import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";
import { runVerifyCore, InvalidVerifyPathError } from "./verify-core.js";
import type { CoreVerifyInput, CoreVerifyDeps, CommandRunner } from "./verify-core.js";

// ---------------------------------------------------------------------------
// GIT-SAFETY (a, mig-phase-2 t2): workDir/gitRoot are required and validated
// at runVerifyCore, the single choke point every verify caller routes
// through. A request that omits/mis-supplies either must fail closed with a
// typed error BEFORE any command runs — never fall back to the ambient cwd.
// ---------------------------------------------------------------------------

const baseInput: Omit<CoreVerifyInput, "workDir" | "gitRoot"> = {
  checks: [],
  contractChecks: [],
};

function makeDeps(overrides: Partial<CoreVerifyDeps> = {}): CoreVerifyDeps {
  return {
    runCommand: vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" })),
    ...overrides,
  };
}

describe("runVerifyCore — GIT-SAFETY (a) fail-closed workdir validation", () => {
  test("empty workDir throws InvalidVerifyPathError and never invokes the command runner", async () => {
    const deps = makeDeps();

    await expect(
      runVerifyCore({ ...baseInput, workDir: "", gitRoot: "/tmp/valid" }, deps),
    ).rejects.toBeInstanceOf(InvalidVerifyPathError);

    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  test("relative (non-absolute) workDir throws and never invokes the command runner", async () => {
    const deps = makeDeps();

    await expect(
      runVerifyCore({ ...baseInput, workDir: "relative/path", gitRoot: "/tmp/valid" }, deps),
    ).rejects.toBeInstanceOf(InvalidVerifyPathError);

    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  test("empty gitRoot throws even when workDir is valid", async () => {
    const deps = makeDeps();

    await expect(
      runVerifyCore({ ...baseInput, workDir: "/tmp/valid", gitRoot: "" }, deps),
    ).rejects.toBeInstanceOf(InvalidVerifyPathError);

    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  test("error carries structured context (field, received, reason) — Discipline C", async () => {
    const deps = makeDeps();
    let caught: unknown;
    try {
      await runVerifyCore({ ...baseInput, workDir: "", gitRoot: "/tmp/valid" }, deps);
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
      const deps = makeDeps();

      const result = await runVerifyCore(
        { ...baseInput, workDir: dir, gitRoot: dir },
        deps,
      );

      // Empty dir has no project markers and no custom checks, so nothing is
      // executable — the point here is only that validation did not block it.
      expect(result.verdict).toBe("unverified");
      expect(result.tiers.deterministic.status).toBe("skipped");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Contract check wiring
// ---------------------------------------------------------------------------

describe("runVerifyCore — contract checks replace baseline injection", () => {
  test("contract checks run when no verify.toml and no taskSpec checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-contract-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: [], contractChecks: ["cargo check"], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.verdict).toBe("passed");
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("cargo check");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contract checks deduplicate against taskSpec checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-dedup-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: ["npm test", "cargo check"],
          contractChecks: ["cargo check", "cargo clippy"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("passed");
      const checks = result.tiers.deterministic.checks ?? [];
      // cargo check from contract, cargo clippy from contract, npm test from taskSpec
      // Order: contract first, then unique taskSpec
      expect(checks).toHaveLength(3);
      expect(checks[0].name).toBe("cargo check");
      expect(checks[1].name).toBe("cargo clippy");
      expect(checks[2].name).toBe("npm test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no contract checks + no taskSpec checks produces unverified verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-empty-"));
    try {
      const log = vi.fn();
      const deps = makeDeps({ log });
      const result = await runVerifyCore(
        { checks: [], contractChecks: [], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.verdict).toBe("unverified");
      expect(result.tiers.deterministic.status).toBe("skipped");

      const warningEvent = log.mock.calls.find(
        (c) => (c[0] as Record<string, unknown>).event === "verify_no_checks_warning",
      );
      expect(warningEvent).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty contractChecks with taskSpec checks runs only taskSpec checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-empty-contract-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: ["npm test"], contractChecks: [], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.verdict).toBe("passed");
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("npm test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// All checks now execute — no allowlist filtering. Any command the LLM
// produces runs inside the cell. A PHP check, a Zig check, any
// previously-filtered command now executes and either passes or fails
// honestly.
// ---------------------------------------------------------------------------

describe("runVerifyCore — all checks execute (no allowlist)", () => {
  test("PHP check command executes — previously dropped by allowlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-php-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: [],
          contractChecks: ["php artisan test"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      // The check ran (stub runner returns exit 0) and passed
      expect(result.verdict).toBe("passed");
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("php artisan test");
      expect(checks[0].passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Zig check command executes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-zig-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: [],
          contractChecks: ["zig build"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("passed");
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("zig build");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("all checks pass → verdict is passed (no partial-drop concept)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-allpass-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: ["npm test", "cargo check"],
          contractChecks: [],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("passed");
      expect(result.tiers.deterministic.details).toContain("All");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("any check fails → verdict is failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-fail-"));
    try {
      const runCommand = vi.fn<CommandRunner>(async () => ({ exitCode: 1, output: "type error" }));
      const deps = makeDeps({ runCommand });
      const result = await runVerifyCore(
        {
          checks: ["npm test"],
          contractChecks: [],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Runner errors propagate — never falls back to silent success
// ---------------------------------------------------------------------------

describe("runVerifyCore — runner errors propagate", () => {
  test("error from runner propagates as failed verify", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-runner-err-"));
    try {
      const runCommand = vi.fn<CommandRunner>(async () => {
        throw new Error("runner unavailable");
      });
      const deps = makeDeps({ runCommand });

      // The error should propagate (fail-closed), not be caught and turned
      // into a "passed" or "unverified" verdict.
      await expect(
        runVerifyCore(
          { checks: ["npm test"], contractChecks: [], workDir: dir, gitRoot: dir },
          deps,
        ),
      ).rejects.toThrow("runner unavailable");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

