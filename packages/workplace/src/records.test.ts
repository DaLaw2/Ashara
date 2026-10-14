import { describe, expect, it } from "vitest";
import { joinElided, wholeText } from "@ashara/shared";
import { truncateElided, truncateText } from "./records.js";

describe("truncateText", () => {
  it("returns text within the bound unchanged", () => {
    expect(truncateText("abcdefghij")).toBe("abcdefghij");
  });

  it("keeps 12,000 characters of the head and 18,000 of the tail, and counts the rest", () => {
    const cut = truncateText(`${"H".repeat(12_000)}${"m".repeat(70_000)}${"T".repeat(18_000)}`);
    expect(cut).toBe(`${"H".repeat(12_000)}\n[truncated by Ashara: 70000 characters cut here]\n${"T".repeat(18_000)}`);
  });
});

describe("truncateElided", () => {
  it("tells the true count of a command's output that an output cap had already cut", () => {
    const output = joinElided([
      wholeText("Exit code: 1\nSTDOUT:\n"),
      wholeText("H".repeat(400_000)),
      [{ kind: "cut", chars: 3_000_000 }],
      wholeText(`${"T".repeat(600_000)}FAILED`),
    ]);
    const cut = truncateElided(output);
    const total = "Exit code: 1\nSTDOUT:\n".length + 400_000 + 3_000_000 + 600_006;
    expect(cut).toContain(`[truncated by Ashara: ${total - 30_000} characters cut here]`);
    expect(cut.startsWith("Exit code: 1\nSTDOUT:\nHHH")).toBe(true);
    expect(cut.endsWith("TTTFAILED")).toBe(true);
  });
});
