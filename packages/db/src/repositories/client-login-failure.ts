import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { clientLoginFailures } from "../schema.js";

/**
 * Failed web-client logins (migration 018), keyed by the client name as
 * presented. The throttle counts these rows, so it survives a restart. Every
 * window is judged against the database clock.
 */
export class ClientLoginFailureRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Records one failure and drops every row older than the window, for every
   * name: rows past the window no longer count toward any throttle, and
   * failures under made-up names would otherwise accumulate without bound.
   */
  async record(clientName: string, windowSeconds: number): Promise<void> {
    await this.db.insert(clientLoginFailures).values({ clientName });
    await this.db
      .delete(clientLoginFailures)
      .where(lt(clientLoginFailures.failedAt, sql`now() - make_interval(secs => ${windowSeconds})`));
  }

  async countWithin(clientName: string, windowSeconds: number): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(clientLoginFailures)
      .where(
        and(
          eq(clientLoginFailures.clientName, clientName),
          gte(clientLoginFailures.failedAt, sql`now() - make_interval(secs => ${windowSeconds})`),
        ),
      );
    return row.n;
  }

  async purge(clientName: string): Promise<void> {
    await this.db.delete(clientLoginFailures).where(eq(clientLoginFailures.clientName, clientName));
  }
}
