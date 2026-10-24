import { describe, expect, test, vi } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import type { CapabilityLevel, ContextualLlm } from "./acl/finance-acl.js";
import { createPendingWorkItem } from "./domain/work-item.js";
import type { WorkItem } from "./domain/work-item.js";
import { Replanner } from "./replan.js";
import type { AttemptGrade, ReplanStore } from "./replan-port.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000cc", "test");

// Whether the environment still serves judges the environment task's work, so the revision asks for a
// judge of work at that work's tier: the higher of its planned grade and its model's grade.
describe("Replanner: the environment judgement asks for a judge of the environment work's tier", () => {
  const ROSTER_ROWS = [
    { revision: 1, visionVersion: 1, roleId: "00000000-0000-4000-8000-0000000000a0", name: "Liaison", responsibility: "Liaison duties", capabilities: ["client-comms"] },
    { revision: 1, visionVersion: 1, roleId: "00000000-0000-4000-8000-0000000000a1", name: "Platform", responsibility: "Platform duties", capabilities: ["write-environment"] },
    { revision: 1, visionVersion: 1, roleId: "00000000-0000-4000-8000-0000000000a2", name: "Implementer", responsibility: "Implementer duties", capabilities: ["write-source"] },
    { revision: 1, visionVersion: 1, roleId: "00000000-0000-4000-8000-0000000000a3", name: "Check author", responsibility: "Check author duties", capabilities: ["author-checks"] },
  ];
  const notReached = async (): Promise<never> => {
    throw new Error("must not be reached");
  };

  /** The tier the environment judgement asks for, given the environment task's planned grade and its attempt's grade. */
  async function judgedTier(planned: CapabilityLevel, attemptGrade: AttemptGrade) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const environment: WorkItem = {
      ...createPendingWorkItem({ level: "Task", title: "Set up the environment", projectId: PROJECT, taskSpec: { origin: "sprint0", capability: planned } }),
      workKind: "environment",
      status: "Completed",
    };
    const given: WorkItem = {
      ...createPendingWorkItem({ level: "Task", title: "Store keys", projectId: PROJECT, taskSpec: { origin: "decomposition", capability: "Strong" } }),
      workKind: "implementation",
      status: "Abandoned",
      blockedReason: { source: "task_failed", reason: "its checks failed" },
    };
    const store: ReplanStore = {
      projectsAwaitingReplan: async () => [
        {
          projectId: PROJECT,
          projectName: "Key store",
          correctionsAwaited: [],
          repairsAwaited: [given.id],
          dependencies: [],
          vision: { projectId: PROJECT, version: 1, visionText: "A key store.", summary: "A key store.", scopeBoundaries: ["In: storing keys"], inferences: [], openQuestions: [], contractForm: "scope-lines", interface: [], guarantees: [], exclusions: [] },
          rosterRows: ROSTER_ROWS,
          replanAttempts: 0,
          replanLastError: null,
          replanLastFailure: null,
          revisionsSinceReview: 0,
          repairsSinceReview: 0,
          nextRevision: 2,
          items: [
            { item: environment, mergeCommit: "abc123", attemptGrade, environmentStatement: "Rust with cargo test.", decided: [] },
            { item: given, mergeCommit: null, attemptGrade: { kind: "unrecorded", why: "never completed" }, environmentStatement: null, decided: [] },
          ],
        },
      ],
      writeRevision: notReached,
      recordFailedAttempt: notReached,
      blockProject: notReached,
    };
    const sent: Array<{ readonly judges: CapabilityLevel | undefined; readonly capability: CapabilityLevel | undefined }> = [];
    const llm: ContextualLlm = {
      forCall: () => ({
        generateStructured: async (request) => {
          sent.push({ judges: request.judges, capability: request.capability });
          throw new Error("the judgement's request is all this test reads");
        },
      }),
    };
    await new Replanner({ shutdownSignal: new AbortController().signal, llm, store, containment: memoryStepContainment(() => false), logger: recordingLogger() }).runPending();
    return sent;
  }

  test.each([
    ["Strong", { kind: "graded", model: "m", grade: "Frontier" }, "Frontier"],
    ["Frontier", { kind: "graded", model: "m", grade: "Medium" }, "Frontier"],
    ["Medium", { kind: "graded", model: "m", grade: "Light" }, "Medium"],
    ["Medium", { kind: "unrecorded", why: "no completed attempt of it records the model it ran on" }, "Medium"],
  ] as const)("planned %s, done on %o: the judge is asked for work at %s, never a capability", async (planned, attempt, expected) => {
    expect(await judgedTier(planned, attempt)).toEqual([{ judges: expected, capability: undefined }]);
  });
});
