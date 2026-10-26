/**
 * Fails on a comment that carries something that can go stale (records rule 5 of the governance
 * rules): a decision record id, a decision number, a board story or task id, a design-review label, a
 * record label, a migration number, a date in any form, a path into the governance documents, a run
 * name, a story named in words, a commit hash, or a history marker. A comment states the rule the
 * code keeps and why; the provenance of that rule lives in the governance records, which cite the
 * code, never the reverse.
 *
 * What is read, over every file `git ls-files` lists outside COMMENT_LINT_EXCLUDES:
 * - .ts, .mts, .cts, .mjs, .cjs and .js files: every comment, found by the TypeScript parser so a
 *   `//` inside a string, template or regular expression is never taken for one, and the title of
 *   every `it`, `test`, `describe` and `suite` call (including `.each`, `.skip`, `.skipIf(...)` and
 *   the like), since a test title is read as prose about the code just as a comment is.
 * - justfile, .github/workflows, docker/, *.toml, config/env.example and .gitignore: every `#`
 *   comment that starts a line or follows whitespace outside a quoted string.
 * - .sql files: every `--` comment.
 * - .md files: every line of prose outside a fenced code block; .html and .css files: every
 *   `<!-- -->` or `/* *\/` comment.
 * Code, string literals and identifiers are not read: they are behaviour, and a string that names a
 * path or holds a date is data the code acts on.
 *
 * A design label is any capital letter and one or two digits, with an optional lowercase suffix
 * (`W<n>`, or `W<n>` followed by a lowercase letter), plus an option label (a capital and digits, a
 * space, a lowercase letter), `mig-` and `r9f-` ids, and a milestone label followed by `exit`. A
 * record label is two to four capitals, one to three digits and an optional lowercase suffix
 * (`AR<n>`); one whose capitals are a STANDARD_PREFIXES entry names a standard and passes.
 * A run name is an `m<n>final` name, or `run` or `w` and digits with a letter suffix. A story by name
 * is a hyphenated name next to the word story, or the word story before the word decision. A non-ISO
 * date is a month name and a day in either order, or two slash-separated day and month numbers; a
 * fraction written with a slash reads as one too, so a comment spells a fraction out.
 * Either kind of label passes in a file that holds it as a whole string literal, and in every file of
 * a package (`packages/<name>`, or a top-level directory) whose non-test code holds it so: there it
 * is an id the code defines (an invariant's name), and a comment naming it names code. A literal in a
 * test file is a fixture and exempts the label in that test file alone; a literal in another package
 * exempts nothing. A design label also passes when it is one of DOMAIN_NAMES, a word of the domain
 * that happens to have the label's shape. Likewise a numbered SQL file name passes when a tracked
 * file has that name: the comment names a file that exists, not one a checkout no longer holds. A
 * migration number is also caught bare: a zero-padded three-digit number after `pre-`, `before`,
 * `after`, `since`, `until` or an opening parenthesis (`before` followed by such a number, `pre-`
 * joined to one, a parenthesised list of them), since a quantity in prose carries no leading zero.
 *
 * A comment names only files that exist. A path-like token (slash-separated parts ending in a
 * script, SQL or TOML file) fails unless a tracked file is that path or ends with it after a slash,
 * or production code holds the token in a string literal: then it is a path the code reads, such as
 * the target repository's contract file, which no Ashara checkout tracks. A file name written after
 * the name of a package (a directory under the packages directory, in any case, on the same line or across a line
 * break) fails unless that package tracks a file of that name. A file named after an orchestrator
 * package, in any case and on the same line or across a line break, fails whatever the tree holds,
 * since no package of that name exists. The planning and development contexts are retired too, their
 * code now Delivery's, Quality's and execution-infra's: a symbol or file named as theirs (a
 * camel-case name or a script file after `planning's` or `development's`, on one line or across a
 * line break), the context written with `BC` after it, and a path under it fail, since none names a
 * home that exists. Either word as an activity (`a stopped planning's message`) passes. A `@testseam` tag that names a test file fails unless a
 * tracked test file of that name mentions a value the tagged declaration declares or exports: the
 * tag claims that file drives the seam, and a file that never names it does not.
 *
 * Blind spots, each a stale comment this check passes:
 * - A history account in plain words ("X now does Y", "after the outage we ...") uses no marker the
 *   history pattern lists; only the listed markers are caught.
 * - A count or line number of other code ("the three callers", "see line 40") has no shape a pattern
 *   can tell apart from a rule stating a quantity.
 * - A measurement ("about ten seconds today") goes stale without carrying any id.
 * - An id written in a shape no pattern lists (a new label scheme) passes until a pattern names it.
 * - A bare migration number in any other wording ("the rows 046 wrote") or without its leading zero
 *   ("before 58") passes.
 * - A label that a string literal in the same file or package happens to equal passes there.
 * - A string literal that is prose for a human (a log message, a fixture description) is not read.
 * - A slash-separated path split across two comment lines is read as two halves, neither a path;
 *   only a package, orchestrator or retired context name ending one line and a file or symbol name
 *   opening the next are joined.
 * - A symbol named as a real package's (`Quality's runSuitesOnCheckout`) is not checked against that
 *   package's declarations; only the retired context names are caught.
 * - A `@testseam` tag on a type-only declaration is not judged: a test uses a type by its shape, not
 *   its name. A test file that names the value without calling it passes.
 * - A bare file name after no package name is not resolved: a placeholder in a usage line or a file
 *   another tool owns is written the same way.
 * - A path that resolves by suffix to some other tracked file of the same trailing name passes.
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
const MISSING_PATH_CLASS = "missing path";
const PATH_TOKEN = /(?<![\w./-])[\w-]+(?:\/[\w.-]+)+\.(?:[cm]?ts|sql|toml)\b/g;
const PACKAGE_FILE = /\b([A-Za-z][\w-]*) ([\w.-]+\.(?:[cm]?ts|sql|toml))\b/g;
const ORCHESTRATOR_CLASS = "nonexistent package path";
const ORCHESTRATOR_FILE = /\borchestrator[ /][\w-]+\.ts\b/gi;
const RETIRED_CONTEXT_CLASS = "retired context home";
const RETIRED_CONTEXT_HOME = /\b(?:[Pp]lanning|[Dd]evelopment)(?:'s (?:[a-z]+[A-Z]\w*|[\w-]+\.[cm]?ts)\b| BC\b|\/[a-z][\w-]*)/g;
const TESTSEAM_CLASS = "testseam without caller";
const TESTSEAM_FILE = /(?<![\w.*-])\w[\w.-]*\.test\.[cm]?ts\b/g;
const COMMENT_MARKER = /^\s*(?:\/\/+|\*|#|--)?\s*/;
const NUMBERED_SQL_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
const RECORD_LABEL_CLASS = "record label";
const LABEL_SHAPE = /^(?:[A-Z]\d{1,2}[a-z]?|[A-Z]{2,4}\d{1,3}[a-z]?)$/;
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/**
 * Letter prefixes of published standards and formats whose names carry a number (SQL92, UTF8,
 * SHA256, ES2022, HTTP2, MD5, AES256, IPV4, BASE64): a capitals-and-digits word with one of these
 * prefixes names the standard, not a record.
 */
