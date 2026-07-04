import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { GateResult } from "./types.js";
import { buildExcludeDirSet, collectSourceFiles, computeReachableFiles, findEntryPoint, ROUTE_REGISTRATION_PATTERN } from "./internal.js";
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
  readonly contractEntryPoint?: string | null;
  readonly contractLanguage?: string | null;
  readonly contractExcludePaths?: readonly string[];
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

    const routeCheck = await checkRouteReachability(
      targetProjectPath,
      deps.contractEntryPoint ?? null,
      deps.contractLanguage ?? null,
      deps.contractExcludePaths,
    );
    if (!routeCheck.passed) {
      return routeCheck;
    }

    return { passed: true, output: `integration gate passed; ${routeCheck.output}` };
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

// ---------------------------------------------------------------------------
// Route-reachability check (integration gate) — a route file that still
// compiles but is no longer imported from the entry point silently 404s at
// runtime (E2E Run 7: entry-point rewrite dropped router mounts; tsc and
// smoke both passed). Static text-level import traversal, fully deterministic.
// ---------------------------------------------------------------------------

const JS_LANGUAGES = new Set(["typescript", "javascript"]);

function isJsLanguage(language: string | null): boolean {
  return language !== null && JS_LANGUAGES.has(language.toLowerCase());
}

export async function checkRouteReachability(
  projectPath: string,
  contractEntryPoint: string | null = null,
  contractLanguage: string | null = null,
  contractExcludePaths?: readonly string[],
): Promise<GateResult> {
  if (contractLanguage !== null && !isJsLanguage(contractLanguage)) {
    return {
      passed: true,
      output: `route-reachability skipped: language "${contractLanguage}" is not JS/TS`,
    };
  }

  const projectRoot = resolve(projectPath);

  const entryPoint = await findEntryPoint(projectRoot, contractEntryPoint);
  if (entryPoint === null) {
    console.log(
      `route-reachability: no entry point in ${projectRoot} — skipping check`,
    );
    return {
      passed: true,
      output: "route-reachability skipped: no entry point found",
    };
  }

  const excludeDirs = buildExcludeDirSet(contractExcludePaths);
  const sourceFiles: string[] = [];
  await collectSourceFiles(join(projectRoot, "src"), sourceFiles, excludeDirs);

  const routeFiles: string[] = [];
  for (const file of sourceFiles) {
    if (file === entryPoint) continue;
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    if (ROUTE_REGISTRATION_PATTERN.test(content)) routeFiles.push(file);
  }

  if (routeFiles.length === 0) {
    return { passed: true, output: "route-reachability passed: no route files found" };
  }

  const reachable = await computeReachableFiles(entryPoint);

  const entryLabel = relative(projectRoot, entryPoint);
  const unreachable = routeFiles.filter((file) => !reachable.has(file));
  if (unreachable.length === 0) {
    return {
      passed: true,
      output: `route-reachability passed: ${routeFiles.length} route file(s) reachable from ${entryLabel}`,
    };
  }

  const unreachableList = unreachable
    .map((file) => `  - ${relative(projectRoot, file)}`)
    .join("\n");
  return {
    passed: false,
    output: [
      `route-reachability check failed: ${unreachable.length} route file(s) not imported ` +
        `(directly or transitively) from entry point ${entryLabel}:`,
      unreachableList,
      "These files register routes (router.<method>/app.<method>/express.Router) but are " +
        "unreachable from the entry point, so their endpoints will 404 at runtime. " +
        "Likely cause: the entry point was rewritten and route mounts were dropped. " +
        `Re-import and mount these routers in ${entryLabel}.`,
    ].join("\n"),
  };
}
