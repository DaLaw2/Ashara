import { describe, expect, test } from "vitest";
import { mapFinishReason, parseToolCalls } from "./turn.js";

describe("mapFinishReason", () => {
  test("is total: a missing, `error` or undocumented finish reason is provider_error", () => {
    expect(mapFinishReason("length")).toBe("truncated");
    expect(mapFinishReason("tool-calls")).toBe("tool_calls");
    for (const absent of [undefined, null, "error", "unknown", 42]) {
      expect(mapFinishReason(absent)).toBe("provider_error");
    }
  });
});

describe("parseToolCalls", () => {
  const declared = { read_file: { description: "d", inputSchema: { type: "object" as const } } };

  test("an SDK-flagged invalid call is returned as invalid; an undeclared unflagged call is an issue", () => {
    const { toolCalls, issues } = parseToolCalls(
      [
        { toolCallId: "a", toolName: "nope", input: "{", invalid: true, error: new Error("no such tool") },
        { toolCallId: "b", toolName: "nope", input: {} },
        { toolName: "read_file", input: {} },
      ],
      declared,
    );
    expect(toolCalls).toEqual([
      { kind: "invalid", toolCallId: "a", toolName: "nope", input: "{", error: "Error: no such tool" },
    ]);
    expect(issues).toHaveLength(2);
  });
});
