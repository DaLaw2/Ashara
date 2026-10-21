import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ClientRepository, PROJECT_BLOCK_KINDS, ProjectRepository, createDb, projects, resolveTestDatabaseUrl, type Database } from "@ashara/db";
import { projectHaltedOnModelWork } from "@ashara/delivery/predicates";
import { ClientReceipts } from "@ashara/engagement";
import type { ClientReceiptStore } from "@ashara/engagement";
import { memoryStepContainment, type ProjectId } from "@ashara/shared";
import { UNREAD_HALT_KINDS } from "../simulator/invariants.js";

// The halts under which nothing reads the client's messages, the halts on the project's model work,
// are spelled three times: Delivery's projectHaltedOnModelWork (what Engagement's reading admits by),
// the receipt's reason for the wait (client-receipt.ts), and the simulator oracle's own copy, which
// stays independent of the product it judges. Every kind a halt can record is enumerated, so a kind
// added to one spelling and not the others fails here instead of falling through to a default.
// Every row belongs to a project this suite creates under a unique name.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projectId: ProjectId;

class RolledBack extends Error {
  constructor(readonly verdict: boolean) {
    super("rolled back: the halt was opened only to read the predicate under it");
    this.name = "RolledBack";
  }
}

/** Whether Delivery's predicate holds while the project's open halt is of `kind`: the halt is opened and rolled back in one transaction. */
async function deliveryHoldsModelWork(kind: string): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${projectId}, ${kind}, 'ScriptedHalt', 'opened by the test')`);
      const [row] = await tx.select({ held: projectHaltedOnModelWork(projects.id).mapWith(Boolean) }).from(projects).where(sql`${projects.id} = ${projectId}`);
      throw new RolledBack(z.object({ held: z.boolean() }).parse(row).held);
    });
  } catch (err) {
    if (err instanceof RolledBack) return err.verdict;
    throw err;
  }
  throw new Error("the transaction committed a halt opened only to be rolled back");
}

/** Whether the receipt of a change to a project paused by `kind`, under which its input is not read, names model work as the reason it waits. */
async function receiptHoldsModelWork(kind: string): Promise<boolean> {
  const bodies: string[] = [];
  const store: ClientReceiptStore = {
    dueReceipts: async () => [
      { messageId: "change-1", projectId, kind: "change", consumed: false, stoppedProject: false, standing: { kind: "paused", halt: kind, readsInput: false } },
    ],
    postReceipt: async ({ body }) => {
      bodies.push(body);
      return "posted";
    },
  };
  await new ClientReceipts(store, memoryStepContainment(() => true)).runPending({ kind: "running" });
  const [body] = bodies;
  if (body === undefined) throw new Error(`no receipt posted under a ${kind} halt`);
  return body.includes("Reading it takes model work");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const clientId = (await new ClientRepository(db).create(`model-work-halt-kinds-test-${NONCE}-client`)).id;
  projectId = (await new ProjectRepository(db).create(`model-work-halt-kinds-test-${NONCE}-project`, clientId)).id;
});

afterAll(async () => {
  const pattern = `model-work-halt-kinds-test-${NONCE}-%`;
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("the halts on a project's model work, spelled three times, agree on every kind a halt can record", () => {
  test("the kinds enumerated are the ones the database admits", async () => {
    const result = await db.execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'project_blocks_kind_check'`);
    const [check] = z.array(z.object({ def: z.string() })).length(1).parse(result.rows);
    const admitted = [...(check?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
    expect([...admitted].sort()).toEqual([...PROJECT_BLOCK_KINDS].sort());
  });

  test("the model-work set holds the plan revision's model failures", () => {
    expect(UNREAD_HALT_KINDS).toEqual(expect.arrayContaining(["replan_stopped", "replan_provider_failed"]));
  });

  test.each(PROJECT_BLOCK_KINDS)("%s: Delivery's predicate, the receipt and the simulator oracle agree", async (kind) => {
    const simulator = UNREAD_HALT_KINDS.some((unread) => unread === kind);
    expect({ kind, delivery: await deliveryHoldsModelWork(kind), receipt: await receiptHoldsModelWork(kind) }).toEqual({ kind, delivery: simulator, receipt: simulator });
  });
});
