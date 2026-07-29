import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";
import type { ProjectKnowledge } from "@ashara/shared";
import { runVerifyCore, InvalidVerifyPathError, extractContractChecks } from "./verify-core.js";
import type { CoreVerifyInput, CoreVerifyDeps, CommandRunner } from "./verify-core.js";
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
    prepareToolchain: vi.fn(async () => stubToolchain),
    ...overrides,
  };
}

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

      await runVerifyCore(
        { checks: ["cargo check"], workDir: dir, gitRoot: dir },
        { prepareToolchain, runCommand },
      );

      // The critical assertion: prepareToolchain was called with the workDir.
      // Before the fix, the package.json guard returned null and this never fired.
      expect(prepareToolchain).toHaveBeenCalledTimes(1);
      expect(prepareToolchain).toHaveBeenCalledWith(dir, expect.objectContaining({ runCommand }));
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
        { prepareToolchain },
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

  test("all custom checks filtered by allowlist triggers fail-closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-failclosed-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: [
            "npx tsc --noEmit passes",
            "the build should succeed",
          ],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("failed");
      expect(result.tiers.deterministic.status).toBe("fail");
      expect(result.tiers.deterministic.details).toContain("no executable checks");
      // Drop visibility is in details, not a separate field
      expect(result.tiers.deterministic.details).toContain("npx tsc --noEmit passes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contract checks all filtered by allowlist triggers fail-closed (Discipline A)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-contract-failclosed-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: [],
          contractChecks: ["php artisan test", "zig build"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      // Checks existed but none survived isAllowedCheck — fail closed, not unverified
      expect(result.verdict).toBe("failed");
      expect(result.tiers.deterministic.status).toBe("fail");
      expect(result.tiers.deterministic.details).toContain("no executable checks");
      // Details must name the dropped checks
      expect(result.tiers.deterministic.details).toContain("php artisan test");
      expect(result.tiers.deterministic.details).toContain("zig build");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("contract checks rescue runs the executable check but verdict is unverified when NL check is dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-rescue-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: ["the project compiles without errors"],
          contractChecks: ["npx --no-install tsc --noEmit"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      // The executable check ran and passed, but the NL check was dropped —
      // verification is incomplete, not passed.
      expect(result.verdict).toBe("unverified");
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("npx --no-install tsc --noEmit");

      // Drop is visible through the details string
      expect(result.tiers.deterministic.details).toContain("the project compiles without errors");
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
// Partial drop — some checks ran, some were dropped by the allowlist.
// The defect: "All 1 checks passed" when 1 of 2 specified checks was silently
// dropped. The fix: partial drop → verdict "unverified", details name what
// was dropped, details names the drops and the JSONL log carries the structured list.
// ---------------------------------------------------------------------------

describe("runVerifyCore — partial check drop yields unverified", () => {
  test("two checks, one dropped → verdict is unverified and result names the skipped one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-partial-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: ["just check"],
          contractChecks: ["php artisan test"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("unverified");
      expect(result.tiers.deterministic.status).toBe("pass");

      // Details must name what was dropped — never "All 1 checks passed"
      expect(result.tiers.deterministic.details).toContain("1 of 2");
      expect(result.tiers.deterministic.details).toContain("php artisan test");
      expect(result.tiers.deterministic.details).not.toContain("All");

      // Drop is visible through the details string
      expect(result.tiers.deterministic.details).toContain("php artisan test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("multiple drops are all named in details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-multidrop-"));
    try {
      const deps = makeDeps();
      const result = await runVerifyCore(
        {
          checks: ["npm test"],
          contractChecks: ["php artisan test", "zig build", "mix test"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      expect(result.verdict).toBe("unverified");
      expect(result.tiers.deterministic.details).toContain("1 of 4");
      expect(result.tiers.deterministic.details).toContain("3 dropped");
      expect(result.tiers.deterministic.details).toContain("php artisan test");
      expect(result.tiers.deterministic.details).toContain("zig build");
      expect(result.tiers.deterministic.details).toContain("mix test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("failing check with drops → verdict is failed, not unverified (failure trumps)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-fail-plus-drop-"));
    try {
      const runCommand = vi.fn<CommandRunner>(async () => ({ exitCode: 1, output: "type error" }));
      const deps = makeDeps({ runCommand });
      const result = await runVerifyCore(
        {
          checks: ["npm test"],
          contractChecks: ["php artisan test"],
          workDir: dir,
          gitRoot: dir,
        },
        deps,
      );

      // A real failure is the verdict regardless of drops
      expect(result.verdict).toBe("failed");
      // The drop is still visible through the deterministic tier details
      expect(result.tiers.deterministic.details).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("all checks pass allowlist and pass → verdict is passed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-nodrop-"));
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
      // Details should say "All" when nothing was dropped
      expect(result.tiers.deterministic.details).toContain("All");
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
