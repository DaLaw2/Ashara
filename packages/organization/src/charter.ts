import { CHECK_MISSING_EXIT, CHECK_RUNNER, CHECK_VERDICT, environmentDefinitionRules } from "./acl/workplace-acl.js";
import type { WorkKind } from "./work-kind.js";

/**
 * A role's charter as an attempt states it: who the agent is, and the duties its role carries
 * beyond the task itself (null when it carries none). An attempt's grant carries the charter of the
 * role that owns its task's kind of work, and Delivery hands it to Workplace with the assignment.
 */
export interface RoleCharter {
  readonly identity: string;
  readonly duties: string | null;
}

const CODING_AGENT = "You are a coding agent.";

/**
 * Environment work writes the recipe of the image every task works in; it names no stack: choosing
 * one is the work. The definition's schema and rules are stated in Workplace's environment-rules.ts; Quality enforces them.
 * The finish statement is the statement of that choice, which Z0 keeps on the task.
 */
const ENVIRONMENT_DUTIES = [
  [
    `# Defining the environment`,
    `You write the recipe of the environment every later task of this project works in, and nothing else. The product`,
    `owns its layout, its manifests, its source and its tests: do not write any of them, not even a placeholder.`,
    `- Use build_environment to build the image from your recipe and run its probe. Call it again after each change;`,
    `  finish with status "done" only after it reports PASSED on the files as they are.`,
    `- The product does not exist yet, and its build and test commands are not run now: the product's first task sets`,
    `  up its layout so that they pass. State them as that product will be built and tested from the repository root.`,
    `- Finish with a statement: one paragraph on the stack you chose and why, and how the product is built and tested`,
    `  with it. The client reads it; it lists no files. The probe only proves the toolchain is present; product`,
    `  behaviour is verified by the check author's checks.`,
  ].join("\n"),
  environmentDefinitionRules(),
].join("\n\n");

/**
 * Check work writes the checks that decide another task, before that task starts. Nothing of it is
 * merged: Z0 keeps the checks and their files, and puts them back in place whenever they run.
 */
