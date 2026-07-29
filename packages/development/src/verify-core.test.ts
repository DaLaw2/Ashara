import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";
import type { ProjectKnowledge } from "@ashara/shared";
import { runVerifyCore, InvalidVerifyPathError, extractContractChecks } from "./verify-core.js";
import type { CoreVerifyInput, CoreVerifyDeps, CommandRunner } from "./verify-core.js";
import { ContainedCheckError } from "./check-runner.js";
import { ToolchainError } from "./project-toolchain.js";
import type { ToolchainResult } from "./project-toolchain.js";

// ---------------------------------------------------------------------------
// GIT-SAFETY (a, mig-phase-2 t2): workDir/gitRoot are required and validated
// at the single choke point both adapters (verify.ts, inline-verify.ts) route
// through. A request that omits/mis-supplies either must fail closed with a
// typed error BEFORE any command runs — never fall back to the ambient cwd.
// ---------------------------------------------------------------------------

const baseInput: Omit<CoreVerifyInput, "workDir" | "gitRoot"> = {
  checks: [],
};

const stubToolchain: ToolchainResult = {
  manager: "npm",
  installRan: false,
  installReason: "stub",
  codegen: [],
};

function makeDeps(overrides: Partial<CoreVerifyDeps> = {}): CoreVerifyDeps {
  return {
    runCommand: vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" })),
    prepareRunCommand: vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" })),
    prepareToolchain: vi.fn(async () => stubToolchain),
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
// Non-Node project reachability (t-nonnode-prepare-is-unreachable)
//
// The whole finding: prepareToolchainForVerify previously guarded on
// package.json, returning null before calling prepare(). Since prepare()
// routes to prepareNonNode() only when package.json is ABSENT, the guard
// made non-Node preparation unreachable. These tests verify the fix.
// ---------------------------------------------------------------------------

describe("runVerifyCore — non-Node project reaches preparation", () => {
  test("workDir without package.json calls prepareToolchain (the finding is that it previously did not)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-nonnode-reach-"));
    try {
      const prepareToolchain = vi.fn(async () => stubToolchain);
      const runCommand = vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" }));
      const prepareRunCommand = vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" }));

      await runVerifyCore(
        { checks: ["cargo check"], workDir: dir, gitRoot: dir },
        { prepareToolchain, runCommand, prepareRunCommand },
      );

      // The critical assertion: prepareToolchain was called with the workDir
      // and received the PREPARE runner, not the check runner.
      expect(prepareToolchain).toHaveBeenCalledTimes(1);
      expect(prepareToolchain).toHaveBeenCalledWith(dir, expect.objectContaining({ runCommand: prepareRunCommand }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("non-Node preparation failure fails the verify closed (Discipline A)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-nonnode-fail-"));
    try {
      const prepareToolchain = vi.fn(async () => {
        throw new ToolchainError("install", {
          cwd: dir,
          detail: "cargo build failed",
          command: ["cargo", "build"],
          exitCode: 101,
        });
      });

      const result = await runVerifyCore(
        { checks: ["cargo check"], workDir: dir, gitRoot: dir },
        {
          prepareToolchain,
          runCommand: vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" })),
          prepareRunCommand: vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" })),
        },
      );

      expect(result.verdict).toBe("failed");
      expect(result.tiers.deterministic.details).toContain("cargo build failed");
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
        { checks: [], workDir: dir, gitRoot: dir },
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

  test("omitting contractChecks is backward-compatible (defaults to empty)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-compat-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: ["npm test"], workDir: dir, gitRoot: dir },
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
// produces runs inside the container. A PHP check, a Zig check, any
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
// Runner split: preparation gets prepareRunCommand, checks get runCommand.
// This is the mechanism that prevents npm install / cargo build / go mod
// download from hitting --network=none. The test exercises the real
// runVerifyCore code path, not a stub — the prepare function and the check
// execution each receive a distinct, identifiable runner.
// ---------------------------------------------------------------------------

describe("runVerifyCore — preparation uses prepareRunCommand, checks use runCommand", () => {
  test("prepareToolchain receives prepareRunCommand, checks receive runCommand", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-split-"));
    try {
      // Two distinct runners so we can tell which one was passed where
      const checkRunner = vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "check" }));
      const prepareRunner = vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "prepare" }));
      const prepareToolchain = vi.fn(async () => stubToolchain);

      const result = await runVerifyCore(
        { checks: ["npm test"], workDir: dir, gitRoot: dir },
        {
          runCommand: checkRunner,
          prepareRunCommand: prepareRunner,
          prepareToolchain,
        },
      );

      // Preparation was called with the PREPARE runner (network-enabled)
      expect(prepareToolchain).toHaveBeenCalledTimes(1);
      expect(prepareToolchain).toHaveBeenCalledWith(
        dir,
        expect.objectContaining({ runCommand: prepareRunner }),
      );

      // Checks were executed with the CHECK runner (network-isolated)
      expect(checkRunner).toHaveBeenCalled();
      // prepareRunner was NOT used to run checks
      expect(prepareRunner).not.toHaveBeenCalled();

      expect(result.verdict).toBe("passed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("in-container path: both runners are the same defaultRunCommand and both work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-same-runner-"));
    try {
      // Simulates the agent-runner path: both fields point to the same runner
      const sharedRunner = vi.fn<CommandRunner>(async () => ({ exitCode: 0, output: "" }));
      const prepareToolchain = vi.fn(async () => stubToolchain);

      const result = await runVerifyCore(
        { checks: ["cargo check"], workDir: dir, gitRoot: dir },
        {
          runCommand: sharedRunner,
          prepareRunCommand: sharedRunner,
          prepareToolchain,
        },
      );

      // Both preparation and checks used the same runner
      expect(prepareToolchain).toHaveBeenCalledWith(
        dir,
        expect.objectContaining({ runCommand: sharedRunner }),
      );
      expect(sharedRunner).toHaveBeenCalled();
      expect(result.verdict).toBe("passed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Container unavailability fails closed — never falls back to host execution
// ---------------------------------------------------------------------------

describe("runVerifyCore — container unavailability fails closed", () => {
  test("ContainedCheckError from runner propagates as failed verify", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-no-podman-"));
    try {
      const runCommand = vi.fn<CommandRunner>(async () => {
        throw new ContainedCheckError("spawn", "podman binary not found on PATH");
      });
      const deps = makeDeps({ runCommand });

      // The error should propagate (fail-closed), not be caught and turned
      // into a "passed" or "unverified" verdict.
      await expect(
        runVerifyCore(
          { checks: ["npm test"], workDir: dir, gitRoot: dir },
          deps,
        ),
      ).rejects.toBeInstanceOf(ContainedCheckError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ContainedCheckError for missing image propagates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-no-image-"));
    try {
      const runCommand = vi.fn<CommandRunner>(async () => {
        throw new ContainedCheckError("image_pull", "image not found: ashara-sandbox:0.1.0");
      });
      const deps = makeDeps({ runCommand });

      await expect(
        runVerifyCore(
          { checks: ["cargo check"], workDir: dir, gitRoot: dir },
          deps,
        ),
      ).rejects.toBeInstanceOf(ContainedCheckError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractContractChecks — Zod-validated extraction from knowledge graph
// ---------------------------------------------------------------------------

describe("extractContractChecks", () => {
  test("extracts commands from check nodes with valid meta.command", () => {
    const knowledge: ProjectKnowledge = {
      nodes: [
        { id: "lang-ts", kind: "language", label: "TypeScript" },
        { id: "check-tsc", kind: "check", label: "TypeScript compilation", meta: { command: ["npx", "--no-install", "tsc", "--noEmit"] } },
        { id: "check-test", kind: "check", label: "Run tests", meta: { command: ["npm", "test"] } },
      ],
      edges: [],
    };

    const checks = extractContractChecks(knowledge);
    expect(checks).toEqual(["npx --no-install tsc --noEmit", "npm test"]);
  });

  test("skips check nodes without meta.command", () => {
    const knowledge: ProjectKnowledge = {
      nodes: [
        { id: "check-no-cmd", kind: "check", label: "The tests pass" },
        { id: "check-with-cmd", kind: "check", label: "Lint", meta: { command: ["npm", "run", "lint"] } },
      ],
      edges: [],
    };

    const checks = extractContractChecks(knowledge);
    expect(checks).toEqual(["npm run lint"]);
  });

  test("skips check nodes with invalid meta.command (not string array)", () => {
    const knowledge: ProjectKnowledge = {
      nodes: [
        { id: "check-bad", kind: "check", label: "Bad command", meta: { command: "not an array" } },
        { id: "check-empty", kind: "check", label: "Empty command", meta: { command: [] } },
        { id: "check-num", kind: "check", label: "Number command", meta: { command: [42] } },
        { id: "check-good", kind: "check", label: "Good", meta: { command: ["cargo", "test"] } },
      ],
      edges: [],
    };

    const checks = extractContractChecks(knowledge);
    expect(checks).toEqual(["cargo test"]);
  });

  test("returns empty for knowledge graph with no check nodes", () => {
    const knowledge: ProjectKnowledge = {
      nodes: [
        { id: "lang-rs", kind: "language", label: "Rust" },
        { id: "rt-tokio", kind: "runtime", label: "Tokio" },
      ],
      edges: [],
    };

    const checks = extractContractChecks(knowledge);
    expect(checks).toEqual([]);
  });

  test("works for any tech stack — PHP, Zig, Elixir (target generality)", () => {
    const knowledge: ProjectKnowledge = {
      nodes: [
        { id: "lang-php", kind: "language", label: "PHP" },
        { id: "check-php", kind: "check", label: "PHPUnit", meta: { command: ["php", "artisan", "test"] } },
        { id: "check-lint", kind: "check", label: "PHPStan", meta: { command: ["vendor/bin/phpstan", "analyse"] } },
      ],
      edges: [],
    };

    const checks = extractContractChecks(knowledge);
    expect(checks).toEqual(["php artisan test", "vendor/bin/phpstan analyse"]);
  });
});
