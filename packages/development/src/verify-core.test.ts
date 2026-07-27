import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";
import { runVerifyCore, InvalidVerifyPathError } from "./verify-core.js";
import type { CoreVerifyInput, CoreVerifyDeps, CommandRunner } from "./verify-core.js";
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

      // Empty dir has no project markers, so all builtin checks are skipped —
      // the point here is only that validation did not block it.
      expect(result.tiers.deterministic.status).toBe("pass");
      expect(result.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Baseline check injection + fail-closed on zero executable checks
// ---------------------------------------------------------------------------

describe("runVerifyCore — baseline check injection", () => {
  test("empty checks + TypeScript project injects tsc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-ts-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "tsconfig.json"), "{}");

      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: [], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("npx --no-install tsc --noEmit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty checks + Rust project injects cargo check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-rs-"));
    try {
      await writeFile(join(dir, "Cargo.toml"), "");

      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: [], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("cargo check");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty checks + Go project injects go build", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-go-"));
    try {
      await writeFile(join(dir, "go.mod"), "");

      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: [], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("go build ./...");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("empty checks + no project files passes with warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-empty-"));
    try {
      const log = vi.fn();
      const deps = makeDeps({ log });
      const result = await runVerifyCore(
        { checks: [], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      expect(result.tiers.deterministic.status).toBe("pass");

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

      expect(result.passed).toBe(false);
      expect(result.tiers.deterministic.status).toBe("fail");
      expect(result.tiers.deterministic.details).toContain("no executable checks");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("custom checks + baseline both run with baseline first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-both-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "tsconfig.json"), "{}");

      const commands: string[] = [];
      const runCommand = vi.fn<CommandRunner>(async (cmd) => {
        commands.push(cmd.join(" "));
        return { exitCode: 0, output: "" };
      });
      const deps = makeDeps({ runCommand });
      const result = await runVerifyCore(
        { checks: ["npm test"], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(2);
      expect(checks[0].name).toBe("npx --no-install tsc --noEmit");
      expect(checks[1].name).toBe("npm test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("LLM already included tsc — no duplicate injection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-dedup-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "tsconfig.json"), "{}");

      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: ["npx --no-install tsc --noEmit"], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("npx --no-install tsc --noEmit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("baselines rescue when all custom checks are NL descriptions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ashara-verify-rescue-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      await writeFile(join(dir, "tsconfig.json"), "{}");

      const deps = makeDeps();
      const result = await runVerifyCore(
        { checks: ["the project compiles without errors"], workDir: dir, gitRoot: dir },
        deps,
      );

      expect(result.passed).toBe(true);
      const checks = result.tiers.deterministic.checks ?? [];
      expect(checks).toHaveLength(1);
      expect(checks[0].name).toBe("npx --no-install tsc --noEmit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

