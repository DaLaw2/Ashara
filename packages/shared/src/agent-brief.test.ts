import { describe, expect, test } from "vitest";
import { createAgentBrief, parseAgentBrief, InvalidAgentBriefError } from "./agent-brief.js";

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

    test("rejects task_spec with no checks (field omitted) — checks is required", () => {
      const raw = { ...minimalBrief(), task_spec: {} };
      expect(() => parseAgentBrief(raw, "test")).toThrow(InvalidAgentBriefError);
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

    test("constraints never substitute for absent checks — the two fields serve different consumers", () => {
      // brief.constraints carries natural-language prose for the agent prompt;
      // brief.task_spec.checks carries executable shell commands for inline verify.
      // When task_spec is absent, inline verify is SKIPPED (the named absence
      // case), not run with an empty array derived from constraints.
      const raw = {
        ...minimalBrief(),
        constraints: ["All endpoints must return JSON", "Code must compile"],
      };
      const brief = parseAgentBrief(raw, "test");
      expect(brief.task_spec).toBeUndefined();
      expect(brief.constraints).toEqual(["All endpoints must return JSON", "Code must compile"]);
    });
  });

  describe("createAgentBrief — typed producer entry point", () => {
    test("produces the same result as parseAgentBrief for a valid input", () => {
      const input = {
        taskId: "11111111-1111-4111-8111-111111111111",
        goal: "implement the thing",
        projectFrame: { intent: "a project", stack: ["TypeScript"], source: "vision-derivation" as const },
        context: "end state: the thing works",
        tools: [] as string[],
        constraints: [] as string[],
        deliverables: [] as string[],
        task_spec: { checks: ["npm test"] },
      };
      const fromCreate = createAgentBrief(input, "test");
      const fromParse = parseAgentBrief(input, "test");
      expect(fromCreate).toEqual(fromParse);
    });

    test("still runs the Zod parse at runtime — a .min(1) violation is caught", () => {
      // Even though the TypeScript type is satisfied, the Zod .min(1) constraint
      // on taskId catches an empty string at runtime.
      const input = {
        taskId: "",
        goal: "implement the thing",
        projectFrame: { intent: "a project", stack: ["TypeScript"], source: "vision-derivation" as const },
        context: "end state: the thing works",
        tools: [] as string[],
        constraints: [] as string[],
        deliverables: [] as string[],
      };
      // TypeScript allows this (string satisfies string), but Zod rejects it
      expect(() => createAgentBrief(input, "test")).toThrow(InvalidAgentBriefError);
    });

    test("the ?? brief.constraints fallback is structurally impossible — checks is string[], not optional", () => {
      // This test guards against the regression where someone re-introduces
      // `brief.task_spec?.checks ?? brief.constraints` at the consumer. After
      // making checks required, a present task_spec ALWAYS has checks: string[],
      // so the fallback chain can only reach [] via task_spec absence (the named
      // case), never via an absent checks field that could be silently filled by
      // constraints.
      const raw = {
        ...minimalBrief(),
        constraints: ["All endpoints must return JSON"],
        task_spec: { checks: [] },
      };
      const brief = parseAgentBrief(raw, "test");
      // task_spec is present → checks is string[], never undefined
      expect(brief.task_spec!.checks).toEqual([]);
      // constraints are completely separate
      expect(brief.constraints).toEqual(["All endpoints must return JSON"]);
    });
  });
});
