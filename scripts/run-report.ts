/**
 * The evidence of one project's run (roadmap M2 exit 7; story c-walking-skeleton-run, task
 * t-w8-exit-evidence). Read-only; prints no credential and no connection string.
 *
 *   npx tsx scripts/run-report.ts <project-id>        (or: just run-report <project-id>)
 *
 * Per task: each dev session's attempt (terminal, turns, model, environment version, prompt
 * digest), or, when none is recorded, what the row says about why (still open, closed by the startup
 * reconciler, from before migration 046, or ended without an attempt outcome), never "no model
 * call"; a task with an agent call admitted inside no session with a recorded attempt is flagged
 * UNTIED (one at or after the start of a session not yet terminal is listed apart as open: in flight,
 * or a crash orphan not yet reconciled, the rows do not say which; a call of any site but
 * agent-runner, such as a review of the plan's suites, is no attempt's turn and is listed by its site). Its
 * llm_calls per provider with the measured coverage of their cost and the cache-hit share
 * (cache-read over input tokens, over the calls that reported both). Then the run's totals. Exits 1 when an llm_calls row is priced at
 * exactly $0, which the ledger must never write (an unknown cost is NULL).
 */

import { createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import { describeErrorChain, parseProjectId } from "@ashara/shared";
import { readRunEvidence } from "@ashara/workplace";
import { formatRunReport } from "./run-report-format.js";

class RunReportUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\nUsage: npx tsx scripts/run-report.ts <project-id>`);
    this.name = "RunReportUsageError";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [raw] = args;
  if (raw === undefined || args.length !== 1) throw new RunReportUsageError("run-report takes exactly one project id.");
  const projectId = parseProjectId(raw, "run-report <project-id> argument");

  const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  try {
    const report = formatRunReport(await readRunEvidence(db, projectId));
    console.log(report.text);
    if (report.zeroCostCalls > 0) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});
