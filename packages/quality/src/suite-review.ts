import { z } from "zod";
import { runHostGit, targetRepo } from "@ashara/execution-infra";
import type { ContextualLlm } from "@ashara/finance";
import { withStructuredLadder } from "@ashara/finance";
import type { LadderAttemptEvent, StructuredValidation } from "@ashara/finance";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { describeErrorChain, parseWorkItemId } from "@ashara/shared";
import type { StoredTaskSpec } from "./acl/delivery-acl.js";
import type { VisionSource } from "./acl/engagement-acl.js";
import { visionSourceCitation } from "./acl/engagement-acl.js";
import { PUBLIC_INTERFACE_FILE } from "./public-interface.js";
import type { TaskChecks } from "./task-checks.js";

// Quality's review of a plan revision's check suites (ADR-074 addendum 2 d71 c): checks written by
// independent authors can together ask for what no product can pass. After the last check task of a revision completes and
// before any implementation starts, every stored suite is read together with the vision, in one
// structured call of its own: a separate dispatch of the check author's role that wrote none of the
// checks it reads. Each check is judged against the vision items its own task cites, with their
// status, and against the product's public interface as it stood on the commit the checks were
// written against (d89 B): a reviewer that reads neither rejects checks their brief required.
// What it finds is routed by the orchestrator (planning's exitSuiteReview). A model can misread an
// item it was shown whole. Z0 can disprove an outside-vision rejection only one way: the clause it
// quotes as missing appears word for word (case and punctuation aside) in the text of an item the
// check's task cites. Such a rejection is discarded and the review asked again within the ladder's
// bound. Z0 cannot tell that a paraphrased clause is absent, so a rejection it cannot disprove is
// the reviewer's judgement, not a verified fact: it is acted on only when a second review, a fresh
// call with the same prompt that never sees the first verdict, rejects the same check as outside
// the vision too. When it does not, the check is released as passing review and both judgements
// are recorded with the outcome.

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
}

/** What the review reads: the review task's check tasks and the checks stored for their tasks. */
export interface SuiteReviewSource {
  /** The check tasks the review task depends on: its plan revision's. */
  checkTasksUnderReview(reviewTaskId: WorkItemId): Promise<readonly CheckTaskUnderReview[]>;
  /** The task's latest revision of checks, or null when none was ever stored. */
  latest(taskId: WorkItemId): Promise<TaskChecks | null>;
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
  readonly kind: "contradiction" | "outside-vision";
  readonly problem: string;
  readonly evidence: string;
}

/**
 * An outside-vision rejection the first review made and the second did not: the check passes review.
 * Both judgements are kept: the first's rejection, and every finding the second made on that check
 * task (none when it found nothing there).
 */
interface ReleasedRejection {
  readonly checkTaskId: string;
  readonly check: string;
  readonly first: string;
  readonly second: readonly string[];
}

/**
 * The review's verdict, accepted only after its schema validated and every check task it names is
 * one it read. `reviewed` names the check tasks whose suites it read; `setAside` the Abandoned ones,
 * whose implementations wait on nothing they wrote; `released` the rejections the second review did
 * not reach.
 */
type SuiteReviewOutcome =
  | { readonly kind: "clean"; readonly reviewed: readonly string[]; readonly setAside: readonly string[]; readonly released: readonly ReleasedRejection[] }
  | {
      readonly kind: "problems";
      readonly reviewed: readonly string[];
      readonly setAside: readonly string[];
      readonly released: readonly ReleasedRejection[];
      readonly problems: readonly SuiteReviewProblem[];
    };

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

const NonEmpty = z.string().trim().min(1);

/**
 * A rejection is acted on only with what makes its claim checkable: an outside-vision finding names
 * the one check task and the one check it judged, the cited items it judged the check against and,
 * quoted, the clause it says none of them states; a finding without them is not a verdict.
 */
const ReviewResponseSchema = z.strictObject({
  problems: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("contradiction"),
        checkTasks: z.array(NonEmpty).min(1),
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
    ]),
  ),
});

type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

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
  readonly taskTitle: string;
  readonly cited: readonly CitedItem[];
  readonly checks: TaskChecks;
}

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
    `It wrote the checks of the task ${JSON.stringify(suite.taskTitle)}, which cites these vision items:`,
    ...suite.cited.map((item) => `- ${item.line}`),
    `Checks (revision ${suite.checks.revision}${suite.checks.baselineCommit === null ? "" : `, written against commit ${suite.checks.baselineCommit}`}):`,
    ...suite.checks.checks.map((check) => `- ${JSON.stringify(check.name)}: ${check.command}`),
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

