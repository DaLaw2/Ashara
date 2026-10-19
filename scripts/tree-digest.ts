/**
 * The digest of a directory tree, the one function both a hidden suite's verdict (its `suiteDigest` and product
 * digest, scripts/hidden-suite.ts) and a pre-registration use, so the two compare by string equality.
 *
 *   npx tsx scripts/tree-digest.ts <dir> [<dir> ...]
 *
 * Prints `<digest>  <dir>` per directory. The digest is `sha256:` and the hex sha256 over every entry below the root,
 * each directory's names in sorted order, depth first: a file contributes its path, executable bit and content; a
 * directory its path; a symbolic link its path and its target text, never followed, so a link is recorded and a change
 * of target changes the digest; anything else (a socket, a fifo, a device) its path and kind only. The root's own name,
 * owners, timestamps and other permission bits are not part of it. An entry that cannot be read stops the digest with a
 * TreeDigestError naming it: a partial tree never yields a digest. Exit status: 0 every directory digested, 1 otherwise.
 */

import { createHash, type Hash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";

const USAGE = "Usage: npx tsx scripts/tree-digest.ts <dir> [<dir> ...]";

/** @testseam tree-digest.test.ts checks an unreadable entry throws this type */
export class TreeDigestError extends Error {
  constructor(
    readonly root: string,
    readonly entry: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`tree-digest: ${JSON.stringify(entry)} under ${JSON.stringify(root)} cannot be digested: ${detail}`, options);
    this.name = "TreeDigestError";
  }
}

async function read<T>(root: string, entry: string, what: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    throw new TreeDigestError(root, entry, `${what} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

async function walk(hash: Hash, root: string, relative: string): Promise<void> {
  const directory = path.join(root, relative);
  const names = (await read(root, relative === "" ? "." : relative, "listing the directory", () => readdir(directory))).sort();
  for (const name of names) {
    const entryPath = relative === "" ? name : `${relative}/${name}`;
    const full = path.join(root, entryPath);
    const entry = await read(root, entryPath, "lstat", () => lstat(full));
    if (entry.isSymbolicLink()) {
      hash.update(`l\0${entryPath}\0${await read(root, entryPath, "reading the link", () => readlink(full))}\0`);
    } else if (entry.isDirectory()) {
      hash.update(`d\0${entryPath}\0`);
      await walk(hash, root, entryPath);
    } else if (entry.isFile()) {
      hash.update(`f\0${entryPath}\0${(entry.mode & 0o111) === 0 ? "-" : "x"}\0`);
      hash.update(await read(root, entryPath, "reading the file", () => readFile(full)));
      hash.update("\0");
    } else {
      hash.update(`o\0${entryPath}\0`);
    }
  }
}

export async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  await walk(hash, root, "");
  return `sha256:${hash.digest("hex")}`;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    console.error(USAGE);
    return 1;
  }
  for (const dir of argv) {
    try {
      console.log(`${await treeDigest(path.resolve(dir))}  ${dir}`);
    } catch (err) {
      console.error(describeErrorChain(err));
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (err: unknown) => {
      console.error(describeErrorChain(err));
      process.exitCode = 1;
    },
  );
}
