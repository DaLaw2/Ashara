import { z } from "zod";

/**
 * Subprocess trust boundary: the shape of output.json that agent-runner writes
 * and execution-service / orchestrator consume. Defined here (Published Language)
 * so the compiler catches field-name mismatches that previously compiled silently
 * against Record<string, unknown> — the bug that killed shouldSplit for 42 runs.
 *
 * Snake_case fields match the Rust-compatible serialization in agent-runner.
 */

const agentErrorDetailSchema = z.object({
  model: z.string().nullable(),
  turn_count: z.number(),
  last_tool_call: z.string().nullable(),
  message: z.string(),
});

export const agentOutputJsonSchema = z.object({
  status: z.enum(["done", "blocked", "failed"]),
  summary: z.string(),
  findings: z.array(z.string()),
  error: z.string().nullable(),
  error_detail: agentErrorDetailSchema.nullable(),
  total_tokens: z.object({ input: z.number(), output: z.number() }),
  total_cost: z.number(),
  /**
   * `true` when every gateway call reported measured token counts; `false`
   * when at least one call was unmeasured. Required at the subprocess
   * boundary — an omitted flag must be a parse failure, not a silent
   * `undefined` that reads as "measured".
   */
  cost_measured: z.boolean(),
  turn_count: z.number(),
  finish_reason: z.enum(["completed", "turn_limit", "error"]),
});

export type AgentOutputJson = z.infer<typeof agentOutputJsonSchema>;
