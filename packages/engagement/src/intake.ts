import { z } from "zod";
import type { ContextualLlm } from "@ashara/finance";
import {
  SECOND_OPINION_STRENGTHS,
  SecondOpinionUnanswered,
  SecondOpinionUnavailable,
  StructuredOutputExhausted,
  modelCallFailureOf,
  withStructuredLadder,
} from "@ashara/finance";
import type { LadderAttemptEvent, SecondOpinion, SecondOpinionStrength } from "@ashara/finance";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";
import { projectBlockCause } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import type { AssumptionKind, ScopeLine } from "./vision-language/vision-assumption.js";
import { ASSUMPTION_KIND_RULE, ClassifiedAssumptionKindSchema } from "./vision-language/vision-assumption.js";
import type { FirstVision, InferredAssumption } from "./vision.js";

// The Liaison's intake of a tender.
// Proceed on silence at once: the questions
// go out, the assumptions work proceeds on are recorded as Inferred, and vision v1
// is written in the same intake. A later answer is a change request, not a rewrite.
// The assumptions no question carries are reported to the client in one message of the
// same intake, without waiting, so every Inferred
// assumption intake writes is one the client was asked about or told of.
// A reading that asks the client nothing is a claim that the tender leaves nothing open worth asking,
// as a clean suite review is a claim about its checks:
// it is put to a second reading at the strongest independence the catalog offers. The questions a
// second reading asks are the ones the client is sent, so Ashara writes none of its own. The strength
// that confirmed the reading, or that none answered, is recorded and told to the client.

/** At most this many questions per tender. */
const MAX_QUESTIONS_PER_TENDER = 5;

/**
 * Failed reads of a tender after which the Liaison stops retrying and reports to the client. Only the
 * read counts, the model's failure or its provider's (modelCallFailureOf): Ashara's own faults never
 * use up the client's tender.
 */
const MAX_INTAKE_ATTEMPTS = 3;

/** What the client reads before a question's assumption; the statement itself never carries it. */
const ASSUMPTION_LABEL = "Until you answer, we proceed on this assumption:";

// The label's lead-in, alone or with the rest of the label, at the start of a statement.
const LABEL_LEAD_IN = /^\s*until you answer\b\s*,?\s*(?:we proceed on this assumption\b\s*:?\s*)?/i;

/**
 * The assumption statement without a lead-in that repeats the label shown before
 * it: a model may write "Until you answer, ..." into a statement, which the
 * client would read twice and the vision would store.
 */
function withoutLabelLeadIn(statement: string): string {
  const rest = statement.replace(LABEL_LEAD_IN, "").trim();
  return rest === statement.trim() ? rest : rest.charAt(0).toUpperCase() + rest.slice(1);
}

// A statement that is nothing but the lead-in is rejected (and re-asked), never stored empty.
const AssumptionStatementSchema = z.string().min(1).transform(withoutLabelLeadIn).pipe(z.string().min(1));

// "kind": behaviour the client could observe, or the team's own design choice no
// client could observe. The Liaison classifies each assumption when it writes it; "undecided" is
// recorded as client-visible, and only a client-visible one may become the source of an acceptance line.
const AssumptionSchema = z.strictObject({
  statement: AssumptionStatementSchema,
  rationale: z.string().min(1),
  kind: ClassifiedAssumptionKindSchema,
});

// Over the cap is rejected, never truncated: a dropped question would be a question the client was
// never asked and no record says was cut. Each question carries the assumption adopted until it is
// answered: a later answer is a change request against that assumption, so a question without one has
// nothing to change. An empty list is a claim, which a second reading confirms or answers.
const QuestionsSchema = z
  .array(z.strictObject({ text: z.string().min(1), whyItMatters: z.string().min(1), assumption: AssumptionSchema }))
  .max(MAX_QUESTIONS_PER_TENDER);

export const IntakeResponseSchema = z.strictObject({
  summary: z.string().min(1),
  // Kept apart so the vision records each line's side, and no report has to read it from the wording.
  inScope: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)),
  questions: QuestionsSchema,
  /** Assumptions work proceeds on without asking the client. */
  assumptions: z.array(AssumptionSchema),
});

type IntakeResponse = z.infer<typeof IntakeResponseSchema>;
type IntakeQuestion = IntakeResponse["questions"][number];

/** A second reading's answer: the questions it would put to the client; none confirms the first reading. */
export const SecondReadingSchema = z.strictObject({ questions: QuestionsSchema });

