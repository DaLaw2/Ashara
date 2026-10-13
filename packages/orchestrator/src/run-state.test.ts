import { describe, expect, test } from "vitest";
import type { RunState } from "@ashara/shared";
import type { RunStateStore } from "./run-state.js";
import { openRun, persistRun } from "./run-state.js";

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
    spendUsd: 0,
    ...overrides,
  };
}

// Discipline B: the budget used to live only in process memory, so every restart
// handed out the whole budget again. Nothing closes the record, so the spend is a
// lifetime total per database (ADR-073 addendum 3).
describe("openRun — a restart resumes the recorded spend", () => {
  test("no record at all opens a fresh run at zero", async () => {
    const store = new InMemoryRunStateStore(null);

    const state = await openRun(store);

    expect(state.spendUsd).toBe(0);
    expect(store.state).toEqual(state);
  });

  test("an existing record is adopted — a restarted process does not get the budget twice", async () => {
    const store = new InMemoryRunStateStore(record({ spendUsd: 0.93 }));

    const state = await openRun(store);

    expect(state.runId).toBe("run-1");
    expect(state.spendUsd).toBe(0.93);
  });

  // Fail-closed (Discipline A): dispatching against an unknown budget baseline is
  // dispatching with no cap. The cycle must fail, not assume zero.
  test("a store failure propagates instead of defaulting to a fresh run", async () => {
    const store = new InMemoryRunStateStore(record({ spendUsd: 0.99 }));
    store.loadError = new Error("connection refused");

    await expect(openRun(store)).rejects.toThrow("connection refused");
  });
});

describe("persistRun", () => {
  test("spend is written through so a restart resumes from the latest total", async () => {
    const store = new InMemoryRunStateStore(null);
    const opened = await openRun(store);

    await persistRun(store, opened, { spendUsd: 0.41 });

    expect(store.state?.spendUsd).toBe(0.41);
    expect(store.state?.runId).toBe(opened.runId);
  });

  // Fail-soft with a warn: a transient DB blip must not stop a run, and the
  // in-process cap still binds for this process.
  test("a persist failure does not throw", async () => {
    const store = new InMemoryRunStateStore(null);
    const opened = await openRun(store);
    store.saveError = new Error("write failed");

    await expect(persistRun(store, opened, { spendUsd: 0.5 })).resolves.toBeDefined();
  });
});
