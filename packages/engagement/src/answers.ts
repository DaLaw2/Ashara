import { z } from "zod";
import { PreCallRefusal, withStructuredLadder } from "@ashara/llm-gateway";
import type { ContextualLlm, LadderAttemptEvent } from "@ashara/llm-gateway";
import { AssumptionKindSchema, describeErrorChain, projectBlockCause } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";

// The client's answers to the Liaison's questions (story s-liaison-intake-m1, task
// t-vision-answers-reach-plan). Each question names the assumption work proceeds on
// until it is answered (intake.ts). The Liaison reads each answer once: one that
// confirms or changes that assumption appends a vision version (versions are
// append-only) in which the assumption is Stated and carries the answer, the client
// message id as its provenance. Delivery plans from the current version, so an answer
// read before the first plan is planned on. One read after it that changes an
// assumption the plan was built on is recorded as a request to revise the plan, which stops its
// dispatch, and is reported to the client once. Delivery revises the plan once the work
// in progress has finished (planning replan.ts), taking in every such answer recorded, and the Liaison reports the revision, naming each.

/** Failed attempts to read one answer after which the Liaison stops and blocks the project. */
const MAX_ANSWER_ATTEMPTS = 3;
/** Writes of one answer per cycle: the first, and one more composed against the state that moved it. */
const MAX_ANSWER_WRITES = 2;

/** An inbound answer not yet consumed, as the answer store reads it. */
interface OpenAnswer {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly body: string;
  /** The question message it answers. */
  readonly questionId: string;
  readonly intakeAttempts: number;
  readonly intakeLastError: string | null;
  /** Whether the project's first plan had been written when the answer was read. */
  readonly planned: boolean;
  /** The project's current vision, as stored; null when it has none. */
  readonly vision: { readonly version: number; readonly inferences: unknown; readonly openQuestions: unknown } | null;
}

interface AnswerWrite {
  readonly answerId: string;
  readonly projectId: ProjectId;
  readonly planned: boolean;
  readonly vision: {
    readonly basedOnVersion: number;
    readonly inferences: readonly unknown[];
    readonly openQuestions: readonly unknown[];
    readonly changeReason: string;
  } | null;
  readonly replanReport: string | null;
}

/** What recording an answer did; "moved" wrote nothing: what it was composed against changed meanwhile. */
type AnswerRecording =
  | { readonly kind: "recorded" }
  | { readonly kind: "already-consumed" }
  | { readonly kind: "moved"; readonly detail: string };

/** Engagement's persistence port for answers. Each write method is one transaction. */
export interface AnswerStore {
  openAnswers(): Promise<readonly OpenAnswer[]>;
  /** The answer as openAnswers lists it, with its project's vision as it is now; null when no longer listed. */
  openAnswer(answerId: string): Promise<OpenAnswer | null>;
  /**
   * Consumes the answer and, together with it, appends the vision version and
   * records the request to revise the plan, with its report; an answer already consumed
   * gets nothing new. A write composed against a vision version or a plan state
   * that is no longer current writes nothing and returns "moved".
   */
  recordAnswer(write: AnswerWrite): Promise<AnswerRecording>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(answerId: string, error: string): Promise<number>;
  /** Blocks the project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type AnswerOutcome =
  | {
      /** The assumption is now Stated in a new vision version; `replanRequested` when the plan relied on what it changed. */
      readonly kind: "stated";
      readonly answerId: string;
      readonly projectId: ProjectId;
      readonly assumptionKey: string;
      readonly verdict: "confirms" | "changes";
      readonly visionVersion: number;
      readonly replanRequested: boolean;
    }
  /** The answer neither confirms nor changes its assumption: it is consumed and the vision is unchanged. */
  | { readonly kind: "not-an-answer"; readonly answerId: string; readonly projectId: ProjectId }
  | { readonly kind: "already-consumed"; readonly answerId: string; readonly projectId: ProjectId }
  /** Listed at the cycle's start, but consumed or its project stopped before it was read: nothing was done. */
  | { readonly kind: "not-open"; readonly answerId: string; readonly projectId: ProjectId }
  /**
   * Its project's record moved under every write this cycle tried: nothing was written, no attempt is
   * counted, and the answer is read again next cycle.
   */
  | { readonly kind: "moved"; readonly answerId: string; readonly projectId: ProjectId; readonly detail: string }
  | { readonly kind: "failed"; readonly answerId: string; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "project-blocked"; readonly answerId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison each cycle, before planning. */
export interface LiaisonAnswers {
  runPending(): Promise<readonly AnswerOutcome[]>;
}

// Intake writes the assumptions as keyed records and each open question with the key
// of the assumption it adopted. Other fields of a record (rationale, a stack choice's)
// are carried over unchanged.
const StoredInferencesSchema = z.array(
  z.looseObject({ key: z.string().min(1).optional(), statement: z.string().min(1), status: z.string().min(1) }),
);
const StoredOpenQuestionsSchema = z.array(
  z.looseObject({ messageId: z.string().min(1), text: z.string().min(1), assumptionKey: z.string().min(1) }),
);

/** The project's record cannot take this answer: the answer is left unconsumed and the project blocked. */
class AnswerVisionUnusable extends Error {
  constructor(
    readonly answerId: string,
    readonly projectId: ProjectId,
    readonly detail: string,
  ) {
    super(`answer ${answerId} of project ${projectId} cannot be recorded against the vision: ${detail}`);
    this.name = "AnswerVisionUnusable";
  }
}

/** Reading the answer failed on every attempt: what the client said is not known, so nothing is planned past it. */
class AnswerReadingExhausted extends Error {
  constructor(
    readonly answerId: string,
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(`answer ${answerId} could not be read after ${attempts} attempts; last error: ${lastError}`);
    this.name = "AnswerReadingExhausted";
  }
}

const AnswerReadingSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ verdict: z.literal("confirms") }),
  // A changed decision is classified again (W11 residual): the kind of the decision it replaced says
  // nothing about the new one, and only a client-visible decision may be cited by an acceptance line.
  z.strictObject({ verdict: z.literal("changes"), statement: z.string().min(1), kind: AssumptionKindSchema }),
  z.strictObject({ verdict: z.literal("does-not-answer") }),
]);

