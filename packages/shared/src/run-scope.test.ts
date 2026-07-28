import { describe, test, expect } from "vitest";
import { parseRunScope, RunScopeCorrupt, RUN_SCOPE_PRE_SCOPING, RUN_SCOPE_AD_HOC } from "./run-scope.js";

describe("parseRunScope", () => {
  test("null throws RunScopeCorrupt (NOT NULL column)", () => {
    try {
      parseRunScope(null);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RunScopeCorrupt);
      const err = e as RunScopeCorrupt;
      expect(err.raw).toBeNull();
      expect(err.detail).toContain("NOT NULL");
      expect(err.name).toBe("RunScopeCorrupt");
    }
  });

  test("undefined throws RunScopeCorrupt (NOT NULL column)", () => {
    expect(() => parseRunScope(undefined)).toThrow(RunScopeCorrupt);
  });

  test("empty string throws RunScopeCorrupt (min length 1)", () => {
    expect(() => parseRunScope("")).toThrow(RunScopeCorrupt);
  });

  test("number throws RunScopeCorrupt (not a string)", () => {
    expect(() => parseRunScope(42)).toThrow(RunScopeCorrupt);
  });

  test("RUN_SCOPE_PRE_SCOPING round-trips", () => {
    expect(parseRunScope(RUN_SCOPE_PRE_SCOPING)).toBe("pre-scoping");
  });

  test("RUN_SCOPE_AD_HOC round-trips", () => {
    expect(parseRunScope(RUN_SCOPE_AD_HOC)).toBe("ad-hoc");
  });

  test("a UUID runId round-trips", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseRunScope(uuid)).toBe(uuid);
  });
});
