import { z } from "zod";
import type { Tape } from "./tape.js";

/**
 * The client's product as the simulator models it (design §4.4, in today's in-repository layout:
 * the recipe under `environment/`, check files written over the checkout). A delivered behaviour
 * is one file; a regression deletes it. Distinct files never conflict in git, so merges stay real.
 */
const BEHAVIOUR_DIR = "product/behaviours";
export const LAYOUT_FILE = "product/LAYOUT";
export const MANIFEST_FILE = "product/MANIFEST";

export function behaviourPath(behaviour: string): string {
  return `${BEHAVIOUR_DIR}/${behaviour}`;
}

/** One planned implementation task of the scripted plan: its marker ref and the behaviours it delivers. */
export interface SimTask {
  readonly ref: string;
  readonly behaviours: readonly string[];
}

/** The universe of one seed: the behaviours the tender asks for, one outside it, and the plan over them. */
export interface Universe {
  readonly behaviours: readonly string[];
  readonly outOfVision: string;
  readonly tasks: readonly SimTask[];
  /**
   * The plan's tasks depend on none of each other, so two implementations can run in one batch and
   * finalize together (the checkout lock's race); otherwise each depends on the one before.
   */
  readonly independent: boolean;
}

/** How often a seed's plan has independent tasks. */
const INDEPENDENT_PLAN_RATE = 0.5;

/** 2-4 behaviours, one scope item each (S1.. as the scripted intake numbers them), cut into 1-3 vertical tasks, in order or independent. */
export function drawUniverse(tape: Tape): Universe {
  const count = 2 + tape.pick("universe.extra-behaviours", 3);
  const behaviours = Array.from({ length: count }, (_, i) => `b${i + 1}`);
  const taskCount = 1 + tape.pick("universe.extra-tasks", Math.min(count, 3));
  const tasks: SimTask[] = [];
  for (let t = 0; t < taskCount; t++) {
    const mine = behaviours.filter((_, i) => i % taskCount === t);
    tasks.push({ ref: `t${t + 1}`, behaviours: mine });
  }
  return { behaviours, outOfVision: "x1", tasks, independent: tape.chance("universe.independent-tasks", INDEPENDENT_PLAN_RATE) };
}

const TASK_MARKER = /\[sim (t\d+)\]/;

/** The title the scripted planner gives a task; its marker survives into the check task's title. */
export function taskTitle(task: SimTask): string {
  return `Deliver ${task.behaviours.join(", ")} [sim ${task.ref}]`;
}

export function taskOfTitle(universe: Universe, title: string): SimTask | null {
  const ref = TASK_MARKER.exec(title)?.[1];
  return universe.tasks.find((task) => task.ref === ref) ?? null;
}

const CHECK_KINDS = ["correct", "wrong", "contradictory", "vacuous", "flaky", "out_of_vision", "unrunnable", "slow"] as const;

/**
 * A check as the scripted check author writes it, in a file of the check set. `sim check <file>`
 * passes iff every required behaviour exists and no forbidden one does, modified by `kind`.
 */
export const CheckSpecSchema = z.strictObject({
  kind: z.enum(CHECK_KINDS),
  requires: z.array(z.string()),
  forbids: z.array(z.string()),
  /** Files the check copies into the workspace before it runs (a product-side harness, design §2.10). */
  harness: z.array(z.strictObject({ path: z.string().min(1), content: z.string() })),
});

export type CheckSpec = z.infer<typeof CheckSpecSchema>;

/** A command's outcome in a fake cell. `hung` is a command the host backstop had to kill. */
export interface SimOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly hung: boolean;
}

export function exited(exitCode: number, stdout: string, stderr = ""): SimOutcome {
  return { exitCode, stdout, stderr, hung: false };
}

export const HUNG: SimOutcome = { exitCode: 124, stdout: "", stderr: "", hung: true };

/** The recipe tokens a Containerfile declares, one `# sim: <token>` line each. */
export function recipeTokens(containerfile: string): string[] {
  return containerfile
    .split("\n")
    .map((line) => /^#\s*sim:\s*(\S+)\s*$/.exec(line.trim())?.[1])
    .filter((token): token is string => token !== undefined);
}

/** The token whose presence breaks every build as the cell's user (run 6 G2). */
export const RECIPE_DEFECT_TOKEN = "cache-dir-owner=root";
/** What a build or test under that defect prints (run 6). */
export const RECIPE_DEFECT_SYMPTOM = "the cache dir is owned by root";
export const TOOLCHAIN_TOKEN = "toolchain";