const STANDARD_PREFIXES: ReadonlySet<string> = new Set(["SQL", "UTF", "SHA", "ES", "HTTP", "MD", "AES", "IPV", "BASE"]);

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
  { patternClass: ORCHESTRATOR_CLASS, regex: ORCHESTRATOR_FILE },
  { patternClass: RETIRED_CONTEXT_CLASS, regex: RETIRED_CONTEXT_HOME },
  { patternClass: "run name", regex: /\b(?:m\d+final\d*|run\d+[a-z]+|w\d+[a-z])\b/g },
  {
    patternClass: "story by name",
    regex: /\b[a-z0-9]+(?:-[a-z0-9]+)+ stor(?:y|ies)\b|\bstor(?:y|ies) (?:decision|[a-z0-9]+(?:-[a-z0-9]+)+)\b/gi,
  },
  {
    patternClass: "non-ISO date",
    regex: new RegExp(
      `\\b${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2} ${MONTH}\\b|(?<![\\w/.])\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?(?![\\w/]|\\.\\d)`,
      "g",
    ),
  },
  { patternClass: RECORD_LABEL_CLASS, regex: /\b[A-Z]{2,4}\d{1,3}[a-z]?\b/g },
  { patternClass: "commit hash", regex: /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g },
  { patternClass: "history marker", regex: /\b(?:previously|formerly|used to be|was changed)\b/gi },
];

