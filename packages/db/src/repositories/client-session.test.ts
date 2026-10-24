import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { systemClock, type Clock } from "@ashara/shared";
import { createDb, type Database } from "../connection.js";
import { resolveTestDatabaseUrl } from "../test-database-url.js";
import { ClientRepository } from "./client.js";
import { ClientSessionRepository } from "./client-session.js";

// Against the shared dev database: every row here belongs to a client this suite creates under a
// unique name.

const DATABASE_URL = resolveTestDatabaseUrl(process.env);
const NONCE = randomUUID().slice(0, 8);
const TTL_SECONDS = 3600;
const GRACE_SECONDS = 600;

let db: Database;
let clientId: string;

function tokenHashOf(label: string): string {
  return createHash("sha256").update(`${label}-${NONCE}`, "utf8").digest("hex");
}

/** A clock the database's now() does not follow: ten days behind it, moved only by hand. */
function handClock(): { readonly clock: Clock; readonly t0: number; set(at: number): void } {
  const t0 = Date.now() - 10 * 24 * 3600 * 1000;
  let at = t0;
  return { clock: { now: () => at }, t0, set: (next) => (at = next) };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  clientId = (await new ClientRepository(db).create(`client-session-test-${NONCE}-client`)).id;
});

afterAll(async () => {
  await new ClientSessionRepository(db, systemClock).deleteByClient(clientId);
  await db.execute(sql`DELETE FROM clients WHERE name LIKE ${`client-session-test-${NONCE}-%`}`);
  await db.$client.end();
});

describe("ClientSessionRepository", () => {
  test("a session expires when the injected clock passes its ttl, not when the database's does", async () => {
    const { clock, t0, set } = handClock();
    const repo = new ClientSessionRepository(db, clock);
    const tokenHash = tokenHashOf("expiry");
    await repo.create(tokenHash, clientId, TTL_SECONDS);

    set(t0 + (TTL_SECONDS - 1) * 1000);
    expect(await repo.findActive(tokenHash)).toMatchObject({ tokenHash, clientId });
    set(t0 + (TTL_SECONDS + 1) * 1000);
    expect(await repo.findActive(tokenHash)).toBeNull();
  });

  test("a revoked session is purged only once the injected clock is past its revocation by the grace", async () => {
    const { clock, t0, set } = handClock();
    const repo = new ClientSessionRepository(db, clock);
    const tokenHash = tokenHashOf("purge");
    // Its expiry lies far beyond the grace, so only the revocation can make it ended.
    await repo.create(tokenHash, clientId, 30 * 24 * 3600);
    expect(await repo.revoke(tokenHash)).toBe(true);
    const present = async () => (await db.execute(sql`SELECT 1 FROM client_sessions WHERE token_hash = ${tokenHash}`)).rows.length;

    set(t0 + (GRACE_SECONDS - 1) * 1000);
    await repo.deleteEndedBefore(GRACE_SECONDS);
    expect(await present()).toBe(1);
    set(t0 + (GRACE_SECONDS + 1) * 1000);
    await repo.deleteEndedBefore(GRACE_SECONDS);
    expect(await present()).toBe(0);
  });
});
