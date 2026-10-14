import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFatalExit, reconcileOrRefuse } from "./fail-closed.js";
import { ServerStartupRefused } from "./secrets.js";

const FAIL_CLOSED_MODULE = fileURLToPath(new URL("./fail-closed.ts", import.meta.url));

afterEach(() => {
  vi.useRealTimers();
});

describe("fatal exit", () => {
  test("a rejection after boot, in a real process, runs the shutdown and exits non-zero with the cause chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashara-fatal-"));
    try {
      const script = join(dir, "entry.ts");
      writeFileSync(
        script,
        `import { createFatalExit } from ${JSON.stringify(FAIL_CLOSED_MODULE)};
const fatal = createFatalExit({ deadlineMs: 5000, exit: (c) => process.exit(c), log: (l) => console.error(l) });
process.on("uncaughtException", (e) => fatal.onFatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal.onFatal("unhandledRejection", e));
fatal.setShutdown(async () => { console.log("SHUTDOWN-RAN"); });
setInterval(() => {}, 1000);
void Promise.reject(new Error("outer failure", { cause: new Error("inner root cause") }));
`,
      );
      const run = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf-8", timeout: 20_000 });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("SHUTDOWN-RAN");
      expect(run.stderr).toContain("unhandledRejection");
      expect(run.stderr).toContain("outer failure");
      expect(run.stderr).toContain("inner root cause");
      // Logged through the one serializer: its JSON form, the cause nested under the error.
      expect(run.stderr).toMatch(/"cause": \{\s*"name": "Error",\s*"message": "inner root cause"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a shutdown that hangs is cut off at the deadline and the exit is still non-zero", () => {
    vi.useFakeTimers();
    const exit = vi.fn<(code: number) => void>();
    const lines: string[] = [];
    const fatal = createFatalExit({ deadlineMs: 1000, exit, log: (l) => lines.push(l) });
    fatal.setShutdown(() => new Promise<void>(() => {}));

    fatal.onFatal("uncaughtException", new Error("boom"));
    expect(exit).not.toHaveBeenCalled();
    fatal.onFatal("unhandledRejection", new Error("second"));
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.join("\n")).toContain("did not finish within 1000ms");
  });

  test("main() rejecting after boot runs the same shutdown and exits non-zero; a refused start says so", async () => {
    const exit = vi.fn<(code: number) => void>();
    const lines: string[] = [];
    const shutdown = vi.fn(async () => {});
    const fatal = createFatalExit({ deadlineMs: 1000, exit, log: (l) => lines.push(l) });
    fatal.setShutdown(shutdown);
    const main = async (): Promise<void> => {
      throw new ServerStartupRefused("the loop could not start", "work items", "fix the database", { cause: new Error("root") });
    };
    await main().catch((e: unknown) => fatal.onFatal("main", e));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("FATAL: server refused to start. the loop could not start");
    expect(lines.join("\n")).toContain("FATAL: main;");
    expect(lines.join("\n")).toContain("root");
  });

  test("an error whose report is hostile (huge fields, a revoked Proxy) still runs the shutdown and exits", async () => {
    const shared = "s".repeat(9_000_000);
    const huge = Object.assign(new Error("huge"), Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`f${i}`, shared])));
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const err of [huge, proxy]) {
      const exit = vi.fn<(code: number) => void>();
      const shutdown = vi.fn(async () => {});
      const fatal = createFatalExit({ deadlineMs: 1000, exit, log: () => {} });
      fatal.setShutdown(shutdown);
      fatal.onFatal("uncaughtException", err);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(shutdown).toHaveBeenCalledTimes(1);
    }

    const exit = vi.fn<(code: number) => void>();
    const shutdown = vi.fn(async () => {});
    const fatal = createFatalExit({
      deadlineMs: 1000,
      exit,
      log: () => {
        throw new Error("stderr closed");
      },
    });
    fatal.setShutdown(shutdown);
    expect(() => fatal.onFatal("uncaughtException", new Error("x"))).toThrow("stderr closed");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  test("before the shutdown exists the exit is immediate", () => {
    const exit = vi.fn<(code: number) => void>();
    createFatalExit({ deadlineMs: 1000, exit, log: () => {} }).onFatal("uncaughtException", new Error("during boot"));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("startup reconciliation", () => {
  test("a reconcile that throws refuses the start and keeps the original as cause", async () => {
    const original = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const refused: unknown = await reconcileOrRefuse(() => Promise.reject(original), "work items").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ServerStartupRefused);
    if (!(refused instanceof ServerStartupRefused)) return;
    expect(refused.cause).toBe(original);
    expect(refused.message).toContain("ECONNREFUSED");
  });
});