type AnswerReading = z.infer<typeof AnswerReadingSchema>;

interface AnswerContext {
  readonly answer: OpenAnswer;
  readonly vision: { readonly version: number };
  readonly inferences: z.infer<typeof StoredInferencesSchema>;
  readonly openQuestions: z.infer<typeof StoredOpenQuestionsSchema>;
  readonly question: z.infer<typeof StoredOpenQuestionsSchema>[number];
  readonly assumptionIndex: number;
  readonly assumption: z.infer<typeof StoredInferencesSchema>[number];
}

function buildAnswerPrompt(context: AnswerContext): string {
  return [
    `You are the Liaison of a software contractor. You asked the client a question, and work`,
    `proceeded on an assumption until they answered. Read their answer and say what it does to`,
    `that assumption.`,
    ``,
    `Question:`,
    JSON.stringify(context.question.text),
    ``,
    `Assumption work proceeded on:`,
    JSON.stringify(context.assumption.statement),
    ``,
    `The client's answer:`,
    JSON.stringify(context.answer.body),
    ``,
    `Return exactly one of:`,
    `- {"verdict": "confirms"} when the answer agrees with the assumption as stated.`,
    `- {"verdict": "changes", "statement": "...", "kind": "client-visible"} when the answer says something different from`,
    `  the assumption, in any part. "statement" is the decision work now proceeds on, stated`,
    `  plainly as what will be built, in the client's terms. Do not add anything the answer and`,
    `  the question do not say. "kind" classifies that new decision:`,
    `  - "client-visible": behaviour the client sees or relies on when using the deliverable, such`,
    `    as what it outputs, which inputs it accepts or refuses, or what still holds after a failure.`,
    `  - "internal-design": how the team builds it, which the client neither sees nor relies on.`,
    `- {"verdict": "does-not-answer"} when the answer neither agrees with nor changes the`,
    `  assumption (it asks something back, defers, or is about something else).`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
  ].join("\n");
}

function answerReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. No markdown, no explanatory prose.`
  );
}

/** Plain words: what the answer changed, that the plan already under way relied on it, and what happens now. */
function replanReport(context: AnswerContext, statement: string): string {
  return [
    `Your answer to "${context.question.text}" changes an assumption the current plan was built on.`,
    `The plan assumed: ${context.assumption.statement}`,
    `Work now proceeds on: ${statement}`,
    `The plan has to be revised for this change. No new work on this project starts until it is: work already ` +
      `running finishes first, then the team revises the plan, and you will be told what changes.`,
  ].join("\n\n");
}

function isPreCallRefusal(err: unknown): boolean {
  for (let current: unknown = err; current instanceof Error; current = current.cause) {
    if (current instanceof PreCallRefusal) return true;
  }
  return false;
}

interface ClientAnswersDeps {
  readonly llm: ContextualLlm;
  readonly store: AnswerStore;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * The Liaison's reading of the client's answers. Each unconsumed answer is read by
 * one structured call; its result is recorded whole or not at all. A failed attempt
 * leaves the answer unconsumed with the failure counted; at the cap the project is
 * blocked, since planning on without what the client said would ignore it.
 */
export class ClientAnswers implements LiaisonAnswers {
  constructor(private readonly deps: ClientAnswersDeps) {}

  /**
   * An answer its project's record cannot take blocks that project, and the other
   * answers are still read. A spend-cap refusal, and any other failure of the store,
   * throws through.
   */
  async runPending(): Promise<readonly AnswerOutcome[]> {
    const outcomes: AnswerOutcome[] = [];
    for (const listed of await this.deps.store.openAnswers()) {
      // Read again now: an answer of the same project read earlier this cycle may have written a
      // vision version, and an answer read against the version before it would be discarded.
      const answer = await this.deps.store.openAnswer(listed.id);
      if (answer === null) {
        outcomes.push({ kind: "not-open", answerId: listed.id, projectId: listed.projectId });
        continue;
      }
      try {
        outcomes.push(await this.read(answer));
      } catch (err) {
        if (!(err instanceof AnswerVisionUnusable || err instanceof AnswerReadingExhausted)) throw err;
        outcomes.push(await this.block(answer, projectBlockCause(err)));
      }
    }
    return outcomes;
  }

  private async block(answer: OpenAnswer, cause: ProjectBlockCause): Promise<AnswerOutcome> {
    const result = await this.deps.store.blockProject(answer.projectId, cause);
    console.warn(
      `[liaison-answer] answer ${answer.id} (project ${answer.projectId}): ${cause.errorClass}; project ${result}: ${cause.reason}`,
    );
    return { kind: "project-blocked", answerId: answer.id, projectId: answer.projectId, cause };
  }

  private async read(answer: OpenAnswer): Promise<AnswerOutcome> {
    const base = { answerId: answer.id, projectId: answer.projectId };
    if (answer.intakeAttempts >= MAX_ANSWER_ATTEMPTS) {
      throw new AnswerReadingExhausted(answer.id, answer.intakeAttempts, answer.intakeLastError ?? "(none recorded)");
    }
    let context = contextOf(answer);
    let reading = await this.interpret(context);
    if (reading.kind === "failed") return reading.outcome;

    for (let written = 1; ; written++) {
      const write = composeWrite(context, reading.reading);
      const recorded = await this.deps.store.recordAnswer(write);
      if (recorded.kind === "already-consumed") return { kind: recorded.kind, ...base };
      if (recorded.kind === "recorded") return recordedOutcome(context, reading.reading, write);
      if (written >= MAX_ANSWER_WRITES) {
        console.warn(
          `[liaison-answer] answer ${answer.id} (project ${answer.projectId}): its project's record moved under ` +
            `${written} writes this cycle; nothing written, read again next cycle: ${recorded.detail}`,
        );
        return { kind: "moved", ...base, detail: recorded.detail };
      }
      const fresh = await this.deps.store.openAnswer(answer.id);
      if (fresh === null) return { kind: "not-open", ...base };
      const moved = contextOf(fresh);
      // The reading answers a question about one assumption: while both read the same, it holds
      // against the new version as it did against the old, and is not paid for again.
      if (!readingStillApplies(context, moved)) {
        console.warn(
          `[liaison-answer] answer ${answer.id} (project ${answer.projectId}): ${recorded.detail}; the question or its ` +
            `assumption changed, so the answer is read again against vision v${moved.vision.version}`,
        );
        reading = await this.interpret(moved);
        if (reading.kind === "failed") return reading.outcome;
      }
      context = moved;
    }
  }

  /** One paid reading of the answer; a failure is counted (and blocks at the cap), a spend-cap refusal throws. */
  private async interpret(
    context: AnswerContext,
  ): Promise<{ readonly kind: "read"; readonly reading: AnswerReading } | { readonly kind: "failed"; readonly outcome: AnswerOutcome }> {
    try {
      return { kind: "read", reading: await this.callModel(context) };
    } catch (err) {
      if (isPreCallRefusal(err)) throw err;
      return { kind: "failed", outcome: await this.fail(context.answer, err) };
    }
  }

  private async callModel(context: AnswerContext): Promise<AnswerReading> {
    const provider = withStructuredLadder(
      // The answer is read at the Liaison's intake site: it is the Liaison taking in client input.
      this.deps.llm.forCall({ projectId: context.answer.projectId, taskId: null, callSite: "liaison-intake" }),
      {
        site: "liaison-intake",
        // 2, as at intake: a failed answer is retried up to MAX_ANSWER_ATTEMPTS
        // times around this ladder.
        attempts: 2,
        onAttempt: this.deps.onAttempt,
        reask: answerReask,
      },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: buildAnswerPrompt(context),
      schema: AnswerReadingSchema,
      maxTokens: 1024,
    });
    return response.data;
  }

  private async fail(answer: OpenAnswer, err: unknown): Promise<AnswerOutcome> {
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(answer.id, error);
    console.warn(
      `[liaison-answer] answer ${answer.id} (project ${answer.projectId}): attempt ${attempt}/${MAX_ANSWER_ATTEMPTS} failed: ${error}`,
    );
    if (attempt >= MAX_ANSWER_ATTEMPTS) throw new AnswerReadingExhausted(answer.id, attempt, error);
    return { kind: "failed", answerId: answer.id, projectId: answer.projectId, attempt, error };
  }
}

