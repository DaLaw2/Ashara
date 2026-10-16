import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkBlocks, checkRetention, discoverDocuments, parseVerifyBlocks } from "./check-docs.js";

let root = "";

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function liveRecords(): void {
  write("CLAUDE.md", "# rules\n");
  write("docs/state.toml", "");
  write("docs/backlog.toml", "");
  write("docs/context.md", "");
  write("docs/roadmap.md", "");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("discoverDocuments", () => {
  test("scans docs/rules alongside the other scopes, and nothing under investigations", () => {
    liveRecords();
    write("docs/rules/enforcement.md", "");
    write("docs/rules/notes.txt", "");
    write("docs/decisions/ADR-001-x.md", "");
    write("docs/investigations/run-2026-10-16.md", "");
    const found = discoverDocuments(root).map((f) => path.relative(root, f));
    expect(found).toContain(path.join("docs", "rules", "enforcement.md"));
    expect(found).toContain(path.join("docs", "decisions", "ADR-001-x.md"));
    expect(found).not.toContain(path.join("docs", "rules", "notes.txt"));
    expect(found.some((f) => f.includes("investigations"))).toBe(false);
  });

  test("an empty tree yields zero documents", () => {
    expect(discoverDocuments(root)).toEqual([]);
  });
});

describe("checkRetention", () => {
  const index = (rows: string[]): string =>
    ["| File | Date | Description | Cited by |", "|---|---|---|---|", ...rows].join("\n");

  test("a cited and indexed file and subdirectory pass", () => {
    liveRecords();
    write("docs/context.md", "See `docs/investigations/run-2026-10-16.md` §2.");
    write("docs/rules/records.md", "Entry point: docs/investigations/review-2026-10-15/index.md");
    write("docs/investigations/run-2026-10-16.md", "");
    write("docs/investigations/review-2026-10-15/index.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `run-2026-10-16.md` | x | x | x |", "| `review-2026-10-15/` | x | x | x |"]),
    );
    expect(checkRetention(root)).toEqual([]);
  });

  test("an uncited file is an archive candidate; citations from evidence or archive paths keep nothing", () => {
    liveRecords();
    write("docs/roadmap.md", "Moved to docs/archive/old-2026-10-01.md");
    write("docs/investigations/other-2026-10-02.md", "Cites old-2026-10-01.md");
    write("docs/state-archive.toml", "old-2026-10-01.md");
    write("docs/investigations/old-2026-10-01.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `old-2026-10-01.md` | x | x | x |", "| `other-2026-10-02.md` | x | x | x |"]),
    );
    const failures = checkRetention(root);
    expect(failures.map((f) => [f.path, f.kind])).toEqual([
      [path.join("docs", "investigations", "old-2026-10-01.md"), "archive-candidate"],
      [path.join("docs", "investigations", "other-2026-10-02.md"), "archive-candidate"],
    ]);
  });

  test("a name embedded in a longer name is not a citation", () => {
    liveRecords();
    write("CLAUDE.md", "see run-2026-10-16.md.bak and prerun-2026-10-16.md");
    write("docs/investigations/run-2026-10-16.md", "");
    write("docs/investigations/INDEX.md", index(["| `run-2026-10-16.md` | x | x | x |"]));
    expect(checkRetention(root).map((f) => f.kind)).toEqual(["archive-candidate"]);
  });

  test("a cited file without its own index row is unindexed, even if INDEX.md mentions it elsewhere", () => {
    liveRecords();
    write("docs/decisions/ADR-002-y.md", "Decided on run-2026-10-16.md and review-2026-10-15/.");
    write("docs/investigations/run-2026-10-16.md", "");
    write("docs/investigations/review-2026-10-15/index.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `other.md` | x | mentions run-2026-10-16.md | x |"]),
    );
    expect(checkRetention(root).map((f) => [f.path, f.kind])).toEqual([
      [path.join("docs", "investigations", "review-2026-10-15") + "/", "unindexed"],
      [path.join("docs", "investigations", "run-2026-10-16.md"), "unindexed"],
    ]);
  });

  test("an uncited subdirectory is one archive candidate, not one per file", () => {
    liveRecords();
    write("docs/investigations/review-2026-10-15/a.md", "");
    write("docs/investigations/review-2026-10-15/b.md", "");
    write("docs/investigations/INDEX.md", index(["| `review-2026-10-15/` | x | x | x |"]));
    expect(checkRetention(root)).toEqual([
      {
        path: path.join("docs", "investigations", "review-2026-10-15") + "/",
        kind: "archive-candidate",
        rule: "README section 7: no live record cites this subdirectory by name",
      },
    ]);
  });

  test("citations in .claude workflows and the decisions index are told apart", () => {
    liveRecords();
    write(".claude/workflows/dev.js", "// evidence: kept-2026-10-03.md");
    write("docs/decisions/index.md", "| 001 | x | [ADR-001](f) | dropped-2026-10-04.md | x |");
    write("docs/investigations/kept-2026-10-03.md", "");
    write("docs/investigations/dropped-2026-10-04.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `kept-2026-10-03.md` | x | x | x |", "| [dropped-2026-10-04.md](dropped-2026-10-04.md) | x | x | x |"]),
    );
    expect(checkRetention(root).map((f) => [f.path, f.kind])).toEqual([
      [path.join("docs", "investigations", "dropped-2026-10-04.md"), "archive-candidate"],
    ]);
  });

  test("missing inputs fail closed instead of reporting nothing", () => {
    const failures = checkRetention(root);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.kind === "missing-input")).toBe(true);
    expect(failures.map((f) => f.path)).toContain(path.join("docs", "investigations", "INDEX.md"));
  });
});

