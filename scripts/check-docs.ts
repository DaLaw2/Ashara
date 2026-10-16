/**
 * Executable-claims gate.
 *
 * Finds every ```verify block in the scan scope set by docs/README.md section 9 —
 * CLAUDE.md, .claude/commands/*.md, docs/*.md, docs/design/*.md,
 * docs/decisions/*.md and docs/rules/*.md — runs each command from the repo root, and compares
 * trimmed stdout against the recorded expected output. A mismatch, a non-zero exit, an unreadable
 * document, or an unparseable block is a failure. Zero documents found is a failure.
 *
 * Also enforces docs/README.md section 7 on docs/investigations/: every entry there is
 * cited by name from a live record (else an archive candidate) and has its INDEX.md row.
 * Exit non-zero on any failure.
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeErrorChain } from "@ashara/shared";

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
 * The verify-block scan scope of docs/README.md section 9, plus docs/rules/*.md, which
 * holds rules split out of CLAUDE.md together with their verify blocks.
 * investigations/ and archive/ are dated observations that never hold verify blocks,
 * so they are deliberately excluded.
 * @testseam check-docs.test.ts exercises the scan scope on a fixture tree
 */
export function discoverDocuments(root: string): string[] {
  const docs: string[] = [];

  const claudeMd = path.join(root, "CLAUDE.md");
  if (fs.existsSync(claudeMd)) docs.push(claudeMd);

  for (const dir of [
    path.join(root, ".claude", "commands"),
    path.join(root, "docs"),
    path.join(root, "docs", "design"),
    path.join(root, "docs", "decisions"),
    path.join(root, "docs", "rules"),
  ]) {
    docs.push(...markdownFilesIn(dir));
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Retention (docs/README.md section 7)
// ---------------------------------------------------------------------------

interface RetentionFailure {
  /** Repo-relative path of the offending entry or of the missing input */
  readonly path: string;
  readonly kind: "archive-candidate" | "unindexed" | "missing-input";
  readonly rule: string;
}

const INVESTIGATIONS_DIR = path.join("docs", "investigations");
const INVESTIGATIONS_INDEX = path.join(INVESTIGATIONS_DIR, "INDEX.md");

/** Live records that must exist: without one, every citation it holds would read as missing. */
const REQUIRED_LIVE_FILES = [
  "CLAUDE.md",
  path.join("docs", "state.toml"),
  path.join("docs", "backlog.toml"),
  path.join("docs", "context.md"),
  path.join("docs", "roadmap.md"),
];

/** Live-record directories, every file in them read recursively. */
const LIVE_TREES = [
  path.join("docs", "design"),
  path.join("docs", "rules"),
  path.join(".claude", "commands"),
  path.join(".claude", "workflows"),
];

function filesUnder(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    throw new DocumentReadError(dir, err);
  }
  const files: string[] = [];
  for (const entry of entries) {
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
 * A citation by name is the entry's name as a whole token. A path prefix such as
 * `docs/investigations/` is allowed and a subdirectory may be cited by a path into it;
 * an `archive/` prefix is not, since that names the archived copy, not the evidence here.
 */
function citesByName(text: string, name: string): boolean {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_.-])(?<!archive/)${escapeRegExp(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
  );
  return pattern.test(text);
}

/** The first cell of every Markdown table row, without backticks, link syntax or a trailing slash. */
function indexedNames(indexText: string): Set<string> {
  const names = new Set<string>();
  for (const line of indexText.split("\n")) {
    const row = /^\|([^|]*)\|/.exec(line);
    if (!row) continue;
    const link = /^\s*\[([^\]]*)\]\([^)]*\)\s*$/.exec(row[1]);
    const cell = (link ? link[1] : row[1]).replace(/`/g, "").trim().replace(/\/$/, "");
    if (cell !== "") names.add(cell);
  }
  return names;
}

/**
 * docs/README.md section 7: every file or subdirectory directly under docs/investigations/
 * (INDEX.md aside) is cited by name from a live record, else it is an archive candidate;
 * and section 4: each has its own INDEX.md row (a subdirectory: one row). A missing
 * investigations directory, index or required live record is a failure, never an empty result.
 * @testseam check-docs.test.ts exercises retention on a fixture tree
 */
export function checkRetention(root: string): RetentionFailure[] {
  const missing: RetentionFailure[] = [];
  for (const required of [INVESTIGATIONS_DIR, INVESTIGATIONS_INDEX, ...REQUIRED_LIVE_FILES]) {
    if (!fs.existsSync(path.join(root, required))) {
      missing.push({
        path: required,
        kind: "missing-input",
        rule: "README section 7: the retention check reads this record and it is absent",
      });
    }
  }
  if (missing.length > 0) return missing;

  const liveFiles = REQUIRED_LIVE_FILES.map((rel) => path.join(root, rel));
  liveFiles.push(
    ...markdownFilesIn(path.join(root, "docs", "decisions")).filter((f) =>
      path.basename(f).startsWith("ADR-"),
    ),
  );
  for (const tree of LIVE_TREES) {
    const dir = path.join(root, tree);
    if (fs.existsSync(dir)) liveFiles.push(...filesUnder(dir));
  }
  const liveTexts = liveFiles.map(readText);
  const indexed = indexedNames(readText(path.join(root, INVESTIGATIONS_INDEX)));

  const investigationsDir = path.join(root, INVESTIGATIONS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(investigationsDir, { withFileTypes: true });
  } catch (err: unknown) {
    throw new DocumentReadError(investigationsDir, err);
  }

  const failures: RetentionFailure[] = [];
  const indexName = path.basename(INVESTIGATIONS_INDEX);
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === indexName) continue;
    const isDir = entry.isDirectory();
    const rel = path.join(INVESTIGATIONS_DIR, entry.name) + (isDir ? "/" : "");
    const unit = isDir ? "subdirectory" : "file";

    if (!liveTexts.some((text) => citesByName(text, entry.name))) {
      failures.push({
        path: rel,
        kind: "archive-candidate",
        rule: `README section 7: no live record cites this ${unit} by name`,
      });
    }
    if (!indexed.has(entry.name)) {
      failures.push({
        path: rel,
        kind: "unindexed",
        rule: `README section 4: this ${unit} has no row of its own in ${INVESTIGATIONS_INDEX}`,
      });
    }
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
  // directory), so the script can check a checkout other than the one it lives in.
  const root = process.cwd();

  let documents: string[];
  let retentionFailures: RetentionFailure[];
  try {
    documents = discoverDocuments(root);
    retentionFailures = checkRetention(root);
  } catch (err: unknown) {
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
    const relPath = path.relative(root, docPath);
    let content: string;
    try {
      content = fs.readFileSync(docPath, "utf-8");
    } catch (err: unknown) {
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
