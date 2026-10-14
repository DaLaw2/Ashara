import { z } from "zod";
import { withStructuredLadder } from "@ashara/llm-gateway";
import type { ContextualLlm, LadderAttemptEvent, StructuredValidation } from "@ashara/llm-gateway";
import type { ProjectId, StoredTaskSpec, WorkItemId } from "@ashara/shared";
import { parseWorkItemId } from "@ashara/shared";
import type { TaskChecks } from "./task-checks.js";

// Quality's review of a plan revision's check suites (ADR-074 addendum 2 d71 c; fifth run N20: 36
// stored checks no product could all pass). After the last check task of a revision completes and
// before any implementation starts, every stored suite is read together with the vision, in one
// structured call of its own: a separate dispatch of the check author's role that wrote none of the
// checks it reads. What it finds is routed by the orchestrator (planning's exitSuiteReview).

/** A check task the review reads, as stored; nulls are what its row does not record. */
interface CheckTaskUnderReview {
  readonly id: string;
  readonly status: string;
  /** The implementation task its checks decide (task_spec.checksFor). */
  readonly checksFor: string | null;
  /** The vision items its task delivers (task_spec.visionItems). */
  readonly visionItems: readonly string[] | null;
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
  review(task: ReviewTask): Promise<SuiteReviewOutcome>;
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

/** One suite as the review reads it. */
interface ReviewedSuite {
  readonly checkTaskId: string;
  readonly taskTitle: string;
  readonly visionItems: readonly string[];
  readonly checks: TaskChecks;
}

/** A check file longer than this is cut in the prompt, and the cut is stated. */
const FILE_CHARS = 6000;

function fileText(content: string): string {
  if (content.length <= FILE_CHARS) return content;
  return `${content.slice(0, FILE_CHARS)}\n[cut: ${content.length - FILE_CHARS} more characters not shown]`;
}

function suiteSection(suite: ReviewedSuite): string {
  const files = suite.checks.files.map((file) => `--- file ${file.path}\n${fileText(file.content)}`);
  return [
    `## Check task ${suite.checkTaskId}`,
    `It wrote the checks of the task ${JSON.stringify(suite.taskTitle)}, which delivers these vision items:`,
    ...suite.visionItems.map((item) => `- ${item}`),
    `Checks (revision ${suite.checks.revision}):`,
    ...suite.checks.checks.map((check) => `- ${JSON.stringify(check.name)}: ${check.command}`),
    ...(files.length === 0 ? [`Files: none`] : [`Files:`, ...files]),
  ].join("\n");
}

function reviewPrompt(vision: readonly string[], suites: readonly ReviewedSuite[]): string {
  return [
    `You review the acceptance checks of a software project before any of its work starts. Each check is a shell`,
    `command run from the repository root; it passes when it exits 0 and prints output. Every check below runs on the`,
    `same finished product once all of its tasks are done, so every one of them must be able to pass on that one product.`,
    ``,
    `# What the client asked for (the vision)`,
    ...vision.map((item) => `- ${item}`),
    ``,
    `# The checks, by the check task that wrote them`,
    ...suites.map(suiteSection),
    ``,
    `# What to return`,
    `Name every problem of these two kinds, and nothing else:`,
    `- "contradiction": checks, of one check task or of several, that no single product could all pass (one requires`,
    `  an output, a format, a file or an exit status that another forbids). Name every check task whose checks are involved.`,
    `- "outside-vision": a check that requires behaviour none of its task's vision items asks for. An input a vision`,
    `  item says the product must reject is asked for. Name the check task that wrote it.`,
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
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

export class SuiteReviewer implements SuiteReviewing {
  constructor(private readonly deps: SuiteReviewerDeps) {}

  async review(task: ReviewTask): Promise<SuiteReviewOutcome> {
    const vision = task.taskSpec?.visionItems;
    if (vision === undefined || vision.length === 0) {
      throw new SuitesUnreadable(task.id, "the review task records no vision item to review against (task_spec.visionItems)");
    }
    const { suites, setAside } = await this.readSuites(task.id);
    const reviewed = new Set(suites.map((suite) => suite.checkTaskId));
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: task.projectId, taskId: task.id, callSite: "suite-review" }),
      { site: "suite-review", attempts: 2, onAttempt: this.deps.onAttempt, reask: reviewReask },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: reviewPrompt(vision, suites),
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
      suites.push({ checkTaskId: checkTask.id, taskTitle: checkTask.checkedTitle, visionItems: checkTask.visionItems, checks });
    }
    if (suites.length === 0) throw new SuitesUnreadable(reviewTaskId, "none of its check tasks finished a suite to review");
    return { suites, setAside };
  }
}
