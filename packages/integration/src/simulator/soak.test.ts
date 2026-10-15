import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const run = promisify(execFile);

interface Soak {
  readonly exitCode: number;
  /** stdout without what is not a function of the seeds: each run's `ms` and the stale-database notice. */
  readonly lines: readonly string[];
}

/** A run that exited non-zero: execFile rejects with its exit code and output. */
function failedSoak(err: unknown): Soak | null {
  if (!(err instanceof Error) || !("code" in err) || typeof err.code !== "number" || !("stdout" in err) || typeof err.stdout !== "string") return null;
  return { exitCode: err.code, lines: canonical(err.stdout) };
}

function canonical(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => !line.startsWith("dropped "))
    .map((line) => line.replace(/, \d+ ms$/, ""));
}

/** The soak tier as a reader runs it: scripts/simulate.ts in its own process, on the test's database server. */
async function soak(jobs: number, args: readonly string[] = ["--seeds", "2", "--start", "75"]): Promise<Soak> {
  try {
    const { stdout } = await run("npx", ["tsx", "scripts/simulate.ts", ...args, "--jobs", String(jobs)], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, lines: canonical(stdout) };
  } catch (err) {
    const failed = failedSoak(err);
    if (failed === null) throw err;
    return failed;
  }
}

describe("simulate.ts --jobs", () => {
  // Seeds 75-76 at one project: seed 75 fails its listed B8 key (expected-failures.ts), so the
  // replay line is compared too. A worker's seed is a function of the seed and the mode alone (owner
  // 2026-10-15, ADR-081): in two processes at once, every line but the time is the serial run's.
  it("reports every seed as the serial run does, in seed order", async () => {
    const serial = await soak(1);
    const parallel = await soak(2);
    expect(serial.lines.filter((line) => line.startsWith("seed ")).map((line) => line.split(" (")[0])).toEqual(["seed 75", "seed 76"]);
    expect(serial.lines.some((line) => line.includes("(known: listed in expected-failures.ts)"))).toBe(true);
    expect(parallel).toEqual(serial);
    expect(serial.exitCode).toBe(0);
  }, 300_000);

  // The adversarial profile's misbehaviour is drawn from the tape like every other choice, so its
  // seeds too are a function of the seed alone; the coverage lines (MODEL_PATHS met) are compared too.
  it("reports every adversarial seed as the serial run does", async () => {
    const args = ["--seeds", "3", "--start", "11", "--profile", "adversarial"];
    const serial = await soak(1, args);
    const parallel = await soak(3, args);
    expect(serial.lines.some((line) => line.startsWith("model misbehaviour met (MODEL_PATHS)"))).toBe(true);
    expect(parallel).toEqual(serial);
    expect(serial.exitCode).toBe(0);
  }, 300_000);
});
