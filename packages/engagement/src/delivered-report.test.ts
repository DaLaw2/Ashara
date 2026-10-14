import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { DeliveredReports } from "./delivered-report.js";
import type { DeliveredReportStore } from "./delivered-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000021", "test");
const MAIN = "c".repeat(40);
const MERGE_A = "a".repeat(40);

type Due = Awaited<ReturnType<DeliveredReportStore["dueReports"]>>[number];

async function render(due: Due): Promise<string> {
  const posted: string[] = [];
  const reports = new DeliveredReports({
    dueReports: async () => [due],
    postReport: async (sweepId, body) => {
      expect(sweepId).toBe(due.sweepId);
      posted.push(body);
      return "posted";
    },
  });
  expect(await reports.runPending()).toEqual([{ kind: "posted", projectId }]);
  expect(posted).toHaveLength(1);
  return posted[0];
}

// Story s-independent-verify-m1 W7 (eighth run E3): the delivered report, every line from a record.
describe("the delivered report", () => {
  test("names each goal task with how its record says it closed, and each vision item no check covers as not checked", async () => {
    const body = await render({
      sweepId: "s1",
      projectId,
      mainCommit: MAIN,
      goals: [
        { title: "Store and read keys", close: { kind: "merged", commit: MERGE_A } },
        { title: "Delete keys", close: { kind: "already-delivered", commit: MERGE_A, by: "Store and read keys" } },
        { title: "List keys", close: { kind: "unrecorded-kind", commit: MERGE_A } },
      ],
      checked: ["Store and read keys", "Delete keys", "List keys"],
      unchecked: [],
      givenUp: [],
      vision: {
        kind: "recorded",
        items: ["A key can be stored and read back", "A key can be deleted", "Concurrent writers never corrupt the store"],
        checked: ["A key can be stored and read back", "A key can be deleted"],
      },
    });
    expect(body).toContain(`the environment's test and the stored checks of 3 completed tasks passed together on main, commit ${MAIN}`);
    expect(body).toContain(`"Store and read keys": built and merged, commit ${MERGE_A}.`);
    expect(body).toContain(`"Delete keys": already delivered when its turn came; nothing of its own was merged.`);
    expect(body).toContain(`the merge of "Store and read keys".`);
    expect(body).toContain(`"List keys": closed on commit ${MERGE_A}; whether it was merged or already delivered there is not on record.`);
    expect(body).toContain("not checked");
    expect(body).toContain("- Concurrent writers never corrupt the store");
    expect(body).not.toContain("- A key can be deleted\n");
  });

  test("with no coverage on record, nothing is stated as checked", async () => {
    const body = await render({
      sweepId: "s2",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      vision: { kind: "unrecorded" },
    });
    expect(body).toContain("is not on record for this plan, so none of it is stated as checked");
  });

  test("every vision item covered is said so, and nothing else is claimed", async () => {
    const body = await render({
      sweepId: "s3",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      vision: { kind: "recorded", items: ["Keys can be stored"], checked: ["Keys can be stored"] },
    });
    expect(body).toContain("Every item of what you asked for is covered by at least one stored check that passed on main.");
    expect(body).not.toContain("not checked");
  });

  test("a completed task with no stored check is listed as not checked, apart from what passed, and the opening claims only what ran", async () => {
    const body = await render({
      sweepId: "s4",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: ["Set up the product's module root"],
      givenUp: ["Shard the store"],
      vision: { kind: "recorded", items: ["Keys can be stored"], checked: ["Keys can be stored"] },
    });
    const [opening] = body.split("\n\n");
    expect(opening).toBe(
      `Your project is delivered. Every task of the plan is settled, and the environment's test and the stored checks of ` +
        `1 completed task passed together on main, commit ${MAIN}.`,
    );
    expect(opening).not.toContain("every");
    expect(body).toContain(`These tasks are done but not checked by a stored check: none was written for them, so nothing in the run above confirms them:\n- "Set up the product's module root"`);
    expect(body).toContain(`These tasks were given up, and the plan was revised around them:\n- "Shard the store"`);
  });

  test("with no stored check run at all, the opening says only the environment's test passed", async () => {
    const body = await render({
      sweepId: "s5",
      projectId,
      mainCommit: MAIN,
      goals: [],
      checked: [],
      unchecked: ["Set up the product's module root"],
      givenUp: [],
      vision: { kind: "unrecorded" },
    });
    expect(body).toContain(`the environment's test passed on main, commit ${MAIN}; no stored check of any task ran with it.`);
    expect(body).not.toContain("passed together");
  });
});
