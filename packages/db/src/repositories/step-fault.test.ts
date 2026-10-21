import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { systemClock, type Clock, type ProjectId } from "@ashara/shared";
import { createDb, type Database } from "../connection.js";
import { projects } from "../schema/index.js";
import { resolveTestDatabaseUrl } from "../test-database-url.js";
import { ClientRepository } from "./client.js";
import { ProjectRepository } from "./project.js";
import { stepFaultLedger } from "./step-fault.js";

// Against the shared dev database: every row here belongs to a project this suite creates under a
// unique name; deleting the project deletes its step_faults rows.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);
const PAUSED_SUFFIX = "-paused";

// The ledger reads whatever at-work condition its caller states (Engagement's projectAtWork in
// production); this suite states one naming the projects it treats as not at work by their name.
const projectAtWork = sql`${projects.name} NOT LIKE ${`%${PAUSED_SUFFIX}`}`;

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
    const ledger = stepFaultLedger(db, systemClock, projectAtWork);

    expect(await ledger.record({ step: "liaison-intake", subjectId: subject, projectId, error: "first", retryAfterSeconds: 60 })).toBe(1);
    expect(await ledger.record({ step: "liaison-intake", subjectId: subject, projectId, error: "second", retryAfterSeconds: 120 })).toBe(2);
    await ledger.record({ step: "liaison-answers", subjectId: subject, projectId, error: "other step", retryAfterSeconds: -1 });

    // A fresh ledger, as after a restart, reads what the first one wrote.
    const restarted = stepFaultLedger(db, systemClock, projectAtWork);
    expect((await restarted.faultsOf("liaison-intake")).get(subject)).toEqual({ faults: 2, due: false });
    expect((await restarted.faultsOf("liaison-answers")).get(subject)).toEqual({ faults: 1, due: true });

    await restarted.clear("liaison-intake", subject);
    expect((await restarted.faultsOf("liaison-intake")).has(subject)).toBe(false);
    expect((await restarted.faultsOf("liaison-answers")).has(subject)).toBe(true);
  });

  test("a parked subject is not due while its project is not at work, and is due past its backoff once its project is at work", async () => {
    const ledger = stepFaultLedger(db, systemClock, projectAtWork);
    const clientId = (await new ClientRepository(db).create(`step-fault-test-${NONCE}-client-parked`)).id;
    const halted = (await new ProjectRepository(db).create(`step-fault-test-${NONCE}${PAUSED_SUFFIX}`, clientId)).id;
    const atWork = `parked-at-work-${NONCE}`;
    const ofHalted = `parked-halted-${NONCE}`;
    await ledger.record({ step: "block-report", subjectId: atWork, projectId, error: "e", retryAfterSeconds: -1 });
    await ledger.record({ step: "block-report", subjectId: ofHalted, projectId: halted, error: "e", retryAfterSeconds: -1 });
    await ledger.park("block-report", atWork);
    await ledger.park("block-report", ofHalted);

    const standing = await stepFaultLedger(db, systemClock, projectAtWork).faultsOf("block-report");
    expect(standing.get(ofHalted)).toEqual({ faults: 1, due: false });
    expect(standing.get(atWork)).toEqual({ faults: 1, due: true });
    await expect(ledger.park("block-report", `never-recorded-${NONCE}`)).rejects.toMatchObject({ name: "StepFaultNotOnRecord" });
  });

  test("a backoff passes on the clock the cycle runs on, not on the database's", async () => {
    // A clock the database's now() does not follow: two days behind it, moved only by hand, as a
    // cycle's clock moves by the wait between cycles.
    let at = Date.now() - 2 * 24 * 3600 * 1000;
    const clock: Clock = { now: () => at };
    const ledger = stepFaultLedger(db, clock, projectAtWork);
    const subject = `roster-${NONCE}`;
    await ledger.record({ step: "roster", subjectId: subject, projectId, error: "e", retryAfterSeconds: 60 });

    at += 59_000;
    expect((await ledger.faultsOf("roster")).get(subject)).toEqual({ faults: 1, due: false });
    at += 1_000;
    expect((await stepFaultLedger(db, clock, projectAtWork).faultsOf("roster")).get(subject)).toEqual({ faults: 1, due: true });
  });
});
