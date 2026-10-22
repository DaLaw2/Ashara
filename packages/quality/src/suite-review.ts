import { z } from "zod";
import { runHostGit, targetRepo } from "@ashara/execution-infra";
import type { ContextualLlm } from "@ashara/finance";
import {
  CAPABILITY_RANK,
  judgeRelation,
  ModelAnswerUnfit,
  SECOND_OPINION_STRENGTHS,
  SecondOpinionUnanswered,
  SecondOpinionUnavailable,
  StructuredOutputExhausted,
  withStructuredLadder,
} from "@ashara/finance";
import type { CapabilityLevel, JudgeRelation, LadderAttemptEvent, SecondOpinion, SecondOpinionStrength, StructuredValidation } from "@ashara/finance";
import type { Logger, ProjectId, WorkItemId } from "@ashara/shared";
import { describeErrorChain, parseWorkItemId } from "@ashara/shared";
import type { StoredTaskSpec } from "./acl/delivery-acl.js";
import type { VisionSource } from "./acl/engagement-acl.js";
import { visionSourceCitation } from "./acl/engagement-acl.js";
import { PUBLIC_INTERFACE_FILE } from "./public-interface.js";
import type { TaskChecks } from "./task-checks.js";

// Quality's review of a plan revision's check suites: checks written by
// independent authors can together ask for what no product can pass. After the last check task of a revision completes and
// before any implementation starts, every stored suite is read together with the vision, in one
// structured call of its own: a separate dispatch of the check author's role that wrote none of the
// checks it reads. Each check is judged against the vision items its own task cites, with their
// status, and against the product's public interface as it stood on the commit the checks were
// written against: a reviewer that reads neither rejects checks their brief required.
// What it finds is routed by the orchestrator (planning's exitSuiteReview), and only a finding with
// a witness, or with another model family's agreement where no witness can exist, reopens anything.
// A model can misread an item it was shown whole. Z0 can disprove an
// outside-vision rejection only one way: the clause it quotes as missing appears word for word (case
// and punctuation aside) in the text of an item the check's task cites. Such a rejection is
// discarded and the review asked again within the ladder's bound. Z0 cannot tell that a paraphrased
// clause is absent, so a rejection it cannot disprove is the reviewer's judgement, not a verified
// fact: it is acted on only when a second review, a fresh call on the same inputs that never sees
// the first verdict, rejects the same check as outside the vision too. The second review is an
// independent opinion, asked in order of strength from what the
// catalog offers at the capability: another model family, whose failover never returns to the
// first's; else another model of the first's family; else, only in a deployment with no other model,
// the first's model again. The last two are asked from another angle: to look for what each check
// cannot observe. A strength the catalog does not serve, or whose answer never validates, is passed
// over explicitly and recorded; agreement at any strength counts as agreement, and every
// text and record that names the second review names its strength. When the second does not reject
// that check, the check is released as passing review. A second review that fails at every strength
// confirms and releases nothing: every finding it was asked for is kept as advisory, recorded as
// failed, never as a disagreement.
// A contradiction must quote, from the stored check files, what each of its two checks requires; Z0
// holds each quote to the check it names. Whether two shell commands can pass together is not
// decidable from their text without reading them as some stack's language, which Ashara never does,
// so a grounded contradiction still needs agreement. An undecided item, a claim that no check decides an item,
// overrules the stored record that some check decides it, and no run can witness an
// absence. Either acts only when the second review reaches the same finding; otherwise it is kept
// as advisory, and an undecided item stays undecided (undecided_items) and is reported unverified,
// never covered.
// A review that routes nothing is a claim about the checks too:
// that they decide the items their tasks cite. An empty problem list is the identity element of a
// verdict and no evidence of one, so the second review is asked on every review, clean or not, and
// a covered item reads as verified only when that second review answered and named nothing about
// it. An item it named, or every covered item when it failed, is stored undecided and reported
// unverified, with why; nothing reopens on the second review's own findings, which no first finding
// raised.
// Two ratchets bound the rounds: a check task the review already reopened once
// is not reopened for an undecided item again (the item stays undecided), and once the check set is
// frozen, at the first implementation dispatched on it, no finding acts. Every judgement, and the
// claim of a review that routes nothing, is recorded whole (suite_review_judgements,
// suite_review_claims) before anything is routed, released or kept on it.
// Both reviews judge the check work at its own tier: the higher of each check task's grade and the
// grade of every model an attempt on it ran on, the highest over the suites read. A judge is graded
// one tier above that, else at it, never below; each record names the weaker judge it rests on and
// whether it stood above the work or only equal to it.

/** A check task the review reads, as stored; nulls are what its row does not record. */
interface CheckTaskUnderReview {
  readonly id: string;
  readonly status: string;
  /** The implementation task its checks decide (task_spec.checksFor). */
  readonly checksFor: string | null;
  /** The vision items its task cites (task_spec.visionItems). */
  readonly visionItems: readonly string[] | null;
  /** The same items with their ids, status and kind (task_spec.sources); null on rows written before them. */
  readonly sources: readonly VisionSource[] | null;
  /** The title of the task its checks decide. */
  readonly checkedTitle: string | null;
  /** How many reviews have reopened it so far (its suite_review_findings rows). */
  readonly reviewReopens: number;
  /** The grade its task was dispatched at (task_spec.capability); null when the row records none. */
  readonly grade: CapabilityLevel | null;
  /** Every model an attempt on it ran on (dev_sessions.attempt_model), each with its catalog grade; null for a model the catalog does not grade. */
  readonly attemptModels: ReadonlyArray<{ readonly model: string; readonly grade: CapabilityLevel | null }>;
}

/** What the review reads: the review task's check tasks, the checks stored for their tasks, and whether its check set is frozen. */
export interface SuiteReviewSource {
  /** The check tasks the review task depends on: its plan revision's. */
  checkTasksUnderReview(reviewTaskId: WorkItemId): Promise<readonly CheckTaskUnderReview[]>;
  /** The task's latest revision of checks, or null when none was ever stored. */
  latest(taskId: WorkItemId): Promise<TaskChecks | null>;
  /** Whether the review task's check set is frozen: an implementation depending on it was dispatched (check_set_freezes). */
  frozen(reviewTaskId: WorkItemId): Promise<boolean>;
}

/** The product's public interface as it stood at one commit of the target checkout. */
type PublicInterface = { readonly kind: "present"; readonly text: string } | { readonly kind: "absent" };

/** Reads PUBLIC_INTERFACE.md at a commit of the project's target checkout. */
interface PublicInterfaceReader {
  at(targetProjectPath: string, commit: string): Promise<PublicInterface>;
}

