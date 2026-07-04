import { sql } from "drizzle-orm";

import type { Database } from "../connection.js";
import { brainstormLog } from "../schema.js";

export class BrainstormLogRepository {
  constructor(private readonly db: Database) {}

  async insert(
    id: string,
    reason: string,
    level: string,
    itemsCreated: number,
    itemsProposed: number,
  ) {
    await this.db.insert(brainstormLog).values({
      id,
      triggerReason: reason,
      triggerLevel: level,
      itemsCreated,
      itemsProposed,
    });
  }

  async countTasksSinceLast(): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`COUNT(*)::int`,
      })
      .from(sql`work_items`)
      .where(
        sql`level = 'Task' AND status = 'Completed' AND updated_at > COALESCE((SELECT MAX(created_at) FROM brainstorm_log), '1970-01-01'::timestamptz)`,
      );
    return row?.count ?? 0;
  }
}
