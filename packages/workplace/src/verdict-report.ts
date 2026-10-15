/**
 * Quality's verdict on a run a tool asked Z0 for, as the model reads it: whether it passed, and the
 * report of the run. Workplace shows it and never judges the run itself: "Passed" exists only in
 * Quality (ADR-075 §5).
 */
export interface VerdictReport {
  readonly passed: boolean;
  readonly report: string;
}