/** A recorded baseline commit that is not a commit id: it is never handed to git. */
class BaselineCommitInvalid extends Error {
  constructor(readonly commit: string) {
    super(`the recorded baseline commit ${JSON.stringify(commit)} is not a commit id; ${PUBLIC_INTERFACE_FILE} is not read at it`);
    this.name = "BaselineCommitInvalid";
  }
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/** The target checkout's git: absent when the commit's tree holds no such file; any git failure throws. */
export const gitPublicInterface: PublicInterfaceReader = {
  async at(targetProjectPath, commit) {
    if (!COMMIT_ID.test(commit)) throw new BaselineCommitInvalid(commit);
    const repo = targetRepo(targetProjectPath);
    const { stdout: listed } = await runHostGit(repo, ["ls-tree", "--name-only", commit, "--", PUBLIC_INTERFACE_FILE]);
    if (listed.trim() === "") return { kind: "absent" };
    const { stdout: text } = await runHostGit(repo, ["show", `${commit}:${PUBLIC_INTERFACE_FILE}`]);
    return { kind: "present", text };
  },
};

/** One problem the review routes, with the check tasks whose checks it involves. */
interface SuiteReviewProblem {
  readonly checkTaskIds: readonly string[];
  readonly kind: "contradiction" | "outside-vision" | "undecided-item";
  readonly problem: string;
  readonly evidence: string;
}

/**
 * An outside-vision rejection the first review made and the second did not: the check passes review.
 * Both judgements are kept: the first's rejection, and every finding the second made on that check
 * task (none when it found nothing there), with what the second review was.
 */
interface ReleasedRejection {
  readonly checkTaskId: string;
  readonly check: string;
  readonly first: string;
  readonly second: readonly string[];
  /** What the second review was, in words, with its strength (secondReviewText). */
  readonly secondReview: string;
}

/** The model a review's verdict came from, as the response named it, with its catalog grade. */
interface ReviewModel {
  readonly provider: string;
  readonly model: string;
  readonly grade: CapabilityLevel;
}

/**
 * How the judges a verdict rests on stand to the check work they judged: the first review, and the
 * second where it answered. The judge tier is the weaker of the two, so a verdict reads as judged
 * from above only when every judge it rests on is above the work.
 */
interface JudgeTiers {
  readonly judgeTier: CapabilityLevel;
  /** The check work's tier: the highest over the suites read. */
  readonly judgedTier: CapabilityLevel;
  readonly relation: JudgeRelation;
}

/** The second review against the first: the model that answered it, and how independent of the first it is. */
interface SecondReview {
  readonly strength: SecondOpinionStrength;
  readonly first: ReviewModel;
  readonly second: ReviewModel;
}

/**
 * A strength of second opinion the review did not get an answer at before the one that answered, or
 * before it failed: the catalog offered no model for it, or the model it went to never gave a fit
 * answer. Recorded, so moving to a weaker strength is never silent.
 */
interface PassedOver {
  readonly strength: SecondOpinionStrength;
  readonly outcome: "unavailable" | "failed";
  readonly reason: string;
}

function modelName(model: ReviewModel): string {
  return `${model.provider}/${model.model}`;
}

function higherTier(a: CapabilityLevel, b: CapabilityLevel): CapabilityLevel {
  return CAPABILITY_RANK[a] >= CAPABILITY_RANK[b] ? a : b;
}

/** The tiers of a verdict judged at `judged` by the first review and, where it answered, the second. */
function tiersOf(judged: CapabilityLevel, first: ReviewModel, second: SecondReview | null): JudgeTiers {
  const judgeTier = second === null || CAPABILITY_RANK[first.grade] <= CAPABILITY_RANK[second.second.grade] ? first.grade : second.second.grade;
  return { judgeTier, judgedTier: judged, relation: judgeRelation(judged, judgeTier) };
}

/** Each strength in words, as the client and the operator read it: a weaker one says what it shares. */
const STRENGTH_TEXT: Readonly<Record<SecondOpinionStrength, string>> = {
  "other-family": "another model family",
  "same-family-other-model": "another model of the same family, which shares more blind spots with the first than another family would",
  "same-model": "the same model asked again from another angle, which shares every blind spot of the first",
};

/** What the second review was, as every routed or recorded text says it, its strength included. */
function secondReviewText(review: SecondReview): string {
  return review.strength === "same-model"
    ? `the first review's model ${modelName(review.first)} asked again from another angle, which shares every blind spot of the first`
    : `a review by ${STRENGTH_TEXT[review.strength]}, ${modelName(review.second)}, than the first's ${modelName(review.first)}`;
}

/** The strength the answering model has against the first, from the two models alone. */
function strengthBetween(first: ReviewModel, second: ReviewModel): SecondOpinionStrength {
  if (first.provider !== second.provider) return "other-family";
  return first.model === second.model ? "same-model" : "same-family-other-model";
}

/**
 * Why a finding acted or did not (suite_review_judgements.basis): an outside-vision rejection's two
 * reviews; the second opinion's agreement, or its absence, on a finding no witness can settle; a
 * second review that failed at every strength, which leaves every finding it was asked for advisory;
 * or a ratchet that holds whatever a second review says.
 */
type JudgementBasis =
  | "two-reviews"
  | "second-opinion-agreed"
  | "second-opinion-disagreed"
  | "second-review-failed"
  | "frozen"
  | "reopened-once";

/** What each basis means, as every text that reports a finding that did not act says it. */
const BASIS_TEXT: Readonly<Record<Exclude<JudgementBasis, "two-reviews" | "second-opinion-agreed">, string>> = {
  "second-opinion-disagreed": "the second review did not reach it",
  "second-review-failed": "the second review that could have confirmed or settled it failed at every strength, so nothing confirmed it",
  frozen: "the plan's check set is frozen: an implementation was dispatched on it",
  "reopened-once": "its check task was already reopened once by this review",
};

/** A cited item a finding left undecided: kept undecided and reported unverified, never covered. */
interface UndecidedItem {
  readonly checkTaskId: string;
  readonly itemId: string;
  readonly itemText: string;
}

/** One finding of the first review as recorded: both reviews' findings on it whole, what the second review was, and why it acted or did not. */
interface ReviewJudgement {
  /** The check task it is recorded on: the one it names, or a contradiction's first side's. */
  readonly checkTaskId: string;
  /** The rejected check of an outside-vision finding; null for the other kinds. */
  readonly check: string | null;
  readonly outcome: "routed" | "released" | "advisory";
  readonly basis: JudgementBasis;
  readonly first: ReviewFinding;
  /** The model the first review's verdict came from. */
  readonly firstModel: ReviewModel;
  /** Every finding the second review made on the check tasks it names, none when it found nothing there or was not asked. */
  readonly second: readonly ReviewFinding[];
  /** Null when the second review failed. */
  readonly secondReview: SecondReview | null;
  /** The strengths passed over before the second review answered or failed; none when it was not asked. */
  readonly passedOver: readonly PassedOver[];
  /** Why the second review failed, exactly when the basis is second-review-failed; null otherwise. */
  readonly secondFailure: string | null;
  /** The item an advisory undecided-item finding leaves undecided; null for every other finding. */
  readonly undecided: UndecidedItem | null;
  readonly tiers: JudgeTiers;
}

/**
 * Why the items a review that routed nothing covers read as verified or not
 * (suite_review_claims.basis): the second review, of the strength the claim records, named nothing
 * about them, or named something about some of them; or it failed at every strength, so it
 * confirmed none of them.
 */
type ClaimBasis = "second-opinion-clean" | "second-opinion-found" | "second-review-failed";

/** What each basis leaves of the claim, as every text that reports it says it; the strength is added where one answered. */
const CLAIM_TEXT: Readonly<Record<ClaimBasis, string>> = {
  "second-opinion-clean": "a second review found no problem in them either",
  "second-opinion-found": "the review that found no problem in them was not confirmed: a second review found one",
  "second-review-failed": "the review that found no problem in them was not confirmed: the second review failed at every strength the catalog offers",
};

/**
 * The claim of a review that routed nothing: the checks decide every item they record they decide,
 * but those it already left undecided. Recorded whole, with the second review that confirms it or not,
 * its strength, and the covered items it leaves unverified.
 */
interface ReviewClaim {
  readonly basis: ClaimBasis;
  /** The check tasks whose suites it covers. */
  readonly covered: readonly string[];
  readonly firstModel: ReviewModel;
  /** Null exactly when the second review failed. */
  readonly secondReview: SecondReview | null;
  /** The strengths passed over before the second review answered or failed. */
  readonly passedOver: readonly PassedOver[];
  /** Every finding the second review made, whole; none when it failed. */
  readonly second: readonly ReviewFinding[];
  /** Why the second review failed, exactly when the basis is second-review-failed. */
  readonly secondFailure: string | null;
  /** The covered items it leaves undecided: reported unverified, never covered. */
  readonly unconfirmed: readonly UndecidedItem[];
  readonly tiers: JudgeTiers;
}

/**
 * Where a review's judgements, its claim when it routed nothing, and the items they leave
 * undecided, are recorded, together; a write that fails fails the review.
 */
export interface SuiteReviewJudgementStore {
  record(review: {
    readonly projectId: ProjectId;
    readonly reviewTaskId: WorkItemId;
    readonly judgements: readonly ReviewJudgement[];
    readonly claim: ReviewClaim | null;
  }): Promise<void>;
}

/** A finding that did not act: kept as advisory, with why. */
interface AdvisoryFinding {
  readonly checkTaskIds: readonly string[];
  readonly kind: ReviewFinding["kind"];
  readonly finding: string;
  readonly why: string;
}

/**
 * The review's verdict, accepted only after its schema validated and every check task it names is
 * one it read. `reviewed` names the check tasks whose suites it read; `setAside` the Abandoned ones,
 * whose implementations wait on nothing they wrote; `released` the rejections the second review did
 * not reach; `advisory` the findings that did not act, and `undecided` the cited items they leave
 * undecided.
 */
interface ReviewedOutcome {
  readonly reviewed: readonly string[];
  readonly setAside: readonly string[];
  readonly released: readonly ReleasedRejection[];
  readonly advisory: readonly AdvisoryFinding[];
  readonly undecided: readonly UndecidedItem[];
}

/** A clean outcome's claim as its dispatch reports it: why its items read as verified or not, at what strength, and those that do not. */
interface ClaimOutcome {
  readonly basis: ClaimBasis;
  /** The strength of the second review that answered; null when it failed at every strength. */
  readonly strength: SecondOpinionStrength | null;
  readonly why: string;
  readonly unconfirmed: readonly UndecidedItem[];
}

type SuiteReviewOutcome =
  | (ReviewedOutcome & { readonly kind: "clean"; readonly claim: ClaimOutcome })
  | (ReviewedOutcome & { readonly kind: "problems"; readonly problems: readonly SuiteReviewProblem[] });

/** The review task, as the dispatch describes it. */
interface ReviewTask {
  readonly id: WorkItemId;
  readonly projectId: ProjectId;
  readonly taskSpec?: StoredTaskSpec;
}

/** Reviews a plan revision's suites; throws when there is nothing it can truthfully review. */
export interface SuiteReviewing {
  review(task: ReviewTask, targetProjectPath: string): Promise<SuiteReviewOutcome>;
}

/** The suites cannot all be read, so no verdict on them is given: the review fails rather than passing what it did not read. */
class SuitesUnreadable extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly detail: string,
  ) {
    super(`review task ${reviewTaskId} cannot review its plan's suites: ${detail}`);
    this.name = "SuitesUnreadable";
  }
}

