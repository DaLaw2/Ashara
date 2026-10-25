import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { ClientRepository, ProjectRepository, createDb, resolveTestDatabaseUrl } from "@ashara/db";
import type { Database, DbTransaction } from "@ashara/db";
import { workItems } from "@ashara/db/schema/delivery";
import { attemptProfileOf } from "@ashara/delivery";
import { PodmanSubstrate, cellExecInterruptedOf, createCellBackend, environmentVersion } from "@ashara/execution-infra";
import type { Cell } from "@ashara/execution-infra";
import type { ContextualTurnLlm, CostedTurnResult, CostMeasurement, ResolvedModel } from "@ashara/finance";
import { TerminalSweeper, thrownBlocked } from "@ashara/quality";
import type { MainSweepDeps } from "@ashara/quality";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { notExercised, recordingLogger } from "@ashara/shared/testing";
import { serveAshara } from "@ashara/server/process-lifecycle";
import type { ServedComposition } from "@ashara/server/process-lifecycle";
import { DevSessionRepository, ORPHANED_SESSION_RESOLVER, runAttempt, terminalizeOrphanedSessions } from "@ashara/workplace";
import type { AttemptRecord } from "@ashara/workplace";

// A SIGTERM while commands run in cells: an agent's run_command and the environment test of a
// terminal sweep each hang in their cell (`sleep 3600`). The shutdown signal kills each podman exec,
// so the shutdown ends within its deadline; neither command is reported as a result (the attempt is
// cancelled, the sweep throws CellExecInterrupted, which a dispatch routes as interrupted, never as
// failed or blocked), both cells are removed, and the restart finds no container to reconcile and
// closes the dev session the process left open. The cells are a real PodmanSubstrate driving a
// stand-in podman binary: every exec is a real process that sleeps until it is killed, so no
// container is started.

const run = promisify(execFile);
const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NAME_PREFIX = `shutdown-cells-test-${randomUUID().slice(0, 8)}`;
/** The deadline the shutdown is given: far above a killed exec's settling, far below a hung command. */
const SHUTDOWN_DEADLINE_MS = 10_000;
/** How far past the shutdown's deadline this test waits before it fails the shutdown as unbounded. */
const TEST_BOUND_MARGIN_MS = 2_000;
/** How often the commands' start file is read: the poll waits at most this long past their start. */
const EXEC_POLL_MS = 5;
const HANG = "sleep 3600";
const LIMITS = { memoryBytes: 256 * 1024 * 1024, cpus: 0.5, pids: 64 };

/**
 * A podman stand-in: `run` records a container and prints its id, `exec` records its pid and sleeps
 * until killed, `rm` removes the container and records it, `ps` lists the containers left, `info`
 * answers. `state` is where it keeps them, baked in: podman runs with no environment of Ashara's.
 */
