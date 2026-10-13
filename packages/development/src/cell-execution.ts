import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Cell } from "@ashara/execution-infra";
import type { AgentBrief } from "@ashara/shared";
import { CONVERSATION_RECORDS_DIR } from "@ashara/shared";
import type { AgentOutputJson } from "@ashara/shared/agent-output";
import type { AttemptRecord, AttemptRecordSink, Outcome } from "@ashara/workplace";
import type { CommandRunner } from "./verify-core.js";

/** Longest check output kept (the tail, where the failure usually is). */
const MAX_CHECK_OUTPUT = 2000;

/** Record directory names come from ids; anything else could walk out of workdirBase/records. */
const RECORD_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** A task or session id that cannot name a records directory under workdirBase. */
class InvalidRecordPath extends Error {
  readonly segment: string;

  constructor(segment: string) {
    super(`Cannot write records for ${JSON.stringify(segment)}: a records path segment must match ${RECORD_SEGMENT}`);
    this.name = "InvalidRecordPath";
    this.segment = segment;
  }
}

/**
 * Runs verify checks inside `cell`, which mounts `hostRoot` at its workspace: the host cwd a
 * caller passes is mapped to the same place in the cell (a cwd outside `hostRoot` is refused by
 * the cell as PathOutsideWorkspace). A command that runs out of time, or whose podman client the
 * host had to kill, is a failed check, never a passed one.
 */
export function cellAsRunner(cell: Pick<Cell, "exec">, hostRoot: string): CommandRunner {
  return async (command, cwd, timeoutMs) => {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const result = await cell.exec(command, { timeoutSeconds, cwd: relative(hostRoot, cwd) || "." });
    const combined = `${result.stdout}${result.stderr}`.trim();
    const tail = combined.length <= MAX_CHECK_OUTPUT ? combined : combined.slice(-MAX_CHECK_OUTPUT);
    if (result.timedOut || result.exitCode === null) {
      return { exitCode: result.exitCode === null || result.exitCode === 0 ? 1 : result.exitCode, output: `${tail}\n[timed out after ${timeoutSeconds}s]`.trim() };
    }
    return { exitCode: result.exitCode, output: tail };
  };
}

export interface TokenTally {
  readonly input: number;
  readonly output: number;
}

/**
 * The records of one dispatch, Z0-side under `workdirBase/records/<task>/<session>/`: the brief and
 * the attempt's conversation. Nothing is written into the worktree.
 */
export class DispatchRecords implements AttemptRecordSink {
  readonly dir: string;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(workdirBase: string, taskId: string, sessionId: string) {
    for (const segment of [taskId, sessionId]) {
      if (!RECORD_SEGMENT.test(segment) || segment === "." || segment === "..") throw new InvalidRecordPath(segment);
    }
    this.dir = join(workdirBase, CONVERSATION_RECORDS_DIR, taskId, sessionId);
  }

  async writeBrief(brief: AgentBrief): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
  }

  async append(record: AttemptRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, "conversation.jsonl"), `${JSON.stringify(record)}\n`);
    if (record.kind === "turn") {
      this.inputTokens += record.usage.inputTokens;
      this.outputTokens += record.usage.outputTokens;
    }
  }

  /** Token counts summed over the turns recorded so far. */
  tokens(): TokenTally {
    return { input: this.inputTokens, output: this.outputTokens };
  }
}

/**
 * The M1 adapter (story s-isolated-worker-m1): an attempt's Outcome in the shape the orchestrator's
 * budget and failure routing read today. Only finished(done) is "done"; every other terminal is
 * named in the summary and is never read as success.
 */
export function toAgentOutput(outcome: Outcome, modelId: string, tokens: TokenTally): AgentOutputJson {
  const cost = outcome.cost;
  const totalCost = cost.measured ? cost.totalUsd : cost.measuredUsd;
  const lastToolCall = outcome.lastToolCall?.toolName ?? null;
  const done = outcome.kind === "finished" && outcome.status === "done";
  const status: AgentOutputJson["status"] = done ? "done" : outcome.kind === "finished" ? "blocked" : "failed";
  const summary =
    outcome.kind === "finished"
      ? outcome.status === "blocked"
        ? `${outcome.summary} (blocked: ${outcome.blockedReason ?? "no reason given"})`
        : outcome.summary
      : `attempt ended as ${outcome.kind}: ${outcome.detail}`;
  const message = outcome.kind === "finished" && outcome.blockedReason !== null ? outcome.blockedReason : outcome.detail;
  return {
    status,
    summary,
    findings: [],
    error: status === "failed" ? outcome.detail : null,
    error_detail: done ? null : { model: modelId, turn_count: outcome.turnsUsed, last_tool_call: lastToolCall, message },
    total_tokens: tokens,
    total_cost: totalCost,
    cost_measured: cost.measured,
    turn_count: outcome.turnsUsed,
    finish_reason: outcome.kind === "finished" ? "completed" : outcome.kind === "turn_cap" ? "turn_limit" : "error",
  };
}
