import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { latestRosterRevision, latestRosterRoles } from "@ashara/organization/roster";
import { releaseClearedBlocks, PlanningService, failWorkItem, giveUpWorkItem, recoverFailedItem, createAgentStaffing, adaptWorkItemRepo, WorkItemRowRepository, ProjectHaltRepository } from "@ashara/delivery";
import { parseWorkItemId, type DomainEvent } from "@ashara/shared";
import { memoryStepContainment, recordingLogger } from "@ashara/shared/testing";
import { replanStoreSuite } from "./replan-store-suite.js";

// A task given up is planned around. The rows, stores and scripted model are the shared plan
// revision fixture's (replan-store-suite.ts); no real LLM call is made.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const suite = replanStoreSuite(stub);
const { pipelineModel, replanner, planReports, blockReports, plannedProject, itemsOf, startTask, completeTask, projectRow, reportsOf, MERGE_COMMIT } = suite;

/** Starts, fails and gives up a task as a dispatch's failure and the failure router's abandonment do. */
async function giveUp(id: string, attempts: number): Promise<void> {
  await startTask(id);
  const repo = adaptWorkItemRepo(new WorkItemRowRepository(suite.db));
  const task = await PlanningService.findWorkItem(repo, parseWorkItemId(id, "test"));
  if (task === null) throw new Error(`task ${id} not found`);
  failWorkItem(task, { source: "task_failed", reason: "the check author's red run kept failing" }, { kind: "retryable", ground: "work" });
  await PlanningService.saveWorkItem(repo, task, "InProgress");
  const failure = { detail: "red run on the foundation: REJECTED, the set: no check of the set fails on the foundation", raw: {} };
  const decision = await recoverFailedItem(
    {
      logger: recordingLogger(),
      workItemRepo: repo,
      eventPublisher: { publish: async () => {} },
      failureRouter: { route: () => ({ action: "abandon", reason: `the task failed ${attempts} time(s)`, attempts, failure }) },
    },
    task,
    failure,
    { kind: "retryable", ground: "work" },
  );
  expect(decision).toBe("abandon");
}

/** Pending tasks of our projects only, gated as the core loop gates them. */
async function gateOurs(): Promise<void> {
  const projects = new ProjectHaltRepository(suite.db);
  await PlanningService.gate(
    adaptWorkItemRepo(new WorkItemRowRepository(suite.db)),
    { listActiveIds: async () => (await projects.listActiveIds()).filter((id) => suite.ourProjects.has(id)), block: (id, cause) => projects.block(id, cause) },
    { publish: async () => {} },
    memoryStepContainment(() => true),
    recordingLogger(),
  );
}

