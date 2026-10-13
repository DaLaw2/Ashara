/**
 * What one attempt produced, in the shape the orchestrator's budget and failure routing read.
 * Built in-process by Development's M1 adapter from the Workplace attempt's Outcome (story
 * s-isolated-worker-m1); it no longer crosses a process boundary, so it carries no schema.
 * Snake_case is kept because task_cost_history and stored error envelopes already hold it. A type
 * alias, not an interface, so it stays assignable to the envelope's Record<string, unknown>.
 */
type AgentErrorDetail = {
  readonly model: string | null;
  readonly turn_count: number;
  readonly last_tool_call: string | null;
  readonly message: string;
};

export type AgentOutputJson = {
  readonly status: "done" | "blocked" | "failed";
  readonly summary: string;
  readonly findings: string[];
  readonly error: string | null;
  readonly error_detail: AgentErrorDetail | null;
  readonly total_tokens: { readonly input: number; readonly output: number };
  readonly total_cost: number;
  /**
   * `false` when at least one model call of the attempt could not be priced: `total_cost` is
   * then a lower bound and the orchestrator charges the run as unknown.
   */
  readonly cost_measured: boolean;
  readonly turn_count: number;
  readonly finish_reason: "completed" | "turn_limit" | "error";
};
