import type { EnvironmentCheckScope } from "@ashara/execution-infra";
import { buildContextPaths } from "@ashara/execution-infra";
import { parseWorkItemId } from "@ashara/shared";
import type { Logger } from "@ashara/shared";
import type { CheckDefinition, CheckDefinitionPort, CheckRedRunPreview, FoundationProbe, TaskCheckRunPort } from "@ashara/workplace";
import { checkPassed, checkRunVerdict, describeProductChange } from "../check-verdict.js";
import type { CheckRunReport } from "../check-verdict.js";
import { cellImageOf } from "../dispatch-result.js";
import type { CheckAuthoring, ExecutionEventSink, VerifiedDispatch } from "../dispatch-result.js";
import { environmentErrorOf, VerificationInfrastructureFault } from "../fault-class.js";
import { checkAreaOf, foundationProbeOf, previewCheckFiles, redRunPreview, runChecksOnCheckout, worktreeSnapshotCommit } from "../task-checks.js";
import type { CompletedTaskChecks, TaskCheckStore, TaskChecks } from "../task-checks.js";
import { RED_RUN_ROLE } from "./dispatch-cells.js";
import type { DispatchCells } from "./dispatch-cells.js";

export interface CheckPortsDeps {
  readonly dispatchCells: Pick<DispatchCells, "environmentScope" | "checkCells" | "checkoutDir">;
  readonly checks: Pick<TaskCheckStore, "holdEvidenceOf">;
  readonly eventSink?: ExecutionEventSink;
  readonly logger: Logger;
}

/** The ports Workplace's tools call during an attempt: build_environment's scope, run_checks, define_check and probe_foundation. */
export class CheckPorts {
  private readonly deps: CheckPortsDeps;

  constructor(deps: CheckPortsDeps) {
    this.deps = deps;
  }

  /** What an environment check of this dispatch reaches: its worktree, its project's images, and cells mounting a tree. */
  environmentScope(d: VerifiedDispatch): EnvironmentCheckScope {
    return this.deps.dispatchCells.environmentScope(d);
  }

  /**
   * run_checks' port: the stored checks, with their stored files written over a throwaway checkout
   * of a snapshot of the implementer's current worktree, run in a fresh CI cell from the dispatch's
   * image. The implementer's worktree itself is never written. A substrate failure throws as it
   * is; a failure of Z0's own machinery (the snapshot commit, the checkout) throws as a
   * VerificationInfrastructureFault. Either ends the attempt as its environment failing, and
   * endWithoutDone names which.
   */
  taskCheckRunPort(d: VerifiedDispatch, stored: TaskChecks, merged: readonly CompletedTaskChecks[]): TaskCheckRunPort {
    const { dispatchCells } = this.deps;
    let runs = 0;
    return {
      checkNames: stored.checks.map((check) => check.name),
      mergedChecks: merged.flatMap((prior) => prior.checks.map((check) => ({ taskId: prior.taskId, name: check.name }))),
      run: async (timeoutSeconds) => {
        runs += 1;
        let report: CheckRunReport;
        try {
          const commit = await worktreeSnapshotCommit(d.repo, d.task.id, "run_checks");
          report = await runChecksOnCheckout(
            { ...dispatchCells.checkCells(d), timeoutSeconds },
            { role: RED_RUN_ROLE, image: cellImageOf(d.environment), commit: commit, dir: dispatchCells.checkoutDir(d, `run-checks-${runs}`) },
            stored.checks,
            stored.files,
          );
        } catch (e) {
          if (environmentErrorOf(e) !== null) throw e;
          throw new VerificationInfrastructureFault(d.task.id, "run_checks", { cause: e });
        }
        this.deps.eventSink?.emit({
          event: "task_checks_run",
          taskId: d.task.id,
          attempt: d.task.attempt,
          run: runs,
          revision: stored.revision,
          ...(report.kind === "ran"
            ? { passed: report.runs.filter(checkPassed).map((run) => run.name) }
            : report.kind === "files_refused"
              ? { refused: report.detail }
              : { productChanged: describeProductChange(report) }),
        });
        return checkRunVerdict(report);
      },
    };
  }

