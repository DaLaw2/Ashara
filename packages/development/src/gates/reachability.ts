import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GateResult } from "./types.js";
import { prepare, ToolchainError } from "../project-toolchain.js";
import type { ToolchainDeps, ToolchainLogFn, ToolchainResult } from "../project-toolchain.js";
import type { CommandRunner } from "../verify-core.js";
import { defaultRunCommand } from "../check-runner.js";

const execFileAsync = promisify(execFile);

const CHECK_TIMEOUT_MS = 30_000;

export interface IntegrationGateDeps {
  /** Toolchain preparer (install + codegen). Default: the real prepare(). */
  readonly prepareToolchain?: (targetPath: string, deps?: ToolchainDeps) => Promise<ToolchainResult>;
  /** Runner for prepare() AND the gate's own tsc/build steps — one environment. */
  readonly runCommand?: CommandRunner;
  readonly log?: ToolchainLogFn;
  /** Contract-declared checks for non-Node projects. */
  readonly contractChecks?: ReadonlyArray<{ readonly command: readonly string[]; readonly label: string }>;
}

export async function runIntegrationGate(
  targetProjectPath: string,
  deps: IntegrationGateDeps = {},
): Promise<GateResult> {
  try {
    const run = deps.runCommand ?? defaultRunCommand;
    const prepareFn = deps.prepareToolchain ?? prepare;

    const pkgJsonPath = join(targetProjectPath, "package.json");
    const hasPkgJson = await access(pkgJsonPath).then(
      () => true,
      () => false,
    );
    if (!hasPkgJson) {
      return runNonNodeIntegrationGate(targetProjectPath, run, prepareFn, deps.log, deps.contractChecks);
    }

    // Reproduce the project's build semantics BEFORE tsc: install dependencies
    // and run codegen (e.g. prisma generate) so the assembled tree matches what
    // the agent compiled. Fail-closed (Run 9 class): a toolchain failure fails
    // the gate with the typed, self-diagnosing ToolchainError context — never
    // fall through to running tsc on an unprepared tree.
    try {
      await prepareFn(targetProjectPath, { runCommand: run, log: deps.log });
    } catch (e: unknown) {
      if (e instanceof ToolchainError) {
        const ctx = e.context;
        const excerpt = ctx.outputExcerpt ? `; output: ${ctx.outputExcerpt.slice(0, 300)}` : "";
        return {
          passed: false,
          output:
            `toolchain preparation failed at step "${e.step}": ${ctx.detail}` +
            (ctx.command ? ` [${ctx.command.join(" ")}]` : "") +
            (ctx.exitCode !== undefined ? ` (exit ${ctx.exitCode})` : "") +
            excerpt,
        };
      }
      return { passed: false, output: `toolchain preparation error: ${String(e).slice(0, 500)}` };
    }

    const tsconfigPath = join(targetProjectPath, "tsconfig.json");
    const hasTsconfig = await access(tsconfigPath).then(
      () => true,
      () => false,
    );
    if (hasTsconfig) {
      const { stdout: tsFiles } = await execFileAsync("find", [
        targetProjectPath,
        "-name",
        "*.ts",
        "-not",
        "-path",
        "*/node_modules/*",
        "-maxdepth",
        "3",
      ]);
      if (tsFiles.trim().length > 0) {
        // --no-install: never fetch the name-squatting "tsc" package from the
        // registry — only use the project's own typescript binary.
        const { exitCode, output } = await run(
          ["npx", "--no-install", "tsc", "--noEmit"],
          targetProjectPath,
          CHECK_TIMEOUT_MS,
        );
        if (exitCode !== 0) {
          return { passed: false, output: `tsc --noEmit failed: ${output.slice(0, 500)}` };
        }
      }
    }

    const pkgContent = await readFile(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, unknown> | undefined;
    if (scripts && typeof scripts.build === "string") {
      const { exitCode, output } = await run(["npm", "run", "build"], targetProjectPath, CHECK_TIMEOUT_MS);
      if (exitCode !== 0) {
        return { passed: false, output: `npm run build failed: ${output.slice(0, 500)}` };
      }
    }

    return { passed: true, output: "integration gate passed" };
  } catch (e) {
    return { passed: false, output: `integration gate error: ${String(e).slice(0, 500)}` };
  }
}

// ---------------------------------------------------------------------------
// Non-Node integration gate — runs contract-declared checks for projects
// without package.json. Uses the same CommandRunner injection seam.
// ---------------------------------------------------------------------------

async function runNonNodeIntegrationGate(
  targetProjectPath: string,
  run: CommandRunner,
  prepareFn: (targetPath: string, deps?: ToolchainDeps) => Promise<ToolchainResult>,
  log: ToolchainLogFn | undefined,
  contractChecks: ReadonlyArray<{ readonly command: readonly string[]; readonly label: string }> | undefined,
): Promise<GateResult> {
  try {
    await prepareFn(targetProjectPath, { runCommand: run, log });
  } catch (e: unknown) {
    if (e instanceof ToolchainError) {
      const ctx = e.context;
      const excerpt = ctx.outputExcerpt ? `; output: ${ctx.outputExcerpt.slice(0, 300)}` : "";
      return {
        passed: false,
        output:
          `toolchain preparation failed at step "${e.step}": ${ctx.detail}` +
          (ctx.command ? ` [${ctx.command.join(" ")}]` : "") +
          (ctx.exitCode !== undefined ? ` (exit ${ctx.exitCode})` : "") +
          excerpt,
      };
    }
    return { passed: false, output: `toolchain preparation error: ${String(e).slice(0, 500)}` };
  }

  if (!contractChecks || contractChecks.length === 0) {
    console.warn(`non-Node integration gate: no contract checks declared for ${targetProjectPath}`);
    return { passed: true, output: "no contract checks declared — skipping integration gate" };
  }

  const passed: string[] = [];
  for (const check of contractChecks) {
    const { exitCode, output } = await run(
      [...check.command],
      targetProjectPath,
      CHECK_TIMEOUT_MS,
    );
    if (exitCode !== 0) {
      return { passed: false, output: `${check.label} failed: ${output.slice(0, 500)}` };
    }
    passed.push(check.label);
  }

  return { passed: true, output: `integration gate passed (${passed.join(", ")})` };
}

