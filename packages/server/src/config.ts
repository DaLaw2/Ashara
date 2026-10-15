import path from "node:path";
import { z } from "zod";
import type { CoreLoopConfig } from "@ashara/orchestrator";
import { DEFAULT_CONFIG } from "@ashara/orchestrator";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { readCellLimits, type CellResourceLimits } from "@ashara/execution-infra";

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
  /**
   * The CPU, memory and pids caps of every cell and every image build (ASHARA_CELL_MEMORY,
   * ASHARA_CELL_CPUS, ASHARA_CELL_PIDS_LIMIT). Required: an unset or malformed one refuses the boot.
   */
  readonly cellLimits: CellResourceLimits;
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

/** A server setting that is unset with no default, or set to a value it cannot take. */
class InvalidServerSetting extends Error {
  constructor(
    public readonly variable: string,
    public readonly raw: string | undefined,
    public readonly expected: string,
  ) {
    super(
      raw === undefined
        ? `${variable} is not set; expected ${expected}`
        : `${variable}="${raw}" is not ${expected}`,
    );
    this.name = "InvalidServerSetting";
  }
}

export function loadDatabaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}

export function loadServerConfig(databaseUrl: string, apiToken: string): ServerConfig {

  // Policy default: unset, the web client listens on 3000 (README). A wrong port is seen at once,
  // and the number flows into no verdict; a set but unusable one is refused, never replaced.
  const rawPort = nonEmptyEnv("ASHARA_PORT");
  const port = rawPort === undefined ? 3000 : parseIntegerSetting("ASHARA_PORT", rawPort, 1, 65535);

  // No default: projects, their worktrees and the pipeline log live here, and the database keeps
  // pointing at them after a restart. A temp directory would answer "is this kept?" with a guess
  // the operator never made, and a reboot may clear it.
  const workdirBaseRaw = nonEmptyEnv("WORKDIR_BASE");
  if (workdirBaseRaw === undefined) {
    throw new InvalidServerSetting("WORKDIR_BASE", undefined, "the directory where projects are kept");
  }
  const workdirBase = path.resolve(workdirBaseRaw);

  // Policy default: unset, the loop's own batch size (DEFAULT_CONFIG). It sets throughput only;
  // a set but unusable one is refused, never replaced.
  const rawBatchSize = nonEmptyEnv("MAX_BATCH_SIZE");
  const maxBatchSize =
    rawBatchSize === undefined
      ? DEFAULT_CONFIG.maxBatchSize
      : parseIntegerSetting("MAX_BATCH_SIZE", rawBatchSize, 1, Number.MAX_SAFE_INTEGER);
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
    maxBatchSize,
  };

  // Policy default: unset means "podman on PATH". Pointing it at a missing
  // binary is how an unavailable substrate is observed without uninstalling.
  const podmanBinary = nonEmptyEnv("ASHARA_PODMAN_BINARY") ?? "podman";
  // No default: the host also runs Postgres and Z0, so the caps are the owner's choice (W9).
  const cellLimits = readCellLimits(process.env);

  return {
    databaseUrl,
    apiToken,
    port,
    coreLoop,
    spendCaps: { deploymentUsd, perProjectUsd },
    podmanBinary,
    cellLimits,
  };
}

function nonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

const DecimalInteger = z.string().trim().regex(/^\d+$/).transform(Number);

function parseIntegerSetting(variable: string, raw: string, min: number, max: number): number {
  const parsed = DecimalInteger.pipe(z.number().int().min(min).max(max)).safeParse(raw);
  if (!parsed.success) throw new InvalidServerSetting(variable, raw, `an integer from ${min} to ${max}`);
  return parsed.data;
}

// An owner-set cap that does not parse is not consent to the default: a typo must
// not silently become a different spend limit.
function parseBudgetLimit(variable: string, raw: string | undefined): number {
  if (raw === undefined) throw new InvalidBudgetLimit(variable, raw);
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidBudgetLimit(variable, raw);
  return parsed;
}
