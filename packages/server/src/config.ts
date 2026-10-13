import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { CoreLoopConfig } from "@ashara/orchestrator";
import { DEFAULT_CONFIG } from "@ashara/orchestrator";
import { DEFAULT_DATABASE_URL } from "@ashara/db";

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly apiToken: string;
  readonly port: number;
  readonly coreLoop: CoreLoopConfig;
}

class InvalidBudgetLimit extends Error {
  constructor(public readonly raw: string | undefined) {
    super(
      raw === undefined
        ? "neither ASHARA_BUDGET_LIMIT_USD nor ASHARA_BUDGET_TOTAL is set; every run dispatches paid agents, " +
            "so the per-run cap in USD must be set explicitly"
        : `ASHARA_BUDGET_LIMIT_USD / ASHARA_BUDGET_TOTAL="${raw}" is not a positive finite number; ` +
            "set it to the per-run cap in USD",
    );
    this.name = "InvalidBudgetLimit";
  }
}

export function loadDatabaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}

export function loadServerConfig(databaseUrl: string, apiToken: string): ServerConfig {

  const port = parseIntOr(process.env["ASHARA_PORT"], 3000);

  const repoPathRaw = process.env["REPO_PATH"] ?? ".";
  const repoPath = path.resolve(repoPathRaw);

  const workdirBaseRaw = process.env["WORKDIR_BASE"]
    ?? process.env["WORKTREE_BASE"]
    ?? path.join(os.tmpdir(), "ashara-work");
  const workdirBase = path.isAbsolute(workdirBaseRaw)
    ? workdirBaseRaw
    : path.resolve(workdirBaseRaw);

  const baseBranch =
    process.env["BASE_BRANCH"] ?? detectDefaultBranch(repoPath) ?? "master";

  const asharaSourceDir = process.env["ASHARA_SOURCE_DIR"] ?? ".";
  const maxBatchSize = parseIntOr(process.env["MAX_BATCH_SIZE"], 2);
  // Finding (a), E2E Run 11: the orchestrator's reactive budget is the only
  // ENFORCING per-run cap, but it read ASHARA_BUDGET_LIMIT_USD only — a var the
  // run never set — so it silently defaulted to $5 while the owner's $1 cap
  // lived in ASHARA_BUDGET_TOTAL (the gateway's blind per-call cap). The run
  // over-ran to $1.08. Fall back to ASHARA_BUDGET_TOTAL so a single owner-set
  // per-run number reaches CoreLoopConfig.budgetLimitUsd, with the dedicated
  // ASHARA_BUDGET_LIMIT_USD still winning when both are set. Blank values are
  // treated as unset so an empty override never masks the fallback.
  const rawBudgetLimit = nonEmptyEnv("ASHARA_BUDGET_LIMIT_USD") ?? nonEmptyEnv("ASHARA_BUDGET_TOTAL");
  // No default: every run dispatches paid agents, so the cap is the owner's explicit consent to spend.
  const budgetLimitUsd = parseBudgetLimit(rawBudgetLimit);

  const brainstormCooldownThreshold = parseIntOr(
    process.env["BRAINSTORM_COOLDOWN_THRESHOLD"],
    DEFAULT_CONFIG.brainstormCooldownThreshold,
  );
  const maxPendingWorkItems = parseIntOr(
    process.env["MAX_PENDING_WORK_ITEMS"],
    DEFAULT_CONFIG.maxPendingWorkItems,
  );

  // Coverage reconciliation is ENFORCING by default (mig9-t2, ADR-032 §2). The
  // rollback: ASHARA_COVERAGE_ENFORCING=0 (or "false") switches to observe-only —
  // gaps are logged and reported but never block a rollup or completeness.
  const coverageEnforcing = !(
    process.env["ASHARA_COVERAGE_ENFORCING"] === "0" ||
    process.env["ASHARA_COVERAGE_ENFORCING"]?.toLowerCase() === "false"
  );

  const coreLoop: CoreLoopConfig = {
    ...DEFAULT_CONFIG,
    repoPath,
    workdirBase,
    baseBranch,
    asharaSourceDir,
    maxBatchSize,
    budgetLimitUsd,
    brainstormCooldownThreshold,
    maxPendingWorkItems,
    coverageEnforcing,
  };

  return {
    databaseUrl,
    apiToken,
    port,
    coreLoop,
  };
}

function nonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// An owner-set cap that does not parse is not consent to the default: a typo must
// not silently become a different spend limit.
function parseBudgetLimit(raw: string | undefined): number {
  if (raw === undefined) throw new InvalidBudgetLimit(raw);
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidBudgetLimit(raw);
  return parsed;
}

function detectDefaultBranch(repoPath: string): string | null {
  try {
    const output = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output || output === "HEAD") return null;
    return output;
  } catch {
    return null;
  }
}
