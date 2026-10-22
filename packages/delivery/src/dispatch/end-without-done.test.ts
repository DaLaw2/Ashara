import { describe, expect, test } from "vitest";
import { recordingLogger } from "@ashara/shared/testing";
import type { Outcome } from "@ashara/workplace";
import { agentBlocked } from "./end-without-done.js";

// finished(blocked) is routed by whose the block is to clear: another task's work and the client's
// decision are that owner's and spend no attempt; anything else is the agent's work failing.

type Finished = Extract<Outcome, { readonly kind: "finished" }>;

const INTERFACE = [
  { key: "I1", text: "POST /loans" },
  { key: "I2", text: "GET /loans/{id}" },
];

function finish(): Parameters<typeof agentBlocked>[0] {
  return { logger: recordingLogger(), task: { id: "task-1", attempt: 2 }, sessionId: "session-1", interfaceTable: INTERFACE, chainFields: { taskId: "task-1" } };
}

function blocked(blockedOn: Finished["blockedOn"]): Finished {
  return {
    kind: "finished",
    status: "blocked",
    summary: "Stuck.",
    blockedReason: "the check needs what another task builds",
    blockedOn,
    statement: null,
    turnsUsed: 4,
    cost: { measured: true, totalUsd: 0, turns: 4 },
    lastToolCall: null,
    promptDigest: "0".repeat(64),
    detail: "finished blocked",
  };
}

describe("agentBlocked routes a blocked finish by the owner its cause names", () => {
  test("needs-work naming entries of the interface is prerequisite_needed, each entry by its key, the interface carried", () => {
    const result = agentBlocked(finish(), blocked({ kind: "needs-work", interfaceEntries: ["GET /loans/{id}", "I1"] }), "");
    expect(result).toMatchObject({ status: "prerequisite_needed", interfaceEntries: ["I2", "I1"], interfaceTable: INTERFACE, attempt: 2, sessionId: "session-1" });
  });

  test("needs-client-decision is client_decision_needed, with the question and what stands until it is answered", () => {
    const result = agentBlocked(finish(), blocked({ kind: "needs-client-decision", question: "Which start command?", assumption: "The tender's command." }), "");
    expect(result).toMatchObject({ status: "client_decision_needed", question: "Which start command?", assumption: "The tender's command." });
  });

  test.each<[string, Finished["blockedOn"]]>([
    ["other", { kind: "other" }],
    ["no cause recorded", null],
    ["needs-work naming no entry of the interface", { kind: "needs-work", interfaceEntries: ["DELETE /loans"] }],
  ])("%s is the agent's work failing: blocked, a retryable work failure", (_label, blockedOn) => {
    const result = agentBlocked(finish(), blocked(blockedOn), "");
    expect(result).toMatchObject({ status: "blocked", verdict: { kind: "retryable", ground: "work" } });
  });

  test("an unresolved name says why in the detail the next attempt reads", () => {
    const result = agentBlocked(finish(), blocked({ kind: "needs-work", interfaceEntries: ["DELETE /loans"] }), "");
    expect(result.detail).toContain('"DELETE /loans" is the key or the text of no interface entry (I1, I2)');
  });
});
