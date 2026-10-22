import { z } from "zod";
import type { Tape } from "./tape.js";

/**
 * The client's product as the simulator models it (in today's in-repository layout:
 * the recipe under `environment/`, check files written over the checkout). A delivered behaviour
 * is one file; a regression deletes it. Behaviour files are distinct, so they never conflict in
 * git; the shared index is one file every implementation may append its line to, so two tasks of
 * one batch that both write it conflict on the second merge.
 */
const BEHAVIOUR_DIR = "product/behaviours";
export const LAYOUT_FILE = "product/LAYOUT";
export const MANIFEST_FILE = "product/MANIFEST";
export const SHARED_INDEX_FILE = "product/INDEX";
/** The scaffold's placeholder, whose refusal carries the marker its brief names; implementations remove it. */
export const PLACEHOLDER_FILE = "product/PLACEHOLDER";
/**
 * The marker the scaffold's brief asks every placeholder refusal to carry, as the simulator knows it
 * (never read from Quality, as for the public interface path).
 */
export const PLACEHOLDER_MARKER = "ashara-scaffold-refusal-7c41e09d";
/**
 * Where the scaffold's brief asks the product's public interface to be written, as the simulator
 * knows it (never read from Quality: the oracle states what it expects on its own).
 */
export const PUBLIC_INTERFACE_PATH = "PUBLIC_INTERFACE.md";

/** The two forms of public interface file a scripted scaffold may write (it may also write none). */
export type InterfaceForm = "short" | "oversized";

/**
 * The public interface file a scripted scaffold writes: a short one, none, or one longer than any
 * report quotes whole. The text carries blank lines and a fence, as a real one may.
 */
export function publicInterfaceText(form: InterfaceForm): string {
  const usage = "Run: sim <behaviour>\n\nEach behaviour prints its name:\n```\nsim b1\n```\n";
  if (form === "short") return usage;
  const notes = Array.from({ length: 400 }, (_, i) => `- behaviour note ${i + 1}: unchanged by every task\n`).join("");
  return `${usage}${notes}End of interface.\n`;
}

/**
 * The file an implementer leaves once it has updated the scaffold's: the same form, so a delivered
 * report still quotes a long one cut, and the same text whichever task writes it, so two tasks of
 * one batch that both update it never conflict. It is written whole rather than edited from the
 * scaffold's, whose usage text and notes it does not contain: acceptance refuses only a file
 * byte-identical to the scaffold's, so an honest stand-in that kept the placeholder and added one
 * line would pass on exactly that loophole. Like the scaffold's, it carries blank lines and a fence.
 */
export function deliveredInterfaceText(form: InterfaceForm): string {
  const usage =
    "To use the delivered product, run: sim <behaviour>\n\nA delivered behaviour, run, prints its own " +
    "name:\n```console\n$ sim b1\nb1\n```\n";
  if (form === "short") return usage;
  return (
    `${usage}${Array.from({ length: 400 }, (_, i) => `- delivered behaviour reference ${i + 1}\n`).join("")}End ` +
    `of the delivered interface.\n`
  );
}

/**
 * Whether `text` is a scripted scaffold's public interface file byte for byte: the placeholder's, not the delivered
 * product's.
 */
export function isScaffoldInterface(text: string): boolean {
  return text === publicInterfaceText("short") || text === publicInterfaceText("oversized");
}

/** The marker ref of the task a repair plans to update the public interface file (never a universe task's). */
export const INTERFACE_TASK_REF = "iface";
/** git's conflict marker lines, as `sim resolve` removes them: both sides' lines are kept. */
export const CONFLICT_MARKER_LINE = /^(<{7}|={7}|>{7})( |$)/;

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
  /**
   * The first project's tender is drafted with every guarantee observed in stored data, so Ashara can
   * verify none: its contract is declined at proposal, the client's plain confirmation leaves it so,
   * and its restatement releases the work.
   */
  readonly unverifiable: boolean;
}

/** How often a seed's plan has independent tasks. */
const INDEPENDENT_PLAN_RATE = 0.5;
/** How often a seed's first tender is one whose contract Ashara can verify no guarantee of. */
const UNVERIFIABLE_TENDER_RATE = 0.1;

/**
 * 2-4 behaviours, one guarantee each (keyed by its place, as the scripted intake drafts them), cut into 1-3 vertical
 * tasks, in order or independent.
 */
export function drawUniverse(tape: Tape): Universe {
  const count = 2 + tape.pick("universe.extra-behaviours", 3);
  const behaviours = Array.from({ length: count }, (_, i) => `b${i + 1}`);
  const taskCount = 1 + tape.pick("universe.extra-tasks", Math.min(count, 3));
  const tasks: SimTask[] = [];
  for (let t = 0; t < taskCount; t++) {
    const mine = behaviours.filter((_, i) => i % taskCount === t);
    tasks.push({ ref: `t${t + 1}`, behaviours: mine });
  }
  return {
    behaviours,
    outOfVision: "x1",
    tasks,
    independent: tape.chance("universe.independent-tasks", INDEPENDENT_PLAN_RATE),
    unverifiable: tape.chance("universe.unverifiable-tender", UNVERIFIABLE_TENDER_RATE),
  };
}

const TASK_MARKER = /\[sim (t\d+|iface)\]/;

/** The title the scripted planner gives a task; its marker survives into the check task's title. */
export function taskTitle(task: SimTask): string {
  return `Deliver ${task.behaviours.join(", ")} [sim ${task.ref}]`;
}

export function taskOfTitle(universe: Universe, title: string): SimTask | null {
  const ref = TASK_MARKER.exec(title)?.[1];
  return universe.tasks.find((task) => task.ref === ref) ?? null;
}

/** The title a repair's planner gives the task that updates the public interface file. */
export const INTERFACE_TASK_TITLE =
  `Update ${PUBLIC_INTERFACE_PATH} to describe the delivered product ` + `[sim ${INTERFACE_TASK_REF}]`;

/** Whether `title` is that task's, or a check task's for it. */
export function isInterfaceTaskTitle(title: string): boolean {
  return TASK_MARKER.exec(title)?.[1] === INTERFACE_TASK_REF;
}

/**
 * `interface`: passes iff the public interface file exists and is not a scripted scaffold's, the
 * check of the task a repair plans to update it.
 */
const CHECK_KINDS = [
  "correct",
  "wrong",
  "contradictory",
  "vacuous",
  "flaky",
  "out_of_vision",
  "unrunnable",
  "slow",
  "interface",
] as const;

/**
 * A check as the scripted check author writes it, in a file of the check set. `sim check <file>`
 * passes iff every required behaviour exists and no forbidden one does, modified by `kind`.
 */
export const CheckSpecSchema = z.strictObject({
  kind: z.enum(CHECK_KINDS),
  requires: z.array(z.string()),
  forbids: z.array(z.string()),
  /** Files the check copies into the workspace before it runs (a product-side harness). */
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

/** The token whose presence breaks every build as the cell's user. */
export const RECIPE_DEFECT_TOKEN = "cache-dir-owner=root";
/** What a build or test under that defect prints. */
export const RECIPE_DEFECT_SYMPTOM = "the cache dir is owned by root";
export const TOOLCHAIN_TOKEN = "toolchain";
/** What a suite review's misread rejection of a correct check says, so the oracle finds it if it is ever acted on. */
export const MISREAD_REJECTION_MARKER = "misread-rejection";
