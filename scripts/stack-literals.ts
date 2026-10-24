/**
 * Finds a stack literal in production source: a manifest file name, a language name, a source file
 * extension or a package-manager or toolchain name written as a string, template or regular
 * expression literal (CLAUDE.md "Target Generality"). Ashara provides
 * context and never prescribes a stack, so a literal like "Cargo.toml" in packages/<pkg>/src is a
 * table of the projects that work, invisible in a TypeScript project and fatal in the rest.
 * Run by check-boundaries.ts inside `just check`; the tokens and the reviewed exemptions live in
 * the [stack-literals] section of boundary-rules.toml.
 *
 * What is read: every string, no-substitution template, template part and regular expression
 * literal of a non-test .ts file under packages/<pkg>/src, parsed with the TypeScript compiler, so
 * a quote inside a regular expression never hides the rest of a line. A module specifier is not
 * read: `import "./x.js"` names a module of Ashara, not a stack it assumes; the specifiers are the
 * import edges import-targets.ts reads (a require's and a vitest loader's among them) and a
 * `declare module` name. Comments and
 * identifiers are not read: a comment changes no behaviour, and the defect is code that decides or
 * instructs on a literal.
 *
 * A token matches case-insensitively where the characters on either side of it are not letters,
 * digits or `_`: ".py" matches `".py"` and `/\.py$/` but not `"x.pyc"`, and "npm" matches
 * `"npm install"` but not `".npmrc"`.
 *
 * Blind spots, each a defect this check passes:
 * - The denylist is itself a table of what to refuse: a stack it does not name (a manifest, a
 *   language or a tool nobody listed) passes, the same failure the check exists to catch in code.
 * - A literal split across pieces (`"Cargo" + ".toml"`, `/\.(py|rb)$/`, `[".", "py"].join("")`) or
 *   built from data never forms the token.
 * - A presumption in prose, a model prompt or a role charter that names no token ("the entry
 *   point", "the test runner", "the build script") assumes a stack without spelling one.
 * - A file name that only ends in a listed extension (`"index.ts"`) is not an extension literal.
 * - An exemption admits its token anywhere in its file, so a second literal with the same token
 *   in an exempted file passes; an exemption no literal uses is reported, so the list only shrinks.
 */

import ts from "typescript";
import { importEdges } from "./import-targets.js";

class StackLiteralRulesError extends Error {
  constructor(
    readonly rulesPath: string,
    readonly lineNumber: number,
    readonly lineText: string,
    readonly reason: string,
  ) {
    super(`${rulesPath}:${lineNumber}: [${STACK_LITERALS_SECTION}] ${reason} — ${JSON.stringify(lineText)}`);
    this.name = "StackLiteralRulesError";
  }
}

export const STACK_LITERALS_SECTION = "stack-literals";

interface StackLiteralExemption {
  readonly id: string;
  /** Repository-relative path of the one file the exemption covers. */
  readonly file: string;
  readonly tokens: readonly string[];
  readonly reason: string;
}

export interface StackLiteralRules {
  /** Token group name (manifest, language, extension, toolchain) -> its tokens. */
  readonly tokens: ReadonlyMap<string, readonly string[]>;
  readonly exemptions: readonly StackLiteralExemption[];
}

export interface StackLiteralHit {
  readonly line: number;
  readonly token: string;
  /** The literal as written, cut to a readable length. */
  readonly literal: string;
}

const SECTION_RE = /^\[([^\]]+)\]$/;
const TOKENS_RE = /^tokens\.([a-z][a-z0-9-]*)\s*=\s*\[(.*)\]$/;
const EXEMPT_RE =
  /^exempt\.([a-z0-9][a-z0-9-]*)\s*=\s*\{\s*file\s*=\s*"([^"]+)"\s*,\s*tokens\s*=\s*\[([^\]]*)\]\s*,\s*reason\s*=\s*"([^"]+)"\s*\}$/;
const QUOTED_RE = /^"([^"]+)"$/;

function parseQuotedList(inner: string, rulesPath: string, lineNumber: number, line: string): string[] {
  const items = inner.split(",").map((item) => item.trim()).filter((item) => item !== "");
  return items.map((item) => {
    const quoted = QUOTED_RE.exec(item);
    if (quoted === null) throw new StackLiteralRulesError(rulesPath, lineNumber, line, `${item} is not a double-quoted string`);
    return quoted[1];
  });
}

