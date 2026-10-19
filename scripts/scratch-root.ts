// The one scratch root that test runs and the lifecycle simulator write their temporary files
// under. It defaults to a directory on the host's /dev/shm tmpfs, so a soak or a test run writes
// nothing to the disk; ASHARA_SCRATCH_ROOT names another, existing directory. Neither silently
// falls back to the system temp directory: a root that is absent, or whose filesystem has less free
// space than the bound, stops the caller with ScratchRootUnavailableError naming the root, the
// reason and the variables that change it.
//
// Caches that must survive a reboot (tsx's and node's compile caches) are not scratch and never
// belong under this root.
//
// Run with plain node (type stripping) by the justfile recipes: it prints the resolved root, which
// they export as TMPDIR, or exits 1 with the error.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/scratch-root.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRATCH_ROOT_VAR = "ASHARA_SCRATCH_ROOT";
const SCRATCH_MIN_FREE_VAR = "ASHARA_SCRATCH_MIN_FREE_BYTES";
const SCRATCH_DIR_NAME = "ashara-scratch";
const DEFAULT_SHM = "/dev/shm";
// Below this a run is refused before it starts, rather than failing midway on ENOSPC.
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;

type ScratchRootUnavailableReason = "absent" | "full";

/** @testseam scratch-root.test.ts asserts the root, reason and byte counts it carries */
export class ScratchRootUnavailableError extends Error {
  readonly root: string;
  readonly reason: ScratchRootUnavailableReason;
  readonly bytesFree: number | null;
  readonly bytesRequired: number | null;

  constructor(root: string, reason: ScratchRootUnavailableReason, detail: string, bytes: { free: number; required: number } | null = null) {
    super(
      `scratch root ${root} is ${reason}: ${detail}. Set ${SCRATCH_ROOT_VAR} to an existing directory on a filesystem with room ` +
        `(a tmpfs keeps the writes off the disk), or lower ${SCRATCH_MIN_FREE_VAR}.`,
    );
    this.name = "ScratchRootUnavailableError";
    this.root = root;
    this.reason = reason;
    this.bytesFree = bytes === null ? null : bytes.free;
    this.bytesRequired = bytes === null ? null : bytes.required;
  }
}

/** @testseam scratch-root.test.ts asserts a malformed variable throws it */
export class ScratchRootConfigError extends Error {
  readonly variable: string;
  readonly value: string;

  constructor(variable: string, value: string, expected: string) {
    super(`${variable}=${JSON.stringify(value)} is invalid: expected ${expected}`);
    this.name = "ScratchRootConfigError";
    this.variable = variable;
    this.value = value;
  }
}

export interface ScratchRootDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The tmpfs whose ashara-scratch directory is the default root. */
  readonly shm: string;
  readonly statfs: (dir: string) => { readonly bavail: number; readonly bsize: number };
}

const hostDeps: ScratchRootDeps = { env: process.env, shm: DEFAULT_SHM, statfs: (dir) => fs.statfsSync(dir) };

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function minFreeBytes(env: ScratchRootDeps["env"]): number {
  const raw = env[SCRATCH_MIN_FREE_VAR];
  if (raw === undefined || raw === "") return DEFAULT_MIN_FREE_BYTES;
  if (!/^\d+$/.test(raw)) throw new ScratchRootConfigError(SCRATCH_MIN_FREE_VAR, raw, "a whole number of bytes");
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes)) throw new ScratchRootConfigError(SCRATCH_MIN_FREE_VAR, raw, "a whole number of bytes below 2^53");
  return bytes;
}

/** The scratch root's real path, created when it is the default under an existing tmpfs. */
export function resolveScratchRoot(deps: ScratchRootDeps = hostDeps): string {
  const configured = deps.env[SCRATCH_ROOT_VAR];
  let root: string;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured)) throw new ScratchRootConfigError(SCRATCH_ROOT_VAR, configured, "an absolute path");
    root = configured;
    if (!isDirectory(root)) throw new ScratchRootUnavailableError(root, "absent", `${SCRATCH_ROOT_VAR} names no existing directory`);
  } else {
    root = path.join(deps.shm, SCRATCH_DIR_NAME);
    if (!isDirectory(deps.shm)) throw new ScratchRootUnavailableError(root, "absent", `the default tmpfs ${deps.shm} does not exist on this host`);
    fs.mkdirSync(root, { recursive: true });
  }
  const required = minFreeBytes(deps.env);
  const stats = deps.statfs(root);
  const free = stats.bavail * stats.bsize;
  if (free < required) {
    throw new ScratchRootUnavailableError(root, "full", `${free} bytes free, ${required} required`, { free, required });
  }
  return fs.realpathSync(root);
}

function main(): number {
  try {
    process.stdout.write(`${resolveScratchRoot()}\n`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
