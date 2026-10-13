import { z } from "zod";
import { withStructuredLadder } from "@ashara/llm-gateway";
import type { ContextualLlm, LadderAttemptEvent } from "@ashara/llm-gateway";
import type { ProjectId } from "@ashara/shared";

// The Liaison's intake of a tender (story s-liaison-intake-m1, ADR-075 Engagement).
// Proceed on silence at once (orchestrator 2026-10-13, on the board): the questions
// go out, the assumptions work proceeds on are recorded as Inferred, and vision v1
// is written in the same intake. A later answer is a change request, not a rewrite.

/** At most this many questions per tender (orchestrator 2026-10-13, on the board). */
const MAX_QUESTIONS_PER_TENDER = 5;

/** Failed intake attempts after which the Liaison stops retrying and reports to the client. */
const MAX_INTAKE_ATTEMPTS = 3;

const IntakeResponseSchema = z.strictObject({
  summary: z.string().min(1),
  scopeBoundaries: z.array(z.string().min(1)).min(1),
  assumptions: z.array(z.strictObject({ statement: z.string().min(1), rationale: z.string().min(1) })),
  // Over the cap is rejected, never truncated: a dropped question would be a
  // question the client was never asked and no record says was cut.
  questions: z
    .array(z.strictObject({ text: z.string().min(1), whyItMatters: z.string().min(1) }))
    .max(MAX_QUESTIONS_PER_TENDER),
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

/** An Inferred assumption: what work proceeds on until the client says otherwise. */
interface InferredAssumption {
  readonly statement: string;
  readonly rationale: string;
  readonly status: "Inferred";
}

interface OpenQuestion {
  readonly messageId: string;
  readonly text: string;
  readonly whyItMatters: string;
}

/** Vision v1 as intake writes it. */
interface IntakeVision {
  readonly visionText: string;
  readonly summary: string;
  readonly scopeBoundaries: readonly string[];
  readonly inferences: readonly InferredAssumption[];
  readonly openQuestions: readonly OpenQuestion[];
}

interface IntakeWrite {
  readonly tender: OpenTender;
  /** Question bodies as posted to the client, in order. */
  readonly questions: readonly string[];
  readonly vision: (questionMessageIds: readonly string[]) => IntakeVision;
}

type IntakeCommit =
  | { readonly kind: "recorded"; readonly questionIds: readonly string[] }
  | { readonly kind: "vision-exists"; readonly visionVersion: number };

/** Engagement's persistence port for intake. Each write method is one transaction. */
export interface IntakeStore {
  openTenders(): Promise<readonly OpenTender[]>;
  currentVisionVersion(projectId: ProjectId): Promise<number | null>;
  /** Consumes the tender, posts the questions and writes vision v1 together. */
  recordIntake(write: IntakeWrite): Promise<IntakeCommit>;
  /** Consumes the tender and writes nothing else. */
  consumeTender(tenderId: string): Promise<void>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(tenderId: string, error: string): Promise<number>;
  /** Posts the report and consumes the tender together. */
  closeFailedTender(tender: OpenTender, report: string): Promise<void>;
}

export type IntakeOutcome =
  | { readonly kind: "recorded"; readonly tenderId: string; readonly projectId: ProjectId; readonly questions: number }
  | { readonly kind: "vision-exists"; readonly tenderId: string; readonly projectId: ProjectId; readonly visionVersion: number }
  | { readonly kind: "failed"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "abandoned"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempts: number };

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

/** The store posted a different number of questions than intake asked it to. */
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

/**
 * A thrown non-Error as text. JSON.stringify throws on a circular value or a
 * BigInt and returns undefined for a function or symbol; the description must
 * never throw, or the failed attempt it describes would go uncounted.
 */
function describeNonError(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (stringifyError) {
    const reason = stringifyError instanceof Error ? stringifyError.message : "unknown reason";
    const kind = value === null ? "null" : typeof value === "object" ? (value.constructor?.name ?? "object") : typeof value;
    return `${kind} (not serializable: ${reason})`;
  }
  return json ?? String(value);
}

/** The error chain as one line, every cause's name and message kept. */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined && parts.length < 8) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(`non-Error thrown: ${describeNonError(current)}`);
      break;
    }
  }
  return parts.join(" <- caused by ");
}

