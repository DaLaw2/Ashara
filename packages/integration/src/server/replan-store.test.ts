import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { TaskCheckRepository } from "@ashara/quality";
import { createReplanStore, ProjectHaltRepository } from "@ashara/delivery";
import { memoryStepContainment, recordingLogger, type ProjectId } from "@ashara/shared";
import { replanStoreSuite } from "./replan-store-suite.js";

// A late client change is planned. The rows, stores and scripted model are the shared plan
// revision fixture's (replan-store-suite.ts); no real LLM call is made.

const stub = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek: () => () => stub.model }));

const suite = replanStoreSuite(stub);
const { pipelineModel, replanner, planReports, blockReports, plannedProject, contradict, itemsOf, startTask, completeTask, dependenciesOf, projectRow, reportsOf, MERGE_COMMIT, TWO_QUESTION_INTAKE } = suite;

// Answers read after the first plan was written and before it was reported.
describe("the client is told one plan, and never what the team will now do on a halted project", () => {
  test("a change read between the first plan and its report gives one founded report of the revised plan, and no halt", async () => {
    const { projectId, questionId } = await plannedProject({ reported: false });
    const answerId = await contradict(projectId, questionId);

    // The plan the client was just told must change is not reported meanwhile.
    expect(await planReports().runPending()).toEqual([]);
    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);

    // Before the fix: every item counted, two Sprint 0 tasks, two scaffolds, two reviews: PlanReportUnfounded.
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    expect(await planReports().runPending()).toEqual([]);
    expect(await projectRow(projectId)).toEqual({ status: "active", awaiting: [], category: null });

    const reports = await reportsOf(projectId);
    const plans = reports.filter((m) => m.body.startsWith("Ashara has made the first plan"));
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (plan === undefined) throw new Error("no first-plan report");
    expect(plan.body).toContain("1 epic (");
    expect(plan.body).toContain("split into 1 task for what you asked for.");
    expect(plan.body).toContain("(1 check task)");
    expect(plan.body).toContain(`Because you said "No, the hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(reports.some((m) => m.body.includes("The team will now do") || m.body.includes("set aside"))).toBe(false);
    // The revision is recorded as told by that one report, so it is never told again on its own.
    const revisions = await suite.db.execute(sql`SELECT r.requested_by AS "requestedBy", t.report_id AS "reportId" FROM plan_revisions r
        LEFT JOIN told_reports t ON t.subject_kind = 'plan-revision' AND t.subject_id = r.id WHERE r.project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ requestedBy: answerId, reportId: plan.id }]);
  });

  // Changing answers folded into one revision are each named in the first-plan report.
  test("two changing answers read before the first plan's report are one revision, and the report names both", async () => {
    const { projectId, questionIds } = await plannedProject({ reported: false, intake: TWO_QUESTION_INTAKE });
    const [studioQuestion, teacherQuestion] = questionIds;
    if (studioQuestion === undefined || teacherQuestion === undefined) throw new Error("intake posted fewer than two questions");
    const first = await contradict(projectId, studioQuestion);
    const second = await contradict(projectId, teacherQuestion, { body: "Yes, name the teacher.", statement: "Each class shows its teacher." });
    expect((await projectRow(projectId)).awaiting).toEqual([first, second]);

    const mock = pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("in 2 messages") && p.includes("Each class shows its teacher.") && p.includes("The hill studio opens first."))).toBe(true);
    expect((await projectRow(projectId)).awaiting).toEqual([]);
    const taken = await suite.db.execute(sql`
      SELECT ch.requested_by AS "answerId" FROM correction_holds ch JOIN plan_revisions r ON r.id = ch.plan_revision_id
      WHERE r.project_id = ${projectId} AND r.revision = 2 ORDER BY ch.created_at`);
    expect(taken.rows).toEqual([{ answerId: first }, { answerId: second }]);

    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "first-plan" }]);
    const plan = (await reportsOf(projectId)).find((m) => m.body.startsWith("Ashara has made the first plan"));
    expect(plan?.body).toContain("This plan already takes in your 2 messages that changed it.");
    expect(plan?.body).toContain(`- Because you said "No, the hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(plan?.body).toContain(`- Because you said "Yes, name the teacher.", work proceeds on: Each class shows its teacher.`);
  });

  test("a revision recorded as taking in an answer its summary does not name is not reported, and blocks the project", async () => {
    const { projectId, questionIds } = await plannedProject({ reported: false, intake: TWO_QUESTION_INTAKE });
    const [studioQuestion, teacherQuestion] = questionIds;
    if (studioQuestion === undefined || teacherQuestion === undefined) throw new Error("intake posted fewer than two questions");
    await contradict(projectId, studioQuestion);
    await contradict(projectId, teacherQuestion, { body: "Yes, name the teacher.", statement: "Each class shows its teacher." });
    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    // A record in the form a COALESCE update leaves: the summary names one change of the two taken in.
    await suite.db.execute(sql`
      UPDATE plan_revisions SET summary = jsonb_set(summary, '{changes}', (summary->'changes') - 1) WHERE project_id = ${projectId}`);

    const outcomes = await planReports().runPending();

    expect(outcomes).toMatchObject([{ kind: "project-blocked", projectId, cause: { errorClass: "RevisionChangesUnrecorded" } }]);
    expect((await reportsOf(projectId)).some((m) => m.body.startsWith("Ashara has made the first plan"))).toBe(false);
  });

  test("a revision of a halted project is told only after it resumes, after the pause and the resumption", async () => {
    const { projectId, questionId } = await plannedProject();
    await contradict(projectId, questionId);
    pipelineModel({ environmentChange: false });
    expect((await replanner().runPending()).map((o) => o.kind)).toEqual(["revised"]);
    const projects = new ProjectHaltRepository(suite.db);
    await projects.block(projectId, { category: "fault", errorClass: "TestFault", reason: "TestFault: a halt written by the test" });

    expect(await planReports().runPending()).toEqual([]);
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect((await reportsOf(projectId)).some((m) => m.body.includes("The team will now do"))).toBe(false);

    await projects.unblock(projectId, "operator-a", "checked the halt");
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);

    const bodies = (await reportsOf(projectId)).map((m) => m.body);
    const paused = bodies.findIndex((b) => b.startsWith("Work on this project is paused."));
    const resumed = bodies.findIndex((b) => b.startsWith("Work on this project has resumed"));
    const willDo = bodies.findIndex((b) => b.includes("The team will now do"));
    expect(paused).toBeGreaterThan(-1);
    expect(paused).toBeLessThan(resumed);
    expect(resumed).toBeLessThan(willDo);
    expect(bodies[paused]).not.toContain("TestFault");
  });
});

describe("a late client change is planned", () => {
  test("after in-flight work ends, a new revision supersedes open work, keeps completed work, clears the flag and is reported once", async () => {
    const { projectId, questionId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const check = first.find((i) => i.origin === "check");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || check === undefined || harbour === undefined) throw new Error("the first plan is not Sprint 0, a check task and a task");
    const epic = first.find((i) => i.level === "Epic");
    if (epic === undefined) throw new Error("the first plan has no Epic");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await suite.db.execute(sql`UPDATE work_items SET merge_commit = ${MERGE_COMMIT} WHERE id = ${sprint0.id}`);
    // The check task is in flight when the client's change arrives; its Epic is InProgress
    // from the first started task and stays so while any child is open.
    await startTask(check.id);

    const answerId = await contradict(projectId, questionId);
    expect((await projectRow(projectId)).awaiting).toEqual([answerId]);

    pipelineModel();
    // The revision waits for the check task in flight, which cites A1; the work not started that
    // cites A1 is held (parked) meanwhile, and the scaffold, which cites no item, is not.
    expect(await replanner().runPending()).toEqual([]);
    const inFlight = (i: (typeof first)[number]) => i.id === check.id || i.id === epic.id;
    const held = (i: (typeof first)[number]) => i.origin === "decomposition" || i.origin === "review";
    expect(await itemsOf(projectId)).toEqual(
      first.map((i) =>
        held(i)
          ? { ...i, status: "Blocked", reason: expect.objectContaining({ source: "correction_pending", affected: ["A1"], visionVersion: 2 }) }
          : { ...i, status: i.id === sprint0.id ? "Completed" : inFlight(i) ? "InProgress" : i.status },
      ),
    );

    await completeTask(check.id);
    expect((await itemsOf(projectId)).find((i) => i.id === epic.id)?.status).toBe("InProgress");
    const mock = pipelineModel({ environmentChange: false });
    const outcomes = await replanner().runPending();

    expect(outcomes).toEqual([{ kind: "revised", projectId, revision: 2, cause: "client-change", tasks: 4, superseded: 3, newEnvironment: false }]);
    const prompts = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt));
    expect(prompts.some((p) => p.includes("Already done, and kept") && p.includes(`merged as ${MERGE_COMMIT}`))).toBe(true);

    const after = await itemsOf(projectId);
    expect(after.find((i) => i.id === sprint0.id)?.status).toBe("Completed");
    expect(after.find((i) => i.id === check.id)?.status).toBe("Completed");
    expect(after.find((i) => i.id === harbour.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: answerId },
    });
    // The old Epic can no longer settle: it is closed with the work it held.
    expect(after.find((i) => i.id === epic.id)).toMatchObject({
      status: "Abandoned",
      reason: { source: "superseded", planRevision: 2, requestedBy: answerId },
    });
    const added = after.filter((i) => !first.some((f) => f.id === i.id));
    // Written in one transaction, so their created_at ties: compared in a fixed order.
    const shapes = added.map((i) => [i.level, i.origin, i.title]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    expect(shapes).toEqual([
      ["Epic", null, expect.any(String)],
      ["Task", "check", `Write the checks for "Open hill studio bookings"`],
      ["Task", "decomposition", "Open hill studio bookings"],
      ["Task", "product-scaffold", "Set up the product's layout"],
      ["Task", "review", "Review the plan's checks together against the vision"],
    ]);
    // No new environment task: the new work builds on the Sprint 0 already done. The first plan's
    // scaffold was still open, so it is superseded and the revision sets up the layout again on that
    // Sprint 0; the check and review tasks wait on it.
    const scaffold = added.find((i) => i.origin === "product-scaffold");
    if (scaffold === undefined) throw new Error("the revision planned no product scaffold");
    expect(await dependenciesOf(scaffold.id)).toEqual([sprint0.id]);
    for (const task of added.filter((i) => i.level === "Task" && i.id !== scaffold.id)) {
      expect(await dependenciesOf(task.id)).toContain(task.origin === "decomposition" ? sprint0.id : scaffold.id);
    }
    // The revision's check task names the task it decides by its stored id, and that task waits on it.
    const newCheck = added.find((i) => i.origin === "check");
    const newTask = added.find((i) => i.origin === "decomposition");
    if (newCheck === undefined || newTask === undefined) throw new Error("the revision planned no check task or no task");
    const checksFor = await suite.db.execute(sql`SELECT task_spec->>'checksFor' AS "checksFor" FROM work_items WHERE id = ${newCheck.id}`);
    expect(checksFor.rows).toEqual([{ checksFor: newTask.id }]);
    expect(await dependenciesOf(newTask.id)).toContain(newCheck.id);
    expect(await new TaskCheckRepository(suite.db).checkedTasksOf(newCheck.id)).toEqual([newTask.id]);

    const revisions = await suite.db.execute(sql`SELECT revision, requested_by AS "requestedBy" FROM plan_revisions WHERE project_id = ${projectId}`);
    expect(revisions.rows).toEqual([{ revision: 2, requestedBy: answerId }]);
    expect((await projectRow(projectId)).awaiting).toEqual([]);
    expect(await new ProjectHaltRepository(suite.db).listActiveIds()).toContain(projectId);

    const reportsBefore = (await reportsOf(projectId)).length;
    expect(await planReports().runPending()).toEqual([{ kind: "posted", projectId, subject: "plan-revision" }]);
    expect(await planReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(reportsBefore + 1);
    const report = reports[reports.length - 1];
    expect(report?.inReplyTo).toBe(answerId);
    expect(report?.body).toContain(`Because you said "No, the hill studio opens first.", work proceeds on: The hill studio opens first.`);
    expect(report?.body).toContain("- Open hill studio bookings");
    expect(report?.body).toContain("- Open harbour studio bookings");

    // Nothing is flagged any more: no second revision.
    expect(await replanner().runPending()).toEqual([]);
  });

  // A revision's checks are never red-run on Sprint 0's commit, which holds no product to build.
  test("a revision after the scaffold red-runs its checks on the layout's latest merge, never on the environment task merged before it", async () => {
    const { projectId, questionId } = await plannedProject();
    const first = await itemsOf(projectId);
    const sprint0 = first.find((i) => i.origin === "sprint0");
    const scaffold = first.find((i) => i.origin === "product-scaffold");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (sprint0 === undefined || scaffold === undefined || harbour === undefined) throw new Error("the first plan has no Sprint 0, scaffold or task");
    const merged = [
      { id: sprint0.id, commit: "1".repeat(40), minutesAgo: 30 },
      { id: scaffold.id, commit: "2".repeat(40), minutesAgo: 20 },
      { id: harbour.id, commit: "3".repeat(40), minutesAgo: 10 },
    ];
    for (const { id, commit, minutesAgo } of merged) {
      await startTask(id);
      await completeTask(id);
      // Completion times fixed apart: the order the merges landed on main.
      await suite.db.execute(sql`
        UPDATE work_items SET merge_commit = ${commit}, updated_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${id}`);
    }
    await contradict(projectId, questionId);
    pipelineModel({ environmentChange: false });
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", revision: 2, newEnvironment: false }]);

    const added = (await itemsOf(projectId)).filter((i) => !first.some((f) => f.id === i.id));
    expect(added.filter((i) => i.origin === "product-scaffold" || i.origin === "sprint0")).toEqual([]);
    const newCheck = added.find((i) => i.origin === "check");
    const review = added.find((i) => i.origin === "review");
    if (newCheck === undefined || review === undefined) throw new Error("the revision planned no check or review task");
    expect(await dependenciesOf(newCheck.id)).toEqual([harbour.id]);
    expect(await dependenciesOf(review.id)).toContain(harbour.id);
    const checks = new TaskCheckRepository(suite.db);
    expect(await checks.foundationOf(newCheck.id)).toEqual({ kind: "found", taskId: harbour.id, commit: "3".repeat(40) });

    // A check task whose only foundation merged before the product scaffold has no foundation: fail closed.
    await suite.db.execute(sql`UPDATE dependencies SET to_id = ${sprint0.id} WHERE from_id = ${newCheck.id}`);
    const before = await checks.foundationOf(newCheck.id);
    expect(before.kind).toBe("none");
    if (before.kind === "none") expect(before.reason).toContain("not after the project's product scaffold");
  });

  // What a revision need not plan again is what a completed task's stored checks decide, never what it cites.
  test.each([
    { stored: "no checks", decides: undefined },
    { stored: "a check that records no items it decides", decides: null },
    { stored: "a check deciding every item it cites", decides: "cited" },
  ] as const)("a completed task with $stored is exempt only for the items its stored checks decide", async ({ decides }) => {
    const { projectId, questionId } = await plannedProject();
    const first = await itemsOf(projectId);
    const check = first.find((i) => i.origin === "check");
    const harbour = first.find((i) => i.origin === "decomposition");
    if (check === undefined || harbour === undefined) throw new Error("the first plan has no check task or task");
    const spec = await suite.db.execute(sql`SELECT task_spec->'sources' AS sources FROM work_items WHERE id = ${check.id}`);
    const cited = z.array(z.object({ sources: z.array(z.object({ id: z.string(), text: z.string() })) })).parse(spec.rows)[0]?.sources ?? [];
    expect(cited.length).toBeGreaterThan(0);
    await startTask(harbour.id);
    await completeTask(harbour.id);
    if (decides !== undefined) {
      const recorded = decides === null ? null : JSON.stringify(cited.map((item) => item.id));
      await suite.db.execute(sql`
        INSERT INTO task_checks (project_id, task_id, check_task_id, revision, name, command, files, environment_version, decides)
        VALUES (${projectId}, ${harbour.id}, ${check.id}, 1, 'holds', 'true', '[]'::jsonb, ${"e".repeat(64)}, ${recorded}::jsonb)`);
    }
    await contradict(projectId, questionId);
    const mock = pipelineModel({ environmentChange: false });
    expect(await replanner().runPending()).toMatchObject([{ kind: "revised", revision: 2 }]);

    const revision = mock.doGenerateCalls.map((call) => JSON.stringify(call.prompt)).find((p) => p.includes("changed what is built after work began"));
    // Every guarantee the replaced work cited decided by a stored check: nothing is left to plan, so no planner is asked.
    if (decides === "cited") {
      expect(revision).toBeUndefined();
      return;
    }
    if (revision === undefined) throw new Error("no revision prompt was sent");
    const listed = /a plan that leaves one uncited is rejected: ([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)\./.exec(revision)?.[1]?.split(", ") ?? [];
    // G1, the guarantee the answer leaves as it was: a revision plans it again unless a stored check decides it.
    expect(cited.map((item) => item.id)).toContain("G1");
    expect(listed).toContain("G1");
  });

  test("an environment change plans a new environment task, and the old one stays Completed", async () => {
    const { projectId, questionId } = await plannedProject();
    const sprint0 = (await itemsOf(projectId)).find((i) => i.origin === "sprint0");
    if (sprint0 === undefined) throw new Error("the first plan has no Sprint 0");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await contradict(projectId, questionId);

    pipelineModel({ environmentChange: true });
    const outcomes = await replanner().runPending();

    expect(outcomes).toMatchObject([{ kind: "revised", revision: 2, newEnvironment: true }]);
    const items = await itemsOf(projectId);
    const environments = items.filter((i) => i.origin === "sprint0");
    expect(environments.map((i) => i.status)).toEqual(["Completed", "Pending"]);
    const added = items.find((i) => i.title === "Open hill studio bookings");
    if (added === undefined) throw new Error("the revision planned no task");
    expect(await dependenciesOf(added.id)).not.toContain(sprint0.id);
  });

  test("the store grades a completed task by the model its last completed attempt ran on, the higher of its two grades; a task with none is unrecorded", async () => {
    const { projectId, questionId } = await plannedProject();
    const sprint0 = (await itemsOf(projectId)).find((i) => i.origin === "sprint0");
    if (sprint0 === undefined) throw new Error("the first plan has no Sprint 0");
    await startTask(sprint0.id);
    await completeTask(sprint0.id);
    await suite.db.execute(sql`
      INSERT INTO dev_sessions (id, task_id, phase, attempt_prompt_digest, attempt_terminal, attempt_turns, attempt_provider, attempt_model, attempt_cell)
      VALUES (${randomUUID()}, ${sprint0.id}, 'Completed', ${"a".repeat(64)}, 'finished:done', 3, 'deepseek', 'deepseek-flash', 'base-cell')`);
    await contradict(projectId, questionId);

    const store = createReplanStore(suite.db, recordingLogger());
    const project = (await store.projectsAwaitingReplan()).find((p) => p.projectId === projectId);
    if (project === undefined || !("items" in project)) throw new Error("the project does not await a revision");
    const gradeOf = (id: string) => project.items.find(({ item }) => item.id === id)?.attemptGrade;
    // deepseek-flash is Strong reasoning and Light without: the mode the attempt ran in is not recorded.
    expect(gradeOf(sprint0.id)).toEqual({ kind: "graded", model: "deepseek-flash", grade: "Strong" });
    const unstarted = project.items.find(({ item }) => item.level === "Task" && item.id !== sprint0.id);
    if (unstarted === undefined) throw new Error("the first plan has no other task");
    expect(unstarted.attemptGrade).toMatchObject({ kind: "unrecorded" });
  });

  test("one project whose work items do not read is that project's fault alone: every other project is still revised", async () => {
    const unreadable = await plannedProject();
    const healthy = await plannedProject();
    await contradict(unreadable.projectId, unreadable.questionId);
    await contradict(healthy.projectId, healthy.questionId);
    await suite.db.execute(sql`UPDATE work_items SET success_criteria = '{"not": "criteria"}'::jsonb WHERE project_id = ${unreadable.projectId} AND level = 'Task'`);
    pipelineModel();

    const containment = memoryStepContainment(() => false);
    const outcomes = await replanner(containment).runPending();

    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "step-faulted", step: "replan", subjectId: unreadable.projectId, error: expect.stringContaining("WorkItemRowCorrupt") }),
      expect.objectContaining({ kind: "revised", projectId: healthy.projectId }),
    ]);
    expect(containment.recorded.get(`replan/${unreadable.projectId}`)).toMatchObject({ faults: 1 });
  });

  test("past the bound of revisions the project is blocked, not revised, and the client is told once", async () => {
    const { projectId, questionId } = await plannedProject();
    const answerId = await contradict(projectId, questionId);
    // Three earlier revisions, each already reported: only the block is due.
    for (const revision of [2, 3, 4]) {
      const report = await suite.db.execute(sql`INSERT INTO client_messages (project_id, direction, kind, body)
        VALUES (${projectId}, 'outbound', 'report', 'earlier revision') RETURNING id`);
      const [row] = z.array(z.object({ id: z.string() })).parse(report.rows);
      await suite.db.execute(sql`WITH revision AS (
          INSERT INTO plan_revisions (project_id, revision, vision_version, requested_by, summary)
          VALUES (${projectId}, ${revision}, 1, ${answerId}, '{}'::jsonb) RETURNING id)
        INSERT INTO told_reports (subject_kind, subject_id, project_id, report_id)
        SELECT 'plan-revision', revision.id, ${projectId}, ${row?.id ?? null} FROM revision`);
    }
    const mock = pipelineModel();

    const outcomes = await replanner().runPending();

    expect(outcomes).toMatchObject([{ kind: "project-blocked", projectId, cause: { category: "replan_bound", errorClass: "ReplanBoundReached" } }]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await projectRow(projectId)).toEqual({ status: "blocked", awaiting: [answerId], category: "replan_bound" });
    const before = (await reportsOf(projectId)).length;
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(await blockReports().runPending()).toEqual([]);
    const reports = await reportsOf(projectId);
    expect(reports).toHaveLength(before + 1);
    // The recorded kind in the client's words; the replanner's ReplanBoundReached chain stays in the record.
    expect(reports[reports.length - 1]?.body).toContain("Ashara recorded the cause as this: the plan has been revised for your changes");
    expect(reports[reports.length - 1]?.body).not.toContain("ReplanBoundReached");
  });

  // A revision whose every attempt got no usable answer from the planning model is the model's
  // failure, not Ashara's machinery: the halt says so, never "a step of Ashara's own work failed".
  test("a revision the planning model never answers usably halts as replan_stopped, and the client is told what failed", async () => {
    const { projectId, questionId } = await plannedProject();
    await contradict(projectId, questionId);
    pipelineModel({ revision: { notTasks: "the model's answer does not hold together" } });

    const kinds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) kinds.push(...(await replanner().runPending()).map((outcome) => outcome.kind));

    expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
    expect(await projectRow(projectId)).toMatchObject({ status: "blocked", category: "replan_stopped" });
    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    const reports = await reportsOf(projectId);
    const body = reports[reports.length - 1]?.body ?? "";
    expect(body).toContain(
      "Ashara recorded the cause as this: every attempt to revise the plan failed, the last because the model planning it gave no usable answer.",
    );
    expect(body).not.toContain("a step of Ashara's own work");
    expect(body).not.toContain("ReplanAttemptsExhausted");
  });

  // A cycle that counted the last attempt and stopped before its halt was written (a restart) leaves
  // the exhaustion on record: the next cycle halts from it, blamed as the counting cycle blamed it.
  test("a revision whose attempts ran out before its halt was written halts from its record, blamed by the failure it recorded", async () => {
    const counted = await plannedProject();
    await contradict(counted.projectId, counted.questionId);
    const legacy = await plannedProject();
    await contradict(legacy.projectId, legacy.questionId);
    const store = createReplanStore(suite.db, recordingLogger());
    for (let attempt = 0; attempt < 3; attempt += 1) await store.recordFailedAttempt(counted.projectId, "stub provider unavailable", "provider");
    // A row counted before failures named their party names no party.
    await suite.db.execute(sql`UPDATE projects SET replan_attempts = 3, replan_last_error = 'an earlier attempt failed' WHERE id = ${legacy.projectId}`);
    const mock = pipelineModel({ revision: { notTasks: "never asked" } });

    const outcomes = await replanner().runPending();

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["project-blocked", "project-blocked"]);
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await projectRow(counted.projectId)).toMatchObject({ status: "blocked", category: "replan_provider_failed" });
    expect(await projectRow(legacy.projectId)).toMatchObject({ status: "blocked", category: "fault" });
  });

  // The suite.gateway wraps every failure with no fallback left in ProviderError: one the provider's HTTP
  // error or silence caused is not the model's, and one Ashara's own code threw is Ashara's, never
  // counted toward the revision's bound.
  test("a revision whose provider fails every request halts as replan_provider_failed; a fault in Ashara's code is contained, never counted", async () => {
    const failingWith = async (thrown: Error): Promise<ProjectId> => {
      const { projectId, questionId } = await plannedProject();
      await contradict(projectId, questionId);
      stub.model = new MockLanguageModelV4({
        doGenerate: async () => {
          throw thrown;
        },
      });
      return projectId;
    };

    const unanswered = await failingWith(
      new APICallError({ message: "Service Unavailable", url: "https://stub.invalid/v1", requestBodyValues: {}, statusCode: 503, isRetryable: true }),
    );
    const kinds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) kinds.push(...(await replanner().runPending()).map((outcome) => outcome.kind));
    expect(kinds).toEqual(["failed", "failed", "project-blocked"]);
    expect(await projectRow(unanswered)).toMatchObject({ status: "blocked", category: "replan_provider_failed" });

    const broken = await failingWith(new TypeError("Cannot read properties of undefined"));
    const containment = memoryStepContainment(() => false);
    expect(await replanner(containment).runPending()).toEqual([
      expect.objectContaining({ kind: "step-faulted", step: "replan", subjectId: broken, error: expect.stringContaining("Cannot read properties") }),
    ]);
    // Waiting out its backoff, the project is not replanned again, and nothing was counted against it.
    expect(await replanner(containment).runPending()).toEqual([]);
    expect(await projectRow(broken)).toMatchObject({ category: null });
    const attempts = await suite.db.execute(sql`SELECT replan_attempts AS "attempts" FROM projects WHERE id = ${broken}`);
    expect(z.array(z.object({ attempts: z.number() })).parse(attempts.rows)).toEqual([{ attempts: 0 }]);

    expect((await blockReports().runPending()).map((o) => o.kind)).toEqual(["posted"]);
    const body = (await reportsOf(unanswered)).at(-1)?.body ?? "";
    expect(body).toContain(
      "Ashara recorded the cause as this: every attempt to revise the plan failed, the last because the service that runs the model planning it returned an error or did not answer, so no answer was read.",
    );
    expect(body).not.toContain("gave no usable answer");
  });
});
