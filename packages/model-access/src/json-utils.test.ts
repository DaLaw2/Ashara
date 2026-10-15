import { describe, expect, test } from "vitest";
import { extractJson } from "./json-utils.js";

describe("extractJson", () => {
  test("a fenced valid value is unwrapped and parses", () => {
    expect(JSON.parse(extractJson('```json\n{"greeting":"hi"}\n```'))).toEqual({ greeting: "hi" });
  });

  test("a truncated value is never closed into one that parses", () => {
    for (const truncated of ['{"greeting":"hi"', '```json\n{"items":[1,2\n```', 'Here: {"a":{"b":1}']) {
      expect(() => JSON.parse(extractJson(truncated))).toThrow(SyntaxError);
    }
  });
});
