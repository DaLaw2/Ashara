import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { testCellInstance } from "../test-cells.js";
import { TEST_IMAGES } from "../test-images.js";

// The hidden-suite runner (scripts/hidden-suite.ts) on real podman, no skip, against throwaway suites and products
// this file writes: a suite's verdict is judged by the runner, and a suite that crashes, hangs, omits a guarantee,
// writes no valid verdict or changes its own files never reads as pass.

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
/** A busybox image, pinned like the BaseCell. */
const ALPINE_IMAGE = TEST_IMAGES.alpine;
const run = promisify(execFile);

const storedVerdictSchema = z.object({
  tender: z.string(),
  overall: z.enum(["pass", "fail", "incomplete"]),
  guarantees: z.array(z.object({ id: z.string(), verdict: z.enum(["pass", "fail", "unjudged"]), reason: z.string().optional() })),
  problems: z.array(z.string()),
});
type StoredVerdict = z.infer<typeof storedVerdictSchema>;

const MANIFEST = 'tender = "T0"\n\n[[guarantee]]\nid = "G1"\n\n[[guarantee]]\nid = "G2"\n';

/** Parses `--cmd <program> --out <file>`, then judges G1 (the program prints 42) and G2 (the build ran). */
const SUITE_HEAD = String.raw`#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    --cmd) CMD=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) echo "run: unknown argument $1" >&2; exit 2 ;;
  esac
done
g1=fail; [ "$("$CMD")" = 42 ] && g1=pass
g2=fail; [ -f "$(dirname "$CMD")/built.txt" ] && g2=pass
verdict() { printf '{"tender":"T0","guarantees":[%s],"complete":true}\n' "$1" > "$OUT"; }
both='{"id":"G1","verdict":"'$g1'","cases":1,"evidence":[]},{"id":"G2","verdict":"'$g2'","cases":1}'
`;

const SUITES: Record<string, string> = {
  honest: `${SUITE_HEAD}verdict "$both"\n`,
  crashes: `${SUITE_HEAD}verdict '{"id":"G1","verdict":"pass"},{"id":"G2","verdict":"pass"}'\nexit 1\n`,
  omits: `${SUITE_HEAD}verdict '{"id":"G1","verdict":"pass"}'\n`,
  garbage: `${SUITE_HEAD}printf 'not a verdict' > "$OUT"\n`,
  silent: `${SUITE_HEAD}exit 0\n`,
  hangs: `${SUITE_HEAD}verdict "$both"\nsleep 600\n`,
  tampers: `${SUITE_HEAD}verdict "$both"\necho '# changed' >> "$0"\n`,
};

let root = "";

async function product(name: string, answer: string): Promise<string> {
  const dir = join(root, "products", name);
  await mkdir(join(dir, "environment"), { recursive: true });
  await writeFile(
    join(dir, "environment", "environment.toml"),
    'containerfile = "environment/Containerfile"\nrecipe = []\ninputs = []\nprobe = "true"\nbuild = "echo built > built.txt"\ntest = "true"\n',
  );
  await writeFile(join(dir, "answer.sh"), `#!/bin/sh\necho ${answer}\n`);
  await chmod(join(dir, "answer.sh"), 0o755);
  return dir;
}

async function suite(name: string): Promise<string> {
  const dir = join(root, "suites", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "GUARANTEES.toml"), MANIFEST);
  const script = SUITES[name];
  if (script === undefined) throw new Error(`no suite fixture named ${name}`);
  await writeFile(join(dir, "run"), script);
  await chmod(join(dir, "run"), 0o755);
  return dir;
}

async function runner(suiteName: string, productDir: string, timeoutSeconds = 60): Promise<{ status: number; verdict: StoredVerdict; output: string }> {
  const out = join(root, "verdicts", `${suiteName}-${Math.random().toString(36).slice(2)}.json`);
  const argv = [
    "tsx", "scripts/hidden-suite.ts",
    "--suite", await suite(suiteName),
    "--product", productDir,
    "--image", ALPINE_IMAGE,
    "--out", out,
    "--timeout", String(timeoutSeconds),
    "--instance", testCellInstance(),
    "--", "--cmd", "{product}/answer.sh",
  ];
  let status = 0;
  let output = "";
  try {
    const result = await run("npx", argv, { cwd: REPO_ROOT, env: process.env });
    output = `${result.stdout}${result.stderr}`;
  } catch (err) {
    const failure = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(err);
    status = failure.code;
    output = `${failure.stdout}${failure.stderr}`;
  }
  const verdict = storedVerdictSchema.parse(JSON.parse(await readFile(out, "utf8")));
  return { status, verdict, output };
}

function verdictOf(verdict: StoredVerdict, id: string): string | undefined {
  return verdict.guarantees.find((entry) => entry.id === id)?.verdict;
}

let good = "";
let bad = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ashara-hidden-suite-test-")));
  good = await product("good", "42");
  bad = await product("bad", "41");
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("hidden-suite runner on real podman", () => {
  it("a product the honest suite passes reads pass on every guarantee, after its own build ran in the cell", async () => {
    const { status, verdict, output } = await runner("honest", good);
    expect(output).toContain("hidden-suite: tender T0 overall pass");
    expect(verdict.overall).toBe("pass");
    expect(verdict.guarantees.map((entry) => [entry.id, entry.verdict])).toEqual([["G1", "pass"], ["G2", "pass"]]);
    expect(verdict.problems).toEqual([]);
    expect(status).toBe(0);
  }, 120_000);

  it("a product the honest suite fails reads fail on that guarantee and overall", async () => {
    const { status, verdict } = await runner("honest", bad);
    expect(verdictOf(verdict, "G1")).toBe("fail");
    expect(verdictOf(verdict, "G2")).toBe("pass");
    expect(verdict.overall).toBe("fail");
    expect(status).toBe(1);
  }, 120_000);

  it("a suite that writes a passing verdict and then crashes reads incomplete, every guarantee unjudged", async () => {
    const { status, verdict } = await runner("crashes", good);
    expect(verdict.overall).toBe("incomplete");
    expect(verdict.guarantees.map((entry) => entry.verdict)).toEqual(["unjudged", "unjudged"]);
    expect(verdict.problems.join("\n")).toContain("exited 1");
    expect(status).toBe(3);
  }, 120_000);

  it("a guarantee the verdict omits is unjudged, and the run is not a pass", async () => {
    const { status, verdict } = await runner("omits", good);
    expect(verdictOf(verdict, "G1")).toBe("pass");
    expect(verdictOf(verdict, "G2")).toBe("unjudged");
    expect(verdict.overall).toBe("incomplete");
    expect(status).toBe(3);
  }, 120_000);

  it.each([
    ["garbage", "the verdict file is invalid"],
    ["silent", "the suite wrote no verdict file"],
    ["tampers", "the suite's files changed while it ran"],
  ])("suite %s reads incomplete, never pass", async (name, problem) => {
    const { status, verdict } = await runner(name, good);
    expect(verdict.overall).toBe("incomplete");
    expect(verdict.guarantees.every((entry) => entry.verdict === "unjudged")).toBe(true);
    expect(verdict.problems.join("\n")).toContain(problem);
    expect(status).toBe(3);
  }, 120_000);

  it("a suite that outlives its bound reads incomplete even though its verdict says pass", async () => {
    const { status, verdict } = await runner("hangs", good, 3);
    expect(verdict.overall).toBe("incomplete");
    expect(verdict.guarantees.every((entry) => entry.verdict === "unjudged")).toBe(true);
    expect(verdict.problems.join("\n")).toContain("did not finish within 3 s");
    expect(status).toBe(3);
  }, 120_000);
});
