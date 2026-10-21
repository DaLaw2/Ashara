import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CLIENT_MESSAGE_WRITERS, TEXT_COVERED, TEXT_EXCLUDED } from "./text-facts.js";

/**
 * Every composer of a brief, a prompt or a client report is on I9's covered
 * list (judged by I9 or by I4) or on its excluded list with a reason, and every writer of
 * client_messages rows is on the writers list with the composers whose text it posts. Both are
 * found by parsing the production source, never by a list typed here, so a composer or writer added
 * outside the lists fails this test until it is placed.
 *
 * A composer is a function, method or function-valued const named for what it writes or who reads
 * it (`…Brief`, `…Prompt`, `…Report`, `…Body`, `…Section`, `…Notice`, `…Reply`, `…ForBrief`,
 * `…ForCheckAuthor`), or a const text named so (`…_REPLY`, `…_REPORT`, …). A writer is the named
 * function or method around an `insert(clientMessages)` call. packages/integration is the harness:
 * it composes no text a production agent or client reads.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HARNESS = "integration";
const COMPOSER_NAME = /(Brief|Prompt|Report|Body|Section|Notice|Reply)$|For(Brief|CheckAuthor)$/;
const TEXT_CONSTANT_NAME = /_(BRIEF|PROMPT|REPORT|NOTICE|REPLY)$/;
const WRITTEN_TABLE = "clientMessages";

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface Found {
  readonly source: string;
  readonly role: "composer" | "writer";
}

function productionSources(): SourceFile[] {
  const packages = path.join(ROOT, "packages");
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        files.push({ path: path.relative(ROOT, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  for (const pkg of fs.readdirSync(packages, { withFileTypes: true })) {
    const src = path.join(packages, pkg.name, "src");
    if (pkg.isDirectory() && pkg.name !== HARNESS && fs.existsSync(src)) walk(src);
  }
  return files;
}

function isFunctionValue(node: ts.Expression | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** The name a declaration is listed under: `Class.method` for a method, the bare name otherwise; null when it has none. */
function declaredName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.body !== undefined && ts.isIdentifier(node.name)) {
    const owner = ts.isClassLike(node.parent) && node.parent.name !== undefined ? `${node.parent.name.text}.` : "";
    return `${owner}${node.name.text}`;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionValue(node.initializer)) return node.name.text;
  return null;
}

function memberName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

function enclosingName(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    const name = declaredName(at);
    if (name !== null) return name;
  }
  return null;
}

function insertsClientMessages(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "insert") return false;
  const [table] = node.arguments;
  return table !== undefined && ts.isIdentifier(table) && table.text === WRITTEN_TABLE;
}

/** Every composer and writer the files declare, as `<path>#<name>`; a writer outside any named function is its own finding. */
function textSources(files: readonly SourceFile[]): Found[] {
  const found = new Map<string, Found>();
  for (const file of files) {
    const parsed = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const name = declaredName(node);
      const add = (role: Found["role"], declared: string): void => {
        found.set(`${role} ${file.path}#${declared}`, { source: `${file.path}#${declared}`, role });
      };
      if (name !== null && COMPOSER_NAME.test(memberName(name))) add("composer", name);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !isFunctionValue(node.initializer) && TEXT_CONSTANT_NAME.test(node.name.text)) add("composer", node.name.text);
      if (insertsClientMessages(node)) add("writer", enclosingName(node) ?? `<unnamed at line ${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}>`);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return [...found.values()];
}

const composers = new Set([...TEXT_COVERED, ...TEXT_EXCLUDED].map((entry) => entry.source));
const writers = new Set(CLIENT_MESSAGE_WRITERS.map((entry) => entry.source));

function unplaced(found: readonly Found[]): string[] {
  return found.filter((each) => !(each.role === "composer" ? composers : writers).has(each.source)).map((each) => `${each.role} ${each.source}`);
}

describe("I9's covered and excluded lists", () => {
  const found = textSources(productionSources());

  it("place every client_messages writer and every brief, prompt and report composer the source declares", () => {
    expect(found.some((each) => each.role === "writer")).toBe(true);
    expect(found.some((each) => each.role === "composer")).toBe(true);
    expect(unplaced(found)).toEqual([]);
  });

  it("name only writers and composers the source still declares, each once", () => {
    const entries = [
      ...[...TEXT_COVERED, ...TEXT_EXCLUDED].map((entry) => `composer ${entry.source}`),
      ...CLIENT_MESSAGE_WRITERS.map((entry) => `writer ${entry.source}`),
    ];
    const declared = new Set(found.map((each) => `${each.role} ${each.source}`));
    expect(entries.filter((entry) => !declared.has(entry))).toEqual([]);
    expect(entries.filter((entry, i) => entries.indexOf(entry) !== i)).toEqual([]);
  });

  it("place every text a writer posts", () => {
    expect(CLIENT_MESSAGE_WRITERS.flatMap((writer) => writer.posts).filter((text) => !composers.has(text))).toEqual([]);
  });

  it("name for I4 only violation keys I4 reports", () => {
    // I4 is client-reports.ts and the checker of each report kind beside it (client-report-<kind>.ts).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const checkers = fs.readdirSync(here).filter((name) => /^client-reports?(-[a-z-]+)?\.ts$/.test(name));
    expect(checkers).toContain("client-reports.ts");
    const i4 = checkers.map((name) => fs.readFileSync(path.join(here, name), "utf8")).join("\n");
    const keys = TEXT_COVERED.flatMap((entry) => entry.judges.flatMap((judge) => (judge.by === "I4" ? [judge.key] : [])));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !i4.includes(`"${key}`) && !i4.includes(`\`${key}`))).toEqual([]);
  });

  it("fail on a planted composer or writer outside the lists", () => {
    const planted: SourceFile = {
      path: "packages/engagement/src/planted.ts",
      text: [
        "function plantedReport(count: number): string { return `${count}`; }",
        "export class Planted { async post(db: Db) { await db.transaction(async (tx) => tx.insert(clientMessages).values({})); } }",
        "const PLANTED_REPLY = 'text';",
      ].join("\n"),
    };
    expect(unplaced(textSources([planted])).sort()).toEqual(
      [
        "composer packages/engagement/src/planted.ts#PLANTED_REPLY",
        "composer packages/engagement/src/planted.ts#plantedReport",
        "writer packages/engagement/src/planted.ts#Planted.post",
      ].sort(),
    );
  });
});
