/**
 * Fails on a comment that carries something that can go stale (records rule 5 of the governance
 * rules): a decision record id, a decision number, a board story or task id, a design-review label, a
 * migration number, a date, a path into the governance documents, a run name, a commit hash, or a
 * history marker. A comment states the rule the code keeps and why; the provenance of that rule
 * lives in the governance records, which cite the code, never the reverse.
 *
 * What is read, over every file `git ls-files` lists outside COMMENT_LINT_EXCLUDES:
 * - .ts, .mjs and .js files: every comment, found by the TypeScript parser so a `//` inside a string,
 *   template or regular expression is never taken for one, and the title of every `it`, `test`,
 *   `describe` and `suite` call (including `.each`, `.skip`, `.skipIf(...)` and the like), since a
 *   test title is read as prose about the code just as a comment is.
 * - justfile, .github/workflows, docker/, *.toml, config/env.example and .gitignore: every `#`
 *   comment that starts a line or follows whitespace outside a quoted string.
 * - .sql files: every `--` comment.
 * - .md files: every line of prose outside a fenced code block; .html and .css files: every
 *   `<!-- -->` or `/* *\/` comment.
 * Code, string literals and identifiers are not read: they are behaviour, and a string that names a
 * path or holds a date is data the code acts on.
 *
 * A design label is any capital letter and one or two digits, with an optional lowercase suffix
 * (`W1`, or `W1` followed by a lowercase letter), plus an option label (a capital and digits, a space, a lowercase letter), `mig-` and `r9f-`
 * ids, and a milestone label followed by `exit`.
 * Such a label passes when some script holds it as a whole string literal: then it is an id the code
 * itself defines (an invariant's name), and a comment naming it names code. It also passes when it is
 * one of DOMAIN_NAMES, a word of the domain that happens to have the label's shape. Likewise a
 * numbered SQL file name passes when a tracked file has that name: the comment names a file that
 * exists, not one a checkout no longer holds. A migration number is also caught bare: a zero-padded
 * three-digit number after `pre-`, `before`, `after`, `since`, `until` or an opening parenthesis
 * (`before` followed by such a number, `pre-` joined to one, a parenthesised list of them), since a
 * quantity in prose carries no leading zero.
 *
 * Blind spots, each a stale comment this check passes:
 * - A history account in plain words ("X now does Y", "after the outage we ...") uses no marker the
 *   history pattern lists; only the listed markers are caught.
 * - A count or line number of other code ("the three callers", "see line 40") has no shape a pattern
 *   can tell apart from a rule stating a quantity.
 * - A measurement ("about ten seconds today") goes stale without carrying any id.
 * - An id written in a shape no pattern lists (a two-letter label such as `IN3`, a new label scheme)
 *   passes until a pattern names it.
 * - A bare migration number in any other wording ("the rows 046 wrote") or without its leading zero
 *   ("before 58") passes.
 * - A design label that some string literal happens to equal passes everywhere.
 * - A string literal that is prose for a human (a log message, a fixture description) is not read.
 *
 * Exits 0 when no comment matches, 1 on a match or when a file cannot be read.
 *
 * Usage: npx tsx scripts/check-comments.ts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describeErrorChain } from "@ashara/shared";

/**
 * Path prefixes the lint skips. Empty: the migrations are one baseline file whose comments state the
 * schema, so they are read like any other source.
 * @testseam check-comments.test.ts checks a prefix here is skipped
 */
export const COMMENT_LINT_EXCLUDES: readonly string[] = [];

/** @testseam check-comments.test.ts reads extracted lines */
export interface CommentLine {
  readonly line: number;
  readonly text: string;
}

/** @testseam check-comments.test.ts reads findings */
export interface StaleCommentFinding {
  readonly file: string;
  readonly line: number;
  readonly patternClass: string;
  readonly match: string;
  readonly text: string;
}

interface StalePattern {
  readonly patternClass: string;
  readonly regex: RegExp;
}

const DESIGN_LABEL_CLASS = "design label";
const MIGRATION_CLASS = "migration number";
const NUMBERED_SQL_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
const LABEL_SHAPE = /^[A-Z]\d{1,2}[a-z]?$/;

/**
 * Names in the label shape that are the domain's own words, not labels: Z0 is the host zone Ashara
 * runs in, named throughout the architecture, and no code holds it as a whole string.
 */
const DOMAIN_NAMES: ReadonlySet<string> = new Set(["Z0"]);

