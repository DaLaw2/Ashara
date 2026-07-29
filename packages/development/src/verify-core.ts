import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ProjectKnowledge } from "@ashara/shared";
import { nodesByKind } from "@ashara/shared";
import { prepare, ToolchainError } from "./project-toolchain.js";
import type { ToolchainDeps, ToolchainResult } from "./project-toolchain.js";
import {
  isAllowedCheck,
  defaultRunCommand,
  runDeterministicChecks,
} from "./check-runner.js";
import type { CoreTierResult } from "./check-runner.js";
import { readVerifyConfig } from "./verify-config.js";

// ---------------------------------------------------------------------------
// Shared verify check library (Phase 2, mig-phase-2).
//
// Single implementation behind both the in-process development verify() and the
// out-of-process agent-runner runInlineVerify() adapters. The agent runs in a
// subprocess, so this library is pure functions plus an injected command
// runner — no shared runtime state. Each process supplies its own command
// runner (defaulting to a local `spawn`).
//
// Verification is deterministic checks only: tsc/cargo check/npm test/custom
// commands (check-runner.ts). Evidence across 11 E2E runs: every real quality
// catch came from this deterministic tier; an LLM judge tier previously sat
// here and its only measured contribution was false abandonment (a refuted
// claim carried forward until task exhaustion). It has been removed —
// deterministic pass is the sole pass/fail signal.
//
// Divergence resolutions (docs/migration-plan.md Phase 2):
//   - isAllowedCheck uses the ANCHORED allowlist (closes the agent-side
//     "npx tsc --noEmit passes" NL-as-command hole).
//
// GIT-SAFETY (a, mig-phase-2 t2): workDir/gitRoot are required and validated
// here, at the single choke point both adapters route through. Neither adapter
// (nor any future one) may fall back to `process.cwd()` when a caller omits
// them — that silently ran git commands against whatever the host process's
// ambient working directory happened to be (Discipline A violation).
// ---------------------------------------------------------------------------

/**
 * Three-state verification outcome. `"unverified"` is the honest result when
 * zero executable checks existed — neither pass nor fail, because nothing was
 * tested. The concept aligns with the acceptance system's existing `unverified`
 * verdict (AcceptanceOutcome in planning/acceptance.ts).
 */
export type VerifyVerdict = "passed" | "failed" | "unverified";

export interface CoreVerifyResult {
  readonly verdict: VerifyVerdict;
  readonly tiers: {
    readonly deterministic: CoreTierResult;
  };
  // Structured drop list lives in the JSONL log (checksSkipped); drop visibility is in details.
}

/**
 * Injected command runner. The default runs a local subprocess; both the
 * in-process and out-of-process callers spawn their own children (no shared
 * state), and tests may substitute a deterministic runner.
 */
export type CommandRunner = (
  command: string[],
  cwd: string,
  timeout: number,
) => Promise<{ exitCode: number; output: string }>;

// open-by-design: log payloads carry caller-defined diagnostic fields
export type VerifyLogFn = (event: Record<string, unknown>) => void;

export interface CoreVerifyInput {
  readonly workDir: string;
  readonly gitRoot: string;
  readonly checks: string[];
  /**
   * Executable checks extracted from the contract's knowledge-graph `check`
   * nodes. These are LLM-derived at decomposition time and carry the command
   * the LLM judged appropriate for this project's tech stack — no hardcoded
   * language list, so a PHP or Zig target works with zero code changes.
   *
   * Merge order: verify.toml (agent-observed reality) > contractChecks
   * (LLM-derived intent) > taskSpec checks (decomposition NL). A check
   * already present in a higher-priority source is not re-added.
   */
  readonly contractChecks?: readonly string[];
}

export interface CoreVerifyDeps {
  readonly runCommand?: CommandRunner;
  readonly log?: VerifyLogFn;
  /**
   * Toolchain preparer, run before the deterministic checks using the SAME
   * injected runCommand. Dispatches for any project type (Node, Cargo, Go).
   * Default: the real prepare(). Tests inject a deterministic stub.
   */
  readonly prepareToolchain?: (targetPath: string, deps?: ToolchainDeps) => Promise<ToolchainResult>;
}

// ---------------------------------------------------------------------------
// GIT-SAFETY (a): workDir/gitRoot validation
// ---------------------------------------------------------------------------

export class InvalidVerifyPathError extends Error {
  constructor(
    public readonly field: "workDir" | "gitRoot",
    public readonly received: string,
    public readonly reason: string,
  ) {
    super(`verify-core: invalid ${field} ${JSON.stringify(received)} — ${reason}`);
    this.name = "InvalidVerifyPathError";
  }
}

