import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadBaseCell } from "@ashara/execution-infra";
import { TEST_IMAGES, pullCommand } from "./test-images.js";

// The guard's verdict is whether the vitest run it guards reaches a test, so each probe runs a
// vitest of its own with the guard as its globalSetup, against a stand-in podman that records every
// call and reports the images it is told to as absent.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const GUARD = path.join(HERE, "test-images-guard.ts");
const VITEST = path.resolve(ROOT, "node_modules/vitest/vitest.mjs");

let dir: string;

/** `podman image exists <ref>` exits 1 for a ref in PROBE_MISSING, PROBE_EXISTS_CODE otherwise; every call is logged. */
const FAKE_PODMAN = `#!/bin/sh
dir="$(dirname "$0")/.."
echo "$*" >> "$dir/calls"
if [ "$1" = "image" ] && [ "$2" = "exists" ]; then
  for ref in $PROBE_MISSING; do
    if [ "$ref" = "$3" ]; then exit 1; fi
  done
  exit "\${PROBE_EXISTS_CODE:-0}"
fi
exit 0
`;

const PROBE_TEST = `import { writeFileSync } from "node:fs";
import { test } from "vitest";
test("a test body the guard must keep from running", () => {
  writeFileSync(process.env.PROBE_DIR + "/ran", "");
});
`;

beforeAll(async () => {
  // Inside the package, so the probe's own test resolves vitest from node_modules.
  dir = await mkdtemp(path.join(HERE, "..", ".images-probe-"));
  await mkdir(path.join(dir, "bin"));
  await writeFile(path.join(dir, "bin", "podman"), FAKE_PODMAN);
  await chmod(path.join(dir, "bin", "podman"), 0o755);
  await writeFile(path.join(dir, "probe.test.ts"), PROBE_TEST);
  await writeFile(
    path.join(dir, "vitest.config.mjs"),
    `export default { test: { root: ${JSON.stringify(dir)}, include: ["probe.test.ts"], globalSetup: [${JSON.stringify(GUARD)}] } };\n`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ProbeRun {
  readonly code: number | null;
  readonly output: string;
  readonly testRan: boolean;
  readonly calls: readonly string[];
}

async function probe(missing: readonly string[], existsCode = 0): Promise<ProbeRun> {
  await rm(path.join(dir, "ran"), { force: true });
  await rm(path.join(dir, "calls"), { force: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("VITEST") && key !== "NODE_OPTIONS") env[key] = value;
  }
  Object.assign(env, {
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    PROBE_DIR: dir,
    PROBE_MISSING: missing.join(" "),
    PROBE_EXISTS_CODE: String(existsCode),
  });
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
    execFile(process.execPath, [VITEST, "run", "--config", path.join(dir, "vitest.config.mjs")], { cwd: dir, env, timeout: 90_000 }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : null, output: `${stdout}\n${stderr}` });
    });
  });
  const callsPath = path.join(dir, "calls");
  const calls = existsSync(callsPath) ? (await readFile(callsPath, "utf8")).split("\n").filter((line) => line !== "") : [];
  return { code, output, testRan: existsSync(path.join(dir, "ran")), calls };
}

function neverFetchesOrRemoves(calls: readonly string[]): void {
  for (const call of calls) {
    expect(call, calls.join("\n")).toMatch(/^image exists /);
    expect(call).not.toMatch(/\b(pull|rmi|prune|rm)\b/);
  }
}

describe("the pinned test image guard", () => {
  test("a run with one pinned image absent stops before any test, naming that image and its pull command", async () => {
    const run = await probe([TEST_IMAGES.git]);
    expect(run.code, run.output).not.toBe(0);
    expect(run.code, run.output).not.toBeNull();
    expect(run.testRan, run.output).toBe(false);
    expect(run.output).toContain("TestImagesMissingError");
    expect(run.output).toContain(pullCommand(TEST_IMAGES.git));
    expect(run.output).not.toContain(pullCommand(TEST_IMAGES.alpine));
    neverFetchesOrRemoves(run.calls);
  });

  test("every absent image, the BaseCell's included, is named in the one error", async () => {
    const base = (await loadBaseCell()).image;
    const run = await probe([base, TEST_IMAGES.alpine]);
    expect(run.code, run.output).not.toBe(0);
    expect(run.testRan, run.output).toBe(false);
    expect(run.output).toContain("2 pinned test image(s) absent");
    expect(run.output).toContain(pullCommand(base));
    expect(run.output).toContain(pullCommand(TEST_IMAGES.alpine));
    neverFetchesOrRemoves(run.calls);
  });

  test("a podman that cannot answer stops the run: an unknown presence is no evidence of one", async () => {
    const run = await probe([], 125);
    expect(run.code, run.output).not.toBe(0);
    expect(run.testRan, run.output).toBe(false);
    expect(run.output).toContain("TestImagesCheckFailed");
    neverFetchesOrRemoves(run.calls);
  });

  test("a run with every pinned image present runs its tests, having asked podman about each", async () => {
    const base = (await loadBaseCell()).image;
    const run = await probe([]);
    expect(run.code, run.output).toBe(0);
    expect(run.testRan, run.output).toBe(true);
    expect([...run.calls].sort()).toEqual([base, TEST_IMAGES.alpine, TEST_IMAGES.git].map((image) => `image exists ${image}`).sort());
  });
});

describe("the guard's wiring", () => {
  test("vitest.config.mts names the guard as its first globalSetup", async () => {
    const config = await readFile(path.join(ROOT, "vitest.config.mts"), "utf8");
    const list = /^\s*globalSetup:\s*\[([^\]]*)\]/m.exec(config)?.[1];
    if (list === undefined) return expect.unreachable("vitest.config.mts sets no globalSetup");
    expect(list.trim()).toMatch(/^"packages\/integration\/src\/test-images-guard\.ts"/);
  });

  test("no podman test pins an image of its own: every reference comes from test-images.json or config/base-cell.toml", async () => {
    const grep = await new Promise<{ code: unknown; stdout: string }>((resolve) => {
      execFile("git", ["grep", "-n", "docker.io/", "--", "packages/integration/src/**/*.podman.test.ts"], { cwd: ROOT }, (err, stdout) => {
        resolve({ code: err === null ? 0 : err.code, stdout });
      });
    });
    // git grep exits 1 for no match, 0 for a match, anything else for a failure of its own.
    expect(grep, grep.stdout).toEqual({ code: 1, stdout: "" });
  });
});
