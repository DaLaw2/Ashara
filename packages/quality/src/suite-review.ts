import { z } from "zod";
import { runHostGit, targetRepo } from "@ashara/execution-infra";
import type { ContextualLlm } from "@ashara/finance";
import { withStructuredLadder } from "@ashara/model-access";
import type { LadderAttemptEvent, StructuredValidation } from "@ashara/model-access";
import type { ProjectId, WorkItemId } from "@ashara/shared";
import { describeErrorChain, parseWorkItemId } from "@ashara/shared";
import type { StoredTaskSpec } from "./acl/delivery-acl.js";
import type { VisionSource } from "./acl/engagement-acl.js";
import { visionSourceLine } from "./acl/engagement-acl.js";
import { PUBLIC_INTERFACE_FILE } from "./public-interface.js";
import type { TaskChecks } from "./task-checks.js";

// Quality's review of a plan revision's check suites (ADR-074 addendum 2 d71 c; fifth run N20: 36
// stored checks no product could all pass). After the last check task of a revision completes and
// before any implementation starts, every stored suite is read together with the vision, in one
// structured call of its own: a separate dispatch of the check author's role that wrote none of the
// checks it reads. Each check is judged against the vision items its own task cites, with their
// status, and against the product's public interface as it stood on the commit the checks were
// written against (d89 B, W11: the reviewer read neither, and rejected checks their brief required).
// What it finds is routed by the orchestrator (planning's exitSuiteReview).

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

/** One problem the review found, with the check tasks whose checks it involves. */
interface SuiteReviewProblem {
  readonly checkTaskIds: readonly string[];
  readonly kind: "contradiction" | "outside-vision";
  readonly problem: string;
  readonly evidence: string;
}

/**
 * The review's verdict, accepted only after its schema validated and every check task it names is
 * one it read. `reviewed` names the check tasks whose suites it read; `setAside` the Abandoned ones,
 * whose implementations wait on nothing they wrote.
 */
type SuiteReviewOutcome =
  | { readonly kind: "clean"; readonly reviewed: readonly string[]; readonly setAside: readonly string[] }
  | {
      readonly kind: "problems";
      readonly reviewed: readonly string[];
      readonly setAside: readonly string[];
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

const ReviewResponseSchema = z.strictObject({
  problems: z.array(
    z.strictObject({
      checkTasks: z.array(z.string().trim().min(1)).min(1),
      kind: z.enum(["contradiction", "outside-vision"]),
      problem: z.string().trim().min(1),
      evidence: z.string().trim().min(1),
    }),
  ),
});

type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/** One suite as the review reads it: its task's cited items, each with its id and status when the row records them. */
interface ReviewedSuite {
  readonly checkTaskId: string;
  readonly taskTitle: string;
  readonly cited: readonly string[];
  readonly checks: TaskChecks;
}

/** A check file longer than this is cut in the prompt, and the cut is stated. */
const FILE_CHARS = 6000;

function fileText(content: string): string {
  if (content.length <= FILE_CHARS) return content;
  return `${content.slice(0, FILE_CHARS)}\n[cut: ${content.length - FILE_CHARS} more characters not shown]`;
}

/** The items as the review shows them: with id, status and kind, or the bare texts of a row written before those. */
function itemLines(sources: readonly VisionSource[] | null | undefined, texts: readonly string[]): string[] {
  return sources === null || sources === undefined || sources.length === 0
    ? texts.map((text) => `${text} (its id, status and kind are not recorded)`)
    : sources.map(visionSourceLine);
}

function suiteSection(suite: ReviewedSuite): string {
  const files = suite.checks.files.map((file) => `--- file ${file.path}\n${fileText(file.content)}`);
  return [
    `## Check task ${suite.checkTaskId}`,
    `It wrote the checks of the task ${JSON.stringify(suite.taskTitle)}, which cites these vision items:`,
    ...suite.cited.map((item) => `- ${item}`),
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
    `  form the public interface names (a command, an argument, a file, an exit status) is never outside. Name the check`,
    `  task that wrote it.`,
    `For each: "checkTasks" lists those check task ids exactly as written above; "problem" says which checks and what`,
    `cannot hold, in one or two sentences; "evidence" quotes the commands or file lines that show it.`,
    `Do not report style, missing coverage, or checks you would have written differently. When there is no problem,`,
    `return {"problems": []}.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"problems": [{"checkTasks": ["<check task id>"], "kind": "contradiction", "problem": "...", "evidence": "..."}]}`,
  ].join("\n");
}

function reviewReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. In "checkTasks" use ONLY the check task ids written above. No markdown, no prose.`
  );
}

/** Every check task a problem names must be one whose suite was read. */
function validateNames(response: ReviewResponse, reviewed: ReadonlySet<string>): StructuredValidation {
  const errors = response.problems.flatMap((problem, i) =>
    problem.checkTasks
      .filter((id) => !reviewed.has(id))
      .map((id) => `problem ${i + 1} names check task ${JSON.stringify(id)}, which is none of [${[...reviewed].join(", ")}]`),
  );
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
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
    const reviewed = new Set(suites.map((suite) => suite.checkTaskId));
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: task.projectId, taskId: task.id, callSite: "suite-review" }),
      { site: "suite-review", attempts: 2, onAttempt: this.deps.onAttempt, reask: reviewReask },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: reviewPrompt(itemLines(task.taskSpec?.sources, vision), interfaces, suites),
      schema: ReviewResponseSchema,
      validate: (value) => validateNames(value, reviewed),
      maxTokens: 4096,
    });
    const reviewedIds = [...reviewed];
    // The ladder validated the names; a model that ignored validate is caught here, never trusted.
    const unnamed = validateNames(response.data, reviewed);
    if (!unnamed.ok) throw new SuitesUnreadable(task.id, `the review named check tasks it did not read: ${unnamed.errors.join("; ")}`);
    if (response.data.problems.length === 0) return { kind: "clean", reviewed: reviewedIds, setAside };
    return {
      kind: "problems",
      reviewed: reviewedIds,
      setAside,
      problems: response.data.problems.map((problem) => ({
        checkTaskIds: [...new Set(problem.checkTasks)],
        kind: problem.kind,
        problem: problem.problem,
        evidence: problem.evidence,
      })),
    };
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
        cited: itemLines(checkTask.sources, checkTask.visionItems),
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