function reviewPrompt(vision: readonly string[], interfaces: readonly InterfaceReading[], suites: readonly ReviewedSuite[]): string {
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
    `Name every problem of these two kinds, and nothing else:`,
    `- "contradiction": checks, of one check task or of several, that no single product could all pass (one requires`,
    `  an output, a format, a file or an exit status that another forbids). Name every check task whose checks are involved.`,
    `- "outside-vision": a check that requires behaviour none of the vision items its own task cites asks for. Judge`,
    `  each check only against its own task's cited items, whatever their status: an Inferred client-visible`,
    `  assumption the task cites is asked for. An input a cited item says the product must reject is asked for. Using a`,
    `  form the public interface names (a command, an argument, a file, an exit status) is never outside. Name the one`,
    `  check task that wrote it. Read each cited item's whole text, every clause of it, before you say it does not ask`,
    `  for something: a finding whose clause a cited item states is discarded and you are asked again.`,
    `For each: "checkTasks" lists those check task ids exactly as written above; "problem" says which checks and what`,
    `cannot hold, in one or two sentences; "evidence" quotes the commands or file lines that show it. An "outside-vision"`,
    `finding is about one check: it also gives "check", that check's name exactly as written above, "judgedItems", the`,
    `ids of the cited items you judged the check against, exactly as written above, and "missingClause", the behaviour`,
    `the check requires, in a few words, that you say none of them states.`,
    `Do not report style, missing coverage, or checks you would have written differently. When there is no problem,`,
    `return {"problems": []}.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"problems": [{"kind": "contradiction", "checkTasks": ["<check task id>", "<check task id>"], "problem": "...", "evidence": "..."}, ` +
      `{"kind": "outside-vision", "checkTasks": ["<check task id>"], "check": "<check name>", "judgedItems": ["<cited item id>"], "missingClause": "...", "problem": "...", "evidence": "..."}]}`,
  ].join("\n");
}

function reviewReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. In "checkTasks" use ONLY the check task ids written above, in "check" ONLY a ` +
    `check of that check task, in "judgedItems" ONLY the ids of the items that check task cites. No markdown, no prose.`
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
 * no words at all, or a clause that appears word for word in one of the check task's cited items.
 * A paraphrase of a cited item passes this check: Z0 cannot verify that a clause is absent.
 */
function verdictErrors(response: ReviewResponse, suites: ReadonlyMap<string, ReviewedSuite>): string[] {
  const unreadError = (i: number, id: string): string =>
    `problem ${i + 1} names check task ${JSON.stringify(id)}, which is none of [${[...suites.keys()].join(", ")}]`;
  return response.problems.flatMap((problem, i) => {
    if (problem.kind === "contradiction") return problem.checkTasks.filter((id) => !suites.has(id)).map((id) => unreadError(i, id));
    const checkTaskId = problem.checkTasks[0];
    const suite = checkTaskId === undefined ? undefined : suites.get(checkTaskId);
    if (checkTaskId === undefined || suite === undefined) return [unreadError(i, checkTaskId ?? "(none)")];
    const checkNames = suite.checks.checks.map((check) => check.name);
    const unwritten = checkNames.includes(problem.check)
      ? []
      : [`problem ${i + 1} judged check ${JSON.stringify(problem.check)}, which check task ${checkTaskId} did not write (it wrote [${checkNames.join(", ")}])`];
    const citedIds = suite.cited.map((item) => item.id);
    const uncited = problem.judgedItems
      .filter((id) => !citedIds.includes(id))
      .map((id) => `problem ${i + 1} judged item ${JSON.stringify(id)}, which check task ${checkTaskId} does not cite (it cites [${citedIds.join(", ")}])`);
    const clause = normalized(problem.missingClause);
    if (clause === "") return [...unwritten, ...uncited, `problem ${i + 1} gives a missingClause with no words: ${JSON.stringify(problem.missingClause)}`];
    const stating = suite.cited.filter((item) => ` ${normalized(item.text)} `.includes(` ${clause} `));
    return [
      ...unwritten,
      ...uncited,
      ...stating.map(
        (item) =>
          `problem ${i + 1} says no item check task ${checkTaskId} cites asks for ${JSON.stringify(problem.missingClause)}, but ${item.id} ` +
          `states it: ${JSON.stringify(item.text)}. Judge that check against the whole text of every item it cites again.`,
      ),
    ];
  });
}

function verdictValidation(response: ReviewResponse, suites: ReadonlyMap<string, ReviewedSuite>): StructuredValidation {
  const errors = verdictErrors(response, suites);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

type ReviewFinding = ReviewResponse["problems"][number];
type OutsideVisionFinding = Extract<ReviewFinding, { readonly kind: "outside-vision" }>;

function isOutsideVision(finding: ReviewFinding): finding is OutsideVisionFinding {
  return finding.kind === "outside-vision";
}

function findingLine(finding: ReviewFinding): string {
  if (finding.kind === "contradiction") return `contradiction in ${finding.checkTasks.join(", ")}: ${finding.problem}`;
  return `check ${JSON.stringify(finding.check)} is outside the vision, requiring ${JSON.stringify(finding.missingClause)}: ${finding.problem}`;
}

/**
 * An outside-vision rejection as Delivery routes it: the reviewers' judgement, said to be one, with
 * the clause they say is missing and the exact text of every item the check's task cites side by
 * side, so whoever acts on it reads both.
 */
function judgedRejection(finding: OutsideVisionFinding, suite: ReviewedSuite): SuiteReviewProblem {
  const items = suite.cited.map((item) => `${item.id}: ${JSON.stringify(item.text)}`).join("; ");
  return {
    checkTaskIds: [suite.checkTaskId],
    kind: "outside-vision",
    problem:
      `${finding.problem} This is the reviewers' judgement, not a verified fact: two independent reviews each judged check ` +
      `${JSON.stringify(finding.check)} to require ${JSON.stringify(finding.missingClause)}, which they read none of its task's ` +
      `cited items as asking for (judged against ${finding.judgedItems.join(", ")}). The clause and the items, side by side: ` +
      `required ${JSON.stringify(finding.missingClause)}; cited ${items}.`,
    evidence: finding.evidence,
  };
}

