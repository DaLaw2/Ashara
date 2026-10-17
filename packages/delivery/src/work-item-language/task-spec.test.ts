import { describe, test, expect } from "vitest";
import { parseStoredTaskSpec, TaskSpecCorrupt } from "./task-spec.js";

describe("parseStoredTaskSpec", () => {
  test("null and undefined return undefined (policy default: absent spec is deliberate delegation)", () => {
    expect(parseStoredTaskSpec(null)).toBeUndefined();
    expect(parseStoredTaskSpec(undefined)).toBeUndefined();
  });

  test("a non-object value throws TaskSpecCorrupt with structured context, a number too (not silently coerced)", () => {
    const corrupt = "not an object";
    try {
      parseStoredTaskSpec(corrupt);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TaskSpecCorrupt);
      const err = e as TaskSpecCorrupt;
      expect(err.raw).toBe(corrupt);
      expect(err.detail).toBeTruthy();
      expect(err.name).toBe("TaskSpecCorrupt");
      expect(err.message).toContain("stored task_spec is not a valid object");
    }
    expect(() => parseStoredTaskSpec(42)).toThrow(TaskSpecCorrupt);
  });

  test("array throws TaskSpecCorrupt (jsonb [] is not a valid spec)", () => {
    expect(() => parseStoredTaskSpec([1, 2, 3])).toThrow(TaskSpecCorrupt);
  });

  test("valid spec round-trips with typed fields intact", () => {
    const input = {
      goal: "Implement user registration",
      endState: "POST /api/register responds 201",
      scope: "packages/server/src/routes",
      deliverables: ["src/routes/register.ts", "src/routes/register.test.ts"],
      origin: "sprint0",
      checkedBy: "substrate",
      capability: "Strong",
    };

    const result = parseStoredTaskSpec(input);
    expect(result).toBeDefined();
    expect(result!.goal).toBe(input.goal);
    expect(result!.endState).toBe(input.endState);
    expect(result!.scope).toBe(input.scope);
    expect(result!.deliverables).toEqual(input.deliverables);
    expect(result!.checkedBy).toBe(input.checkedBy);
    expect(result!.origin).toBe(input.origin);
    expect(result!.capability).toBe(input.capability);
  });

  test("empty object is valid (all fields optional)", () => {
    const result = parseStoredTaskSpec({});
    expect(result).toEqual({});
  });

  test("closed schema strips undeclared keys (no passthrough)", () => {
    const input = {
      goal: "Fix the bug",
      experimentalMetric: 0.95,
      customTag: "hotfix-urgent",
    };

    const result = parseStoredTaskSpec(input);
    expect(result).toBeDefined();
    // Declared fields survive
    expect(result!.goal).toBe("Fix the bug");
    // Undeclared keys are stripped — the key set is closed
    expect((result as Record<string, unknown>)["experimentalMetric"]).toBeUndefined();
    expect((result as Record<string, unknown>)["customTag"]).toBeUndefined();
  });

  test("a capability that is no level is corrupt: dispatch never routes on a guessed one", () => {
    expect(() => parseStoredTaskSpec({ capability: "UltraFrontier9000" })).toThrow(TaskSpecCorrupt);
    expect(parseStoredTaskSpec({ capability: "Medium", capabilityReason: "one module, clear spec" })).toMatchObject({
      capability: "Medium",
      capabilityReason: "one module, clear spec",
    });
  });
});

describe("stored task spec schema", () => {
  test("schema rejects deliverables containing non-strings", () => {
    expect(() => parseStoredTaskSpec({
      deliverables: ["valid.ts", 42, null],
    })).toThrow(TaskSpecCorrupt);
  });
});
