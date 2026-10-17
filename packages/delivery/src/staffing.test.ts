import { describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { ResolvedModel } from "./acl/finance-acl.js";
import type { TaskDescriptor } from "./dispatch/dispatch-service.js";
import { createAgentStaffing } from "./staffing.js";

const projectId = parseProjectId("22222222-2222-4222-8222-222222222222", "test");
const DEVELOPER = "44444444-4444-4444-8444-444444444444";
const LIAISON = "55555555-5555-4555-8555-555555555555";

const row = (roleId: string, name: string, capabilities: string[]) => ({
  revision: 2, visionVersion: 1, roleId, name, responsibility: `${name}'s work`, capabilities,
});
const LATEST_ROSTER = [
  row(LIAISON, "Client Liaison", ["client-comms"]),
  row("77777777-7777-4777-8777-777777777777", "Build and Test Environment Engineer", ["write-environment"]),
  row(DEVELOPER, "Expense Report Tool Developer", ["write-source"]),
  row("88888888-8888-4888-8888-888888888888", "Verification Author", ["author-checks"]),
];

const model: ResolvedModel = {
  model: "unused",
  provider: "none",
  modelId: "unused-model",
  modelConfig: {
    id: "unused-model", apiModelId: "unused-model", provider: "none", capabilityLevel: "Strong",
    inputCostPer1M: 0, outputCostPer1M: 0, cacheReadCostPer1M: null, cacheWriteCostPer1M: null, maxContextTokens: 1, priceWindows: [], priceTiers: [],
  },
  effectiveCapability: "Strong",
};

const task = (): TaskDescriptor => ({
  id: createWorkItemId(), projectId, title: "t", overflowedWindowTokens: null, dispatchCount: 0, attempt: 1, successCriteria: [], workKind: "implementation", epicId: null,
});

function staffingWith(ownerRoleId: string | null | "absent", rows: unknown = LATEST_ROSTER) {
  return createAgentStaffing({
    ownerOf: async () => (ownerRoleId === "absent" ? { kind: "absent" } : { kind: "found", ownerRoleId }),
    latestRosterRows: async () => rows,
    latestRosterRevision: async () => (Array.isArray(rows) && rows.length > 0 ? 2 : null),
    resolveWiderModel: () => null,
    resolveModel: () => model,
  });
}

describe("dispatch staffs the work item's owner from the latest stored roster", () => {
  test("the owner's roster id and name, never a literal role", async () => {
    expect(await staffingWith(DEVELOPER).staff(task())).toEqual({
      kind: "staffed",
      staff: { role: { id: DEVELOPER, name: "Expense Report Tool Developer" }, model },
    });
  });

  test.each([
    { case: "no owner", owner: null, rows: LATEST_ROSTER, reason: "the work item has no owner role" },
    { case: "the row is gone", owner: "absent" as const, rows: LATEST_ROSTER, reason: "the work item row is gone" },
    { case: "an owner outside the latest roster", owner: "66666666-6666-4666-8666-666666666666", rows: LATEST_ROSTER, reason: "is not in roster revision 2" },
    { case: "no roster at all", owner: DEVELOPER, rows: [], reason: "the stored roster is not a valid roster" },
  ])("$case: owner-unresolved, no default role", async ({ owner, rows, reason }) => {
    const staffed = await staffingWith(owner, rows).staff(task());
    expect(staffed.kind).toBe("owner-unresolved");
    if (staffed.kind !== "owner-unresolved") return;
    expect(staffed.ownerRoleId).toBe(owner === "absent" ? null : owner);
    expect(staffed.rosterRevision).toBe(rows.length > 0 ? 2 : null);
    expect(staffed.reason).toContain(reason);
  });
});

// t-context-overflow-routing: a task an attempt of which overflowed a window is never staffed on
// that model again, nor on one no larger.
describe("a task whose attempt overflowed a context window is staffed on a model whose window is larger", () => {
  const wide: ResolvedModel = { ...model, modelId: "wide-model", modelConfig: { ...model.modelConfig, id: "wide-model", maxContextTokens: 200_000 } };

  function staffingOffering(wider: ResolvedModel | null, asked: number[]) {
    return createAgentStaffing({
      ownerOf: async () => ({ kind: "found", ownerRoleId: DEVELOPER }),
      latestRosterRows: async () => LATEST_ROSTER,
      latestRosterRevision: async () => 2,
      resolveWiderModel: (_task, windowTokens) => {
        asked.push(windowTokens);
        return wider;
      },
      resolveModel: () => model,
    });
  }

  test("the overflowed window recorded on the task: the larger-window model, never the routed one", async () => {
    const asked: number[] = [];
    const staffed = await staffingOffering(wide, asked).staff({ ...task(), overflowedWindowTokens: 32_000 });
    expect(staffed).toMatchObject({ kind: "staffed", staff: { model: { modelId: "wide-model" } } });
    expect(asked).toEqual([32_000]);
  });

  // t-overflow-edges: a catalog with nothing larger is a typed outcome the dispatch gives the task up
  // on, never a throw read as Ashara's fault.
  test("none larger in the catalog: no-wider-model naming the window, never a throw and never a model the task is known not to fit", async () => {
    const staffed = await staffingOffering(null, []).staff({ ...task(), overflowedWindowTokens: 32_000 });
    expect(staffed).toEqual({ kind: "no-wider-model", overflowedWindowTokens: 32_000 });
  });

  test("no overflow recorded: the routed model, and no larger one is asked for", async () => {
    const asked: number[] = [];
    expect(await staffingOffering(wide, asked).staff(task())).toMatchObject({ kind: "staffed", staff: { model: { modelId: "unused-model" } } });
    expect(asked).toEqual([]);
  });
});
