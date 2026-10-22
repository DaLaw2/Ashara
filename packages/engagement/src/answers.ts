import { z } from "zod";
import type { ContextualLlm, ModelCallFailure } from "@ashara/finance";
import { modelCallFailureOf, withStructuredLadder } from "@ashara/finance";
import type { LadderAttemptEvent } from "@ashara/finance";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";
import { modelCallBlockCategory, projectBlockCause, recordedFailureOf } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import { ownSpendRefusal } from "./client-spend-refusal.js";
import { checkedDirection } from "./correction.js";
import { AmendOpSchema, opShape, revisionDirection } from "./vision-language/contract-op.js";
import type { AmendOp, RevisionOp, RevisionRecord } from "./vision-language/contract-op.js";
import { OBSERVATION_RULE, contractStandingOf } from "./vision-language/guarantee.js";
import type { ContractStanding } from "./vision-language/guarantee.js";
import { ASSUMPTION_KIND_RULE, ClassifiedAssumptionKindSchema } from "./vision-language/vision-assumption.js";
import { WORK_WORDS } from "./vision-language/work-promise.js";
import { Vision, VisionChangeRefused, VisionUnreadable } from "./vision.js";
import type { StoredVision, VisionAppend, VisionAssumption, VisionVersion } from "./vision.js";

// The client's answers to the Liaison's questions. Each question names the assumption work proceeds on
// until it is answered (intake.ts). The Liaison reads each answer once, against the question's
// assumption and against every other assumption and guarantee of the vision in force, since what the
// client says is not bounded by what they were asked: one that confirms or changes the question's
// assumption appends one vision version (versions are append-only) in which that assumption is Stated
// and carries the answer, the client message id as its provenance, and every other record the answer
// contradicts or refines is restated with it, with one revision record: the client's, approved by them,
// an amendment per record. Delivery plans from the current version, so an answer
// read before the first plan is planned on. One read after it that changes what the plan was built on
// is a correction, taking the path a change message's does: it holds only the tasks citing a record it
// changed (Delivery's hold), the rest of the plan goes on, and it is reported to the client once. Delivery replaces the held work once none of it is in progress
// (delivery replan.ts), taking in every such correction recorded, and the Liaison reports the revision, naming each.
// A halted project's answers are read too: a halt pauses the work, never the reading of what the client said,
// and the work an answer touches waits for the halt's own end; except under a halt the reading cannot get
// past, which the answer waits out, as inboundDecision decides.

/** Failed attempts to read one answer after which the Liaison stops and blocks the project. */
export const MAX_ANSWER_ATTEMPTS = 3;
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
  /** Whose failure the last counted attempt was, as stored; read by recordedFailureOf. */
  readonly intakeLastFailure: string | null;
  /** Whether the project's first plan had been written when the answer was read. */
  readonly planned: boolean;
  /** The project's current vision, as stored; null when it has none. */
  readonly vision: StoredVision | null;
  /** Whether Delivery has the project halted: the answer is read and recorded, and the work it touches waits for the halt to end. */
  readonly paused: boolean;
}

