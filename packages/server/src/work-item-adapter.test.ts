import { describe, expect, test } from "vitest";
import { InvalidId } from "@ashara/shared";
import { rowToWorkItem } from "./work-item-adapter.js";

type Row = Parameters<typeof rowToWorkItem>[0];

const VALID = "00000000-0000-4000-8000-000000000001";

function row(overrides: Partial<Row>): Row {
  const now = new Date();
  return {
    id: VALID,
    level: "Task",
    status: "Pending",
    parentId: null,
    title: "t",
    description: null,
    taskSpec: null,
    northStar: null,
    successCriteria: null,
    blockedReason: null,
    projectId: VALID,
    dispatchCount: 0,
    workKind: null,
    ownerRoleId: null,
    environmentStatement: null,
    environmentStatementVersion: null,
    infrastructureFaults: 0,
    mergeCommit: null,
    mergeKind: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("rowToWorkItem parses every id column", () => {
  test.each([
    ["id", "work_items.id", "WorkItemId"],
    ["parentId", "work_items.parent_id", "WorkItemId"],
    ["projectId", "work_items.project_id", "ProjectId"],
  ] as const)("a malformed %s throws InvalidId naming %s", (column, field, brand) => {
    expect(() => rowToWorkItem(row({ [column]: "not-a-uuid" }))).toThrow(InvalidId);
    expect(() => rowToWorkItem(row({ [column]: "not-a-uuid" }))).toThrow(`Invalid ${brand} in ${field}`);
  });

  test("a well-formed row keeps its ids", () => {
    const item = rowToWorkItem(row({ parentId: VALID }));
    expect(item).toMatchObject({ id: VALID, parentId: VALID, projectId: VALID });
  });
});
