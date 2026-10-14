import type { CheckRun } from "./check-run.js";

/** One check the check author defines: a command the project environment runs; exit 0 with output means it passes. */
export interface CheckDefinition {
  readonly name: string;
  readonly command: string;
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
 * Z0's immediate red run of one defined check on main, with the files the attempt has changed so
 * far written over it: what the check author is shown so a broken check is fixed before finishing.
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
       * It does not fail on main and the red run at finish would still keep it: a re-authoring's rule
       * lets a check pass there as long as one of the set fails (ADR-074 addendum 2 d68 b).
       */
      readonly passesAllowed: boolean;
    }
  /** The attempt's files could not be kept or placed on main, so the check could not run. */
  | { readonly kind: "files_refused"; readonly detail: string };

export type CheckDefinitionResult =
  | {
      readonly kind: "recorded";
      readonly defined: number;
      /** A check of the same name was defined before; this definition replaced it. */
      readonly replaced: boolean;
      readonly redRun: CheckRedRunPreview;
    }
  /** The model can fix it: the reason is told to it as the tool's error. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Z0's side of define_check, supplied by the execution service for a check task only: it keeps
 * each definition (the last of a name wins) for Z0 to harvest when the attempt finishes, and
 * red-runs it at once. A substrate that cannot run it throws.
 */
export interface CheckDefinitionPort {
  define(check: CheckDefinition, timeoutSeconds: number): Promise<CheckDefinitionResult>;
}