/** What a recorded answer did, as the cycle reports it. */
function recordedOutcome(context: AnswerContext, reading: AnswerReading, write: AnswerWrite): AnswerOutcome {
  const { answer } = context;
  const base = { answerId: answer.id, projectId: answer.projectId };
  if (reading.verdict === "does-not-answer") {
    console.warn(
      `[liaison-answer] answer ${answer.id} (project ${answer.projectId}) neither confirms nor changes ` +
        `assumption ${context.question.assumptionKey}; consumed, vision unchanged`,
    );
    return { kind: "not-an-answer", ...base };
  }
  return {
    kind: "stated",
    ...base,
    assumptionKey: context.question.assumptionKey,
    verdict: reading.verdict,
    visionVersion: context.vision.version + 1,
    replanRequested: write.replanReport !== null,
  };
}

/** Whether a reading of the answer against `before` reads the same against `after`: same question, same assumption. */
function readingStillApplies(before: AnswerContext, after: AnswerContext): boolean {
  return (
    before.question.text === after.question.text &&
    before.question.assumptionKey === after.question.assumptionKey &&
    before.assumption.statement === after.assumption.statement
  );
}

/** The question the answer replies to, open in the current vision, and the assumption it adopted. */
function contextOf(answer: OpenAnswer): AnswerContext {
  const unusable = (detail: string) => new AnswerVisionUnusable(answer.id, answer.projectId, detail);
  if (answer.vision === null) throw unusable("the project has no vision");
  const { version } = answer.vision;
  const inferences = StoredInferencesSchema.safeParse(answer.vision.inferences);
  if (!inferences.success) {
    throw unusable(`vision v${version} inferences are not a list of assumption records: ${z.prettifyError(inferences.error)}`);
  }
  const openQuestions = StoredOpenQuestionsSchema.safeParse(answer.vision.openQuestions);
  if (!openQuestions.success) {
    throw unusable(`vision v${version} open questions are not readable: ${z.prettifyError(openQuestions.error)}`);
  }
  const question = openQuestions.data.find((q) => q.messageId === answer.questionId);
  if (question === undefined) throw unusable(`question ${answer.questionId} is not open in vision v${version}`);
  const assumptionIndex = inferences.data.findIndex((a) => a.key === question.assumptionKey);
  const assumption = inferences.data[assumptionIndex];
  if (assumption === undefined) {
    throw unusable(`question ${answer.questionId} names assumption ${question.assumptionKey}, which vision v${version} does not hold`);
  }
  return {
    answer,
    vision: { version },
    inferences: inferences.data,
    openQuestions: openQuestions.data,
    question,
    assumptionIndex,
    assumption,
  };
}

function composeWrite(context: AnswerContext, reading: AnswerReading): AnswerWrite {
  const { answer } = context;
  const base = { answerId: answer.id, projectId: answer.projectId, planned: answer.planned };
  if (reading.verdict === "does-not-answer") return { ...base, vision: null, replanReport: null };

  const statement = reading.verdict === "confirms" ? context.assumption.statement : reading.statement;
  const stated = {
    ...context.assumption,
    statement,
    ...(reading.verdict === "changes" ? { kind: reading.kind } : {}),
    rationale:
      reading.verdict === "confirms"
        ? `The client confirmed this in answer to "${context.question.text}".`
        : `The client's answer to "${context.question.text}" replaced the assumption "${context.assumption.statement}".`,
    status: "Stated",
    clientAnswer: {
      messageId: answer.id,
      questionMessageId: answer.questionId,
      question: context.question.text,
      answer: answer.body,
      // The delivered report says from it whether the client confirmed or changed the assumption (d95 a).
      verdict: reading.verdict,
    },
  };
  const inferences = context.inferences.map((a, i) => (i === context.assumptionIndex ? stated : a));
  const key = context.question.assumptionKey;
  return {
    ...base,
    vision: {
      basedOnVersion: context.vision.version,
      inferences,
      openQuestions: context.openQuestions.filter((q) => q.messageId !== answer.questionId),
      changeReason: `client answer ${answer.id} ${reading.verdict === "confirms" ? "confirmed" : "changed"} assumption ${key}; now Stated`,
    },
    // A confirmed assumption leaves the plan as it is; a changed one it was built on does not.
    replanReport: answer.planned && reading.verdict === "changes" ? replanReport(context, statement) : null,
  };
}
