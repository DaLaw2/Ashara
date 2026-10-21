import { describe, expect, test } from "vitest";
import { memoryStepContainment, parseProjectId } from "@ashara/shared";
import { ClientReceipts } from "./client-receipt.js";
import type { ClientReceiptStore, DueReceipt, ProjectStanding } from "./client-receipt.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000031", "test");

function receiptsFor(due: readonly DueReceipt[]) {
  const posted: Array<{ messageId: string; body: string; closes: boolean }> = [];
  const store: ClientReceiptStore = {
    dueReceipts: async () => due,
    postReceipt: async ({ due: each, body, closes }) => {
      posted.push({ messageId: each.messageId, body, closes });
      return "posted";
    },
  };
  return { receipts: new ClientReceipts(store, memoryStepContainment(() => true)), posted };
}

function due(kind: DueReceipt["kind"], standing: ProjectStanding, overrides: Partial<DueReceipt> = {}): DueReceipt {
  return { messageId: `${kind}-1`, projectId, kind, consumed: false, stoppedProject: false, standing, ...overrides };
}

async function bodyOf(each: DueReceipt, work: "running" | "stopped-at-cap" = "running"): Promise<{ body: string; closes: boolean }> {
  const { receipts, posted } = receiptsFor([each]);
  expect(await receipts.runPending({ kind: work })).toEqual([{ kind: "posted", messageId: each.messageId, projectId }]);
  const [one] = posted;
  if (one === undefined) throw new Error("no receipt posted");
  return one;
}

