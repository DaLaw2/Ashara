/**
 * Executable-claims gate.
 *
 * Finds every ```verify block in the scan scope the documentation README defines (SCAN_SOURCES), runs
 * each command from the repo root, and compares trimmed stdout against the recorded expected
 * output. A mismatch, a non-zero exit, an unreadable document, or an unparseable block is a
 * failure. Zero documents found is a failure.
 *
 * Also enforces the README's retention rules on the investigations directory (checkRetention), and
 * requires the README to still hold, verbatim, every sentence that defines what this gate checks
 * (README_CLAUSES), so the README and the gate cannot drift apart. Exit non-zero on any failure.
 *
 * The repo root is the working directory.
 *
 * Design property: only claims someone explicitly wrote into a verify block are
 * checked. A document with no verify blocks is exactly as unchecked as it was
 * before this gate existed — nothing gets worse. But an adopted claim cannot rot.
 *
 * Usage: npx tsx scripts/check-docs.ts
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";
import { SCAN_SOURCES } from "./check-docs-scope.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class DocumentReadError extends Error {
  readonly filePath: string;
  readonly cause_: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`Cannot read ${filePath}: ${describeErrorChain(cause)}`);
    this.name = "DocumentReadError";
    this.filePath = filePath;
    this.cause_ = cause;
  }
}

class BlockParseError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly reason: string;

  constructor(filePath: string, lineNumber: number, reason: string) {
    super(`${filePath}:${lineNumber}: unparseable verify block — ${reason}`);
    this.name = "BlockParseError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimCommand {
  readonly command: string;
  /** 1-based line in the file where the $ line appears */
  readonly commandLine: number;
  readonly expectedOutput: string;
}

interface VerifyBlock {
  readonly filePath: string;
  /** 1-based line where ```verify starts */
  readonly blockLine: number;
  readonly commands: readonly ClaimCommand[];
}

interface ClaimFailure {
  readonly filePath: string;
  readonly blockLine: number;
  readonly commandLine: number;
  readonly command: string;
  readonly expected: string;
  readonly actual: string;
  readonly kind: "mismatch" | "exit-nonzero" | "parse-error" | "unreadable";
}

