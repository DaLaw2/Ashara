import { z } from "zod";
import type { ContextualLlm } from "@ashara/finance";
import { withStructuredLadder } from "@ashara/model-access";
import type { LadderAttemptEvent } from "@ashara/model-access";
import { AssumptionKindSchema, describeErrorChain } from "@ashara/shared";
import type { AssumptionKind, ProjectId, ScopeLine } from "@ashara/shared";
import { projectBlockCause } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import { classifyReadFailure } from "./read-failure.js";
import type { FirstVision, InferredAssumption } from "./vision.js";

// The Liaison's intake of a tender (story s-liaison-intake-m1, ADR-075 Engagement).
// Proceed on silence at once (orchestrator 2026-10-13, on the board): the questions
// go out, the assumptions work proceeds on are recorded as Inferred, and vision v1
// is written in the same intake. A later answer is a change request, not a rewrite.
// The assumptions no question carries are reported to the client in one message of the
// same intake, without waiting (ADR-073 Q8, ADR-074 addendum 2 d89 C), so every Inferred
// assumption intake writes is one the client was asked about or told of.

/** At most this many questions per tender (orchestrator 2026-10-13, on the board). */
const MAX_QUESTIONS_PER_TENDER = 5;

/**
 * Failed reads of a tender after which the Liaison stops retrying and reports to the client. Only the
 * read counts (read-failure.ts): Ashara's own faults never use up the client's tender.
 */
const MAX_INTAKE_ATTEMPTS = 3;

/** What the client reads before a question's assumption; the statement itself never carries it. */
const ASSUMPTION_LABEL = "Until you answer, we proceed on this assumption:";

// The label's lead-in, alone or with the rest of the label, at the start of a statement.
const LABEL_LEAD_IN = /^\s*until you answer\b\s*,?\s*(?:we proceed on this assumption\b\s*:?\s*)?/i;

/**
 * The assumption statement without a lead-in that repeats the label shown before
 * it (transcript 2, N1: the model wrote "Until you answer, ..." into every
 * statement, so the client read the phrase twice and the vision stored it).
 */
function withoutLabelLeadIn(statement: string): string {
  const rest = statement.replace(LABEL_LEAD_IN, "").trim();
  return rest === statement.trim() ? rest : rest.charAt(0).toUpperCase() + rest.slice(1);
}

// A statement that is nothing but the lead-in is rejected (and re-asked), never stored empty.
const AssumptionStatementSchema = z.string().min(1).transform(withoutLabelLeadIn).pipe(z.string().min(1));

// "kind" (d89 E): behaviour the client sees, or the team's own design choice. The Liaison
// classifies each assumption when it writes it; only a client-visible one may become the
// source of an acceptance line.
const AssumptionSchema = z.strictObject({
  statement: AssumptionStatementSchema,
  rationale: z.string().min(1),
  kind: AssumptionKindSchema,
});

const IntakeResponseSchema = z.strictObject({
  summary: z.string().min(1),
  // Kept apart so the vision records each line's side, and no report has to read it from the wording.
  inScope: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)),
  // Over the cap is rejected, never truncated: a dropped question would be a
  // question the client was never asked and no record says was cut. Each question
  // carries the assumption adopted until it is answered: a later answer is a change
  // request against that assumption, so a question without one has nothing to change.
  questions: z
    .array(z.strictObject({ text: z.string().min(1), whyItMatters: z.string().min(1), assumption: AssumptionSchema }))
    .max(MAX_QUESTIONS_PER_TENDER),
  /** Assumptions work proceeds on without asking the client. */
  assumptions: z.array(AssumptionSchema),
});

type IntakeResponse = z.infer<typeof IntakeResponseSchema>;

/** An inbound tender not yet consumed, as the intake store reads it. */
interface OpenTender {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly body: string;
  readonly intakeAttempts: number;
  readonly intakeLastError: string | null;
}

