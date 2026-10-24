import type { ProjectId } from "@ashara/shared";
import { createDomainEvent } from "@ashara/shared";
import { createPendingWorkItem, giveUpWorkItem } from "./work-item.js";
import type { WorkItem } from "./work-item.js";

// The defect a failed acceptance sweep opens: every
// task of the plan was settled with its goal tasks done, and the environment's test and the checks
// of every completed task did not all pass on main HEAD. That is not acceptance; it is work the
// plan still owes, so it goes where every given-up task goes: the plan is repaired around it
// (the plan_repair_on_abandon trigger). The defect is never dispatched.

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
  /** Where main still holds the product scaffold's placeholder refusal (Quality's sweep found it); null when nowhere. */
  readonly placeholderDefect: PlaceholderDefect | null;
}

/**
 * Main's public interface file fails acceptance: it is byte for byte as a product scaffold wrote
 * it, or main holds none.
 */
export type InterfaceDefect =
  | { readonly kind: "scaffold-placeholder"; readonly file: string; readonly scaffoldTaskId: string; readonly scaffoldCommit: string }
  | { readonly kind: "absent"; readonly file: string };

/**
 * Main still holds the product scaffold's placeholder refusal: the marker every refusal of it carries,
 * and each tracked file and line it is on. An entry that answers with it is not delivered, in any language.
 */
export interface PlaceholderDefect {
  readonly marker: string;
  readonly at: readonly [PlaceholderLine, ...PlaceholderLine[]];
}

interface PlaceholderLine {
  readonly file: string;
  readonly line: number;
}

const SWEEP_PASSES = "every goal task's checks and the environment's test pass together on main";

/** What fixing main's public interface file asks for: the defect's own part of the goal and the end state. */
function interfaceAsk(defect: InterfaceDefect): { goal: string; endState: string; deliverable: string } {
  const deliverable = `${defect.file}, stating the delivered product's public interface`;
  if (defect.kind === "absent") {
    return {
      goal:
        `Restore ${defect.file} so it states how the delivered product is started, configured and called: main holds ` +
        `no ${defect.file}, so it states no public interface at all`,
      endState: `${defect.file} is on main and describes the delivered product`,
      deliverable,
    };
  }
  return {
    goal:
      `Update ${defect.file} so it states how the delivered product is started, configured and called: main still ` +
      `holds it byte for byte as the product scaffold wrote it (task ${defect.scaffoldTaskId}, merged as ` +
      `${defect.scaffoldCommit}), describing a placeholder`,
    endState: `${defect.file} on main differs from the product scaffold's and describes the delivered product`,
    deliverable,
  };
}

function placesOf(defect: PlaceholderDefect): string {
  return defect.at.map((each) => `${each.file}:${each.line}`).join(", ");
}

/** What retiring the scaffold's placeholder asks for: every entry still refused implemented, the marker gone. */
function placeholderAsk(defect: PlaceholderDefect): { goal: string; endState: string; deliverable: string } {
  const places = placesOf(defect);
  return {
    goal:
      `Implement every entry that still answers with the product scaffold's placeholder refusal and remove its ` +
      `marker ${defect.marker}: main still holds it at ${places}, so those entries are not delivered`,
    endState: `no tracked file on main holds ${defect.marker}`,
    deliverable: `every entry refused at ${places}, implemented, with ${defect.marker} removed`,
  };
}

/**
 * What the defect asks for: the sweep passing; when main still holds the scaffold's placeholder
 * refusal, every entry it refuses implemented; and when main's public interface file is the
 * scaffold's placeholder or missing, that file stating the delivered product. No check of a goal
 * task asks for either, so no rerun of one delivers it.
 */
function defectSpec(sweep: FailedAcceptance): { goal: string; endState: string; deliverables: string[] } {
  const asks = [
    ...(sweep.placeholderDefect === null ? [] : [placeholderAsk(sweep.placeholderDefect)]),
    ...(sweep.interfaceDefect === null ? [] : [interfaceAsk(sweep.interfaceDefect)]),
  ];
  if (asks.length === 0) {
    return { goal: "Every goal task's checks and the environment's test pass together on main", endState: "The acceptance run on main passes", deliverables: [] };
  }
  return {
    goal: [...asks.map((ask) => ask.goal), SWEEP_PASSES].join("; and "),
    endState: [...asks.map((ask) => ask.endState), "the acceptance run on main passes"].join(", and "),
    deliverables: asks.map((ask) => ask.deliverable),
  };
}

/**
 * The defect item of a failed sweep, at Pending: the caller writes it, then gives it up with
 * `giveUpAcceptanceDefect` and saves that, in one transaction, so the abandonment is the update the
 * repair trigger reads.
 */
export function openAcceptanceDefect(sweep: FailedAcceptance): WorkItem {
  const spec = defectSpec(sweep);
  const { interfaceDefect, placeholderDefect } = sweep;
  const asked = [
    ...(placeholderDefect === null ? [] : [`retire the scaffold placeholder at ${placesOf(placeholderDefect)}`]),
    ...(interfaceDefect === null ? [] : [`${interfaceDefect.kind === "absent" ? "restore" : "update"} ${interfaceDefect.file}`]),
  ]
    .map((each) => `: ${each}`)
    .join("");
  const defect = createPendingWorkItem({
    level: "Task",
    title: `Acceptance on main ${sweep.mainCommit === null ? "(not read)" : sweep.mainCommit.slice(0, 12)}${asked}`,
    projectId: sweep.projectId,
    description: sweep.mainCommit === null ? "The acceptance run could not read main." : `The acceptance run on main ${sweep.mainCommit} did not pass.`,
    taskSpec: { ...spec, scope: sweep.details, origin: "acceptance" },
  });
  defect.events.push(
    createDomainEvent("work_item.created", "delivery", {
      work_item_id: defect.id,
      level: defect.level,
      origin: "acceptance",
      main_commit: sweep.mainCommit,
      interface_defect: interfaceDefect === null ? null : interfaceDefect.kind,
      placeholder_defect: placeholderDefect === null ? null : placesOf(placeholderDefect),
    }),
  );
  return defect;
}

/** Gives the written defect up with the sweep's evidence: its plan is repaired around it. */
export function giveUpAcceptanceDefect(defect: WorkItem, sweep: Pick<FailedAcceptance, "mainCommit" | "details">): void {
  giveUpWorkItem(defect, { source: "acceptance_failed", mainCommit: sweep.mainCommit, reason: sweep.details });
}
