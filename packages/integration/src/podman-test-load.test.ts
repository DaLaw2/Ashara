import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createVitest, type Vitest } from "vitest/node";
import { GUARD_PODMAN_BUDGET } from "./cell-leak-guard.js";
import {
  GUARD_PODMAN_TIMEOUT_MS,
  MEASURED_P95_MS,
  PODMAN_HOOK_TIMEOUT_MS,
  PODMAN_MAX_WORKERS,
  PODMAN_TEST_FILES,
  PODMAN_TEST_TIMEOUT_MS,
  TIMEOUT_MULTIPLE,
  killedAtTimeout,
  podmanTimeoutDetail,
} from "./podman-test-load.js";

// vitest.config.ts as vitest resolves it for the full suite's own command line: the podman files
// land in a project of their own whose worker bound a run's --maxWorkers does not replace, and
// every podman timeout is the stated multiple of its measured p95.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LANE_MAX_WORKERS = 12;

let vitest: Vitest;

function git(args: readonly string[]): string[] {
  return execFileSync("git", [...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })
    .split("\n")
    .filter((line) => line !== "");
}

/** Every test file that starts real podman work, found from the tree rather than from the config. */
function podmanTestFiles(): string[] {
  const named = git(["ls-files", "*.podman.test.ts"]);
  const constructing = git(["grep", "-l", "-F", "new PodmanSubstrate(", "--", "packages/integration/src/**/*.test.ts"]);
  return [...new Set([...named, ...constructing])].sort();
}

beforeAll(async () => {
  vitest = await createVitest("test", { root: ROOT, watch: false, run: true, reporters: [], maxWorkers: LANE_MAX_WORKERS });
}, 60_000);

afterAll(async () => {
  await vitest.close();
});

describe("the podman project", () => {
  test("holds every test file that starts real podman work, and no other project holds one", async () => {
    const expected = podmanTestFiles();
    expect(expected.length).toBeGreaterThan(0);
    const byProject = new Map<string, Set<string>>();
    for (const spec of await vitest.globTestSpecifications()) {
      const file = path.relative(ROOT, spec.moduleId).split(path.sep).join("/");
      const files = byProject.get(spec.project.name) ?? new Set<string>();
      files.add(file);
      byProject.set(spec.project.name, files);
    }
    expect([...(byProject.get("podman") ?? [])].sort()).toEqual(expected);
    for (const [name, files] of byProject) {
      if (name === "podman") continue;
      expect(
        expected.filter((f) => files.has(f)),
        `project ${name} also runs podman files`,
      ).toEqual([]);
    }
  });

  test("names no file that does not exist: an entry that matches nothing holds no test", () => {
    const unmatched = PODMAN_TEST_FILES.filter((entry) => git(["ls-files", "--", `:(glob)${entry}`]).length === 0);
    expect(unmatched).toEqual([]);
  });

  test("runs at most PODMAN_MAX_WORKERS files at once under the lane's --maxWorkers, in a group of its own", () => {
    const podman = vitest.projects.find((p) => p.name === "podman");
    if (podman === undefined) return expect.unreachable("vitest.config.ts defines no podman project");
    expect(vitest.config.maxWorkers).toBe(LANE_MAX_WORKERS);
    expect(PODMAN_MAX_WORKERS).toBeLessThan(LANE_MAX_WORKERS);
    expect(podman.config.maxWorkers).toBe(PODMAN_MAX_WORKERS);
    const others = vitest.projects.filter((p) => p !== podman);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(other.config.sequence.groupOrder).not.toBe(podman.config.sequence.groupOrder);
  });

  test("times its tests and hooks out at TIMEOUT_MULTIPLE times their measured p95", () => {
    const podman = vitest.projects.find((p) => p.name === "podman");
    if (podman === undefined) return expect.unreachable("vitest.config.ts defines no podman project");
    expect(PODMAN_TEST_TIMEOUT_MS).toBe(TIMEOUT_MULTIPLE * MEASURED_P95_MS.slowestTest);
    expect(PODMAN_HOOK_TIMEOUT_MS).toBe(TIMEOUT_MULTIPLE * MEASURED_P95_MS.slowestHook);
    expect(podman.config.testTimeout).toBe(PODMAN_TEST_TIMEOUT_MS);
    expect(podman.config.hookTimeout).toBe(PODMAN_HOOK_TIMEOUT_MS);
  });

  // A timeout passed to a test or hook call replaces the project's measured one.
  test("no podman file passes a timeout of its own to a test or hook", async () => {
    const own = /\},\s*[\d_]+\s*,?\s*\);/;
    const offenders: string[] = [];
    for (const file of podmanTestFiles()) {
      const lines = (await readFile(path.join(ROOT, file), "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (own.test(line) || /^\s*[\d_]+,\s*$/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("the guards' podman calls", () => {
  test("each is bounded at TIMEOUT_MULTIPLE times the measured p95 of the slowest of them", async () => {
    expect(GUARD_PODMAN_TIMEOUT_MS).toBe(TIMEOUT_MULTIPLE * MEASURED_P95_MS.slowestGuardCall);
    expect(GUARD_PODMAN_BUDGET.podmanTimeoutMs).toBe(GUARD_PODMAN_TIMEOUT_MS);
    const images = await readFile(path.join(ROOT, "packages/integration/src/test-images.ts"), "utf8");
    expect(images).toMatch(/run\("podman", \["image", "exists", image\], \{ timeout: GUARD_PODMAN_TIMEOUT_MS \}\)/);
  });

  test("a call killed at its bound says which call it was, how long it was given and where the bound comes from", () => {
    const killed = Object.assign(new Error("Command failed: podman ps"), { killed: true, signal: "SIGTERM" });
    expect(killedAtTimeout(killed)).toBe(true);
    expect(killedAtTimeout(Object.assign(new Error("spawnSync podman ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(killedAtTimeout(Object.assign(new Error("Command failed: podman ps"), { killed: false, code: 125 }))).toBe(false);
    const detail = podmanTimeoutDetail("podman ps -a", 1234);
    expect(detail).toContain("`podman ps -a` was killed after 1234 ms");
    expect(detail).toContain(`${GUARD_PODMAN_TIMEOUT_MS} ms`);
    expect(detail).toContain(`${MEASURED_P95_MS.slowestGuardCall} ms`);
  });
});
