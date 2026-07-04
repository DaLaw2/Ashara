import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, test, expect, vi } from "vitest";

import { runVerifyCore, InvalidVerifyPathError } from "./verify-core.js";
import type { CoreVerifyInput } from "./verify-core.js";

// ---------------------------------------------------------------------------
// GIT-SAFETY (a, mig-phase-2 t2): workDir/gitRoot are required and validated
// at the single choke point both adapters (verify.ts, inline-verify.ts) route
// through. A request that omits/mis-supplies either must fail closed with a
// typed error BEFORE any command runs — never fall back to the ambient cwd.
// ---------------------------------------------------------------------------

const baseInput: Omit<CoreVerifyInput, "workDir" | "gitRoot"> = {
  checks: [],
};

describe("runVerifyCore — GIT-SAFETY (a) fail-closed workdir validation", () => {
  test("empty workDir throws InvalidVerifyPathError and never invokes the command runner", async () => {
    const runCommand = vi.fn();

    await expect(
      runVerifyCore({ ...baseInput, workDir: "", gitRoot: "/tmp/valid" }, { runCommand }),
    ).rejects.toBeInstanceOf(InvalidVerifyPathError);

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("relative (non-absolute) workDir throws and never invokes the command runner", async () => {
    const runCommand = vi.fn();

    await expect(
      runVerifyCore({ ...baseInput, workDir: "relative/path", gitRoot: "/tmp/valid" }, { runCommand }),
    ).rejects.toBeInstanceOf(InvalidVerifyPathError);

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("empty gitRoot throws even when workDir is valid", async () => {
    const runCommand = vi.fn();

    await expect(
      runVerifyCore({ ...baseInput, workDir: "/tmp/valid", gitRoot: "" }, { runCommand }),
    ).rejects.toBeInstanceOf(InvalidVerifyPathError);

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("error carries structured context (field, received, reason) — Discipline C", async () => {
    let caught: unknown;
    try {
      await runVerifyCore({ ...baseInput, workDir: "", gitRoot: "/tmp/valid" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InvalidVerifyPathError);
    if (caught instanceof InvalidVerifyPathError) {
      expect(caught.field).toBe("workDir");
      expect(caught.received).toBe("");
      expect(caught.reason).toContain("non-empty");
    }
  });

  test("valid absolute workDir/gitRoot pass validation and proceed to checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-core-valid-"));
    try {
      const runCommand = vi.fn(async () => ({ exitCode: 0, output: "" }));

      const result = await runVerifyCore(
        { ...baseInput, workDir: dir, gitRoot: dir },
        { runCommand },
      );

      // Empty dir has no project markers, so all builtin checks are skipped —
      // the point here is only that validation did not block it.
      expect(result.tiers.deterministic.status).toBe("pass");
      expect(result.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

