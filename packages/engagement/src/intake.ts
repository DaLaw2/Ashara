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
import type { CapabilityLevel, LadderAttemptEvent, ModelCallFailure, SecondOpinion, SecondOpinionStrength } from "@ashara/finance";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";
import { modelCallBlockCategory, projectBlockCause } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import {
  AssumptionKeySchema,
  ContractDraftSchema,
  GuaranteeKeySchema,
  NOTHING_VERIFIABLE,
  OBSERVATION_RULE,
  basisOf,
  contractStandingOf,
  markOf,
  markWords,
  verifiableCountLine,
} from "./vision-language/guarantee.js";
import type { ContractStanding, GuaranteeBasis } from "./vision-language/guarantee.js";
import { ASSUMPTION_KIND_RULE, ASSUMPTION_LABEL, ClassifiedAssumptionKindSchema } from "./vision-language/vision-assumption.js";
import { VisionWriteRefused, visionWritable } from "./vision.js";
import type { FirstVision, InferredAssumption } from "./vision.js";

// The Liaison's intake of a tender: it drafts the contract a delivery is judged against, the
// product's interface as Ashara reads it, the guarantees, the assumptions each rests on and the
// exclusions. Proceed on silence at once: the questions go out, the assumptions work proceeds on
// are recorded as Inferred, vision v1 is written, and one contract draft tells the client every
// record of it, in the same intake. A later answer or correction is a change request, not a rewrite.
// Every Inferred assumption intake writes is one the client was asked about or told of in the draft.
// A tender is never refused: one Ashara cannot read blocks its project, and the tender is kept.
// A contract in which Ashara can verify no guarantee is the one exception to proceeding on silence:
// it is declined. Every message intake posts for it tells the client plainly that Ashara cannot verify
// any guarantee as written and asks them to restate the guarantees; no work starts on it, and their
// confirming it as written does not start work, since only a version holding a guarantee Ashara can
// verify ends the decline (declinesUnverifiable).
// A reading that asks the client nothing is a claim that the tender leaves nothing open worth asking,
// as a clean suite review is a claim about its checks:
// it is put to a second reading at the strongest independence the catalog offers. The questions a
// second reading asks are the ones the client is sent, so Ashara writes none of its own. The strength
// that confirmed the reading, or that none answered, is recorded and told to the client.

/** At most this many questions per tender. */
const MAX_QUESTIONS_PER_TENDER = 5;

/**
 * Failed reads of a tender after which the Liaison stops retrying and blocks the project. Only the
 * read counts, the model's failure or its provider's (modelCallFailureOf): Ashara's own faults never
 * use up the client's tender.
 */
const MAX_INTAKE_ATTEMPTS = 3;

/** The label on a contract Ashara declines: no work proceeds on it, so the assumption is only what the contract rests on. */
const HELD_ASSUMPTION_LABEL = "Until you answer, the contract rests on this assumption:";

// Either label's lead-in, alone or with the rest of the label, at the start of a statement.
const LABEL_LEAD_IN = /^\s*until you answer\b\s*,?\s*(?:(?:we proceed on|the contract rests on) this assumption\b\s*:?\s*)?/i;

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
// recorded as client-visible. "underpins": the guarantees that would change were it wrong; whether
// those keys resolve, and whether a client-visible one names any, the vision's own rules judge.
const assumptionFields = {
  statement: AssumptionStatementSchema,
  rationale: z.string().min(1),
  kind: ClassifiedAssumptionKindSchema,
  underpins: z.array(GuaranteeKeySchema),
};

// The first reading keys each assumption it drafts, so a guarantee or an exclusion can cite it.
const DraftedAssumptionSchema = z.strictObject({ id: AssumptionKeySchema, ...assumptionFields });

// A second reading cites nothing by key: its questions' assumptions are keyed after the first reading's.
const RaisedAssumptionSchema = z.strictObject(assumptionFields);

// Over the cap is rejected, never truncated: a dropped question would be a question the client was
// never asked and no record says was cut. Each question carries the assumption adopted until it is
// answered: a later answer is a change request against that assumption, so a question without one has
// nothing to change. An empty list is a claim, which a second reading confirms or answers.
const questionsWith = <A extends z.ZodType>(assumption: A) =>
  z.array(z.strictObject({ text: z.string().min(1), whyItMatters: z.string().min(1), assumption })).max(MAX_QUESTIONS_PER_TENDER);