const STALE_PATTERNS: readonly StalePattern[] = [
  { patternClass: "decision record id", regex: /\bADR[- ]?\d{2,3}\b/g },
  { patternClass: "decision number", regex: /\b(?:d\d{1,3}|addendum \d+|decisions? \d+)\b/g },
  { patternClass: "board id", regex: /\b(?:[tsch]-[a-z0-9]+(?:-[a-z0-9]+)+|[a-z0-9]+-t\d+[a-z]?)\b/g },
  {
    patternClass: DESIGN_LABEL_CLASS,
    regex: /\b(?:O\d+ c|[A-Z]\d{1,2}[a-z]?|(?:mig\d*|r9f)-[a-z0-9]+|M\d(?:\.\d)? exit)\b|\bdesign (?:[A-Z]\d|§)|§\s?\d/g,
  },
  {
    patternClass: MIGRATION_CLASS,
    regex:
      /\b[Mm]igrations? \d{3}\b|\b\d{3}_[a-z0-9_]+\.sql\b|\bmigrations\/\d{3}|(?:\b[Pp]re-|\b(?:[Bb]efore|[Aa]fter|[Ss]ince|[Uu]ntil) |\()0\d{2}\b/g,
  },
  { patternClass: "date", regex: /\b20\d{2}-[01]\d-[0-3]\d\b/g },
  { patternClass: "governance path", regex: /(?<![\w./-])docs\/[\w.-]/g },
  { patternClass: "run name", regex: /\bm\d+final\d*\b/g },
  { patternClass: "commit hash", regex: /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g },
  { patternClass: "history marker", regex: /\b(?:previously|formerly|used to be|was changed)\b/gi },
];

const TEST_CALLEES: ReadonlySet<string> = new Set(["it", "test", "describe", "suite"]);

function splitLines(text: string, firstLine: number): CommentLine[] {
  return text.split(/\r?\n/).map((piece, index) => ({ line: firstLine + index, text: piece }));
}

function isScript(relPath: string): boolean {
  return /\.(?:ts|mjs|js)$/.test(relPath);
}

function parseScript(relPath: string, content: string): ts.SourceFile {
  const kind = relPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, kind);
}

function calleeRoot(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) current = current.expression;
    else return current;
  }
}

function titleText(argument: ts.Expression, source: ts.SourceFile): string | null {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  if (ts.isTemplateExpression(argument)) return argument.getText(source);
  return null;
}

function scriptComments(relPath: string, content: string): CommentLine[] {
  const source = parseScript(relPath, content);
  const seen = new Set<number>();
  const lines: CommentLine[] = [];
  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
  const collect = (ranges: readonly ts.CommentRange[] | undefined): void => {
    if (ranges === undefined) return;
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      lines.push(...splitLines(content.slice(range.pos, range.end), lineOf(range.pos)));
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(content, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(content, node.getEnd()));
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression);
      const first = node.arguments[0];
      if (ts.isIdentifier(root) && TEST_CALLEES.has(root.text) && first !== undefined) {
        const title = titleText(first, source);
        if (title !== null) lines.push(...splitLines(title, lineOf(first.getStart(source))));
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return lines;
}

/**
 * The short labels (`W1`) a script holds as a whole string literal: ids the code itself defines.
 * @testseam check-comments.test.ts exercises the label exemption without running the CLI
 */
export function definedLabels(relPath: string, content: string): Set<string> {
  const labels = new Set<string>();
  if (!isScript(relPath)) return labels;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && LABEL_SHAPE.test(node.text)) {
      labels.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseScript(relPath, content));
  return labels;
}

function hashComments(content: string): CommentLine[] {
  const lines: CommentLine[] = [];
  content.split(/\r?\n/).forEach((text, index) => {
    let quote: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#" && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
        lines.push({ line: index + 1, text: text.slice(i) });
        return;
      }
    }
  });
  return lines;
}

function sqlComments(content: string): CommentLine[] {
  const lines: CommentLine[] = [];
  content.split(/\r?\n/).forEach((text, index) => {
    const at = text.indexOf("--");
    if (at >= 0) lines.push({ line: index + 1, text: text.slice(at) });
  });
  return lines;
}

function delimitedComments(content: string, open: string, close: string): CommentLine[] {
  const lines: CommentLine[] = [];
  let from = 0;
  for (;;) {
    const start = content.indexOf(open, from);
    if (start < 0) return lines;
    const end = content.indexOf(close, start + open.length);
    const stop = end < 0 ? content.length : end + close.length;
    const firstLine = content.slice(0, start).split("\n").length;
    lines.push(...splitLines(content.slice(start, stop), firstLine));
    from = stop;
  }
}

function markdownProse(content: string): CommentLine[] {
  const lines: CommentLine[] = [];
  let fenced = false;
  content.split(/\r?\n/).forEach((text, index) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) lines.push({ line: index + 1, text });
  });
  return lines;
}

