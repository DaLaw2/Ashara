import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { StackChoiceReports } from "./stack-choice.js";
import type { StackChoiceStore } from "./stack-choice.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000011", "test");
const STATEMENT = "A Debian image with the language's standard toolchain, chosen because the tender names no stack.";

describe("stack-choice report", () => {
  test("states what the environment's test covers and promises no extension of it", async () => {
    const reports: string[] = [];
    const store: StackChoiceStore = {
      dueStackChoices: async () => [{ projectId, taskId: "t1", statement: STATEMENT, vision: { projectId, version: 1, visionText: "A tender.", summary: "A tender.", scopeBoundaries: [], inferences: [], openQuestions: [], contractForm: "scope-lines", interface: [], guarantees: [], exclusions: [] } }],
      recordStackChoice: async (write) => {
        reports.push(write.report);
        return "recorded";
      },
      blockProject: async () => "blocked",
    };

    await new StackChoiceReports(store, memoryStepContainment(() => true)).runPending();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(STATEMENT);
    expect(reports[0]).toContain("The environment's own test proves only that the toolchain builds and runs; it does not test the product.");
    expect(reports[0]).toContain("verified by checks written for it before that task starts");
    expect(reports[0]).not.toMatch(/extend/i);
  });
});
