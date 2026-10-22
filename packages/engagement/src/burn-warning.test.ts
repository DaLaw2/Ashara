import { describe, expect, test } from "vitest";
import { DEFAULT_WORK_BUDGETS } from "@ashara/finance";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { BurnWarnings } from "./burn-warning.js";
import type { BurnWarning, BurnWarningStore, ProjectBurn } from "./burn-warning.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000030", "test");

/**
 * A store in memory that keeps what was posted the way the repository does: once per zone and
 * revision, never yellow after red. The burn it lists is whatever the test sets now.
 */
function storeOf(initial: Omit<ProjectBurn, "reported" | "projectId">) {
  let burn = initial;
  const posted: BurnWarning[] = [];
  const store: BurnWarningStore = {
    projectBurns: async () => [
      { ...burn, projectId, reported: posted.filter((warning) => warning.planRevision === burn.planRevision).map((warning) => warning.zone) },
    ],
    postWarning: async (warning) => {
      posted.push(warning);
      return "posted";
    },
    riskRecords: async () => ({ kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } }),
  };
  return { store, posted, set: (next: Partial<typeof initial>) => (burn = { ...burn, ...next }) };
}

// The default budgets: 600 requests, a reserve of 150, so 450 the project's work may draw.
const warnings = (store: BurnWarningStore) => new BurnWarnings(store, DEFAULT_WORK_BUDGETS, memoryStepContainment(() => false));

describe("the work ledger's early warning", () => {
  test("yellow fires once at half the upstream budget with a quarter of the plan done, and states what was spent, what is done and what comes next", async () => {
    const { store, posted, set } = storeOf({ planRevision: 1, drawnRequests: 224, grantedRequests: 0, plannedTasks: 4, completedTasks: 1 });
    expect(await warnings(store).runPending()).toEqual([]);

    set({ drawnRequests: 225 });
    expect(await warnings(store).runPending()).toEqual([{ kind: "posted", projectId, zone: "yellow" }]);
    set({ drawnRequests: 300 });
    expect(await warnings(store).runPending()).toEqual([]);

    expect(posted).toHaveLength(1);
    const [yellow] = posted;
    expect(yellow).toMatchObject({
      zone: "yellow",
      figures: { drawnRequests: 225, budgetRequests: 600, reserveRequests: 150, upstreamRequests: 450, plannedTasks: 4, completedTasks: 1 },
      operatorText: null,
    });
    expect(yellow?.body).toBe(
      "This project has used more of its budget of model requests than its finished work accounts for.\n\n" +
        "So far 225 model requests have been sent, of the 450 model requests this project's work may use before it pauses. A further 150 model " +
        "requests of its budget are set aside for checking and accepting the finished work, and only that checking may use them. 1 of the 4 " +
        "building tasks of the current plan are finished.\n\n" +
        "Ashara goes on with the plan as it stands. If the model requests this project's work may use are used up before it is finished, " +
        "work on it pauses until the operator grants more, and you are told when it does.\n\n" +
        "No guarantee is at risk on the records.",
    );
  });

  test("red fires once at 80 percent with the plan unfinished, tells the operator, and leaves no yellow after it", async () => {
    const { store, posted, set } = storeOf({ planRevision: 1, drawnRequests: 360, grantedRequests: 0, plannedTasks: 4, completedTasks: 0 });
    expect(await warnings(store).runPending()).toEqual([{ kind: "posted", projectId, zone: "red" }]);
    expect(await warnings(store).runPending()).toEqual([]);
    expect(posted.map((warning) => warning.zone)).toEqual(["red"]);
    expect(posted[0]?.operatorText).toContain(`project ${projectId} (plan revision 1) has drawn 360 of the 450 model requests its upstream work may draw`);
    expect(posted[0]?.body).toContain("Ashara has told its operator.");

    // A plan finished at the same burn is in no zone.
    set({ planRevision: 2, completedTasks: 4 });
    expect(await warnings(store).runPending()).toEqual([]);
    // A new plan revision is a new chart: its zones are told again.
    set({ completedTasks: 0 });
    expect(await warnings(store).runPending()).toEqual([{ kind: "posted", projectId, zone: "red" }]);
  });

  test("a plan with no building task planned has none finished: the burn still warns", async () => {
    const { store, posted } = storeOf({ planRevision: 1, drawnRequests: 230, grantedRequests: 0, plannedTasks: 0, completedTasks: 0 });
    await warnings(store).runPending();
    expect(posted.map((warning) => warning.zone)).toEqual(["yellow"]);
    expect(posted[0]?.body).toContain("No building task of the current plan is planned yet, so none of it is finished.");
  });
});
