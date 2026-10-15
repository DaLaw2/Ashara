import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptCellImage } from "@ashara/execution-infra";
import type { AgentBrief, AttemptTerminal } from "@ashara/shared";
import { CONVERSATION_RECORDS_DIR } from "@ashara/shared";
import { toRecordedOutcome } from "@ashara/workplace";
import type { AttemptRecord, AttemptRecordSink, Outcome } from "@ashara/workplace";

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
 * The records of one dispatch, Z0-side under `workdirBase/records/<task>/<session>/`: the brief and
 * the attempt's conversation. Nothing is written into the worktree.
 */
export class DispatchRecords implements AttemptRecordSink {
  readonly dir: string;

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
  }
}

/**
 * How the attempt ended, in one line: a finished attempt's own summary (with its blocked reason),
 * every other terminal named with its detail. A claim of the agent's, never a verdict.
 */
export function attemptSummary(outcome: Outcome): string {
  if (outcome.kind !== "finished") return `attempt ended as ${outcome.kind}: ${outcome.detail}`;
  return outcome.status === "blocked" ? `${outcome.summary} (blocked: ${outcome.blockedReason ?? "no reason given"})` : outcome.summary;
}

/** The Outcome as plain data for an error envelope, its error (or cancellation reason) serialized with its chain. */
export function outcomeRecord(outcome: Outcome): Record<string, unknown> {
  return { ...toRecordedOutcome(outcome) };
}

/** An attempt as the session's terminal write records it (migration 046). */
export interface SessionAttempt {
  readonly promptDigest: string;
  /** The Outcome kind, with a finished attempt's status: "finished:done", "finished:blocked", "turn_cap", ... */
  readonly terminal: AttemptTerminal;
  readonly turns: number;
  readonly provider: string;
  readonly model: string;
  readonly cell: AttemptCellImage["kind"];
}

export function toSessionAttempt(
  outcome: Outcome,
  model: { readonly provider: string; readonly modelId: string },
  cellImage: AttemptCellImage,
): SessionAttempt {
  return {
    promptDigest: outcome.promptDigest,
    terminal: attemptTerminal(outcome),
    turns: outcome.turnsUsed,
    provider: model.provider,
    model: model.modelId,
    cell: cellImage.kind,
  };
}

/** Typed against the one list the DB CHECK mirrors: an Outcome kind the list lacks fails the build. */
function attemptTerminal(outcome: Outcome): AttemptTerminal {
  return outcome.kind === "finished" ? `finished:${outcome.status}` : outcome.kind;
}
