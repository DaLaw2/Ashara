import { describe, expect, test } from "vitest";
import { z } from "zod";
import { JsonParseFailed, parseJson } from "./json.js";

const Shape = z.object({ n: z.number() });

function failureOf(text: string): JsonParseFailed {
  try {
    parseJson(Shape, text, "planted source");
  } catch (err) {
    if (err instanceof JsonParseFailed) return err;
    throw err;
  }
  throw new JsonParseFailed("planted source", "syntax", "parsed, but a failure was expected", [], text);
}

describe("parseJson", () => {
  test("a text of the shape becomes the schema's value", () => {
    expect(parseJson(Shape, '{"n": 1}', "planted source")).toEqual({ n: 1 });
  });

  test("a text that is not JSON throws JsonParseFailed at the syntax stage, naming its source", () => {
    const failure = failureOf("{n: 1");
    expect(failure.stage).toBe("syntax");
    expect(failure.issues).toEqual([]);
    expect(failure.message).toMatch(/^planted source: not JSON: /);
    expect(failure.cause).toBeInstanceOf(SyntaxError);
  });

  test("JSON of another shape throws JsonParseFailed at the schema stage with each issue", () => {
    const failure = failureOf('{"n": "one"}');
    expect(failure.stage).toBe("schema");
    expect(failure.issues).toEqual([expect.stringMatching(/^n: /)]);
    expect(failureOf("[]").issues).toEqual([expect.stringMatching(/^\(root\): /)]);
  });

  test("a long rejected text is kept as an excerpt", () => {
    const failure = failureOf(`"${"x".repeat(500)}`);
    expect(failure.excerpt.length).toBeLessThan(300);
    expect(failure.excerpt).toMatch(/more characters\]$/);
  });
});