function isHashCommented(relPath: string): boolean {
  const base = path.posix.basename(relPath);
  return (
    base === "justfile" ||
    base === ".gitignore" ||
    relPath === "config/env.example" ||
    relPath.endsWith(".toml") ||
    relPath.startsWith(".github/workflows/") ||
    relPath.startsWith("docker/")
  );
}

/**
 * The comment and test-title lines of one file; an empty list for a file type the lint does not read.
 * @testseam check-comments.test.ts exercises extraction without running the CLI
 */
export function extractCommentLines(relPath: string, content: string): CommentLine[] {
  if (isScript(relPath)) return scriptComments(relPath, content);
  if (isHashCommented(relPath)) return hashComments(content);
  if (relPath.endsWith(".sql")) return sqlComments(content);
  if (relPath.endsWith(".md")) return markdownProse(content);
  if (relPath.endsWith(".html")) return delimitedComments(content, "<!--", "-->");
  if (relPath.endsWith(".css")) return delimitedComments(content, "/*", "*/");
  return [];
}

/** @testseam check-comments.test.ts checks the exclude list */
export function isExcluded(relPath: string, excludes: readonly string[] = COMMENT_LINT_EXCLUDES): boolean {
  return excludes.some((prefix) => relPath.startsWith(prefix));
}

function firstMatch(pattern: StalePattern, text: string, labels: ReadonlySet<string>): string | null {
  for (const match of text.matchAll(pattern.regex)) {
    if (pattern.patternClass === DESIGN_LABEL_CLASS && (labels.has(match[0]) || DOMAIN_NAMES.has(match[0]))) continue;
    if (pattern.patternClass === MIGRATION_CLASS && NUMBERED_SQL_FILE.test(match[0]) && labels.has(match[0])) continue;
    return match[0];
  }
  return null;
}

/**
 * The stale patterns in one file's comments and test titles, one finding per line and pattern class.
 * `labels` holds the names the tree defines (definedLabels over every tracked script, and the
 * numbered SQL files trackedSqlNames finds); a comment may name those.
 * @testseam check-comments.test.ts plants one comment per pattern class without running the CLI
 */
export function findStaleComments(
  relPath: string,
  content: string,
  labels: ReadonlySet<string>,
): StaleCommentFinding[] {
  const findings: StaleCommentFinding[] = [];
  for (const { line, text } of extractCommentLines(relPath, content)) {
    for (const pattern of STALE_PATTERNS) {
      const match = firstMatch(pattern, text, labels);
      if (match !== null) {
        findings.push({ file: relPath, line, patternClass: pattern.patternClass, match, text: text.trim() });
      }
    }
  }
  return findings;
}

class CommentLintReadError extends Error {
  constructor(
    readonly file: string,
    options: { cause: unknown },
  ) {
    super(`cannot read tracked file ${file}`, options);
    this.name = "CommentLintReadError";
  }
}

/**
 * The numbered SQL file names among the tracked paths: files a comment may name, since they exist.
 * @testseam check-comments.test.ts exercises the file-name exemption without running the CLI
 */
export function trackedSqlNames(relPaths: readonly string[]): Set<string> {
  return new Set(relPaths.map((relPath) => path.posix.basename(relPath)).filter((base) => NUMBERED_SQL_FILE.test(base)));
}

function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file.length > 0);
}

function main(): void {
  const root = process.cwd();
  const files = new Map<string, string>();
  const tracked = trackedFiles(root);
  for (const file of tracked) {
    if (isExcluded(file)) continue;
    const full = path.join(root, file);
    // A tracked file deleted in the working tree has no comments left to read.
    if (!fs.existsSync(full)) continue;
    try {
      files.set(file, fs.readFileSync(full, "utf8"));
    } catch (err) {
      throw new CommentLintReadError(file, { cause: err });
    }
  }
  const labels = trackedSqlNames(tracked);
  for (const [file, content] of files) for (const label of definedLabels(file, content)) labels.add(label);
  const findings: StaleCommentFinding[] = [];
  for (const [file, content] of files) findings.push(...findStaleComments(file, content, labels));
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.patternClass} "${finding.match}": ${finding.text}`);
  }
  if (findings.length > 0) {
    console.error(`\n${files.size} files checked, ${findings.length} stale comment patterns found\n`);
    process.exit(1);
  }
  console.log(`\nComments clean. ${files.size} files checked, 0 stale comment patterns.\n`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === thisFile) {
  try {
    main();
  } catch (err) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the operator script exits 1 below with the error's chain
    console.error(`\nERROR: ${describeErrorChain(err)}\n`);
    process.exit(1);
  }
}
