/**
 * Finds a write to another context's table, and a read of one in raw SQL or through drizzle's builder. Every insert, update or
 * delete a context's source issues lands on a table that context owns; anything it does to another
 * context's table goes through that owner's exported write entry or typed read. Run by
 * check-boundaries.ts inside `just check`; the owner of every table and the reads the context map
 * allows live in the [tables] section of boundary-rules.toml.
 *
 * The owner map is held to the schema: every table a packages/db/src/schema/<module>.ts declares
 * (`pgTable("<name>", ...)`) has exactly one entry, owned by <module> when <module> is a package, by
 * "db" (generic persistence) or "shared" otherwise, or by "shared" whatever its module; an entry
 * naming no declared table is itself a finding.
 *
 * What is read: every non-test .ts file under packages/<pkg>/src, packages/db and
 * packages/integration aside, parsed with the TypeScript compiler.
 * - A write: a call `.insert(T)`, `.update(T)` or `.delete(T)` whose argument is the identifier of a
 *   table the schema exports, and an `insert into`, `update ... set` or `delete from` inside a
 *   `sql`-tagged template or a `sql.raw` string. A table owned by another package fails; "shared"
 *   admits every writer. No exemption admits a write.
 * - A raw read: a table named after `from` or `join` inside a `sql`-tagged template or a `sql.raw`
 *   string (a `for update` lock included), a substitution that is a table's identifier read as its
 *   name.
 * - A builder read: a call `.from(T)`, `.innerJoin(T, ...)`, `.leftJoin`, `.rightJoin`, `.fullJoin`,
 *   `.crossJoin` or `.join`, or `alias(T, ...)`, whose first argument is the identifier of a table the
 *   schema exports.
 * A read of a table owned by another package or by "db" fails unless an allowed edge names the file
 * and the table; an edge no read uses is itself a finding. There is no exemption: a key other than an
 * owner or an edge is a parse error.
 *
 * Blind spots, each a finding this check passes:
 * - A column `T.c` of another context's table named in a select or a predicate without a from or join
 *   of `T` in the same file, and its jsonb parsed in place.
 * - A read through a variable holding the table under another name.
 * - A write through an alias or a variable holding the table, a write built from pieces, and SQL
 *   held in a plain string or template that is not `sql`-tagged.
 * - A write the database makes for the context (a trigger, a cascade).
 */

import ts from "typescript";

class TableOwnershipRulesError extends Error {
  constructor(
    readonly rulesPath: string,
    readonly lineNumber: number,
    readonly lineText: string,
    readonly reason: string,
  ) {
    super(`${rulesPath}:${lineNumber}: [${TABLES_SECTION}] ${reason} — ${JSON.stringify(lineText)}`);
    this.name = "TableOwnershipRulesError";
  }
}

export const TABLES_SECTION = "tables";

/** The owner that admits every context: a table every context keys its rows by, or generic persistence every context appends to. */
export const SHARED_OWNER = "shared";

/** The owner of generic persistence a context reaches only through db's repositories. */
export const DB_OWNER = "db";

interface AllowedReadEdge {
  readonly id: string;
  /** Repository-relative path of the one file the edge covers. */
  readonly file: string;
  readonly tables: readonly string[];
  readonly reason: string;
}

export interface TableOwnershipRules {
  /** table -> owning package, "db" or "shared". */
  readonly owners: ReadonlyMap<string, string>;
  /** table -> the line of its entry, for findings about the map. */
  readonly lines: ReadonlyMap<string, number>;
  readonly edges: readonly AllowedReadEdge[];
}

const SECTION_RE = /^\[([^\]]+)\]$/;
const OWNER_RE = /^([a-z][a-z0-9_]*)\s*=\s*"([a-z][a-z0-9-]*)"$/;
const EDGE_RE =
  /^edge\.([a-z0-9][a-z0-9-]*)\s*=\s*\{\s*file\s*=\s*"([^"]+)"\s*,\s*tables\s*=\s*\[([^\]]*)\]\s*,\s*reason\s*=\s*"([^"]+)"\s*\}$/;
const QUOTED_RE = /^"([^"]+)"$/;

