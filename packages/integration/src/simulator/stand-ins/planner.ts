import { INTERFACE_TASK_REF, INTERFACE_TASK_TITLE, PUBLIC_INTERFACE_PATH, taskTitle } from "../product.js";
import type { StandInContext } from "./context.js";
import { namesBehaviour } from "./context.js";
import {
  CORRECTION_REVISION,
  MISSING_INTERFACE_EVIDENCE,
  PLACEHOLDER_INTERFACE_EVIDENCE,
  guaranteesListed,
  itemsToCheck,
  listsDoneTask,
} from "./recognised-wording.js";
import { StandInUnanswerable } from "./responses.js";

type ScriptedLine = { readonly text: string; readonly sources: readonly string[] };

type ScriptedTask = Record<string, unknown> & { readonly acceptance: readonly ScriptedLine[] };

interface ScriptedPlan {
  readonly tasks: readonly ScriptedTask[];
}

/**
 * The id of the guarantee the planner's prompt lists for behaviour `b`, as an honest planner reads
 * the vision: the guarantee whose line names it. A prompt that lists none is unanswerable.
 */
function guaranteeOf(prompt: string, b: string): string {
  const found = guaranteesListed(prompt).find((guarantee) => namesBehaviour(guarantee.line, b));
  if (found === undefined)
    throw new StandInUnanswerable("decomposition.tasks", `the planner's prompt lists no guarantee naming ${b}`);
  return found.id;
}

/** The repair task that writes the public interface file, citing the first guarantee the planner's prompt lists. */
function interfaceTaskCiting(prompt: string): ScriptedTask {
  const first = guaranteesListed(prompt)[0];
  if (first === undefined)
    throw new StandInUnanswerable("decomposition.tasks", "the planner's prompt lists no guarantee");
  return {
    ref: INTERFACE_TASK_REF,
    title: INTERFACE_TASK_TITLE,
    description: `Updates ${PUBLIC_INTERFACE_PATH} to describe the delivered product.`,
    dependsOn: [],
    goal: `${PUBLIC_INTERFACE_PATH} describes the delivered product`,
    endState: `${PUBLIC_INTERFACE_PATH} is no longer the scaffold's.`,
    scope: `${PUBLIC_INTERFACE_PATH} only.`,
    deliverables: [{ text: `${PUBLIC_INTERFACE_PATH} describes the product.`, sources: [first.id] }],
    acceptance: [{ text: `A user reads how to run the product in ${PUBLIC_INTERFACE_PATH}.`, sources: [first.id] }],
    capability: "Medium",
    capabilityReason: "One file.",
  };
}

/**
 * `tasks` as an honest planner cites what `toCheck` lists: each line cites only the items its own text
 * tests, so an item no line cites yet gets a line of its own on the first task, stating it.
 */
function citingPerLine<T extends { readonly acceptance: readonly ScriptedLine[] }>(
  tasks: readonly T[],
  toCheck: readonly string[],
): T[] {
  const cited = new Set(tasks.flatMap((task) => task.acceptance.flatMap((line) => line.sources)));
  const lines = toCheck
    .filter((id) => !cited.has(id))
    .map((id) => ({ text: `A user sees what ${id} states hold.`, sources: [id] }));
  return tasks.map((task, i) =>
    i > 0 || lines.length === 0 ? task : { ...task, acceptance: [...task.acceptance, ...lines] },
  );
}

/**
 * `plan` as an honest planner answers `prompt`: every item the prompt says a task must cite
 * that no line cites yet gets an acceptance line of its own that cites it alone.
 *
 * @testseam the integration planning tests' scripted planners answer through it, reading the prompt as the simulator's
 * planner does
 */
export function citingItemsToCheck(plan: ScriptedPlan, prompt: string): ScriptedPlan {
  return { tasks: citingPerLine(plan.tasks, itemsToCheck(prompt)) };
}

/** Delivery's planner, first plan and revision alike, as the stand-in answers it. */
export class PlannerStandIn {
  /** Plans answered so far: the oscillating planner reverses every other one. */
  private plans = 0;

  constructor(private readonly context: StandInContext) {}

  /**
   * The universe's tasks; a repair whose evidence says acceptance refused main's public interface
   * file as the scaffold's, or as missing, also plans a task to write it, which no universe task's
   * checks ask for.
   */
  plan(prompt: string): unknown {
    const { universe } = this.context;
    const toCheck = itemsToCheck(prompt);
    const interfaceTask =
      prompt.includes(PLACEHOLDER_INTERFACE_EVIDENCE) || prompt.includes(MISSING_INTERFACE_EVIDENCE)
        ? [interfaceTaskCiting(prompt)]
        : [];
    // Answering that evidence, it plans only what is still to do: a done task planned again could
    // never have a check fail on its foundation.
    // A correction's revision lists only the guarantees it plans again: it plans only the tasks naming them.
    const listed = guaranteesListed(prompt);
    const corrected = prompt.includes(CORRECTION_REVISION)
      ? universe.tasks.filter((task) => task.behaviours.every((b) => listed.some((g) => namesBehaviour(g.line, b))))
      : universe.tasks;
    const todo =
      interfaceTask.length === 0 ? corrected : corrected.filter((task) => !listsDoneTask(prompt, taskTitle(task)));
    const planned = this.reverses() ? [...todo].reverse() : todo;
    return {
      tasks: citingPerLine(
        [
          ...planned.map((task, i) => ({
            ref: task.ref,
            title: taskTitle(task),
            description: `Delivers ${task.behaviours.join(", ")}.`,
            dependsOn: i === 0 || universe.independent ? [] : [planned[i - 1]?.ref ?? task.ref],
            goal: `Deliver ${task.behaviours.join(", ")}`,
            endState: `${task.behaviours.join(", ")} can be used end to end.`,
            scope: `The ${task.behaviours.join(", ")} part of the product.`,
            deliverables: task.behaviours.map((b) => ({ text: `${b} works.`, sources: [guaranteeOf(prompt, b)] })),
            acceptance: task.behaviours.map((b) => ({ text: `A user sees ${b}.`, sources: [guaranteeOf(prompt, b)] })),
            capability: "Medium",
            capabilityReason: "One small behaviour.",
          })),
          ...interfaceTask,
        ],
        toCheck,
      ),
    };
  }

  /** Whether the oscillating planner reverses this plan: every other plan it answers, when its persona fires. */
  private reverses(): boolean {
    const { personas, onModelCall } = this.context;
    if (personas.of("planner") !== "oscillating") return false;
    this.plans += 1;
    if (this.plans % 2 === 1 || !personas.fires("planner")) return false;
    onModelCall({ site: "decomposition.tasks", action: "persona oscillating: the plan reversed" });
    return true;
  }
}
