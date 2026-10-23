/**
 * Run-state replay: loads a kept run's plain pg
 * dump into a scratch database, migrates it forward, re-runs today's brief and report composers over
 * its records with no model call, and judges what they state with the simulator's text-against-fact
 * oracle (packages/integration/src/simulator/text-facts.ts) and its report oracle
 * (client-reports.ts). $0: nothing here calls a model, a cell or git.
 *
 *   npx tsx scripts/replay-run-state.ts --dump FILE --psql "COMMAND" [--keep]
 *
 * `--dump` is a plain-format pg_dump of a run's database (`ashara_run_*.sql`, `db-dump.sql`).
 * `--psql` is the command that runs psql with the SQL on its stdin; the scratch database's name is
 * appended as its last argument. Split on spaces, no quoting. With the database in a container:
 *
 *   npx tsx scripts/replay-run-state.ts --dump kept-run/ashara_run.sql \
 *     --psql "podman exec -i ashara-db psql -U ashara -v ON_ERROR_STOP=1 -q -d"
 *
 * The scratch database `ashara_replay_*` is created on the server of REPLAY_DATABASE_URL (default
 * DATABASE_URL, default local) and dropped at the end unless `--keep`; the shared database is never
 * touched. A dump holds what its run held, its secrets rows included: it is loaded only into the
 * scratch database.
 *
 * What is judged, per project of the dump:
 * - kept: the briefs the sessions recorded and the reports the run posted, as they are (what the
 *   code of that run stated);
 * - today: the same, after today's code composes them again from the migrated records: each recorded
 *   session's brief facts (its goal as Delivery takes it from the task's task_spec, and the
 *   project intent today's loadProjectIntent states from the vision current when the session was
 *   recorded), the delivered report of each passed sweep (its project accepted again for the
 *   while, as it was when the report was composed), the report of a blocked project's open
 *   episode, the client's stop report and the planning-stopped report, posted again by Engagement
 *   through today's stores with the kept ones set aside. Each carries the guarantee table of its
 *   sweep, or of none on record for it, and its verdicts are printed one per guarantee. An open
 *   episode and a stop are owed a terminal sweep before the report; a dump holds no checkout to run
 *   one on, so it is recorded as run on no commit, and every guarantee of that report reads unjudged. One
 *   today's Engagement does not post again (a project with a stop awaiting the Liaison is not
 *   reported on) gets its kept report back and is judged as kept, and says so. A brief's
 *   other sections (its context map, checks, knowledge) need the run's checkout, which a dump does
 *   not hold, so they are not composed, and a delivered report composed again says it does not
 *   quote the product's public interface file, for the same reason; questions, the assumptions report, answer replies and the
 *   other plan reports are written with a model call or in the step that made the record, so they are judged
 *   as kept only.
 * Exits 1 when a text today's code composed again states a fact its records do not hold, or when any
 * step fails; the kept violations, and today's on texts judged as kept, are printed for the record
 * and do not set the exit code.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { DEFAULT_DATABASE_URL, MIGRATIONS_DIR, createDb, runMigrations } from "@ashara/db";
import { BlockReports, TerminalReports } from "@ashara/engagement";
import {
  composedAgain,
  createReplayDatabase,
  dropReplayDatabase,
  judgeStoredText,
  recomposeBriefs,
  replayDatabaseUrl,
  replayProjects,
  setAsideReports,
  settleReports,
  storedVerdicts,
} from "@ashara/integration";
import type { StoredTextViolation, StoredVerdict } from "@ashara/integration";
import { PUBLIC_INTERFACE_FILE } from "@ashara/quality";
import { createTerminalSweepStore } from "@ashara/server/acceptance-store";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createTerminalReportStore } from "@ashara/server/terminal-report-store";
import { createLogger, describeErrorChain, stdoutSink, systemClock, uncontainedSteps } from "@ashara/shared";

const USAGE = 'Usage: npx tsx scripts/replay-run-state.ts --dump FILE --psql "COMMAND" [--keep]';
const RESTORE_TIMEOUT_MS = 5 * 60_000;

class ReplayUsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n${USAGE}`);
    this.name = "ReplayUsageError";
  }
}

/** The dump could not be loaded: nothing is judged. */
class ReplayRestoreFailed extends Error {
  constructor(
    readonly database: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`replay of ${database}: restore failed: ${detail}`, options);
    this.name = "ReplayRestoreFailed";
  }
}

interface Args {
  readonly dump: string;
  readonly psql: readonly string[];
  readonly keep: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let dump: string | null = null;
  let psql: string[] | null = null;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--keep") {
      keep = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new ReplayUsageError(`${flag ?? "(none)"} needs a value`);
    if (flag === "--dump") dump = value;
    else if (flag === "--psql") psql = value.split(" ").filter((part) => part !== "");
    else throw new ReplayUsageError(`unknown argument ${flag ?? "(none)"}`);
    i += 1;
  }
  if (dump === null) throw new ReplayUsageError("--dump is required");
  if (psql === null || psql.length === 0) throw new ReplayUsageError("--psql is required: the command that runs psql, the database name appended");
  return { dump, psql, keep };
}