/** The model's verdict passed its schema and is still unfit to act on: the review model's failure, never Ashara's record's (modelCallFailureOf "model"). */
class SuiteVerdictUnfit extends ModelAnswerUnfit {
  constructor(
    readonly reviewTaskId: string,
    readonly detail: string,
  ) {
    super(`review task ${reviewTaskId}: the review's verdict is unfit to act on: ${detail}`);
    this.name = "SuiteVerdictUnfit";
  }
}

/** The reviews' judgements could not be recorded, so none of them is acted on. */
class SuiteJudgementsUnrecorded extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly judgements: number,
    options: { readonly cause: unknown },
  ) {
    super(`review task ${reviewTaskId}: the reviews' judgements on ${judgements} rejection(s) could not be recorded: ${describeErrorChain(options.cause)}`, options);
    this.name = "SuiteJudgementsUnrecorded";
  }
}

const NonEmpty = z.string().trim().min(1);

/** One side of a contradiction: a check, and the text of its command or its check task's files that shows what it requires. */
const ConflictSideSchema = z.strictObject({ checkTask: NonEmpty, check: NonEmpty, requires: NonEmpty });

/**
 * A contradiction's two checks as two named sides, never a tuple: a tuple renders as an array-form
 * `items`, which a provider decoding against the schema refuses (model-access schema-acceptance).
 */
const ConflictSchema = z.strictObject({ first: ConflictSideSchema, second: ConflictSideSchema });

/**
 * A finding is acted on only with what makes its claim checkable: an outside-vision finding names
 * the one check task and the one check it judged, the cited items it judged the check against and,
 * quoted, the clause it says none of them states; a contradiction names its two checks, each with
 * what it requires quoted from the stored checks; a finding without them is not a verdict.
 */
const ReviewResponseSchema = z.strictObject({
  problems: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("contradiction"),
        checkTasks: z.array(NonEmpty).min(1),
        conflict: ConflictSchema,
        problem: NonEmpty,
        evidence: NonEmpty,
      }),
      z.strictObject({
        kind: z.literal("outside-vision"),
        checkTasks: z.array(NonEmpty).length(1),
        check: NonEmpty,
        judgedItems: z.array(NonEmpty).min(1),
        missingClause: NonEmpty,
        problem: NonEmpty,
        evidence: NonEmpty,
      }),
      z.strictObject({
        kind: z.literal("undecided-item"),
        checkTasks: z.array(NonEmpty).length(1),
        item: NonEmpty,
        problem: NonEmpty,
        evidence: NonEmpty,
      }),
    ]),
  ),
});

type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/** A review's answer: the verdict and the model that gave it, with the model's catalog grade. */
interface ReviewAnswer {
  readonly data: ReviewResponse;
  readonly provider: string;
  readonly model: string;
  readonly grade: CapabilityLevel;
}

/**
 * Every schema Quality sends to a model, by call site: the integration schema-acceptance test judges each against every provider type, so a schema a provider refuses fails a test before any run sends it.
 */
export const QUALITY_MODEL_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = { "suite-review": ReviewResponseSchema };

/** One vision item a check task cites, as the review shows it and checks a rejection against: its exact text. */
interface CitedItem {
  /** Its id in the vision, or `item <n>` on a row that records no ids. */
  readonly id: string;
  readonly text: string;
  readonly line: string;
}

/** One suite as the review reads it: its task's cited items, each with its id and status when the row records them. */
interface ReviewedSuite {
  readonly checkTaskId: string;
  /** The task whose checks its check task wrote: an id the check files' paths may carry, never one a finding names. */
  readonly checksFor: string;
  readonly taskTitle: string;
  readonly cited: readonly CitedItem[];
  readonly checks: TaskChecks;
  /** How many reviews have reopened its check task so far. */
  readonly reviewReopens: number;
  /** The tier of its check work: the higher of its task's grade and the grade of every model that ran an attempt on it. */
  readonly judgedTier: CapabilityLevel;
}

/** Why a second review failed is cut at this length in an advisory line; the judgement row keeps it whole. */
const FAILURE_CHARS = 300;

/** A check file longer than this is cut in the prompt, and the cut is stated. */
const FILE_CHARS = 6000;

function fileText(content: string): string {
  if (content.length <= FILE_CHARS) return content;
  return `${content.slice(0, FILE_CHARS)}\n[cut: ${content.length - FILE_CHARS} more characters not shown]`;
}

/** The items as the review shows them: with id and kind (never a standing the plan recorded, which answers change), or the bare texts of a row written before those. */
function itemLines(sources: readonly VisionSource[] | null | undefined, texts: readonly string[]): string[] {
  return sources === null || sources === undefined || sources.length === 0
    ? texts.map((text) => `${text} (its id, status and kind are not recorded)`)
    : sources.map(visionSourceCitation);
}

/**
 * A check task's cited items with the exact text each was cited with: the text a rejection is
 * checked against. A row that records no ids names its items by their place.
 */
function citedItems(sources: readonly VisionSource[] | null | undefined, texts: readonly string[]): CitedItem[] {
  return sources === null || sources === undefined || sources.length === 0
    ? texts.map((text, i) => ({ id: `item ${i + 1}`, text, line: `item ${i + 1}: ${text} (its id, status and kind are not recorded)` }))
    : sources.map((source) => ({ id: source.id, text: source.text, line: visionSourceCitation(source) }));
}

function suiteSection(suite: ReviewedSuite): string {
  const files = suite.checks.files.map((file) => `--- file ${file.path}\n${fileText(file.content)}`);
  return [
    `## Check task ${suite.checkTaskId}`,
    `It wrote the checks of the task ${JSON.stringify(suite.taskTitle)} (task ${suite.checksFor}, whose id the paths of the ` +
      `files below may carry; it is not a check task id: a finding on these checks names check task ${suite.checkTaskId}), ` +
      `which cites these vision items:`,
    ...suite.cited.map((item) => `- ${item.line}`),
    `Checks (revision ${suite.checks.revision}${suite.checks.baselineCommit === null ? "" : `, written against commit ${suite.checks.baselineCommit}`}):`,
    ...suite.checks.checks.map(
      (check) =>
        `- ${JSON.stringify(check.name)} (its author says it decides ${check.decides === null ? "nothing on record" : check.decides.join(", ")}): ${check.command}`,
    ),
    ...(files.length === 0 ? [`Files: none`] : [`Files:`, ...files]),
  ].join("\n");
}

/** What the review is told of the public interface at one commit the checks were written against. */
interface InterfaceReading {
  readonly commit: string | null;
  readonly reading: PublicInterface | null;
}

function interfaceSection(readings: readonly InterfaceReading[]): string[] {
  return readings.flatMap(({ commit, reading }) => {
    if (commit === null || reading === null) {
      return [`The commit some checks were written against is not recorded, so no ${PUBLIC_INTERFACE_FILE} is shown for them.`];
    }
    if (reading.kind === "absent") return [`At commit ${commit}, the checks' foundation, there is no ${PUBLIC_INTERFACE_FILE}.`];
    return [`## ${PUBLIC_INTERFACE_FILE} at commit ${commit}, the foundation the checks were written against`, fileText(reading.text)];
  });
}

