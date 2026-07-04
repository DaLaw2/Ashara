import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";

import { terminateProcessTree } from "./process-group.js";

// Findings (e)+(f), E2E Run 11: a "stop" must reap the WHOLE spawned tree — the
// npx/tsx/node wrapper chain and any app the smoke gate booted — leaving zero
// survivors. These tests use throwaway sleeper processes, never the real server
// or a real agent run (per the task's DB-safety constraint).

function errorCode(e: unknown): string | undefined {
  if (e instanceof Error && "code" in e && typeof e.code === "string") {
    return e.code;
  }
  return undefined;
}

// A process is "alive" if signal 0 succeeds, or fails with EPERM (exists but not
// ours). ESRCH means it is truly gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("terminateProcessTree", () => {
  test("reaps the whole process group — no survivors (findings e+f)", async () => {
    // A detached parent (group leader) that spawns a grandchild sleeper in the
    // same group — the shape of npx -> tsx -> node, or a smoke-boot app under
    // the gate. The parent prints the grandchild PID so the test can probe it.
    const parentScript = `
      const { spawn } = require('node:child_process');
      const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
      process.stdout.write('GC:' + gc.pid + '\\n');
      setInterval(() => {}, 1e9);
    `;
    const parent = spawn(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });

    const parentPid = parent.pid;
    if (parentPid === undefined) throw new Error("parent process has no pid");

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("grandchild pid not reported")), 5000);
      parent.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/GC:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(parseInt(match[1], 10));
        }
      });
      parent.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    // Both must be alive before the kill, else the test proves nothing.
    expect(isAlive(parentPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await terminateProcessTree(parent, { graceMs: 500, killMs: 2000 });

    // Signalling + reaping are async (a killed grandchild is briefly a zombie
    // until its reparented reaper collects it) — poll until both are gone.
    for (let i = 0; i < 30 && (isAlive(parentPid) || isAlive(grandchildPid)); i++) {
      await delay(100);
    }

    expect(isAlive(parentPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  });
});
