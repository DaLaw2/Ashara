import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DbHandle } from "./connection.js";

const AppliedRowSchema = z.object({ appliedAt: z.coerce.date() });

/** When the earliest of `filenames` was applied to this database; null when schema_migrations lists none of them. */
export async function firstAppliedAt(db: DbHandle, filenames: readonly [string, ...string[]]): Promise<Date | null> {
  const rows = await db.execute(
    sql`SELECT applied_at AS "appliedAt" FROM schema_migrations
         WHERE filename IN (${sql.join(filenames.map((filename) => sql`${filename}`), sql`, `)}) ORDER BY applied_at LIMIT 1`,
  );
  const [row] = rows.rows;
  return row === undefined ? null : AppliedRowSchema.parse(row).appliedAt;
}
