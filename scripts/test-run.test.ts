import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GUARD_PODMAN_BUDGET } from "../packages/integration/src/cell-leak-guard.js";
import { runBound, type SuiteFile } from "./test-run-budget.js";
import { boundedRun, KILL_GRACE_MS, LEADER_SOURCE, planRun } from "./test-run.js";

const REPO = path.join(import.meta.dirname, "..");

let scratch: string | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** The body of a justfile recipe, its indented lines after its header. */
function recipe(name: string): string {
  const justfile = fs.readFileSync(path.join(REPO, "justfile"), "utf-8");
  const body = new RegExp(`^${name}(?: [^\\n]*)?:[^\\n]*\\n((?: {4}.*\\n|\\n)+)`, "m").exec(justfile)?.[1];
  if (body === undefined) throw new Error(`the justfile has no recipe ${name}`);
  return body;
}

/** The lines of a YAML or shell text with their comments dropped. */
function uncommented(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*#/.test(line));
}

/** The text of CI's test job, its lines up to the next job. */
function ciTestJob(): string {
  const workflow = fs.readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf-8");
  const job = /^ {2}test:\n((?: {4}.*\n|\s*\n)+)/m.exec(workflow)?.[1];
  if (job === undefined) throw new Error("ci.yml has no test job");
  return job;
}

/** Resolves once `file` exists, polling at a short interval: the event is a child process's write. */
async function written(file: string): Promise<void> {
  while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The live (not zombie) processes of process group `pgid`, read from /proc. */
function groupMembers(pgid: number): number[] {
  const members: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, "utf-8");
    } catch {
      continue; // The process ended between the listing and the read.
    }
    // `pid (comm) state ppid pgrp ...`; comm may hold spaces and parentheses, so fields count from its last ')'.
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (state !== "Z" && Number(pgrp) === pgid) members.push(Number(entry));
  }
  return members;
}

