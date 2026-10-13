import { describe, expect, test } from "vitest";
import { parseVerifyBlocks, checkBlocks } from "./check-docs.js";

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