/** The model a reading's answer came from, as the response named it. */
interface ReadingModel {
  readonly provider: string;
  readonly model: string;
}

/** The first reading's answer and the model that gave it. */
interface FirstReading {
  readonly response: IntakeResponse;
  readonly model: ReadingModel;
}

/**
 * A strength of second reading no answer was had at: the catalog offered no model for it, or the
 * model it went to gave no fit answer. Recorded, so moving to a weaker strength is never silent.
 */
interface PassedOver {
  readonly strength: SecondOpinionStrength;
  readonly outcome: "unavailable" | "failed";
  readonly reason: string;
}

/** The second reading that answered: its strength against the first, its model and the questions it asked. */
interface SecondReading {
  readonly strength: SecondOpinionStrength;
  readonly model: ReadingModel;
  readonly questions: readonly IntakeQuestion[];
}

/**
 * How the tender's first reading stands (intake_readings.confirmation): it asked the
 * client questions, so there is no claim to confirm; or it asked none, and a second reading asked none
 * either, or asked the questions the client is sent; or no second reading answered at any strength.
 */
export type ReadingConfirmation =
  | { readonly kind: "not-needed" }
  | { readonly kind: "confirmed" | "questions-raised"; readonly second: SecondReading; readonly passedOver: readonly PassedOver[] }
  | { readonly kind: "unconfirmed"; readonly passedOver: readonly [PassedOver, ...PassedOver[]] };

/** The tender's reading as intake_readings records it. */
export interface IntakeReading {
  readonly first: ReadingModel;
  readonly firstQuestions: number;
  readonly confirmation: ReadingConfirmation;
}

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
  /** The report of how a reading that asked nothing was confirmed; null when the first reading asked questions. */
  readonly readingReport: string | null;
  readonly reading: IntakeReading;
  readonly vision: (questionMessageIds: readonly string[]) => FirstVision;
}

type IntakeCommit =
  | { readonly kind: "recorded"; readonly questionIds: readonly string[] }
  | { readonly kind: "vision-exists"; readonly visionVersion: number };

