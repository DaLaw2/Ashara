/**
 * The oracle's own bounds on work (ADR-084 decision 4: "an oracle-owned bounds table"): what the
 * termination invariants W1-W3 (termination.ts) hold production's records to. Each entry states
 * its value and the decision it is taken from, never a production constant: this file imports
 * nothing (boundary-rules.toml `bounds-tables`), so a production change that moves a bound changes
 * nothing here until the decision and this table change with it, a deliberate and reviewed act. A
 * run that stays far under a bound is reported as its margin, never used to tighten the bound.
 */
interface WorkBound {
  readonly value: number;
  /** The decision the value is taken from, as a record cites it. */
  readonly decided: string;
}

export const WORK_BOUNDS = {
  /**
   * W1: model requests one task may draw, every call site and attempt of it together, refunds and
   * restarts included.
   */
  requestsPerTask: {
    value: 60,
    decided: "ADR-084 decision 1 (owner 2026-10-16): the work ledger's per-task budget, more than two full dispatches of an agent's 25 turns",
  },
  /** W1: model requests one project may draw, its tasks' and its own together, with no grant on record. */
  requestsPerProject: {
    value: 600,
    decided: "ADR-084 decision 1 (owner 2026-10-16): the work ledger's per-project budget, ten tasks' worth",
  },
  /**
   * W2, W3: reviews that may name one check task (suite_review_findings rows): the first naming
   * reopens it, the second gives the review up, and no review names it after that.
   */
  reviewNamingsPerCheckTask: {
    value: 2,
    decided: "ADR-084 decision 3 and ADR-074 addendum 2 d71 c: a review reopens a check task at most once, then gives up and the plan is repaired",
  },
  /**
   * W2, W3: disputes one check task may draw (check_disputes rows): K = 2 reopen it, the third gives
   * the disputing task up.
   */
  disputesPerCheckTask: {
    value: 3,
    decided: "ADR-074 addendum 2 d65 c, K = 2 (d76): two disputes reopen the check task, the next gives the task up and the plan is repaired",
  },
} as const satisfies Readonly<Record<string, WorkBound>>;