describe("parseVerifyBlocks", () => {
  test("extracts a single command with expected output", () => {
    const doc = "```verify\n$ echo hello\nhello\n```";
    const blocks = parseVerifyBlocks(doc, "test.md");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].commands).toHaveLength(1);
    expect(blocks[0].commands[0].command).toBe("echo hello");
    expect(blocks[0].commands[0].expectedOutput).toBe("hello");
    expect(blocks[0].blockLine).toBe(1);
  });

  test("supports multiple commands in one block", () => {
    const doc = "```verify\n$ echo a\na\n$ echo b\nb\n```";
    const blocks = parseVerifyBlocks(doc, "test.md");
    expect(blocks[0].commands).toHaveLength(2);
    expect(blocks[0].commands[1].command).toBe("echo b");
  });

  test("throws on any annotation, including the removed requires=db", () => {
    const doc = "```verify requires=db\n$ echo ok\nok\n```";
    expect(() => parseVerifyBlocks(doc, "test.md")).toThrow("unknown annotation");
  });

  test("throws on unclosed block", () => {
    const doc = "```verify\n$ echo ok\nok";
    expect(() => parseVerifyBlocks(doc, "test.md")).toThrow("block never closed");
  });

  test("throws on empty block with no commands", () => {
    const doc = "```verify\n```";
    expect(() => parseVerifyBlocks(doc, "test.md")).toThrow("no $ commands");
  });

  test("throws on non-empty line before any command", () => {
    const doc = "```verify\nstray text\n$ echo ok\nok\n```";
    expect(() => parseVerifyBlocks(doc, "test.md")).toThrow("non-empty line before any $ command");
  });

  test("ignores non-verify fenced blocks", () => {
    const doc = "```typescript\nconst x = 1;\n```\n```verify\n$ echo yes\nyes\n```";
    const blocks = parseVerifyBlocks(doc, "test.md");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].commands[0].command).toBe("echo yes");
  });

  test("records correct line numbers from surrounding content", () => {
    const doc = "# Title\n\nSome text.\n\n```verify\n$ echo line5\nline5\n```";
    const blocks = parseVerifyBlocks(doc, "test.md");
    expect(blocks[0].blockLine).toBe(5);
    expect(blocks[0].commands[0].commandLine).toBe(6);
  });
});

describe("checkBlocks", () => {
  test("matching claim passes", () => {
    const blocks = parseVerifyBlocks("```verify\n$ echo hello\nhello\n```", "test.md");
    const result = checkBlocks(blocks, process.cwd());
    expect(result.failures).toHaveLength(0);
    expect(result.commandsRun).toBe(1);
  });

  test("drifted claim fails and names file and line", () => {
    const blocks = parseVerifyBlocks("```verify\n$ echo hello\ngoodbye\n```", "test.md");
    const result = checkBlocks(blocks, process.cwd());
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].filePath).toBe("test.md");
    expect(result.failures[0].blockLine).toBe(1);
    expect(result.failures[0].commandLine).toBe(2);
    expect(result.failures[0].kind).toBe("mismatch");
    expect(result.failures[0].expected).toBe("goodbye");
    expect(result.failures[0].actual).toBe("hello");
  });

  test("non-zero exit command fails", () => {
    const blocks = parseVerifyBlocks("```verify\n$ false\n\n```", "test.md");
    const result = checkBlocks(blocks, process.cwd());
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].kind).toBe("exit-nonzero");
  });

  test("multi-line expected output compared correctly", () => {
    const doc = "```verify\n$ printf 'a\\nb\\nc'\na\nb\nc\n```";
    const blocks = parseVerifyBlocks(doc, "test.md");
    const result = checkBlocks(blocks, process.cwd());
    expect(result.failures).toHaveLength(0);
  });
});
