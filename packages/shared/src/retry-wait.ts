/** Answers a retry's wait in place of the host's timer; production installs none. */
type RetryWaitObserver = (ms: number) => Promise<void>;

let observer: RetryWaitObserver | null = null;

/**
 * The wait between two attempts of a bounded retry. With no observer installed (production) it is
 * a timer of `ms` on the host. A driver whose clock is simulated (the lifecycle simulator) or a
 * test that judges the retry, not its pause, installs an observer: a host timer moves no simulated
 * clock, so there it only holds up the run.
 */
export function retryWait(ms: number): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- real wait: the host timer every retry pause stands for when no observer is installed
  return observer === null ? new Promise((resolve) => setTimeout(resolve, ms)) : observer(ms);
}

/** Installs `next` for the process; returns what puts the previous one back. */
export function observeRetryWaits(next: RetryWaitObserver): () => void {
  const previous = observer;
  observer = next;
  return () => {
    observer = previous;
  };
}
