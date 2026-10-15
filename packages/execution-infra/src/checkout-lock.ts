import { basename, dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { contendedWait, describeErrorChain } from "@ashara/shared";

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

/**
 * The allowance of a holder's own host-side work: the git commands and file writes it runs on the
 * checkout outside any cell. Nothing else bounds them (runHostGit sets no timeout), so no existing
 * timeout can be derived for them; on a local checkout they take seconds, and five minutes of them
 * is a hang. Every phase that runs in cells adds its own bound (CheckoutLease.extend).
 */
const HOST_WORK_BOUND_MS = 5 * 60 * 1000;

/** The holder's bound so far: what it is, and every phase that added to it. */
export interface CheckoutLease {
  /** Raises the holder's bound by `ms` before a phase bounded by its own timeouts; `why` names it. */
  extend(ms: number, why: string): void;
}

/**
 * A waiter for a target checkout gave up: the holder ahead of it outlasted the bound it declared.
 * A holder past its bound is stuck (a hung git command, or Z0's own code), and every phase it
 * declared is bounded by its own timeout, so waiting longer would wait forever.
 */
export class CheckoutHolderOverran extends Error {
  constructor(
    readonly targetPath: string,
    readonly holder: string,
    readonly waiter: string,
    readonly boundMs: number,
    readonly heldMs: number,
    readonly phases: readonly string[],
  ) {
    super(
      `${waiter} gave up waiting for the target checkout ${targetPath}: its holder, ${holder}, has held it ` +
        `${heldMs} ms, past its bound of ${boundMs} ms (${phases.join("; ")})`,
    );
    this.name = "CheckoutHolderOverran";
  }
}

class InvalidLeaseExtension extends Error {
  constructor(
    readonly holder: string,
    readonly ms: number,
    readonly why: string,
  ) {
    super(`${holder}: a lease extension must be a positive finite number of ms, got ${ms} for ${why}`);
    this.name = "InvalidLeaseExtension";
  }
}

interface Holder {
  readonly name: string;
  readonly acquiredAt: number;
  boundMs: number;
  readonly phases: string[];
}

interface CheckoutState {
  /** The last arrival's release; a waiter queues behind it. */
  tail: Promise<void>;
  holder: Holder | null;
  /** Settles whenever the holder changes or extends its bound, so a waiter re-reads the deadline. */
  changed: Promise<void>;
  signal: () => void;
}

/** Each target checkout's queue, keyed by canonical path; a key is gone when free. */
const checkouts = new Map<string, CheckoutState>();

function signalled(state: CheckoutState): void {
  const fire = state.signal;
  state.changed = new Promise<void>((done) => {
    state.signal = done;
  });
  fire();
}

function newState(): CheckoutState {
  let signal: () => void = () => {};
  const changed = new Promise<void>((done) => {
    signal = done;
  });
  return { tail: Promise.resolve(), holder: null, changed, signal };
}

/** Resolves once `previous` settles; throws once the holder in front is past its bound. */
async function waitBehind(key: string, state: CheckoutState, previous: Promise<void>, waiter: string): Promise<void> {
  let free = false;
  void previous.then(() => {
    free = true;
  });
  for (;;) {
    const holder = state.holder;
    const changed = state.changed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overran =
      holder === null
        ? new Promise<never>(() => {})
        : new Promise<"overran">((done) => {
            timer = setTimeout(() => done("overran"), Math.max(0, holder.acquiredAt + holder.boundMs - Date.now()));
          });
    const woke = await Promise.race([previous.then(() => "free" as const), changed.then(() => "changed" as const), overran]);
    if (timer !== undefined) clearTimeout(timer);
    if (woke === "free" || free) return;
    if (woke === "overran" && holder !== null && state.holder === holder && Date.now() >= holder.acquiredAt + holder.boundMs) {
      throw new CheckoutHolderOverran(key, holder.name, waiter, holder.boundMs, Date.now() - holder.acquiredAt, holder.phases);
    }
  }
}

/**
 * Runs `use` while holding the target checkout's lock: one holder at a time per canonical target
 * path, in arrival order, released when `use` settles either way. The target's main checkout is the
 * merge queue's staging area (its index holds a tentative merge while its checks run), so whatever
 * resets, merges into, commits or initialises it runs here (ADR-074 d82 W3).
 *
 * The wait is bounded: a holder declares a bound, HOST_WORK_BOUND_MS for its host-side work plus
 * what it adds for each phase in cells (CheckoutLease.extend), and a waiter whose holder outlasts
 * that bound fails with CheckoutHolderOverran naming the holder rather than wait forever (ADR-074
 * d82). The waiter does not take the checkout: it may still hold a staged merge, so the waiters
 * behind it keep queueing behind the stuck holder and fail the same way.
 *
 * In-process only: one Ashara process drives a target, which the server holds a database claim on
 * for its lifetime (claimTargetCheckouts in @ashara/db). A process that died holding the lock left
 * an orphaned merge, which finalize's recoverOrphanedMerge clears under the lock.
 */
export async function withTargetCheckout<T>(targetProjectPath: string, holder: string, use: (lease: CheckoutLease) => Promise<T>): Promise<T> {
  const key = await canonicalizeAllowingMissing(targetProjectPath);
  let state = checkouts.get(key);
  if (state === undefined) {
    state = newState();
    checkouts.set(key, state);
  }
  const previous = state.tail;
  let release: () => void = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => held);
  state.tail = tail;
  const settle = (current: CheckoutState): void => {
    release();
    if (current.tail === tail) checkouts.delete(key);
  };

  try {
    await contendedWait("target-checkout", waitBehind(key, state, previous, holder));
  } catch (e) {
    // Passed through, not taken: the next waiter still queues behind the stuck holder.
    const current = state;
    void previous.then(() => settle(current));
    throw e;
  }

  const mine: Holder = { name: holder, acquiredAt: Date.now(), boundMs: HOST_WORK_BOUND_MS, phases: [`host-side work ${HOST_WORK_BOUND_MS} ms`] };
  state.holder = mine;
  signalled(state);
  const current = state;
  const lease: CheckoutLease = {
    extend(ms, why) {
      if (!Number.isFinite(ms) || ms <= 0) throw new InvalidLeaseExtension(holder, ms, why);
      mine.boundMs += ms;
      mine.phases.push(`${why} ${ms} ms`);
      if (current.holder === mine) signalled(current);
    },
  };
  try {
    return await use(lease);
  } finally {
    if (current.holder === mine) current.holder = null;
    signalled(current);
    settle(current);
  }
}
