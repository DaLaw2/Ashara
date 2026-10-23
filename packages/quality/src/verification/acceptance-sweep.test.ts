import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { environmentVersion, SubstrateUnavailable } from "@ashara/execution-infra";
import type { Cell } from "@ashara/execution-infra";
import { parseProjectId } from "@ashara/shared";
import { notExercised } from "@ashara/shared/testing";
import { SCAFFOLD_PLACEHOLDER_MARKER } from "../scaffold-placeholder.js";
import { AcceptanceSweeper, observeAcceptanceSweeps } from "./acceptance-sweep.js";
import type { AcceptanceSweep, MainSweepDeps } from "./acceptance-sweep.js";
import { TerminalSweeper } from "./terminal-sweep.js";

const projectId = parseProjectId("22222222-2222-4222-8222-222222222222", "test");

/** Deps whose substrate probe throws `probeError`, and nothing past the probe may be reached. */
function probeFailing(probeError: Error): MainSweepDeps {
  return {
    config: { workdirBase: "/srv/base" },
    cells: {
      substrate: {
        probeSubstrate: async () => {
          throw probeError;
        },
        createCell: notExercised("a cell"),
      },
      instance: "instance-1",
      shutdownSignal: new AbortController().signal,
    },
    attemptPolicy: { perCommandTimeoutSeconds: 30 },
    environment: { images: { build: notExercised("an image build"), prune: notExercised("an image prune") }, statements: { record: notExercised("a statement"), forVersion: notExercised("a statement") } },
    checks: { completedOf: notExercised("the stored checks") },
    teardown: { teardownCell: notExercised("a teardown") },
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function observing(): AcceptanceSweep[] {
  const seen: AcceptanceSweep[] = [];
  restore = observeAcceptanceSweeps((sweep) => void seen.push(sweep));
  return seen;
}

describe("AcceptanceSweeper", () => {
  test("a substrate that does not answer leaves the sweep unrunnable, nothing decided, and the observer sees it", async () => {
    const seen = observing();
    const sweep = await new AcceptanceSweeper(probeFailing(new SubstrateUnavailable("podman", "socket gone"))).sweepForAcceptance(projectId, "/srv/target", ["g1"], []);
    expect(sweep.kind).toBe("unrunnable");
    expect(seen).toEqual([sweep]);
  });

  test("any other failure is a fault at the step it stopped at, never the machines' and never a verdict", async () => {
    observing();
    const sweep = await new AcceptanceSweeper(probeFailing(new TypeError("bug"))).sweepForAcceptance(projectId, "/srv/target", ["g1"], []);
    expect(sweep.kind).toBe("faulted");
    if (sweep.kind !== "faulted") return;
    expect(sweep.mainCommit).toBeNull();
    expect(sweep.error.message).toContain("probe the substrate failed: TypeError: bug");
  });
});

const run = promisify(execFile);
const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const DEFINITION = [
  'containerfile = "environment/Containerfile"',
  "recipe = []",
  "inputs = []",
  'probe = "true"',
  'build = "true"',
  'test = "echo tested"',
  "",
].join("\n");

/**
 * A target whose main holds an environment and `product`, swept in cells that run each command on
 * the host checkout; the environment's own test is the only suite, and it passes.
 */
async function hostSweep(product: Readonly<Record<string, string>>): Promise<{ readonly target: string; readonly deps: MainSweepDeps }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acceptance-sweep-marker-")));
  scratch.push(root);
  const target = join(root, "target");
  await mkdir(join(target, "environment"), { recursive: true });
  const git = (...args: string[]) => run("git", ["-C", target, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "-q", "-b", "main");
  await writeFile(join(target, "environment", "environment.toml"), DEFINITION);
  await writeFile(join(target, "environment", "Containerfile"), "FROM scratch\n");
  for (const [path, content] of Object.entries(product)) {
    await mkdir(join(target, path, ".."), { recursive: true });
    await writeFile(join(target, path), content);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "main");
  const hostCell = (hostPath: string): Cell => ({
    id: "host-stand-in",
    spec: { image: "none", project: "p", task: "t", role: "ci", instance: "test", mount: { hostPath } },
    exec: async (argv) => {
      const [command, ...args] = argv;
      if (command === undefined) throw new TypeError("a cell was asked to run no command");
      const { stdout, stderr } = await run(command, args, { cwd: hostPath });
      return { exitCode: 0, stdout, stderr, timedOut: false, statusLost: false, stdoutCut: null, stderrCut: null };
    },
    teardown: async () => {},
  });
  const deps: MainSweepDeps = {
    config: { workdirBase: join(root, "work") },
    cells: {
      substrate: { probeSubstrate: async () => ({ version: "5", rootless: true }), createCell: async (spec) => hostCell(spec.mount.hostPath) },
      instance: "instance-1",
      shutdownSignal: new AbortController().signal,
    },
    attemptPolicy: { perCommandTimeoutSeconds: 30 },
    environment: {
      images: {
        build: async (request) => ({
          ...(await environmentVersion(request.repoGitDir, request.commit, request.definition)),
          projectId: request.projectId,
          imageRef: "ashara/test:v1",
          network: "none",
          imageId: "image-1",
          reused: true,
        }),
        prune: notExercised("an image prune"),
      },
      statements: { record: notExercised("a statement"), forVersion: async () => "a shell environment" },
    },
    checks: { completedOf: async () => ({ checked: [], unchecked: [] }) },
    teardown: { teardownCell: async () => {} },
  };
  return { target, deps };
}

describe("the scaffold placeholder's marker on main", () => {
  test("a main any tracked file of which still holds the marker fails acceptance, naming each file:line first", async () => {
    observing();
    const { target, deps } = await hostSweep({
      "public/index.php": `<?php\nif (ctype_digit($id)) { show($id); }\nhttp_response_code(501); echo "${SCAFFOLD_PLACEHOLDER_MARKER}";\n`,
      "src/refuse.c": `int refuse(void) {\n  puts("${SCAFFOLD_PLACEHOLDER_MARKER}");\n  return 2;\n}\n`,
    });
    const sweep = await new AcceptanceSweeper(deps).sweepForAcceptance(projectId, target, [], []);
    expect(sweep.kind).toBe("ran");
    if (sweep.kind !== "ran") return;
    expect(sweep.passed).toBe(false);
    expect(sweep.placeholder).toEqual({
      kind: "searched",
      hits: [{ file: "public/index.php", line: 3 }, { file: "src/refuse.c", line: 2 }],
    });
    expect(sweep.details.split("\n")[0]).toContain("still on main at public/index.php:3, src/refuse.c:2");
    expect(sweep.details).toContain("environment test");
  });

  test("the same main without the marker passes", async () => {
    observing();
    const { target, deps } = await hostSweep({ "public/index.php": "<?php\nshow($id);\n", "PUBLIC_INTERFACE.md": "GET /members/{id}\n" });
    const sweep = await new AcceptanceSweeper(deps).sweepForAcceptance(projectId, target, [], []);
    if (sweep.kind === "faulted") throw sweep.error;
    expect(sweep).toMatchObject({ kind: "ran", passed: true });
  });

  test("the terminal sweep judges no acceptance, so it holds no marker against main", async () => {
    const { target, deps } = await hostSweep({ "main.c": `/* ${SCAFFOLD_PLACEHOLDER_MARKER} */\n`, "PUBLIC_INTERFACE.md": "run: ./main\n" });
    const sweep = await new TerminalSweeper(deps).sweepForTerminal(projectId, target);
    if (sweep.kind === "faulted") throw sweep.error;
    expect(sweep).toMatchObject({ kind: "ran", passed: true });
  });
});

describe("TerminalSweeper", () => {
  test("runs the same sweep of main, but the acceptance observer never sees it", async () => {
    const seen = observing();
    const sweep = await new TerminalSweeper(probeFailing(new SubstrateUnavailable("podman", "socket gone"))).sweepForTerminal(projectId, "/srv/target");
    expect(sweep.kind).toBe("unrunnable");
    expect(seen).toEqual([]);
  });
});