/** Engagement's persistence port for intake. Each write method is one transaction. */
export interface IntakeStore {
  openTenders(): Promise<readonly OpenTender[]>;
  currentVisionVersion(projectId: ProjectId): Promise<number | null>;
  /** Consumes the tender, posts the questions and both reports, records the reading and writes vision v1, together. */
  recordIntake(write: IntakeWrite): Promise<IntakeCommit>;
  /** Consumes the tender and writes nothing else. */
  consumeTender(tenderId: string): Promise<void>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(tenderId: string, error: string): Promise<number>;
  /** Posts the report and consumes the tender together. */
  closeFailedTender(tender: OpenTender, report: string): Promise<void>;
  /**
   * Blocks the project and records why; a project already
   * blocked keeps its first cause. A blocked project's tenders are not open.
   */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type IntakeOutcome =
  | {
      readonly kind: "recorded";
      readonly tenderId: string;
      readonly projectId: ProjectId;
      readonly questions: number;
      readonly confirmation: ReadingConfirmation["kind"];
    }
  | { readonly kind: "vision-exists"; readonly tenderId: string; readonly projectId: ProjectId; readonly visionVersion: number }
  | { readonly kind: "failed"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  /** The tender's intake failed on Ashara's side: recorded on it and taken in again after the backoff; the other tenders go on. */
  | StepFaulted
  | { readonly kind: "abandoned"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempts: number }
  | { readonly kind: "project-blocked"; readonly tenderId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison each cycle. */
export interface LiaisonIntake {
  runPending(): Promise<readonly IntakeOutcome[]>;
}

/**
 * A tender reached its attempt cap with no error on record. A store
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

/**
 * A second reading of one strength was answered by a model of another strength: no confirmation is
 * read from it. The gateway pins each strength to its model, so this is Ashara's own fault, never the
 * client's tender's: contained to the tender (containEach), never counted against it.
 */
class SecondReadingMisrouted extends Error {
  constructor(
    readonly tenderId: string,
    readonly asked: SecondOpinionStrength,
    readonly first: ReadingModel,
    readonly answered: ReadingModel,
  ) {
    super(
      `tender ${tenderId}: a ${asked} second reading of ${modelName(first)}'s reading was answered by ${modelName(answered)}, ` +
        `which is ${strengthBetween(first, answered)}: no confirmation is read from it`,
    );
    this.name = "SecondReadingMisrouted";
  }
}

/** No strength of second reading was asked at all: SECOND_OPINION_STRENGTHS holds none, so nothing could confirm the reading. */
class SecondReadingUnasked extends Error {
  constructor(readonly tenderId: string) {
    super(`tender ${tenderId}: its reading asked nothing, yet no strength of second reading was asked`);
    this.name = "SecondReadingUnasked";
  }
}

function modelName(model: ReadingModel): string {
  return `${model.provider}/${model.model}`;
}

/** The strength the answering model has against the first, from the two models alone. */
function strengthBetween(first: ReadingModel, second: ReadingModel): SecondOpinionStrength {
  if (first.provider !== second.provider) return "other-family";
  return first.model === second.model ? "same-model" : "same-family-other-model";
}

/** What every question carries, as both readings of a tender are told. */
const QUESTION_FORM = [
  `  For each: "text" is the question; "whyItMatters" says what gets built differently, or`,
  `  what stops working for the client, depending on the answer; "assumption" is the decision`,
  `  you proceed on until the client answers ("statement") and why the tender makes it the`,
  `  most defensible choice ("rationale"). The client reads the statement after the label`,
  `  ${JSON.stringify(ASSUMPTION_LABEL)}, and it is also recorded in the vision on its own, so`,
  `  "statement" is the decision alone, stated plainly as what will be built and what it`,
  `  means for the client if they never answer. Do not begin it with that label or any`,
  `  wording like it ("Until you answer", "We assume", "For now").`,
];

/** How the questions are chosen, as both readings of a tender are told. */
const QUESTION_RULES = [
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
];

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
    ...QUESTION_FORM,
    `- "assumptions": every other decision the tender leaves open that work must proceed on,`,
    `  each with the same "statement" and "rationale". Do not repeat a question's assumption.`,
    `  The client is told of each of them, and work proceeds on them unless the client objects.`,
    `- Every assumption, a question's included, has a "kind":`,
    ...ASSUMPTION_KIND_RULE,
    `  When one decision fixes both a behaviour and the mechanism behind it, record two`,
    `  assumptions: the behaviour as client-visible, the mechanism as internal-design.`,
    ``,
    `How to choose the questions:`,
    ...QUESTION_RULES,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"summary": "...", "inScope": ["..."], "outOfScope": ["..."], ` +
      `"questions": [{"text": "...", "whyItMatters": "...", ` +
      `"assumption": {"statement": "...", "rationale": "...", "kind": "client-visible"}}], ` +
      `"assumptions": [{"statement": "...", "rationale": "...", "kind": "undecided"}]}`,
  ].join("\n");
}

/**
 * How a second reading reads the tender: `direct` as the first reading does, when another model family
 * answers; `ambiguities` within the first's family, which shares more of its blind spots and so starts
 * from what the tender leaves ambiguous or assumed.
 */
type ReadingAngle = "direct" | "ambiguities";

/** The angle a second reading of each strength is asked from: only another family reads as the first did. */
const ANGLE_OF: Readonly<Record<SecondOpinionStrength, ReadingAngle>> = {
  "other-family": "direct",
  "same-family-other-model": "ambiguities",
  "same-model": "ambiguities",
};

function readingAngleSection(angle: ReadingAngle): string[] {
  if (angle === "direct") return [];
  return [
    `Read the tender from this angle first. Work out what in it is ambiguous or assumed: every word, number,`,
    `limit, format or behaviour it leaves open to more than one reading, and every decision a builder would`,
    `have to assume because the tender does not make it. Then choose the questions from those, as below.`,
    ``,
  ];
}

/**
 * The second reading's prompt: the tender alone, never the first reading's answer, so the second
 * reading is not anchored on it; asked only for the questions the client must be sent.
 */
function secondReadingPrompt(tender: string, angle: ReadingAngle): string {
  return [
    `You are the Liaison of a software contractor. A client has sent the tender below. Work on it starts`,
    `now; every decision the tender leaves open is settled by an assumption the team records and tells`,
    `the client of. Find the questions the client must be asked instead, because a wrong assumption`,
    `would cost them.`,
    ``,
    `Tender:`,
    JSON.stringify(tender),
    ``,
    ...readingAngleSection(angle),
    `Return "questions": at most ${MAX_QUESTIONS_PER_TENDER} questions to the client, most impactful first.`,
    ...QUESTION_FORM,
    `Every question's assumption has a "kind":`,
    ...ASSUMPTION_KIND_RULE,
    ``,
    `How to choose the questions:`,
    ...QUESTION_RULES,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"questions": [{"text": "...", "whyItMatters": "...", ` +
      `"assumption": {"statement": "...", "rationale": "...", "kind": "client-visible"}}]}`,
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
 * The questions the client is sent: the first reading's, or the second reading's when the first asked
 * none and the second raised some.
 */
function questionsAsked(first: IntakeResponse, confirmation: ReadingConfirmation): readonly IntakeQuestion[] {
  return confirmation.kind === "questions-raised" ? confirmation.second.questions : first.questions;
}

/**
 * Every assumption of the intake, keyed: the asked questions' first, in question order, then the
 * unasked ones, which the assumptions report tells the client of.
 */
function inferencesOf(questions: readonly IntakeQuestion[], response: IntakeResponse): InferredAssumption[] {
  const asked = questions.map((q) => ({ ...q.assumption, disclosed: "asked" as const }));
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
 * What the client reads of the assumptions no question asked about: the
 * decisions work proceeds on unless they object, behaviour first, then the team's design choices.
 * Nothing waits on a reply. Null when there are none.
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

/** Who gave a second reading, in the client's words: a weaker strength says what it shares with the first. */
const READ_BY: Readonly<Record<SecondOpinionStrength, string>> = {
  "other-family": "another model family",
  "same-family-other-model": "another model of the same family as the first reading, which shares more of its blind spots than another family would",
  "same-model": "the same model as the first reading, asked again to look for what is ambiguous or assumed, which shares every one of its blind spots",
};

/**
 * What the client reads when the first reading of their tender asked them nothing: that a second
 * reading, of the strength named, found nothing to ask either, or raised the questions they are sent;
 * or that none could be had, so the reading is unconfirmed and work proceeds on it. Null when the first
 * reading asked questions: those are what the client reads.
 */
function readingReport(confirmation: ReadingConfirmation): string | null {
  switch (confirmation.kind) {
    case "not-needed":
      return null;
    case "confirmed":
      return [
        `We read your tender and found nothing in it we need to ask you before work proceeds. A second reading of it, by ` +
          `${READ_BY[confirmation.second.strength]}, found nothing to ask either.`,
        `If anything in the tender can be read more than one way, tell us. Work does not wait for a reply.`,
      ].join("\n\n");
    case "questions-raised":
      return (
        `Our first reading of your tender found nothing to ask you. A second reading of it, by ${READ_BY[confirmation.second.strength]}, ` +
        `found the ${confirmation.second.questions.length === 1 ? "question" : `${confirmation.second.questions.length} questions`} we have sent you; ` +
        `until you answer, work proceeds on the assumption each one states.`
      );
    case "unconfirmed":
      return [
        `We read your tender and found nothing in it we need to ask you before work proceeds, but no second reading of it ` +
          `could be had to confirm that, so that reading is unconfirmed. Work proceeds on it.`,
        `If anything in the tender can be read more than one way, tell us. Work does not wait for a reply.`,
      ].join("\n\n");
  }
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
  /** Each tender's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * The Liaison's tender intake. Each unconsumed tender is read by one structured
 * call; a reading that asks nothing is put to a second reading; the result is
 * recorded whole or not at all. A failed read leaves the tender unconsumed with the
 * failure counted; at the cap the client gets a report saying intake failed and the
 * tender is consumed, so the loop does not spin. Nothing but a failed read is counted.
 */
export class TenderIntake implements LiaisonIntake {
  constructor(private readonly deps: TenderIntakeDeps) {}

  /**
   * A tender whose own record is inconsistent, or whose questions the store posts
   * wrongly, blocks its project, and the other tenders are still taken in. Any other
   * failure that is not the read's own (a price refusal, a ledger or store failure, a
   * provider rejecting what Ashara sent, a misrouted second reading, an error nothing
   * names) is that tender's, contained to it (containEach), never counted against it;
   * a spend-cap refusal throws through to the core loop, which halts at the cap.
   */
  async runPending(): Promise<readonly IntakeOutcome[]> {
    const tenders = await this.deps.store.openTenders();
    return containEach(this.deps.containment, "liaison-intake", tenders, (tender) => ({ id: tender.id, projectId: tender.projectId }), async (tender) => {
      try {
        return await this.intake(tender);
      } catch (err) {
        if (!(err instanceof IntakeFailureUnrecorded || err instanceof QuestionIdsMismatch)) throw err;
        return this.block(tender, projectBlockCause(err));
      }
    });
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

    let first: FirstReading;
    try {
      first = await this.read(tender);
    } catch (err) {
      if (modelCallFailureOf(err) === "ashara") throw err;
      return this.fail(tender, err);
    }
    const confirmation: ReadingConfirmation =
      first.response.questions.length > 0 ? { kind: "not-needed" } : await this.secondReading(tender, first.model);
    const commit = await store.recordIntake(this.toWrite(tender, first, confirmation));
    if (commit.kind === "vision-exists") {
      return { kind: "vision-exists", ...base, visionVersion: commit.visionVersion };
    }
    return { kind: "recorded", ...base, questions: commit.questionIds.length, confirmation: confirmation.kind };
  }

  private ladder(tender: OpenTender) {
    return withStructuredLadder(
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
  }

  private async read(tender: OpenTender): Promise<FirstReading> {
    const response = await this.ladder(tender).generateStructured({
      capability: "Strong",
      prompt: buildIntakePrompt(tender.body),
      schema: IntakeResponseSchema,
      maxTokens: 4096,
    });
    return { response: response.data, model: { provider: response.provider, model: response.model } };
  }

  /**
   * The second reading of a first reading that asked nothing, at the strongest independence that
   * answers, the strengths asked in order: one the catalog does not
   * serve (SecondOpinionUnavailable) or whose model gave no fit answer (SecondOpinionUnanswered,
   * StructuredOutputExhausted) is passed over, recorded and logged, and the next is asked. When none
   * answers, the reading is unconfirmed: work proceeds on it and the client is told, so the bound is
   * the three strengths and the tender is never held. Any other throw (a spend-cap refusal, a
   * misrouted answer) is not the second reading's failure and fails the intake as Ashara's.
   */
  private async secondReading(tender: OpenTender, first: ReadingModel): Promise<ReadingConfirmation> {
    const provider = this.ladder(tender);
    const passedOver: PassedOver[] = [];
    for (const strength of SECOND_OPINION_STRENGTHS) {
      const secondOpinion: SecondOpinion = { avoid: first, strength };
      try {
        const response = await provider.generateStructured({
          capability: "Strong",
          prompt: secondReadingPrompt(tender.body, ANGLE_OF[strength]),
          schema: SecondReadingSchema,
          maxTokens: 4096,
          secondOpinion,
        });
        const model = { provider: response.provider, model: response.model };
        if (strengthBetween(first, model) !== strength) throw new SecondReadingMisrouted(tender.id, strength, first, model);
        const second: SecondReading = { strength, model, questions: response.data.questions };
        return { kind: second.questions.length > 0 ? "questions-raised" : "confirmed", second, passedOver };
      } catch (err) {
        const unavailable = err instanceof SecondOpinionUnavailable;
        if (!(unavailable || err instanceof SecondOpinionUnanswered || err instanceof StructuredOutputExhausted)) throw err;
        const reason = describeErrorChain(err);
        passedOver.push({ strength, outcome: unavailable ? "unavailable" : "failed", reason });
        console.warn(
          `[liaison-intake] tender ${tender.id}: no ${strength} second reading (${unavailable ? "the catalog offers none" : "it failed"}); ` +
            `the next strength is asked: ${reason}`,
        );
      }
    }
    const [firstPassed, ...rest] = passedOver;
    if (firstPassed === undefined) throw new SecondReadingUnasked(tender.id);
    console.warn(
      `[liaison-intake] tender ${tender.id}: its reading asked the client nothing and no second reading answered at any strength; ` +
        `the reading is recorded unconfirmed and the client is told`,
    );
    return { kind: "unconfirmed", passedOver: [firstPassed, ...rest] };
  }

  private toWrite(tender: OpenTender, first: FirstReading, confirmation: ReadingConfirmation): IntakeWrite {
    const { response } = first;
    const questions = questionsAsked(response, confirmation);
    const inferences = inferencesOf(questions, response);
    return {
      tender,
      questions: questions.map(questionBody),
      assumptionsReport: assumptionsReport(inferences),
      readingReport: readingReport(confirmation),
      reading: { first: first.model, firstQuestions: response.questions.length, confirmation },
      vision: (questionMessageIds) => ({
        visionText: tender.body,
        summary: response.summary,
        scopeBoundaries: [
          ...response.inScope.map((text): ScopeLine => ({ text, side: "in" })),
          ...response.outOfScope.map((text): ScopeLine => ({ text, side: "out" })),
        ],
        inferences,
        openQuestions: questions.map((q, i) => {
          const messageId = questionMessageIds[i];
          if (questionMessageIds.length !== questions.length || messageId === undefined) {
            throw new QuestionIdsMismatch(tender.id, questions.length, questionMessageIds.length);
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