interface AnswerWrite {
  readonly answerId: string;
  readonly projectId: ProjectId;
  readonly planned: boolean;
  readonly vision: { readonly append: VisionAppend; readonly revision: RevisionRecord } | null;
  readonly replanReport: string | null;
  /** Whether the project was halted when the answer was composed: its report says so, so a write finding otherwise writes nothing. */
  readonly paused: boolean;
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
   * holds the work citing the assumption it changed, with its report; an answer already consumed
   * gets nothing new. A write composed against a vision version or a plan state
   * that is no longer current writes nothing and returns "moved".
   */
  recordAnswer(write: AnswerWrite): Promise<AnswerRecording>;
  /** Counts a failed attempt with its error and whose failure it was; returns the count after it. */
  recordFailedAttempt(answerId: string, error: string, failure: Exclude<ModelCallFailure, "ashara">): Promise<number>;
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
  /**
   * The paused project's own spend cap or work budget refused the reading's model call: no attempt is
   * counted, and the answer is read once the limit is raised; the other projects' answers go on.
   */
  | { readonly kind: "waits-for-limit"; readonly answerId: string; readonly projectId: ProjectId; readonly reason: string }
  /** The project's record cannot take the answer and the project is halted already: nothing is written, and it blocks once the halt ends. */
  | { readonly kind: "waits-for-halt"; readonly answerId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause }
  /** The answer's read failed on Ashara's side: recorded on it and read again after the backoff; the other answers go on. */
  | StepFaulted
  | { readonly kind: "project-blocked"; readonly answerId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison each cycle, before planning. */
export interface LiaisonAnswers {
  runPending(): Promise<readonly AnswerOutcome[]>;
}

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

/**
 * Reading the answer failed on every attempt: what the client said is not known, so nothing is
 * planned past it. `failure` is whose failure the last attempt was: classified by the cycle that
 * counted it, or read back from the record (recordedFailureOf) by a later cycle, after a restart or
 * an unblock, so the halt blames the same party either way.
 */
class AnswerReadingExhausted extends Error {
  constructor(
    readonly answerId: string,
    readonly attempts: number,
    readonly lastError: string,
    readonly failure: ModelCallFailure,
  ) {
    super(`answer ${answerId} could not be read after ${attempts} attempts; last error: ${lastError}`);
    this.name = "AnswerReadingExhausted";
  }
}

/**
 * An answer at its attempt cap with no error on record. A store
 * CHECK makes this unrepresentable; meeting it means the store lied, and no error is
 * invented to stand in for the missing one.
 */
class AnswerFailureUnrecorded extends Error {
  constructor(
    readonly answerId: string,
    readonly attempts: number,
  ) {
    super(`answer ${answerId} has ${attempts} failed reading attempts but no recorded error`);
    this.name = "AnswerFailureUnrecorded";
  }
}

/**
 * Every other assumption and guarantee the answer contradicts or refines, each restated: an answer
 * taken into the vision leaves no record standing that says otherwise.
 */
const amends = { amends: z.array(AmendOpSchema) };

const AnswerReadingSchema = z.discriminatedUnion("verdict", [
  z.strictObject({ verdict: z.literal("confirms"), ...amends }),
  // A changed decision is classified again: the kind of the decision it replaced says
  // nothing about the new one, and only a client-visible decision may be cited by an acceptance line.
  z.strictObject({ verdict: z.literal("changes"), statement: z.string().min(1), kind: ClassifiedAssumptionKindSchema, ...amends }),
  z.strictObject({ verdict: z.literal("does-not-answer") }),
]);

type AnswerReading = z.infer<typeof AnswerReadingSchema>;

/**
 * The reading as the model returns it: one object holding it, since a provider decoding against the
 * schema takes only an object at its root, never a union of them (model-access schema-acceptance).
 */
export const AnswerResponseSchema = z.strictObject({ reading: AnswerReadingSchema });

/** The question the answer replies to, as the vision holds it open: it names the assumption it adopted. */
interface AnsweredQuestion {
  readonly messageId: string;
  readonly text: string;
  readonly assumptionKey: string;
}

interface AnswerContext {
  readonly answer: OpenAnswer;
  readonly vision: Vision;
  readonly question: AnsweredQuestion;
  readonly assumption: VisionAssumption;
}

function buildAnswerPrompt(context: AnswerContext): string {
  const { current } = context.vision;
  const others = current.assumptions.filter((a) => a.id !== context.question.assumptionKey);
  // A version written before guarantees were holds no keyed guarantee an answer could restate.
  const guarantees = current.contractForm === "guarantees" ? current.guarantees : [];
  return [
    `You are the Liaison of a software contractor. You asked the client a question, and work`,
    `proceeded on an assumption until they answered. Read their answer and say what it does to`,
    `that assumption, and to every other assumption and guarantee of the contract below.`,
    ``,
    `Question:`,
    JSON.stringify(context.question.text),
    ``,
    `Assumption work proceeded on (${context.question.assumptionKey}):`,
    JSON.stringify(context.assumption.statement),
    ``,
    `The client's answer:`,
    JSON.stringify(context.answer.body),
    ``,
    `Interface:`,
    ...(current.interface.length === 0 ? ["- none"] : current.interface.map((e) => `- ${e.id}: ${e.text}`)),
    ``,
    `Guarantees:`,
    ...(guarantees.length === 0
      ? ["- none"]
      : guarantees.map(
          (g) =>
            `- ${g.id}: ${g.statement} (observed in its ${g.verification === "undecided" ? "undecided" : g.observation} at ${g.interface.join(", ") || "no entry"}; ` +
            `refuted by: ${g.refutedBy.join("; ") || "nothing recorded"})`,
        )),
    ``,
    `Other assumptions:`,
    ...(others.length === 0 ? ["- none"] : others.map((a) => `- ${a.id}: ${a.statement}`)),
    ``,
    `Return {"reading": <reading>}, where <reading> is exactly one of:`,
    `- {"verdict": "confirms", "amends": [...]} when the answer agrees with the assumption as stated.`,
    `- {"verdict": "changes", "statement": "...", "kind": "client-visible", "amends": [...]} when the answer says something`,
    `  different from the assumption, in any part. "statement" is the decision work now proceeds on, stated`,
    `  plainly as what will be built, in the client's terms. Do not add anything the answer and`,
    `  the question do not say. "kind" classifies that new decision:`,
    ...ASSUMPTION_KIND_RULE,
    `- {"verdict": "does-not-answer"} when the answer neither agrees with nor changes the`,
    `  assumption (it asks something back, defers, or is about something else).`,
    `"amends" lists every other assumption and guarantee above that the answer contradicts or refines, each`,
    `restated so it agrees with the answer, and nothing else; an empty list when the answer contradicts and`,
    `refines none of them. Never list ${context.question.assumptionKey}: the verdict settles it. Each entry is one of:`,
    `- {"op": "amend-assumption", "id", "statement", "direction"}`,
    `- {"op": "amend-guarantee", "id", "statement", "interface": [interface ids], "observation", "refutedBy": [...], "direction"}:`,
    `  the guarantee restated whole`,
    ...OBSERVATION_RULE,
    `"direction" is "widens" when the restatement promises more, "narrows" when it promises less, "neutral" otherwise.`,
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

/** One record an answer changed: what the plan was built on, and what it now rests on. */
interface AnswerChange {
  readonly target: "assumption" | "guarantee";
  readonly before: string;
  readonly after: string;
}

/**
 * Plain words: every record the answer changed, that the plan already under way relied on them, and
 * what happens now, as the `standing` of the contract the answer is recorded in allows.
 */
function replanReport(context: AnswerContext, changes: readonly [AnswerChange, ...AnswerChange[]], standing: ContractStanding): string {
  const words = WORK_WORDS[standing];
  const what = changes.length > 1 ? `${changes.length} assumptions and guarantees` : changes[0].target === "assumption" ? "an assumption" : "a guarantee";
  return [
    `Your answer to "${context.question.text}" changes ${what} the current plan was built on.`,
    ...changes.map((change) =>
      change.target === "assumption"
        ? `The plan assumed: ${change.before}\n${words.answerRestsOn} ${change.after}`
        : `The plan promised: ${change.before}\nIt now promises: ${change.after}`,
    ),
    words.answerReplans(context.answer.paused),
  ].join("\n\n");
}

interface ClientAnswersDeps {
  readonly llm: ContextualLlm;
  readonly store: AnswerStore;
  /** Each answer's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
  /** Aborted on shutdown: every model call this step sends is cancelled with it (StructuredRequest.abortSignal). */
  readonly shutdownSignal: AbortSignal;
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
   * answers are still read. Any other failure that is not the read's own (a price
   * refusal, a ledger or store failure, an error nothing names) is that answer's,
   * contained to it (containEach), never counted against it; a spend-cap refusal throws
   * through to the core loop, which halts at the cap, except a paused project's own (waitForLimit).
   */
  async runPending(): Promise<readonly AnswerOutcome[]> {
    const answers = await this.deps.store.openAnswers();
    return containEach(this.deps.containment, "liaison-answers", answers, (listed) => ({ id: listed.id, projectId: listed.projectId }), async (listed) => {
      try {
        // Read again now: an answer of the same project read earlier this cycle may have written a
        // vision version, and an answer read against the version before it would be discarded.
        const answer = await this.deps.store.openAnswer(listed.id);
        if (answer === null) return { kind: "not-open", answerId: listed.id, projectId: listed.projectId } satisfies AnswerOutcome;
        return await this.read(answer);
      } catch (err) {
        const blocks =
          err instanceof AnswerVisionUnusable || err instanceof AnswerReadingExhausted || err instanceof AnswerFailureUnrecorded;
        if (!blocks) throw err;
        const cause = projectBlockCause(err);
        return err instanceof AnswerReadingExhausted ? this.block(listed, { ...cause, category: modelCallBlockCategory(err.failure) }, "unread") : this.block(listed, cause, "record");
      }
    });
  }

  private async block(answer: OpenAnswer, cause: ProjectBlockCause, why: "unread" | "record"): Promise<AnswerOutcome> {
    const { store } = this.deps;
    // A record no answer can be read against stays so until the operator acts: under a halt, blocking would
    // find the project halted already, every cycle, with nothing changed. Its halt is opened once the project
    // is at work again, blamed as it is.
    if (why === "record" && answer.paused) {
      this.deps.containment.logger.debug("engagement.answer-waits-for-halt", `answer ${answer.id} waits for its project's halt to end: ${cause.errorClass}: ${cause.reason}`, {
        projectId: answer.projectId,
        answerId: answer.id,
      });
      return { kind: "waits-for-halt", answerId: answer.id, projectId: answer.projectId, cause };
    }
    const result = await store.blockProject(answer.projectId, cause);
    console.warn(
      `[liaison-answer] answer ${answer.id} (project ${answer.projectId}): ${cause.errorClass}; project ${result}: ${cause.reason}`,
    );
    return { kind: "project-blocked", answerId: answer.id, projectId: answer.projectId, cause };
  }

  private async read(answer: OpenAnswer): Promise<AnswerOutcome> {
    const base = { answerId: answer.id, projectId: answer.projectId };
    if (answer.intakeAttempts >= MAX_ANSWER_ATTEMPTS) {
      if (answer.intakeLastError === null) throw new AnswerFailureUnrecorded(answer.id, answer.intakeAttempts);
      // At the cap with no halt to wait out: whatever ends a halt sets the count back to none
      // (inboundDecision's resetOnHaltEnd), so only a count left by no halt at all leads here, and halts the project, blamed as it was.
      throw new AnswerReadingExhausted(answer.id, answer.intakeAttempts, answer.intakeLastError, recordedFailureOf(answer.intakeLastFailure));
    }
    let context = contextOf(answer);
    let reading = await this.interpret(context);
    if (reading.kind === "failed") return reading.outcome;

    for (let written = 1; ; written++) {
      const write = composeWrite(context, reading.reading);
      const recorded = await this.deps.store.recordAnswer(write);
      if (recorded.kind === "already-consumed") return { kind: recorded.kind, ...base };
      if (recorded.kind === "recorded") return recordedOutcome(context, reading.reading, write);
      // Past MAX_ANSWER_WRITES the answer is read again next cycle, uncounted: the work
      // ledger bounds it, since every reading draws from the project's budget, which halts the
      // project as work_budget when spent.
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
            `assumption changed, so the answer is read again against vision v${moved.vision.current.version}`,
        );
        reading = await this.interpret(moved);
        if (reading.kind === "failed") return reading.outcome;
      }
      context = moved;
    }
  }

  /** One paid reading of the answer; a failed read is counted (and blocks at the cap), Ashara's own fault throws to runPending, which contains it. */
  private async interpret(
    context: AnswerContext,
  ): Promise<{ readonly kind: "read"; readonly reading: AnswerReading } | { readonly kind: "failed"; readonly outcome: AnswerOutcome }> {
    try {
      return { kind: "read", reading: await this.callModel(context) };
    } catch (err) {
      const refused = context.answer.paused ? ownSpendRefusal(err, context.answer.projectId) : null;
      if (refused !== null) return { kind: "failed", outcome: this.waitForLimit(context.answer, refused.message) };
      const failure = modelCallFailureOf(err);
      if (failure === "ashara") throw err;
      return { kind: "failed", outcome: await this.fail(context.answer, err, failure) };
    }
  }

  /**
   * A paused project's reading refused by its own spend limit waits for the limit, charged nothing. It
   * does not throw to the core loop: the loop's halt for the refusal would find the project halted
   * already, and the step it ended would leave every later project's answer unread for as long as the
   * limit stands.
   */
  private waitForLimit(answer: OpenAnswer, reason: string): AnswerOutcome {
    this.deps.containment.logger.info("engagement.answer-waits-for-limit", `answer ${answer.id} waits for its paused project's spend limit: ${reason}`, {
      projectId: answer.projectId,
      answerId: answer.id,
    });
    return { kind: "waits-for-limit", answerId: answer.id, projectId: answer.projectId, reason };
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
      schema: AnswerResponseSchema,
      // A guarantee the answer restates is restated whole, as a change message's is.
      maxTokens: 2048,
      // A reading the vision cannot take whole is the model's to correct: never applied to part of it.
      validate: (value) => {
        try {
          composeWrite(context, value.reading);
          return { ok: true };
        } catch (err) {
          if (!(err instanceof VisionChangeRefused)) throw err;
          return { ok: false, errors: [err.detail] };
        }
      },
      abortSignal: this.deps.shutdownSignal,
    });
    return response.data.reading;
  }

  private async fail(answer: OpenAnswer, err: unknown, failure: Exclude<ModelCallFailure, "ashara">): Promise<AnswerOutcome> {
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(answer.id, error, failure);
    console.warn(
      `[liaison-answer] answer ${answer.id} (project ${answer.projectId}): attempt ${attempt}/${MAX_ANSWER_ATTEMPTS} failed: ${error}`,
    );
    if (attempt >= MAX_ANSWER_ATTEMPTS) throw new AnswerReadingExhausted(answer.id, attempt, error, failure);
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
    visionVersion: context.vision.current.version + 1,
    replanRequested: write.replanReport !== null,
  };
}