const CHECK_DUTIES = [
  `# Writing checks`,
  `You write the checks that decide whether another task is done. Your checks are judged against the plan's`,
  `foundation: the project as it stood before any task of the plan did its work. Your workspace shows the project as`,
  `it is now, which may already hold some of that task's behaviour, delivered by other work.`,
  `- Define each check with define_check: a name, a shell command and the ids of the cited vision items it decides.`,
  `  Every item the task cites must be decided by at least one check, or the checks are not kept. ${CHECK_RUNNER}`,
  `  A check passes when its command exits 0 and prints output, and fails otherwise. ${CHECK_VERDICT}`,
  `- Test the task's acceptance lines, listed in the Goal below, each against the vision items it cites: a check states`,
  `  observable behaviour an acceptance line asks for, as its cited items say it, never how it is built. Check nothing`,
  `  that no cited item asks for: no intermediate output, no format, no file and no message they do not ask for. Before`,
  `  any work starts, a reviewer reads every check of the plan together with each task's cited items and the public`,
  `  interface, and sends back any check outside its task's cited items or contradicting another.`,
  `- For each cited item, check what it says the product accepts and what it says the product must reject. For every`,
  `  input the task must reject (malformed, out of range, in another form than the item states), write a check that`,
  `  gives that input and requires it to be refused.`,
  `- An assumption marked internal design is how the team builds the product, not something the client asked for:`,
  `  never test it, except as the public interface names it (a command, a file the client reads), in its one form.`,
  `- Name the files and entry points the project already has (its file tree is in the Project Context Map below),`,
  `  or the ones the task names; do not invent other names for them.`,
  `- At least one check must FAIL on the foundation by exiting ${CHECK_MISSING_EXIT}, for the reason the task's work is missing there; a check that`,
  `  passes on the foundation is kept as a guard of behaviour that already holds. Write each check for the task's`,
  `  behaviour as its acceptance lines and their cited items state it, never stronger to make it fail: a check that demands more`,
  `  than the task asks for makes the task's developer build more than the task. A check that times out, whose`,
  `  command cannot be found or run, or that fails on the foundation with any exit other than ${CHECK_MISSING_EXIT}, is rejected:`,
  `  it did not reach its verdict there. One that fails only on a syntax error or a missing file of its own can never`,
  `  pass: it is worse than none.`,
  `- If the task's behaviour already holds in the project as it is now, still write its checks honestly: they are`,
  `  judged on the foundation, and the task is then closed as already delivered when they pass on the project.`,
  `- define_check red-runs the check at once on the foundation, with your files so far written over it, and shows`,
  `  you its exit code and output. Read them. To fix a check, define it again under the same name: the last`,
  `  definition of a name is the one kept.`,
  `- Every check you define is kept as an acceptance check of the task. To look at the foundation (what exists`,
  `  there, how the product starts or refuses), run the command with probe_foundation, which records nothing; never`,
  `  define a check only to look around.`,
  `- Write every file your checks need (test files, fixtures, scripts) in your checks directory, which the Context`,
  `  below names, with write_file or edit_file: only those are kept with the checks and written over the project`,
  `  whenever they run. A file you write anywhere else, the product's source included, is discarded: it is never`,
  `  kept and never placed on the foundation, so a check cannot test a product you wrote. Nothing of this workspace`,
  `  is merged into the project. Check files are kept as text, without their permissions: run a script through its`,
  `  interpreter rather than directly.`,
  `- A check must not change any file the project tracks when it runs: a check run that leaves one changed reaches`,
  `  no verdict, and the check is rejected. Write what a check produces under your checks directory or a temporary`,
  `  directory.`,
  `- Do not change the project environment's own files.`,
  `- The checks already stored for other tasks of this project, with their files, are in the Context below. Every`,
  `  check of the project runs on the same product once all its tasks are merged, so yours must not contradict`,
  `  them: where they fix an output, its format, a file or a name, require the same; do not fix it differently.`,
  `- When the checks state the task's behaviour and the ones that fail on the foundation fail for the right reason,`,
  `  finish with status "done": they are all red-run on the foundation again then.`,
].join("\n");

/** The conventions of the workplace a charter names, which their owners supply: Organization fixes none of them. */
export interface CharterConventions {
  /** The file at the repository root that states the product's public interface. */
  readonly publicInterfaceFile: string;
}

/**
 * Implementation work changes the product, so it keeps the written public interface true: every
 * check author tests through that file, and the client is told it as how to run what was delivered.
 */
function implementationDuties(conventions: CharterConventions): string {
  const file = conventions.publicInterfaceFile;
  return [
    `# Keeping the public interface true`,
    `${file} at the repository root states the product's public interface: how it is started and configured, and each`,
    `way it is called, with what each gives back and the error each gives for input it refuses. Every check author tests`,
    `the product through it, and the client is given it as how to run the delivered product.`,
    `- Read it before you change the product.`,
    `- When your change makes it no longer true of the product as your change leaves it (an entry it says the product`,
    `  refuses or does not do yet that your work now does, an entry you add, change or remove, a change to how the`,
    `  product is started or configured), update ${file} in the same change, so it states the product as it then is.`,
    `- Change the interface itself only as your task asks: what you write in ${file} describes the product, never a`,
    `  wish for it.`,
    `- A product is not accepted while ${file} is still the one the product's scaffold wrote.`,
  ].join("\n");
}

/** The charter of the role that owns this kind of work, naming the conventions it is held to. */
export function charterOf(workKind: WorkKind, conventions: CharterConventions): RoleCharter {
  switch (workKind) {
    case "environment":
      return { identity: CODING_AGENT, duties: ENVIRONMENT_DUTIES };
    case "implementation":
      return { identity: CODING_AGENT, duties: implementationDuties(conventions) };
    case "check":
      return { identity: CODING_AGENT, duties: CHECK_DUTIES };
  }
}

/** A task with no recorded kind of work is worked by a coding agent whose role carries no further duties. */
export const UNKINDED_WORK_CHARTER: RoleCharter = { identity: CODING_AGENT, duties: null };
