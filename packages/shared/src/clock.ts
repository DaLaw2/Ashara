/**
 * The time the code reads, as a port: the composition root chooses it, so whatever drives the
 * process can also decide what time it is.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The policy default: the host's clock. */
export const systemClock: Clock = { now: () => Date.now() };
