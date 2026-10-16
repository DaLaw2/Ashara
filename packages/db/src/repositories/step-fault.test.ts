import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import type { ProjectId } from "@ashara/shared";
import { createDb, DEFAULT_DATABASE_URL, type Database } from "../connection.js";
import { ClientRepository } from "./client.js";
import { ProjectRepository } from "./project.js";
import { stepFaultLedger } from "./step-fault.js";

// Against the shared dev database: every row here belongs to a project this suite creates under a
// unique name; deleting the project deletes its step_faults rows.

const DATABASE_URL = process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
const NONCE = randomUUID().slice(0, 8);

let db: Database;
let projectId: ProjectId;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  const clientId = (await new ClientRepository(db).create(`step-fault-test-${NONCE}-client`)).id;
  projectId = (await new ProjectRepository(db).create(`step-fault-test-${NONCE}-project`, clientId)).id;
});

afterAll(async () => {
  const pattern = `step-fault-test-${NONCE}-%`;
  await db.execute(sql`DELETE FROM projects WHERE name LIKE ${pattern}`);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${pattern}`);
  await db.$client.end();
});

describe("stepFaultLedger", () => {
  test("faults count up per subject and step, a backoff outlives the ledger that set it, and clear removes only its subject", async () => {
    const subject = `tender-${NONCE}`;
    const ledger = stepFaultLedger(db);

    expect(await ledger.record({ step: "liaison-intake", subjectId: subject, projectId, error: "first", retryAfterSeconds: 60 })).toBe(1);
    expect(await ledger.record({ step: "liaison-intake", subjectId: subject, projectId, error: "second", retryAfterSeconds: 120 })).toBe(2);
    await ledger.record({ step: "liaison-answers", subjectId: subject, projectId, error: "other step", retryAfterSeconds: -1 });

    // A fresh ledger, as after a restart, reads what the first one wrote.
    const restarted = stepFaultLedger(db);
    expect((await restarted.faultsOf("liaison-intake")).get(subject)).toEqual({ faults: 2, due: false });
    expect((await restarted.faultsOf("liaison-answers")).get(subject)).toEqual({ faults: 1, due: true });

    await restarted.clear("liaison-intake", subject);
    expect((await restarted.faultsOf("liaison-intake")).has(subject)).toBe(false);
    expect((await restarted.faultsOf("liaison-answers")).has(subject)).toBe(true);
  });

  test("a parked subject is not due while its project is halted, and is due past its backoff once its project is at work", async () => {
    const ledger = stepFaultLedger(db);
    const clientId = (await new ClientRepository(db).create(`step-fault-test-${NONCE}-client-parked`)).id;
    const halted = (await new ProjectRepository(db).create(`step-fault-test-${NONCE}-halted`, clientId)).id;
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE projects SET blocked_category = 'fault', blocked_error_class = 'Scripted', blocked_reason = 'scripted halt' WHERE id = ${halted}`);
      await tx.execute(sql`INSERT INTO project_blocks (project_id, kind, error_class, reason) VALUES (${halted}, 'fault', 'Scripted', 'scripted halt')`);
    });
    const atWork = `parked-at-work-${NONCE}`;
    const ofHalted = `parked-halted-${NONCE}`;
    await ledger.record({ step: "block-report", subjectId: atWork, projectId, error: "e", retryAfterSeconds: -1 });
    await ledger.record({ step: "block-report", subjectId: ofHalted, projectId: halted, error: "e", retryAfterSeconds: -1 });
    await ledger.park("block-report", atWork);
    await ledger.park("block-report", ofHalted);

    const standing = await stepFaultLedger(db).faultsOf("block-report");
    expect(standing.get(ofHalted)).toEqual({ faults: 1, due: false });
    expect(standing.get(atWork)).toEqual({ faults: 1, due: true });
    await expect(ledger.park("block-report", `never-recorded-${NONCE}`)).rejects.toMatchObject({ name: "StepFaultNotOnRecord" });
  });
});
