import { describe, expect, test } from "vitest";
import { InvalidId, createWorkItemId, parseProjectId, parseWorkItemId } from "./ids.js";

describe("branded id parsers", () => {
  test("a UUID passes through unchanged", () => {
    const raw = "00000000-0000-4000-8000-000000000001";
    expect(parseProjectId(raw, "projects.id")).toBe(raw);
    expect(parseWorkItemId(raw, "work_items.id")).toBe(raw);
    expect(parseWorkItemId(createWorkItemId(), "test")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.each([
    ["ProjectId", (raw: unknown) => parseProjectId(raw, "projects.id"), "projects.id"],
    ["WorkItemId", (raw: unknown) => parseWorkItemId(raw, "dependencies.to_id"), "dependencies.to_id"],
  ] as const)("a malformed %s throws InvalidId naming the brand and the field", (brand, parse, field) => {
    for (const raw of ["not-a-uuid", "", "00000000-0000-4000-8000-00000000000", undefined, 42]) {
      let thrown: unknown;
      try {
        parse(raw);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(InvalidId);
      expect(thrown).toMatchObject({ brand, field, raw });
      expect(thrown).toHaveProperty("message", expect.stringContaining(`Invalid ${brand} in ${field}`));
    }
  });
});