function buildIntakePrompt(tender: string): string {
  return [
    `You are the Liaison of a software contractor. A client has sent the tender below.`,
    `Read it and prepare the first version of the project's vision. Work starts now on what`,
    `you record here; the client may answer your questions later, and an answer then changes`,
    `the plan through a change request.`,
    ``,
    `Tender:`,
    JSON.stringify(tender),
    ``,
    `Return:`,
    `- "summary": what the client wants built, in a few sentences, in the tender's own terms.`,
    `- "scopeBoundaries": what is in scope and what is explicitly out of scope, one item per`,
    `  string, each grounded in the tender.`,
    `- "assumptions": every decision the tender leaves open that work must proceed on. For each,`,
    `  "statement" is the decision you will proceed with, and "rationale" is why the tender makes`,
    `  it the most defensible choice.`,
    `- "questions": at most ${MAX_QUESTIONS_PER_TENDER} questions to the client, fewer when fewer matter.`,
    `  Ask only where a wrong assumption would change what gets built, and for each such`,
    `  question also record the assumption you proceed on until it is answered. "whyItMatters"`,
    `  says what changes depending on the answer.`,
    ``,
    `Rules:`,
    `- Every question must name something specific to THIS tender. Never ask a generic`,
    `  checklist question that could be put to any project.`,
    `- Do not choose or suggest a technology, language, framework or platform the tender does`,
    `  not name. If the tender names one, record it as stated, not as an assumption.`,
    `- An empty question list is correct when nothing open would change what gets built.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"summary": "...", "scopeBoundaries": ["..."], ` +
      `"assumptions": [{"statement": "...", "rationale": "..."}], ` +
      `"questions": [{"text": "...", "whyItMatters": "..."}]}`,
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

function questionBody(question: IntakeResponse["questions"][number]): string {
  return `${question.text}\n\nWhy it matters: ${question.whyItMatters}`;
}

/**
 * What the client reads when intake gives up. The error chain stays in
 * intake_last_error and the warn log: provider and validation text is internal,
 * and it can carry another party's error detail. No operator alert exists beyond
 * the warn log, so the report does not promise one.
 */
function failureReport(attempts: number): string {
  return [
    `Ashara could not process your tender after ${attempts} attempts, so this request has been stopped.`,
    `Nothing was built for this project, and nothing was charged beyond those ${attempts} recorded attempts to read the tender.`,
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
 * call; its result is recorded whole or not at all. A failed attempt leaves the
 * tender unconsumed with the failure counted; at the cap the client gets a report
 * saying intake failed and the tender is consumed, so the loop does not spin.
 */
export class TenderIntake implements LiaisonIntake {
  constructor(private readonly deps: TenderIntakeDeps) {}

  async runPending(): Promise<readonly IntakeOutcome[]> {
    const outcomes: IntakeOutcome[] = [];
    for (const tender of await this.deps.store.openTenders()) {
      outcomes.push(await this.intake(tender));
    }
    return outcomes;
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

    let commit: IntakeCommit;
    let response: IntakeResponse;
    try {
      response = await this.read(tender);
      commit = await store.recordIntake(this.toWrite(tender, response));
    } catch (err) {
      return this.fail(tender, err);
    }
    if (commit.kind === "vision-exists") {
      return { kind: "vision-exists", ...base, visionVersion: commit.visionVersion };
    }
    return { kind: "recorded", ...base, questions: commit.questionIds.length };
  }

  private async read(tender: OpenTender): Promise<IntakeResponse> {
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: tender.projectId, taskId: null, callSite: "liaison-intake" }),
      { site: "liaison-intake", onAttempt: this.deps.onAttempt, reask: intakeReask },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: buildIntakePrompt(tender.body),
      schema: IntakeResponseSchema,
      maxTokens: 4096,
      temperature: 0,
    });
    return response.data;
  }

  private toWrite(tender: OpenTender, response: IntakeResponse): IntakeWrite {
    return {
      tender,
      questions: response.questions.map(questionBody),
      vision: (questionMessageIds) => ({
        visionText: tender.body,
        summary: response.summary,
        scopeBoundaries: response.scopeBoundaries,
        inferences: response.assumptions.map((a) => ({
          statement: a.statement,
          rationale: a.rationale,
          status: "Inferred" as const,
        })),
        openQuestions: response.questions.map((q, i) => {
          const messageId = questionMessageIds[i];
          if (questionMessageIds.length !== response.questions.length || messageId === undefined) {
            throw new QuestionIdsMismatch(tender.id, response.questions.length, questionMessageIds.length);
          }
          return { messageId, text: q.text, whyItMatters: q.whyItMatters };
        }),
      }),
    };
  }

  private async fail(tender: OpenTender, err: unknown): Promise<IntakeOutcome> {
    const error = describeError(err);
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
