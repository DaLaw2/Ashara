import { describe, expect, test } from "vitest";

import type { RunState } from "@ashara/shared";

import type { RunStateStore } from "./run-state.js";
import { closeRun, openRun, persistRun } from "./run-state.js";

class InMemoryRunStateStore implements RunStateStore {
  state: RunState | null;
  loadError: Error | null = null;
  saveError: Error | null = null;

  constructor(state: RunState | null = null) {
    this.state = state;
  }

  async load(): Promise<RunState | null> {
    if (this.loadError) throw this.loadError;
    return this.state;
  }

  async save(state: RunState): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.state = state;
  }
}

function record(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run-1",
    openedAt: "2026-07-01T00:00:00.000Z",
    closed: false,
    spendUsd: 0,
    acceptanceAttempts: 0,
    replanRounds: 0,
    ...overrides,
  };
}

// Discipline B: the budget, the acceptance-attempt cap and the replan-round cap
// all used to live only in process memory, so every restart handed out the whole
// budget again. Per-run semantics are preserved by `closed`, not by forgetting.
describe("openRun — restart resumes, relaunch resets", () => {
  test("no record at all opens a fresh run at zero", async () => {
    const store = new InMemoryRunStateStore(null);

    const state = await openRun(store);

    expect(state.closed).toBe(false);
    expect(state.spendUsd).toBe(0);
    expect(state.acceptanceAttempts).toBe(0);
    expect(store.state).toEqual(state);
  });

  test("an OPEN record is adopted — a crashed process does not get the budget twice", async () => {
    const store = new InMemoryRunStateStore(
      record({ spendUsd: 0.93, acceptanceAttempts: 2, replanRounds: 1 }),
    );

    const state = await openRun(store);

    expect(state.runId).toBe("run-1");
    expect(state.spendUsd).toBe(0.93);
    expect(state.acceptanceAttempts).toBe(2);
    expect(state.replanRounds).toBe(1);
  });

  test("a CLOSED record starts a NEW run at zero — a finished run's spend is never resurrected", async () => {
    const store = new InMemoryRunStateStore(
      record({ runId: "previous-run", closed: true, spendUsd: 0.97, acceptanceAttempts: 2 }),
    );

    const state = await openRun(store);

    expect(state.runId).not.toBe("previous-run");
    expect(state.closed).toBe(false);
    expect(state.spendUsd).toBe(0);
    expect(state.acceptanceAttempts).toBe(0);
  });

  // Fail-closed (Discipline A): dispatching against an unknown budget baseline is
  // dispatching with no cap. The cycle must fail, not assume zero.
  test("a store failure propagates instead of defaulting to a fresh run", async () => {
    const store = new InMemoryRunStateStore(record({ spendUsd: 0.99 }));
    store.loadError = new Error("connection refused");

    await expect(openRun(store)).rejects.toThrow("connection refused");
  });
});

describe("persistRun / closeRun", () => {
  test("counters are written through so a crash resumes from the latest total", async () => {
    const store = new InMemoryRunStateStore(null);
    const opened = await openRun(store);

    await persistRun(store, opened, { spendUsd: 0.41, acceptanceAttempts: 1, replanRounds: 0 });

    expect(store.state?.spendUsd).toBe(0.41);
    expect(store.state?.acceptanceAttempts).toBe(1);
    expect(store.state?.runId).toBe(opened.runId);
  });

  // Fail-soft with a warn: a transient DB blip must not stop a run, and the
  // in-process cap still binds for this process.
  test("a persist failure does not throw", async () => {
    const store = new InMemoryRunStateStore(null);
    const opened = await openRun(store);
    store.saveError = new Error("write failed");

    await expect(
      persistRun(store, opened, { spendUsd: 0.5, acceptanceAttempts: 0, replanRounds: 0 }),
    ).resolves.toBeDefined();
  });

  test("closeRun marks the record closed, so the next process starts fresh", async () => {
    const store = new InMemoryRunStateStore(record({ spendUsd: 0.8 }));

    await closeRun(store);

    expect(store.state?.closed).toBe(true);

    const next = await openRun(store);
    expect(next.spendUsd).toBe(0);
  });

  test("closeRun on a killed-process record is what a SIGTERM path must NOT do", async () => {
    // The inverse of the test above, pinned deliberately: leaving the record open
    // is what makes a restart resume the same cap.
    const store = new InMemoryRunStateStore(record({ spendUsd: 0.8 }));

    const resumed = await openRun(store);

    expect(resumed.spendUsd).toBe(0.8);
  });
});
