import {
  LAYOUT_FILE,
  MANIFEST_FILE,
  PUBLIC_INTERFACE_PATH,
  SHARED_INDEX_FILE,
  behaviourPath,
  deliveredInterfaceText,
  publicInterfaceText,
  taskOfTitle,
} from "../product.js";
import type { InterfaceForm, SimTask } from "../product.js";
import type { StandInContext, TaskRow } from "./context.js";
import { latestChecks, specsOf } from "./context.js";
import { StandInUnanswerable } from "./responses.js";
import { finished } from "./tool-steps.js";
import type { ToolStep } from "./tool-steps.js";

/** The developer's turns, scaffold, public interface repair and implementation alike, as the stand-in scripts them. */
export class ImplementerStandIn {
  /**
   * The form of public interface file each project's latest scripted scaffold wrote (null: none),
   * so an implementer updating it keeps its form. The latest is the one merged: a scaffold attempt
   * that merged is followed by no other.
   */
  private readonly interfaceForms = new Map<string, InterfaceForm | null>();

  constructor(private readonly context: StandInContext) {}

  /** The product scaffold's turns: the layout and the public interface file. */
  scaffoldWork(projectId: string): ToolStep[] {
    return [
      ["write_file", { path: LAYOUT_FILE, content: "behaviours/\n" }],
      ...this.publicInterfaceWork(projectId),
      finished("Set up the product layout."),
    ];
  }

  /** The repair task's turns: the public interface file rewritten to describe the delivered product. */
  interfaceTaskWork(projectId: string): ToolStep[] {
    const form = this.interfaceForms.get(projectId) ?? "short";
    return [
      ["write_file", { path: PUBLIC_INTERFACE_PATH, content: deliveredInterfaceText(form) }],
      finished(`Updated ${PUBLIC_INTERFACE_PATH}.`),
    ];
  }

  /**
   * An implementation's turns. Handed a conflict with main (`conflicted`, the files its brief
   * names), it first resolves each by keeping both sides (`sim resolve`), or leaves one's markers
   * in, and never writes a conflicted file over its resolution afterwards.
   */
  async implementationWork(
    task: TaskRow,
    tools: ReadonlySet<string>,
    conflicted: readonly string[],
  ): Promise<ToolStep[]> {
    const { tape, rates, universe } = this.context;
    const mine = taskOfTitle(universe, task.title);
    if (mine === null)
      throw new StandInUnanswerable(
        "agent-runner",
        `implementation ${task.id} "${task.title}" carries no simulator marker`,
      );
    const index = universe.tasks.indexOf(mine);
    const steps: ToolStep[] = [];
    for (const file of conflicted) {
      const leaves = tape.chance("agent.conflict.markers-left", rates.conflictMarkersLeft, "implementation");
      this.context.onModelCall({
        site: "agent-runner",
        action: `handed a conflict in ${file}: ${leaves ? "leaves its markers" : "resolves it"}`,
      });
      if (!leaves) steps.push(["run_command", { command: `sim resolve ${file}` }]);
    }
    let behaviours = [...mine.behaviours];
    const underDelivers =
      behaviours.length > 0 && tape.chance("agent.under-delivery", rates.underDelivery, "implementation");
    if (underDelivers) behaviours = behaviours.slice(0, -1);
    const later: SimTask[] = universe.tasks.slice(index + 1);
    if (later.length > 0 && tape.chance("agent.over-delivery", rates.overDelivery, "implementation")) {
      /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a later task with no
         behaviours adds none; no oracle reads it */
      behaviours.push(...(later[0]?.behaviours ?? []));
    }
    for (const b of behaviours) steps.push(["write_file", { path: behaviourPath(b), content: `${b}\n` }]);
    const earlier = universe.tasks.slice(0, index).flatMap((t) => t.behaviours);
    const victim = earlier[0];
    if (victim !== undefined && tape.chance("agent.regression", rates.regression, "implementation")) {
      steps.push(["run_command", { command: `sim rm ${behaviourPath(victim)}` }]);
    }
    if (!conflicted.includes(PUBLIC_INTERFACE_PATH)) steps.push(...this.interfaceUpdate(task.projectId));
    if (
      tape.chance("agent.manifest", rates.overDelivery / 3, "implementation") &&
      !conflicted.includes(MANIFEST_FILE)
    ) {
      steps.push(["write_file", { path: MANIFEST_FILE, content: `${mine.ref}\n` }]);
    }
    // One file two tasks of a batch both write, so the second merge conflicts.
    if (
      tape.chance("agent.shared-file", rates.sharedFileEdit, "implementation") &&
      !conflicted.includes(SHARED_INDEX_FILE)
    ) {
      steps.push(["write_file", { path: SHARED_INDEX_FILE, content: `${mine.ref}: ${behaviours.join(", ")}\n` }]);
    }
    if (tools.has("dispute_check")) {
      const dispute = await this.disputeOf(task, underDelivers);
      if (dispute !== null) {
        steps.push(["run_checks", {}]);
        steps.push(["dispute_check", dispute]);
        return steps;
      }
    }
    steps.push(finished(`Delivered ${behaviours.join(", ")}.`));
    return steps;
  }

  /** The scaffold's public interface file: written as briefed, left out, or longer than any report quotes whole. */
  private publicInterfaceWork(projectId: string): ToolStep[] {
    const pick = this.context.tape.pick("agent.scaffold.public-interface", 3, "scaffold");
    const form: InterfaceForm | null = pick === 1 ? null : pick === 0 ? "short" : "oversized";
    this.interfaceForms.set(projectId, form);
    if (form === null) return [];
    return [["write_file", { path: PUBLIC_INTERFACE_PATH, content: publicInterfaceText(form) }]];
  }

  /**
   * An implementation updates the scaffold's public interface file, as its charter asks, unless it
   * leaves it stale (the profile's rate); with no file from the scaffold there is none to update.
   */
  private interfaceUpdate(projectId: string): ToolStep[] {
    const form = this.interfaceForms.get(projectId) ?? null;
    if (form === null) return [];
    if (this.context.tape.chance("agent.interface-left-stale", this.context.rates.interfaceLeftStale, "implementation"))
      return [];
    return [["write_file", { path: PUBLIC_INTERFACE_PATH, content: deliveredInterfaceText(form) }]];
  }

  /** A dispute of one of the task's own stored checks: right when the check is bad, wrong otherwise. */
  private async disputeOf(task: TaskRow, underDelivered: boolean): Promise<{ name: string; reason: string } | null> {
    const { tape, rates } = this.context;
    const own = (await latestChecks(this.context, task.projectId)).filter((row) => row.taskId === task.id);
    for (const row of own) {
      for (const spec of specsOf(row.files)) {
        const bad =
          spec.kind === "wrong" ||
          spec.kind === "contradictory" ||
          spec.kind === "out_of_vision" ||
          spec.kind === "unrunnable" ||
          spec.kind === "slow";
        if (bad && tape.chance("agent.dispute.right", rates.disputeRight, "implementation")) {
          const why =
            spec.kind === "out_of_vision"
              ? "asks for behaviour the vision does not name"
              : "cannot pass on correct work";
          return { name: row.name, reason: `The check ${why}.` };
        }
        if (!bad && underDelivered && tape.chance("agent.dispute.wrong", rates.disputeWrong, "implementation")) {
          return { name: row.name, reason: "The check is too strict." };
        }
      }
    }
    return null;
  }
}