function fakePodman(state: string): string {
  return [
    "#!/bin/sh",
    `state='${state}'`,
    'case "$1" in',
    "  info) printf '%s\\n' '{\"version\":{\"Version\":\"5.0.0-fake\"},\"host\":{\"security\":{\"rootless\":true},\"cpus\":8,\"memTotal\":17179869184}}' ;;",
    "  run)",
    "    name=; instance=",
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in',
    '        --name) name=$2; shift ;;',
    '        --label) case "$2" in ashara.instance=*) instance=${2#ashara.instance=} ;; esac; shift ;;',
    "      esac",
    "      shift",
    "    done",
    "    id=$(printf '%s' \"$name\" | sha256sum | cut -c1-64)",
    "    printf '%s %s\\n' \"$id\" \"$instance\" >> \"$state/containers\"",
    "    printf '%s\\n' \"$id\" ;;",
    "  exec)",
    '    echo "$$" >> "$state/execs"',
    `    exec ${HANG} ;;`,
    "  rm)",
    '    for target; do :; done',
    '    touch "$state/containers"',
    '    grep -v "^$target " "$state/containers" > "$state/containers.next" || true',
    '    mv "$state/containers.next" "$state/containers"',
    '    echo "$target" >> "$state/removed" ;;',
    "  ps)",
    '    touch "$state/containers"',
    "    printf '['; sep=",
    '    while read -r id instance; do',
    "      printf '%s{\"Id\":\"%s\",\"Labels\":{\"ashara.managed\":\"1\",\"ashara.instance\":\"%s\"}}' \"$sep\" \"$id\" \"$instance\"; sep=,",
    '    done < "$state/containers"',
    "    printf ']\\n' ;;",
    '  *) echo "fake podman: unsupported $1" >&2; exit 125 ;;',
    "esac",
    "",
  ].join("\n");
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MEASURED: CostMeasurement = { measured: true, inputCost: 0.001, outputCost: 0.002, cacheSavings: 0, totalCost: 0.003 };

/** A model whose first turn runs `HANG` in the cell; any later turn fails the test. */
function hangingCommandModel(): { readonly llm: ContextualTurnLlm; readonly turns: () => number } {
  let turns = 0;
  const llm: ContextualTurnLlm = {
    forCall: () => ({
      async generateTurn(): Promise<CostedTurnResult> {
        turns += 1;
        if (turns > 1) throw new Error("no turn follows an interrupted command");
        const call = { kind: "valid" as const, toolCallId: "tc-1", toolName: "run_command", input: { command: HANG } };
        return {
          assistant: { role: "assistant", content: [{ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }] },
          text: "",
          toolCalls: [call],
          finishReason: "tool_calls",
          rawFinishReason: null,
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          reportedOutputTokens: 10,
          reportedInputTokens: 100,
          cost: MEASURED,
          provider: "fake",
          model: "fake-model",
        };
      },
    }),
  };
  return { llm, turns: () => turns };
}

const model: ResolvedModel = {
  model: "fake-model",
  modelId: "fake-model",
  provider: "fake",
  effectiveCapability: "Strong",
  modelConfig: {
    id: "fake-model",
    apiModelId: "fake-model",
    provider: "fake",
    capabilityLevel: "Strong",
    thinkingOffCapabilityLevel: "Strong",
    inputCostPer1M: 1,
    outputCostPer1M: 2,
    maxContextTokens: 100_000,
    cacheReadCostPer1M: null,
    cacheWriteCostPer1M: null,
    priceWindows: [],
    priceTiers: [],
    datedPrices: [],
  },
};

class RolledBack extends Error {
  constructor() {
    super("rolled back");
    this.name = "RolledBack";
  }
}

/** `work` in a transaction that is rolled back: the startup reconcile closes every open session in the database. */
async function rolledBack<T>(db: Database, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const box: { done?: { readonly value: T } } = {};
  try {
    await db.transaction(async (tx) => {
      box.done = { value: await work(tx) };
      throw new RolledBack();
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }
  if (box.done === undefined) throw new Error("the rolled-back transaction committed");
  return box.done.value;
}

let db: Database;
let root = "";
let state = "";
let podman = "";
let clientId = "";
let projectId: ProjectId;
const taskId = createWorkItemId();

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), `${NAME_PREFIX}-mount-`)));
  const bin = await realpath(await mkdtemp(join(tmpdir(), `${NAME_PREFIX}-bin-`)));
  state = join(bin, "state");
  await mkdir(state);
  podman = join(bin, "podman");
  await writeFile(podman, fakePodman(state));
  await chmod(podman, 0o755);

  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`${NAME_PREFIX}-client`)).id;
  projectId = (await new ProjectRepository(db).create(`${NAME_PREFIX}-project`, clientId)).id;
  await db.insert(workItems).values({ id: taskId, level: "Task", status: "InProgress", title: "Task whose attempt the shutdown interrupts", projectId });
});

afterAll(async () => {
  // A command no abort reached is still sleeping: end it, so a failed run leaves nothing behind.
  for (const pid of (await lines(join(state, "execs"))).map(Number)) if (alive(pid)) process.kill(pid, "SIGKILL");
  await db.execute(sql`DELETE FROM dev_sessions WHERE task_id = ${taskId}`);
  await db.execute(sql`DELETE FROM work_items WHERE id = ${taskId}`);
  await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
  await db.$client.end();
  await rm(root, { recursive: true, force: true });
  await rm(join(podman, ".."), { recursive: true, force: true });
});

