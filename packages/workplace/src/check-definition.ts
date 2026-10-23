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
 * The rule a check task's whole set is kept by on the plan's foundation, beyond each check's own:
 * Quality's red run applies this value and every text that states the rule to an author renders it
 * from this value, so no text can state another rule.
 */
export interface HeldSetRule {
  /**
   * The exit status by which a check states its own verdict that the behaviour it checks is
   * missing; one check failing on the foundation by it makes the set tell the task's work from its
   * absence. Any other non-zero exit there (the product or the check's harness failing to build or
   * start, a shell error) is a check that never reached its verdict, and counting it would accept
   * "nothing builds" as "the work is missing". Which part of a command is setup and which is the
   * verdict only the check's author knows, so the check declares it; no exit status a tool uses on
   * its own is read as one.
   */
  readonly decisiveExit: number;
  /** How many identical rejections of a set holding whole, for the same items, give its task up. */
  readonly giveUpAfter: number;
}

/**
 * 99 is a status no common build or test tool exits with by itself (they use 1, 2, 101 and the
 * shell's 124-127 and 128+n); a tool that does is told apart by the author's own mapping.
 * giveUpAfter is a retry policy: a rejected set is handed its typed reason and attempted again, and
 * a later attempt can still write a check that fails decisively or a plan can record the evidence
 * that is missing, so a task gets no fewer identical rejections than the failure router gives any
 * failed attempt before it is given up.
 */
export const HELD_SET_RULE: HeldSetRule = { decisiveExit: 99, giveUpAfter: 3 };

/** The exit status by which a check states its own verdict that the behaviour it checks is missing: the held-set rule's decisive exit. */
export const CHECK_MISSING_EXIT = HELD_SET_RULE.decisiveExit;

/** How a check states its verdict, stated once for each brief and tool that names it. */
export const CHECK_VERDICT =
  `A check exits 0 when the behaviour it checks holds, and exits ${CHECK_MISSING_EXIT} (\`exit ${CHECK_MISSING_EXIT}\`) when it ran ` +
  `and found that behaviour missing. Any other exit means the check did not reach its verdict (a build, setup or ` +
  `harness step of its own failed): run such steps first and let their failure exit as it does, then map only the ` +
  `verdict's failure to ${CHECK_MISSING_EXIT}, for example \`<build step> && { <test of the behaviour> || exit ${CHECK_MISSING_EXIT}; }\`.`;

/** Vision item ids, never none. */
type ItemIds = readonly [string, ...string[]];

/**
 * What a check set of an implementation task whose every check passes on its foundation is evidence
 * of, as the records decide it. `still-holds`: every item it decides is a key a client correction
 * put in scope and an earlier Completed task's checks decide, so it held before the correction and
 * the set shows it still holds. Every other arm is a typed reason the set is rejected: holding
 * before any work, it shows only that it does not test what the task adds.
 */
export type HoldEvidence =
  | { readonly kind: "still-holds"; readonly items: ItemIds }
  /** The task records no vision item it cites. */
  | { readonly kind: "uncited"; readonly taskId: string }
  /** No client correction a plan revision took in before the task was planned affects any item it cites: a first plan's task. */
  | { readonly kind: "uncorrected"; readonly items: ItemIds }
  /** A correction put some cited items in scope and none affects the others. */
  | { readonly kind: "partly-corrected"; readonly corrected: ItemIds; readonly uncorrected: ItemIds }
  /** Corrected items no Completed task's checks decide, a guarantee among them: one the correction adds, or one never delivered. */
  | { readonly kind: "undelivered"; readonly items: ItemIds }
  /** Every corrected item no Completed task's checks decide is an amended assumption no earlier check decided. */
  | { readonly kind: "assumption-undecided"; readonly items: ItemIds };

/** A HoldEvidence arm that rejects a set whose every check passes on the foundation. */
export type UnheldEvidence = Exclude<HoldEvidence, { readonly kind: "still-holds" }>;

/** The held-set rule as an author is told it. */
export function heldSetRuleText(rule: HeldSetRule): string {
  return (
    `At least one check of the set must fail on the foundation by exiting ${rule.decisiveExit}, for the reason the ` +
    `task's work is missing there. A set whose every check passes on the foundation is kept only when the records show ` +
    `that every item it decides held before the client correction that put it in scope: the task then closes as held, ` +
    `with no work owed. Any other set whose every check passes there is rejected, and after ${rule.giveUpAfter} ` +
    `identical rejections for the same items the task is given up.`
  );
}

/** Why a set whose every check passes on the foundation is rejected, by the evidence the records hold. */
export function unheldReason(evidence: UnheldEvidence): string {
  switch (evidence.kind) {
    case "uncited":
      return `task ${evidence.taskId} records no vision item it cites (task_spec.sources), so nothing shows what the set decides held before`;
    case "uncorrected":
      return `no client correction a plan revision took in before the task was planned affects ${evidence.items.join(", ")}, so the set does not test what the task adds`;
    case "partly-corrected":
      return (
        `a client correction put ${evidence.corrected.join(", ")} in scope, but none affects ${evidence.uncorrected.join(", ")}, ` +
        `so the set does not test what the task adds for them`
      );
    case "undelivered":
      return (
        `no Completed implementation task's checks decide ${evidence.items.join(", ")}, so nothing shows they held before ` +
        `the correction: what a correction adds, or what was never delivered, is behaviour the set does not test`
      );
    case "assumption-undecided":
      return `no earlier check decided the amended assumption(s) ${evidence.items.join(", ")}, so nothing shows they held before the correction`;
  }
}

/** The items an unheld rejection is about, sorted: two rejections of one reason and the same items are identical. */
export function unheldItems(evidence: UnheldEvidence): string[] {
  switch (evidence.kind) {
    case "uncited":
      return [];
    case "partly-corrected":
      return [...evidence.corrected, ...evidence.uncorrected].sort();
    case "uncorrected":
    case "undelivered":
    case "assumption-undecided":
      return [...evidence.items].sort();
  }
}

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
       * Null unless it passes on the foundation and the red run at finish keeps it, as a guard of
       * behaviour that already holds there; then what a set whose every check passes there shows,
       * as the records decide it.
       */
      readonly holdsAlready: HoldEvidence | null;
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
