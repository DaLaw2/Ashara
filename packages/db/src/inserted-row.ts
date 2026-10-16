/** An INSERT ... RETURNING of one row returned none: nothing the caller meant to record is known to be recorded. */
class InsertReturnedNoRow extends Error {
  constructor(
    readonly table: string,
    readonly operation: string,
  ) {
    super(`${operation}: the INSERT into ${table} returned no row`);
    this.name = "InsertReturnedNoRow";
  }
}

/**
 * The row an INSERT ... RETURNING of one row returned. Drizzle types the destructured row as
 * present, so an empty result would otherwise be read as a row of `undefined` fields.
 */
export function insertedRow<T>(rows: readonly T[], table: string, operation: string): T {
  const [row] = rows;
  if (row === undefined) throw new InsertReturnedNoRow(table, operation);
  return row;
}
