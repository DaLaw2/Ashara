import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { systemClock, type Clock } from "@ashara/shared";
import { createDb, type Database } from "../connection.js";
import { resolveTestDatabaseUrl } from "../test-database-url.js";
import { ClientLoginFailureRepository } from "./client-login-failure.js";

// Against the shared dev database: every row here is under a client name and source unique to
// this run, and the suite clears them.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);
const CLIENT_NAME = `client-login-failure-test-${NONCE}`;
const SOURCE = `source-${NONCE}`;
const CAPS = { windowSeconds: 900, perNameAndSource: 1, perSource: 10 };

let db: Database;

beforeAll(() => {
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await new ClientLoginFailureRepository(db, systemClock).clearNameAndSource(CLIENT_NAME, SOURCE);
  await db.$client.end();
});

describe("ClientLoginFailureRepository", () => {
  test("an attempt counts while the injected clock is inside its window and stops counting once the clock passes it", async () => {
    // A clock the database's now() does not follow: ten days behind it, moved only by hand.
    const t0 = Date.now() - 10 * 24 * 3600 * 1000;
    let at = t0;
    const clock: Clock = { now: () => at };
    const repo = new ClientLoginFailureRepository(db, clock);

    expect(await repo.reserve(CLIENT_NAME, SOURCE, CAPS)).toEqual({ kind: "reserved", nameAndSourceCount: 1 });
    at = t0 + (CAPS.windowSeconds - 1) * 1000;
    expect(await repo.reserve(CLIENT_NAME, SOURCE, CAPS)).toEqual({ kind: "throttled", scope: "name-and-source", count: 1, limit: 1 });
    at = t0 + (CAPS.windowSeconds + 1) * 1000;
    expect(await repo.reserve(CLIENT_NAME, SOURCE, CAPS)).toEqual({ kind: "reserved", nameAndSourceCount: 1 });
  });
});
