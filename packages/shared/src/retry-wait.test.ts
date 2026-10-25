import { afterEach, describe, expect, test, vi } from "vitest";
import { observeRetryWaits, retryWait } from "./retry-wait.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("retryWait", () => {
  test("with no observer it is a host timer of the pause it is given", async () => {
    vi.useFakeTimers();
    let ended = false;
    const waiting = retryWait(1_000).then(() => {
      ended = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(ended).toBe(true);
  });

  test("an installed observer answers every pause in place of the timer, and its restore puts the timer back", async () => {
    const pauses: number[] = [];
    const restore = observeRetryWaits((ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });
    try {
      await retryWait(250);
      await retryWait(1_000);
    } finally {
      restore();
    }
    expect(pauses).toEqual([250, 1_000]);

    vi.useFakeTimers();
    let ended = false;
    const waiting = retryWait(10).then(() => {
      ended = true;
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(pauses).toEqual([250, 1_000]);
  });
});