/** The process group of `pid`, read from /proc. */
function groupOf(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

/** Resolves once process group `pgid` has no live process left. */
async function groupGone(pgid: number): Promise<void> {
  while (groupMembers(pgid).length > 0) await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * A stand-in for vitest: a process that starts a worker, as vitest's forks pool does, each writing
 * its pid to `dir`, both running until stopped.
 */
function vitestStandIn(dir: string): string {
  const worker = `require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "worker"))}, String(process.pid)); setInterval(() => {}, 1000);`;
  return `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "main"))}, String(process.pid)); setInterval(() => {}, 1000);`;
}

/** Resolves to the process group of a started vitestStandIn once both its processes are up. */
async function standInGroup(dir: string): Promise<number> {
  await written(path.join(dir, "main"));
  await written(path.join(dir, "worker"));
  const main = groupOf(Number(fs.readFileSync(path.join(dir, "main"), "utf-8")));
  expect(groupOf(Number(fs.readFileSync(path.join(dir, "worker"), "utf-8")))).toBe(main);
  return main;
}

describe("the bounded test run", () => {
  test("`just test` and `just test-affected` run vitest through the bounded runners, under no fixed timeout of their own", () => {
    expect(recipe("test")).toMatch(/^ {4}exec npx tsx scripts\/test-run\.ts /m);
    expect(recipe("test-affected")).toMatch(/^ {4}exec npx tsx scripts\/affected-tests\.ts /m);
    for (const name of ["test", "test-affected"]) expect(recipe(name)).not.toMatch(/\btimeout\b/);
  });

  test("the justfile and CI start vitest only through scripts/test-run.ts, and CI's test job outlasts the bound of the run it starts", async () => {
    const vitestCommand = /(?:^|[\s/;&|(])vitest(?:\.mjs)?(?:\s|$)/;
    for (const file of ["justfile", ".github/workflows/ci.yml"]) {
      const starts = uncommented(fs.readFileSync(path.join(REPO, file), "utf-8")).filter((line) => vitestCommand.test(line));
      expect(starts, `${file} starts vitest other than through scripts/test-run.ts`).toEqual([]);
    }
    const job = ciTestJob();
    const step = /^ {6}- name: Test suite\n((?: {8}.*\n)+)/m.exec(job)?.[1];
    if (step === undefined) return expect.unreachable("CI's test job has no Test suite step");
    const args = /^\s+npx tsx scripts\/test-run\.ts -- (.+)$/m.exec(step)?.[1]?.trim().split(/\s+/);
    if (args === undefined) return expect.unreachable("CI's Test suite step does not run scripts/test-run.ts");
    // The bound depends on the workers, so CI names its own rather than take the host's.
    expect(args.some((arg) => arg.startsWith("--maxWorkers="))).toBe(true);
    const stepMinutes = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
    const jobMinutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1]);
    const { bound } = await planRun(REPO, [], args);
    // The run's own stop, its bound and the SIGKILL grace after it, comes before CI's.
    expect(stepMinutes * 60).toBeGreaterThanOrEqual(bound.seconds + KILL_GRACE_MS / 1000);
    expect(jobMinutes).toBeGreaterThan(stepMinutes);
  });

  test("past its bound, the run waits out the cell-leak guard's signal-time removal before its SIGKILL", () => {
    expect(KILL_GRACE_MS).toBeGreaterThanOrEqual(GUARD_PODMAN_BUDGET.worstCaseMs);
  });

  test("a terminal's Ctrl+C reaches every process of the run's group, not its leader alone, and the run fails", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const ready = path.join(scratch, "ready");
    const heard = path.join(scratch, "heard");
    const grandchild = `const fs = require("node:fs"); process.on("SIGINT", () => { fs.writeFileSync(${JSON.stringify(heard)}, "SIGINT"); process.exit(0); }); fs.writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000);`;
    const leader = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" }); process.on("SIGINT", () => {}); child.on("exit", () => process.exit(0));`;
    const terminal = new EventEmitter();
    const run = boundedRun({ file: process.execPath, args: ["-e", leader] }, REPO, { seconds: 60, rule: "probe" }, [], terminal);
    await written(ready);
    terminal.emit("SIGINT", "SIGINT");
    expect(await run).toEqual({ exitCode: 128 + os.constants.signals.SIGINT, report: "test-run: the run was stopped by SIGINT;\n0 of 0 test file(s) did not finish:" });
    expect(fs.readFileSync(heard, "utf-8")).toBe("SIGINT");
  });

  test("a run a caller's SIGTERM stops fails naming every test file it did not finish", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const ready = path.join(scratch, "ready");
    const finishesOne = `const fs = require("node:fs"); fs.appendFileSync(process.env.ASHARA_TEST_RUN_PROGRESS, "a.test.ts\\n"); fs.writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000);`;
    const caller = new EventEmitter();
    const run = boundedRun({ file: process.execPath, args: ["-e", finishesOne] }, REPO, { seconds: 60, rule: "probe" }, ["a.test.ts", "b.test.ts", "c.test.ts"], caller);
    await written(ready);
    caller.emit("SIGTERM", "SIGTERM");
    const result = await run;
    expect(result.exitCode).toBe(128 + os.constants.signals.SIGTERM);
    expect(result.report).toContain("the run was stopped by SIGTERM");
    expect(result.report).toContain("2 of 3 test file(s) did not finish");
    expect(result.report).toMatch(/^ {2}b\.test\.ts$/m);
    expect(result.report).toMatch(/^ {2}c\.test\.ts$/m);
    expect(result.report).not.toMatch(/^ {2}a\.test\.ts$/m);
  });

  test("a runner killed outright takes its run's whole process group with it: no test or worker outlives the run that started it", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const runner = `import { boundedRun } from ${JSON.stringify(path.join(REPO, "scripts", "test-run.ts"))};
await boundedRun({ file: process.execPath, args: ["-e", ${JSON.stringify(vitestStandIn(scratch))}] }, ${JSON.stringify(REPO)}, { seconds: 600, rule: "probe" }, []);`;
    const runnerFile = path.join(scratch, "runner.mts");
    fs.writeFileSync(runnerFile, runner);
    // The loader, not tsx's CLI: the CLI runs the script in a child of its own, which a SIGKILL of the CLI leaves running.
    const loader = path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
    const child = spawn(process.execPath, ["--import", loader, runnerFile], { cwd: REPO, stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const group = await standInGroup(scratch);
    cleanups.push(() => {
      if (groupMembers(group).length > 0) process.kill(-group, "SIGKILL");
    });
    expect(group).not.toBe(groupOf(process.pid));
    expect(groupMembers(group).length).toBeGreaterThanOrEqual(3);
    child.kill("SIGKILL");
    await exited;
    await groupGone(group);
    expect(groupMembers(group)).toEqual([]);
  }, 30_000);

  test("a runner gone while its pipe to the run's leader is still held elsewhere still takes the run with it: the leader watches its parent", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    // The runner's stand-in gives the leader the reading end of a FIFO whose writing end another
    // process holds past the runner's death: only the leader's watch on its parent can see the runner go.
    const fifo = path.join(scratch, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const holder = spawn(process.execPath, ["-e", `require("node:fs").openSync(${JSON.stringify(fifo)}, "w"); setInterval(() => {}, 1000);`], { stdio: "ignore" });
    cleanups.push(() => holder.kill("SIGKILL"));
    const runner = `const fs = require("node:fs"); const { spawn } = require("node:child_process"); const pipe = fs.openSync(${JSON.stringify(fifo)}, "r"); spawn(process.execPath, ["-e", process.env.LEADER, "60000", process.execPath, "-e", process.env.STAND_IN], { detached: true, stdio: [pipe, "ignore", "ignore"] }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", runner], { stdio: "ignore", env: { ...process.env, LEADER: LEADER_SOURCE, STAND_IN: vitestStandIn(scratch) } });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const group = await standInGroup(scratch);
    cleanups.push(() => {
      if (groupMembers(group).length > 0) process.kill(-group, "SIGKILL");
    });
    child.kill("SIGKILL");
    await exited;
    await groupGone(group);
    expect(groupMembers(group)).toEqual([]);
  }, 30_000);
});

describe("a run's plan, as vitest resolves it", () => {
  test("a filter's bound is the bound of the files it selects, not the whole suite's", async () => {
    const whole = await planRun(REPO, [], ["--maxWorkers=2"]);
    const filtered = await planRun(REPO, [], ["--maxWorkers=2", "scripts/test-run"]);
    const expected = whole.files.filter((file) => file.path.includes("scripts/test-run"));
    expect(expected.length).toBeGreaterThan(0);
    expect(filtered.files).toEqual(expected);
    expect(filtered.bound).toEqual(runBound(expected));
    expect(filtered.bound.seconds).toBeLessThan(whole.bound.seconds);
  });

  test("a percentage of workers resolves against the host's cores, as vitest resolves it", async () => {
    const cores = os.availableParallelism();
    const plan = await planRun(REPO, ["scripts/test-run.test.ts"], ["--maxWorkers=50%"]);
    expect(plan.files.map((file) => file.workers)).toEqual([Math.max(1, Math.min(cores, Math.round(cores / 2)))]);
  });

  test("the podman group is budgeted at the workers vitest runs it on, its project's own, whatever the run is given", async () => {
    const vitestNode = await import("vitest/node");
    const vitest = await vitestNode.createVitest("test", { root: REPO, watch: false, run: true, reporters: [], maxWorkers: 2 });
    let podmanWorkers: number;
    try {
      const podman = vitest.projects.find((project) => project.name === "podman");
      if (podman === undefined) return expect.unreachable("vitest.config.mts defines no podman project");
      podmanWorkers = podman.config.maxWorkers;
    } finally {
      await vitest.close();
    }
    const plan = await planRun(REPO, [], ["--maxWorkers=2"]);
    const podmanFiles = plan.files.filter((file) => file.project === "podman");
    expect(podmanFiles.length).toBeGreaterThan(0);
    expect(new Set(podmanFiles.map((file) => file.workers))).toEqual(new Set([podmanWorkers]));
    expect(new Set(plan.files.filter((file) => file.project !== "podman").map((file) => file.workers))).toEqual(new Set([2]));
    expect(plan.bound.rule).toContain(`${podmanFiles.length} in group 1 at ${podmanWorkers} worker(s)`);
    const atOne = plan.files.map((file): SuiteFile => (file.project === "podman" ? { ...file, workers: 1 } : file));
    expect(runBound(atOne).seconds).toBeGreaterThan(plan.bound.seconds);
  });
});
