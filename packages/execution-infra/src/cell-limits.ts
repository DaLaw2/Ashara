import { z } from "zod";
import { CellLimitsInvalid } from "./errors.js";

/**
 * The resource caps every cell and every image build runs under (ADR-074 d82 W9). Required
 * configuration with no default in code: the host also runs Postgres and Z0, and a cap nobody
 * chose is not a cap the owner consented to.
 */
export interface CellResourceLimits {
  /** The memory cap in bytes; swap beyond it is denied (--memory-swap equals --memory). */
  readonly memoryBytes: number;
  /** CPUs as a fraction of whole cores (--cpus; a CFS quota over a 100 ms period for builds). */
  readonly cpus: number;
  /** The most processes and threads a cell may hold at once (--pids-limit). */
  readonly pids: number;
}

/** The environment variables an operator sets the limits with. */
export const CELL_LIMIT_VARIABLES = {
  memory: "ASHARA_CELL_MEMORY",
  cpus: "ASHARA_CELL_CPUS",
  pids: "ASHARA_CELL_PIDS_LIMIT",
} as const;

/** podman refuses a memory limit below 6 MiB. */
const MIN_MEMORY_BYTES = 6 * 1024 * 1024;
const CFS_PERIOD_MICROS = 100_000;
const UNIT_BYTES: Readonly<Record<string, number>> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export const cellLimitsSchema = z
  .object({
    memoryBytes: z.number().int().min(MIN_MEMORY_BYTES).max(Number.MAX_SAFE_INTEGER),
    // At least one hundredth of a core: the quota is whole microseconds of a 100 ms period.
    cpus: z.number().finite().min(0.01),
    pids: z.number().int().min(1),
  })
  .strict();

function parseMemory(raw: string): number | null {
  const match = /^([1-9][0-9]*)([bkmg])?$/i.exec(raw.trim());
  if (match?.[1] === undefined) return null;
  const unit = UNIT_BYTES[(match[2] ?? "b").toLowerCase()];
  if (unit === undefined) return null;
  const bytes = Number(match[1]) * unit;
  return Number.isSafeInteger(bytes) && bytes >= MIN_MEMORY_BYTES ? bytes : null;
}

function parseCpus(raw: string): number | null {
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(raw.trim())) return null;
  const cpus = Number(raw.trim());
  return Number.isFinite(cpus) && cpus >= 0.01 ? cpus : null;
}

function parsePids(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw.trim())) return null;
  const pids = Number(raw.trim());
  return Number.isSafeInteger(pids) ? pids : null;
}

/**
 * Reads the three limits from `env`. A variable that is unset, blank or malformed throws
 * CellLimitsInvalid naming it, the value read and the form expected: there is no fallback.
 */
export function readCellLimits(env: Readonly<Record<string, string | undefined>>): CellResourceLimits {
  const read = (variable: string, expected: string, parse: (raw: string) => number | null): number => {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === "") throw new CellLimitsInvalid(variable, raw ?? null, expected);
    const value = parse(raw);
    if (value === null) throw new CellLimitsInvalid(variable, raw, expected);
    return value;
  };
  return {
    memoryBytes: read(CELL_LIMIT_VARIABLES.memory, "a whole number with an optional b, k, m or g suffix, at least 6m (for example 4g)", parseMemory),
    cpus: read(CELL_LIMIT_VARIABLES.cpus, "a number of CPUs, at least 0.01, with at most two decimals (for example 4)", parseCpus),
    pids: read(CELL_LIMIT_VARIABLES.pids, "a positive whole number of processes (for example 1024)", parsePids),
  };
}

/** The `podman run` options that cap a cell. */
export function runLimitArgs(limits: CellResourceLimits): string[] {
  return [
    `--memory=${limits.memoryBytes}`,
    `--memory-swap=${limits.memoryBytes}`,
    `--cpus=${limits.cpus}`,
    `--pids-limit=${limits.pids}`,
  ];
}

/** The CFS quota `--cpus` stands for, over CFS_PERIOD_MICROS. */
function cpuQuotaMicros(cpus: number): number {
  return Math.round(cpus * CFS_PERIOD_MICROS);
}

/**
 * The `podman build` options that cap each build container. podman build has no --cpus and no
 * --pids-limit (podman 5.8.2 `podman build --help`): the CPU cap is the same CFS quota --cpus sets,
 * and the pids cap is not applied to builds.
 */
export function buildLimitArgs(limits: CellResourceLimits): string[] {
  return [
    `--memory=${limits.memoryBytes}`,
    `--memory-swap=${limits.memoryBytes}`,
    `--cpu-period=${CFS_PERIOD_MICROS}`,
    `--cpu-quota=${cpuQuotaMicros(limits.cpus)}`,
  ];
}

/** cgroup v2's `cpu.max` line a cell capped at `cpus` reads: "<quota> <period>". */
export function expectedCpuMax(limits: CellResourceLimits): string {
  return `${cpuQuotaMicros(limits.cpus)} ${CFS_PERIOD_MICROS}`;
}
