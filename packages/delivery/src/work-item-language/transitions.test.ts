import { describe, expect, test } from "vitest";
import { WORK_ITEM_STATUSES } from "./work-item-status.js";
import type { WorkItemStatus } from "./work-item-status.js";
import { OUTBOUND_TRANSITIONS, canTransitionTo } from "./transitions.js";

describe("the work item machine, walked from its own lists", () => {
  test("every status reaches Abandoned, the one status with no way out", () => {
    const terminal = WORK_ITEM_STATUSES.filter((status) => OUTBOUND_TRANSITIONS[status].length === 0);
    expect(terminal).toEqual(["Abandoned"]);

    for (const start of WORK_ITEM_STATUSES) {
      const seen = new Set<WorkItemStatus>([start]);
      const frontier: WorkItemStatus[] = [start];
      for (let from = frontier.pop(); from !== undefined; from = frontier.pop()) {
        for (const to of OUTBOUND_TRANSITIONS[from]) {
          expect(canTransitionTo(from, to)).toBe(true);
          if (!seen.has(to)) {
            seen.add(to);
            frontier.push(to);
          }
        }
      }
      expect(seen.has("Abandoned"), `${start} reaches Abandoned`).toBe(true);
    }
  });
});
