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
  /** Finance's spend caps in USD, summed from llm_calls (see SpendCap). */
  readonly spendCaps: {
    readonly deploymentUsd: number;
    readonly perProjectUsd: number;
  };
  /** The podman executable every cell runs through (ASHARA_PODMAN_BINARY). */
  readonly podmanBinary: string;
}

class InvalidBudgetLimit extends Error {
  constructor(
    public readonly variable: string,
    public readonly raw: string | undefined,
  ) {
    super(
      raw === undefined
        ? "neither ASHARA_BUDGET_LIMIT_USD nor ASHARA_BUDGET_TOTAL is set; every run dispatches paid agents, " +
            "so the spend cap in USD must be set explicitly"
        : `${variable}="${raw}" is not a positive finite number; set it to the spend cap in USD`,
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
    ?? path.join(os.tmpdir(), "ashara-work");
  const workdirBase = path.isAbsolute(workdirBaseRaw)
    ? workdirBaseRaw
    : path.resolve(workdirBaseRaw);

  const baseBranch =
    process.env["BASE_BRANCH"] ?? detectDefaultBranch(repoPath) ?? "master";

  const maxBatchSize = parseIntOr(process.env["MAX_BATCH_SIZE"], 2);
  // Finding (a), E2E Run 11: the owner's $1 cap lived in ASHARA_BUDGET_TOTAL
  // while the enforcing cap read only ASHARA_BUDGET_LIMIT_USD, and the run
  // over-ran to $1.08. Both names set the one deployment cap, the dedicated
  // ASHARA_BUDGET_LIMIT_USD winning when both are set. Blank values are treated
  // as unset so an empty override never masks the fallback.
  const deploymentVariable =
    nonEmptyEnv("ASHARA_BUDGET_LIMIT_USD") !== undefined ? "ASHARA_BUDGET_LIMIT_USD" : "ASHARA_BUDGET_TOTAL";
  // No default: every run dispatches paid agents, so the cap is the owner's explicit consent to spend.
  const deploymentUsd = parseBudgetLimit(deploymentVariable, nonEmptyEnv(deploymentVariable));
  // Policy default: unset, a project may spend the whole deployment cap. The
  // deployment cap is the one number the owner consented to; any smaller
  // default would be a cap nobody chose, and a larger one could never bind.
  const rawProjectLimit = nonEmptyEnv("ASHARA_PROJECT_BUDGET_LIMIT_USD");
  const perProjectUsd =
    rawProjectLimit === undefined ? deploymentUsd : parseBudgetLimit("ASHARA_PROJECT_BUDGET_LIMIT_USD", rawProjectLimit);

  const coreLoop: CoreLoopConfig = {
    ...DEFAULT_CONFIG,
    workdirBase,
    baseBranch,
    maxBatchSize,
  };

  // Policy default: unset means "podman on PATH". Pointing it at a missing
  // binary is how an unavailable substrate is observed without uninstalling.
  const podmanBinary = nonEmptyEnv("ASHARA_PODMAN_BINARY") ?? "podman";

  return {
    databaseUrl,
    apiToken,
    port,
    coreLoop,
    spendCaps: { deploymentUsd, perProjectUsd },
    podmanBinary,
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
function parseBudgetLimit(variable: string, raw: string | undefined): number {
  if (raw === undefined) throw new InvalidBudgetLimit(variable, raw);
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidBudgetLimit(variable, raw);
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
