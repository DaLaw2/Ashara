import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GUARD_PODMAN_BUDGET } from "../packages/integration/src/cell-leak-guard.js";
import { PODMAN_MAX_WORKERS } from "../packages/integration/src/podman-test-load.js";
import { BUDGET_PROFILES, runBound, type SuiteFile } from "./test-run-budget.js";
import { profileOf } from "./test-run-profile.js";
import { PROGRESS_ENV } from "./test-run-progress.js";
import { boundedRun, KILL_GRACE_MS, LEADER_SOURCE, planRun, RUN_EXPECTED, RUN_FINISHED, runTests } from "./test-run.js";

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

/** How long a child process may take to write a file a test waits on: a node start and one write. */
const WRITTEN_DEADLINE_MS = 15_000;

/**
 * Resolves once `file` exists, polling at a short interval: the event is a child process's write.
 * Past `deadlineMs`, fails naming the file.
 */
async function written(file: string, deadlineMs: number = WRITTEN_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} was not written within ${deadlineMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

/** How long a stopped run's group may take to be gone: its stand-ins die on the first SIGTERM. */
const GROUP_GONE_DEADLINE_MS = 15_000;

/** Resolves once process group `pgid` has no live process left; past `deadlineMs`, fails naming the processes still in it. */
async function groupGone(pgid: number, deadlineMs: number = GROUP_GONE_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (let left = groupMembers(pgid); left.length > 0; left = groupMembers(pgid)) {
    if (Date.now() > deadline) throw new Error(`process group ${pgid} still has process(es) ${left.join(", ")} ${deadlineMs} ms after its run was stopped`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Kills what is left of process group `pgid`; a group gone before the kill is no failure. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

/**
 * A stand-in for vitest: a process that starts a worker, as vitest's forks pool does, each writing
 * its pid to `dir`, both running until stopped. The main process first records `finished` as
 * finished test files in the progress file PROGRESS_ENV names, as the progress reporter would.
 */
function vitestStandIn(dir: string, finished: readonly string[] = []): string {
  const worker = `require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "worker"))}, String(process.pid)); setInterval(() => {}, 1000);`;
  const progress = finished.map((file) => `require("node:fs").appendFileSync(process.env.${PROGRESS_ENV}, ${JSON.stringify(`${file}\n`)});`).join(" ");
  return `const { spawn } = require("node:child_process"); ${progress} spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "main"))}, String(process.pid)); setInterval(() => {}, 1000);`;
}

/**
 * A recipe of the justfile as a justfile of its own, its attributes kept, its dependencies dropped
 * and `npx tsx` replaced by a stand-in that prints the arguments it is given as JSON.
 */
function recipeWithArgvStandIn(name: string, printer: string): string {
  const justfile = fs.readFileSync(path.join(REPO, "justfile"), "utf-8");
  const match = new RegExp(`((?:^\\[[^\\n]*\\]\\n)*)^(${name}(?: [^\\n:]*)?):[^\\n]*\\n((?: {4}.*\\n|\\n)+)`, "m").exec(justfile);
  if (match === null) throw new Error(`the justfile has no recipe ${name}`);
  const [, attributes = "", header = "", body = ""] = match;
  return `${attributes}${header}:\n${body.replaceAll("npx tsx", `node ${JSON.stringify(printer)}`)}`;
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
    const command = /^\s+npx tsx scripts\/test-run\.ts (.*?) -- (.+)$/m.exec(step);
    if (command === null) return expect.unreachable("CI's Test suite step does not run scripts/test-run.ts with vitest arguments");
    const own = (command[1] ?? "").trim().split(/\s+/);
    const args = (command[2] ?? "").trim().split(/\s+/);
    // The bound is derived from figures measured on CI's runner, never on another host.
    expect(own).toContain("--profile=ci");
    // The workers are this runner's vCPUs, read on the runner, so the bound is derived at the count the run uses.
    expect(args.filter((arg) => arg.startsWith("--maxWorkers="))).toEqual(["--maxWorkers=$(nproc)"]);
    const within = Number(own.find((arg) => arg.startsWith("--within="))?.slice("--within=".length));
    const stepMinutes = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
    const jobMinutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)?.[1]);
    // The run refuses a bound that does not fit in --within, which leaves the step its plan's time.
    expect(within).toBeLessThan(stepMinutes * 60);
    expect(jobMinutes).toBeGreaterThan(stepMinutes);
    // At the vCPUs of the runner the ci figures were measured on, the run's own stop, its bound and
    // the SIGKILL grace after it, fits in --within, so a correct run is never refused.
    expect(BUDGET_PROFILES.ci.workers.length).toBeGreaterThan(0);
    for (const vcpus of BUDGET_PROFILES.ci.workers) {
      const { bound } = await planRun(REPO, [], args.map((arg) => arg.replace("$(nproc)", String(vcpus))), "ci");
      expect(bound.rule).toContain("measured on the ci host");
      expect(within).toBeGreaterThanOrEqual(bound.seconds + KILL_GRACE_MS / 1000);
    }
  });

  test("a run whose bound and SIGKILL grace do not fit in the time its caller gives it fails before any test, naming both", async () => {
    await expect(runTests(REPO, ["scripts/test-run.test.ts"], ["--maxWorkers=2"], { profile: "dev", withinS: 60 })).rejects.toThrow(/SIGKILL grace exceed the 60 s its caller gives it.*no test ran/);
  });

  test("`just test` and `just test-affected` pass each caller argument through as one argument, a quoted one with spaces included", () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const printer = path.join(scratch, "argv.js");
    fs.writeFileSync(printer, "console.log(JSON.stringify(process.argv.slice(2)));");
    const justfile = path.join(scratch, "justfile");
    const run = (recipeName: string, ...args: string[]): unknown => {
      fs.writeFileSync(justfile, recipeWithArgvStandIn(recipeName, printer));
      const output = execFileSync("just", ["--justfile", justfile, "--working-directory", REPO, recipeName, ...args], { encoding: "utf-8", timeout: 60_000 });
      return JSON.parse(output.trim().split("\n").at(-1) ?? "");
    };
    expect(run("test", "--", "-t", "a b")).toEqual(["scripts/test-run.ts", "--profile=dev", "--", "-t", "a b"]);
    expect(run("test-affected", "origin/master", "--list", "--", "-t", "a b")).toEqual(["scripts/affected-tests.ts", "origin/master", "--profile=dev", "--list", "--", "-t", "a b"]);
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
    const run = boundedRun({ file: process.execPath, args: ["-e", leader] }, REPO, { seconds: 60, rule: "probe" }, [], { signals: terminal });
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
    const run = boundedRun({ file: process.execPath, args: ["-e", finishesOne] }, REPO, { seconds: 60, rule: "probe" }, ["a.test.ts", "b.test.ts", "c.test.ts"], { signals: caller });
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

  test("a runner killed outright takes its run's whole process group with it, and its leader names every test file the run did not finish", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const runner = `import { boundedRun } from ${JSON.stringify(path.join(REPO, "scripts", "test-run.ts"))};
await boundedRun({ file: process.execPath, args: ["-e", ${JSON.stringify(vitestStandIn(scratch, ["a.test.ts"]))}] }, ${JSON.stringify(REPO)}, { seconds: 600, rule: "probe" }, ["a.test.ts", "b.test.ts", "c.test.ts"]);`;
    const runnerFile = path.join(scratch, "runner.mts");
    fs.writeFileSync(runnerFile, runner);
    const stderr = path.join(scratch, "stderr");
    const stderrFd = fs.openSync(stderr, "w");
    // The loader, not tsx's CLI: the CLI runs the script in a child of its own, which a SIGKILL of the CLI leaves running.
    const loader = path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
    const child = spawn(process.execPath, ["--import", loader, runnerFile], { cwd: REPO, stdio: ["ignore", "ignore", stderrFd] });
    fs.closeSync(stderrFd);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const group = await standInGroup(scratch);
    cleanups.push(() => killGroup(group));
    expect(group).not.toBe(groupOf(process.pid));
    expect(groupMembers(group).length).toBeGreaterThanOrEqual(3);
    child.kill("SIGKILL");
    await exited;
    await groupGone(group);
    expect(groupMembers(group)).toEqual([]);
    const report = fs.readFileSync(stderr, "utf-8");
    expect(report).toContain("the runner that started this run is gone");
    expect(report).toContain("2 of 3 test file(s) did not finish");
    expect(report).toMatch(/^ {2}b\.test\.ts$/m);
    expect(report).toMatch(/^ {2}c\.test\.ts$/m);
    expect(report).not.toMatch(/^ {2}a\.test\.ts$/m);
  }, 30_000);

  test("a runner gone while its pipe to the run's leader is still held elsewhere still takes the run with it: the leader watches its parent", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    // The runner's stand-in gives the leader the reading end of a FIFO whose writing end another
    // process holds past the runner's death: only the leader's watch on its parent can see the runner go.
    const fifo = path.join(scratch, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const holder = spawn(process.execPath, ["-e", `require("node:fs").openSync(${JSON.stringify(fifo)}, "w"); setInterval(() => {}, 1000);`], { stdio: "ignore" });
    cleanups.push(() => holder.kill("SIGKILL"));
    // The run's directory as the runner makes one: the files it expects, and the progress file the stand-in appends to.
    const runDir = path.join(scratch, "run");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, RUN_EXPECTED), "a.test.ts\nb.test.ts\n");
    const stderr = path.join(scratch, "stderr");
    const runner = `const fs = require("node:fs"); const { spawn } = require("node:child_process"); const pipe = fs.openSync(${JSON.stringify(fifo)}, "r"); spawn(process.execPath, ["-e", process.env.LEADER, "60000", ${JSON.stringify(runDir)}, process.execPath, "-e", process.env.STAND_IN], { detached: true, stdio: [pipe, "ignore", fs.openSync(${JSON.stringify(stderr)}, "w")] }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", runner], { stdio: "ignore", env: { ...process.env, LEADER: LEADER_SOURCE, STAND_IN: vitestStandIn(scratch, ["a.test.ts"]), [PROGRESS_ENV]: path.join(runDir, RUN_FINISHED) } });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const group = await standInGroup(scratch);
    cleanups.push(() => killGroup(group));
    child.kill("SIGKILL");
    await exited;
    await groupGone(group);
    expect(groupMembers(group)).toEqual([]);
    const report = fs.readFileSync(stderr, "utf-8");
    expect(report).toContain("the leader's parent changed");
    expect(report).toContain("1 of 2 test file(s) did not finish");
    expect(report).toMatch(/^ {2}b\.test\.ts$/m);
    expect(report).not.toMatch(/^ {2}a\.test\.ts$/m);
    // No runner is left to remove the run's directory, so the leader does.
    expect(fs.existsSync(runDir)).toBe(false);
  }, 30_000);

  test("a run that outlives its SIGTERM after its runner is killed outright is still killed, and its leader still names every test file it did not finish", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const runDir = path.join(scratch, "run");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, RUN_EXPECTED), "a.test.ts\nb.test.ts\n");
    const stderr = path.join(scratch, "stderr");
    // A stand-in that ignores SIGTERM, as a hung run does: only the leader's grace SIGKILL ends it.
    const standIn = `process.on("SIGTERM", () => {}); ${vitestStandIn(scratch, ["a.test.ts"])}`;
    const runner = `const fs = require("node:fs"); const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", process.env.LEADER, "500", ${JSON.stringify(runDir)}, process.execPath, "-e", process.env.STAND_IN], { detached: true, stdio: ["pipe", "ignore", fs.openSync(${JSON.stringify(stderr)}, "w")] }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", runner], { stdio: "ignore", env: { ...process.env, LEADER: LEADER_SOURCE, STAND_IN: standIn, [PROGRESS_ENV]: path.join(runDir, RUN_FINISHED) } });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const group = await standInGroup(scratch);
    cleanups.push(() => killGroup(group));
    child.kill("SIGKILL");
    await exited;
    await groupGone(group);
    const report = fs.readFileSync(stderr, "utf-8");
    expect(report).toContain("the runner that started this run is gone");
    expect(report).toContain("1 of 2 test file(s) did not finish");
    expect(report).toMatch(/^ {2}b\.test\.ts$/m);
    expect(report).not.toMatch(/^ {2}a\.test\.ts$/m);
    expect(fs.existsSync(runDir)).toBe(false);
  }, 30_000);

  test("waiting for a child process's write is bounded, and names the file not written", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const never = path.join(scratch, "never");
    await expect(written(never, 200)).rejects.toThrow(`${never} was not written within 200 ms`);
  });

  test("waiting for a stopped run's group is bounded, and names the processes still in it", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-run-"));
    const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
    const pid = survivor.pid;
    if (pid === undefined) return expect.unreachable("the survivor did not start");
    cleanups.push(() => killGroup(pid));
    await expect(groupGone(pid, 200)).rejects.toThrow(new RegExp(`process group ${pid} still has process\\(es\\) ${pid} 200 ms after`));
    killGroup(pid);
    await groupGone(pid);
    // The group is gone before this kill: a cleanup that finds nothing to kill does not fail.
    expect(() => killGroup(pid)).not.toThrow();
  });
});