interface IntakeWrite {
  readonly tender: OpenTender;
  /** Question bodies as posted to the client, most impactful first; the store keeps this order. */
  readonly questions: readonly string[];
  /** The report of the assumptions no question carries; null when every assumption is a question's. */
  readonly assumptionsReport: string | null;
  readonly vision: (questionMessageIds: readonly string[]) => FirstVision;
}

type IntakeCommit =
  | { readonly kind: "recorded"; readonly questionIds: readonly string[] }
  | { readonly kind: "vision-exists"; readonly visionVersion: number };

/** Engagement's persistence port for intake. Each write method is one transaction. */
export interface IntakeStore {
  openTenders(): Promise<readonly OpenTender[]>;
  currentVisionVersion(projectId: ProjectId): Promise<number | null>;
  /** Consumes the tender, posts the questions and the assumptions report, and writes vision v1, together. */
  recordIntake(write: IntakeWrite): Promise<IntakeCommit>;
  /** Consumes the tender and writes nothing else. */
  consumeTender(tenderId: string): Promise<void>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(tenderId: string, error: string): Promise<number>;
  /** Posts the report and consumes the tender together. */
  closeFailedTender(tender: OpenTender, report: string): Promise<void>;
  /**
   * Blocks the project and records why (migration 025); a project already
   * blocked keeps its first cause. A blocked project's tenders are not open.
   */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type IntakeOutcome =
  | { readonly kind: "recorded"; readonly tenderId: string; readonly projectId: ProjectId; readonly questions: number }
  | { readonly kind: "vision-exists"; readonly tenderId: string; readonly projectId: ProjectId; readonly visionVersion: number }
  | { readonly kind: "failed"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "abandoned"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempts: number }
  | { readonly kind: "project-blocked"; readonly tenderId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison each cycle. */
export interface LiaisonIntake {
  runPending(): Promise<readonly IntakeOutcome[]>;
}

/**
 * A tender reached its attempt cap with no error on record. Migration 019's
 * CHECK makes this unrepresentable; meeting it means the store lied.
 */
class IntakeFailureUnrecorded extends Error {
  constructor(
    readonly tenderId: string,
    readonly attempts: number,
  ) {
    super(`tender ${tenderId} has ${attempts} failed intake attempts but no recorded error`);
    this.name = "IntakeFailureUnrecorded";
  }
}

/**
 * The store posted a different number of questions than intake asked it to. The store's
 * record does not hold together, so the project is blocked: another paid read would meet
 * the same store.
 */
class QuestionIdsMismatch extends Error {
  constructor(
    readonly tenderId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`intake of tender ${tenderId} asked for ${expected} questions to be posted; the store returned ${actual} ids`);
    this.name = "QuestionIdsMismatch";
  }
}

function buildIntakePrompt(tender: string): string {
  return [
    `You are the Liaison of a software contractor. A client has sent the tender below.`,
    `Read it and prepare the first version of the project's vision. Work starts now on what`,
    `you record here; the client may answer your questions later, and an answer then changes`,
    `the plan through a change request against the assumption that question names.`,
    ``,
    `Tender:`,
    JSON.stringify(tender),
    ``,
    `Return:`,
    `- "summary": what the client wants built, in a few sentences, in the tender's own terms.`,
    `- "inScope": what the client asks to be built, one item per string, each grounded in the`,
    `  tender. Write each as the item itself, without a label such as "In scope:".`,
    `- "outOfScope": what the tender explicitly leaves out, one item per string, in the same`,
    `  form; an empty list when it leaves nothing out.`,
    `- "questions": at most ${MAX_QUESTIONS_PER_TENDER} questions to the client, most impactful first.`,
    `  For each: "text" is the question; "whyItMatters" says what gets built differently, or`,
    `  what stops working for the client, depending on the answer; "assumption" is the decision`,
    `  you proceed on until the client answers ("statement") and why the tender makes it the`,
    `  most defensible choice ("rationale"). The client reads the statement after the label`,
    `  ${JSON.stringify(ASSUMPTION_LABEL)}, and it is also recorded in the vision on its own, so`,
    `  "statement" is the decision alone, stated plainly as what will be built and what it`,
    `  means for the client if they never answer. Do not begin it with that label or any`,
    `  wording like it ("Until you answer", "We assume", "For now").`,
    `- "assumptions": every other decision the tender leaves open that work must proceed on,`,
    `  each with the same "statement" and "rationale". Do not repeat a question's assumption.`,
    `  The client is told of each of them, and work proceeds on them unless the client objects.`,
    `- Every assumption, a question's included, has a "kind":`,
    `  - "client-visible": behaviour the client sees or relies on when using the deliverable, such`,
    `    as what it outputs and in what form, which inputs it accepts or refuses and how it says so,`,
    `    or what still holds after a failure. The client's acceptance tests may check it.`,
    `  - "internal-design": how the team builds it, which the client neither sees nor relies on,`,
    `    such as the name of an internal file, the mechanism behind a guarantee, or how data is laid`,
    `    out. It guides the work and is never checked as the client's requirement.`,
    `  When one decision fixes both a behaviour and the mechanism behind it, record two`,
    `  assumptions, one of each kind.`,
    ``,
    `How to choose the questions:`,
    `- First consider every unknown the tender leaves open. For each, ask: if my assumption is`,
    `  wrong, does the deliverable get built differently, or fail to work for the client at`,
    `  all? Only an unknown where the answer is yes may become a question.`,
    `- Rank those unknowns by what a wrong assumption would cost the client: one that could make`,
    `  the deliverable unusable where the client will use it outranks one that changes a detail`,
    `  of its output. Ask the highest-ranked ones, most impactful first.`,
    `- Ask fewer questions when fewer matter. The limit is a ceiling, not a target; an empty`,
    `  question list is correct when nothing open would change what gets built.`,
    `- When the tender states a constraint on where or how the deliverable must run or be used,`,
    `  consider what about that constraint is still unknown and could make the deliverable fail`,
    `  there. Do not settle such an unknown silently with an assumption: ask about it.`,
    `- Every question must name something specific to THIS tender. Never ask a generic`,
    `  checklist question that could be put to any project, and never ask about a feature the`,
    `  tender gives no sign of wanting.`,
    `- Do not choose or suggest a technology, language, framework or platform the tender does`,
    `  not name. If the tender names one, record it as stated, not as an assumption.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"summary": "...", "inScope": ["..."], "outOfScope": ["..."], ` +
      `"questions": [{"text": "...", "whyItMatters": "...", ` +
      `"assumption": {"statement": "...", "rationale": "...", "kind": "client-visible"}}], ` +
      `"assumptions": [{"statement": "...", "rationale": "...", "kind": "internal-design"}]}`,
  ].join("\n");
}

function intakeReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only, with at most ${MAX_QUESTIONS_PER_TENDER} questions. ` +
    `No markdown, no explanatory prose.`
  );
}

type IntakeQuestion = IntakeResponse["questions"][number];

/** What the client reads: the question, why it matters, and what Ashara does if they stay silent. */
function questionBody(question: IntakeQuestion): string {
  return [
    question.text,
    `Why it matters: ${question.whyItMatters}`,
    `${ASSUMPTION_LABEL} ${question.assumption.statement}`,
    `Why this assumption: ${question.assumption.rationale}`,
  ].join("\n\n");
}

/** Question i's assumption is A(i+1); the unasked assumptions are numbered after the questions'. */
function assumptionKey(index: number): string {
  return `A${index + 1}`;
}

/**
 * Every assumption of the intake, keyed: the questions' first, in question order, then the unasked
 * ones, which the assumptions report tells the client of.
 */
function inferencesOf(response: IntakeResponse): InferredAssumption[] {
  const asked = response.questions.map((q) => ({ ...q.assumption, disclosed: "asked" as const }));
  const reported = response.assumptions.map((a) => ({ ...a, disclosed: "reported" as const }));
  return [...asked, ...reported].map((a, i) => ({
    key: assumptionKey(i),
    statement: a.statement,
    rationale: a.rationale,
    status: "Inferred",
    kind: a.kind,
    disclosed: a.disclosed,
  }));
}

/**
 * What the client reads of the assumptions no question asked about (ADR-074 addendum 2 d89 C): the
 * decisions work proceeds on unless they object, behaviour first, then the team's design choices.
 * Nothing waits on a reply (ADR-073 Q8). Null when there are none.
 */
function assumptionsReport(inferences: readonly InferredAssumption[]): string | null {
  const reported = inferences.filter((a) => a.disclosed === "reported");
  if (reported.length === 0) return null;
  const listed = (kind: AssumptionKind) =>
    reported.filter((a) => a.kind === kind).map((a) => `- ${a.key}: ${a.statement} (why: ${a.rationale})`);
  const behaviour = listed("client-visible");
  const design = listed("internal-design");
  return [
    `Besides the questions we asked, the tender leaves these decisions open, and we proceed on them unless you object. Work does not wait for a reply.`,
    ...(behaviour.length === 0 ? [] : [`What the product will do:\n${behaviour.join("\n")}`]),
    ...(design.length === 0 ? [] : [`How we will build it (our own design choices, which your acceptance does not depend on):\n${design.join("\n")}`]),
    `If any of these does not fit what you need, send a change naming it and saying what should be different.`,
  ].join("\n\n");
}

/**
 * What the client reads when intake gives up: only what is recorded, the count of failed reads.
 * The error chain stays in intake_last_error and the warn log: provider and validation text is internal,
 * and it can carry another party's error detail. No operator alert exists beyond
 * the warn log, so the report does not promise one.
 */
function failureReport(attempts: number): string {
  return [
    `Ashara could not process your tender after ${attempts} attempts, so this request has been stopped.`,
    `Nothing was built for this project.`,
    `You can send the tender again to start a new request.`,
  ].join("\n\n");
}

interface TenderIntakeDeps {
  readonly llm: ContextualLlm;
  readonly store: IntakeStore;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * The Liaison's tender intake. Each unconsumed tender is read by one structured
 * call; its result is recorded whole or not at all. A failed read leaves the
 * tender unconsumed with the failure counted; at the cap the client gets a report
 * saying intake failed and the tender is consumed, so the loop does not spin.
 * Nothing but a failed read is counted.
 */
export class TenderIntake implements LiaisonIntake {
  constructor(private readonly deps: TenderIntakeDeps) {}

  /**
   * A tender whose own record is inconsistent, or whose questions the store posts
   * wrongly, blocks its project, and the other tenders are still taken in. Any other
   * failure that is not the read's own (a spend-cap refusal, a ledger or store
   * failure) throws through with its class and fails the cycle, counting nothing.
   */
  async runPending(): Promise<readonly IntakeOutcome[]> {
    const outcomes: IntakeOutcome[] = [];
    for (const tender of await this.deps.store.openTenders()) {
      try {
        outcomes.push(await this.intake(tender));
      } catch (err) {
        if (!(err instanceof IntakeFailureUnrecorded || err instanceof QuestionIdsMismatch)) throw err;
        outcomes.push(await this.block(tender, projectBlockCause(err)));
      }
    }
    return outcomes;
  }

  private async block(tender: OpenTender, cause: ProjectBlockCause): Promise<IntakeOutcome> {
    const result = await this.deps.store.blockProject(tender.projectId, cause);
    console.warn(
      `[liaison-intake] tender ${tender.id} (project ${tender.projectId}): ${cause.errorClass}; ` +
        `project ${result}: ${cause.reason}`,
    );
    return { kind: "project-blocked", tenderId: tender.id, projectId: tender.projectId, cause };
  }

  private async intake(tender: OpenTender): Promise<IntakeOutcome> {
    const { store } = this.deps;
    const base = { tenderId: tender.id, projectId: tender.projectId };

    // A previous cycle reached the cap but did not close the tender.
    if (tender.intakeAttempts >= MAX_INTAKE_ATTEMPTS) {
      if (tender.intakeLastError === null) throw new IntakeFailureUnrecorded(tender.id, tender.intakeAttempts);
      await store.closeFailedTender(tender, failureReport(tender.intakeAttempts));
      return { kind: "abandoned", ...base, attempts: tender.intakeAttempts };
    }

    const visionVersion = await store.currentVisionVersion(tender.projectId);
    if (visionVersion !== null) {
      await store.consumeTender(tender.id);
      console.warn(
        `[liaison-intake] tender ${tender.id}: project ${tender.projectId} already has vision v${visionVersion}; ` +
          `tender consumed without intake`,
      );
      return { kind: "vision-exists", ...base, visionVersion };
    }

    let response: IntakeResponse;
    try {
      response = await this.read(tender);
    } catch (err) {
      if (classifyReadFailure(err) === "ashara-fault") throw err;
      return this.fail(tender, err);
    }
    const commit = await store.recordIntake(this.toWrite(tender, response));
    if (commit.kind === "vision-exists") {
      return { kind: "vision-exists", ...base, visionVersion: commit.visionVersion };
    }
    return { kind: "recorded", ...base, questions: commit.questionIds.length };
  }

  private async read(tender: OpenTender): Promise<IntakeResponse> {
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: tender.projectId, taskId: null, callSite: "liaison-intake" }),
      {
        site: "liaison-intake",
        // 2, not 3: the re-ask corrects one malformed emission, escalation covers
        // a model that keeps failing, and a failed tender is retried up to
        // MAX_INTAKE_ATTEMPTS times around this ladder.
        attempts: 2,
        onAttempt: this.deps.onAttempt,
        reask: intakeReask,
      },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: buildIntakePrompt(tender.body),
      schema: IntakeResponseSchema,
      maxTokens: 4096,
    });
    return response.data;
  }

  private toWrite(tender: OpenTender, response: IntakeResponse): IntakeWrite {
    const inferences = inferencesOf(response);
    return {
      tender,
      questions: response.questions.map(questionBody),
      assumptionsReport: assumptionsReport(inferences),
      vision: (questionMessageIds) => ({
        visionText: tender.body,
        summary: response.summary,
        scopeBoundaries: [
          ...response.inScope.map((text): ScopeLine => ({ text, side: "in" })),
          ...response.outOfScope.map((text): ScopeLine => ({ text, side: "out" })),
        ],
        inferences,
        openQuestions: response.questions.map((q, i) => {
          const messageId = questionMessageIds[i];
          if (questionMessageIds.length !== response.questions.length || messageId === undefined) {
            throw new QuestionIdsMismatch(tender.id, response.questions.length, questionMessageIds.length);
          }
          return { messageId, text: q.text, whyItMatters: q.whyItMatters, assumptionKey: assumptionKey(i) };
        }),
      }),
    };
  }

  private async fail(tender: OpenTender, err: unknown): Promise<IntakeOutcome> {
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(tender.id, error);
    console.warn(
      `[liaison-intake] tender ${tender.id} (project ${tender.projectId}): attempt ${attempt}/${MAX_INTAKE_ATTEMPTS} failed: ${error}`,
    );
    const base = { tenderId: tender.id, projectId: tender.projectId };
    if (attempt < MAX_INTAKE_ATTEMPTS) return { kind: "failed", ...base, attempt, error };

    await this.deps.store.closeFailedTender(tender, failureReport(attempt));
    console.warn(
      `[liaison-intake] tender ${tender.id}: intake abandoned after ${attempt} attempts; failure reported to the client`,
    );
    return { kind: "abandoned", ...base, attempts: attempt };
  }
}
