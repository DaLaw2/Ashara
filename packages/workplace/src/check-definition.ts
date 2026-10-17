import type { CheckRun } from "./check-run.js";

/** One check the check author defines: a command the project environment runs; exit 0 with output means it passes. */
export interface CheckDefinition {
  readonly name: string;
  readonly command: string;
}

/**
 * A check as its author defines it: with the ids of the vision items its verdict decides,
 * never none. A check task's set is kept only when every item its task cites is decided by at least
 * one of its checks, so which items are checked is a stored fact, never read off an acceptance line.
 */
export interface DefinedCheck extends CheckDefinition {
  readonly decides: readonly [string, ...string[]];
}

/**
 * How Z0 runs every check (development's runSuitesOnCheckout), stated once for each brief and tool
 * that names it: a check author who guesses the shell writes checks that can never pass.
 */
export const CHECK_RUNNER =
  "Each check's command runs as `sh -c '<command>'`: POSIX sh, not bash, so bash-only syntax such as arrays or " +
  "[[ ]] is a syntax error. It runs from the repository root of a fresh copy of the project, inside the project " +
  "environment's image, with no network.";

/**
 * The exit status by which a check states its own verdict that the behaviour it checks is missing.
 * On the foundation only this exit is a decisive failure: any other
 * non-zero exit (the product or the check's harness failing to build or start, a shell error) is a
 * check that never reached its verdict, and counting it would accept "nothing builds" as "the work
 * is missing". Which part of a command is setup and which is the verdict only the check's author
 * knows, so the check declares it; no exit status a tool uses on its own is read as one. 99 is
 * chosen as a status no common build or test tool exits with by itself (they use 1, 2, 101 and the
 * shell's 124-127 and 128+n); a tool that does is told apart by the author's own mapping.
 */
export const CHECK_MISSING_EXIT = 99;

/** How a check states its verdict, stated once for each brief and tool that names it. */
export const CHECK_VERDICT =
  `A check exits 0 when the behaviour it checks holds, and exits ${CHECK_MISSING_EXIT} (\`exit ${CHECK_MISSING_EXIT}\`) when it ran ` +
  `and found that behaviour missing. Any other exit means the check did not reach its verdict (a build, setup or ` +
  `harness step of its own failed): run such steps first and let their failure exit as it does, then map only the ` +
  `verdict's failure to ${CHECK_MISSING_EXIT}, for example \`<build step> && { <test of the behaviour> || exit ${CHECK_MISSING_EXIT}; }\`.`;

/**
 * Z0's immediate red run of one defined check on the plan's foundation, with the files the attempt
 * has changed so far written over it: what the check author is shown so a broken check is fixed
 * before finishing.
 */
export type CheckRedRunPreview =
  | {
      readonly kind: "ran";
      readonly run: CheckRun;
      /** The bound this run had; the red run at finish uses the attempt's full per-command limit. */
      readonly timeoutSeconds: number;
      /** Why the red run at finish would reject this check as it ran here; null when it would keep it. */
      readonly rejection: string | null;
      /**
       * It passes on the foundation and the red run at finish keeps it, as a guard of behaviour
       * that already holds there: the set is kept only if another of its checks fails there.
       */
      readonly holdsAlready: boolean;
    }
  /** The attempt's files could not be kept or placed on the foundation, so the check could not run. */
  | { readonly kind: "files_refused"; readonly detail: string }
  /** The check files or the check changed files the foundation tracks: the run reached no verdict there. */
  | { readonly kind: "product_changed"; readonly detail: string };

export type CheckDefinitionResult =
  | {
      readonly kind: "recorded";
      readonly defined: number;
      /** A check of the same name was defined before; this definition replaced it. */
      readonly replaced: boolean;
      readonly redRun: CheckRedRunPreview;
      /**
       * Files the author wrote outside its checks directory: never kept, never placed on the
       * foundation. Empty when there are none.
       */
      readonly discarded: readonly string[];
      /** The items the task cites that no check defined so far decides; the set is kept only when none is left. */
      readonly undecided: readonly string[];
    }
  /** The model can fix it: the reason is told to it as the tool's error. */
  | { readonly kind: "refused"; readonly reason: string };

/** probe_foundation's run of one command on the foundation: nothing of it is recorded. */
export type FoundationProbe =
  | { readonly kind: "ran"; readonly run: CheckRun; readonly timeoutSeconds: number }
  | { readonly kind: "files_refused"; readonly detail: string }
  | { readonly kind: "product_changed"; readonly detail: string };

/**
 * Z0's side of define_check, supplied by the execution service for a check task only: it keeps
 * each definition (the last of a name wins) for Z0 to harvest when the attempt finishes, and
 * red-runs it at once. A substrate that cannot run it throws.
 */
export interface CheckDefinitionPort {
  /**
   * The author wrote `path` with write_file or edit_file: only such files are its submission, never
   * a file a command it ran left in the workspace.
   */
  fileWritten(path: string): void;
  define(check: DefinedCheck, timeoutSeconds: number): Promise<CheckDefinitionResult>;
  /**
   * Runs one command on the foundation the way define_check red-runs a check, and records nothing:
   * the author's way to look at the foundation, so no command it runs only to look around is ever
   * stored as an acceptance check. A substrate that cannot run it throws.
   */
  probe(command: string, timeoutSeconds: number): Promise<FoundationProbe>;
}
