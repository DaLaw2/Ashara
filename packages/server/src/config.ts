import path from "node:path";
import { z } from "zod";
import type { CoreLoopConfig } from "@ashara/delivery";
import { DEFAULT_CONFIG } from "@ashara/delivery";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { readCellLimits, type CellResourceLimits, type HostCapacity, type PodmanSubstrate } from "@ashara/execution-infra";
import { DEFAULT_WORK_BUDGETS, type WorkBudgets } from "@ashara/finance";

interface ServerConfig {
  readonly databaseUrl: string;
  readonly apiToken: string;
  readonly port: number;
  readonly coreLoop: CoreLoopConfig;
  /** Finance's spend caps in USD, summed from llm_calls (see SpendCap). */
  readonly spendCaps: {
    readonly deploymentUsd: number;
    readonly perProjectUsd: number;
  };
  /** Finance's work ledger budgets in model requests, counted from llm_calls (see WorkLedger). */
  readonly workBudgets: WorkBudgets;
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

/** The configured task lanes' cells cannot all fit the host they run on at once: the server refuses to boot. */
class TaskLanesExceedHost extends Error {
  constructor(
    readonly lanes: number,
    readonly cellsAtOnce: number,
    readonly resource: "memory" | "cpus",
    readonly needed: number,
    readonly host: number,
    readonly source: string,
  ) {
    const amount = (value: number) => (resource === "memory" ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${value} CPUs`);
    super(
      `ASHARA_TASK_LANES=${lanes} runs up to ${cellsAtOnce} cells at once, whose ${resource} caps need ${amount(needed)}, ` +
        `but the host cells run on has ${amount(host)} (read from ${source}); lower ASHARA_TASK_LANES or the cell caps ` +
        "(ASHARA_CELL_MEMORY, ASHARA_CELL_CPUS)",
    );
    this.name = "TaskLanesExceedHost";
  }
}

/**
 * Refuses lanes whose cells cannot all run at once on the host the cell runtime starts them on: each
 * lane holds one cell at a time, and one more (a check cell or an image build) may run beside them,
 * each capped at `cells`. The capacity is the runtime's, not this process's: cells run in scopes of
 * their own, outside any CPU quota or memory limit the server itself runs under.
 */
export async function assertLanesFitCellHost(
  lanes: number,
  cells: CellResourceLimits,
  runtime: Pick<PodmanSubstrate, "hostCapacity">,
): Promise<void> {
  assertLanesFitHost(lanes, cells, await runtime.hostCapacity());
}

function assertLanesFitHost(lanes: number, cells: CellResourceLimits, host: HostCapacity): void {
  const cellsAtOnce = lanes + 1;
  if (cellsAtOnce * cells.memoryBytes > host.memoryBytes) {
    throw new TaskLanesExceedHost(lanes, cellsAtOnce, "memory", cellsAtOnce * cells.memoryBytes, host.memoryBytes, host.source);
  }
  if (cellsAtOnce * cells.cpus > host.cpus) {
    throw new TaskLanesExceedHost(lanes, cellsAtOnce, "cpus", cellsAtOnce * cells.cpus, host.cpus, host.source);
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

/** A setting under a name the server no longer reads: honoured silently, it would be ignored. */
class RetiredServerSetting extends Error {
  constructor(
    readonly variable: string,
    readonly raw: string,
    readonly replacement: string,
  ) {
    super(`${variable}="${raw}" is no longer read; set ${replacement} instead and unset ${variable}`);
    this.name = "RetiredServerSetting";
  }
}

export function loadDatabaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}

/** The policy default of ASHARA_SHUTDOWN_DEADLINE_MS: what a process manager's stop timeout commonly allows. */
const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;
/** A deadline above this would outlast what any process manager waits before it kills the process. */
const MAX_SHUTDOWN_DEADLINE_MS = 600_000;

/**
 * The one bound on a shutdown, graceful or fatal (ASHARA_SHUTDOWN_DEADLINE_MS): every model call
 * and agent session in flight is aborted at once, and past it the process exits without the rest,
 * which the next startup reconciles. A set but unusable one is refused, never replaced.
 */
export function loadShutdownDeadlineMs(): number {
  const raw = nonEmptyEnv("ASHARA_SHUTDOWN_DEADLINE_MS");
  return raw === undefined ? DEFAULT_SHUTDOWN_DEADLINE_MS : parseIntegerSetting("ASHARA_SHUTDOWN_DEADLINE_MS", raw, 1, MAX_SHUTDOWN_DEADLINE_MS);
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

  // MAX_BATCH_SIZE is not read: a value set under it would be ignored without a word, so the boot
  // is refused while it is set.
  const retiredBatchSize = nonEmptyEnv("MAX_BATCH_SIZE");
  if (retiredBatchSize !== undefined) throw new RetiredServerSetting("MAX_BATCH_SIZE", retiredBatchSize, "ASHARA_TASK_LANES");
  // Policy default: unset, the loop's own lane count (DEFAULT_CONFIG). It sets throughput only, and
  // is checked with the cell caps against the host cells run on once the cell runtime is composed
  // (assertLanesFitCellHost); a set but unusable one is refused, never replaced.
  const rawLanes = nonEmptyEnv("ASHARA_TASK_LANES");
  const laneCount = rawLanes === undefined ? DEFAULT_CONFIG.laneCount : parseIntegerSetting("ASHARA_TASK_LANES", rawLanes, 1, Number.MAX_SAFE_INTEGER);
  // Both names set the one deployment cap, so a cap the owner set under either
  // name is enforced; the dedicated ASHARA_BUDGET_LIMIT_USD wins
  // when both are set. Blank values are treated
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

  // Policy defaults: unset, Finance's budgets and verification
  // reserve (DEFAULT_WORK_BUDGETS). A set but unusable
  // one is refused, never replaced.
  const rawTaskWork = nonEmptyEnv("ASHARA_TASK_WORK_BUDGET_REQUESTS");
  const rawProjectWork = nonEmptyEnv("ASHARA_PROJECT_WORK_BUDGET_REQUESTS");
  const rawReserve = nonEmptyEnv("ASHARA_WORK_RESERVE_PERCENT");
  const workBudgets: WorkBudgets = {
    verificationReservePercent:
      rawReserve === undefined ? DEFAULT_WORK_BUDGETS.verificationReservePercent : parseIntegerSetting("ASHARA_WORK_RESERVE_PERCENT", rawReserve, 0, 99),
    perTaskRequests:
      rawTaskWork === undefined
        ? DEFAULT_WORK_BUDGETS.perTaskRequests
        : parseIntegerSetting("ASHARA_TASK_WORK_BUDGET_REQUESTS", rawTaskWork, 1, Number.MAX_SAFE_INTEGER),
    perProjectRequests:
      rawProjectWork === undefined
        ? DEFAULT_WORK_BUDGETS.perProjectRequests
        : parseIntegerSetting("ASHARA_PROJECT_WORK_BUDGET_REQUESTS", rawProjectWork, 1, Number.MAX_SAFE_INTEGER),
  };

  const coreLoop: CoreLoopConfig = {
    ...DEFAULT_CONFIG,
    workdirBase,
    laneCount,
  };

  // Policy default: unset means "podman on PATH". Pointing it at a missing
  // binary is how an unavailable substrate is observed without uninstalling.
  const podmanBinary = nonEmptyEnv("ASHARA_PODMAN_BINARY") ?? "podman";
  // No default: the host also runs Postgres and Z0, so the caps are the owner's choice.
  const cellLimits = readCellLimits(process.env);

  return {
    databaseUrl,
    apiToken,
    port,
    coreLoop,
    spendCaps: { deploymentUsd, perProjectUsd },
    workBudgets,
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