/**
 * How a review reads the checks: `direct` as the first review and an other-family second one do;
 * `blind-spots` as a second opinion within the first's family does, which shares more of its blind
 * spots and so starts from what each check cannot observe.
 */
type ReviewAngle = "direct" | "blind-spots";

/** The angle a second opinion of each strength is asked from: only another family reads as the first did. */
const ANGLE_OF: Readonly<Record<SecondOpinionStrength, ReviewAngle>> = {
  "other-family": "direct",
  "same-family-other-model": "blind-spots",
  "same-model": "blind-spots",
};

function angleSection(angle: ReviewAngle): string[] {
  if (angle === "direct") return [];
  return [
    `Read the checks from this angle first. For each check, work out what it cannot observe: the ways a product could`,
    `break what its task's cited items ask for while that check still passes (an input it never gives, an output it never`,
    `compares, a state it never reopens, a failure it never forces). A cited item that every check of its task would let`,
    `break unseen is an "undecided-item". Then name every problem of the three kinds below, judged as written there.`,
  ];
}

function reviewPrompt(vision: readonly string[], interfaces: readonly InterfaceReading[], suites: readonly ReviewedSuite[], angle: ReviewAngle): string {
  return [
    `You review the acceptance checks of a software project before any of its work starts. Each check is a shell`,
    `command run from the repository root; it passes when it exits 0 and prints output. Every check below runs on the`,
    `same finished product once all of its tasks are done, so every one of them must be able to pass on that one product.`,
    ``,
    `# What the client asked for (the vision)`,
    `Scope lines are the client's; an assumption is Stated by the client or Inferred by the team, and is client-visible`,
    `behaviour or internal design (how the team builds it, which no check is for).`,
    ...vision.map((item) => `- ${item}`),
    ``,
    `# The product's public interface`,
    `The one interface the product commits to: how it is started and called, its files and its errors. Every check`,
    `must use the product only through it, in the one form it names.`,
    ...interfaceSection(interfaces),
    ``,
    `# The checks, by the check task that wrote them`,
    ...suites.map(suiteSection),
    ``,
    `# What to return`,
    ...angleSection(angle),
    `Name every problem of these three kinds, and nothing else:`,
    `- "contradiction": two checks, of one check task or of two, that no single product could both pass (one requires`,
    `  an output, a format, a file or an exit status that the other forbids). Name every check task whose checks are`,
    `  involved, and give "conflict": the two checks, as "first" and "second", each as its check task id, its name exactly as written above, and`,
    `  "requires", the text of its command or of one of its check task's files, copied exactly, that shows what it`,
    `  requires. Two checks that one product can pass together are no contradiction, however they are written.`,
    `- "outside-vision": a check that requires behaviour none of the vision items its own task cites asks for. Judge`,
    `  each check only against its own task's cited items, whatever their status or recorded kind: an Inferred`,
    `  assumption the task cites is asked for. An input a cited item says the product must reject is asked for. Using a`,
    `  form the public interface names (a command, an argument, a file, an exit status) is never outside. Name the one`,
    `  check task that wrote it. Read each cited item's whole text, every clause of it, before you say it does not ask`,
    `  for something: a finding whose clause a cited item states is discarded and you are asked again.`,
    `- "undecided-item": an item a check task's own task cites that none of its checks decides: no check of it would`,
    `  fail on a product that breaks what the item asks for, whatever items its checks say they decide. Name the one`,
    `  check task.`,
    `For each: "checkTasks" lists those check task ids exactly as written above; "problem" says which checks and what`,
    `cannot hold, in one or two sentences; "evidence" quotes, copied exactly, the commands or file lines of those checks that show it. An "outside-vision"`,
    `finding is about one check: it also gives "check", that check's name exactly as written above, "judgedItems", the`,
    `ids of the cited items you judged the check against, exactly as written above, and "missingClause", the behaviour`,
    `the check requires, in a few words, that you say none of them states. An "undecided-item" finding also gives "item",`,
    `the id of the cited item exactly as written above.`,
    `Do not report style, behaviour no cited item asks for that no check tests, or checks you would have written`,
    `differently. When there is no problem, return {"problems": []}.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"problems": [{"kind": "contradiction", "checkTasks": ["<check task id>", "<check task id>"], ` +
      `"conflict": {"first": {"checkTask": "<check task id>", "check": "<check name>", "requires": "<copied text>"}, "second": {"checkTask": "<check task id>", "check": "<check name>", "requires": "<copied text>"}}, "problem": "...", "evidence": "..."}, ` +
      `{"kind": "outside-vision", "checkTasks": ["<check task id>"], "check": "<check name>", "judgedItems": ["<cited item id>"], "missingClause": "...", "problem": "...", "evidence": "..."}, ` +
      `{"kind": "undecided-item", "checkTasks": ["<check task id>"], "item": "<cited item id>", "problem": "...", "evidence": "..."}]}`,
  ].join("\n");
}

function reviewReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. In "checkTasks" use ONLY the check task ids written above, in "check" ONLY a ` +
    `check of that check task, in "judgedItems" ONLY the ids of the items that check task cites, in "requires" ONLY ` +
    `text copied exactly from that check's command or its check task's files, in "evidence" a command or whole file lines ` +
    `copied exactly from the checks the problem judges. No markdown, no prose.`
  );
}

/** Text as a clause is matched against an item: lower case, every run of anything but letters and digits one space. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * What makes a verdict unfit to act on: a check task it did not read, and an outside-vision finding
 * Z0 can disprove from the text, judged by Z0 and never by another model call: a check its check
 * task did not write, an item it says it judged that the check task does not cite, a clause that is
 * no words at all, or a clause that appears word for word in one of the check task's cited items;
 * and any finding whose evidence quotes nothing of the checks it judges. A paraphrase of a cited
 * item passes this check: Z0 cannot verify that a clause is absent.
 */
function verdictErrors(response: ReviewResponse, suites: ReadonlyMap<string, ReviewedSuite>): string[] {
  const unreadError = (i: number, id: string): string => {
    const writer = [...suites.values()].find((suite) => suite.checksFor === id);
    const named = `problem ${i + 1} names check task ${JSON.stringify(id)}, which is none of [${[...suites.keys()].join(", ")}]`;
    return writer === undefined ? named : `${named}: ${id} is the task whose checks check task ${writer.checkTaskId} wrote, so name check task ${writer.checkTaskId}`;
  };
  return response.problems.flatMap((problem, i) => {
    if (problem.kind === "contradiction") {
      const unread = problem.checkTasks.filter((id) => !suites.has(id)).map((id) => unreadError(i, id));
      return unread.length > 0 ? unread : conflictErrors(problem, i, suites);
    }
    const checkTaskId = problem.checkTasks[0];
    const suite = checkTaskId === undefined ? undefined : suites.get(checkTaskId);
    if (checkTaskId === undefined || suite === undefined) return [unreadError(i, checkTaskId ?? "(none)")];
    const citedIds = suite.cited.map((item) => item.id);
    const files = suite.checks.files.map((file) => file.content);
    if (problem.kind === "undecided-item") {
      const uncitedItem = citedIds.includes(problem.item)
        ? []
        : [`problem ${i + 1} names item ${JSON.stringify(problem.item)} as decided by no check, but check task ${checkTaskId} does not cite it (it cites [${citedIds.join(", ")}])`];
      const stored = [...suite.checks.checks.map((check) => check.command), ...files];
      return [...uncitedItem, ...evidenceErrors(problem.evidence, i, stored, `any command or file of check task ${checkTaskId}`)];
    }
    const checkNames = suite.checks.checks.map((check) => check.name);
    const judged = suite.checks.checks.find((check) => check.name === problem.check);
    const checkErrors = judged !== undefined
      ? evidenceErrors(problem.evidence, i, [judged.command, ...files], `the command of check ${JSON.stringify(problem.check)} or any file of check task ${checkTaskId}`)
      : [`problem ${i + 1} judged check ${JSON.stringify(problem.check)}, which check task ${checkTaskId} did not write (it wrote [${checkNames.join(", ")}])`];
    const uncited = problem.judgedItems
      .filter((id) => !citedIds.includes(id))
      .map((id) => `problem ${i + 1} judged item ${JSON.stringify(id)}, which check task ${checkTaskId} does not cite (it cites [${citedIds.join(", ")}])`);
    const clause = normalized(problem.missingClause);
    if (clause === "") return [...checkErrors, ...uncited, `problem ${i + 1} gives a missingClause with no words: ${JSON.stringify(problem.missingClause)}`];
    const stating = suite.cited.filter((item) => ` ${normalized(item.text)} `.includes(` ${clause} `));
    return [
      ...checkErrors,
      ...uncited,
      ...stating.map(
        (item) =>
          `problem ${i + 1} says no item check task ${checkTaskId} cites asks for ${JSON.stringify(problem.missingClause)}, but ${item.id} ` +
          `states it: ${JSON.stringify(item.text)}. Judge that check against the whole text of every item it cites again.`,
      ),
    ];
  });
}

/** Text as a quote is matched against a stored check: every run of whitespace one space. */
function spaced(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Z0's part of a contradiction's witness: its two sides are two different checks, each written by a
 * check task the finding names, each with what it requires copied from its own command or its check
 * task's files; and the finding names no check task neither side is of.
 */
function conflictErrors(problem: ContradictionFinding, i: number, suites: ReadonlyMap<string, ReviewedSuite>): string[] {
  const { first: a, second: b } = problem.conflict;
  const errors: string[] = [];
  if (a.checkTask === b.checkTask && a.check === b.check) errors.push(`problem ${i + 1} gives one check, ${JSON.stringify(a.check)} of ${a.checkTask}, as both sides of its conflict`);
  const sideTasks = new Set([a.checkTask, b.checkTask]);
  for (const id of problem.checkTasks.filter((named) => !sideTasks.has(named))) {
    errors.push(`problem ${i + 1} names check task ${JSON.stringify(id)}, which neither side of its conflict is of`);
  }
  const sideTexts: string[] = [];
  for (const [n, side] of [a, b].entries()) {
    const suite = suites.get(side.checkTask);
    if (suite === undefined || !problem.checkTasks.includes(side.checkTask)) {
      errors.push(`side ${n + 1} of problem ${i + 1} is of check task ${JSON.stringify(side.checkTask)}, which is not one the problem names among those read`);
      continue;
    }
    const check = suite.checks.checks.find((each) => each.name === side.check);
    if (check === undefined) {
      errors.push(`side ${n + 1} of problem ${i + 1} is check ${JSON.stringify(side.check)}, which check task ${side.checkTask} did not write (it wrote [${suite.checks.checks.map((each) => each.name).join(", ")}])`);
      continue;
    }
    const quote = spaced(side.requires);
    const stored = [check.command, ...suite.checks.files.map((file) => file.content)];
    sideTexts.push(...stored);
    if (quote === "" || !stored.map(spaced).some((text) => text.includes(quote))) {
      errors.push(
        `side ${n + 1} of problem ${i + 1} quotes ${JSON.stringify(side.requires)} as what check ${JSON.stringify(side.check)} requires, but neither its command nor ` +
          `any file of check task ${side.checkTask} holds that text: copy it exactly.${whereQuoteDiffers(side.requires, stored)}`,
      );
    }
  }
  if (sideTexts.length > 0) errors.push(...evidenceErrors(problem.evidence, i, sideTexts, "the command of either check it names or any file of their check tasks"));
  return errors;
}

/**
 * A finding's evidence is held to the checks it judges as a quote is: it is itself text one stored
 * command or file holds, or it holds one whole stored line. Its prose is never judged, so a finding
 * that argues itself out of its claim passes or fails on what it quotes; one that quotes nothing
 * stored has no claim that can be held to the checks and is no verdict.
 */
function evidenceErrors(evidence: string, i: number, stored: readonly string[], where: string): string[] {
  const quote = spaced(evidence);
  const texts = stored.map(spaced);
  if (quote !== "" && texts.some((text) => text.includes(quote))) return [];
  const lines = stored.flatMap((text) => text.split(/\r?\n/)).map(spaced);
  if (lines.some((line) => holdsWhole(quote, line))) return [];
  return [
    `problem ${i + 1} gives as evidence ${JSON.stringify(evidence)}, which neither is text nor holds a whole line that ${where} holds: ` +
      `copy into "evidence" the command or the file lines that show the problem, exactly.${whereQuoteDiffers(evidence, stored)}`,
  ];
}

/** Whether `line` stands in `text` whole: it names something, and no letter or digit runs on at either end of it. */
function holdsWhole(text: string, line: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(line)) return false;
  const wordChar = /[\p{L}\p{N}]/u;
  for (let at = text.indexOf(line); at !== -1; at = text.indexOf(line, at + 1)) {
    const before = text.charAt(at - 1);
    const after = text.charAt(at + line.length);
    if (!wordChar.test(before) && !wordChar.test(after)) return true;
  }
  return false;
}

/** Shared words of two lines, over the longer's word count: how near a stored line is to a quoted one. */
function likeness(quoted: string, stored: string): number {
  const words = new Set(stored.split(" "));
  const shared = quoted.split(" ").filter((word) => words.has(word)).length;
  return shared / Math.max(quoted.split(" ").length, stored.split(" ").length);
}

/**
 * Where a quote no stored text holds goes wrong, for the re-ask to name: its first line no stored
 * text holds, with the stored line nearest it, so a model that changed a character is shown the
 * text to copy rather than told again to copy it. Whitespace and line endings are never the cause:
 * every comparison runs on text with each run of whitespace made one space.
 */
function whereQuoteDiffers(quote: string, stored: readonly string[]): string {
  const texts = stored.map(spaced);
  const missing = quote
    .split(/\r?\n/)
    .map(spaced)
    .find((line) => line !== "" && !texts.some((text) => text.includes(line)));
  if (missing === undefined) return " Each of its lines is stored, but not one after another: quote one run of consecutive lines.";
  const candidates = stored.flatMap((text) => text.split(/\r?\n/)).map(spaced).filter((line) => line !== "");
  let nearest: { readonly line: string; readonly score: number } | null = null;
  for (const line of candidates) {
    const score = likeness(missing, line);
    if (score > 0 && (nearest === null || score > nearest.score)) nearest = { line, score };
  }
  return nearest === null
    ? ` Its line ${JSON.stringify(missing)} shares no word with any stored line.`
    : ` Its line ${JSON.stringify(missing)} is in none of them; the stored line nearest it reads ${JSON.stringify(nearest.line)}.`;
}

function verdictValidation(response: ReviewResponse, suites: ReadonlyMap<string, ReviewedSuite>): StructuredValidation {
  const errors = verdictErrors(response, suites);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

type ReviewFinding = ReviewResponse["problems"][number];
type OutsideVisionFinding = Extract<ReviewFinding, { readonly kind: "outside-vision" }>;
type ContradictionFinding = Extract<ReviewFinding, { readonly kind: "contradiction" }>;
type UndecidedItemFinding = Extract<ReviewFinding, { readonly kind: "undecided-item" }>;

function isOutsideVision(finding: ReviewFinding): finding is OutsideVisionFinding {
  return finding.kind === "outside-vision";
}

type ConflictSide = ContradictionFinding["conflict"]["first"];

function sidesOf(finding: ContradictionFinding): readonly [ConflictSide, ConflictSide] {
  return [finding.conflict.first, finding.conflict.second];
}

function sideLine(side: ConflictSide): string {
  return `check ${JSON.stringify(side.check)} of ${side.checkTask} requires ${JSON.stringify(side.requires)}`;
}

function findingLine(finding: ReviewFinding): string {
  switch (finding.kind) {
    case "contradiction":
      return `contradiction in ${finding.checkTasks.join(", ")} (${sidesOf(finding).map(sideLine).join("; ")}): ${finding.problem}`;
    case "undecided-item":
      return `cited item ${finding.item} is decided by no check: ${finding.problem}`;
    case "outside-vision":
      return `check ${JSON.stringify(finding.check)} is outside the vision, requiring ${JSON.stringify(finding.missingClause)}: ${finding.problem}`;
  }
}

/** The two checks of a contradiction, in either order: two findings on the same pair are the same contradiction. */
function conflictKey(finding: ContradictionFinding): string {
  return JSON.stringify(sidesOf(finding).map((side) => [side.checkTask, side.check]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** The check tasks a finding names, once each. */
function namedBy(finding: ReviewFinding): string[] {
  return finding.kind === "contradiction" ? [...new Set(sidesOf(finding).map((side) => side.checkTask))] : [...new Set(finding.checkTasks)];
}

/** The second review's finding that reaches the same one: the same check rejected, the same two checks in conflict, the same item undecided. */
function agreeingWith(finding: ReviewFinding, second: readonly ReviewFinding[]): ReviewFinding | undefined {
  switch (finding.kind) {
    case "outside-vision":
      return second.find((other) => other.kind === "outside-vision" && other.checkTasks[0] === finding.checkTasks[0] && other.check === finding.check);
    case "contradiction":
      return second.find((other) => other.kind === "contradiction" && conflictKey(other) === conflictKey(finding));
    case "undecided-item":
      return second.find((other) => other.kind === "undecided-item" && other.checkTasks[0] === finding.checkTasks[0] && other.item === finding.item);
  }
}

/** A contradiction both reviews reached, as Delivery routes it: what each of its checks requires, quoted, and who agreed. */
function agreedContradiction(first: ContradictionFinding, review: SecondReview): SuiteReviewProblem {
  return {
    checkTaskIds: namedBy(first),
    kind: "contradiction",
    problem: `${first.problem} ${agreedBy(review)} each found that no product can pass both: ${sidesOf(first).map(sideLine).join("; ")}.`,
    evidence: first.evidence,
  };
}

/** An undecided item both reviews reached, as the reopened check author reads it. */
function agreedUndecided(first: UndecidedItemFinding, review: SecondReview): SuiteReviewProblem {
  return {
    checkTaskIds: namedBy(first),
    kind: "undecided-item",
    problem: `Cited item ${first.item} is decided by none of the checks: ${first.problem} ${agreedBy(review)} each found it so.`,
    evidence: first.evidence,
  };
}

/** Who agreed on a finding, with the strength of the second: a weaker one says what it shares with the first. */
function agreedBy(review: SecondReview): string {
  return `Two reviews, the first by ${modelName(review.first)} and the second ${secondReviewText(review)},`;
}

/**
 * An outside-vision rejection both reviews reached, as Delivery routes it: the reviewers' judgement,
 * said to be one, with what the second review was, each review's clause and the exact text of every
 * item the check's task cites side by side, so whoever acts on it reads all of them.
 */
function judgedRejection(first: OutsideVisionFinding, second: OutsideVisionFinding, suite: ReviewedSuite, review: SecondReview): SuiteReviewProblem {
  const items = suite.cited.map((item) => `${item.id}: ${JSON.stringify(item.text)}`).join("; ");
  return {
    checkTaskIds: [suite.checkTaskId],
    kind: "outside-vision",
    problem:
      `${first.problem} This is the reviewers' judgement, not a verified fact: two reviews each judged check ` +
      `${JSON.stringify(first.check)} to require behaviour none of its task's cited items asks for. The second was ` +
      `${secondReviewText(review)}. Side by side: the first review (${modelName(review.first)}) judged it against ` +
      `${first.judgedItems.join(", ")} to require ${JSON.stringify(first.missingClause)}; the second (${modelName(review.second)}) ` +
      `judged it against ${second.judgedItems.join(", ")} to require ${JSON.stringify(second.missingClause)}; cited ${items}.`,
    evidence: first.evidence === second.evidence ? first.evidence : `first review: ${first.evidence}\nsecond review: ${second.evidence}`,
  };
}

