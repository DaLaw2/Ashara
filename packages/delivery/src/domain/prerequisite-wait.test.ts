import { describe, expect, test } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import type { WorkItemStatus } from "../work-item-language/work-item-status.js";
import { deliveringTasks, resolveInterfaceEntries } from "./prerequisite-wait.js";
import type { InterfaceTable } from "./prerequisite-wait.js";
import type { WorkItem } from "./work-item.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000b1", "test");

const TABLE: InterfaceTable = [
  { key: "I1", text: "POST /loans" },
  { key: "I2", text: "GET /loans/{id}" },
  { key: "I3", text: "POST /loans" },
  { key: "I4", text: "I1" },
];

/** A decomposed task delivering the guarantee observed through `entries`. */
function task(entries: readonly string[], status: WorkItemStatus = "Pending"): WorkItem {
  return {
    id: createWorkItemId(),
    level: "Task",
    status,
    title: `delivers ${entries.join(", ")}`,
    projectId: PROJECT,
    overflowedWindowTokens: null,
    failureVerdict: { kind: "none" },
    dispatchCount: 0,
    workKind: "implementation",
    repairsTaskId: null,
    taskSpec: {
      origin: "decomposition",
      sources: [{ type: "guarantee", id: "G1", text: "loans are recorded", observation: "output", interface: [...entries], refutedBy: [] }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    events: [],
  };
}

describe("an entry a blocked finish names is resolved against the interface its brief showed: by key or exact text, never by a guess", () => {
  test("by its key, and by an entry's exact text that only one entry has", () => {
    expect(resolveInterfaceEntries(["I2"], TABLE)).toEqual({ kind: "resolved", keys: ["I2"] });
    expect(resolveInterfaceEntries([" GET /loans/{id} "], TABLE)).toEqual({ kind: "resolved", keys: ["I2"] });
    expect(resolveInterfaceEntries(["I2", "GET /loans/{id}"], TABLE)).toEqual({ kind: "resolved", keys: ["I2"] });
  });

  test("a name more than one entry answers to is refused, and so is one no entry answers to", () => {
    expect(resolveInterfaceEntries(["POST /loans"], TABLE)).toEqual({
      kind: "unresolved",
      problems: ['"POST /loans" could be any of the interface entries I1, I3: name one by its key'],
    });
    // A key that is also another entry's text is ambiguous too.
    expect(resolveInterfaceEntries(["I1"], TABLE)).toMatchObject({ kind: "unresolved" });
    expect(resolveInterfaceEntries(["DELETE /loans"], TABLE)).toEqual({
      kind: "unresolved",
      problems: ['"DELETE /loans" is the key or the text of no interface entry (I1, I2, I3, I4)'],
    });
    expect(resolveInterfaceEntries(["I2"], [])).toEqual({ kind: "unresolved", problems: ['"I2" names no interface entry: the vision records no public interface'] });
  });

  test("deliveringTasks finds the open tasks building the entry named by key or by its text, and none for a refused name", () => {
    const waiting = task(["I9"], "InProgress");
    const builder = task(["I2"]);
    const done = task(["I2"], "Completed");
    const items = [waiting, builder, done];

    expect(deliveringTasks(waiting, ["I2"], TABLE, items, [])).toEqual({ kind: "resolved", keys: ["I2"], owners: [builder.id] });
    expect(deliveringTasks(waiting, ["GET /loans/{id}"], TABLE, items, [])).toEqual({ kind: "resolved", keys: ["I2"], owners: [builder.id] });
    expect(deliveringTasks(waiting, ["POST /loans"], TABLE, items, [])).toMatchObject({ kind: "unresolved" });
    // A task that already depends on the waiting one is never waited on: that wait would close a cycle.
    expect(deliveringTasks(waiting, ["I2"], TABLE, items, [{ fromId: builder.id, toId: waiting.id }])).toEqual({ kind: "resolved", keys: ["I2"], owners: [] });
  });
});
