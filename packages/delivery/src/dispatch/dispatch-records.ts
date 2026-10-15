import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentBrief } from "@ashara/workplace";
import { CONVERSATION_RECORDS_DIR } from "@ashara/workplace";
import type { AttemptRecord, AttemptRecordSink } from "@ashara/workplace";

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
 * the attempt's conversation, Workplace's record sink. Nothing is written into the worktree.
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
