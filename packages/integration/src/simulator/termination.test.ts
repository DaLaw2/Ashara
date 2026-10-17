import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_DATABASE_URL } from "@ashara/db";
import { dropStaleRunDatabases, prepareTemplate } from "./database.js";
import { runSeed } from "./run.js";
import type { RunOptions, RunResult } from "./run.js";
import type { Direction } from "./tape.js";

/**
 * The termination invariants (termination.ts) on directed tapes under the
 * liveness profile: each persona, forced by name, permanent from the first cycle, and the project
 * still ends through a typed, reported state with every invariant holding; then each W fails on a
 * plant that removes the bound it judges.
 */
const databaseUrl = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
let template = "";

beforeAll(async () => {
  await dropStaleRunDatabases(databaseUrl);
  template = await prepareTemplate(databaseUrl);
}, 120_000);

afterAll(async () => {
  await dropStaleRunDatabases(databaseUrl);
});

function live(directions: readonly Direction[], scenario: Partial<Pick<RunOptions, "mutation" | "maxCycles">> = {}): Promise<RunResult> {
  return runSeed({ seed: 1, profile: "liveness", tape: { kind: "directed", directions }, databaseUrl, template, timeoutMs: 90_000, maxCycles: 120, ...scenario });
}

const persona = (role: string, value: number): Direction => ({ kind: "draw", site: `persona.${role}`, nth: 1, value });
const REVIEWERS = ["never-satisfied", "rotating", "resurrecting", "flip-flop", "self-refuting", "correlated-second", "lazy-pass"] as const;

function keys(result: RunResult): string[] {
  return result.violations.map((v) => v.key).sort();
}

function statements(result: RunResult): string {
  return [...result.violations.map((v) => `${v.key}: ${v.statement}`), `outcome ${JSON.stringify(result.outcome)}`].join("\n");
}

describe("termination under permanent personas", () => {
  for (const [index, name] of REVIEWERS.entries()) {
    it(`ends a project whose reviewer is ${name}`, async () => {
      const result = await live([persona("suite-review", index + 1)]);
      expect(result.trace).toContain(`personas suite-review=${name} planner=honest classifier=honest check-author=honest intake=honest from cycle 1`);
      expect(keys(result), statements(result)).toEqual([]);
      expect(result.outcome.kind, statements(result)).not.toBe("open");
    }, 150_000);
  }

  it("ends a project whose planner oscillates, whose classifier flips, whose check author is sticky-bad and whose intake is lazy", async () => {
    const result = await live([persona("planner", 1), persona("classifier", 1), persona("check-author", 1), persona("intake", 1)]);
    expect(result.trace).toContain("personas suite-review=honest planner=oscillating classifier=flipping check-author=sticky-bad intake=lazy from cycle 1");
    expect(keys(result), statements(result)).toEqual([]);
    expect(result.outcome.kind, statements(result)).not.toBe("open");
  }, 150_000);
});

/*
 * Each W fails on a plant that removes the bound it judges. A never-satisfied reviewer rejects the
 * same correct check every round, and its re-sampled second review agrees, so the review loop runs
 * on the review's own bound: two namings per check task, then a give-up and a plan repair, twice,
 * then a typed halt with its report. An implementer that stalls every attempt spends its whole turn
 * cap each time, so its task runs on the work ledger's bound.
 */
describe("the termination invariants against plants", () => {
  const NEVER_SATISFIED = [persona("suite-review", 1)];
  const STALLS = [{ kind: "draw", site: "agent.timeout", scope: "implementation", nth: "every", value: 1 } as const];
  const TASK = 'Write the checks for "Deliver b1, b2 [sim t1]"';

  it("W1: names a task that drew past the per-task bound when the work ledger reads nothing drawn", async () => {
    const clean = await live(STALLS);
    expect(keys(clean), statements(clean)).toEqual([]);
    expect(clean.outcome, statements(clean)).toMatchObject({ kind: "halted", cause: "undeliverable" });
    const planted = await live(STALLS, { mutation: "ledger-draw-skipped" });
    expect(keys(planted), statements(planted)).toEqual(["W1:task:Deliver b1, b2 [sim t1]"]);
  }, 300_000);

  it("W2: names a review round that left no count when a review drops its earlier findings", async () => {
    const planted = await live(NEVER_SATISFIED, { mutation: "review-count-reset" });
    expect(keys(planted), statements(planted)).toEqual([`W2:review-uncounted:${TASK}`]);
  }, 300_000);

  it("W3: names a measure that left its well-founded order when the review's bound is read as one naming", async () => {
    const planted = await live(NEVER_SATISFIED, { mutation: "suite-review-bound-ignored" });
    expect(keys(planted), statements(planted)).toEqual([`W2:review-bound:${TASK}`, `W3:unfounded:review:${TASK}`]);
  }, 300_000);

  it("W4: names a project that never ends when the review loop has neither its bound nor the work ledger", async () => {
    const planted = await live(NEVER_SATISFIED, { mutation: "review-loop-unbounded", maxCycles: 40 });
    expect(planted.outcome.kind).toBe("open");
    expect(keys(planted), statements(planted)).toEqual(expect.arrayContaining(["W4:open", `W1:task:${TASK}`, `W3:unfounded:review:${TASK}`]));
  }, 300_000);
});
