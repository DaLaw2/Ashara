import { describe, test, expect } from "vitest";
import { parseStoredSuccessCriteria, SuccessCriteriaCorrupt } from "./success-criteria.js";

describe("parseStoredSuccessCriteria", () => {
  test("null returns undefined (policy default: not all items carry criteria)", () => {
    expect(parseStoredSuccessCriteria(null)).toBeUndefined();
  });

  test("undefined returns undefined", () => {
    expect(parseStoredSuccessCriteria(undefined)).toBeUndefined();
  });

  test("non-array value throws SuccessCriteriaCorrupt", () => {
    const corrupt = "not an array";
    try {
      parseStoredSuccessCriteria(corrupt);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SuccessCriteriaCorrupt);
      const err = e as SuccessCriteriaCorrupt;
      expect(err.raw).toBe(corrupt);
      expect(err.detail).toBeTruthy();
      expect(err.name).toBe("SuccessCriteriaCorrupt");
      expect(err.message).toContain("stored success_criteria is not a valid array");
    }
  });

  test("number throws SuccessCriteriaCorrupt", () => {
    expect(() => parseStoredSuccessCriteria(42)).toThrow(SuccessCriteriaCorrupt);
  });

  test("array containing non-strings throws SuccessCriteriaCorrupt", () => {
    expect(() => parseStoredSuccessCriteria(["valid", 42, null])).toThrow(SuccessCriteriaCorrupt);
  });

  test("valid string array round-trips", () => {
    const input = ["Tests pass", "API responds 200", "README updated"];
    const result = parseStoredSuccessCriteria(input);
    expect(result).toEqual(input);
  });

  test("empty array is valid", () => {
    const result = parseStoredSuccessCriteria([]);
    expect(result).toEqual([]);
  });
});

describe("stored success criteria schema", () => {
  test("rejects object (not an array)", () => {
    expect(() => parseStoredSuccessCriteria({ criteria: "test" })).toThrow(SuccessCriteriaCorrupt);
  });
});