const TEST_CALLEES: ReadonlySet<string> = new Set(["it", "test", "describe", "suite"]);

function splitLines(text: string, firstLine: number): CommentLine[] {
  return text.split(/\r?\n/).map((piece, index) => ({ line: firstLine + index, text: piece }));
}

function isScript(relPath: string): boolean {
  return /\.(?:[cm]?ts|[cm]?js)$/.test(relPath);
}

function parseScript(relPath: string, content: string): ts.SourceFile {
  const kind = /\.[cm]?ts$/.test(relPath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
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
 * The short labels (`W<n>`, `AR<n>`) a script holds as a whole string literal: ids the code itself defines.
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

function isStandardName(word: string): boolean {
  const prefix = /^[A-Z]+/.exec(word);
  return prefix !== null && STANDARD_PREFIXES.has(prefix[0]);
}

function firstMatch(pattern: StalePattern, text: string, labels: ReadonlySet<string>): string | null {
  for (const match of text.matchAll(pattern.regex)) {
    if (pattern.patternClass === DESIGN_LABEL_CLASS && (labels.has(match[0]) || DOMAIN_NAMES.has(match[0]))) continue;
    if (pattern.patternClass === RECORD_LABEL_CLASS && (labels.has(match[0]) || isStandardName(match[0]))) continue;
    if (pattern.patternClass === MIGRATION_CLASS && NUMBERED_SQL_FILE.test(match[0]) && labels.has(match[0])) continue;
    return match[0];
  }
  return null;
}

/**
 * What a comment's path may resolve to: the tracked files, by whole path or by a trailing part after
 * a slash; the base names each package tracks; and the path-like tokens production code holds in a
 * string literal.
 * @testseam check-comments.test.ts resolves planted paths against a small tree without running the CLI
 */
export interface CommentTree {
  readonly suffixes: ReadonlySet<string>;
  readonly packageFiles: ReadonlyMap<string, ReadonlySet<string>>;
  readonly codePaths: ReadonlySet<string>;
  readonly testFiles: ReadonlyMap<string, readonly string[]>;
}

function literalPaths(relPath: string, content: string): string[] {
  const paths: string[] = [];
  if (!isScript(relPath) || isTestFile(relPath) || content.search(PATH_TOKEN) < 0) return paths;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const match of node.text.matchAll(PATH_TOKEN)) paths.push(match[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseScript(relPath, content));
  return paths;
}

/**
 * The tree `tracked` lists, with the code paths the production scripts among `files` hold.
 * @testseam check-comments.test.ts builds a small tree without running the CLI
 */
export function commentTree(tracked: readonly string[], files: ReadonlyMap<string, string>): CommentTree {
  const suffixes = new Set<string>();
  const packageFiles = new Map<string, Set<string>>();
  for (const relPath of tracked) {
    const parts = relPath.split("/");
    for (let i = 0; i < parts.length; i += 1) suffixes.add(parts.slice(i).join("/"));
    const name = parts[1];
    const base = parts.at(-1);
    if (parts[0] !== "packages" || parts.length < 3 || name === undefined || base === undefined) continue;
    const names = packageFiles.get(name) ?? new Set<string>();
    names.add(base);
    packageFiles.set(name, names);
  }
  const codePaths = new Set<string>();
  for (const [file, content] of files) for (const token of literalPaths(file, content)) codePaths.add(token);
  const testFiles = new Map<string, string[]>();
  for (const relPath of tracked) {
    if (!isTestFile(relPath)) continue;
    const content = files.get(relPath);
    if (content === undefined) continue;
    const base = path.posix.basename(relPath);
    const contents = testFiles.get(base);
    if (contents === undefined) testFiles.set(base, [content]);
    else contents.push(content);
  }
  return { suffixes, packageFiles, codePaths, testFiles };
}

function missingPackageFile(text: string, tree: CommentTree): string | null {
  for (const match of text.matchAll(PACKAGE_FILE)) {
    const [token, name, base] = match;
    if (name === undefined || base === undefined) continue;
    const names = tree.packageFiles.get(name.toLowerCase());
    if (names !== undefined && !names.has(base)) return token;
  }
  return null;
}

function missingPath(text: string, tree: CommentTree): string | null {
  for (const match of text.matchAll(PATH_TOKEN)) {
    if (!tree.suffixes.has(match[0]) && !tree.codePaths.has(match[0])) return match[0];
  }
  return missingPackageFile(text, tree);
}

/** A package or context name ending one comment line and the file or symbol opening the next, read as one phrase. */
function lineBreakPhrase(previous: string, text: string): string {
  const tail = /(\S+)\s*$/.exec(previous)?.[1];
  const head = /^\S+/.exec(text.replace(COMMENT_MARKER, ""))?.[0];
  return tail === undefined || head === undefined ? "" : `${tail} ${head}`;
}

function splitFinding(phrase: string, tree: CommentTree): { readonly patternClass: string; readonly match: string } | null {
  const orchestrator = phrase.match(new RegExp(ORCHESTRATOR_FILE.source, "i"));
  if (orchestrator !== null) return { patternClass: ORCHESTRATOR_CLASS, match: orchestrator[0] };
  const retired = phrase.match(new RegExp(RETIRED_CONTEXT_HOME.source));
  if (retired !== null) return { patternClass: RETIRED_CONTEXT_CLASS, match: retired[0] };
  const missing = missingPackageFile(phrase, tree);
  return missing === null ? null : { patternClass: MISSING_PATH_CLASS, match: missing };
}

/** The value names a statement's export list names, local and exported; the module it names is not read. */
function exportedValueNames(node: ts.Node): string[] {
  if (!ts.isStatement(node) || ts.isModuleDeclaration(node)) return [];
  const names: string[] = [];
  const collect = (child: ts.Node): void => {
    if (!ts.isExportSpecifier(child)) {
      ts.forEachChild(child, collect);
      return;
    }
    if (child.isTypeOnly || child.parent.parent.isTypeOnly) return;
    names.push(child.name.text);
    if (child.propertyName !== undefined) names.push(child.propertyName.text);
  };
  ts.forEachChild(node, collect);
  return names;
}

function declaredValueNames(node: ts.Node): string[] {
  const exported = exportedValueNames(node);
  if (exported.length > 0) return exported;
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name !== undefined && (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) ? [node.name.text] : [];
  }
  return [];
}

function mentions(content: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`).test(content);
}

/**
 * The `@testseam` tags in one script whose named test file is untracked or never names a value the
 * tagged declaration declares or exports.
 */
function testseamFindings(relPath: string, content: string, tree: CommentTree): StaleCommentFinding[] {
  if (!isScript(relPath) || !content.includes("@testseam")) return [];
  const source = parseScript(relPath, content);
  const seen = new Set<number>();
  const findings: StaleCommentFinding[] = [];
  const visit = (node: ts.Node): void => {
    const ranges = ts.getLeadingCommentRanges(content, node.getFullStart());
    for (const range of ranges === undefined ? [] : ranges) {
      const names = declaredValueNames(node);
      if (names.length === 0 || seen.has(range.pos)) continue;
      seen.add(range.pos);
      const comment = content.slice(range.pos, range.end);
      if (!comment.includes("@testseam")) continue;
      for (const match of comment.matchAll(TESTSEAM_FILE)) {
        const contents = tree.testFiles.get(match[0]);
        if (contents?.some((text) => names.some((name) => mentions(text, name))) === true) continue;
        const at = range.pos + match.index;
        const line = source.getLineAndCharacterOfPosition(at).line + 1;
        const lineEnd = content.indexOf("\n", at);
        const text = content.slice(content.lastIndexOf("\n", at) + 1, lineEnd < 0 ? content.length : lineEnd);
        findings.push({ file: relPath, line, patternClass: TESTSEAM_CLASS, match: match[0], text: text.trim() });
      }
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return findings;
}

/**
 * The stale patterns in one file's comments and test titles, one finding per line and pattern class.
 * `names` holds what a comment here may name besides this file's own labels (definedLabels over it):
 * the numbered SQL files trackedSqlNames finds and the labels packageLabels gives this file's
 * package. A literal anywhere else, such as another file's test fixture id, exempts nothing. `tree`
 * is what a path a comment names must resolve to.
 * @testseam check-comments.test.ts plants one comment per pattern class without running the CLI
 */
export function findStaleComments(
  relPath: string,
  content: string,
  names: ReadonlySet<string>,
  tree: CommentTree,
): StaleCommentFinding[] {
  const labels = new Set([...names, ...definedLabels(relPath, content)]);
  const findings: StaleCommentFinding[] = [];
  let previous: CommentLine | null = null;
  for (const { line, text } of extractCommentLines(relPath, content)) {
    for (const pattern of STALE_PATTERNS) {
      const match = firstMatch(pattern, text, labels);
      if (match !== null) {
        findings.push({ file: relPath, line, patternClass: pattern.patternClass, match, text: text.trim() });
      }
    }
    const missing = missingPath(text, tree);
    const split = previous?.line === line - 1 ? splitFinding(lineBreakPhrase(previous.text, text), tree) : null;
    if (missing !== null) {
      findings.push({ file: relPath, line, patternClass: MISSING_PATH_CLASS, match: missing, text: text.trim() });
    } else if (split !== null) {
      findings.push({ file: relPath, line, patternClass: split.patternClass, match: split.match, text: text.trim() });
    }
    previous = { line, text };
  }
  findings.push(...testseamFindings(relPath, content, tree));
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

function packageOf(relPath: string): string {
  const parts = relPath.split("/");
  if (parts[0] === "packages" && parts.length > 2) return `packages/${parts[1]}`;
  return parts.length > 1 ? parts[0] : "";
}

function isTestFile(relPath: string): boolean {
  return /\.test\.[cm]?[jt]s$/.test(relPath);
}

/**
 * The labels each package's production code defines (definedLabels over its non-test scripts),
 * answered for any file by the package it sits in. A test file's literals are fixtures, not
 * definitions: they exempt a label in that test file alone (findStaleComments reads its own file).
 * @testseam check-comments.test.ts exercises the package scope without running the CLI
 */
export function packageLabels(files: ReadonlyMap<string, string>): (relPath: string) => ReadonlySet<string> {
  const byPackage = new Map<string, Set<string>>();
  for (const [file, content] of files) {
    if (isTestFile(file)) continue;
    const key = packageOf(file);
    const labels = byPackage.get(key) ?? new Set<string>();
    for (const label of definedLabels(file, content)) labels.add(label);
    byPackage.set(key, labels);
  }
  const none: ReadonlySet<string> = new Set();
  return (relPath) => byPackage.get(packageOf(relPath)) ?? none;
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
  const sqlNames = trackedSqlNames(tracked);
  const byPackage = packageLabels(files);
  const tree = commentTree(tracked, files);
  const findings: StaleCommentFinding[] = [];
  for (const [file, content] of files) {
    findings.push(...findStaleComments(file, content, new Set([...sqlNames, ...byPackage(file)]), tree));
  }
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