describe("a run's plan, as vitest resolves it", () => {
  test("a filter's bound is the bound of the files it selects, not the whole suite's", async () => {
    const whole = await planRun(REPO, [], ["--maxWorkers=2"], "dev");
    const filtered = await planRun(REPO, [], ["--maxWorkers=2", "scripts/test-run"], "dev");
    const expected = whole.files.filter((file) => file.path.includes("scripts/test-run"));
    expect(expected.length).toBeGreaterThan(0);
    expect(filtered.files).toEqual(expected);
    expect(filtered.bound).toEqual(runBound(expected, "dev"));
    expect(filtered.bound.seconds).toBeLessThan(whole.bound.seconds);
  });

  test("a percentage of workers resolves against the host's cores, as vitest resolves it", async () => {
    const cores = os.availableParallelism();
    const plan = await planRun(REPO, ["scripts/test-run.test.ts"], ["--maxWorkers=50%"], "dev");
    expect(plan.files.map((file) => file.workers)).toEqual([Math.max(1, Math.min(cores, Math.round(cores / 2)))]);
  });

  test("the podman group runs, and is budgeted, at the lower of its project's own workers and the run's: the caller's count is a ceiling", async () => {
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
    expect(PODMAN_MAX_WORKERS).toBeGreaterThan(2);
    expect(podmanWorkers).toBe(Math.min(2, PODMAN_MAX_WORKERS));
    const plan = await planRun(REPO, [], ["--maxWorkers=2"], "dev");
    const podmanFiles = plan.files.filter((file) => file.project === "podman");
    expect(podmanFiles.length).toBeGreaterThan(0);
    expect(new Set(podmanFiles.map((file) => file.workers))).toEqual(new Set([podmanWorkers]));
    expect(new Set(plan.files.filter((file) => file.project !== "podman").map((file) => file.workers))).toEqual(new Set([2]));
    expect(plan.bound.rule).toContain(`${podmanFiles.length} in group 1 at ${podmanWorkers} worker(s)`);
    const atOne = plan.files.map((file): SuiteFile => (file.project === "podman" ? { ...file, workers: 1 } : file));
    expect(runBound(atOne, "dev").seconds).toBeGreaterThan(plan.bound.seconds);
    // Above the podman project's own, the run's count leaves it at its own.
    const wide = await planRun(REPO, [], [`--maxWorkers=${PODMAN_MAX_WORKERS + 1}`], "dev");
    expect(new Set(wide.files.filter((file) => file.project === "podman").map((file) => file.workers))).toEqual(new Set([PODMAN_MAX_WORKERS]));
  });

  test("a host's profile is derived from the per-file wall times its runs recorded, the larger of the runs' for each rank", () => {
    const run = (podman: number, simulator: number, others: readonly number[]): { path: string; project: string; wallMs: number }[] => [
      { path: "packages/integration/src/a.podman.test.ts", project: "podman", wallMs: podman },
      { path: "packages/integration/src/simulator/a.test.ts", project: "default", wallMs: simulator },
      ...others.map((wallMs, index) => ({ path: `packages/p/src/f${index}.test.ts`, project: "default", wallMs })),
    ];
    const others = Array.from({ length: 12 }, (_, index) => 1000 * (12 - index));
    const profile = profileOf([run(5000, 9000, others), run(7000, 8000, others.map((ms) => ms / 2))]);
    expect(profile.classes.podman).toEqual({ heaviestS: [7], restMeanS: 7 });
    expect(profile.classes.simulator).toEqual({ heaviestS: [9], restMeanS: 9 });
    expect(profile.classes.other).toEqual({ heaviestS: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3], restMeanS: 1.5 });
    expect(profile.suite).toEqual({ files: 14, fileWallS: 92 });
    expect(() => profileOf([run(5000, 9000, []).slice(1)])).toThrow(/no run recorded a file of this class/);
  });
});
