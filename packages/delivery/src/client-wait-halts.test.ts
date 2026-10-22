import { describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { WorkItem } from "./domain/index.js";
import { resumeClientWaitHalts } from "./client-wait-halts.js";

// A project halted on client_wait ends its halt by itself once the client's answer to a question its
// held tasks wait on is read, and only then.

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000c1", "test");
const QUESTION = "6f1c3c1e-8a52-4d43-9d7a-2b2f3e0e9a12";

function held(): WorkItem {
  return {
    id: createWorkItemId(),
    level: "Task",
    status: "Blocked",
    title: "delete keys",
    projectId: PROJECT,
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    workKind: "implementation",
    repairsTaskId: null,
    blockedReason: { source: "awaiting_client", waits: 1, questionId: QUESTION, question: "Which command?", assumption: "The tender's.", reason: "contradiction" },
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}

function run(answered: boolean, outcome: "resumed" | "moved" | "unreported" = "resumed") {
  const resumed: Array<{ readonly projectId: ProjectId; readonly evidence: string }> = [];
  const result = resumeClientWaitHalts({
    halts: {
      listClientWaitHalted: async () => [PROJECT],
      resumeFromClientWait: async (projectId, evidence) => {
        resumed.push({ projectId, evidence });
        return outcome;
      },
    },
    workItemRepo: { findByProjectAndStatus: async (_projectId, status) => (status === "Blocked" ? [held()] : []) },
    clientQuestions: { answered: async (questionId) => answered && questionId === QUESTION },
    containment: memoryStepContainment(() => true),
    logger: recordingLogger(),
  });
  return { result, resumed };
}

describe("a client_wait halt is ended by the client's answer, read during it", () => {
  test("the answer read: the halt ends with what was answered as its evidence", async () => {
    const { result, resumed } = run(true);
    expect(await result).toBe(1);
    expect(resumed).toEqual([{ projectId: PROJECT, evidence: expect.stringContaining(`question ${QUESTION}`) }]);
  });

  test("no answer read yet: the halt stays, and nothing is written", async () => {
    const { result, resumed } = run(false);
    expect(await result).toBe(0);
    expect(resumed).toEqual([]);
  });

  test("a halt whose report is not yet posted is not counted as resumed", async () => {
    const { result } = run(true, "unreported");
    expect(await result).toBe(0);
  });
});
