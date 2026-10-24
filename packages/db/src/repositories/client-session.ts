import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Clock } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { insertedRow } from "../inserted-row.js";
import { clientSessions } from "../schema/index.js";

type ClientSessionRow = typeof clientSessions.$inferSelect;

/**
 * The web client's browser sessions, each acting for one client. Keyed by the
 * SHA-256 of the cookie token. Expiry, revocation and the purge cutoff are all
 * set and judged on `clock`, the time the process runs on, so the expiry a session
 * was created with and the instant it is checked against share one clock, and a
 * clock the composition root drives moves them together.
 */
export class ClientSessionRepository {
  constructor(
    private readonly db: DbHandle,
    private readonly clock: Clock,
  ) {}

  async create(tokenHash: string, clientId: string, ttlSeconds: number): Promise<ClientSessionRow> {
    // Creation is on the same clock as expiry: the table holds every expiry after its creation.
    const now = this.clock.now();
    const rows = await this.db
      .insert(clientSessions)
      .values({
        tokenHash,
        clientId,
        createdAt: new Date(now),
        expiresAt: new Date(now + ttlSeconds * 1000),
      })
      .returning();
    return insertedRow(rows, "client_sessions", `create a session for client ${clientId}`);
  }

  /** The session for this hash when it is neither expired nor revoked, else null. */
  async findActive(tokenHash: string): Promise<ClientSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(clientSessions)
      .where(
        and(
          eq(clientSessions.tokenHash, tokenHash),
          isNull(clientSessions.revokedAt),
          gt(clientSessions.expiresAt, new Date(this.clock.now())),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Revokes an unrevoked session; returns whether one was revoked. */
  async revoke(tokenHash: string): Promise<boolean> {
    const rows = await this.db
      .update(clientSessions)
      .set({ revokedAt: new Date(this.clock.now()) })
      .where(and(eq(clientSessions.tokenHash, tokenHash), isNull(clientSessions.revokedAt)))
      .returning({ id: clientSessions.id });
    return rows.length > 0;
  }

  /**
   * Deletes every session of one client, active or ended; returns how many rows
   * went. `scripts/client.ts set-code` and `remove-code` call this in the same
   * transaction as the code change, so no session opened with the old code outlives it.
   */
  async deleteByClient(clientId: string): Promise<number> {
    const rows = await this.db
      .delete(clientSessions)
      .where(eq(clientSessions.clientId, clientId))
      .returning({ id: clientSessions.id });
    return rows.length;
  }

  /**
   * Deletes sessions that expired or were revoked more than `graceSeconds` ago.
   * Returns how many rows went.
   */
  async deleteEndedBefore(graceSeconds: number): Promise<number> {
    const cutoff = new Date(this.clock.now() - graceSeconds * 1000);
    const rows = await this.db
      .delete(clientSessions)
      .where(or(lt(clientSessions.expiresAt, cutoff), lt(clientSessions.revokedAt, cutoff)))
      .returning({ id: clientSessions.id });
    return rows.length;
  }
}