/**
 * Whether a reading of the answer against `before` reads the same against `after`: same question, and
 * every record it was reconciled with (the interface, each guarantee and each assumption) as it was.
 */
function readingStillApplies(before: AnswerContext, after: AnswerContext): boolean {
  return before.question.text === after.question.text && before.question.assumptionKey === after.question.assumptionKey && JSON.stringify(reconciledWith(before)) === JSON.stringify(reconciledWith(after));
}

/** The records an answer is read against, as its prompt states them. */
function reconciledWith(context: AnswerContext): unknown {
  const { current } = context.vision;
  return {
    form: current.contractForm,
    interface: current.interface.map((e) => [e.id, e.text]),
    guarantees: current.guarantees.map((g) => [g.id, g.statement, g.interface, g.observation, g.verification, g.refutedBy]),
    assumptions: current.assumptions.map((a) => [a.id, a.statement]),
  };
}

/** The question the answer replies to, open in the current vision, and the assumption it adopted. */
function contextOf(answer: OpenAnswer): AnswerContext {
  const unusable = (detail: string) => new AnswerVisionUnusable(answer.id, answer.projectId, detail);
  if (answer.vision === null) throw unusable("the project has no vision");
  const { version } = answer.vision;
  let vision: Vision;
  try {
    vision = Vision.read(answer.vision);
  } catch (err) {
    if (!(err instanceof VisionUnreadable)) throw err;
    throw unusable(`vision v${version} ${err.field} are not readable: ${err.issues}`);
  }
  const open = vision.current.openQuestions.find((q) => q.messageId === answer.questionId);
  if (open === undefined || open.messageId === null || open.assumptionKey === null) throw unusable(`question ${answer.questionId} is not open in vision v${version}`);
  const question: AnsweredQuestion = { messageId: open.messageId, text: open.text, assumptionKey: open.assumptionKey };
  const assumption = vision.current.assumptions.find((a) => a.keyed && a.id === question.assumptionKey);
  if (assumption === undefined) {
    throw unusable(`question ${answer.questionId} names assumption ${question.assumptionKey}, which vision v${version} does not hold`);
  }
  return { answer, vision, question, assumption };
}