export const IntakeResponseSchema = z.strictObject({
  summary: z.string().min(1),
  interface: ContractDraftSchema.shape.interface,
  guarantees: ContractDraftSchema.shape.guarantees,
  questions: questionsWith(DraftedAssumptionSchema),
  /** Assumptions work proceeds on without asking the client. */
  assumptions: z.array(DraftedAssumptionSchema),
  exclusions: ContractDraftSchema.shape.exclusions,
});

type IntakeResponse = z.infer<typeof IntakeResponseSchema>;

/** A second reading's answer: the questions it would put to the client; none confirms the first reading. */
export const SecondReadingSchema = z.strictObject({ questions: questionsWith(RaisedAssumptionSchema) });

type RaisedQuestion = z.infer<typeof SecondReadingSchema>["questions"][number];

/** What the client reads of a question, from either reading. */
interface QuestionText {
  readonly text: string;
  readonly whyItMatters: string;
  readonly assumption: { readonly statement: string; readonly rationale: string };
}

/** A question the client is sent, with the key of the assumption adopted until it is answered. */
interface AskedQuestion {
  readonly question: QuestionText;
  readonly key: string;
}

/** The model a reading's answer came from, as the response named it, with its catalog grade as it was called. */
interface ReadingModel {
  readonly provider: string;
  readonly model: string;
  readonly grade: CapabilityLevel;
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
  readonly questions: readonly RaisedQuestion[];
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
  /** The contract draft: every record of vision v1, as the client reads it. */
  readonly contractDraft: string;
  /** The report of how a reading that asked nothing was confirmed; null when the first reading asked questions. */
  readonly readingReport: string | null;
  readonly reading: IntakeReading;
  readonly vision: (questionMessageIds: readonly string[]) => FirstVision;
}

type IntakeCommit =
  | { readonly kind: "recorded"; readonly questionIds: readonly string[] }
  | { readonly kind: "vision-exists"; readonly visionVersion: number }
  /** The project no longer reads the tender now under its row lock: nothing was written and the tender stays unconsumed. */
  | { readonly kind: "moved"; readonly detail: string };