interface SuiteReviewerDeps {
  readonly llm: ContextualLlm;
  readonly source: SuiteReviewSource;
  readonly publicInterface: PublicInterfaceReader;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

export class SuiteReviewer implements SuiteReviewing {
  constructor(private readonly deps: SuiteReviewerDeps) {}

  async review(task: ReviewTask, targetProjectPath: string): Promise<SuiteReviewOutcome> {
    const vision = task.taskSpec?.visionItems;
    if (vision === undefined || vision.length === 0) {
      throw new SuitesUnreadable(task.id, "the review task records no vision item to review against (task_spec.visionItems)");
    }
    const { suites, setAside } = await this.readSuites(task.id);
    const interfaces = await this.readInterfaces(task.id, targetProjectPath, suites);
    const bySuite = new Map(suites.map((suite) => [suite.checkTaskId, suite]));
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: task.projectId, taskId: task.id, callSite: "suite-review" }),
      { site: "suite-review", attempts: 2, onAttempt: this.deps.onAttempt, reask: reviewReask },
    );
    const prompt = reviewPrompt(itemLines(task.taskSpec?.sources, vision), interfaces, suites);
    const ask = () =>
      provider.generateStructured({
        capability: "Strong",
        prompt,
        schema: ReviewResponseSchema,
        validate: (value) => verdictValidation(value, bySuite),
        maxTokens: 4096,
      });
    const reviewedIds = [...bySuite.keys()];
    const first = await this.verdict(task.id, ask, bySuite);
    const contradictions = first.problems.filter((finding) => finding.kind === "contradiction");
    const rejections = first.problems.filter(isOutsideVision);
    // The second review sees exactly the first's inputs and none of its verdict; it is asked only
    // when there is a rejection Z0 could not disprove.
    const second = rejections.length === 0 ? [] : (await this.verdict(task.id, ask, bySuite)).problems;
    const routed: SuiteReviewProblem[] = contradictions.map((finding) => ({
      checkTaskIds: [...new Set(finding.checkTasks)],
      kind: finding.kind,
      problem: finding.problem,
      evidence: finding.evidence,
    }));
    const released: ReleasedRejection[] = [];
    for (const finding of rejections) {
      const [checkTaskId] = finding.checkTasks;
      const suite = checkTaskId === undefined ? undefined : bySuite.get(checkTaskId);
      if (checkTaskId === undefined || suite === undefined) {
        throw new SuitesUnreadable(task.id, `a validated rejection names check task ${JSON.stringify(finding.checkTasks)}, which is not one it read`);
      }
      const agreed = second.some((other) => isOutsideVision(other) && other.checkTasks[0] === checkTaskId && other.check === finding.check);
      if (agreed) {
        routed.push(judgedRejection(finding, suite));
        continue;
      }
      released.push({
        checkTaskId,
        check: finding.check,
        first: findingLine(finding),
        second: second.filter((other) => other.checkTasks.includes(checkTaskId)).map(findingLine),
      });
    }
    if (routed.length === 0) return { kind: "clean", reviewed: reviewedIds, setAside, released };
    return { kind: "problems", reviewed: reviewedIds, setAside, released, problems: routed };
  }

  /** One review's verdict, validated by the ladder and again here: a model that ignored validate is caught, never acted on. */
  private async verdict(
    reviewTaskId: WorkItemId,
    ask: () => Promise<{ readonly data: ReviewResponse }>,
    suites: ReadonlyMap<string, ReviewedSuite>,
  ): Promise<ReviewResponse> {
    const { data } = await ask();
    const unfit = verdictErrors(data, suites);
    if (unfit.length > 0) throw new SuitesUnreadable(reviewTaskId, `the review's verdict is unfit to act on: ${unfit.join("; ")}`);
    return data;
  }

  /**
   * Every finished suite of the review task's check tasks. An Abandoned check task is set aside: its
   * implementation is parked on it and nothing it wrote is run. Any other unfinished check task, one
   * that decides no task, or a finished one with no stored checks fails the review; so does a plan
   * with no suite to read, since a review of nothing would pass.
   */
  private async readSuites(reviewTaskId: WorkItemId): Promise<{ readonly suites: ReviewedSuite[]; readonly setAside: string[] }> {
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
        taskTitle: checkTask.checkedTitle,
        cited: citedItems(checkTask.sources, checkTask.visionItems),
        checks,
      });
    }
    if (suites.length === 0) throw new SuitesUnreadable(reviewTaskId, "none of its check tasks finished a suite to review");
    return { suites, setAside };
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
