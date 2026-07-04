import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ZodType } from "zod";

/**
 * Typed failure for a spawned agent whose output.json is genuinely missing or
 * unparseable (Discipline C — self-diagnosing). Carries the exit code and path so a
 * reader knows the runner never wrote a result (vs. wrote a "failed"/"blocked" one,
 * which is a valid result, not this error).
 */
export class AgentSpawnError extends Error {
  readonly context: {
    readonly taskId: string;
    readonly outputPath: string;
    readonly exitCode: number | null;
    readonly cause: string;
    readonly stderr: string;
  };

  constructor(context: AgentSpawnError["context"]) {
    super(
      `agent for task ${context.taskId} produced no readable output (exit ${context.exitCode}): ${context.cause}`,
    );
    this.name = "AgentSpawnError";
    this.context = context;
  }
}

/**
 * The agent output.json is a subprocess trust boundary — validate it with Zod rather
 * than asserting its shape (CLAUDE.md). A permissive object schema is deliberate: the
 * consumers (costFromOutput, execution-service) read individual fields defensively, so
 * the only invariant enforced here is "it is a JSON object", which is what distinguishes
 * a real result from a corrupt/absent one.
 */
const agentOutputSchema: ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

/**
 * Reads and validates a spawned agent's output.json REGARDLESS of exit code (r9f-t2).
 * A failing agent (turn-limit "blocked", "failed") writes a valid output.json with its
 * real status and total_cost before exiting non-zero, so that output must flow back
 * intact — throwing on the non-zero exit (as the pre-fix code did) discarded the real
 * status and cost, leaving the orchestrator with an empty result: zero cost, no dispatch
 * counted, the retry bound never binding (Run-9). Fail-closed (Discipline A): a genuinely
 * missing or unparseable file — the runner crashed before writing — throws a typed
 * AgentSpawnError instead of fabricating a success.
 */
export async function resolveAgentOutput(
  taskId: string,
  outputPath: string,
  exitCode: number | null,
  stderr: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(outputPath, "utf-8");
  } catch (readError) {
    throw new AgentSpawnError({
      taskId,
      outputPath,
      exitCode,
      cause: `output file unreadable: ${readError instanceof Error ? readError.message : String(readError)}`,
      stderr: stderr.slice(0, 500),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    throw new AgentSpawnError({
      taskId,
      outputPath,
      exitCode,
      cause: `output is not valid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      stderr: stderr.slice(0, 500),
    });
  }

  const validated = agentOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AgentSpawnError({
      taskId,
      outputPath,
      exitCode,
      cause: `output is not a JSON object: ${validated.error.issues.map((i) => i.message).join("; ")}`,
      stderr: stderr.slice(0, 500),
    });
  }
  return validated.data;
}
