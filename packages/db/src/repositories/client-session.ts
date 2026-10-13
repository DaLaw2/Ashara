import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { clientSessions } from "../schema.js";

type ClientSessionRow = typeof clientSessions.$inferSelect;

/**
 * The web client's browser sessions (migration 017). Keyed by the SHA-256 of the
 * cookie token. Expiry is judged against the database clock, so the expiry a
 * session was created with and the expiry it is checked against share one clock.
 */
export class ClientSessionRepository {
  constructor(private readonly db: DbHandle) {}

  async create(tokenHash: string, ttlSeconds: number): Promise<ClientSessionRow> {
    const [row] = await this.db
      .insert(clientSessions)
      .values({
        tokenHash,
        expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
      })
      .returning();
    return row;
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
          gt(clientSessions.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Revokes an unrevoked session; returns whether one was revoked. */
  async revoke(tokenHash: string): Promise<boolean> {
    const rows = await this.db
      .update(clientSessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(clientSessions.tokenHash, tokenHash), isNull(clientSessions.revokedAt)))
      .returning({ id: clientSessions.id });
    return rows.length > 0;
  }
}
