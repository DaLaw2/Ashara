import { describe, test, expect, vi } from "vitest";
import { isHttpCheck, validateBodyShape, runDeterministicChecks } from "./check-runner.js";
import type { CommandRunner } from "./verify-core.js";

describe("isHttpCheck", () => {
  test("recognizes GET with exact status", () => {
    expect(isHttpCheck("GET /path returns 200")).toBe(true);
  });

  test("recognizes POST with exact status", () => {
    expect(isHttpCheck("POST /api/items returns 201")).toBe(true);
  });

  test("recognizes DELETE with exact status", () => {
    expect(isHttpCheck("DELETE /api/items/1 returns 204")).toBe(true);
  });

  test("recognizes PUT with exact status", () => {
    expect(isHttpCheck("PUT /api/items/1 returns 200")).toBe(true);
  });

  test("recognizes PATCH with exact status", () => {
    expect(isHttpCheck("PATCH /api/items/1 returns 200")).toBe(true);
  });

  test("recognizes HEAD with exact status", () => {
    expect(isHttpCheck("HEAD /health returns 200")).toBe(true);
  });

  test("recognizes range status pattern (3xx)", () => {
    expect(isHttpCheck("GET /:code returns 3xx")).toBe(true);
  });

  test("recognizes range status pattern (2xx)", () => {
    expect(isHttpCheck("POST /api/items returns 2xx")).toBe(true);
  });

  test("recognizes paths with route params", () => {
    expect(isHttpCheck("GET /:code returns 302")).toBe(true);
  });

  test("rejects natural language", () => {
    expect(isHttpCheck("npx tsc --noEmit passes")).toBe(false);
  });

  test("rejects shell commands", () => {
    expect(isHttpCheck("npm test")).toBe(false);
  });

  test("rejects invalid HTTP methods", () => {
    expect(isHttpCheck("FETCH /path returns 200")).toBe(false);
  });

  test("rejects missing path", () => {
    expect(isHttpCheck("GET returns 200")).toBe(false);
  });

  test("rejects non-numeric status", () => {
    expect(isHttpCheck("GET /path returns abc")).toBe(false);
  });

  test("rejects path not starting with /", () => {
    expect(isHttpCheck("GET path returns 200")).toBe(false);
  });
});

describe("isHttpCheck — with body shape", () => {
  test("recognizes json-array shape", () => {
    expect(isHttpCheck("GET /api/todos returns 200 with json-array")).toBe(true);
  });

  test("recognizes json-object shape", () => {
    expect(isHttpCheck("POST /api/todos returns 201 with json-object")).toBe(true);
  });

  test("recognizes json shape", () => {
    expect(isHttpCheck("GET /api/data returns 200 with json")).toBe(true);
  });

  test("recognizes non-empty shape", () => {
    expect(isHttpCheck("GET /health returns 200 with non-empty")).toBe(true);
  });

  test("rejects unknown shape", () => {
    expect(isHttpCheck("GET /path returns 200 with xml")).toBe(false);
  });

  test("status-only check still works", () => {
    expect(isHttpCheck("GET /path returns 200")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDeterministicChecks — zero-check identity-element trap (Discipline A)
//
// "The identity element of a collection, a conjunction, or a sum always reads
// as fine — that is a property of arithmetic, not evidence about the world."
// An empty loop over zero checks must not produce status "pass".
// ---------------------------------------------------------------------------

describe("runDeterministicChecks — zero checks", () => {
  const stubRunner: CommandRunner = async () => ({ exitCode: 0, output: "" });

  test("zero checks must not produce a pass status", async () => {
    const result = await runDeterministicChecks(stubRunner, "/tmp/test", []);
    expect(result.tier.status).not.toBe("pass");
    expect(result.tier.details).not.toContain("All 0 checks passed");
  });

  test("zero checks produces skipped status with empty checks array", async () => {
    const result = await runDeterministicChecks(stubRunner, "/tmp/test", []);
    expect(result.tier.status).toBe("skipped");
    expect(result.tier.checks).toEqual([]);
  });
});


describe("validateBodyShape", () => {
  describe("json-array", () => {
    test("array passes", () => {
      expect(validateBodyShape('[{"id":1}]', "json-array")).toEqual({ valid: true, actual: "json-array" });
    });

    test("empty array passes", () => {
      expect(validateBodyShape("[]", "json-array")).toEqual({ valid: true, actual: "json-array" });
    });

    test("object fails", () => {
      expect(validateBodyShape('{"id":1}', "json-array")).toEqual({ valid: false, actual: "object" });
    });

    test("null fails", () => {
      expect(validateBodyShape("null", "json-array")).toEqual({ valid: false, actual: "null" });
    });

    test("invalid JSON fails", () => {
      expect(validateBodyShape("not json", "json-array")).toEqual({ valid: false, actual: "invalid JSON" });
    });
  });

  describe("json-object", () => {
    test("object passes", () => {
      expect(validateBodyShape('{"id":1}', "json-object")).toEqual({ valid: true, actual: "json-object" });
    });

    test("empty object passes", () => {
      expect(validateBodyShape("{}", "json-object")).toEqual({ valid: true, actual: "json-object" });
    });

    test("array fails", () => {
      expect(validateBodyShape('[{"id":1}]', "json-object")).toEqual({ valid: false, actual: "array" });
    });

    test("null fails", () => {
      expect(validateBodyShape("null", "json-object")).toEqual({ valid: false, actual: "null" });
    });

    test("string fails", () => {
      expect(validateBodyShape('"hello"', "json-object")).toEqual({ valid: false, actual: "string" });
    });

    test("invalid JSON fails", () => {
      expect(validateBodyShape("not json", "json-object")).toEqual({ valid: false, actual: "invalid JSON" });
    });
  });

  describe("json", () => {
    test("valid object passes", () => {
      expect(validateBodyShape('{"a":1}', "json")).toEqual({ valid: true, actual: "valid JSON" });
    });

    test("valid array passes", () => {
      expect(validateBodyShape("[1,2]", "json")).toEqual({ valid: true, actual: "valid JSON" });
    });

    test("valid null passes", () => {
      expect(validateBodyShape("null", "json")).toEqual({ valid: true, actual: "valid JSON" });
    });

    test("valid string passes", () => {
      expect(validateBodyShape('"hello"', "json")).toEqual({ valid: true, actual: "valid JSON" });
    });

    test("invalid JSON fails", () => {
      expect(validateBodyShape("not json", "json")).toEqual({ valid: false, actual: "invalid JSON" });
    });

    test("empty string fails", () => {
      expect(validateBodyShape("", "json")).toEqual({ valid: false, actual: "invalid JSON" });
    });
  });

  describe("non-empty", () => {
    test("non-empty body passes", () => {
      expect(validateBodyShape("hello", "non-empty")).toEqual({ valid: true, actual: "non-empty" });
    });

    test("empty body fails", () => {
      expect(validateBodyShape("", "non-empty")).toEqual({ valid: false, actual: "empty" });
    });
  });
});
