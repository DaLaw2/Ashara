import { describe, expect, test } from "vitest";
import { HALT_KINDS } from "@ashara/delivery/predicates";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
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
    const { body, closes } = await bodyOf(due("change", { kind: "at-work", visionWritten: true }));
    expect(body).toContain("Ashara has received your change.");
    expect(body).toContain("This project is at work.");
    expect(body).toContain("replies with what it changes, the work it touches and what that costs");
    expect(closes).toBe(false);
  });

  test("paused under a halt that reads input: read all the same, the pause not ended, its end named", async () => {
    const { body, closes } = await bodyOf(due("change", { kind: "paused", visionWritten: true, halt: "plan_repair" }));
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
      for (const halt of ["plan_repair", "check_dispute", "suite_review", "fault", "infrastructure"] as const) {
        const { body } = await bodyOf(due(kind, { kind: "paused", visionWritten: true, halt }));
        expect(body).toContain(path);
        expect(body).toContain(
          "If reading it fails on every attempt, or the project's record cannot take it while the pause lasts, Ashara reads it afresh once work resumes.",
        );
      }
    }
  });

  test("paused on a budget: read once the pause ends, since reading it is model work the budget refuses", async () => {
    const { body } = await bodyOf(due("answer", { kind: "paused", visionWritten: true, halt: "budget_cap" }));
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
      const { body, closes } = await bodyOf(due(kind, { kind: "paused", visionWritten: true, halt }));
      expect(body).toContain(reason);
      expect(body).toContain("so Ashara reads it once the pause ends");
      expect(body).not.toContain("all the same");
      expect(body).not.toContain("round of work");
      expect(body).toContain("The pause ends when the team's operator resumes the project");
      expect(closes).toBe(false);
    }
  });

  test("paused on infrastructure: the project resumes by itself", async () => {
    const { body } = await bodyOf(due("change", { kind: "paused", visionWritten: true, halt: "infrastructure" }));
    expect(body).toContain("resumes the project by itself");
  });

  test.each([
    ["at work", { kind: "at-work", visionWritten: true }],
    ["paused on a plan repair", { kind: "paused", visionWritten: true, halt: "plan_repair" }],
    ["paused on infrastructure", { kind: "paused", visionWritten: true, halt: "infrastructure" }],
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

// Every halt kind by every message the receipt words a fate for, the fate read from the halt's group
// as decided: a tender waits out any halt, an answer or a change waits for the budget or the model
// work that holds its reading, and is otherwise read during the pause.
// A change sent before the project's tender is read has nothing to correct yet: it waits for that
// reading, at work, and under any halt, since the tender's reading waits for the halt's end.
describe("the receipt of a change sent before the tender is read", () => {
  test("at work: read once the tender is read, never told it is read now", async () => {
    const { body, closes } = await bodyOf(due("change", { kind: "at-work", visionWritten: false }));
    expect(body).toContain("Ashara reads it once it has read the tender this project began with");
    expect(body).not.toContain("in this or the next round of work");
    expect(closes).toBe(false);
  });

  test.each(HALT_KINDS)("paused on %s: read once the pause ends, never told it is read during it", async (halt) => {
    const { body, closes } = await bodyOf(due("change", { kind: "paused", visionWritten: false, halt }));
    expect(body).toContain("Ashara reads it once the pause ends.");
    expect(body).not.toContain("all the same");
    expect(body).not.toContain("Reading it takes model work");
    expect(closes).toBe(false);
  });
});

describe("the receipt under each halt kind words the inbound-message decision", () => {
  const WAIT_WORDS: Readonly<Record<string, string>> = {
    budget_cap: "the budget that paused this project does not allow",
    work_budget: "the budget that paused this project does not allow",
    model_failed: "what paused this project is model work failing",
    provider_failed: "what paused this project is model work failing",
    replan_stopped: "what paused this project is model work failing",
    replan_provider_failed: "what paused this project is model work failing",
  };
  const cells = HALT_KINDS.flatMap((halt) => (["tender", "answer", "change"] as const).map((kind) => [halt, kind] as const));

  test.each(cells)("paused on %s, a %s", async (halt, kind) => {
    const { body, closes } = await bodyOf(due(kind, { kind: "paused", visionWritten: true, halt }));
    expect(closes).toBe(false);
    const waits = WAIT_WORDS[halt];
    if (kind === "tender") {
      expect(body).toContain("Ashara reads it once the pause ends.");
      expect(body).not.toContain("Reading it takes model work");
    } else if (waits !== undefined) {
      expect(body).toContain(waits);
      expect(body).not.toContain("all the same");
    } else {
      expect(body).toContain("Ashara reads it all the same");
      expect(body).not.toContain("Reading it takes model work");
    }
  });
});