function composeWrite(context: AnswerContext, reading: AnswerReading): AnswerWrite {
  const { answer } = context;
  const base = { answerId: answer.id, projectId: answer.projectId, planned: answer.planned, paused: answer.paused };
  if (reading.verdict === "does-not-answer") return { ...base, vision: null, replanReport: null };

  const statement = reading.verdict === "confirms" ? context.assumption.statement : reading.statement;
  const key = context.question.assumptionKey;
  const { current } = context.vision;
  const amended: RevisionOp[] = reading.amends.map((op) => ({ ...opShape(op), key: op.id, direction: checkedDirection(op, current), labelled: op.direction, read: op, statement: op.statement }));
  const ops: readonly [RevisionOp, ...RevisionOp[]] = [
    // An answer settles its own assumption's wording; which way that moves the promise no record decides.
    { target: "assumption", action: "amend", key, direction: "neutral", labelled: null, read: null, statement },
    ...amended,
  ];
  const revision: RevisionRecord = {
    author: "client",
    sourceMessageId: answer.id,
    approver: "client",
    direction: revisionDirection(ops),
    cause: "client-change",
    ops,
    pushback: null,
  };
  const append = context.vision.stateAssumption(key, {
      messageId: answer.id,
      questionMessageId: answer.questionId,
      question: context.question.text,
      answer: answer.body,
      verdict: reading.verdict,
      statement,
      kind: reading.verdict === "changes" ? reading.kind : null,
      rationale:
        reading.verdict === "confirms"
          ? `The client confirmed this in answer to "${context.question.text}".`
          : `The client's answer to "${context.question.text}" replaced the assumption "${context.assumption.statement}".`,
      changeReason:
        `client answer ${answer.id} ${reading.verdict === "confirms" ? "confirmed" : "changed"} assumption ${key}; now Stated` +
        (reading.amends.length === 0 ? "" : `; it also restated ${reading.amends.map((op) => op.id).join(", ")}`),
    },
    reading.amends,
  );
  // A confirmed assumption with nothing else restated leaves the plan as it is; any record it was built on that changed does not.
  const changes: AnswerChange[] = [
    ...(reading.verdict === "changes" ? [{ target: "assumption", before: context.assumption.statement, after: statement } as const] : []),
    ...reading.amends.map((op): AnswerChange => ({ target: op.op === "amend-assumption" ? "assumption" : "guarantee", before: statementOf(current, op), after: op.statement })),
  ];
  const [first, ...rest] = changes;
  return {
    ...base,
    vision: { append, revision },
    replanReport: answer.planned && first !== undefined ? replanReport(context, [first, ...rest], contractStandingOf(current.guarantees)) : null,
  };
}

/** The statement the vision in force holds for the record `op` restates; composing the version first proved it holds one. */
function statementOf(vision: VisionVersion, op: AmendOp): string {
  const held = op.op === "amend-assumption" ? vision.assumptions.find((a) => a.id === op.id) : vision.guarantees.find((g) => g.id === op.id);
  if (held === undefined) throw new VisionChangeRefused(vision.projectId, vision.version, `it holds no ${op.op === "amend-assumption" ? "assumption" : "guarantee"} keyed ${op.id}`);
  return held.statement;
}