describe("the receipt of a client message", () => {
  test("at work: the change is read now and answered with its impact; nothing is consumed", async () => {
    const { body, closes } = await bodyOf(due("change", { kind: "at-work" }));
    expect(body).toContain("Ashara has received your change.");
    expect(body).toContain("This project is at work.");
    expect(body).toContain("replies with what it changes, the work it touches and what that costs");
    expect(closes).toBe(false);
  });

  test("paused under a halt that reads input: read all the same, the pause not ended, its end named", async () => {
    const { body, closes } = await bodyOf(due("change", { kind: "paused", halt: "plan_repair", readsInput: true }));
    expect(body).toContain("Ashara reads it all the same");
    // The paused project's own spend limit refuses the reading's model call, which then waits for that limit.
    expect(body).toContain("unless this project has reached its own spending limit, in which case it is read once that limit is raised");
    expect(body).toContain("This change does not end the pause");
    expect(body).toContain("The pause ends when the team's operator resumes the project");
    expect(closes).toBe(false);
  });

  // A reading under such a halt is not certain: one whose readings run out, or that the record cannot take
  // while paused (waits-for-halt), waits for the pause's end, whose exits set its count of failed readings back to none.
  test.each([
    ["its readings run out", "If reading it fails on every attempt"],
    ["the record cannot take it while paused", "or the project's record cannot take it while the pause lasts"],
  ] as const)("paused under a halt that reads input, when %s: the receipt says it is read afresh once work resumes", async (_, path) => {
    for (const kind of ["change", "answer"] as const) {
      for (const halt of ["plan_repair", "check_dispute", "suite_review", "fault", "infrastructure"]) {
        const { body } = await bodyOf(due(kind, { kind: "paused", halt, readsInput: true }));
        expect(body).toContain(path);
        expect(body).toContain(
          "If reading it fails on every attempt, or the project's record cannot take it while the pause lasts, Ashara reads it afresh once work resumes.",
        );
      }
    }
  });

  test("paused on a budget: read once the pause ends, since reading it is model work the budget refuses", async () => {
    const { body } = await bodyOf(due("answer", { kind: "paused", halt: "budget_cap", readsInput: false }));
    expect(body).toContain("Ashara reads it once the pause ends");
    expect(body).not.toContain("all the same");
  });

  test.each([
    ["the project's spend cap", "budget_cap", "the budget that paused this project does not allow"],
    ["the work ledger", "work_budget", "the budget that paused this project does not allow"],
    ["a model's failure", "model_failed", "what paused this project is model work failing"],
    ["a provider's failure", "provider_failed", "what paused this project is model work failing"],
    ["a plan revision's model failing", "replan_stopped", "what paused this project is model work failing"],
    ["a plan revision's provider failing", "replan_provider_failed", "what paused this project is model work failing"],
  ] as const)("paused on %s, which the reading cannot get past: it waits for the pause's end, for the halt's own reason", async (_, halt, reason) => {
    for (const kind of ["change", "answer"] as const) {
      const { body, closes } = await bodyOf(due(kind, { kind: "paused", halt, readsInput: false }));
      expect(body).toContain(reason);
      expect(body).toContain("so Ashara reads it once the pause ends");
      expect(body).not.toContain("all the same");
      expect(body).not.toContain("round of work");
      expect(body).toContain("The pause ends when the team's operator resumes the project");
      expect(closes).toBe(false);
    }
  });

  test("paused on infrastructure: the project resumes by itself", async () => {
    const { body } = await bodyOf(due("change", { kind: "paused", halt: "infrastructure", readsInput: true }));
    expect(body).toContain("resumes the project by itself");
  });

  test.each([
    ["at work", { kind: "at-work" }],
    ["paused on a plan repair", { kind: "paused", halt: "plan_repair", readsInput: true }],
    ["paused on infrastructure", { kind: "paused", halt: "infrastructure", readsInput: true }],
  ] as const)("all work stopped at the deployment's cap, %s: nothing reads it until the limit is raised, and no round of work or resumption is promised", async (_, standing) => {
    const { body, closes } = await bodyOf(due("change", standing), "stopped-at-cap");
    expect(body).toContain("Ashara has stopped all work: the spending limit set for the whole deployment is reached.");
    expect(body).toContain("nothing reads it while all work is stopped: Ashara reads it once the owner raises that limit and Ashara is started again.");
    expect(body).not.toContain("This project is at work.");
    expect(body).not.toContain("round of work");
    expect(body).not.toContain("resumes the project by itself");
    expect(body).not.toContain("The pause ends when");
    expect(closes).toBe(false);
  });

  test("all work stopped at the deployment's cap: a closed project's message is still recorded and not acted on", async () => {
    const { body, closes } = await bodyOf(due("change", { kind: "accepted" }), "stopped-at-cap");
    expect(body).toContain("It is recorded, but not acted on: Ashara does no further work on a delivered project.");
    expect(body).not.toContain("stopped all work");
    expect(closes).toBe(true);
  });

  test.each([
    ["stopped", "a stopped project"],
    ["accepted", "a delivered project"],
  ] as const)("%s: recorded and not acted on, and consumed with its receipt", async (kind, words) => {
    const { body, closes } = await bodyOf(due("change", { kind }));
    expect(body).toContain(`It is recorded, but not acted on: Ashara does no further work on ${words}.`);
    expect(closes).toBe(true);
  });

  test("a stop is never consumed by its receipt; the one that stopped the project says so, a second says it changes nothing", async () => {
    const taken = await bodyOf(due("stop", { kind: "stopped" }, { consumed: true, stoppedProject: true }));
    expect(taken.body).toContain("Your request is taken");
    expect(taken.closes).toBe(false);
    const second = await bodyOf(due("stop", { kind: "stopped" }));
    expect(second.body).toContain("The project was already stopped, so this request changes nothing.");
    expect(second.closes).toBe(false);
    const accepted = await bodyOf(due("stop", { kind: "accepted" }));
    expect(accepted.body).toContain("Ashara takes the stop in at the start of its next round of work");
    expect(accepted.closes).toBe(false);
  });

  test("a message already read says so and is not consumed again", async () => {
    const { body, closes } = await bodyOf(due("answer", { kind: "stopped" }, { consumed: true }));
    expect(body).toContain("It has been read and taken into the project's record.");
    expect(closes).toBe(false);
  });
});