/** A target repository whose main defines an environment whose test hangs. */
async function hangingTarget(): Promise<string> {
  const target = join(root, "target");
  const files: Record<string, string> = {
    "environment/environment.toml": `containerfile = "environment/Containerfile"\nrecipe = []\ninputs = []\nprobe = "true"\nbuild = "true"\ntest = "${HANG}"\n`,
    "environment/Containerfile": "FROM scratch\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(target, path, ".."), { recursive: true });
    await writeFile(join(target, path), content);
  }
  const git = (...args: string[]) => run("git", ["-C", target, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "main");
  return target;
}

describe("a shutdown while commands run in cells", () => {
  test("interrupts each command, removes every cell within the deadline, and the restart reconciles what is left", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const instance = `${NAME_PREFIX}-instance`;
    const logger = recordingLogger();
    const substrate = new PodmanSubstrate({ logger, podmanPath: podman, mountRoot: root, limits: LIMITS });
    const target = await hangingTarget();
    const shutdown = new AbortController();
    const sweepProject = parseProjectId(randomUUID(), "test");

    const teardowns: string[] = [];
    const sweepDeps: MainSweepDeps = {
      config: { workdirBase: join(root, "work") },
      cells: { substrate, instance, shutdownSignal: shutdown.signal },
      attemptPolicy: { perCommandTimeoutSeconds: 3600 },
      environment: {
        images: {
          build: async (request) => ({
            ...(await environmentVersion(request.repoGitDir, request.commit, request.definition)),
            projectId: request.projectId,
            imageRef: "ashara/test",
            network: "none",
            imageId: "image-1",
            reused: true,
          }),
          prune: notExercised("an image prune"),
        },
        statements: { record: notExercised("a statement"), forVersion: async () => "a shell environment" },
      },
      checks: { completedOf: async () => ({ checked: [], unchecked: [] }) },
      teardown: {
        teardownCell: async (_, cell) => {
          teardowns.push(cell.id);
          await cell.teardown();
        },
      },
    };

    // The dispatch opens its session before the attempt, as the session store does.
    const sessionId = randomUUID();
    await new DevSessionRepository(db).insert(sessionId, taskId, {}, null, "shutdown-cells-trace");
    const taskTree = join(root, "task");
    await mkdir(taskTree);
    const taskCell: Cell = await substrate.createCell({ image: "base", project: projectId, task: taskId, role: "worker", instance, mount: { hostPath: taskTree } });
    const { llm, turns } = hangingCommandModel();
    const records: AttemptRecord[] = [];

    const ended: { attempt?: Awaited<ReturnType<typeof runAttempt>>; sweep?: unknown } = {};
    const ashara: ServedComposition = {
      logger,
      booted: (work) => work(),
      port: 0,
      shutdownSignal: shutdown.signal,
      startup: async () => {},
      // The runner's cycle: an agent's command in its task cell, and a terminal sweep's check on main.
      runner: {
        run: async (signal) => {
          const [attempt, sweep] = await Promise.allSettled([
            runAttempt(
              {
                projectId,
                taskId,
                role: { id: "worker", name: "Worker" },
                ...attemptProfileOf(null),
                charter: { identity: "You are a coding agent.", duties: null },
                brief: {
                  goal: "Run the suite",
                  intent: "A long command",
                  visionVersion: 1,
                  assumptions: [],
                  interfaceEntries: [],
                  projectEnvironment: { kind: "to-define" },
                  context: "An empty workspace.",
                  deliverables: [],
                },
                model,
                cellImage: { kind: "base-cell", image: "base@sha256:" + "0".repeat(64), digest: "sha256:" + "0".repeat(64) },
                limits: { maxTurns: 4, perCommandTimeoutSeconds: 3600 },
              },
              {
                llm,
                cell: createCellBackend(taskCell, { toolTimeoutSeconds: 30, signal }),
                clock: { now: () => Date.now() },
                records: { append: async (record) => void records.push(record) },
                signal,
                environment: null,
                checks: null,
                taskChecks: null,
              },
            ),
            new TerminalSweeper(sweepDeps).sweepForTerminal(sweepProject, target),
          ]);
          if (attempt.status === "fulfilled") ended.attempt = attempt.value;
          ended.sweep = sweep.status === "rejected" ? sweep.reason : sweep.value;
          return null;
        },
      },
      abort: () => shutdown.abort(new Error("SIGTERM")),
      teardownCells: async () => {
        await substrate.teardownAll();
      },
      closeDatabase: async () => {},
    };
    const served = await serveAshara(ashara, () => ({ close: () => {} }), SHUTDOWN_DEADLINE_MS);

    // Both commands are running in their cells before the shutdown.
    const waitUntil = Date.now() + SHUTDOWN_DEADLINE_MS;
    while ((await lines(join(state, "execs"))).length < 2) {
      if (Date.now() > waitUntil) throw new Error("the two commands never started in their cells");
      await new Promise((resolve) => setTimeout(resolve, EXEC_POLL_MS));
    }
    const execs = (await lines(join(state, "execs"))).map(Number);
    expect(execs.every(alive)).toBe(true);

    // Bounded by this test, not by the shutdown's own deadline: a shutdown that never settles fails here.
    const started = Date.now();
    let bound: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      served.shutdown(),
      new Promise<"test-bound-passed">((resolve) => (bound = setTimeout(() => resolve("test-bound-passed"), SHUTDOWN_DEADLINE_MS + TEST_BOUND_MARGIN_MS))),
    ]).finally(() => clearTimeout(bound));
    expect(outcome).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_DEADLINE_MS);

    // Each command's process was killed.
    expect(execs.some(alive)).toBe(false);

    // The agent's command has no outcome: the attempt is cancelled by the shutdown, no tool result
    // is recorded or shown, and its one turn is measured, not an unknown cost.
    expect(ended.attempt).toMatchObject({ kind: "cancelled", reason: new Error("SIGTERM"), turnsUsed: 1 });
    expect(ended.attempt?.cost).toEqual({ measured: true, totalUsd: MEASURED.totalCost, turns: 1 });
    expect(records.map((record) => record.kind)).toEqual(["attempt_started", "turn", "outcome"]);
    expect(turns()).toBe(1);

    // The sweep's check has no outcome either: it threw the interruption, which a dispatch routes as
    // interrupted, never failed or blocked.
    const interrupted = cellExecInterruptedOf(ended.sweep);
    expect(interrupted?.reason).toEqual(new Error("SIGTERM"));
    const routed = thrownBlocked({ task: { id: taskId, attempt: 1 }, sessionId, stage: "checkRedRun", error: ended.sweep, where: { step: "red run", cell: "CI cell" }, agent: { outcome: null, agentWork: "none" }, eventSink: undefined, logger });
    expect(routed.status).toBe("interrupted");

    // Both cells were torn down (the sweep's by its own teardown, the task's by the shutdown) and no container is left.
    expect(teardowns).toHaveLength(1);
    expect(await lines(join(state, "removed"))).toEqual(expect.arrayContaining([taskCell.id, ...teardowns]));
    expect(await lines(join(state, "containers"))).toEqual([]);

    // The restart: no cell of this instance is left to reconcile, and the session left open is closed.
    const restarted = new PodmanSubstrate({ logger: recordingLogger(), podmanPath: podman, mountRoot: root, limits: LIMITS });
    expect(await restarted.reconcileOrphans(instance)).toEqual([]);
    const evidence = await rolledBack(db, async (tx) => {
      const repo = new DevSessionRepository(tx);
      const reconcile = await terminalizeOrphanedSessions(repo, [taskId]);
      return { reconcile, session: await repo.dispatchEvidence(taskId, ORPHANED_SESSION_RESOLVER) };
    });
    expect(evidence).toMatchObject({ reconcile: { kind: "terminalized", orphaned: 1 }, session: { latestPhase: "Failed", orphanedBefore: 1 } });
    vi.restoreAllMocks();
  });
});
