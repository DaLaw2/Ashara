import { describe, expect, test } from "vitest";
import { parseAgentBrief, InvalidAgentBriefError } from "./agent-brief.js";

/** Minimal valid brief — every required field present, no optionals. */
function minimalBrief(): Record<string, unknown> {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    goal: "implement the thing",
    projectFrame: { intent: "a project", stack: ["TypeScript"], source: "vision-derivation" },
    context: "end state: the thing works",
    tools: [],
    constraints: [],
    deliverables: [],
  };
}

describe("AgentBriefSchema", () => {
  test("parses a minimal valid brief", () => {
    const brief = parseAgentBrief(minimalBrief(), "test");
    expect(brief.taskId).toBe("11111111-1111-4111-8111-111111111111");
    expect(brief.task_spec).toBeUndefined();
  });

  test("rejects an unexpected top-level field (.strict())", () => {
    expect(() =>
      parseAgentBrief({ ...minimalBrief(), rogue: "field" }, "test"),
    ).toThrow(InvalidAgentBriefError);
  });

  describe("task_spec", () => {
    test("accepts task_spec with checks", () => {
      const raw = { ...minimalBrief(), task_spec: { checks: ["npm test"] } };
      const brief = parseAgentBrief(raw, "test");
      expect(brief.task_spec).toEqual({ checks: ["npm test"] });
    });

    test("accepts task_spec with empty checks array", () => {
      const raw = { ...minimalBrief(), task_spec: { checks: [] } };
      const brief = parseAgentBrief(raw, "test");
      expect(brief.task_spec).toEqual({ checks: [] });
    });

    test("accepts task_spec with no checks (field omitted)", () => {
      const raw = { ...minimalBrief(), task_spec: {} };
      const brief = parseAgentBrief(raw, "test");
      expect(brief.task_spec).toEqual({});
      expect(brief.task_spec?.checks).toBeUndefined();
    });

    test("strips unrecognized fields from task_spec (producer sends full StoredTaskSpec)", () => {
      const raw = {
        ...minimalBrief(),
        task_spec: {
          checks: ["npm test"],
          goal: "should be stripped",
          endState: "should be stripped",
          scope: "should be stripped",
          deliverables: ["should be stripped"],
          origin: "acceptance-gap",
          splitDepth: 1,
        },
      };
      const brief = parseAgentBrief(raw, "test");
      // Only the declared field survives the parse
      expect(brief.task_spec).toEqual({ checks: ["npm test"] });
    });

    test("rejects task_spec.checks with wrong type", () => {
      const raw = { ...minimalBrief(), task_spec: { checks: "not-an-array" } };
      expect(() => parseAgentBrief(raw, "test")).toThrow(InvalidAgentBriefError);
    });

    test("rejects task_spec.checks with non-string elements", () => {
      const raw = { ...minimalBrief(), task_spec: { checks: [42] } };
      expect(() => parseAgentBrief(raw, "test")).toThrow(InvalidAgentBriefError);
    });

    test("absent task_spec is allowed (optional)", () => {
      const raw = minimalBrief();
      delete raw["task_spec"];
      const brief = parseAgentBrief(raw, "test");
      expect(brief.task_spec).toBeUndefined();
    });
  });
});
