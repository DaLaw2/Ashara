import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkBlocks,
  checkRetention,
  discoverDocuments,
  LIVE_RECORD_EXCLUSIONS,
  LIVE_RECORD_SOURCES,
  parseVerifyBlocks,
  README_CLAUSES,
  SCAN_SOURCES,
} from "./check-docs.js";

let root = "";

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const readme = (): string =>
  ["# docs", "", ...Object.values(README_CLAUSES).map((clause) => clause.replace(/ (\S+ \S+ \S+)$/, "\n$1"))].join(
    "\n\n",
  );

function backticked(text: string): string[] {
  return [...text.matchAll(/`[^`]+`/g)].map((m) => m[0]).sort();
}

function liveRecords(): void {
  write("docs/README.md", readme());
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
    ["# index", "", "| File | Date | Description | Cited by |", "|---|---|---|---|", ...rows, "", "Trailing prose."].join(
      "\n",
    );
  const memory = (): string => path.join(root, "memory");
  const check = (): ReturnType<typeof checkRetention> => checkRetention(root, memory());
  const kinds = (): Array<[string, string]> => check().map((f) => [f.path, f.kind]);

  beforeEach(() => {
    write("memory/MEMORY.md", "- [Profile](user.md)\n");
  });

  test("a cited and indexed file and subdirectory pass", () => {
    liveRecords();
    write("docs/context.md", "See `docs/investigations/run-2026-10-16.md` §2.");
    write("docs/rules/records.md", "Entry point: docs/investigations/review-2026-10-15/index.md");
    write("docs/investigations/run-2026-10-16.md", "");
    write("docs/investigations/review-2026-10-15/index.md", index(["| `a.md` | x | x | x |"]));
    write("docs/investigations/review-2026-10-15/a.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `run-2026-10-16.md` | x | x | x |", "| `review-2026-10-15/` | x | x | x |"]),
    );
    expect(check()).toEqual([]);
  });

  test("the auto-memory is a live record", () => {
    liveRecords();
    write("memory/feedback.md", "Evidence: investigations/mem-2026-10-05.md");
    write("docs/investigations/mem-2026-10-05.md", "");
    write("docs/investigations/INDEX.md", index(["| `mem-2026-10-05.md` | x | x | x |"]));
    expect(check()).toEqual([]);
  });

  test("an absent or empty auto-memory fails closed", () => {
    liveRecords();
    write("docs/investigations/INDEX.md", index([]));
    expect(checkRetention(root, path.join(root, "nowhere"))).toEqual([
      expect.objectContaining({ path: path.join(root, "nowhere"), kind: "missing-input" }),
    ]);
    fs.rmSync(path.join(root, "memory", "MEMORY.md"));
    expect(check().map((f) => f.kind)).toEqual(["missing-input"]);
  });

  test("an unreadable auto-memory throws instead of counting as empty", () => {
    liveRecords();
    write("docs/investigations/INDEX.md", index([]));
    write("memory-file", "");
    expect(() => checkRetention(root, path.join(root, "memory-file"))).toThrow(/Cannot read/);
  });

  test("a bare name, an archive path or an evidence citation keeps nothing", () => {
    liveRecords();
    write("CLAUDE.md", "see bare-2026-10-01.md and docs/archive/investigations/old-2026-10-01.md");
    write("docs/roadmap.md", "Moved to docs/archive/old-2026-10-01.md");
    write("docs/investigations/other-2026-10-02.md", "Cites investigations/old-2026-10-01.md");
    write("docs/state-archive.toml", "docs/investigations/old-2026-10-01.md");
    write("docs/investigations/old-2026-10-01.md", "");
    write("docs/investigations/bare-2026-10-01.md", "");
    write(
      "docs/investigations/INDEX.md",
      index([
        "| `bare-2026-10-01.md` | x | x | x |",
        "| `old-2026-10-01.md` | x | x | x |",
        "| `other-2026-10-02.md` | x | x | x |",
      ]),
    );
    expect(kinds()).toEqual([
      [path.join("docs", "investigations", "bare-2026-10-01.md"), "archive-candidate"],
      [path.join("docs", "investigations", "old-2026-10-01.md"), "archive-candidate"],
      [path.join("docs", "investigations", "other-2026-10-02.md"), "archive-candidate"],
    ]);
  });

  test("a name embedded in a longer name is not a citation", () => {
    liveRecords();
    write("CLAUDE.md", "see investigations/run-2026-10-16.md.bak and investigations/prerun-2026-10-16.md");
    write("docs/investigations/run-2026-10-16.md", "");
    write("docs/investigations/INDEX.md", index(["| `run-2026-10-16.md` | x | x | x |"]));
    expect(check().map((f) => f.kind)).toEqual(["archive-candidate"]);
  });

  test("a cited entry without its own index row is unindexed, even if INDEX.md mentions it elsewhere", () => {
    liveRecords();
    write(
      "docs/decisions/ADR-002-y.md",
      "Decided on investigations/run-2026-10-16.md and investigations/review-2026-10-15/.",
    );
    write("docs/investigations/run-2026-10-16.md", "");
    write("docs/investigations/other.md", "");
    write("docs/investigations/review-2026-10-15/index.md", index([]));
    write("docs/investigations/INDEX.md", index(["| `other.md` | x | mentions run-2026-10-16.md | x |"]));
    expect(kinds()).toEqual([
      [path.join("docs", "investigations", "other.md"), "archive-candidate"],
      [path.join("docs", "investigations", "review-2026-10-15") + "/", "unindexed"],
      [path.join("docs", "investigations", "run-2026-10-16.md"), "unindexed"],
    ]);
  });

  test("an uncited subdirectory is one archive candidate, not one per file", () => {
    liveRecords();
    write("docs/investigations/review-2026-10-15/a.md", index(["| `b.md` | x | x | x |"]));
    write("docs/investigations/review-2026-10-15/b.md", "");
    write("docs/investigations/INDEX.md", index(["| `review-2026-10-15/` | x | entry point `a.md` | x |"]));
    expect(check()).toEqual([
      {
        path: path.join("docs", "investigations", "review-2026-10-15") + "/",
        kind: "archive-candidate",
        rule: "README section 7: no live record cites this subdirectory by its investigations/ path",
      },
    ]);
  });

  test("an INDEX.md row or an entry-point row for an absent file is stale", () => {
    liveRecords();
    write("CLAUDE.md", "investigations/kept.md investigations/sub/");
    write("docs/investigations/kept.md", "");
    write("docs/investigations/sub/index.md", index(["| `a.md` | x | x | x |", "|---|---|---|---|", "| `gone.md` | x | x | x |"]));
    write("docs/investigations/sub/a.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `kept.md` | x | x | x |", "| `sub/` | x | x | x |", "| [moved.md](moved.md) | x | x | x |"]),
    );
    expect(kinds()).toEqual([
      [path.join("docs", "investigations", "sub", "gone.md"), "stale-row"],
      [path.join("docs", "investigations", "moved.md"), "stale-row"],
    ]);
  });

  test("the entry point is the file the row names, else index.md, and must hold the file table", () => {
    liveRecords();
    write("CLAUDE.md", "investigations/named/ investigations/plain/ investigations/tableless/");
    write("docs/investigations/named/index.md", index([]));
    write("docs/investigations/plain/brief.md", index([]));
    write("docs/investigations/tableless/index.md", "# no table\n");
    write(
      "docs/investigations/INDEX.md",
      index([
        "| `named/` | x | entry point `brief.md`, which lists every file | x |",
        "| `plain/` | x | x | x |",
        "| `tableless/` | x | x | x |",
      ]),
    );
    expect(kinds()).toEqual([
      [path.join("docs", "investigations", "named", "brief.md"), "no-entry-point"],
      [path.join("docs", "investigations", "plain", "index.md"), "no-entry-point"],
      [path.join("docs", "investigations", "tableless", "index.md"), "no-entry-point"],
    ]);
  });

  test("a subdirectory file without a row in its entry point is unindexed", () => {
    liveRecords();
    write("CLAUDE.md", "investigations/sub/");
    write("docs/investigations/sub/index.md", index(["| `a.md` | x | x | x |"]));
    write("docs/investigations/sub/a.md", "");
    write("docs/investigations/sub/b.md", "");
    write("docs/investigations/INDEX.md", index(["| `sub/` | x | x | x |"]));
    expect(kinds()).toEqual([[path.join("docs", "investigations", "sub", "b.md"), "unindexed"]]);
  });

  test("citations in .claude workflows and the decisions index are told apart", () => {
    liveRecords();
    write(".claude/workflows/dev.js", "// evidence: docs/investigations/kept-2026-10-03.md");
    write("docs/decisions/index.md", "| 001 | x | [ADR-001](f) | investigations/dropped-2026-10-04.md | x |");
    write("docs/investigations/kept-2026-10-03.md", "");
    write("docs/investigations/dropped-2026-10-04.md", "");
    write(
      "docs/investigations/INDEX.md",
      index(["| `kept-2026-10-03.md` | x | x | x |", "| [dropped-2026-10-04.md](dropped-2026-10-04.md) | x | x | x |"]),
    );
    expect(kinds()).toEqual([
      [path.join("docs", "investigations", "dropped-2026-10-04.md"), "archive-candidate"],
    ]);
  });

  test("a README that no longer holds a clause the gate implements is drift", () => {
    liveRecords();
    write("docs/investigations/INDEX.md", index([]));
    write("docs/README.md", readme().replace("auto-memory", "wiki"));
    expect(check()).toEqual([
      expect.objectContaining({ path: path.join("docs", "README.md"), kind: "readme-drift" }),
    ]);
    expect(check()[0].rule).toContain(README_CLAUSES.liveRecord);
  });

  test("missing inputs fail closed instead of reporting nothing", () => {
    const failures = check();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.kind === "missing-input")).toBe(true);
    expect(failures.map((f) => f.path)).toContain(path.join("docs", "investigations", "INDEX.md"));
  });
});

describe("the README clauses and the tables that implement them", () => {
  test("the scan sources are exactly the tokens of the scan-scope clause", () => {
    expect(SCAN_SOURCES.map((s) => s.readmeName).sort()).toEqual(
      backticked(README_CLAUSES.scanScope.split(", checks")[0]),
    );
  });

  test("the live-record sources and exclusions are exactly the live-record clause's names", () => {
    const names = LIVE_RECORD_SOURCES.map((s) => s.readmeName);
    for (const name of names) expect(README_CLAUSES.liveRecord).toContain(name);
    expect([...names.filter((n) => n.startsWith("`")), ...LIVE_RECORD_EXCLUSIONS].sort()).toEqual(
      backticked(README_CLAUSES.liveRecord),
    );
    expect(README_CLAUSES.liveRecord.replace(/`[^`]+`/g, "").match(/an ADR body|the auto-memory/g)).toEqual(
      names.filter((n) => !n.startsWith("`")),
    );
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