interface CheckResult {
  readonly failures: readonly ClaimFailure[];
  readonly commandsRun: number;
  readonly blocksChecked: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extract all verify blocks from a document.
 *
 * Each block is a fenced code block whose info string is "verify" (exactly
 * three backticks — four or more are a different fence level and are not
 * matched, so examples of verify blocks can be written safely inside a
 * four-backtick fence).
 *
 * Inside a block, lines starting with "$ " introduce a command. All
 * subsequent non-command lines until the next "$ " or the closing fence
 * are that command's expected stdout. Multiple commands per block are
 * supported — they run in sequence, each in an independent shell.
 * @testseam check-docs.test.ts exercises parsing without running the CLI
 */
export function parseVerifyBlocks(content: string, filePath: string): VerifyBlock[] {
  const blocks: VerifyBlock[] = [];
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Match exactly three backticks followed by "verify" and optional annotation.
    // Four or more backticks are a higher fence level and are deliberately skipped,
    // so an example verify block inside a ````-fenced code block is not parsed.
    const fenceMatch = /^```verify(\s.*)?$/.exec(line);
    if (!fenceMatch) {
      i++;
      continue;
    }

    const blockLine = i + 1;
    // eslint-disable-next-line no-restricted-syntax -- policy default: a fence with no annotation
    const rawAnnotation = (fenceMatch[1] ?? "").trim();
    if (rawAnnotation !== "") {
      throw new BlockParseError(filePath, blockLine, `unknown annotation "${rawAnnotation}"`);
    }

    i++;

    // Collect body lines until closing ``` (exactly three backticks, optionally
    // followed by whitespace — not four, which would belong to a higher fence).
    const blockLines: Array<{ text: string; lineNumber: number }> = [];
    let closed = false;
    while (i < lines.length) {
      if (/^```\s*$/.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      blockLines.push({ text: lines[i], lineNumber: i + 1 });
      i++;
    }

    if (!closed) {
      throw new BlockParseError(filePath, blockLine, "block never closed — missing closing ```");
    }

    // Parse commands and expected output
    const commands: ClaimCommand[] = [];
    let currentCommand: string | null = null;
    let currentCommandLine = 0;
    let expectedLines: string[] = [];

    for (const bl of blockLines) {
      if (bl.text.startsWith("$ ")) {
        if (currentCommand !== null) {
          commands.push({
            command: currentCommand,
            commandLine: currentCommandLine,
            expectedOutput: expectedLines.join("\n").trim(),
          });
        }
        currentCommand = bl.text.slice(2);
        currentCommandLine = bl.lineNumber;
        expectedLines = [];
      } else if (currentCommand !== null) {
        expectedLines.push(bl.text);
      } else if (bl.text.trim() !== "") {
        // Non-empty line before any $ command — fail closed on malformed blocks
        throw new BlockParseError(
          filePath,
          bl.lineNumber,
          `non-empty line before any $ command: ${JSON.stringify(bl.text)}`,
        );
      }
    }

    if (currentCommand !== null) {
      commands.push({
        command: currentCommand,
        commandLine: currentCommandLine,
        expectedOutput: expectedLines.join("\n").trim(),
      });
    }

    if (commands.length === 0) {
      throw new BlockParseError(filePath, blockLine, "verify block contains no $ commands");
    }

    blocks.push({ filePath, blockLine, commands });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecutionResult {
  readonly stdout: string;
  readonly exitCode: number;
}

function executeCommand(command: string, cwd: string): ExecutionResult {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      shell: "/bin/sh",
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    // execSync throws on non-zero exit — narrow to the shaped error it produces
    if (
      err !== null &&
      typeof err === "object" &&
      "status" in err &&
      "stdout" in err
    ) {
      const status = typeof err.status === "number" ? err.status : 1;
      const rawStdout = err.stdout;
      const stdout = typeof rawStdout === "string"
        ? rawStdout
        : rawStdout instanceof Buffer
          ? rawStdout.toString("utf-8")
          : "";
      return { stdout, exitCode: status };
    }
    return { stdout: "", exitCode: 1 };
  }
}

/**
 * Run all commands in parsed verify blocks and compare against expected output.
 * Every block runs unconditionally — a command that cannot execute is a
 * failure, never a skip.
 * @testseam check-docs.test.ts exercises checking without running the CLI
 */
export function checkBlocks(blocks: readonly VerifyBlock[], cwd: string): CheckResult {
  const failures: ClaimFailure[] = [];
  let commandsRun = 0;
  let blocksChecked = 0;

  for (const block of blocks) {
    blocksChecked++;

    for (const cmd of block.commands) {
      commandsRun++;
      const result = executeCommand(cmd.command, cwd);

      if (result.exitCode !== 0) {
        failures.push({
          filePath: block.filePath,
          blockLine: block.blockLine,
          commandLine: cmd.commandLine,
          command: cmd.command,
          expected: cmd.expectedOutput,
          actual: `exit code ${result.exitCode}${result.stdout.trim() ? "\n" + result.stdout.trim() : ""}`,
          kind: "exit-nonzero",
        });
        continue;
      }

      const actualTrimmed = result.stdout.trim();
      if (actualTrimmed !== cmd.expectedOutput) {
        failures.push({
          filePath: block.filePath,
          blockLine: block.blockLine,
          commandLine: cmd.commandLine,
          command: cmd.command,
          expected: cmd.expectedOutput,
          actual: actualTrimmed,
          kind: "mismatch",
        });
      }
    }
  }

  return { failures, commandsRun, blocksChecked };
}

// ---------------------------------------------------------------------------
// The README rules this gate implements
// ---------------------------------------------------------------------------

/**
 * Every documentation README sentence that defines what this gate checks, verbatim (whitespace
 * normalized). The gate fails when the README does not hold one of them, so neither the
 * README nor the code below can change the rule alone. Each source table below names the README
 * token it implements; check-docs.test.ts requires the tables and these clauses to agree.
 */
const README_PATH = path.join("docs", "README.md");

const SCAN_SCOPE_CLAUSE =
  "It scans `CLAUDE.md`, `.claude/commands/*.md`, `docs/*.md`, `docs/design/*.md`, `docs/decisions/*.md` " +
  "and `docs/rules/*.md`, checks §7 retention, and fails closed on no documents.";

const LIVE_RECORD_CLAUSE =
  "A **live record** is: `state.toml`, `backlog.toml`, `context.md`, `roadmap.md`, anything in `design/` " +
  "or `rules/`, an ADR body, `CLAUDE.md`, `.claude/commands/`, `.claude/workflows/`, or the auto-memory " +
  "(not `.claude/worktrees/`).";

const CITATION_CLAUSE =
  "Only a **direct** citation by its `investigations/` path from a live record keeps a file in place; one " +
  "from an index, `state-archive.toml`, `archive/` or other evidence keeps nothing (ADR-073 d15).";

const SUBDIRECTORY_CLAUSE =
  "A subdirectory of `investigations/` has one `INDEX.md` row, pointing at its entry point (`index.md` or " +
  "the file named), which ends with the same table for its other files.";

/** @testseam check-docs.test.ts requires each clause's backticked tokens to match the tables below */
export const README_CLAUSES = {
  scanScope: SCAN_SCOPE_CLAUSE,
  liveRecord: LIVE_RECORD_CLAUSE,
  citation: CITATION_CLAUSE,
  subdirectory: SUBDIRECTORY_CLAUSE,
} as const;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Document discovery
// ---------------------------------------------------------------------------

function markdownFilesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (err: unknown) {
    throw new DocumentReadError(dir, err);
  }
}

/**
 * Every document in SCAN_SOURCES that exists under `root`.
 * @testseam check-docs.test.ts exercises the scan scope on a fixture tree
 */
export function discoverDocuments(root: string): string[] {
  const docs: string[] = [];
  for (const source of SCAN_SOURCES) {
    const full = path.join(root, source.rel);
    if (source.kind === "file") {
      if (fs.existsSync(full)) docs.push(full);
    } else {
      docs.push(...markdownFilesIn(full));
    }
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

interface RetentionFailure {
  /** Repo-relative path of the offending entry, row or record, or the absolute path of a missing auto-memory */
  readonly path: string;
  readonly kind:
    | "archive-candidate"
    | "unindexed"
    | "stale-row"
    | "no-entry-point"
    | "missing-input"
    | "readme-drift";
  readonly rule: string;
}

const INVESTIGATIONS_DIR = path.join("docs", "investigations");
const INVESTIGATIONS_INDEX = path.join(INVESTIGATIONS_DIR, "INDEX.md");
const DEFAULT_ENTRY_POINT = "index.md";

/**
 * Where LIVE_RECORD_CLAUSE's live records are read from. A `file` must exist: without it, every
 * citation it holds would read as missing. A `tree` is read recursively when present. `adr` is
 * every ADR body in the decisions directory; `memory` is the auto-memory's *.md files, which must exist.
 */
type LiveRecordSource =
  | { readonly readmeName: string; readonly kind: "file" | "tree"; readonly rel: string }
  | { readonly readmeName: string; readonly kind: "adr" | "memory" };

/** @testseam check-docs.test.ts requires these, with the exclusions, to be exactly the clause's tokens */
export const LIVE_RECORD_SOURCES: readonly LiveRecordSource[] = [
  { readmeName: "`state.toml`", kind: "file", rel: path.join("docs", "state.toml") },
  { readmeName: "`backlog.toml`", kind: "file", rel: path.join("docs", "backlog.toml") },
  { readmeName: "`context.md`", kind: "file", rel: path.join("docs", "context.md") },
  { readmeName: "`roadmap.md`", kind: "file", rel: path.join("docs", "roadmap.md") },
  { readmeName: "`design/`", kind: "tree", rel: path.join("docs", "design") },
  { readmeName: "`rules/`", kind: "tree", rel: path.join("docs", "rules") },
  { readmeName: "an ADR body", kind: "adr" },
  { readmeName: "`CLAUDE.md`", kind: "file", rel: "CLAUDE.md" },
  { readmeName: "`.claude/commands/`", kind: "tree", rel: path.join(".claude", "commands") },
  { readmeName: "`.claude/workflows/`", kind: "tree", rel: path.join(".claude", "workflows") },
  { readmeName: "the auto-memory", kind: "memory" },
];

/**
 * Tokens LIVE_RECORD_CLAUSE names as not live. `.claude/worktrees/` lies outside every tree in
 * LIVE_RECORD_SOURCES, so excluding it needs no code.
 * @testseam check-docs.test.ts requires the clause's tokens to be the sources' plus these
 */
export const LIVE_RECORD_EXCLUSIONS: readonly string[] = ["`.claude/worktrees/`"];

/**
 * The checkout that holds the gitignored records (CLAUDE.md, .claude/, docs/ and its auto-memory).
 * A linked worktree has none of its own: its docs/ is a symlink to the main checkout's, so the
 * records, its .claude/workflows/ and its auto-memory among them, are those of the link target's
 * parent. Any other checkout holds its own.
 * @testseam check-docs.test.ts exercises a linked and an unlinked docs/ on a fixture tree
 */
export function recordsRoot(root: string): string {
  const docs = path.join(root, "docs");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(docs);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return root;
    throw err;
  }
  return stat.isSymbolicLink() ? path.dirname(fs.realpathSync(docs)) : root;
}

/**
 * The auto-memory directory Claude Code keeps for a checkout: `<config>/projects/<root with every
 * non-alphanumeric character replaced by "-">/memory`, where `<config>` is CLAUDE_CONFIG_DIR or ~/.claude.
 */
function autoMemoryDir(root: string): string {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", root.replace(/[^A-Za-z0-9]/g, "-"), "memory");
}

function readEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    throw new DocumentReadError(dir, err);
  }
}

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readEntries(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    throw new DocumentReadError(filePath, err);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * CITATION_CLAUSE: a citation names the entry by its investigations path, `investigations/<name>`
 * as a whole token, alone or at the end of a longer path that leads into it. A
 * subdirectory may be cited by a path into it. A bare name does not count, since a same-named file
 * elsewhere would satisfy it; nor does an `archive/` path, which names the archived copy.
 */
function citesByPath(text: string, name: string): boolean {
  const pattern = new RegExp(
    `(?<!archive/)investigations/${escapeRegExp(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
  );
  return pattern.test(text);
}

const FILE_TABLE_HEADER = /^\|\s*File\s*\|\s*Date\s*\|/;
const SEPARATOR_ROW = /^\|[\s:|-]*$/;

interface IndexRow {
  /** The first cell, without backticks, link syntax or a trailing slash */
  readonly name: string;
  readonly line: string;
}

/** Every row of the file table (the one headed `| File | Date |`). Separator rows are not rows. */
function indexRows(indexText: string): IndexRow[] {
  const rows: IndexRow[] = [];
  let inTable = false;
  for (const line of indexText.split("\n")) {
    if (FILE_TABLE_HEADER.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    if (SEPARATOR_ROW.test(line)) continue;
    const row = /^\|([^|]*)\|/.exec(line);
    if (!row) continue;
    const link = /^\s*\[([^\]]*)\]\([^)]*\)\s*$/.exec(row[1]);
    const name = (link ? link[1] : row[1]).replace(/`/g, "").trim().replace(/\/$/, "");
    if (name !== "") rows.push({ name, line });
  }
  return rows;
}

/** SUBDIRECTORY_CLAUSE: the entry point is the file the row names as "entry point `<file>`", else index.md. */
function entryPointName(row: IndexRow | undefined): string {
  const named = row ? /entry point `([^`]+)`/.exec(row.line) : null;
  return named ? named[1] : DEFAULT_ENTRY_POINT;
}

/**
 * SUBDIRECTORY_CLAUSE: the entry point exists and holds the file table, every row of that table
 * names a file that exists, and every other file in the subdirectory has a row.
 */
function checkSubdirectory(root: string, relDir: string, row: IndexRow | undefined): RetentionFailure[] {
  const dir = path.join(root, relDir);
  const entryName = entryPointName(row);
  const entryPoint = path.join(dir, entryName);
  const relEntryPoint = path.join(relDir, entryName);
  const entryText = fs.existsSync(entryPoint) ? readText(entryPoint) : null;
  if (entryText === null || !entryText.split("\n").some((line) => FILE_TABLE_HEADER.test(line))) {
    return [
      {
        path: relEntryPoint,
        kind: "no-entry-point",
        rule:
          "README section 4: the entry point (the file the INDEX.md row names, else index.md) " +
          (entryText === null ? "does not exist" : "holds no `| File | Date |` table"),
      },
    ];
  }

  const present = readEntries(dir).map((entry) => entry.name);
  const listed = new Set(indexRows(entryText).map((r) => r.name));
  const failures: RetentionFailure[] = [];
  for (const name of [...listed].sort()) {
    if (present.includes(name)) continue;
    failures.push({
      path: path.join(relDir, name),
      kind: "stale-row",
      rule: `README section 4: ${relEntryPoint} has a row for a file that does not exist`,
    });
  }
  for (const name of [...present].sort()) {
    if (name === entryName || listed.has(name)) continue;
    failures.push({
      path: path.join(relDir, name),
      kind: "unindexed",
      rule: `README section 4: this file has no row in its entry point ${relEntryPoint}`,
    });
  }
  return failures;
}

/** README sentences this gate implements that the documentation README does not hold verbatim. */
function readmeDrift(readmeText: string): RetentionFailure[] {
  const normalized = normalizeWhitespace(readmeText);
  return Object.values(README_CLAUSES)
    .filter((clause) => !normalized.includes(normalizeWhitespace(clause)))
    .map((clause) => ({
      path: README_PATH,
      kind: "readme-drift",
      rule:
        `scripts/check-docs.ts implements this sentence and ${README_PATH} no longer holds it; ` +
        `change the rule in both together: ${clause}`,
    }));
}

/**
 * The documentation README's retention rules. The README must still hold every clause in README_CLAUSES.
 * Every file or subdirectory directly under the investigations directory (INDEX.md aside) is cited by its
 * investigations path from a live record (LIVE_RECORD_SOURCES; the auto-memory is read from the
 * *.md files of `memoryDir`), else it is an archive candidate. Each entry has its own INDEX.md
 * row, every INDEX.md row names an entry that exists, and each subdirectory passes
 * checkSubdirectory. A missing README, investigations directory, index, required live record or
 * auto-memory is a failure, never an empty result; an unreadable one throws.
 * @testseam check-docs.test.ts exercises retention on a fixture tree
 */
export function checkRetention(root: string, memoryDir: string): RetentionFailure[] {
  const missing: RetentionFailure[] = [];
  const requiredFiles = LIVE_RECORD_SOURCES.flatMap((source) => (source.kind === "file" ? [source.rel] : []));
  for (const required of [README_PATH, INVESTIGATIONS_DIR, INVESTIGATIONS_INDEX, ...requiredFiles]) {
    if (!fs.existsSync(path.join(root, required))) {
      missing.push({
        path: required,
        kind: "missing-input",
        rule: "README section 7: the retention check reads this record and it is absent",
      });
    }
  }
  if (!fs.existsSync(memoryDir)) {
    missing.push({
      path: memoryDir,
      kind: "missing-input",
      rule: "README section 7: the auto-memory is a live record and its directory is absent",
    });
  }
  if (missing.length > 0) return missing;

  const memoryFiles = readEntries(memoryDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(memoryDir, entry.name));
  if (memoryFiles.length === 0) {
    return [
      {
        path: memoryDir,
        kind: "missing-input",
        rule: "README section 7: the auto-memory is a live record and its directory holds no *.md file",
      },
    ];
  }

  const liveFiles = LIVE_RECORD_SOURCES.flatMap((source): string[] => {
    switch (source.kind) {
      case "file":
        return [path.join(root, source.rel)];
      case "tree": {
        const dir = path.join(root, source.rel);
        return fs.existsSync(dir) ? filesUnder(dir) : [];
      }
      case "adr":
        return markdownFilesIn(path.join(root, "docs", "decisions")).filter((f) =>
          path.basename(f).startsWith("ADR-"),
        );
      case "memory":
        return memoryFiles;
    }
  });
  const liveTexts = liveFiles.map(readText);
  const rows = indexRows(readText(path.join(root, INVESTIGATIONS_INDEX)));
  const entries = readEntries(path.join(root, INVESTIGATIONS_DIR));

  const failures = readmeDrift(readText(path.join(root, README_PATH)));
  const indexName = path.basename(INVESTIGATIONS_INDEX);
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === indexName) continue;
    const isDir = entry.isDirectory();
    const rel = path.join(INVESTIGATIONS_DIR, entry.name) + (isDir ? "/" : "");
    const unit = isDir ? "subdirectory" : "file";
    const row = rows.find((r) => r.name === entry.name);

    if (!liveTexts.some((text) => citesByPath(text, entry.name))) {
      failures.push({
        path: rel,
        kind: "archive-candidate",
        rule: `README section 7: no live record cites this ${unit} by its investigations/ path`,
      });
    }
    if (row === undefined) {
      failures.push({
        path: rel,
        kind: "unindexed",
        rule: `README section 4: this ${unit} has no row of its own in ${INVESTIGATIONS_INDEX}`,
      });
    }
    if (isDir) failures.push(...checkSubdirectory(root, path.join(INVESTIGATIONS_DIR, entry.name), row));
  }

  const present = new Set(entries.map((entry) => entry.name));
  for (const { name } of rows) {
    if (present.has(name)) continue;
    failures.push({
      path: path.join(INVESTIGATIONS_DIR, name),
      kind: "stale-row",
      rule: `README section 4: ${INVESTIGATIONS_INDEX} has a row for an entry that does not exist`,
    });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function formatMultiline(label: string, value: string, labelWidth: number): string {
  if (value.includes("\n")) {
    return `${label}${" ".repeat(labelWidth - label.length)}\n${indent(value, labelWidth)}`;
  }
  return `${label}${" ".repeat(labelWidth - label.length)}${value}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // The repo root is the working directory (`just` runs recipes from the justfile's
  // directory), so the script can check a checkout other than the one it lives in. Verify
  // commands run against that checkout's code; the records are read from recordsRoot.
  const root = process.cwd();

  let records: string;
  let documents: string[];
  let retentionFailures: RetentionFailure[];
  try {
    records = recordsRoot(root);
    documents = discoverDocuments(records);
    retentionFailures = checkRetention(records, autoMemoryDir(records));
  } catch (err: unknown) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: the operator script exits 1 below with the error's chain
    console.error(`\nERROR: ${describeErrorChain(err)}\n`);
    process.exit(1);
  }

  if (documents.length === 0) {
    console.error("\nERROR: No documents found to scan\n");
    process.exit(1);
  }

  const allBlocks: VerifyBlock[] = [];
  const parseFailures: ClaimFailure[] = [];

  for (const docPath of documents) {
    const relPath = path.relative(records, docPath);
    let content: string;
    try {
      content = fs.readFileSync(docPath, "utf-8");
    } catch (err: unknown) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the unreadable file is kept as a failure, which fails the gate
      parseFailures.push({
        filePath: relPath,
        blockLine: 0,
        commandLine: 0,
        command: "(read file)",
        expected: "(readable)",
        actual: describeErrorChain(err),
        kind: "unreadable",
      });
      continue;
    }

    try {
      allBlocks.push(...parseVerifyBlocks(content, relPath));
    } catch (err: unknown) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: a parse error is kept as a failure, which fails the gate; any other error is rethrown
      if (err instanceof BlockParseError) {
        parseFailures.push({
          filePath: err.filePath,
          blockLine: err.lineNumber,
          commandLine: err.lineNumber,
          command: "(parse)",
          expected: "(valid verify block)",
          actual: err.reason,
          kind: "parse-error",
        });
      } else {
        parseFailures.push({
          filePath: relPath,
          blockLine: 0,
          commandLine: 0,
          command: "(parse)",
          expected: "(valid document)",
          actual: describeErrorChain(err),
          kind: "parse-error",
        });
      }
    }
  }

  const { failures: execFailures, commandsRun, blocksChecked } = checkBlocks(allBlocks, root);

  const failures = [...parseFailures, ...execFailures];

  if (failures.length > 0) {
    console.error("\nExecutable-claims failures:\n");
    for (const f of failures) {
      console.error(`  ${f.filePath}:${f.commandLine}  [${f.kind}]`);
      console.error(`    ${formatMultiline("command:  $ ", f.command, 14)}`);
      console.error(`    ${formatMultiline("expected: ", f.expected, 14)}`);
      console.error(`    ${formatMultiline("actual:   ", f.actual, 14)}`);
      console.error();
    }
  }

  if (retentionFailures.length > 0) {
    console.error("\nRetention failures (docs/README.md sections 4 and 7):\n");
    for (const f of retentionFailures) {
      console.error(`  ${f.path}  [${f.kind}]`);
      console.error(`    ${f.rule}`);
    }
    console.error();
  }

  const summary =
    `${documents.length} documents scanned, ${blocksChecked} blocks checked, ` +
    `${commandsRun} commands run, ${failures.length} claims failed, ` +
    `${retentionFailures.length} retention failures`;

  if (failures.length > 0 || retentionFailures.length > 0) {
    console.error(`${summary}\n`);
    process.exit(1);
  }

  console.log(`\nAll claims verified and every investigation retained. ${summary}.\n`);
}

// Direct execution guard — when imported by tests, main() does not run
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}
