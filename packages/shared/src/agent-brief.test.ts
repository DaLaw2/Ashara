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
  });

  test("rejects an unexpected top-level field (.strict())", () => {
    expect(() =>
      parseAgentBrief({ ...minimalBrief(), rogue: "field" }, "test"),
    ).toThrow(InvalidAgentBriefError);
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
  });
});
