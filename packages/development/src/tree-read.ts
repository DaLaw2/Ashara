import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Z0's only way to read a tree a cell can write: a task worktree, the target checkout, a target
 * repository. A cell can commit `NOTES -> /etc/shadow`; a symlink-following read would then carry
 * a host file into the next brief, the records and the model provider. Every path component is
 * lstat'ed and a symbolic link anywhere refuses the read; the final file is opened with
 * O_NOFOLLOW and O_NONBLOCK (a planted FIFO must not hang Z0), and the opened file and every
 * component are re-checked against what was lstat'ed, so a swap during the read is refused too.
 */
export class TreePathRefused extends Error {
  constructor(
    readonly root: string,
    readonly path: string,
    readonly target: string | null,
    readonly reason: string,
  ) {
    super(
      `refusing to read ${JSON.stringify(path)} in the cell-writable tree ${JSON.stringify(root)}: ${reason}` +
        (target === null ? "" : ` (it points to ${JSON.stringify(target)})`),
    );
    this.name = "TreePathRefused";
  }
}

export type TreeFileRead =
  | { readonly kind: "file"; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "absent" };

export interface TreeEntry {
  readonly name: string;
  /** From lstat: a symbolic link is reported as one, never as what it points to. */
  readonly kind: "file" | "directory" | "symlink" | "other";
}

interface Walked {
  readonly rootReal: string;
  readonly fullPath: string;
  readonly prefixes: readonly string[];
  readonly chain: readonly BigIntStats[];
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

function isAbsence(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function segmentsOf(root: string, relPath: string): string[] {
  if (relPath.includes("\0") || isAbsolute(relPath)) {
    throw new TreePathRefused(root, relPath, null, "the path is absolute or contains NUL; only a path relative to the tree is read");
  }
  const segments = relPath.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new TreePathRefused(root, relPath, null, "the path climbs out of the tree with '..'");
  }
  return segments;
}

async function linkTarget(path: string): Promise<string> {
  try {
    return await readlink(path);
  } catch (err) {
    return `<unreadable link: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

/** Returns null when the path does not exist (or a component is not a directory). */
async function walk(root: string, relPath: string): Promise<Walked | null> {
  const segments = segmentsOf(root, relPath);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (err) {
    if (isAbsence(err)) return null;
    throw err;
  }
  const prefixes = [rootReal];
  for (let i = 0; i < segments.length; i++) prefixes.push(join(rootReal, ...segments.slice(0, i + 1)));

  const chain: BigIntStats[] = [];
  for (let i = 0; i < prefixes.length; i++) {
    const path = prefixes[i];
    let stats: BigIntStats;
    try {
      stats = await lstat(path, { bigint: true });
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new TreePathRefused(root, relPath, await linkTarget(path), `${JSON.stringify(path)} is a symbolic link`);
    }
    if (i < prefixes.length - 1 && !stats.isDirectory()) return null;
    chain.push(stats);
  }
  return { rootReal, fullPath: prefixes[prefixes.length - 1], prefixes, chain };
}

function sameNode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function assertUnchanged(root: string, relPath: string, walked: Walked): Promise<void> {
  for (let i = 0; i < walked.prefixes.length; i++) {
    const path = walked.prefixes[i];
    let now: BigIntStats;
    try {
      now = await lstat(path, { bigint: true });
    } catch (err) {
      throw new TreePathRefused(root, relPath, null, `${JSON.stringify(path)} vanished while it was read (${errorCode(err) ?? String(err)})`);
    }
    if (now.isSymbolicLink()) {
      throw new TreePathRefused(root, relPath, await linkTarget(path), `${JSON.stringify(path)} became a symbolic link while it was read`);
    }
    if (!sameNode(now, walked.chain[i])) {
      throw new TreePathRefused(root, relPath, null, `${JSON.stringify(path)} was replaced while it was read`);
    }
  }
}

/**
 * Reads at most `maxBytes` of the regular file at `relPath` under `root`. Absent is a value; a
 * symbolic link, a path out of the tree, or anything but a regular file throws TreePathRefused.
 */
export async function readTreeFile(root: string, relPath: string, maxBytes: number): Promise<TreeFileRead> {
  if (segmentsOf(root, relPath).length === 0) {
    throw new TreePathRefused(root, relPath, null, "the path names the tree root, not a file in it");
  }
  const walked = await walk(root, relPath);
  if (walked === null) return { kind: "absent" };
  const expected = walked.chain[walked.chain.length - 1];
  if (!expected.isFile()) {
    throw new TreePathRefused(root, relPath, null, `${JSON.stringify(walked.fullPath)} is not a regular file`);
  }

  let handle;
  try {
    handle = await open(walked.fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (isAbsence(err)) return { kind: "absent" };
    if (errorCode(err) === "ELOOP") {
      throw new TreePathRefused(root, relPath, await linkTarget(walked.fullPath), "the file became a symbolic link before it was opened");
    }
    throw err;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameNode(opened, expected)) {
      throw new TreePathRefused(root, relPath, null, "the opened file is not the regular file that was checked");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    await assertUnchanged(root, relPath, walked);
    const truncated = filled > maxBytes;
    return { kind: "file", text: buffer.subarray(0, Math.min(filled, maxBytes)).toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

/** Lists the directory at `relPath` (default: the root) without following links; null when absent. */
export async function listTreeDir(root: string, relPath = ""): Promise<TreeEntry[] | null> {
  const walked = await walk(root, relPath);
  if (walked === null) return null;
  if (!walked.chain[walked.chain.length - 1].isDirectory()) {
    throw new TreePathRefused(root, relPath, null, `${JSON.stringify(walked.fullPath)} is not a directory`);
  }
  const dirents = await readdir(walked.fullPath, { withFileTypes: true });
  await assertUnchanged(root, relPath, walked);
  return dirents.map((d) => ({
    name: d.name,
    kind: d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "directory" : d.isFile() ? "file" : "other",
  }));
}

/** Whether `relPath` exists under `root` as a directory, checked without following any link. */
export async function treeHasDirectory(root: string, relPath: string): Promise<boolean> {
  const walked = await walk(root, relPath);
  return walked !== null && walked.chain[walked.chain.length - 1].isDirectory();
}