function assertValidVerifyPath(value: string, field: "workDir" | "gitRoot"): void {
  // Runtime guard, not just a compile-time one: a caller that bypasses the
  // (required) TS type — e.g. an `as` cast from a looser upstream shape —
  // can still hand this an undefined/non-string value at runtime.
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidVerifyPathError(field, String(value), "must be a non-empty path");
  }
  if (!isAbsolute(value)) {
    throw new InvalidVerifyPathError(field, value, "must be an absolute path");
  }
}

function toolchainFailureDetails(err: unknown): string {
  if (err instanceof ToolchainError) {
    const ctx = err.context;
    const excerpt = ctx.outputExcerpt ? `; output: ${ctx.outputExcerpt.slice(0, 300)}` : "";
    return (
      `toolchain preparation failed at step "${err.step}": ${ctx.detail}` +
      (ctx.command ? ` [${ctx.command.join(" ")}]` : "") +
      (ctx.exitCode !== undefined ? ` (exit ${ctx.exitCode})` : "") +
      excerpt
    );
  }
  return `toolchain preparation error: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Run the toolchain preparer for the workDir. Returns null on success; returns
 * a fully-formed failed CoreVerifyResult when preparation throws, so the caller
 * fails closed without running any check on an unprepared tree.
 *
 * `prepare()` dispatches internally: Node projects (package.json present) get
 * dependency installation and codegen; non-Node projects (Cargo.toml, go.mod)
 * get their own build/download step; projects with no recognized manifest get
 * a no-op return. This function does not gate on project type — `prepare()`
 * owns that routing.
 */
async function prepareToolchainForVerify(
  workDir: string,
  run: CommandRunner,
  deps: CoreVerifyDeps,
  log: VerifyLogFn | undefined,
): Promise<CoreVerifyResult | null> {
  const prepareFn = deps.prepareToolchain ?? prepare;
  try {
    await prepareFn(workDir, { runCommand: run, log });
    return null;
  } catch (err) {
    const details = toolchainFailureDetails(err);
    log?.({ event: "verify_toolchain_failed", details });
    return {
      verdict: "failed",
      tiers: {
        deterministic: { status: "fail", details },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Contract check extraction (zero-enum: replaces hardcoded baseline injection)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the command array inside a knowledge-graph `check` node's
 * `meta.command` field. The node's `meta` is `Record<string, unknown>`, so
 * this is the boundary validation (Discipline A, Zod at every boundary).
 */
const CheckNodeCommandSchema = z.array(z.string().min(1)).nonempty();

/**
 * Extract executable check commands from the contract's knowledge graph.
 *
 * The decomposition prompt asks the LLM to emit `check` nodes with
 * `meta.command` set to a shell argv array (e.g. `["cargo", "check"]`).
 * This function reads those nodes and joins each argv into a command string
 * suitable for the deterministic check runner.
 *
 * Nodes whose `meta.command` is absent or fails Zod validation are silently
 * skipped — they may carry a human-readable `label` (criterion) but no
 * executable command.
 *
 * Target-generality: no language enumeration. A PHP project emitting
 * `["php", "artisan", "test"]` works with zero code changes.
 */
export function extractContractChecks(knowledge: ProjectKnowledge): string[] {
  const checkNodes = nodesByKind(knowledge, "check");
  const commands: string[] = [];
  for (const node of checkNodes) {
    const parsed = CheckNodeCommandSchema.safeParse(node.meta?.command);
    if (parsed.success) {
      commands.push(parsed.data.join(" "));
    }
  }
  return commands;
}

// ---------------------------------------------------------------------------
// Core verify
// ---------------------------------------------------------------------------

/**
 * Run the deterministic verify pipeline: toolchain preparation, then the
 * deterministic checks (tsc/cargo check/npm test/custom commands). `passed`
 * is exactly the deterministic tier's outcome — nothing else feeds it.
 *
 * Never fails open: a toolchain-preparation failure or a failing check yields
 * `verdict="failed"`. A throwing log sink propagates (fail-closed at the caller).
 */
export async function runVerifyCore(
  input: CoreVerifyInput,
  deps: CoreVerifyDeps = {},
): Promise<CoreVerifyResult> {
  assertValidVerifyPath(input.workDir, "workDir");
  assertValidVerifyPath(input.gitRoot, "gitRoot");

  const run = deps.runCommand ?? defaultRunCommand;
  const log = deps.log;

  // Reproduce the project's build semantics BEFORE any deterministic check, so
  // the agent-worktree tsc runs against the same prepared tree the gate does
  // (ADR-032 §1: one implementation, one environment). Preparation dispatches
  // per project type: Node (npm/bun install + codegen), Cargo (cargo build),
  // Go (go mod download), or no-op when no recognized manifest is present.
  // Fail-closed (Run 9 / R8-F6a class): a toolchain failure yields a failed
  // deterministic tier carrying the typed, self-diagnosing context; never fall
  // through to running checks on an unprepared tree.
  const toolchainFailure = await prepareToolchainForVerify(input.workDir, run, deps, log);
  if (toolchainFailure) {
    return toolchainFailure;
  }

  const verifyConfig = await readVerifyConfig(input.workDir);
  const configChecks = verifyConfig.checks.map((c) => c.command);
  const hasVerifyToml = configChecks.length > 0;

  if (hasVerifyToml) {
    log?.({
      event: "verify_toml_loaded",
      checks: verifyConfig.checks.map((c) => ({ name: c.name, command: c.command })),
    });
  }

  const contractChecks = input.contractChecks ?? [];

  if (contractChecks.length > 0) {
    log?.({
      event: "verify_contract_checks",
      checks: contractChecks,
    });
  }

  // Merge order (documented, not implicit):
  //   1. verify.toml — agent-observed reality, authoritative
  //   2. contractChecks — LLM-derived from knowledge-graph check nodes
  //   3. taskSpec checks (input.checks) — decomposition NL, fill gaps
  //
  // verify.toml wins because it is what the agent WROTE after observing the
  // project; the contract is what the LLM INFERRED before seeing it. A check
  // already present in a higher-priority source is not re-added from a lower
  // one.
  const seen = new Set<string>();
  const allChecks: string[] = [];

  const addUnique = (checks: readonly string[]): void => {
    for (const c of checks) {
      if (!seen.has(c)) {
        seen.add(c);
        allChecks.push(c);
      }
    }
  };

  if (hasVerifyToml) {
    addUnique(configChecks);
  }
  addUnique(contractChecks);
  addUnique(input.checks);

  const executableChecks = allChecks.filter(isAllowedCheck);
  const skippedChecks = allChecks
    .filter((c) => !isAllowedCheck(c))
    .map((c) => ({ name: c, reason: "not in allowlist" }));

  if (executableChecks.length === 0 && allChecks.length > 0) {
    const droppedNames = skippedChecks.map((s) => s.name).join(", ");
    const details =
      `no executable checks — all ${allChecks.length} specified checks dropped ` +
      `(not in allowlist: ${droppedNames})`;
    log?.({
      event: "verify_deterministic",
      status: "fail",
      details,
      checks: [],
      checksSkipped: skippedChecks,
    });
    log?.({ event: "verify_final", verdict: "failed" });
    return {
      verdict: "failed",
      tiers: { deterministic: { status: "fail", details } },
    };
  }

  if (executableChecks.length === 0) {
    const details = "no executable checks — unverified";
    log?.({
      event: "verify_no_checks_warning",
      workDir: input.workDir,
      reason: "no tech stack detected and no custom checks specified",
    });
    log?.({ event: "verify_final", verdict: "unverified" });
    return {
      verdict: "unverified",
      tiers: { deterministic: { status: "skipped", details } },
    };
  }

  const deterministicOutcome = await runDeterministicChecks(run, input.workDir, executableChecks, skippedChecks);
  const deterministic = deterministicOutcome.tier;

  log?.({
    event: "verify_deterministic",
    status: deterministic.status,
    details: deterministic.details,
    checks: deterministic.checks ?? [],
    checksSkipped: deterministicOutcome.checksSkipped,
  });

  // A partial drop means some checks were specified but never ran because
  // isAllowedCheck rejected them. When the executed subset passes, "passed"
  // would assert complete verification — the defect this fixes. "unverified"
  // states what is true: evidence is incomplete. When any executed check
  // *failed*, that real failure is the verdict regardless of drops.
  const partialDrop = deterministic.status === "pass" && skippedChecks.length > 0;

  const verdict: VerifyVerdict = deterministic.status === "pass"
    ? (skippedChecks.length > 0 ? "unverified" : "passed")
    : "failed";

  // Replace "All N checks passed" with a message that names what was dropped
  // — a reader must not have to consult the log to see that verification was
  // incomplete ("All 1 checks passed" IS the defect, one layer up).
  const finalDeterministic: CoreTierResult = partialDrop
    ? {
        ...deterministic,
        details:
          `${executableChecks.length} of ${allChecks.length} specified checks ran and passed; ` +
          `${skippedChecks.length} dropped (not in allowlist: ${skippedChecks.map((s) => s.name).join(", ")})`,
      }
    : deterministic;

  log?.({ event: "verify_final", verdict });

  return {
    verdict,
    tiers: {
      deterministic: finalDeterministic,
    },
  };
}