  /**
   * define_check's port: records the definition, the last of a name
   * winning, then red-runs that one check at once by the harvest's own machinery: the files the
   * attempt has changed so far (a snapshot of its throwaway worktree, by the harvest's rules) are
   * written over a fresh checkout of the plan's foundation, and the check
   * runs in a CI cell from the environment image. The author is shown its exit code and output and
   * whether the red run at finish would reject it; that red run still decides, unchanged. A
   * substrate failure throws as it is; a failure of Z0's own machinery throws as a
   * VerificationInfrastructureFault.
   */
  checkDefinitionPort(d: VerifiedDispatch, work: CheckAuthoring): CheckDefinitionPort {
    const { dispatchCells } = this.deps;
    let runs = 0;
    // One command on a fresh checkout of the foundation with the attempt's check files so far over
    // it, by the harvest's own rules: define_check's red run and probe_foundation's look alike.
    const onFoundation = async (
      check: CheckDefinition,
      timeoutSeconds: number,
      purpose: "define-check" | "probe-foundation",
    ): Promise<{ readonly report: CheckRunReport; readonly dir: string; readonly discarded: readonly string[] }> => {
      runs += 1;
      const dir = dispatchCells.checkoutDir(d, `${purpose}-${runs}`);
      try {
        const harvest = await previewCheckFiles({
          repo: d.repo,
          taskId: d.task.id,
          startCommit: work.startCommit,
          buildContext: buildContextPaths(work.environment.definition),
          written: work.recorder.writtenFiles(),
          area: checkAreaOf(work.checkedTaskId),
          logger: this.deps.logger,
        });
        if (harvest.kind === "rejected") return { report: { kind: "files_refused", detail: harvest.reason }, dir, discarded: [] };
        const report = await runChecksOnCheckout(
          { ...dispatchCells.checkCells(d), timeoutSeconds },
          { role: RED_RUN_ROLE, image: work.environment.imageId, commit: work.foundation.commit, dir: dir },
          [check],
          harvest.files,
        );
        return { report, dir, discarded: harvest.discarded };
      } catch (e) {
        if (environmentErrorOf(e) !== null) throw e;
        throw new VerificationInfrastructureFault(d.task.id, purpose === "define-check" ? "define_check red run" : "probe_foundation run", { cause: e });
      }
    };
    return {
      fileWritten: (path) => work.recorder.fileWritten(path),
      probe: async (command, timeoutSeconds): Promise<FoundationProbe> => {
        const { report, dir } = await onFoundation({ name: "probe", command }, timeoutSeconds, "probe-foundation");
        this.deps.eventSink?.emit({
          event: "foundation_probed",
          taskId: d.task.id,
          attempt: d.task.attempt,
          command,
          ...(report.kind === "ran"
            // eslint-disable-next-line no-restricted-syntax -- policy default: event-sink telemetry only, no verdict reads it; a ran report carries its one run
            ? { exitCode: report.runs[0]?.exitCode ?? null, timedOut: report.runs[0]?.timedOut ?? false }
            : { notRun: report.kind }),
        });
        return foundationProbeOf(report, timeoutSeconds, dir);
      },
      define: async (check, timeoutSeconds) => {
        const recording = work.recorder.record(check);
        if (recording.kind === "refused") return recording;
        const { report, dir, discarded } = await onFoundation(check, timeoutSeconds, "define-check");
        const redRun: CheckRedRunPreview = await redRunPreview(report, timeoutSeconds, dir, () =>
          this.deps.checks.holdEvidenceOf(parseWorkItemId(work.checkedTaskId, "CheckAuthoring.checkedTaskId")),
        );
        this.deps.eventSink?.emit({
          event: "check_defined",
          taskId: d.task.id,
          attempt: d.task.attempt,
          name: check.name,
          command: check.command,
          decides: check.decides,
          replaced: recording.replaced,
          defined: recording.defined,
          ...(redRun.kind === "ran"
            ? { exitCode: redRun.run.exitCode, timedOut: redRun.run.timedOut, rejection: redRun.rejection }
            : redRun.kind === "files_refused"
              ? { filesRefused: redRun.detail }
              : { productChanged: redRun.detail }),
          ...(discarded.length > 0 ? { discarded } : {}),
        });
        return { ...recording, redRun, discarded, undecided: work.recorder.undecided() };
      },
    };
  }
}
