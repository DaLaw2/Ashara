import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GUARD_PODMAN_BUDGET } from "./cell-leak-guard.js";

// The guard's verdict is the exit code of the vitest run it guards, so each probe runs a vitest of
// its own with the guard as its globalSetup, against a stand-in podman: a run whose test "leaves" a
// cell exits non-zero, a removal that hangs past vitest's teardownTimeout does not hold the run, and
// a listing that hangs leaves the run failed.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "cell-leak-guard.ts");
const VITEST = path.resolve(HERE, "../../../node_modules/vitest/vitest.mjs");
const TEARDOWN_TIMEOUT_MS = 3_000;
/** Longer than the teardownTimeout: a removal this slow would still be running when vitest exits. */
const SLOW_REMOVAL_SECONDS = 30;

let dir: string;

/**
 * podman ps lists one cell of the probed run once its test wrote the run id, after PROBE_PS_SECONDS
 * when the end-of-run listing is to hang; podman rm takes PROBE_RM_SECONDS.
 */
const FAKE_PODMAN = `#!/bin/sh
dir="$(dirname "$0")/.."
case "$1" in
  ps)
    if [ -f "$dir/teardown" ] && [ -n "$PROBE_PS_SECONDS" ]; then exec sleep "$PROBE_PS_SECONDS"; fi
    if [ -f "$dir/cellrun" ]; then
      printf '[{"Id":"probe1","Names":["probe-cell"],"State":"running","Labels":{"ashara.instance":"test-%s-probe"}}]' "$(cat "$dir/cellrun")"
    else
      printf '[]'
    fi ;;
  rm) exec sleep "\${PROBE_RM_SECONDS:-0}" ;;
esac
`;

const PROBE_TEST = `import { writeFileSync } from "node:fs";
import { inject, test } from "vitest";
test("starts a cell it may leave behind", () => {
  writeFileSync(process.env.PROBE_DIR + "/teardown", "");
  if (process.env.PROBE_LEAK === "1") writeFileSync(process.env.PROBE_DIR + "/cellrun", inject("cellRun"));
});
`;

beforeAll(async () => {
  // Inside the package, so the probe's own test resolves vitest from node_modules.
  dir = await mkdtemp(path.join(HERE, "..", ".leak-probe-"));
  await mkdir(path.join(dir, "bin"));
  await writeFile(path.join(dir, "bin", "podman"), FAKE_PODMAN);
  await chmod(path.join(dir, "bin", "podman"), 0o755);
  await writeFile(path.join(dir, "probe.test.ts"), PROBE_TEST);
  await writeFile(
    path.join(dir, "vitest.config.mjs"),
    `export default { test: { root: ${JSON.stringify(dir)}, include: ["probe.test.ts"], globalSetup: [${JSON.stringify(GUARD)}], teardownTimeout: ${TEARDOWN_TIMEOUT_MS} } };\n`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ProbeRun {
  readonly code: number | null;
  readonly elapsedMs: number;
  readonly output: string;
}

async function probe(leak: boolean, removalSeconds: number, listingSeconds?: number): Promise<ProbeRun> {
  await rm(path.join(dir, "cellrun"), { force: true });
  await rm(path.join(dir, "teardown"), { force: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("VITEST") && key !== "NODE_OPTIONS") env[key] = value;
  }
  Object.assign(env, {
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    PROBE_DIR: dir,
    PROBE_LEAK: leak ? "1" : "0",
    PROBE_RM_SECONDS: String(removalSeconds),
    ...(listingSeconds === undefined ? {} : { PROBE_PS_SECONDS: String(listingSeconds) }),
  });
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [VITEST, "run", "--config", path.join(dir, "vitest.config.mjs")], { cwd: dir, env, timeout: 90_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
      resolve({ code, elapsedMs: Date.now() - started, output: `${stdout}\n${stderr}` });
    });
  });
}

describe("the end-of-run leak check", () => {
  test("a run that leaves a cell exits non-zero, and a removal slower than vitest's teardownTimeout is cut short", async () => {
    const run = await probe(true, SLOW_REMOVAL_SECONDS);
    expect(run.code, run.output).not.toBe(0);
    expect(run.code, run.output).not.toBeNull();
    expect(run.output).toContain("TestCellsLeaked");
    expect(run.elapsedMs).toBeLessThan(SLOW_REMOVAL_SECONDS * 1000);
  });

  // Nothing is leaked, so only a code set before podman is asked can make this run fail: a code set
  // once the listing returned, or after the removal, never is.
  test("a run whose end-of-run listing hangs past the teardownTimeout exits non-zero", async () => {
    const run = await probe(false, 0, SLOW_REMOVAL_SECONDS);
    expect(run.code, run.output).not.toBe(0);
    expect(run.code, run.output).not.toBeNull();
    expect(run.elapsedMs).toBeLessThan(SLOW_REMOVAL_SECONDS * 1000);
  });

  test("a run that leaves nothing keeps its exit code 0", async () => {
    const run = await probe(false, 0);
    expect(run.code, run.output).toBe(0);
  });
});

// The guard's podman work is bounded by PODMAN_TIMEOUT_MS per call; the run around it has to wait
// that long, or a removal in progress is cut off and the cells are left to a later run's reaper.
describe("the bounds around the guard", () => {
  const ROOT = path.resolve(HERE, "../../..");

  test("vitest.config.mts sets a teardownTimeout whose share for the end-of-run check covers its podman worst case", async () => {
    const config = await readFile(path.join(ROOT, "vitest.config.mts"), "utf8");
    const set = /^\s*teardownTimeout:\s*([\d_]+),/m.exec(config)?.[1];
    if (set === undefined) return expect.unreachable("vitest.config.mts sets no teardownTimeout: vitest's 10 s default would cut the check short");
    expect(Number(set.replaceAll("_", "")) * GUARD_PODMAN_BUDGET.teardownShare).toBeGreaterThanOrEqual(GUARD_PODMAN_BUDGET.worstCaseMs);
  });

});
