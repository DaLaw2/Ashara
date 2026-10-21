import { describe, expect, test } from "vitest";
import { OPEN_WORK_ITEM_STATUSES, SETTLED_WORK_ITEM_STATUSES, WORK_ITEM_STATUSES } from "./work-item-status.js";

describe("the open and settled halves of the work item statuses", () => {
  test("every status is in exactly one half, and the halves together are every status", () => {
    for (const status of WORK_ITEM_STATUSES) {
      const halves = [OPEN_WORK_ITEM_STATUSES.includes(status), SETTLED_WORK_ITEM_STATUSES.includes(status)].filter(Boolean);
      expect({ status, halves: halves.length }).toEqual({ status, halves: 1 });
    }
    expect([...OPEN_WORK_ITEM_STATUSES, ...SETTLED_WORK_ITEM_STATUSES].sort()).toEqual([...WORK_ITEM_STATUSES].sort());
  });

  test("neither half is empty: a work item can both await work and be done with", () => {
    expect(OPEN_WORK_ITEM_STATUSES.length).toBeGreaterThan(0);
    expect(SETTLED_WORK_ITEM_STATUSES.length).toBeGreaterThan(0);
  });
});
