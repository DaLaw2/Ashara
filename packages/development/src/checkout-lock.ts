import { basename, dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { describeErrorChain } from "@ashara/shared";

/** Not even the filesystem root of a path resolves: it names no place a lock or a guard can key on. */
class TargetPathUncanonical extends Error {
  constructor(
    readonly inputPath: string,
    options: { readonly cause: unknown },
  ) {
    super(`no existing ancestor could be resolved for "${inputPath}": ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "TargetPathUncanonical";
  }
}

// realpath() fails on paths that do not exist yet. A minted target is usually
// not created at validation time, so resolve the nearest existing ancestor and
// re-append the missing tail. Fail closed if NO ancestor resolves.
export async function canonicalizeAllowingMissing(inputPath: string): Promise<string> {
  let current = resolve(inputPath);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (err) {
      const parent = dirname(current);
      if (parent === current) throw new TargetPathUncanonical(inputPath, { cause: err });
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** The last holder's release of each target checkout, keyed by canonical path; a key is gone when free. */
const tails = new Map<string, Promise<void>>();

/**
 * Runs `use` while holding the target checkout's lock: one holder at a time per canonical target
 * path, in arrival order, released when `use` settles either way. The target's main checkout is the
 * merge queue's staging area (its index holds a tentative merge while its checks run), so whatever
 * resets, merges into, commits or initialises it runs here (ADR-074 d82 W3). In-process only: one
 * Ashara process drives a target; a process that died holding it left an orphaned merge, which
 * finalize's recoverOrphanedMerge clears under the lock.
 */
export async function withTargetCheckout<T>(targetProjectPath: string, use: () => Promise<T>): Promise<T> {
  const key = await canonicalizeAllowingMissing(targetProjectPath);
  // Free when no holder is recorded: the lock's own state, not evidence about the checkout.
  const previous = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => held);
  tails.set(key, tail);
  await previous;
  try {
    return await use();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
