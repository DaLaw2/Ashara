import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import { z } from "zod";

declare module "vitest" {
  export interface ProvidedContext {
    /** This vitest run's id; every test cell's ashara.instance starts with testInstancePrefix(cellRun). */
    cellRun: string;
  }
}

// vitest's globalSetup. A test cell's instance names the run that made it, so the run's end can
// tell its own cells from a concurrent run's, and a later run can tell a dead run's from a live
// one's. A test process that dies before its afterAll (a test that timed out with a cell still
// starting, a killed worker) leaves cells no production reaper selects: reconcileOrphans selects
// one instance, and every test file draws its own. A run stopped by a signal removes its cells in
// the signal listener; a run killed outright (SIGKILL, an out-of-memory kill) leaves them to the
// next run's reaper.

const run = promisify(execFile);
const PODMAN_TIMEOUT_MS = 60_000;
const LABEL_INSTANCE = "ashara.instance";
/** test-<pid of the vitest process>x<8 hex>-: the pid says whether the run that made a cell is alive. */
const RUN_INSTANCE = /^test-(\d+)x[0-9a-f]{8}-/;
/** The part of vitest's teardownTimeout the end-of-run check may spend on podman, so it ends first. */
const TEARDOWN_SHARE = 0.8;

/** Time left until `deadline`, at least 1 ms: execFile reads a timeout of 0 as none. */
function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** The prefix of every test cell's instance in run `cellRun`. */
export function testInstancePrefix(cellRun: string): string {
  return `test-${cellRun}-`;
}

