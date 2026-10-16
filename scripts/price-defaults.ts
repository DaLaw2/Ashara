/**
 * Finds a column default on a price or cost column of the Drizzle schema. Such a default is an
 * evidence default: an insert that forgets the rate writes a model the spend cap reads as free
 * (db review #1, migration 054). Run by check-boundaries.ts inside `just check`.
 *
 * A column is one `key: builder("sql_name")` entry plus its `.chain()` continuation lines; it is a
 * price column when its key or SQL name mentions cost or price, and any `.default(` on it is reported.
 *
 * Blind spots: a price column named without "cost" or "price" (`rate`, `usd`, `amount`); a column
 * whose builder call spans lines, or whose chain continues past a comment or blank line; a default
 * given another way (`.$defaultFn(`, `.$onUpdate(`, `sql` in a builder helper); a DEFAULT written in
 * a migration's SQL, which this scan of the Drizzle schema never reads; SQL COALESCE or a `??`
 * fallback in the code that reads a rate; and schema outside packages/db/src/schema.
 */

interface PriceColumnDefault {
  readonly line: number;
  readonly column: string;
  readonly text: string;
}

const COLUMN_START_RE = /^\s+(\w+):\s*\w+\(\s*"([a-z0-9_]+)"/;
const CONTINUATION_RE = /^\s+\./;
const PRICE_NAME_RE = /cost|price/i;

export function findPriceColumnDefaults(schemaSource: string): PriceColumnDefault[] {
  const lines = schemaSource.split("\n");
  const found: PriceColumnDefault[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = COLUMN_START_RE.exec(lines[i]);
    if (start === null) continue;
    const [, key, sqlName] = start;
    let end = i + 1;
    while (end < lines.length && CONTINUATION_RE.test(lines[end])) end++;
    const text = lines.slice(i, end).map((l) => l.trim()).join(" ");
    if ((PRICE_NAME_RE.test(key) || PRICE_NAME_RE.test(sqlName)) && text.includes(".default(")) {
      found.push({ line: i + 1, column: sqlName, text });
    }
    i = end - 1;
  }
  return found;
}
