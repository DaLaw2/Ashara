import { describe, test, expect, vi } from "vitest";
import { runDeterministicChecks } from "./check-runner.js";
import type { CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// runDeterministicChecks — zero-check identity-element trap (Discipline A)
//
// "The identity element of a collection, a conjunction, or a sum always reads
// as fine — that is a property of arithmetic, not evidence about the world."
// An empty loop over zero checks must not produce status "pass".
// ---------------------------------------------------------------------------

describe("runDeterministicChecks — zero checks", () => {
  const stubRunner: CommandRunner = async () => ({ exitCode: 0, output: "" });

  test("zero checks must not produce a pass status", async () => {
    const result = await runDeterministicChecks(stubRunner, "/tmp/test", []);
    expect(result.tier.status).not.toBe("pass");
    expect(result.tier.details).not.toContain("All 0 checks passed");
  });

  test("zero checks produces skipped status with empty checks array", async () => {
    const result = await runDeterministicChecks(stubRunner, "/tmp/test", []);
    expect(result.tier.status).toBe("skipped");
    expect(result.tier.checks).toEqual([]);
  });

  // HTTP-assertion strings are no longer a check dialect: one runs as a shell
  // command like any other and fails closed when the shell rejects it.
  test("an HTTP-assertion string is executed as a shell command", async () => {
    const run = vi.fn<CommandRunner>(async () => ({ exitCode: 127, output: "GET: not found" }));
    const result = await runDeterministicChecks(run, "/tmp/test", ["GET /health returns 200"]);
    expect(run).toHaveBeenCalledWith(["sh", "-c", "GET /health returns 200"], "/tmp/test", expect.any(Number));
    expect(result.tier.status).toBe("fail");
  });
});
