import { describe, expect, test, vi } from "vitest";
import type { ContextualLlm } from "@ashara/llm-gateway";
import { parseProjectId } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";
import { FirstPlanner } from "./first-plan.js";
import type { FirstPlanStore } from "./first-plan.js";

function awaiting(projectId: ProjectId, planLastError: string | null) {
  return {
    projectId,
    projectName: "Studio booking",
    visionVersion: 1,
    visionText: "A booking page.",
    summary: "A booking page.",
    scopeBoundaries: [],
    inferences: [],
    userAnswers: [],
    planAttempts: 3,
    planLastError,
  };
}

describe("FirstPlanner per-project failure", () => {
  test("a project at its cap with no recorded error is blocked and the next project is still stopped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const lying = parseProjectId("00000000-0000-4000-8000-000000000020");
    const capped = parseProjectId("00000000-0000-4000-8000-000000000021");
    const blocked: Array<{ projectId: ProjectId; cause: ProjectBlockCause }> = [];
    const stopped: ProjectId[] = [];
    const notReached = async (): Promise<never> => {
      throw new Error("must not be reached");
    };
    const store: FirstPlanStore = {
      projectsAwaitingPlan: async () => [awaiting(lying, null), awaiting(capped, "Error: decomposition failed")],
      writeFirstPlan: notReached,
      recordFailedAttempt: notReached,
      stopPlanning: async (projectId) => {
        stopped.push(projectId);
      },
      blockProject: async (projectId, cause) => {
        blocked.push({ projectId, cause });
        return "blocked";
      },
    };
    const llm: ContextualLlm = { forCall: () => ({ generateStructured: notReached }) };

    const outcomes = await new FirstPlanner({ llm, store }).runPending();

    expect(outcomes.map((o) => `${o.projectId}:${o.kind}`)).toEqual([`${lying}:project-blocked`, `${capped}:stopped`]);
    expect(blocked).toEqual([
      { projectId: lying, cause: { errorClass: "PlanFailureUnrecorded", reason: expect.stringMatching(/^PlanFailureUnrecorded: /) } },
    ]);
    expect(stopped).toEqual([capped]);
  });
});
