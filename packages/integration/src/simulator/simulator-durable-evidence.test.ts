import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Database } from "./database.js";
import { directed, draw, keys, liveness, persona, statementsAndOutcome, useSimulatorDatabase } from "./simulator-harness.js";

/*
 * Production publishes a work item's domain events after its transition commits and goes on when
 * the publish fails, so a verdict judged on them reads a lost event as a start or a reopen that
 * never happened. Each run here loses every domain event its production writes, and the verdict
 * that judges starts (I2's dispatched-held clause) or reopens (W2) still names its plant: it reads
 * the transition rows written with the change itself.
 */
useSimulatorDatabase();

const SIMULATOR_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Every insert into the event log is dropped for the whole run: it holds no row a verdict could read. */
async function loseEveryEvent(db: Database): Promise<void> {
  await db.execute(sql`CREATE RULE every_event_lost AS ON INSERT TO domain_events DO INSTEAD NOTHING`);
  await db.execute(sql`INSERT INTO domain_events (event_id, event_type, timestamp, source_context) VALUES (gen_random_uuid(), 'probe', now(), 'test')`);
  const [kept] = z.array(z.object({ n: z.number().int() })).parse((await db.execute(sql`SELECT count(*)::int AS n FROM domain_events`)).rows);
  expect(kept?.n).toBe(0);
}

describe("the simulator's verdicts with every domain event lost", () => {
  // simulator-plants-correction.test.ts's tape: the correction awaits its revision across a cycle
  // and the task it holds comes back to Pending meanwhile; the plant dispatches it.
  const RETURNED = [
    draw("universe.extra-behaviours", 1, 1),
    draw("universe.extra-tasks", 1, 2),
    draw("client.correction", 1),
    draw("correction.held-returns", 1),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((nth) => draw("model.replan.environment.invalid", nth)),
  ];
  it("I2 names a held task dispatched before its revision", async (ctx) => {
    const run = await directed(ctx, RETURNED, { mutation: "correction-hold-misses-returned", alterDatabase: loseEveryEvent });
    const planted = keys(run);
    expect(planted.some((key) => key.startsWith("I2:dispatched-held:")), `${planted.join(", ")}\n${run.trace.join("\n")}`).toBe(true);
  }, 120_000);

  // termination-plants.test.ts's W2 plant: a review that drops its earlier findings reopens its check
  // task more often than suite_review_findings counts.
  it("W2 names a review round that left no count", async (ctx) => {
    const run = await liveness(ctx, [persona("suite-review", 1)], { mutation: "review-count-reset", alterDatabase: loseEveryEvent });
    expect(keys(run), statementsAndOutcome(run)).toEqual(['W2:review-uncounted:Write the checks for "Deliver b1, b2 [sim t1]"']);
  }, 300_000);

  it("no simulator source reads the event log", () => {
    const readers = readdirSync(SIMULATOR_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => readFileSync(join(SIMULATOR_DIR, name), "utf8").includes("domain_events"));
    expect(readers).toEqual([]);
  });
});