/**
 * The output bound of one review: a full answer can name a finding for every check it reads, each
 * with quoted evidence, so the bound grows with the checks under review and never falls below what
 * a plan of a few suites needs.
 */
const REVIEW_OUTPUT_FLOOR = 8192;
const REVIEW_OUTPUT_PER_CHECK = 600;
const REVIEW_OUTPUT_CEILING = 32768;

function reviewOutputBound(suites: readonly ReviewedSuite[]): number {
  const checks = suites.reduce((sum, suite) => sum + suite.checks.checks.length, 0);
  return Math.min(REVIEW_OUTPUT_CEILING, Math.max(REVIEW_OUTPUT_FLOOR, checks * REVIEW_OUTPUT_PER_CHECK));
}

/** A finding's own suite, or the first side's for a contradiction; a validated finding always has one. */
function suiteOf(reviewTaskId: WorkItemId, finding: ReviewFinding, suites: ReadonlyMap<string, ReviewedSuite>): ReviewedSuite {
  const [checkTaskId] = namedBy(finding);
  const suite = checkTaskId === undefined ? undefined : suites.get(checkTaskId);
  if (suite === undefined) throw new SuiteVerdictUnfit(reviewTaskId, `a validated finding names check task ${JSON.stringify(finding.checkTasks)}, which is not one it read`);
  return suite;
}

/** The cited item an undecided-item finding names, as its check task cites it; a validated finding always names one it cites. */
function undecidedItemOf(reviewTaskId: WorkItemId, finding: UndecidedItemFinding, suite: ReviewedSuite): UndecidedItem {
  const item = suite.cited.find((each) => each.id === finding.item);
  if (item === undefined) throw new SuiteVerdictUnfit(reviewTaskId, `a validated undecided item ${JSON.stringify(finding.item)} is not one check task ${suite.checkTaskId} cites`);
  return { checkTaskId: suite.checkTaskId, itemId: item.id, itemText: item.text };
}

/**
 * Why a finding cannot act whatever a second review says, or null when the second review decides:
 * nothing acts on a frozen check set, and an undecided item does not reopen a check task this review
 * already reopened once.
 */
function ratchetOf(finding: ReviewFinding, frozen: boolean, suite: ReviewedSuite): Extract<JudgementBasis, "frozen" | "reopened-once"> | null {
  if (frozen) return "frozen";
  if (finding.kind === "undecided-item" && suite.reviewReopens > 0) return "reopened-once";
  return null;
}

/** A cited item of one check task, as a key: an item is the same across findings only on the same check task. */
function itemKey(checkTaskId: string, itemId: string): string {
  return JSON.stringify([checkTaskId, itemId]);
}

/**
 * The cited items a finding says something about, as keys: an undecided item's own item, the items
 * an outside-vision rejection judged its check against, and every item each side's check task of
 * a contradiction cites, since no item of a suite that cannot pass is settled by it.
 */
function itemsNamedBy(finding: ReviewFinding, suites: ReadonlyMap<string, ReviewedSuite>): string[] {
  switch (finding.kind) {
    case "undecided-item":
      return finding.checkTasks.map((checkTaskId) => itemKey(checkTaskId, finding.item));
    case "outside-vision":
      return finding.checkTasks.flatMap((checkTaskId) => finding.judgedItems.map((itemId) => itemKey(checkTaskId, itemId)));
    case "contradiction":
      return namedBy(finding).flatMap((checkTaskId) => {
        const suite = suites.get(checkTaskId);
        return suite === undefined ? [] : suite.cited.map((item) => itemKey(checkTaskId, item.id));
      });
  }
}

/** What the second review gave: its verdict and who answered at what strength, or why it gave none; with the strengths passed over on the way. */
type SecondVerdict =
  | { readonly kind: "answered"; readonly data: ReviewResponse; readonly review: SecondReview; readonly passedOver: readonly PassedOver[] }
  | { readonly kind: "failed"; readonly reason: string; readonly passedOver: readonly PassedOver[] };

/**
 * The claim of a review that routed nothing: it covers every item a reviewed suite cites and one of its checks records that it decides, but
 * those its findings already left undecided; an item no check claims is reported as decided by none.
 * A covered item reads as verified only when the second review answered and named nothing about it,
 * at the strength the claim records; the second review's findings act on nothing, the first having
 * raised none of them, and only leave the items they name unverified. A second review that failed at
 * every strength confirms no item: every covered one is unverified (fail closed).
 */
function claimOf(
  suites: ReadonlyMap<string, ReviewedSuite>,
  firstModel: ReviewModel,
  second: SecondVerdict,
  undecided: readonly UndecidedItem[],
  judged: CapabilityLevel,
): ReviewClaim {
  const left = new Set(undecided.map((item) => itemKey(item.checkTaskId, item.itemId)));
  const coveredItems = [...suites.values()].flatMap((suite) =>
    suite.cited
      .filter((item) => !left.has(itemKey(suite.checkTaskId, item.id)) && suite.checks.checks.some((check) => check.decides?.includes(item.id) === true))
      .map((item) => ({ checkTaskId: suite.checkTaskId, itemId: item.id, itemText: item.text })),
  );
  const covered = [...suites.keys()];
  const { passedOver } = second;
  if (second.kind === "failed") {
    return {
      basis: "second-review-failed",
      covered,
      firstModel,
      secondReview: null,
      passedOver,
      second: [],
      secondFailure: second.reason,
      unconfirmed: coveredItems,
      tiers: tiersOf(judged, firstModel, null),
    };
  }
  const found = second.data.problems;
  const named = new Set(found.flatMap((finding) => itemsNamedBy(finding, suites)));
  const unconfirmed = coveredItems.filter((item) => named.has(itemKey(item.checkTaskId, item.itemId)));
  const basis = unconfirmed.length === 0 ? "second-opinion-clean" : "second-opinion-found";
  return { basis, covered, firstModel, secondReview: second.review, passedOver, second: found, secondFailure: null, unconfirmed, tiers: tiersOf(judged, firstModel, second.review) };
}

