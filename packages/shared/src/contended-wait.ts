/**
 * The in-process waits one task of a batch makes on another's turn: the target checkout's lock
 * (development checkout-lock.ts) and the spend cap's admission queue (finance spend-cap.ts).
 */
export type ContendedWaitKind = "target-checkout" | "spend-admission";

/** Sees a contended wait and returns what the waiter awaits instead; production installs none. */
export type ContendedWaitObserver = (kind: ContendedWaitKind, waiting: Promise<unknown>) => Promise<unknown>;

let observer: ContendedWaitObserver | null = null;

/**
 * Awaited by a task about to wait on another task's turn; its value is never read. With no
 * observer installed (production) it is `waiting` itself. An observer is what lets a driver that
 * runs one task at a time (the lifecycle simulator) know the waiter cannot go on until another
 * task does.
 */
export function contendedWait(kind: ContendedWaitKind, waiting: Promise<unknown>): Promise<unknown> {
  return observer === null ? waiting : observer(kind, waiting);
}

/** Installs `next` for the process; returns what puts the previous one back. */
export function observeContendedWaits(next: ContendedWaitObserver): () => void {
  const previous = observer;
  observer = next;
  return () => {
    observer = previous;
  };
}
