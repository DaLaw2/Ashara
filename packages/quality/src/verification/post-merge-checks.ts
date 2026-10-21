import type { BuiltEnvironment, CheckoutLease, CurrentEnvironment, EnvironmentImages } from "@ashara/execution-infra";
import {
  ENVIRONMENT_BUILD_TIMEOUT_MS,
  EnvironmentBuildFailed,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  cellRunBoundMs,
  environmentVersion,
  targetRepo,
} from "@ashara/execution-infra";
import type { Logger, WorkItemId } from "@ashara/shared";
import { renderElided } from "@ashara/shared";
import { isSprint0Origin } from "../acl/delivery-acl.js";
import { PostMergeEnvironmentMissing } from "../dispatch-result.js";
import type { ExecutionEventSink, VerifiedDispatch } from "../dispatch-result.js";
import { runPostMergeEnvironmentCommands, runPostMergeProbe } from "../environment-check.js";
import type { EnvironmentStatementStore, TestedEnvironment } from "../environment-check.js";
import { readEnvironmentDefinition } from "../environment-definition.js";
import type { EnvironmentDefinition } from "../environment-definition.js";
import { environmentCommandsPassed, environmentProbePassed, formatEnvironmentCommands, formatEnvironmentProbe } from "../environment-verdict.js";
import { environmentErrorOf, VerificationInfrastructureFault } from "../fault-class.js";
import type { PostMergeVerdict } from "../gates/finalize.js";
import { productChangeOf, runSuitesOnCheckout, tentativeMergeCommit } from "../task-checks.js";
import type { CheckSuite, CompletedTaskChecks, SuiteRun, TaskCheckStore, TaskChecks } from "../task-checks.js";
import { POST_MERGE_VERIFIER_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";
import { suitesVerdict } from "./suites-verdict.js";

/**
 * The environment a tentative merge is verified in: the dispatch's own version, unchanged; a new
 * version the merge produced by changing the build context (an input),
 * rebuilt and the product's build and test passed on it (`details` says so); or none the merge can
 * be verified in, which refuses it (`details` says why).
 */
type MergedEnvironment =
  | ({ readonly kind: "unchanged" } & MergedImage)
  | ({ readonly kind: "rebuilt"; readonly statement: string; readonly details: string } & MergedImage)
  | { readonly kind: "refused"; readonly details: string };

/** The image a merge is verified in, and the definition it was built from. */
interface MergedImage {
  readonly version: string;
  /** The image id: what the verifier cells start from. */
  readonly image: string;
  readonly imageRef: string;
  readonly definition: EnvironmentDefinition;
}

export interface PostMergeChecksDeps {
  readonly dispatchCells: Pick<DispatchCells, "environmentScope" | "checkCells" | "checkoutDir">;
  readonly attemptPolicy: { readonly perCommandTimeoutSeconds: number };
  /** Builds the image of a version a merge produced, and keeps the stack statement it carries. */
  readonly environment: {
    readonly images: Pick<EnvironmentImages, "build">;
    readonly statements: Pick<EnvironmentStatementStore, "record">;
  };
  readonly checks: Pick<TaskCheckStore, "completedOf">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** The checks a tentative merge must pass before it lands: one per kind of work merged. */
export class PostMergeChecks {
  private readonly deps: PostMergeChecksDeps;

  constructor(deps: PostMergeChecksDeps) {
    this.deps = deps;
  }

  /**
   * An environment task's post-merge check: the gate's run again, the definition's `probe` from the
   * gate's image, on a throwaway checkout of the tentative merge. Sprint 0's merge holds no product,
   * so it runs nothing else, nor does an environment change opened with
   * product "absent" (the product scaffold asked before any scaffold completed; its own merge runs
   * them). Any other environment change lands on a product: after the probe, the product's `build`
   * then `test` run on the merge from the same image and must leave the checkout clean.
   */
  async postMergeEnvironmentTest(d: VerifiedDispatch, targetProjectPath: string, tested: TestedEnvironment, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const commit = await tentativeMergeCommit(targetProjectPath, d.task.id);
    const scope = this.deps.dispatchCells.environmentScope(d);
    const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
    lease.extend(cellRunBoundMs([timeoutSeconds]), "the post-merge probe cell");
    const probe = await runPostMergeProbe(scope, POST_MERGE_VERIFIER_ROLE, tested, commit, timeoutSeconds);
    let passed = environmentProbePassed(probe);
    let details = formatEnvironmentProbe(probe);
    const noProduct = isSprint0Origin(d.task.taskSpec?.origin) || d.task.taskSpec?.product === "absent";
    if (passed && !noProduct) {
      lease.extend(cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the post-merge build and test cell");
      const commands = await runPostMergeEnvironmentCommands(scope, POST_MERGE_VERIFIER_ROLE, tested, commit, timeoutSeconds);
      passed = environmentCommandsPassed(commands);
      details = `${details}\nThe product's build and test on the merge:\n${formatEnvironmentCommands(commands)}`;
    }
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: d.task.id, attempt: d.task.attempt, verdict: passed ? "passed" : "failed", details });
    return { passed, details };
  }

  /**
   * The product scaffold's post-merge check: the environment of the
   * tentative merge (mergedEnvironment: rebuilt when the scaffold wrote an input the recipe reads),
   * then the definition's `build` then `test` on a throwaway checkout of the merge in a verifier
   * cell from that image, which must pass and leave the checkout clean. A rebuilt version passing
   * records the dispatch's statement for it. A substrate failure throws.
   */
  async postMergeScaffold(d: VerifiedDispatch, targetProjectPath: string, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const { task } = d;
    let verdict: PostMergeVerdict;
    let merged: MergedEnvironment;
    try {
      if (d.environment.kind !== "environment") throw new PostMergeEnvironmentMissing(task.id);
      const commit = await tentativeMergeCommit(targetProjectPath, task.id);
      merged = await this.mergedEnvironment(d, d.environment, commit, lease);
      if (merged.kind === "refused") {
        verdict = { passed: false, details: merged.details };
      } else if (merged.kind === "rebuilt") {
        verdict = { passed: true, details: merged.details };
      } else {
        const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
        lease.extend(cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the post-merge build and test cell");
        const commands = await runPostMergeEnvironmentCommands(
          this.deps.dispatchCells.environmentScope(d),
          POST_MERGE_VERIFIER_ROLE,
          { version: merged.version, imageRef: merged.imageRef, definition: merged.definition },
          commit,
          this.deps.attemptPolicy.perCommandTimeoutSeconds,
        );
        verdict = {
          passed: environmentCommandsPassed(commands),
          details: `the product's build and test (environment version ${merged.version}) on the merge:\n${formatEnvironmentCommands(commands)}`,
        };
      }
    } catch (e) {
      if (environmentErrorOf(e) !== null) throw e;
      throw new VerificationInfrastructureFault(task.id, "product scaffold build and test", { cause: e });
    }
    this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: task.id, attempt: task.attempt, verdict: verdict.passed ? "passed" : "failed", details: verdict.details });
    if (verdict.passed && merged.kind === "rebuilt") await this.recordRebuiltStatement(task.id, merged);
    return verdict;
  }

  /** The version a verified merge produced carries the statement of the stack it was built from. */
  private async recordRebuiltStatement(taskId: WorkItemId, merged: Extract<MergedEnvironment, { readonly kind: "rebuilt" }>): Promise<void> {
    try {
      await this.deps.environment.statements.record(taskId, merged.statement, merged.version);
    } catch (e) {
      throw new VerificationInfrastructureFault(taskId, `record the environment statement for rebuilt version ${merged.version}`, { cause: e });
    }
  }

  /**
   * Every other task's post-merge check.
   * First the merge's own environment (mergedEnvironment): when the work changed an input the
   * recipe reads, the merge's version is rebuilt and the product's build and test must pass on it,
   * and that version's image and test replace the dispatch's below; the merge passing records the
   * dispatch's statement for that version. Then, in one verifier cell from that image on a
   * throwaway checkout of the tentative merge, in order:
   * the environment definition's `test`; the latest stored checks of every implementation task of
   * the project already Completed, each with its files written over the checkout; then this task's
   * own stored checks with theirs, so whatever the implementer put at those paths is replaced and it
   * cannot grade itself. An earlier task's checks are not red-run again on this environment: they
   * are regression checks and must pass on the merge whatever version they were red-run on. Every
   * check must exit 0 with output; any failure fails this task naming the suite and the check, and
   * an earlier task's check that fails is this task's regression. Sequential, each check bounded by
   * the per-command timeout: the run takes at most (1 + every check counted) x that timeout, plus
   * the cell's start and teardown, plus, for a rebuilt environment, its image build (bounded by the
   * builder) and its build and test (2 x that timeout). A substrate failure throws, which finalize turns into an
   * environment block.
   */
  async postMergeStoredChecks(d: VerifiedDispatch, targetProjectPath: string, stored: TaskChecks, lease: CheckoutLease): Promise<PostMergeVerdict> {
    const { task } = d;
    let runs: readonly SuiteRun[];
    let suites: readonly CheckSuite[];
    let earlier: readonly CompletedTaskChecks[];
    let unchecked: readonly string[];
    let merged: MergedEnvironment;
    try {
      if (d.environment.kind !== "environment") {
        throw new PostMergeEnvironmentMissing(task.id);
      }
      const commit = await tentativeMergeCommit(targetProjectPath, task.id);
      merged = await this.mergedEnvironment(d, d.environment, commit, lease);
      if (merged.kind === "refused") {
        this.deps.eventSink?.emit({ event: "post_merge_verify", taskId: task.id, attempt: task.attempt, verdict: "failed", revision: stored.revision, details: merged.details });
        return { passed: false, details: merged.details };
      }
      const completed = await this.deps.checks.completedOf(task.projectId, task.id);
      earlier = completed.checked;
      unchecked = completed.unchecked;
      suites = [
        { label: `the environment's test (version ${merged.version})`, checks: [{ name: "environment test", command: merged.definition.test }], files: [] },
        ...earlier.map((prior) => ({
          label: `earlier task ${prior.taskId}'s checks revision ${prior.revision} (check task ${prior.checkTaskId})`,
          checks: prior.checks,
          files: prior.files,
        })),
        { label: `this task's checks revision ${stored.revision} (check task ${stored.checkTaskId})`, checks: stored.checks, files: stored.files },
      ];
      const checks = suites.reduce((sum, suite) => sum + suite.checks.length, 0);
      const perCheck = this.deps.attemptPolicy.perCommandTimeoutSeconds;
      lease.extend(cellRunBoundMs(Array.from({ length: checks }, () => perCheck)), `the post-merge cell of ${checks} check(s)`);
      runs = await runSuitesOnCheckout(
        this.deps.dispatchCells.checkCells(d),
        POST_MERGE_VERIFIER_ROLE,
        merged.image,
        commit,
        this.deps.dispatchCells.checkoutDir(d, "post-merge-checks"),
        suites,
      );
      // A run that changed the merge's tracked files is no verdict on the merge: unrunnable,
      // carried out typed in the fault's cause, neither a pass nor the task's failure.
      const changed = productChangeOf(task.id, runs);
      if (changed !== null) {
        this.deps.eventSink?.emit({ event: "check_run_product_changed", taskId: task.id, attempt: task.attempt, commit, suite: changed.suite, check: changed.check, paths: changed.paths });
        throw changed;
      }
    } catch (e) {
      if (environmentErrorOf(e) !== null) throw e;
      throw new VerificationInfrastructureFault(task.id, "stored-check run", { cause: e });
    }
    const checkCount = suites.reduce((sum, suite) => sum + suite.checks.length, 0);
    const suitesVerdictRun = suitesVerdict(suites, runs, earlier.length, "merge");
    const suitesRun: PostMergeVerdict =
      merged.kind === "rebuilt"
        ? { passed: suitesVerdictRun.passed, details: `${merged.details}\n${suitesVerdictRun.details}` }
        : suitesVerdictRun;
    // A task completed with no stored check has nothing to re-run: skipping it is stated, never
    // silent, and never a block (no transition could ever give a Completed task checks, so every
    // later merge of the project would block on it with no exit).
    const verdict: PostMergeVerdict =
      unchecked.length === 0
        ? suitesRun
        : {
            passed: suitesRun.passed,
            details: `${suitesRun.details}\nNot re-run, no check is stored for them (completed before checks existed): ${unchecked.join(", ")}`,
          };
    if (unchecked.length > 0) {
      this.deps.logger.info("quality.regression-unchecked", "post-merge regression suite skips Completed task(s) with no stored check", { taskId: task.id, unchecked });
    }
    this.deps.eventSink?.emit({
      event: "post_merge_verify",
      taskId: task.id,
      attempt: task.attempt,
      verdict: verdict.passed ? "passed" : "failed",
      revision: stored.revision,
      regressionTasks: earlier.map((prior) => prior.taskId),
      uncheckedTasks: unchecked,
      boundSeconds: checkCount * this.deps.attemptPolicy.perCommandTimeoutSeconds,
      details: verdict.details,
    });
    // The version this merge produces is the stack the team stated, with inputs a verified merge
    // changed: it carries that statement, so the next dispatch resolves it (current-environment.ts).
    if (verdict.passed && merged.kind === "rebuilt") await this.recordRebuiltStatement(task.id, merged);
    return verdict;
  }

  /**
   * The environment of the tentative merge `commit`: its definition and
   * version read from the merge's committed objects, the version being the digest of the build
   * context (environmentVersion, the same function the image build uses). The same version as the
   * dispatch's: its image. Another one (the work changed an input the recipe reads): its image is
   * built and recorded, and the product's `build` then `test` run on a fresh checkout of the merge
   * in a verifier cell from it, which must pass and leave the checkout clean; the caller then runs
   * the stored checks on that image. A definition the merge leaves unreadable, an image that cannot
   * be built and a failed build or test refuse the merge with what failed, the task's failure. A
   * substrate failure throws.
   */
  private async mergedEnvironment(d: VerifiedDispatch, current: CurrentEnvironment<EnvironmentDefinition>, commit: string, lease: CheckoutLease): Promise<MergedEnvironment> {
    const { task } = d;
    const gitDir = targetRepo(d.targetProjectPath).gitDir;
    const refused = (details: string): MergedEnvironment => ({ kind: "refused", details });
    let definition: EnvironmentDefinition;
    let version: string;
    try {
      definition = await readEnvironmentDefinition(gitDir, commit);
      version = (await environmentVersion(gitDir, commit, definition)).version;
    } catch (e) {
      if (e instanceof EnvironmentDefinitionInvalid || e instanceof EnvironmentVersionUnresolved) {
        return refused(`The merge leaves no environment that can be built (it was version ${current.version}): ${e.message}`);
      }
      throw e;
    }
    if (version === current.version) {
      return { kind: "unchanged", version, image: current.imageId, imageRef: current.imageRef, definition: current.definition };
    }

    const change = `The merge changes the environment's build context (its inputs): version ${current.version} becomes ${version}`;
    const timeoutSeconds = this.deps.attemptPolicy.perCommandTimeoutSeconds;
    lease.extend(ENVIRONMENT_BUILD_TIMEOUT_MS + cellRunBoundMs([timeoutSeconds, timeoutSeconds]), "the merge's environment rebuild and its build and test cell");
    let built: BuiltEnvironment;
    try {
      built = await this.deps.environment.images.build({ projectId: task.projectId, repoGitDir: gitDir, commit, definition });
    } catch (e) {
      if (e instanceof EnvironmentBuildFailed) {
        return refused(
          `${change}, and its image could not be built: ${e.detail}\nBuild log:\n${renderElided(e.log).trim() || "(empty)"}`,
        );
      }
      if (e instanceof EnvironmentVersionUnresolved) return refused(`${change}, and it cannot be built: ${e.message}`);
      throw e;
    }
    if (built.version !== version) {
      throw new VerificationInfrastructureFault(task.id, "rebuild the merge's environment", {
        cause: `version ${version} was resolved at ${commit}, but the image was built for ${built.version}`,
      });
    }
    this.deps.eventSink?.emit({
      event: "environment_rebuilt",
      taskId: task.id,
      attempt: task.attempt,
      from: current.version,
      to: version,
      imageId: built.imageId,
      imageRef: built.imageRef,
      reused: built.reused,
    });
    const commands = await runPostMergeEnvironmentCommands(
      this.deps.dispatchCells.environmentScope(d),
      POST_MERGE_VERIFIER_ROLE,
      { version, imageRef: built.imageRef, definition },
      commit,
      this.deps.attemptPolicy.perCommandTimeoutSeconds,
    );
    const ran = `the product's build and test on the rebuilt environment (version ${version}) on the merge:\n${formatEnvironmentCommands(commands)}`;
    if (!environmentCommandsPassed(commands)) return refused(`${change}, and ${ran}`);
    return {
      kind: "rebuilt",
      version,
      image: built.imageId,
      imageRef: built.imageRef,
      definition,
      statement: current.statement,
      details: `${change}; ${ran}`,
    };
  }
}
