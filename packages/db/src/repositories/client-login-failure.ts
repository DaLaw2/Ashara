import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "../connection.js";
import { clientLoginFailures } from "../schema/index.js";

/**
 * Each cap admits this many attempts within the window; the next one is refused.
 * Every cap is scoped to one source, so attempts from one source never close login
 * for another: a cap counted across sources (per name, or over the whole table)
 * would let anyone with enough sources lock a client, or every client, out.
 */
export interface LoginAttemptCaps {
  readonly windowSeconds: number;
  /** One client name from one source. */
  readonly perNameAndSource: number;
  /** One source, across every name it presents. */
  readonly perSource: number;
}

type LoginAttemptScope = "name-and-source" | "source";

type LoginAttemptReservation =
  | { readonly kind: "reserved"; readonly nameAndSourceCount: number }
  | { readonly kind: "throttled"; readonly scope: LoginAttemptScope; readonly count: number; readonly limit: number };

const CountsSchema = z.object({
  name_and_source: z.number().int().nonnegative(),
  source: z.number().int().nonnegative(),
});

/**
 * Web-client login attempts, keyed by the client name
 * as presented and the source the attempt came from (column `source_address`;
 * the caller decides what one source is). A row is a failed attempt or one still
 * being evaluated; a success deletes its pair's rows. Every window is judged
 * against the database clock, so the throttle survives a restart.
 */
export class ClientLoginFailureRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Counts the window and, when every cap still has room, inserts this attempt,
   * under a transaction-scoped advisory lock per source: every cap counts one
   * source, so serialising that source's reservations is enough for a burst never
   * to get more attempts evaluated than a cap admits, and a flood from other
   * sources does not queue this one. A refused attempt writes nothing, so hammering a closed throttle
   * does not extend it. Rows past the window are dropped on the way, for every
   * name: they no longer count, and made-up names would otherwise accumulate.
   */
  async reserve(clientName: string, source: string, caps: LoginAttemptCaps): Promise<LoginAttemptReservation> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'ashara.client_login_throttle/' + source}))`);
      const windowStart = sql`now() - make_interval(secs => ${caps.windowSeconds})`;
      await tx.delete(clientLoginFailures).where(sql`${clientLoginFailures.failedAt} < ${windowStart}`);
      const result = await tx.execute(sql`
        SELECT
          (count(*) FILTER (WHERE client_name = ${clientName}))::int AS name_and_source,
          count(*)::int AS source
        FROM client_login_failures
        WHERE source_address = ${source} AND failed_at >= ${windowStart}`);
      const counts = CountsSchema.parse(result.rows[0]);
      const checks: readonly [LoginAttemptScope, number, number][] = [
        ["name-and-source", counts.name_and_source, caps.perNameAndSource],
        ["source", counts.source, caps.perSource],
      ];
      for (const [scope, count, limit] of checks) {
        if (count >= limit) return { kind: "throttled", scope, count, limit };
      }
      await tx.insert(clientLoginFailures).values({ clientName, sourceAddress: source });
      return { kind: "reserved", nameAndSourceCount: counts.name_and_source + 1 };
    });
  }

  /** A success clears its own pair only: the same source's failures under other names stay counted. */
  async clearNameAndSource(clientName: string, source: string): Promise<void> {
    await this.db
      .delete(clientLoginFailures)
      .where(and(eq(clientLoginFailures.clientName, clientName), eq(clientLoginFailures.sourceAddress, source)));
  }
}
