import type { ProjectId } from "@ashara/shared";
import { createDomainEvent } from "@ashara/shared";
import { createPendingWorkItem, giveUpWorkItem } from "./work-item.js";
import type { WorkItem } from "./work-item.js";

// The defect a failed acceptance sweep opens (story s-independent-verify-m1 W7, design P11): every
// task of the plan was settled with its goal tasks done, and the environment's test and the checks
// of every completed task did not all pass on main HEAD. That is not acceptance; it is work the
// plan still owes, so it goes where every given-up task goes: the plan is repaired around it
// (migration 048's plan_repair_on_abandon). The defect is never dispatched.

/**
 * The failed sweep the defect records: the commit it ran on (null when the sweep faulted before
 * main could be read) and the run, or the fault that stopped it, as recorded.
 */
interface FailedAcceptance {
  readonly projectId: ProjectId;
  readonly mainCommit: string | null;
  readonly details: string;
  /** What is wrong with main's public interface file (Quality's sweep found it); null when that is not why. */
  readonly interfaceDefect: InterfaceDefect | null;
}

/**
 * Main's public interface file fails acceptance: it is byte for byte as a product scaffold wrote
 * it, or main holds none.
 */
export type InterfaceDefect =
  | { readonly kind: "scaffold-placeholder"; readonly file: string; readonly scaffoldTaskId: string; readonly scaffoldCommit: string }
  | { readonly kind: "absent"; readonly file: string };

const SWEEP_PASSES = "every goal task's checks and the environment's test pass together on main";

/**
 * What the defect asks for: the sweep passing, and, when main's public interface file is the
 * scaffold's placeholder or missing, that file stating the delivered product, which no check of a
 * goal task asks for and so no rerun of one delivers.
 */
function defectSpec(sweep: FailedAcceptance): { goal: string; endState: string; deliverables: string[] } {
  const defect = sweep.interfaceDefect;
  if (defect === null) {
    return { goal: "Every goal task's checks and the environment's test pass together on main", endState: "The acceptance run on main passes", deliverables: [] };
  }
  const deliverables = [`${defect.file}, stating the delivered product's public interface`];
  if (defect.kind === "absent") {
    return {
      goal:
        `Restore ${defect.file} so it states how the delivered product is started, configured and called: main holds ` +
        `no ${defect.file}, so it states no public interface at all; and ${SWEEP_PASSES}`,
      endState: `${defect.file} is on main and describes the delivered product, and the acceptance run on main passes`,
      deliverables,
    };
  }
  return {
    goal:
      `Update ${defect.file} so it states how the delivered product is started, configured and called: main still ` +
      `holds it byte for byte as the product scaffold wrote it (task ${defect.scaffoldTaskId}, merged as ` +
      `${defect.scaffoldCommit}), describing a placeholder; and ${SWEEP_PASSES}`,
    endState: `${defect.file} on main differs from the product scaffold's and describes the delivered product, and the acceptance run on main passes`,
    deliverables,
  };
}

/**
 * The defect item of a failed sweep, at Pending: the caller writes it, then gives it up with
 * `giveUpAcceptanceDefect` and saves that, in one transaction, so the abandonment is the update the
 * repair trigger reads.
 */
export function openAcceptanceDefect(sweep: FailedAcceptance): WorkItem {
  const spec = defectSpec(sweep);
  const interfaceDefect = sweep.interfaceDefect;
  const asked = interfaceDefect === null ? "" : `: ${interfaceDefect.kind === "absent" ? "restore" : "update"} ${interfaceDefect.file}`;
  const defect = createPendingWorkItem(
    "Task",
    `Acceptance on main ${sweep.mainCommit === null ? "(not read)" : sweep.mainCommit.slice(0, 12)}${asked}`,
    sweep.projectId,
    undefined,
    sweep.mainCommit === null ? "The acceptance run could not read main." : `The acceptance run on main ${sweep.mainCommit} did not pass.`,
    { ...spec, scope: sweep.details, origin: "acceptance" },
  );
  defect.events.push(
    createDomainEvent("work_item.created", "delivery", {
      work_item_id: defect.id,
      level: defect.level,
      origin: "acceptance",
      main_commit: sweep.mainCommit,
      interface_defect: interfaceDefect === null ? null : interfaceDefect.kind,
    }),
  );
  return defect;
}

/** Gives the written defect up with the sweep's evidence: its plan is repaired around it. */
export function giveUpAcceptanceDefect(defect: WorkItem, sweep: Pick<FailedAcceptance, "mainCommit" | "details">): void {
  giveUpWorkItem(defect, { source: "acceptance_failed", mainCommit: sweep.mainCommit, reason: sweep.details });
}