/** Engagement's persistence port for intake. Each write method is one transaction. */
export interface IntakeStore {
  openTenders(): Promise<readonly OpenTender[]>;
  currentVisionVersion(projectId: ProjectId): Promise<number | null>;
  /**
   * Consumes the tender, posts the questions, the contract draft and the reading report, records the
   * reading and writes vision v1, together, only while its project still reads the tender now.
   */
  recordIntake(write: IntakeWrite): Promise<IntakeCommit>;
  /**
   * Consumes the tender and writes nothing else, only while its project still reads the tender now
   * under its row lock; "moved" consumes nothing.
   */
  consumeTender(tender: Pick<OpenTender, "id" | "projectId">): Promise<{ readonly kind: "consumed" } | { readonly kind: "moved"; readonly detail: string }>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(tenderId: string, error: string): Promise<number>;
  /**
   * Blocks the project and records why; a project already blocked keeps its first cause. A blocked
   * project's tenders are not open, and the halt's end sets each one's count of failed reads back to
   * none (inboundDecision's resetOnHaltEnd), so the operator's unblock has it read again.
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
  /** Its project was halted, stopped or delivered while it was read: nothing was written, no attempt counted, and it is read once its project reads it again. */
  | { readonly kind: "moved"; readonly tenderId: string; readonly projectId: ProjectId; readonly detail: string }
  | { readonly kind: "failed"; readonly tenderId: string; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  /** The tender's intake failed on Ashara's side: recorded on it and taken in again after the backoff; the other tenders go on. */
  | StepFaulted
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
 * A tender failed every read intake makes of it. The project is blocked on Ashara's side and the
 * tender kept: it is never refused, and the operator's unblock has it read again.
 */
class IntakeReadExhausted extends Error {
  constructor(
    readonly tenderId: string,
    readonly attempts: number,
    readonly lastError: string,
    readonly failure: ModelCallFailure,
  ) {
    super(`tender ${tenderId} could not be read after ${attempts} attempts; last error: ${lastError}`);
    this.name = "IntakeReadExhausted";
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

/** What an assumption's "underpins" names, as both readings of a tender are told. */
const UNDERPINS_RULE = [
  `  "underpins" lists the keys of the guarantees that would change if the assumption were wrong.`,
  `  An assumption a client could observe underpins at least one guarantee, unless an exclusion`,
  `  cites it as its source; one of the team's own design choices may underpin none.`,
];

function buildIntakePrompt(tender: string): string {
  return [
    `You are the Liaison of a software contractor. A client has sent the tender below.`,
    `Read it and prepare the first version of the project's vision: the contract the delivery is`,
    `judged against. Work starts now on what you record here; the client may correct any line of`,
    `it at any time, and may answer your questions later, and an answer then changes the plan`,
    `through a change request against the assumption that question names.`,
    ``,
    `Tender:`,
    JSON.stringify(tender),
    ``,
    `Return:`,
    `- "summary": what the client wants built, in a few sentences, in the tender's own terms.`,
    `- "interface": the product's public interface as you read it from the tender, keyed "I1",`,
    `  "I2", and so on: one entry for each way the product is used, in the terms its kind has (a`,
    `  command with its arguments and exit statuses, a network route with its request and response,`,
    `  a function or type of a library's interface, or whatever else the product exposes), with`,
    `  "text" saying what the entry is and "source" where it comes from. Where the tender leaves an`,
    `  entry's form open, choose one form, never alternatives, and record the choice as an`,
    `  assumption the entry cites as its source.`,
    `- "guarantees": every promise a delivery of this tender is judged against, keyed "G1", "G2",`,
    `  and so on, together covering everything the tender asks to be built. Each has: "statement",`,
    `  the promise in one sentence; "observable", with "interface", the keys of the interface entries`,
    `  where it is seen (at least one), and "observation", as the rule below decides; "refutedBy", at`,
    `  least one concrete observation at the interface that would show the promise broken; and "source".`,
    ...OBSERVATION_RULE,
    `- "exclusions": what the tender leaves out, keyed "X1", "X2", and so on, each with "text" and`,
    `  "source", so the absence of a guarantee is never read as a promise; an empty list when it`,
    `  leaves nothing out.`,
    `- Every "source" is {"kind": "tender", "quote": "..."}, a sentence or phrase copied word for`,
    `  word from the tender, or {"kind": "assumption", "id": "A<n>"}, the key of one of your`,
    `  assumptions that the record rests on.`,
    `- "questions": at most ${MAX_QUESTIONS_PER_TENDER} questions to the client, most impactful first.`,
    ...QUESTION_FORM,
    `- "assumptions": every other decision the tender leaves open that work must proceed on,`,
    `  each with the same "statement" and "rationale". Do not repeat a question's assumption.`,
    `  The client is told of each of them, and work proceeds on them unless the client objects.`,
    `- Every assumption, a question's included, has an "id", "A1", "A2" and so on, no two alike,`,
    `  and "underpins":`,
    ...UNDERPINS_RULE,
    `- Every assumption, a question's included, has a "kind":`,
    ...ASSUMPTION_KIND_RULE,
    `  When one decision fixes both a behaviour and the mechanism behind it, record two`,
    `  assumptions: the behaviour as client-visible, the mechanism as internal-design.`,
    ``,
    `How to choose the questions:`,
    ...QUESTION_RULES,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"summary": "...", ` +
      `"interface": [{"id": "I1", "text": "...", "source": {"kind": "tender", "quote": "..."}}], ` +
      `"guarantees": [{"id": "G1", "statement": "...", "observable": {"interface": ["I1"], "observation": "output"}, ` +
      `"refutedBy": ["..."], "source": {"kind": "tender", "quote": "..."}}], ` +
      `"questions": [{"text": "...", "whyItMatters": "...", ` +
      `"assumption": {"id": "A1", "statement": "...", "rationale": "...", "kind": "client-visible", "underpins": ["G1"]}}], ` +
      `"assumptions": [{"id": "A2", "statement": "...", "rationale": "...", "kind": "undecided", "underpins": ["G1"]}], ` +
      `"exclusions": [{"id": "X1", "text": "...", "source": {"kind": "assumption", "id": "A2"}}]}`,
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
 * The second reading's prompt: the tender and the guarantees drafted from it, never the first
 * reading's questions or assumptions, so the second reading is not anchored on what the first chose
 * to ask or assume; asked only for the questions the client must be sent, each assumption naming
 * the guarantees it underpins.
 */
function secondReadingPrompt(tender: string, angle: ReadingAngle, guarantees: IntakeResponse["guarantees"]): string {
  return [
    `You are the Liaison of a software contractor. A client has sent the tender below. Work on it starts`,
    `now; every decision the tender leaves open is settled by an assumption the team records and tells`,
    `the client of. Find the questions the client must be asked instead, because a wrong assumption`,
    `would cost them.`,
    ``,
    `Tender:`,
    JSON.stringify(tender),
    ``,
    `The delivery is judged against these guarantees, drafted from the tender:`,
    ...guarantees.map((g) => `- ${g.id}: ${g.statement}`),
    ``,
    ...readingAngleSection(angle),
    `Return "questions": at most ${MAX_QUESTIONS_PER_TENDER} questions to the client, most impactful first.`,
    ...QUESTION_FORM,
    `Every question's assumption has "underpins", naming guarantees listed above:`,
    ...UNDERPINS_RULE,
    `Every question's assumption has a "kind":`,
    ...ASSUMPTION_KIND_RULE,
    ``,
    `How to choose the questions:`,
    ...QUESTION_RULES,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"questions": [{"text": "...", "whyItMatters": "...", ` +
      `"assumption": {"statement": "...", "rationale": "...", "kind": "client-visible", "underpins": ["G1"]}}]}`,
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

/**
 * What the client reads: the question, why it matters, and what Ashara does if they stay silent; on a
 * held contract, then the decline, so no message of the intake reads as work under way.
 */
function questionBody(question: QuestionText, standing: DraftStanding): string {
  const held = standing === "held";
  return [
    question.text,
    `Why it matters: ${question.whyItMatters}`,
    `${held ? HELD_ASSUMPTION_LABEL : ASSUMPTION_LABEL} ${question.assumption.statement}`,
    `Why this assumption: ${question.assumption.rationale}`,
    ...(held ? [NOTHING_VERIFIABLE] : []),
  ].join("\n\n");
}

/** The standing of the contract a reading of the tender drafts: it is read whole, so never unread. */
type DraftStanding = Exclude<ContractStanding, "unread">;

/** The assumptions vision v1 records and the questions the client is sent, each with its assumption's key. */
interface IntakeRecords {
  readonly inferences: readonly InferredAssumption[];
  readonly asked: readonly AskedQuestion[];
}

/**
 * The intake's assumptions, keyed: the first reading's under the keys it drafted them with, its
 * questions' asked and the rest reported in the contract draft; then the questions a second reading
 * raised, asked, keyed after the highest key the first reading drafted, so no record of the first
 * reading that cites an assumption comes to name another.
 */
function recordsOf(first: IntakeResponse, raised: readonly RaisedQuestion[]): IntakeRecords {
  const inferred = (key: string, a: z.infer<typeof RaisedAssumptionSchema>, disclosed: InferredAssumption["disclosed"]): InferredAssumption => ({
    key,
    statement: a.statement,
    rationale: a.rationale,
    status: "Inferred",
    kind: a.kind,
    disclosed,
    underpins: a.underpins,
  });
  const drafted = [
    ...first.questions.map((q) => inferred(q.assumption.id, q.assumption, "asked")),
    ...first.assumptions.map((a) => inferred(a.id, a, "reported")),
  ];
  const highest = Math.max(0, ...drafted.map((a) => Number(a.key.slice(1))));
  const raisedAsked = raised.map((question, i) => ({ question, key: `A${highest + i + 1}` }));
  return {
    inferences: [...drafted, ...raisedAsked.map(({ question, key }) => inferred(key, question.assumption, "asked"))],
    asked: [...first.questions.map((question) => ({ question, key: question.assumption.id })), ...raisedAsked],
  };
}

/**
 * Why the vision would refuse the contract these records make, as the reading that drafted it is
 * told when it is asked again; null when it would take it. The vision's own rules decide, so what a
 * reading is held to and what is stored are the one definition.
 */
function contractRefusal(tender: OpenTender, first: IntakeResponse, inferences: readonly InferredAssumption[]): string | null {
  try {
    visionWritable(tender.projectId, {
      visionText: tender.body,
      scopeBoundaries: [],
      inferences,
      openQuestions: [],
      contract: { form: "guarantees", interface: first.interface, guarantees: first.guarantees, exclusions: first.exclusions },
    }, "first");
    return null;
  } catch (err) {
    if (!(err instanceof VisionWriteRefused)) throw err;
    return `${err.field}: ${err.issues}`;
  }
}

/** The first reading's schema for one tender: an answer whose contract the vision would refuse is asked again, with why. */
function firstReadingSchema(tender: OpenTender) {
  return IntakeResponseSchema.superRefine((response, ctx) => {
    const refusal = contractRefusal(tender, response, recordsOf(response, []).inferences);
    if (refusal !== null) ctx.addIssue({ code: "custom", message: refusal });
  });
}

/** A second reading's schema: the questions it raises must leave the first reading's contract one the vision takes. */
function secondReadingSchema(tender: OpenTender, first: IntakeResponse) {
  return SecondReadingSchema.superRefine((second, ctx) => {
    const refusal = contractRefusal(tender, first, recordsOf(first, second.questions).inferences);
    if (refusal !== null) ctx.addIssue({ code: "custom", message: refusal });
  });
}

/** A guarantee's basis in the client's words. */
const BASIS_WORDS: Readonly<Record<GuaranteeBasis, string>> = {
  "client-stated": "what your tender states",
  "assumed-unconfirmed": "an assumption you have not confirmed",
  derived: "our reading of your tender",
};

/**
 * The contract draft the client reads with vision v1: the interface as Ashara reads it, the first
 * thing they may correct; every guarantee with its basis, one resting on an assumption they have
 * not confirmed marked at risk until they confirm it, one Ashara cannot verify with the checks it
 * can run marked not verifiable by Ashara with the reason, as the contract records it, and one whose
 * drafter could not tell where it is observed put to the client; how many Ashara can verify; the
 * assumptions they could observe, each with the guarantees it underpins; the exclusions, so silence is
 * never read as a promise; and the team's own design choices, which acceptance does not depend on.
 * Nothing waits on a reply, unless the contract is held: then the draft opens with the decline and
 * never says work has started or that nothing waits.
 */
function contractDraftReport(first: IntakeResponse, inferences: readonly InferredAssumption[], standing: DraftStanding): string {
  const held = standing === "held";
  const footing = inferences.map((a) => ({ id: a.key, status: a.status, underpins: a.underpins }));
  const guarantees = first.guarantees.map((g) => {
    const resting = inferences.filter((a) => a.underpins.includes(g.id) || (g.source.kind === "assumption" && g.source.id === a.key)).map((a) => a.key);
    const risk = resting.length === 0 ? "" : `; at risk until you confirm ${resting.join(", ")}`;
    const told = markWords(markOf(g.observable.observation));
    return `- ${g.id}: ${g.statement} (basis: ${BASIS_WORDS[basisOf(g, footing)]}${risk}${told === null ? "" : `; ${told}`})`;
  });
  const verifiable = first.guarantees.filter((g) => markOf(g.observable.observation).verification === "by-ashara").length;
  const excludedBy = (key: string): string[] => first.exclusions.filter((x) => x.source.kind === "assumption" && x.source.id === key).map((x) => x.id);
  const visible = inferences.flatMap((a) => {
    if (a.kind === "internal-design") return [];
    const grounds = [
      ...(a.underpins.length === 0 ? [] : [`underpins ${a.underpins.join(", ")}`]),
      ...excludedBy(a.key).map((x) => `the ground of exclusion ${x}`),
      ...(a.disclosed === "asked" ? ["asked in a question"] : []),
    ];
    return [`- ${a.key}: ${a.statement} (${grounds.join("; ")})`];
  });
  const design = inferences.filter((a) => a.kind === "internal-design").map((a) => `- ${a.key}: ${a.statement}`);
  return [
    held ? `This is the contract drafted from your tender, and Ashara declines it as written. ${NOTHING_VERIFIABLE}` : `This is the contract we are working to, drafted from your tender.`,
    `The interface, as we read it; it is the first thing you may correct:\n${first.interface.map((entry) => `- ${entry.id}: ${entry.text}`).join("\n")}`,
    `What we guarantee, each with what it rests on:\n${guarantees.join("\n")}`,
    verifiableCountLine(verifiable, first.guarantees.length),
    ...(visible.length === 0 ? [] : [`The assumptions the guarantees rest on:\n${visible.join("\n")}`]),
    first.exclusions.length === 0
      ? `What is left out: nothing is excluded on record.`
      : `What is left out, so that silence is never read as a promise:\n${first.exclusions.map((x) => `- ${x.id}: ${x.text}`).join("\n")}`,
    ...(design.length === 0 ? [] : [`Basis of Design, our own design choices, which your acceptance does not depend on:\n${design.join("\n")}`]),
    held
      ? `Correct any line at any time. ${RESTATE_TO_START}`
      : `Work has started on this list; correct any line at any time; nothing waits for your reply.`,
  ].join("\n\n");
}

/** How a declined contract's draft closes: what starts work on it. */
const RESTATE_TO_START = "Work starts once you restate the guarantees so that Ashara can verify at least one of them.";

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
 * reading asked questions: those are what the client reads. When the contract is held no work
 * proceeds on anything, so the report says what the reading found and then the decline, never that
 * work proceeds or does not wait.
 */
function readingReport(confirmation: ReadingConfirmation, standing: DraftStanding): string | null {
  if (confirmation.kind === "not-needed") return null;
  if (standing === "held") {
    const found = (() => {
      switch (confirmation.kind) {
        case "confirmed":
          return `We read your tender and found nothing in it we need to ask you. A second reading of it, by ${READ_BY[confirmation.second.strength]}, found nothing to ask either.`;
        case "questions-raised":
          return (
            `Our first reading of your tender found nothing to ask you. A second reading of it, by ${READ_BY[confirmation.second.strength]}, ` +
            `found the ${confirmation.second.questions.length === 1 ? "question" : `${confirmation.second.questions.length} questions`} we have sent you.`
          );
        case "unconfirmed":
          return (
            `We read your tender and found nothing in it we need to ask you, but no second reading of it could be had to confirm that, ` +
            `so that reading is unconfirmed.`
          );
      }
    })();
    return [found, NOTHING_VERIFIABLE].join("\n\n");
  }
  switch (confirmation.kind) {
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
 * failure counted; at the cap the project is blocked on Ashara's side and the tender kept,
 * so the loop does not spin and the client's tender is never refused. Nothing but a failed read is counted.
 */
export class TenderIntake implements LiaisonIntake {
  constructor(private readonly deps: TenderIntakeDeps) {}

  /**
   * A tender no read of which succeeded, whose own record is inconsistent, or whose questions the
   * store posts wrongly, blocks its project, and the other tenders are still taken in. Any other
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
        if (err instanceof IntakeReadExhausted) {
          return this.block(tender, { ...projectBlockCause(err), category: modelCallBlockCategory(err.failure) });
        }
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

    // A previous cycle reached the cap but did not block the project. The tender's record names no
    // party to the last failure, so it is Ashara's to look into, never the model's or the provider's.
    if (tender.intakeAttempts >= MAX_INTAKE_ATTEMPTS) {
      if (tender.intakeLastError === null) throw new IntakeFailureUnrecorded(tender.id, tender.intakeAttempts);
      throw new IntakeReadExhausted(tender.id, tender.intakeAttempts, tender.intakeLastError, "ashara");
    }

    const visionVersion = await store.currentVisionVersion(tender.projectId);
    if (visionVersion !== null) {
      const consumed = await store.consumeTender(tender);
      if (consumed.kind === "moved") return this.moved(tender, consumed.detail);
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
      const failure = modelCallFailureOf(err);
      if (failure === "ashara") throw err;
      return this.fail(tender, err, failure);
    }
    const confirmation: ReadingConfirmation =
      first.response.questions.length > 0 ? { kind: "not-needed" } : await this.secondReading(tender, first);
    const commit = await store.recordIntake(this.toWrite(tender, first, confirmation));
    if (commit.kind === "vision-exists") {
      return { kind: "vision-exists", ...base, visionVersion: commit.visionVersion };
    }
    if (commit.kind === "moved") return this.moved(tender, commit.detail);
    return { kind: "recorded", ...base, questions: commit.questionIds.length, confirmation: confirmation.kind };
  }

  private moved(tender: OpenTender, detail: string): IntakeOutcome {
    console.warn(`[liaison-intake] tender ${tender.id} (project ${tender.projectId}): nothing written, read again once its project reads it: ${detail}`);
    return { kind: "moved", tenderId: tender.id, projectId: tender.projectId, detail };
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
      schema: firstReadingSchema(tender),
      maxTokens: 4096,
    });
    return { response: response.data, model: { provider: response.provider, model: response.model, grade: response.grade } };
  }

  /**
   * The second reading of a first reading that asked nothing, at the strongest independence that
   * answers, the strengths asked in order: one the catalog does not
   * serve (SecondOpinionUnavailable) or whose model gave no fit answer (SecondOpinionUnanswered,
   * StructuredOutputExhausted) is passed over, recorded and logged, and the next is asked. When none
   * answers, the reading is unconfirmed: work proceeds on it and the client is told, so the bound is
   * the three strengths and the tender is never held. Any other throw (a spend-cap refusal, a
   * misrouted answer) is not the second reading's failure and fails the intake as Ashara's.
   * The second reading judges the first, so it asks for a judge of work at the first reading's grade
   * as called: never a model weaker than the one whose reading it judges.
   */
  private async secondReading(tender: OpenTender, reading: FirstReading): Promise<ReadingConfirmation> {
    const first = reading.model;
    const provider = this.ladder(tender);
    const schema = secondReadingSchema(tender, reading.response);
    const passedOver: PassedOver[] = [];
    for (const strength of SECOND_OPINION_STRENGTHS) {
      const secondOpinion: SecondOpinion = { avoid: { provider: first.provider, model: first.model }, strength };
      try {
        const response = await provider.generateStructured({
          judges: first.grade,
          prompt: secondReadingPrompt(tender.body, ANGLE_OF[strength], reading.response.guarantees),
          schema,
          maxTokens: 4096,
          secondOpinion,
        });
        const model = { provider: response.provider, model: response.model, grade: response.grade };
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
    const { inferences, asked } = recordsOf(response, confirmation.kind === "questions-raised" ? confirmation.second.questions : []);
    // Held as vision v1 will record it: each guarantee marked as markOf decides for the observation it was drafted with.
    const standing = contractStandingOf(response.guarantees.map((g) => markOf(g.observable.observation)));
    return {
      tender,
      questions: asked.map((a) => questionBody(a.question, standing)),
      contractDraft: contractDraftReport(response, inferences, standing),
      readingReport: readingReport(confirmation, standing),
      reading: { first: first.model, firstQuestions: response.questions.length, confirmation },
      vision: (questionMessageIds) => ({
        visionText: tender.body,
        summary: response.summary,
        contract: { interface: response.interface, guarantees: response.guarantees, exclusions: response.exclusions },
        inferences,
        openQuestions: asked.map(({ question, key }, i) => {
          const messageId = questionMessageIds[i];
          if (questionMessageIds.length !== asked.length || messageId === undefined) {
            throw new QuestionIdsMismatch(tender.id, asked.length, questionMessageIds.length);
          }
          return { messageId, text: question.text, whyItMatters: question.whyItMatters, assumptionKey: key };
        }),
      }),
    };
  }

  private async fail(tender: OpenTender, err: unknown, failure: ModelCallFailure): Promise<IntakeOutcome> {
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(tender.id, error);
    console.warn(
      `[liaison-intake] tender ${tender.id} (project ${tender.projectId}): attempt ${attempt}/${MAX_INTAKE_ATTEMPTS} failed: ${error}`,
    );
    if (attempt < MAX_INTAKE_ATTEMPTS) return { kind: "failed", tenderId: tender.id, projectId: tender.projectId, attempt, error };
    throw new IntakeReadExhausted(tender.id, attempt, error, failure);
  }
}
