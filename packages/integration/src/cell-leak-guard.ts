import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
// one instance, and every test file draws its own.

const run = promisify(execFile);
const PODMAN_TIMEOUT_MS = 60_000;
const LABEL_INSTANCE = "ashara.instance";
/** test-<pid of the vitest process>x<8 hex>-: the pid says whether the run that made a cell is alive. */
const RUN_INSTANCE = /^test-(\d+)x[0-9a-f]{8}-/;

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

async function podman(args: readonly string[]): Promise<string> {
  try {
    return (await run("podman", [...args], { timeout: PODMAN_TIMEOUT_MS })).stdout;
  } catch (err) {
    throw new TestCellGuardFailed(`podman ${args.join(" ")}`, err instanceof Error ? err.message : String(err), { cause: err });
  }
}

/** Every container carrying an ashara.instance label, whoever made it. */
async function labelledContainers(): Promise<TestContainer[]> {
  const stdout = await podman(["ps", "-a", "--filter", `label=${LABEL_INSTANCE}`, "--format", "json"]);
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
async function remove(containers: readonly TestContainer[]): Promise<string> {
  if (containers.length === 0) return "nothing to remove";
  try {
    await podman(["rm", "-f", "--ignore", "-t", "0", ...containers.map((c) => c.id)]);
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

/** @testseam vitest.config.ts names this file as globalSetup, a reference knip does not read */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cellRun = `${process.pid}x${randomBytes(4).toString("hex")}`;
  await reapDeadRuns();
  project.provide("cellRun", cellRun);
  return async () => {
    const prefix = testInstancePrefix(cellRun);
    const leaked = (await labelledContainers()).filter((c) => (c.labels[LABEL_INSTANCE] ?? "").startsWith(prefix));
    if (leaked.length === 0) return;
    const removal = await remove(leaked);
    // vitest prints an error thrown here but still exits 0, and the exit code is the run's verdict.
    process.exitCode = 1;
    throw new TestCellsLeaked(cellRun, leaked, removal);
  };
}
