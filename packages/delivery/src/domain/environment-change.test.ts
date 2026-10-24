import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { CapabilityLevel } from "../acl/finance-acl.js";
import { requestEnvironmentChange } from "./environment-change.js";
import { createPendingWorkItem } from "./work-item.js";
import type { WorkItem } from "./work-item.js";

const PROJECT = parseProjectId("00000000-0000-4000-8000-0000000000e1", "test");
const REQUEST = { paths: ["environment/Containerfile"], need: "A JSON parser in the image.", diff: "+RUN apk add jq", detail: "recipe files changed" };
const CONTEXT = { opened: 0, owner: { kind: "role", roleId: "00000000-0000-4000-8000-0000000000e2" }, product: "present" } as const;

function requester(capability: CapabilityLevel | undefined): WorkItem {
  return {
    ...createPendingWorkItem({ level: "Task", title: "Parse the config", projectId: PROJECT, taskSpec: { origin: "decomposition", ...(capability === undefined ? {} : { capability }) } }),
    status: "InProgress",
  };
}

// The environment task decides what of the implementer's request the recipe provides: it judges the
// requester's work, so it is graded at or above the requester, and never below environment work's level.
describe("requestEnvironmentChange: the environment task is graded at or above the task that asked for it", () => {
  test.each([
    ["Frontier", "Frontier"],
    ["Strong", "Strong"],
    ["Medium", "Strong"],
    ["Light", "Strong"],
  ] as const)("a requester graded %s opens an environment task graded %s", (graded, expected) => {
    const exit = requestEnvironmentChange(requester(graded), REQUEST, CONTEXT);
    if (exit.kind !== "opened") return expect.unreachable(`exit is ${exit.kind}`);
    expect(exit.environment.taskSpec?.capability).toBe(expected);
  });

  test("a requester with no grade opens nothing and is left in progress", () => {
    const task = requester(undefined);
    expect(() => requestEnvironmentChange(task, REQUEST, CONTEXT)).toThrow(/carries no capability level/);
    expect(task.status).toBe("InProgress");
  });
});
