/**
 * The evidence of one project's run. Read-only; prints no credential and no connection string.
 *
 *   npx tsx scripts/run-report.ts <project-id> [--hidden <verdict.json>] [--run <label> [--pool <dir>]]
 *     [--mapping <mapping.toml> --key <key.json>]
 *     (or: just run-report <project-id> [arguments])
 *
 * After the first line: the tender the run picked from the pool (its id, seed and reason, read from the pool's
 * ledger by the run label; the pool directory is --pool, else ASHARA_TENDER_POOL), and Ashara's verdict (its latest acceptance sweep)
 * beside the hidden suite's verdict (the judged file scripts/hidden-suite.ts writes) with every guarantee pass, fail
 * or unjudged, and DISAGREE when they disagree; with no --hidden, "hidden suite: not run". A verdict file or pick that
 * cannot be read or parsed stops the report before the database is read.
 *
 * With --mapping (a reader's blind mapping file of the run's Ashara arm, scripts/pool-mapping.ts) and --key (the packet
 * key that joins its item labels back to Ashara's guarantee ids), one line per intended guarantee: the Ashara
 * guarantees mapped to it with each verdict and evidence class from the guarantee_verdicts of the last terminal
 * report, beside the hidden suite's verdict of it, read agree, false-confirm (a pass over a hidden fail, or any pass of
 * a narrowed item), omitted (no item covers it) or not compared; without --mapping, "pairs: not mapped". A mapping or
 * key that cannot be read or parsed stops the report before the database is read; one that does not join to the
 * last terminal report is a violation.
 *
 * Per task: each dev session's attempt (terminal, turns, model, environment version, prompt
 * digest), or, when none is recorded, what the row says about why (still open, closed by the startup
 * reconciler, from before attempt outcomes were recorded, or ended without an attempt outcome), never "no model
 * call"; a task with an agent call admitted inside no session with a recorded attempt is flagged
 * UNTIED (one at or after the start of a session not yet terminal is listed apart as open: in flight,
 * or a crash orphan not yet reconciled, the rows do not say which; a call of any site but
 * agent-runner, such as a review of the plan's suites, is no attempt's turn and is listed by its site). Its
 * llm_calls per provider with the measured coverage of their cost and the cache-hit share
 * (cache-read over input tokens, over the calls that reported both). Then the run's totals, and the suite
 * reviews' judgements on the rejections they routed or released, and the claims of those that routed nothing:
 * what each covered, its basis, the second opinion's strength (or none and why), the strengths passed over,
 * and the items it leaves unverified with why; then each reviewer model's record, read from reviewer_outcomes alone:
 * its passes contradicted and findings witnessed or refuted by later evidence, and its calls' cost at the site. Spend per Epic and per goal task, with
 * each check task's and environment change's spend charged to the goal task it serves by the link its row
 * records, and mean input tokens per agent call per Epic; spend that serves no goal task is printed as
 * unattributed in its Epic, and llm_calls with no task on a project-level line of their own. Exits 1 when an
 * llm_calls row is priced at exactly $0, which the ledger must never write (an unknown cost is NULL), when
 * the Epics' spend and the project-level spend do not add up to every llm_calls row, or when the hidden verdict
 * judges another tender than the run picked, or when the mapping does not join to the last terminal report.
 */

import { createDb, DEFAULT_DATABASE_URL } from "@ashara/db";
import { poolDirOf, readHidden, readMapping, recordedPick, runReport, type PickRecord } from "@ashara/evaluation";
import { describeErrorChain, parseProjectId } from "@ashara/shared";

const USAGE =
  "Usage: npx tsx scripts/run-report.ts <project-id> [--hidden <verdict.json>] [--run <label> [--pool <dir>]] [--mapping <mapping.toml> --key <key.json>]";

const FLAGS = ["--hidden", "--run", "--pool", "--mapping", "--key"];

class RunReportUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "RunReportUsageError";
  }
}

function parseArgs(argv: readonly string[]): { readonly project: string; readonly flags: ReadonlyMap<string, string> } {
  const [project, ...rest] = argv;
  if (project === undefined || project.startsWith("--")) throw new RunReportUsageError("run-report takes one project id first.");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !FLAGS.includes(flag)) throw new RunReportUsageError(`Unknown argument ${JSON.stringify(flag)}.`);
    if (value === undefined || value === "") throw new RunReportUsageError(`${flag} needs a value.`);
    if (flags.has(flag)) throw new RunReportUsageError(`${flag} is given twice.`);
    flags.set(flag, value);
  }
  if (flags.has("--pool") && !flags.has("--run")) throw new RunReportUsageError("--pool names where the --run label's pick is; --run is missing.");
  if (flags.has("--mapping") !== flags.has("--key")) throw new RunReportUsageError("--mapping and --key are given together: the key joins the mapping's item labels to Ashara's guarantees.");
  return { project, flags };
}

async function main(): Promise<void> {
  const { project, flags } = parseArgs(process.argv.slice(2));
  const projectId = parseProjectId(project, "run-report <project-id> argument");
  const hiddenPath = flags.get("--hidden");
  const hidden = hiddenPath === undefined ? null : await readHidden(hiddenPath, "run-report");
  const run = flags.get("--run");
  const pick: PickRecord | null = run === undefined ? null : await recordedPick(poolDirOf(flags.get("--pool"), process.env), run);
  const mappingPath = flags.get("--mapping");
  const keyPath = flags.get("--key");
  const mapping = mappingPath === undefined || keyPath === undefined ? null : await readMapping(mappingPath, keyPath, "run-report");

  const db = createDb(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  try {
    const report = await runReport(db, projectId, { hidden, pick, mapping });
    console.log(report.text);
    if (report.failed) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});