/** The claim as the dispatch reports it: why, at what strength, with why the second review failed cut to its advisory length. */
function claimOutcome(claim: ReviewClaim): ClaimOutcome {
  const strength = claim.secondReview === null ? null : claim.secondReview.strength;
  const by = claim.secondReview === null ? "" : `; the second review was ${secondReviewText(claim.secondReview)}`;
  const failure = claim.secondFailure === null ? "" : ` (${claim.secondFailure.slice(0, FAILURE_CHARS)})`;
  return { basis: claim.basis, strength, why: `${CLAIM_TEXT[claim.basis]}${by}${failure}`, unconfirmed: claim.unconfirmed };
}

/** A second opinion's answer came from a model of another strength than the one it asked for: the gateway broke its contract. */
class SecondOpinionMisrouted extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly asked: SecondOpinionStrength,
    readonly answered: SecondReview,
  ) {
    super(
      `review task ${reviewTaskId}: a ${asked} second opinion on ${modelName(answered.first)} was answered by ${modelName(answered.second)}, ` +
        `which is ${answered.strength}: no agreement is read from it`,
    );
    this.name = "SecondOpinionMisrouted";
  }
}

/**
 * The tier of a check task's work: the higher of the grade its task was dispatched at and the
 * catalog grade of every model an attempt on it ran on, since either alone can understate the work.
 * A task with no grade on record, or an attempt on a model the catalog does not grade, has no tier
 * a judge can be held to, and the review fails.
 */
function checkWorkTier(reviewTaskId: string, checkTask: CheckTaskUnderReview): CapabilityLevel {
  if (checkTask.grade === null) {
    throw new SuitesUnreadable(reviewTaskId, `check task ${checkTask.id} records no grade it was dispatched at (task_spec.capability)`);
  }
  let tier = checkTask.grade;
  for (const attempt of checkTask.attemptModels) {
    if (attempt.grade === null) {
      throw new SuitesUnreadable(reviewTaskId, `check task ${checkTask.id} ran an attempt on model ${attempt.model}, which the catalog does not grade`);
    }
    tier = higherTier(tier, attempt.grade);
  }
  return tier;
}

/** A review's answer came from a model graded below the check work it judged: the gateway broke its contract, and no verdict is read from it. */
class JudgeBelowWork extends Error {
  constructor(
    readonly reviewTaskId: string,
    readonly judged: CapabilityLevel,
    readonly answered: ReviewModel,
  ) {
    super(`review task ${reviewTaskId}: the review of check work at ${judged} was answered by ${modelName(answered)}, graded ${answered.grade}: no verdict is read from it`);
    this.name = "JudgeBelowWork";
  }
}

export interface SuiteReviewerDeps {
  readonly llm: ContextualLlm;
  readonly source: SuiteReviewSource;
  readonly publicInterface: PublicInterfaceReader;
  readonly judgements: SuiteReviewJudgementStore;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
  readonly logger: Logger;
}

export class SuiteReviewer implements SuiteReviewing {
  constructor(private readonly deps: SuiteReviewerDeps) {}