/** Reads the [stack-literals] section; a missing section, an empty token group or an unknown key fails closed. */
export function parseStackLiteralRules(toml: string, rulesPath: string): StackLiteralRules {
  const tokens = new Map<string, string[]>();
  const exemptions: StackLiteralExemption[] = [];
  let inSection = false;
  let sawSection = false;
  const lines = toml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNumber = i + 1;
    const section = SECTION_RE.exec(line);
    if (section !== null) {
      inSection = section[1] === STACK_LITERALS_SECTION;
      sawSection ||= inSection;
      continue;
    }
    if (!inSection || line === "" || line.startsWith("#")) continue;

    const group = TOKENS_RE.exec(line);
    if (group !== null) {
      const list = parseQuotedList(group[2], rulesPath, lineNumber, line);
      if (list.length === 0) throw new StackLiteralRulesError(rulesPath, lineNumber, line, "token group is empty");
      if (tokens.has(group[1])) throw new StackLiteralRulesError(rulesPath, lineNumber, line, `token group "${group[1]}" is stated twice`);
      tokens.set(group[1], list);
      continue;
    }

    const exempt = EXEMPT_RE.exec(line);
    if (exempt !== null) {
      const [, id, file, tokenList, reason] = exempt;
      if (exemptions.some((e) => e.id === id)) throw new StackLiteralRulesError(rulesPath, lineNumber, line, `exemption "${id}" is stated twice`);
      const exemptTokens = parseQuotedList(tokenList, rulesPath, lineNumber, line);
      if (exemptTokens.length === 0) throw new StackLiteralRulesError(rulesPath, lineNumber, line, "exemption names no token");
      exemptions.push({ id, file, tokens: exemptTokens, reason });
      continue;
    }

    throw new StackLiteralRulesError(rulesPath, lineNumber, line, "unrecognised key (expected tokens.<group> or exempt.<id>)");
  }
  if (!sawSection) throw new StackLiteralRulesError(rulesPath, 0, `[${STACK_LITERALS_SECTION}]`, "section is missing");
  if (tokens.size === 0) throw new StackLiteralRulesError(rulesPath, 0, `[${STACK_LITERALS_SECTION}]`, "states no token group; a denylist of nothing would pass");
  const known = new Set([...tokens.values()].flat().map((token) => token.toLowerCase()));
  for (const exemption of exemptions) {
    for (const token of exemption.tokens) {
      if (!known.has(token.toLowerCase())) {
        throw new StackLiteralRulesError(rulesPath, 0, `exempt.${exemption.id}`, `exempts "${token}", which no token group lists`);
      }
    }
  }
  return { tokens, exemptions };
}

const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** The [start, end) offsets where `token` stands alone in `text`. */
function tokenSpans(text: string, token: string): [number, number][] {
  const haystack = text.toLowerCase();
  const needle = token.toLowerCase();
  const spans: [number, number][] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : haystack[at - 1];
    // eslint-disable-next-line no-restricted-syntax -- policy default: past the end of the text is a word boundary
    const after = haystack[at + needle.length] ?? "";
    if (!WORD_CHAR_RE.test(before) && !WORD_CHAR_RE.test(after)) spans.push([at, at + needle.length]);
  }
  return spans;
}

/** The tokens standing alone in `text`, less one whose every occurrence lies inside a longer one ("cargo" in "Cargo.toml"). */
function tokensIn(text: string, tokens: readonly string[]): string[] {
  const found = tokens.map((token) => ({ token, spans: tokenSpans(text, token) })).filter((f) => f.spans.length > 0);
  const inside = (span: [number, number], other: [number, number]): boolean =>
    other[0] <= span[0] && span[1] <= other[1] && other[1] - other[0] > span[1] - span[0];
  return found
    .filter((f) => !f.spans.every((span) => found.some((o) => o.spans.some((other) => inside(span, other)))))
    .map((f) => f.token);
}

/** A module's name: an import edge's specifier (import-targets.ts), at one of `specifierStarts`, or a `declare module` name. */
function isModuleSpecifier(node: ts.Node, sourceFile: ts.SourceFile, specifierStarts: ReadonlySet<number>): boolean {
  return specifierStarts.has(node.getStart(sourceFile)) || ts.isModuleDeclaration(node.parent);
}

function literalText(node: ts.Node, sourceFile: ts.SourceFile, specifierStarts: ReadonlySet<number>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return isModuleSpecifier(node, sourceFile, specifierStarts) ? null : node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return node.getText(sourceFile);
  return null;
}

/** Every literal of `source` that contains one of `tokens`, one hit per literal and token. */
export function findStackLiterals(source: string, fileName: string, tokens: readonly string[]): StackLiteralHit[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: StackLiteralHit[] = [];
  const specifierStarts = new Set(importEdges(fileName, source).map((edge) => edge.start));
  const visit = (node: ts.Node): void => {
    const text = literalText(node, sourceFile, specifierStarts);
    if (text !== null) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const written = node.getText(sourceFile);
      const literal = written.length > 80 ? `${written.slice(0, 77)}...` : written;
      for (const token of tokensIn(text, tokens)) hits.push({ line, token, literal });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}