const psSchema = z.array(
  z.object({
    Id: z.string().min(1),
    Names: z.array(z.string()).nullable().optional(),
    State: z.string().optional(),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
);

interface TestContainer {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly labels: Readonly<Record<string, string>>;
}

class TestCellGuardFailed extends Error {
  constructor(
    readonly operation: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`test cell guard: ${operation} failed: ${detail}`, options);
    this.name = "TestCellGuardFailed";
  }
}

/** A run ended with containers of its own test instances still present; they were removed first. */
class TestCellsLeaked extends Error {
  constructor(
    readonly cellRun: string,
    readonly leaked: readonly TestContainer[],
    readonly removal: string,
  ) {
    super(
      `vitest run ${cellRun} left ${leaked.length} container(s) of its test instances behind, so a test started a cell ` +
        `and no path of it removed the cell (${removal}):\n` +
        leaked
          .map((c) => `  ${c.name} (${c.state}) instance=${c.labels[LABEL_INSTANCE] ?? "?"} task=${c.labels["ashara.task"] ?? "?"} role=${c.labels["ashara.role"] ?? "?"}`)
          .join("\n"),
    );
    this.name = "TestCellsLeaked";
  }
}

async function podman(args: readonly string[], timeoutMs: number = PODMAN_TIMEOUT_MS): Promise<string> {
  try {
    return (await run("podman", [...args], { timeout: timeoutMs })).stdout;
  } catch (err) {
    throw new TestCellGuardFailed(`podman ${args.join(" ")}`, err instanceof Error ? err.message : String(err), { cause: err });
  }
}

const PS_LABELLED = ["ps", "-a", "--filter", `label=${LABEL_INSTANCE}`, "--format", "json"] as const;

/** Every container carrying an ashara.instance label, whoever made it. */
async function labelledContainers(timeoutMs?: number): Promise<TestContainer[]> {
  return parsePs(await podman(PS_LABELLED, timeoutMs));
}

function parsePs(stdout: string): TestContainer[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new TestCellGuardFailed("parse podman ps", `invalid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const parsed = psSchema.safeParse(json);
  if (!parsed.success) throw new TestCellGuardFailed("parse podman ps", parsed.error.message);
  return parsed.data.map((entry) => ({
    id: entry.Id,
    name: entry.Names?.[0] ?? entry.Id,
    state: entry.State ?? "unknown",
    labels: entry.Labels ?? {},
  }));
}

/** Removes the containers by id; returns what could not be removed, never throws for it. */
async function remove(containers: readonly TestContainer[], timeoutMs?: number): Promise<string> {
  if (containers.length === 0) return "nothing to remove";
  try {
    await podman(["rm", "-f", "--ignore", "-t", "0", ...containers.map((c) => c.id)], timeoutMs);
    return "all removed";
  } catch (err) {
    return `removal failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid is alive, owned by someone else. Only ESRCH says no process holds it.
    return !(err instanceof Error && "code" in err && err.code === "ESRCH");
  }
}

/** Test cells of runs whose vitest process is gone: their own end never ran. */
async function reapDeadRuns(): Promise<void> {
  const dead = (await labelledContainers()).filter((c) => {
    const pid = RUN_INSTANCE.exec(c.labels[LABEL_INSTANCE] ?? "")?.[1];
    return pid !== undefined && !processAlive(Number(pid));
  });
  if (dead.length === 0) return;
  const removal = await remove(dead);
  console.warn(
    `[cell-leak-guard] ${dead.length} test container(s) of vitest runs that are no longer alive (${removal}): ` +
      dead.map((c) => `${c.name} instance=${c.labels[LABEL_INSTANCE] ?? "?"}`).join(", "),
  );
}

const TEARDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type TeardownSignal = (typeof TEARDOWN_SIGNALS)[number];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Removes this run's cells before the process exits, synchronously: vitest answers SIGTERM, SIGINT
 * and SIGHUP by exiting a millisecond later, so neither a test file's afterAll nor this file's
 * teardown runs. The removal runs in a session of its own (setsid), so a SIGKILL sent to the run's
 * process group after a short grace, as a task stop does, ends the run but not the removal.
 * Returns what happened; never throws, since it runs inside a signal listener.
 */
function removeOwnCellsNow(cellRun: string): string {
  const prefix = testInstancePrefix(cellRun);
  let own: TestContainer[];
  try {
    const stdout = execFileSync("podman", [...PS_LABELLED], { encoding: "utf8", timeout: PODMAN_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
    own = parsePs(stdout).filter((c) => (c.labels[LABEL_INSTANCE] ?? "").startsWith(prefix));
  } catch (err) {
    return `listing its cells failed, so a later run's reaper removes them: ${message(err)}`;
  }
  if (own.length === 0) return "no cell of it was present";
  const names = own.map((c) => c.name).join(", ");
  try {
    execFileSync("setsid", ["--wait", "podman", "rm", "-f", "--ignore", "-t", "0", ...own.map((c) => c.id)], {
      timeout: PODMAN_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return `removed ${own.length} cell(s): ${names}`;
  } catch (err) {
    return `removing ${names} failed, so a later run's reaper removes them: ${message(err)}`;
  }
}

/** Arms the signal teardown for the run; returns its disarm. */
function armSignalTeardown(cellRun: string): () => void {
  let swept = false;
  const listeners = TEARDOWN_SIGNALS.map((signal) => {
    const listener = (): void => onSignal(signal);
    process.on(signal, listener);
    return { signal, listener };
  });
  function onSignal(signal: TeardownSignal): void {
    if (!swept) {
      swept = true;
      console.warn(`[cell-leak-guard] ${signal}: vitest run ${cellRun} stops before its end; ${removeOwnCellsNow(cellRun)}`);
    }
    // A persistent listener replaces the signal's default action; when no other listener is left to
    // end the process (vitest's own is a once-listener), this one ends it, so the signal still stops the run.
    if (process.listenerCount(signal) === 1) process.exit(128 + osConstants.signals[signal]);
  }
  return () => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
}

/** @testseam vitest.config.ts names this file as globalSetup, a reference knip does not read */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cellRun = `${process.pid}x${randomBytes(4).toString("hex")}`;
  await reapDeadRuns();
  project.provide("cellRun", cellRun);
  const teardownTimeoutMs = project.globalConfig.teardownTimeout;
  const disarm = armSignalTeardown(cellRun);
  return async () => {
    try {
      // vitest's close() logs an error thrown here without setting the exit code, so the code is set
      // here, before podman is asked, and restored only once the run is shown to have left nothing.
      // `vitest run` awaits this teardown with no timer armed; Vitest.exit() arms teardownTimeout
      // first and on firing calls process.exit() with whatever code is set (vitest 4.1.10,
      // cli-api close() and exit()). Every podman call here is bounded to end before that timeout.
      const verdictBefore = process.exitCode;
      process.exitCode = 1;
      const deadline = Date.now() + teardownTimeoutMs * TEARDOWN_SHARE;
      const prefix = testInstancePrefix(cellRun);
      const leaked = (await labelledContainers(remainingMs(deadline))).filter((c) => (c.labels[LABEL_INSTANCE] ?? "").startsWith(prefix));
      if (leaked.length === 0) {
        process.exitCode = verdictBefore;
        return;
      }
      const removal = await remove(leaked, remainingMs(deadline));
      throw new TestCellsLeaked(cellRun, leaked, removal);
    } finally {
      disarm();
    }
  };
}
