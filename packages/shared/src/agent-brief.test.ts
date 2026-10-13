import { describe, expect, test } from "vitest";
import { createAgentBrief, InvalidAgentBriefError } from "./agent-brief.js";
import type { AgentBrief } from "./agent-brief.js";

/** Minimal valid brief: every required field present, no optionals. */
function minimalBrief(): AgentBrief {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    goal: "implement the thing",
    projectFrame: { intent: "a project", stack: ["TypeScript"], source: "vision-derivation" },
    context: "end state: the thing works",
    deliverables: [],
  };
}

describe("createAgentBrief", () => {
  test("accepts a minimal valid brief", () => {
    expect(createAgentBrief(minimalBrief(), "test").taskId).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("still runs the Zod parse at runtime: a .min(1) violation the type admits is caught", () => {
    expect(() => createAgentBrief({ ...minimalBrief(), taskId: "" }, "test")).toThrow(InvalidAgentBriefError);
  });
});
