import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VerifyRequest, VerifyResponse } from "./types.js";
import { runVerifyCore } from "./verify-core.js";

// Thin in-process adapter over the shared verify-core library. Owns the
// environment specifics of the server/orchestrator path: request/response
// shaping (session_id) and JSONL log emission. All check logic lives in
// verify-core.ts.

export interface VerifyLogOptions {
  readonly logPath: string;
}

// open-by-design: log payloads carry caller-defined diagnostic fields
function emitVerifyLog(opts: VerifyLogOptions | undefined, data: Record<string, unknown>): void {
  if (!opts) return;
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const line = JSON.stringify({ ...data, timestamp: new Date().toISOString() });
  appendFileSync(opts.logPath, line + "\n");
}

export async function verify(
  request: VerifyRequest,
  logOpts?: VerifyLogOptions,
): Promise<VerifyResponse> {
  const result = await runVerifyCore(
    {
      workDir: request.working_directory,
      gitRoot: request.git_root,
      checks: request.task_spec?.checks ?? [],
      contractChecks: request.contractChecks,
    },
    {
      log: (event) => emitVerifyLog(logOpts, { taskId: request.task_id, ...event }),
    },
  );

  return {
    session_id: request.session_id,
    verdict: result.verdict,
    tiers: result.tiers,
  };
}
