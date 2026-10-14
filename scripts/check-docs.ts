/**
 * Executable-claims gate.
 *
 * Finds every ```verify block in the scan scope set by docs/README.md section 9 —
 * CLAUDE.md, .claude/commands/*.md, docs/*.md, docs/design/*.md and
 * docs/decisions/*.md — runs each command from the repo root, and compares trimmed stdout against
 * the recorded expected output. A mismatch, a non-zero exit, an unreadable
 * document, or an unparseable block is a failure. Exit non-zero on any failure.
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
      .map((entry) => path.join(dir, entry.name));
  } catch (err: unknown) {
    throw new DocumentReadError(dir, err);
  }
}

// Scan scope is docs/README.md section 9. investigations/ and archive/ are dated
// observations that never hold verify blocks, so they are deliberately excluded.
function discoverDocuments(root: string): string[] {
  const docs: string[] = [];

  const claudeMd = path.join(root, "CLAUDE.md");
  if (fs.existsSync(claudeMd)) docs.push(claudeMd);

  for (const dir of [
    path.join(root, ".claude", "commands"),
    path.join(root, "docs"),
    path.join(root, "docs", "design"),
    path.join(root, "docs", "decisions"),
  ]) {
    docs.push(...markdownFilesIn(dir));
  }

  return docs;
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
  const root = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "..",
  );

  let documents: string[];
  try {
    documents = discoverDocuments(root);
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
    console.error(
      `${documents.length} documents scanned, ${blocksChecked} blocks checked, ` +
        `${commandsRun} commands run, ${failures.length} failed\n`,
    );
    process.exit(1);
  }

  console.log(
    `\nAll claims verified. ${documents.length} documents scanned, ` +
      `${blocksChecked} blocks checked, ${commandsRun} commands passed.\n`,
  );
}

// Direct execution guard — when imported by tests, main() does not run
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main();
}
