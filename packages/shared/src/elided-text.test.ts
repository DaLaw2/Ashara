import { describe, expect, it } from "vitest";
import { cutText, joinElided, keepEnds, renderElided, wholeText } from "./elided-text.js";

describe("keepEnds", () => {
  it("leaves a text within the limit unchanged", () => {
    expect(cutText("abcdefghij", 10)).toBe("abcdefghij");
  });

  it("keeps the head and the larger tail of a long text, with a marker counting exactly the characters cut", () => {
    const text = `${"H".repeat(40)}${"m".repeat(900)}${"T".repeat(60)}`;
    expect(cutText(text, 100)).toBe(`${"H".repeat(40)}\n[truncated by Ashara: 900 characters cut here]\n${"T".repeat(60)}`);
  });

  it("keeps a failure summary at the very end of a long build log", () => {
    const cut = cutText(`${"compiling...\n".repeat(5000)}FAILED: 3 tests failed`, 1000);
    expect(cut.startsWith("compiling...")).toBe(true);
    expect(cut.endsWith("FAILED: 3 tests failed")).toBe(true);
  });

  it("counts an earlier cut together with its own when it cuts again", () => {
    // What an output cap kept of 4,000,000 characters: 400 from the start, 600 from the end.
    const capped = joinElided([wholeText("a".repeat(400)), [{ kind: "cut", chars: 3_999_000 }], wholeText("z".repeat(600))]);
    expect(keepEnds(capped, 100)).toEqual([
      { kind: "kept", text: "a".repeat(40) },
      { kind: "cut", chars: 4_000_000 - 100 },
      { kind: "kept", text: "z".repeat(60) },
    ]);
  });

  it("keeps an earlier cut that lies inside what it keeps, so every place text is missing is marked", () => {
    const text = joinElided([wholeText("ab"), [{ kind: "cut", chars: 7 }], wholeText("c".repeat(20))]);
    expect(renderElided(keepEnds(text, 10))).toBe(
      `ab\n[truncated by Ashara: 7 characters cut here]\ncc\n[truncated by Ashara: 12 characters cut here]\n${"c".repeat(6)}`,
    );
  });
});