  async review(task: ReviewTask, targetProjectPath: string): Promise<SuiteReviewOutcome> {
    const vision = task.taskSpec?.visionItems;
    if (vision === undefined || vision.length === 0) {
      throw new SuitesUnreadable(task.id, "the review task records no vision item to review against (task_spec.visionItems)");
    }
    const { suites, setAside, judged } = await this.readSuites(task.id);
    const interfaces = await this.readInterfaces(task.id, targetProjectPath, suites);
    const frozen = await this.deps.source.frozen(task.id);
    const bySuite = new Map(suites.map((suite) => [suite.checkTaskId, suite]));
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: task.projectId, taskId: task.id, callSite: "suite-review" }),
      { site: "suite-review", attempts: 2, onAttempt: this.deps.onAttempt, reask: reviewReask },
    );
    const items = itemLines(task.taskSpec?.sources, vision);
    const maxTokens = reviewOutputBound(suites);
    const ask = (secondOpinion?: SecondOpinion) =>
      provider.generateStructured({
        judges: judged,
        prompt: reviewPrompt(items, interfaces, suites, secondOpinion === undefined ? "direct" : ANGLE_OF[secondOpinion.strength]),
        schema: ReviewResponseSchema,
        validate: (value) => verdictValidation(value, bySuite),
        maxTokens,
        secondOpinion,
      });
    const reviewed = { reviewed: [...bySuite.keys()], setAside };
    const first = await this.verdict(task.id, judged, () => ask(), bySuite);
    const findings = first.data.problems.map((finding) => {
      const suite = suiteOf(task.id, finding, bySuite);
      return { finding, suite, ratchet: ratchetOf(finding, frozen, suite) };
    });
    // The second review sees exactly the first's inputs and none of its verdict, asked at the
    // strongest independence the catalog offers. It is asked on every review: a finding acts only
    // on its agreement, and a review that routes nothing is a claim only it confirms.
    const secondAsked = await this.secondVerdict(task.id, judged, first.model, ask, bySuite);
    const answered = secondAsked.kind === "answered" ? secondAsked : null;
    const secondFailure = secondAsked.kind === "failed" ? secondAsked.reason : null;
    const review = answered === null ? null : answered.review;
    const second = answered === null ? [] : answered.data.problems;
    const { passedOver } = secondAsked;

    const routed: SuiteReviewProblem[] = [];
    const released: ReleasedRejection[] = [];
    const advisory: AdvisoryFinding[] = [];
    const judgements: ReviewJudgement[] = [];
    for (const { finding, suite, ratchet } of findings) {
      const named = namedBy(finding);
      const onTasks = second.filter((other) => namedBy(other).some((id) => named.includes(id)));
      const base = { checkTaskId: suite.checkTaskId, first: finding, firstModel: first.model, second: onTasks, secondReview: review, passedOver, secondFailure: null, tiers: tiersOf(judged, first.model, review) };
      const keep = (basis: Exclude<JudgementBasis, "two-reviews" | "second-opinion-agreed">, failure: string | null): void => {
        const undecided = finding.kind === "undecided-item" ? undecidedItemOf(task.id, finding, suite) : null;
        judgements.push({ ...base, check: isOutsideVision(finding) ? finding.check : null, outcome: "advisory", basis, undecided, secondFailure: failure });
        const by = basis === "second-opinion-disagreed" && review !== null ? `; the second review was ${secondReviewText(review)}` : "";
        const why = failure === null ? `${BASIS_TEXT[basis]}${by}` : `${BASIS_TEXT[basis]} (${failure.slice(0, FAILURE_CHARS)})`;
        advisory.push({ checkTaskIds: named, kind: finding.kind, finding: findingLine(finding), why });
      };
      if (ratchet !== null) {
        keep(ratchet, null);
        continue;
      }
      // A second review asked and failed confirms nothing: every finding it was asked for stays advisory.
      if (secondFailure !== null) {
        keep("second-review-failed", secondFailure);
        continue;
      }
      if (review === null) throw new SuiteVerdictUnfit(task.id, "a second review that did not fail named no model");
      const agreeing = agreeingWith(finding, second);
      if (isOutsideVision(finding)) {
        const judgement: Omit<ReviewJudgement, "outcome"> = { ...base, check: finding.check, basis: "two-reviews", undecided: null };
        if (agreeing !== undefined && isOutsideVision(agreeing)) {
          judgements.push({ ...judgement, outcome: "routed" });
          routed.push(judgedRejection(finding, agreeing, suite, review));
        } else {
          judgements.push({ ...judgement, outcome: "released" });
          released.push({ checkTaskId: suite.checkTaskId, check: finding.check, first: findingLine(finding), second: onTasks.map(findingLine), secondReview: secondReviewText(review) });
        }
        continue;
      }
      // No witness can settle these: only the independent second opinion's agreement acts on them.
      if (agreeing === undefined) {
        keep("second-opinion-disagreed", null);
        continue;
      }
      judgements.push({ ...base, check: null, outcome: "routed", basis: "second-opinion-agreed", undecided: null });
      routed.push(finding.kind === "contradiction" ? agreedContradiction(finding, review) : agreedUndecided(finding, review));
    }
    const undecided = judgements.flatMap((judgement) => (judgement.undecided === null ? [] : [judgement.undecided]));
    // A review that routes something is followed by another on the reopened checks, whose claim is the one judged.
    const claim = routed.length === 0 ? claimOf(bySuite, first.model, secondAsked, undecided, judged) : null;
    // Recorded before anything is released, routed or kept on them: a judgement that cannot be kept is not acted on.
    try {
      await this.deps.judgements.record({ projectId: task.projectId, reviewTaskId: task.id, judgements, claim });
    } catch (err) {
      throw new SuiteJudgementsUnrecorded(task.id, judgements.length, { cause: err });
    }
    if (claim !== null) return { kind: "clean", ...reviewed, released, advisory, undecided, claim: claimOutcome(claim) };
    return { kind: "problems", ...reviewed, released, advisory, undecided, problems: routed };
  }

  /**
   * The second review's verdict at the strongest independence that answers, or why none did.
   * Each strength is asked in order: one the catalog does not
   * serve at the capability (SecondOpinionUnavailable) or whose model gave no fit answer
   * (SecondOpinionUnanswered, StructuredOutputExhausted, SuiteVerdictUnfit) is passed over, recorded
   * and logged, and the next is asked. Any other throw (a spend-cap refusal, a schema Ashara must not
   * send, an answer from a model of another strength) is not the review's failure and fails the
   * review task.
   */
  private async secondVerdict(
    reviewTaskId: WorkItemId,
    judged: CapabilityLevel,
    first: ReviewModel,
    ask: (secondOpinion: SecondOpinion) => Promise<ReviewAnswer>,
    suites: ReadonlyMap<string, ReviewedSuite>,
  ): Promise<SecondVerdict> {
    const passedOver: PassedOver[] = [];
    for (const strength of SECOND_OPINION_STRENGTHS) {
      try {
        const { data, model } = await this.verdict(reviewTaskId, judged, () => ask({ avoid: first, strength }), suites);
        const review: SecondReview = { strength: strengthBetween(first, model), first, second: model };
        if (review.strength !== strength) throw new SecondOpinionMisrouted(reviewTaskId, strength, review);
        return { kind: "answered", data, review, passedOver };
      } catch (err) {
        const unavailable = err instanceof SecondOpinionUnavailable;
        if (!(unavailable || err instanceof SecondOpinionUnanswered || err instanceof StructuredOutputExhausted || err instanceof SuiteVerdictUnfit)) throw err;
        const reason = describeErrorChain(err);
        passedOver.push({ strength, outcome: unavailable ? "unavailable" : "failed", reason });
        this.deps.logger.warn(
          "quality.second-opinion-passed-over",
          `review task ${reviewTaskId}: no ${strength} second opinion (${unavailable ? "the catalog offers none" : "it failed"}); the next strength is asked`,
          { taskId: reviewTaskId, strength, outcome: unavailable ? "unavailable" : "failed" },
          err,
        );
      }
    }
    const reason = passedOver.map((over) => `${over.strength} ${over.outcome}: ${over.reason}`).join("; ");
    this.deps.logger.warn(
      "quality.second-review-failed",
      `review task ${reviewTaskId}: the second review failed at every strength, so no finding it was asked for acts and no item reads as verified on it: ${reason}`,
      { taskId: reviewTaskId, passedOver: passedOver.map((over) => ({ strength: over.strength, outcome: over.outcome, reason: over.reason })) },
    );
    return { kind: "failed", reason, passedOver };
  }

  /**
   * One review's verdict, validated by the ladder and again here: a model that ignored validate is
   * caught, never acted on, and so is an answer from a model graded below the check work it judged.
   */
  private async verdict(
    reviewTaskId: WorkItemId,
    judged: CapabilityLevel,
    ask: () => Promise<ReviewAnswer>,
    suites: ReadonlyMap<string, ReviewedSuite>,
  ): Promise<{ readonly data: ReviewResponse; readonly model: ReviewModel }> {
    const { data, provider, model, grade } = await ask();
    const answered: ReviewModel = { provider, model, grade };
    if (CAPABILITY_RANK[grade] < CAPABILITY_RANK[judged]) throw new JudgeBelowWork(reviewTaskId, judged, answered);
    const unfit = verdictErrors(data, suites);
    if (unfit.length > 0) throw new SuiteVerdictUnfit(reviewTaskId, unfit.join("; "));
    return { data, model: answered };
  }

  /**
   * Every finished suite of the review task's check tasks, and the tier of the check work they hold:
   * the highest over them. An Abandoned check task is set aside: its implementation is parked on it
   * and nothing it wrote is run. Any other unfinished check task, one that decides no task, one whose
   * work has no tier on record, or a finished one with no stored checks fails the review; so does a
   * plan with no suite to read, since a review of nothing would pass.
   */
  private async readSuites(
    reviewTaskId: WorkItemId,
  ): Promise<{ readonly suites: ReviewedSuite[]; readonly setAside: string[]; readonly judged: CapabilityLevel }> {
    const suites: ReviewedSuite[] = [];
    const setAside: string[] = [];
    for (const checkTask of await this.deps.source.checkTasksUnderReview(reviewTaskId)) {
      if (checkTask.status === "Abandoned") {
        setAside.push(checkTask.id);
        continue;
      }
      if (checkTask.status !== "Completed") {
        throw new SuitesUnreadable(reviewTaskId, `check task ${checkTask.id} is ${checkTask.status}: only finished suites are reviewed`);
      }
      if (checkTask.checksFor === null || checkTask.checkedTitle === null) {
        throw new SuitesUnreadable(reviewTaskId, `check task ${checkTask.id} decides no task on record (task_spec.checksFor)`);
      }
      if (checkTask.visionItems === null || checkTask.visionItems.length === 0) {
        throw new SuitesUnreadable(reviewTaskId, `check task ${checkTask.id} records no vision item its task delivers`);
      }
      const checks = await this.deps.source.latest(parseWorkItemId(checkTask.checksFor, "check task task_spec.checksFor"));
      if (checks === null) {
        throw new SuitesUnreadable(reviewTaskId, `check task ${checkTask.id} is Completed but no checks are stored for task ${checkTask.checksFor}`);
      }
      suites.push({
        checkTaskId: checkTask.id,
        checksFor: checkTask.checksFor,
        taskTitle: checkTask.checkedTitle,
        cited: citedItems(checkTask.sources, checkTask.visionItems),
        checks,
        reviewReopens: checkTask.reviewReopens,
        judgedTier: checkWorkTier(reviewTaskId, checkTask),
      });
    }
    const [head, ...rest] = suites;
    if (head === undefined) throw new SuitesUnreadable(reviewTaskId, "none of its check tasks finished a suite to review");
    const judged = rest.reduce((tier, suite) => higherTier(tier, suite.judgedTier), head.judgedTier);
    return { suites, setAside, judged };
  }

  /**
   * PUBLIC_INTERFACE.md at each commit the suites were red-run on, once per commit. A suite stored
   * before baselines were recorded has none, and the review is told so; a commit git cannot read
   * fails the review rather than judging the checks without the interface they were written against.
   */
  private async readInterfaces(
    reviewTaskId: WorkItemId,
    targetProjectPath: string,
    suites: readonly ReviewedSuite[],
  ): Promise<InterfaceReading[]> {
    const commits = [...new Set(suites.map((suite) => suite.checks.baselineCommit))];
    const readings: InterfaceReading[] = [];
    for (const commit of commits) {
      if (commit === null) {
        readings.push({ commit: null, reading: null });
        continue;
      }
      try {
        readings.push({ commit, reading: await this.deps.publicInterface.at(targetProjectPath, commit) });
      } catch (err) {
        throw new SuitesUnreadable(reviewTaskId, `${PUBLIC_INTERFACE_FILE} could not be read at commit ${commit}: ${describeErrorChain(err)}`);
      }
    }
    return readings;
  }
}