/** Feeds the dump to psql on its stdin; any non-zero exit, signal or timeout is a failed restore. */
async function restore(dump: string, psql: readonly string[], database: string): Promise<void> {
  const [command, ...args] = psql;
  if (command === undefined) throw new ReplayUsageError("--psql names no command");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args, database], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    // psql that stopped on an error closes its stdin first: the exit status and stderr below say why.
    child.stdin.on("error", (err) => {
      stderr = `${stderr}\n(writing the dump to ${command}: ${err.message})`.slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RESTORE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ReplayRestoreFailed(database, `${command} could not start`, { cause: err }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ReplayRestoreFailed(database, `${command} exited ${code ?? "with no code"}${signal === null ? "" : ` on ${signal}`}: ${stderr.trim()}`));
    });
    const input = createReadStream(dump);
    input.on("error", (err) => {
      child.kill("SIGKILL");
      reject(new ReplayRestoreFailed(database, `${dump} could not be read`, { cause: err }));
    });
    input.pipe(child.stdin);
  });
}

/**
 * Records the terminal sweep every open halt episode and stop of the dump is owed, as one that ran
 * on no commit: a dump holds no checkout of the product, and the replay runs nothing on cells.
 * Returns how many were recorded.
 */
async function recordUnsweptTerminals(db: ReturnType<typeof createDb>): Promise<number> {
  const store = createTerminalSweepStore(db);
  let recorded = 0;
  for (const due of await store.dueTerminalSweeps()) {
    const outcome = await store.recordTerminalSweep({
      projectId: due.projectId,
      terminal: due.terminal,
      mainCommit: null,
      environmentVersion: null,
      checkedTasks: [],
      uncheckedTasks: [],
      checkOutcomes: [],
      details: "No terminal sweep ran: a replay of a kept run's records holds no checkout of its product.",
    });
    if (outcome === "recorded") recorded += 1;
  }
  return recorded;
}

function printVerdicts(verdicts: readonly StoredVerdict[]): void {
  if (verdicts.length === 0) {
    console.log("  verdicts: none stored");
    return;
  }
  for (const reportId of new Set(verdicts.map((each) => each.reportId))) {
    const of = verdicts.filter((each) => each.reportId === reportId);
    const [first] = of;
    const sweep = first === undefined ? "?" : (first.sweepId ?? "none on record");
    console.log(`  verdicts of report ${reportId} (sweep ${sweep}, vision v${first?.visionVersion ?? "?"}):`);
    for (const each of of) console.log(`    ${each.guaranteeId} ${each.verdict}${each.reason === null ? "" : ` ${each.reason}`} (evidence: ${each.evidenceClass})`);
  }
}

function print(label: string, violations: readonly StoredTextViolation[]): void {
  if (violations.length === 0) {
    console.log(`  ${label}: no violation`);
    return;
  }
  console.log(`  ${label}: ${violations.length} violation(s)`);
  for (const each of violations) console.log(`    ${each.invariant} [${each.key}]: ${each.statement}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await access(args.dump);
  const server = process.env["REPLAY_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  const database = await createReplayDatabase(server);
  let failed = 0;
  try {
    await restore(args.dump, args.psql, database);
    const url = replayDatabaseUrl(server, database);
    const migrated = await runMigrations(url, MIGRATIONS_DIR);
    console.log(`restored ${args.dump} into ${database}; migrated forward: ${migrated.applied.length} applied (${migrated.applied.join(", ") || "none"})`);
    const db = createDb(url);
    try {
      const projects = await replayProjects(db);
      const kept = new Map<string, StoredTextViolation[]>();
      for (const project of projects) kept.set(project.id, await judgeStoredText(db, project.id, "as-recorded"));
      const setAside = await setAsideReports(db);
      console.log(`terminal sweeps recorded on no commit for the open halts and stops: ${await recordUnsweptTerminals(db)}`);
      // A replay contains nothing and skips nothing: any report that fails throws, so the replay stops on it, and a
      // backoff kept in the restored step_faults does not hide a report.
      const steps = uncontainedSteps(createLogger({ sink: stdoutSink, clock: systemClock, minLevel: "info" }));
      const notHeld = { kind: "not-held", reason: "a replay of a kept run's records holds no checkout of its product" } as const;
      await new TerminalReports(createTerminalReportStore(db), { file: PUBLIC_INTERFACE_FILE, at: async () => notHeld }, steps).runPending();
      await new BlockReports(createBlockReportStore(db), steps).runPending();
      const recomposed = await settleReports(db, setAside);
      console.log(
        `today's composers: every recorded brief's facts, and ${recomposed.length} of ${setAside.records.length} kept delivered, halt, stop and planning-stopped ` +
          `report(s), composed again; every other text is judged as kept`,
      );
      for (const project of projects) {
        console.log(`project ${project.id} "${project.name}"`);
        // eslint-disable-next-line no-restricted-syntax -- policy default: a project with nothing kept prints an empty list
        print("kept", kept.get(project.id) ?? []);
        const today = await judgeStoredText(db, project.id, await recomposeBriefs(db, project.id));
        const composed = today.filter((each) => composedAgain(each.key, project.id, recomposed));
        print("today, composed again", composed);
        print("today, judged as kept", today.filter((each) => !composed.includes(each)));
        printVerdicts(await storedVerdicts(db, project.id));
        failed += composed.length;
      }
    } finally {
      await db.$client.end();
    }
  } finally {
    if (args.keep) console.log(`kept ${database}`);
    else await dropReplayDatabase(server, database);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(`\n${describeErrorChain(err)}\n`);
  process.exit(1);
});