/** Reads the [tables] section; a missing or empty section, a table stated twice or an unknown key fails closed. */
export function parseTableOwnershipRules(toml: string, rulesPath: string): TableOwnershipRules {
  const owners = new Map<string, string>();
  const lines = new Map<string, number>();
  const edges: AllowedReadEdge[] = [];
  let inSection = false;
  let sawSection = false;
  const all = toml.split("\n");
  for (let i = 0; i < all.length; i++) {
    const line = all[i].trim();
    const lineNumber = i + 1;
    const section = SECTION_RE.exec(line);
    if (section !== null) {
      inSection = section[1] === TABLES_SECTION;
      sawSection ||= inSection;
      continue;
    }
    if (!inSection || line === "" || line.startsWith("#")) continue;

    const owner = OWNER_RE.exec(line);
    if (owner !== null) {
      if (owners.has(owner[1])) throw new TableOwnershipRulesError(rulesPath, lineNumber, line, `table "${owner[1]}" is stated twice`);
      owners.set(owner[1], owner[2]);
      lines.set(owner[1], lineNumber);
      continue;
    }

    const edge = EDGE_RE.exec(line);
    if (edge !== null) {
      const [, id, file, tableList, reason] = edge;
      if (edges.some((e) => e.id === id)) throw new TableOwnershipRulesError(rulesPath, lineNumber, line, `edge "${id}" is stated twice`);
      const tables = tableList
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "")
        .map((item) => {
          const quoted = QUOTED_RE.exec(item);
          if (quoted === null) throw new TableOwnershipRulesError(rulesPath, lineNumber, line, `${item} is not a double-quoted string`);
          return quoted[1];
        });
      if (tables.length === 0) throw new TableOwnershipRulesError(rulesPath, lineNumber, line, "edge names no table");
      edges.push({ id, file, tables, reason });
      continue;
    }

    throw new TableOwnershipRulesError(rulesPath, lineNumber, line, 'unrecognised key (expected <table> = "<owner>" or edge.<id>; a read the context map does not allow has no exemption)');
  }
  if (!sawSection) throw new TableOwnershipRulesError(rulesPath, 0, `[${TABLES_SECTION}]`, "section is missing");
  if (owners.size === 0) throw new TableOwnershipRulesError(rulesPath, 0, `[${TABLES_SECTION}]`, "states no table; an owner map of nothing would pass every write");
  for (const edge of edges) {
    for (const table of edge.tables) {
      if (!owners.has(table)) throw new TableOwnershipRulesError(rulesPath, 0, `edge.${edge.id}`, `allows "${table}", which the owner map does not list`);
    }
  }
  return { owners, lines, edges };
}

/** One table a schema module declares: its SQL name and the identifier the module exports it as. */
export interface DeclaredTable {
  readonly name: string;
  readonly identifier: string;
  readonly line: number;
}

/** Every `export const <identifier> = pgTable("<name>", ...)` of a schema module. */
export function declaredTables(source: string, fileName: string): DeclaredTable[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tables: DeclaredTable[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || init === undefined || !ts.isCallExpression(init)) continue;
      if (!ts.isIdentifier(init.expression) || init.expression.text !== "pgTable") continue;
      const [first] = init.arguments;
      if (first === undefined || !ts.isStringLiteral(first)) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
      tables.push({ name: first.text, identifier: declaration.name.text, line });
    }
  }
  return tables;
}

/** What a context's source does to a table: writes it, or reads it in raw SQL or through the builder. */
export interface TableUse {
  readonly line: number;
  readonly table: string;
  readonly kind: "write" | "raw-read" | "builder-read";
  /** The call or the SQL as written, cut to a readable length. */
  readonly text: string;
}

const RAW_WRITE_RES = [/\binsert\s+into\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi, /\bupdate\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?(?:\s+[a-z_][a-z0-9_]*)?\s+set\b/gi, /\bdelete\s+from\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi];
// A `delete from` is the write's own table, reported as the write.
const RAW_READ_RE = /(?<!\bdelete\s+)\b(?:from|join)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const WRITE_METHODS = new Set(["insert", "update", "delete"]);
const READ_METHODS = new Set(["from", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "crossJoin", "join"]);

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 100 ? `${flat.slice(0, 97)}...` : flat;
}

/** The SQL text of a `sql`-tagged template or a `sql.raw` string, a table identifier substituted by its name; null for any other node. */
function sqlText(node: ts.Node, tables: ReadonlyMap<string, string>): string | null {
  if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "sql") {
    const template = node.template;
    if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
    const parts = [template.head.text];
    for (const span of template.templateSpans) {
      const name = ts.isIdentifier(span.expression) ? tables.get(span.expression.text) : undefined;
      parts.push(name === undefined ? " ? " : name, span.literal.text);
    }
    return parts.join("");
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "sql" &&
    node.expression.name.text === "raw"
  ) {
    const [first] = node.arguments;
    if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
  }
  return null;
}

/**
 * Every write, raw read and builder read of a table in `source`; `tables` maps each table identifier the schema
 * exports to its SQL name. Only tables the map names are reported.
 */
export function findTableUses(source: string, fileName: string, tables: ReadonlyMap<string, string>): TableUse[] {
  const known = new Set(tables.values());
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const uses: TableUse[] = [];
  const visit = (node: ts.Node): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITE_METHODS.has(node.expression.name.text)) {
      const [first] = node.arguments;
      const table = first !== undefined && ts.isIdentifier(first) ? tables.get(first.text) : undefined;
      if (table !== undefined && node.arguments.length === 1) uses.push({ line, table, kind: "write", text: cut(node.getText(sourceFile)) });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const reads =
        (ts.isPropertyAccessExpression(callee) && READ_METHODS.has(callee.name.text)) || (ts.isIdentifier(callee) && callee.text === "alias");
      const [first] = node.arguments;
      const table = reads && first !== undefined && ts.isIdentifier(first) ? tables.get(first.text) : undefined;
      if (table !== undefined) uses.push({ line, table, kind: "builder-read", text: cut(node.getText(sourceFile)) });
    }
    const text = sqlText(node, tables);
    if (text !== null) {
      const written = cut(text);
      for (const re of RAW_WRITE_RES) {
        for (const match of text.matchAll(re)) if (known.has(match[1].toLowerCase())) uses.push({ line, table: match[1].toLowerCase(), kind: "write", text: written });
      }
      for (const match of text.matchAll(RAW_READ_RE)) if (known.has(match[1].toLowerCase())) uses.push({ line, table: match[1].toLowerCase(), kind: "raw-read", text: written });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return uses;
}
