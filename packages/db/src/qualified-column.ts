import { getTableName, sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * A column named with its table. Drizzle renders a bare column unqualified in a select list, where
 * inside a subquery it would name the subquery's own column of that name.
 */
export const qualifiedColumn = (column: AnyColumn): SQL => sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
