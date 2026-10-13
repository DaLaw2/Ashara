import { readFile } from "node:fs/promises";
import { agentOutputJsonSchema } from "@ashara/shared/agent-output";
import type { AgentOutputJson } from "@ashara/shared/agent-output";

/**
 * Typed failure for a spawned agent whose output.json is genuinely missing or
 * unparseable (Discipline C — self-diagnosing). Carries the exit code and path so a
 * reader knows the runner never wrote a result (vs. wrote a "failed"/"blocked" one,
 * which is a valid result, not this error).
 */
class AgentSpawnError extends Error {
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
 * Reads and validates a spawned agent's output.json REGARDLESS of exit code (r9f-t2).
 * A failing agent (turn-limit "blocked", "failed") writes a valid output.json with its
 * real status and total_cost before exiting non-zero, so that output must flow back
 * intact — throwing on the non-zero exit (as the pre-fix code did) discarded the real
 * status and cost, leaving the orchestrator with an empty result: zero cost, no dispatch
 * counted, the retry bound never binding (Run-9). Fail-closed (Discipline A): a genuinely
 * missing or unparseable file — the runner crashed before writing — throws a typed
 * AgentSpawnError instead of fabricating a success.
 *
 * The schema enforces the full agent-output contract (agentOutputJsonSchema from
 * @ashara/shared) — a missing or misnamed field (like the finish_reason that killed
 * shouldSplit for 42 runs) is now a validation failure, not a silent undefined.
 */
export async function resolveAgentOutput(
  taskId: string,
  outputPath: string,
  exitCode: number | null,
  stderr: string,
): Promise<AgentOutputJson> {
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

  const validated = agentOutputJsonSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AgentSpawnError({
      taskId,
      outputPath,
      exitCode,
      cause: `agent output schema validation failed: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      stderr: stderr.slice(0, 500),
    });
  }
  return validated.data;
}