// A task the failure router gave up would park every task depending on it as
// dependency_unsatisfiable, each for the operator. The project is held and its plan repaired instead.
describe("a task the team gives up is planned around", () => {
  test("the project is held, no dependent is parked, and a repair supersedes the open work around the given-up task and is reported once", async () => {
    const { projectId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const check = first.find((i) => i.origin === "check");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || check === undefined || harbour === undefined) throw new Error("the first plan is not Sprint 0, a check task and a task");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await suite.db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);

    await giveUp(check.id, 3);

    expect(await new ProjectHaltRepository(suite.db).listActiveIds()).not.toContain(projectId);
    await gateOurs();
    const held = await itemsOf(projectId);
    expect(held.find((i) => i.id === harbour.id)?.status).toBe("Pending");
    expect(held.filter((i) => z.object({ source: z.literal("dependency_unsatisfiable") }).safeParse(i.reason).success)).toEqual([]);

    const mock = pipelineModel();
    const outcomes = await replanner().runPending();

    expect(outcomes).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair", newEnvironment: false }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes(`after 3 attempt(s)`) && p.includes("no check of the set fails on the foundation"))).toBe(true);
    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === check.id)).toMatchObject({ status: "Abandoned", reason: { source: "failure_given_up" } });
    expect(after.find((i) => i.id === harbour.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: null, repairOf: [check.id] },
    });
    expect(after.some((i) => i.title === "Book a harbour class by its date" && i.status === "Pending")).toBe(true);
    const revisions = await suite.db.execute(sql`SELECT revision, kind, requested_by AS "requestedBy" FROM plan_revisions WHERE project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ revision: 2, kind: "repair", requestedBy: null }]);
    const repairs = await suite.db.execute(sql`SELECT work_item_id AS "id", plan_revision_id IS NOT NULL AS "answered" FROM plan_repairs WHERE project_id = ${projectId}`);
    expect(repairs.rows).toEqual([{ id: check.id, answered: true }]);
    expect(await new ProjectHaltRepository(suite.db).listActiveIds()).toContain(projectId);

    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    expect(await planReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    const report = reports[reports.length - 1];
    expect(report?.inReplyTo).toBeNull();
    expect(report?.body).toContain(`- ${check.title}`);
    expect(report?.body).toContain("what you asked for has not changed");
    expect(await replanner().runPending()).toEqual([]);
  });

  // A check task given up for a cause the
  // failure router never saw (here a dispute past its bound) is repaired, never left for a person.
  test("a check task given up past its dispute bound is repaired like any give-up, with the dispute as its evidence", async () => {
    const { projectId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const check = first.find((i) => i.origin === "check");
    if (sprint0 === undefined || check === undefined) throw new Error("the first plan is not Sprint 0 and a check task");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await suite.db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);

    await startTask(check.id);
    const repo = adaptWorkItemRepo(new WorkItemRowRepository(suite.db));
    const task = await PlanningService.findWorkItem(repo, parseWorkItemId(check.id, "test"));
    if (task === null) throw new Error(`task ${check.id} not found`);
    giveUpWorkItem(task, { source: "check_disputed", checkTaskId: check.id, checkName: "books", reason: "disputed 3 time(s), past the bound of 2: the check reads a file no task writes" });
    await PlanningService.saveWorkItem(repo, task, "InProgress");

    expect(await new ProjectHaltRepository(suite.db).listActiveIds()).not.toContain(projectId);
    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair" }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("the check reads a file no task writes"))).toBe(true);
    expect(await new ProjectHaltRepository(suite.db).listActiveIds()).toContain(projectId);
  });

  test("past the bound of repairs the next abandonment blocks the project with one report naming the task given up", async () => {
    const { projectId } = await plannedProject();
    const sprint0 = (await itemsOf(projectId)).find((i) => i.origin === "sprint0");
    if (sprint0 === undefined) throw new Error("the first plan has no Sprint 0");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);

    const givenUp: string[] = [];
    for (const round of [1, 2, 3]) {
      const open = (await itemsOf(projectId)).find((i) => i.origin === "check" && i.status === "Pending");
      if (open === undefined) throw new Error(`round ${round}: no open check task to give up`);
      givenUp.push(open.title);
      await giveUp(open.id, 3);
      pipelineModel();
      const outcomes = await replanner().runPending();
      if (round < 3) {
        expect(outcomes, `round ${round}`).toMatchObject([{ kind: "revised", cause: "repair", revision: round + 1 }]);
        expect(await planReports().runPending()).toMatchObject([{ kind: "posted" }]);
      } else {
        expect(outcomes).toMatchObject([{ kind: "project-blocked", projectId, cause: { category: "plan_repair", errorClass: "PlanRepairBoundReached" } }]);
      }
    }

    expect(await projectRow(projectId)).toMatchObject({ status: "blocked", category: "plan_repair" });
    await gateOurs();
    const items = await itemsOf(projectId);
    expect(items.filter((i) => z.object({ source: z.literal("dependency_unsatisfiable") }).safeParse(i.reason).success)).toEqual([]);
    const before = (await reportsOf(projectId)).length;
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await blockReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(before + 1);
    const body = reports[reports.length - 1]?.body ?? "";
    expect(body).toContain(`"${givenUp[2] ?? ""}", after`);
    expect(body).toContain("Ashara recorded why it was given up as this: ");
    expect(body).not.toContain(givenUp[0] ?? "");
  });
});

// A task no roster role can work is never parked at Blocked until a
// newer roster revision, which no production path writes (recordFirstRoster refuses any revision
// but 1). It is given up instead, and the repair staffs its new tasks.
describe("a task no roster role can work is planned around, never left waiting", () => {
  test("staffing finds no owner; the sweep gives the Blocked task up; the repair re-plans it with an owner the staffing resolves", async () => {
    const { projectId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || harbour === undefined) throw new Error("the first plan is not Sprint 0 and a task");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await suite.db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);
    // A task planned before owners were assigned: no work kind and no owner.
    await suite.db.execute(sql`UPDATE work_items SET owner_role_id = NULL, work_kind = NULL WHERE id = ${harbour.id}`);

    const workItems = new WorkItemRowRepository(suite.db);
    const staffing = createAgentStaffing({
      async ownerOf(taskId) {
        const row = await workItems.findById(taskId);
        return row === null ? { kind: "absent" } : { kind: "found", ownerRoleId: row.ownerRoleId };
      },
      latestRosterRows: (id) => latestRosterRoles(suite.db, id),
      latestRosterRevision: (id) => latestRosterRevision(suite.db, id),
      resolveWiderModel: () => null,
      resolveModel: () => suite.gateway.resolveModel("Strong", "agent-runner"),
    });
    const staffOf = (id: string) =>
      staffing.staff({ id: parseWorkItemId(id, "test"), projectId, title: "t", epicId: null, overflowedWindowTokens: null, dispatchCount: 1, attempt: 1, workKind: "implementation", successCriteria: [] });
    const unresolved = await staffOf(harbour.id);
    if (unresolved.kind !== "owner-unresolved") throw new Error(`expected owner-unresolved, got ${unresolved.kind}`);

    // A Blocked owner_unresolved row, as a stored row from an earlier dispatch holds it.
    await startTask(harbour.id);
    const reason = { source: "owner_unresolved", ownerRoleId: unresolved.ownerRoleId, rosterRevision: unresolved.rosterRevision, reason: unresolved.reason };
    await suite.db.execute(sql`UPDATE work_items SET status = 'Blocked', blocked_reason = ${JSON.stringify(reason)}::jsonb WHERE id = ${harbour.id}`);
    expect(await latestRosterRevision(suite.db, projectId)).toBe(1);

    const published: DomainEvent[] = [];
    const left = await releaseClearedBlocks({
      logger: recordingLogger(),
      workItemRepo: adaptWorkItemRepo(workItems),
      eventStore: { publish: async (event: DomainEvent) => void published.push(event) },
      projects: { listActiveIds: async () => [projectId], get: (id) => new ProjectHaltRepository(suite.db).get(id) },
      workdirBase: tmpdir(),
      containment: memoryStepContainment(() => true),
    });

    expect(left).toBe(1);
    expect(published.map((e) => e.eventType)).toEqual(["work_item.given_up"]);
    const givenUp = await PlanningService.findWorkItem(adaptWorkItemRepo(workItems), parseWorkItemId(harbour.id, "test"));
    expect(givenUp).toMatchObject({ status: "Abandoned", blockedReason: reason });

    const mock = pipelineModel();
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", projectId, revision: 2, cause: "repair" }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("No role of the team's roster could be assigned it"))).toBe(true);
    const repaired = (await itemsOf(projectId)).find((i) => i.title === "Book a harbour class by its date" && i.status === "Pending");
    if (repaired === undefined) throw new Error("the repair planned no new task");
    expect((await staffOf(repaired.id)).kind).toBe("staffed");
    expect(await new ProjectHaltRepository(suite.db).listActiveIds()).toContain(projectId);
  });
});
