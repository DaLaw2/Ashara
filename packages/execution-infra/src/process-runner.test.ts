import { describe, expect, it } from "vitest";
import { renderElided } from "@ashara/shared";
import { elidedOutput, spawnProcess } from "./process-runner.js";

function run(script: string, maxOutputBytes: number) {
  return spawnProcess({ file: process.execPath, args: ["-e", script], env: {}, maxOutputBytes, killAfterMs: 30_000 });
}

describe("spawnProcess output cap", () => {
  it("keeps output within the cap whole", async () => {
    const result = await run(`process.stdout.write("short")`, 100);
    expect(result.stdout).toBe("short");
    expect(result.stdoutCut).toBeNull();
  });

  it("keeps the head and the tail of output past the cap, across many writes, and counts what it cut", async () => {
    const script =
      `process.stdout.write("H".repeat(40));` +
      `for (let i = 0; i < 200; i++) process.stdout.write("m".repeat(1000));` +
      `process.stdout.write("T".repeat(60));`;
    const result = await run(script, 100);
    expect(result.stdout).toBe(`${"H".repeat(40)}${"T".repeat(60)}`);
    expect(result.stdoutCut).toEqual({ at: 40, chars: 200_000 });
    expect(renderElided(elidedOutput(result.stdout, result.stdoutCut))).toBe(
      `${"H".repeat(40)}\n[truncated by Ashara: 200000 characters cut here]\n${"T".repeat(60)}`,
    );
  });

  it("never splits a character at a cut, and counts the characters cut as the decoded text would", async () => {
    // 3-byte "€" (1 UTF-16 unit) and 4-byte "😀" (2 units). Head budget 40 bytes ends inside the 14th "€".
    const script = `process.stdout.write("€".repeat(1000)); process.stdout.write("😀".repeat(1000));`;
    const result = await run(script, 100);
    const units = 1000 + 2 * 1000;
    expect(result.stdout).toBe(`${"€".repeat(13)}${"😀".repeat(15)}`);
    expect(result.stdoutCut).toEqual({ at: 13, chars: units - 13 - 30 });
  });
});

describe("spawnProcess abort", () => {
  const idle = ["-e", "setTimeout(() => {}, 60_000)"];

  it("kills the child once its signal aborts, long before the host backstop", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const running = spawnProcess({ file: process.execPath, args: idle, env: {}, maxOutputBytes: 100, killAfterMs: 60_000, signal: abort.signal });
    setTimeout(() => abort.abort(new Error("SIGTERM")), 50);
    expect(await running).toMatchObject({ exitCode: null, signal: "SIGKILL", killedByHost: false });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills at once a child whose signal had already aborted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("SIGTERM"));
    const result = await spawnProcess({ file: process.execPath, args: idle, env: {}, maxOutputBytes: 100, killAfterMs: 60_000, signal: abort.signal });
    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL" });
  });
});
