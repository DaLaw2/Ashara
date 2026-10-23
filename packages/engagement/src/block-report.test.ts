import { describe, expect, test, vi } from "vitest";
import { parseProjectId, type UnreadSubject } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { HALT_KINDS } from "@ashara/delivery/predicates";
import { SPEND_CAP_ERROR_CLASS } from "@ashara/finance";
import { BlockReports } from "./block-report.js";
import type { BlockReportStore, ProjectBlockedReport } from "./block-report.js";
import type { RiskRecords } from "./early-warning.js";
import { guaranteeTableOf } from "./guarantee-report.js";
import { inboundDecision } from "./inbound-policy.js";
import { TerminalReports } from "./terminal-report.js";
import type { DueTerminal, TerminalReportStore } from "./terminal-report.js";

// A halt is told by its terminal message (terminal-report.ts), and its resumption by the block-report
// step once that message is told; the tests spell both as one listing.

const projectId = parseProjectId("00000000-0000-4000-8000-000000000020", "test");

type DueResumption = Exclude<Awaited<ReturnType<BlockReportStore["dueReports"]>>[number], UnreadSubject>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The table these messages carry; guarantee-report.test.ts judges its text. */
const TABLE = guaranteeTableOf({ kind: "no-contract", sweep: { id: "s1", mainCommit: null } });

/** A listed report as a test spells it: its subject named, and the project's vision written unless it says otherwise. */
type Spelled =
  | (DistributiveOmit<ProjectBlockedReport, "visionWritten"> & { readonly subject: "project-blocked"; readonly visionWritten?: boolean })
  | (DueResumption & { readonly subject: "project-resumed" });

/** The register's records of a project with no guarantee: a contract none of whose guarantees is held. */
const OPEN_RECORDS: RiskRecords = { kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } };

function reportsFor(listed: readonly Spelled[], records: RiskRecords = OPEN_RECORDS) {
  const halts: DueTerminal[] = [];
  const resumptions: DueResumption[] = [];
  for (const each of listed) {
    if (each.subject === "project-resumed") {
      resumptions.push({ episodeId: each.episodeId, projectId: each.projectId, how: each.how });
      continue;
    }
    const { subject: _subject, ...spelled } = each;
    const halt: ProjectBlockedReport = { visionWritten: true, ...spelled };
    halts.push({ kind: "listed", event: { kind: "halted", projectId: halt.projectId, halt, risk: records }, table: TABLE });
  }
  const posted: Array<{ key: string; body: string }> = [];
  const terminals: TerminalReportStore = {
    dueTerminals: async () => halts,
    postTerminal: async (message) => {
      posted.push({ key: `${message.subject.kind === "halted" ? message.subject.episodeId : message.subject.kind}:blocked`, body: message.body });
      return "posted";
    },
    recordDeliveredFailure: async () => expect.unreachable("no delivered report is due"),
  };
  const store: BlockReportStore = {
    dueReports: async () => resumptions,
    postResumedReport: async (episodeId, body) => {
      posted.push({ key: `${episodeId}:resumed`, body });
      return "posted";
    },
    riskRecords: async () => records,
  };
  const containment = memoryStepContainment(() => true);
  const halted = new TerminalReports(terminals, { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "absent" }) }, containment);
  const resumed = new BlockReports(store, containment);
  return { reports: { runPending: async () => [...(await halted.runPending()), ...(await resumed.runPending())] }, posted };
}

describe("project block reports", () => {
  test.each(["budget_cap", "configuration", "fault", "planning_stopped"] as const)(
    "%s: one report saying work is paused, the recorded cause, and that the operator is awaited",
    async (kind) => {
      const cause = { errorClass: "SomethingFailed", reason: `the ${kind} cause as recorded`, spend: null, work: null };
      const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, kind, cause }]);

      expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, terminal: "halted" }]);

      expect(posted).toHaveLength(1);
      expect(posted[0].key).toBe("e1:blocked");
      expect(posted[0].body).toContain("Ashara recorded the cause as this: ");
      expect(posted[0].body).toContain("its own record of this pause, record e1.");
      expect(posted[0].body).not.toContain("SomethingFailed");
      expect(posted[0].body).not.toContain(`the ${kind} cause as recorded`);
      expect(posted[0].body).toContain("waiting on its operator");
    },
  );

  // A deployment-cap halt is never told as the project's own budget needing to be raised.
  test.each([
    [
      SPEND_CAP_ERROR_CLASS.deployment,
      "the spending limit set for all of Ashara's work, across every project it runs, left no room for the next step of the work",
      "The spending limit for all of Ashara's work has to be raised before more is spent on any project, this one included.",
    ],
    [SPEND_CAP_ERROR_CLASS.project, "the spending limit set for this project left no room for the next step of the work", "The budget set for this project has to be raised before more is spent."],
    [
      "SomethingElse",
      "a spending limit set for this work left no room for the next step of the work, so that step was not paid for; which limit it was is not on record",
      "The spending limit that stopped the work has to be raised before more is spent.",
    ],
  ])("a budget_cap halt recorded as %s names the limit its record names", async (errorClass, cause, next) => {
    // The message names the other cap: the report is chosen by the recorded class, never by the message's words.
    const reason = "budget_cap: the spend cap of project p is $1; Raise ASHARA_PROJECT_BUDGET_LIMIT_USD (the deployment cap)";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "budget_cap", cause: { errorClass, reason, spend: null, work: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain(`Ashara recorded the cause as this: ${cause}`);
    expect(posted[0].body).not.toContain("was reached");
    expect(posted[0].body).toContain("How much had been spent and set aside against that limit when it stopped the work is not on record.");
    expect(posted[0].body).toContain(next);
    expect(posted[0].body).not.toContain(errorClass);
    if (errorClass !== SPEND_CAP_ERROR_CLASS.project) expect(posted[0].body).not.toContain("The budget set for this project");
  });

  // A cap refuses a call whose worst case would cross it, before the recorded spend reaches the limit.
  test("a budget_cap halt states the spent, set-aside and limit amounts its record holds, never a limit reached", async () => {
    const spend = { capUsd: 1, spentUsd: 0.412203, inFlightUsd: 0.29854, nextCallUsd: 0.304642 };
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "budget_cap", cause: { errorClass: SPEND_CAP_ERROR_CLASS.deployment, reason: "r", spend, work: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain(
      "When it stopped the work, $0.412203 had been spent and $0.298540 was set aside for work under way, and the next step " +
        "needed up to $0.304642 set aside, more than the limit had room for; the limit is $1.000000.",
    );
    expect(posted[0].body).not.toContain("was reached");
  });

  // The report names the budget, what was drawn against it and which call sites drew it.
  test("a work_budget halt names the request budget, what was drawn and the call sites that drew it, and that a grant is awaited", async () => {
    const work = {
      scope: "project" as const,
      budgetRequests: 650,
      grantedRequests: 50,
      reserveRequests: 0,
      reserveProtected: false,
      spentRequests: 649,
      inFlightRequests: 1,
      bySite: [{ callSite: "agent", requests: 600 }, { callSite: "suite-review", requests: 50 }],
    };
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "work_budget", cause: { errorClass: "WorkBudgetSpent", reason: "r", spend: null, work } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain("Ashara recorded the cause as this: the budget of model requests set for this project was used up");
    expect(posted[0].body).toContain(
      "When it stopped the work, 649 model requests had been sent and 1 more were under way, against a budget of 650 model " +
        'requests, 50 model requests of it granted by the operator. The requests drawn, by the step of the work that drew them: "agent" 600, "suite-review" 50.',
    );
    expect(posted[0].body).toContain("More model requests have to be granted to this project before more work is done.");
    expect(posted[0].body).not.toContain("WorkBudgetSpent");
  });

  // A halt that kept the verification reserve says so, and names what spent the rest.
  test("a work_budget halt that protected the verification reserve says the reserve is kept, and names the call sites that drew the rest", async () => {
    const work = {
      scope: "project" as const,
      budgetRequests: 600,
      grantedRequests: 0,
      reserveRequests: 150,
      reserveProtected: true,
      spentRequests: 450,
      inFlightRequests: 0,
      bySite: [{ callSite: "agent-runner", requests: 400 }, { callSite: "suite-review", requests: 50 }],
    };
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "work_budget", cause: { errorClass: "WorkBudgetSpent", reason: "r", spend: null, work } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain(
      "Ashara recorded the cause as this: the budget of model requests set for this project was used up except for the share set aside " +
        "for checking and accepting the finished work, which is kept for that, so the next step of the work, which was not that checking, was not sent.",
    );
    expect(posted[0].body).toContain(
      "against a budget of 600 model requests. 150 model requests of the budget are set aside for checking and accepting the finished work. " +
        'The requests drawn, by the step of the work that drew them: "agent-runner" 400, "suite-review" 50.',
    );
  });

  test("a halt with no cause recorded says so, and claims none", async () => {
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "fault", cause: { errorClass: null, reason: null, spend: null, work: null } },
    ]);
    await reports.runPending();
    expect(posted[0].body).toContain("No cause was recorded for this pause.");
  });

  // The client never reads an error class or its chain.
  test("a fault's report keeps the error class and chain with the operator, and names the record that holds them", async () => {
    const reason =
      "PlanReportUnfounded: project 00000000-0000-4000-8000-000000000020 is recorded as planned with 2 epic(s), 13 decomposed task(s); " +
      "no report is posted\n    at PlanReports.compose (packages/engagement/src/plan-report.ts:289:13)";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "ep-7", projectId, kind: "fault", cause: { errorClass: "PlanReportUnfounded", reason, spend: null, work: null } },
    ]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).not.toMatch(/PlanReportUnfounded|Error\b|decomposed task\(s\)|\n\s+at |\.ts:\d+/);
    expect(body).toContain(
      "Ashara recorded the cause as this: a step of Ashara's own work on this project failed, or Ashara's own record of the project did not hold together.",
    );
    expect(body).toContain("Ashara keeps the technical detail in its own record of this pause, record ep-7.");
    expect(body).toContain("The team has to repair it.");
  });

  test("a resumption after an unblock is told once, on its own episode", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "unblocked" }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("the team cleared what paused it") }]);
  });
});

// The cause told is the one observed, never a
// sentence fixed per kind of halt.
describe("halt reports state the observed cause", () => {
  test("an infrastructure halt quotes the recorded fault chain, says it is not charged and resumes by itself", async () => {
    const reason =
      "task t1 met 4 infrastructure fault(s), past the budget of 3 uncharged requeues; the project halts until the " +
      "substrate probe passes. The last fault: task cell unavailable: exec wrapper killed by the command's own kill -9";
    const { reports, posted } = reportsFor([
      { subject: "project-blocked", episodeId: "e1", projectId, kind: "infrastructure", cause: { errorClass: "InfrastructureFaultBudgetSpent", reason, spend: null, work: null } },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain("Ashara recorded the cause as this: the machines Ashara runs the work on kept failing");
    expect(posted[0].body).not.toContain("InfrastructureFaultBudgetSpent");
    expect(posted[0].body).not.toContain("kill -9");
    expect(posted[0].body).toContain("not charged");
    expect(posted[0].body).toContain("resumes this project by itself");
    expect(posted[0].body).not.toContain("operator");
  });

  test("its resumption says the machines work again", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "probe_passed" }]);
    await reports.runPending();
    expect(posted).toEqual([{ key: "e1:resumed", body: expect.stringContaining("the machines Ashara runs the work on work again") }]);
  });

  test("an undeliverable halt names each task given up with its recorded category and record, never the stored text", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [
          { workItemId: "w1", title: "Lock the data directory", attempts: 3, cause: { source: "failure_given_up", reason: "attempts exhausted (3/3)", detail: "flock: lock held by pid 41" } },
          { workItemId: "w2", title: "Review the checks", attempts: 1, cause: { source: "suite_review_unresolved", checkTaskIds: ["c"], reason: "checks 2 and 5 contradict" } },
          {
            workItemId: "w3",
            title: "Acceptance on main 0123456789ab",
            attempts: 0,
            cause: { source: "acceptance_failed", mainCommit: "0123456789abcdef0123456789abcdef01234567", reason: `check "get" exited 1` },
          },
          { workItemId: "w4", title: "Write the importer", attempts: 2, cause: { source: "orchestrator_error", reason: "orchestrator error" } },
        ],
      },
    ]);
    await reports.runPending();
    expect(posted).toHaveLength(1);
    const body = posted[0].body;
    expect(body).toContain("cannot deliver it as planned");
    expect(body).toContain(
      `- "Lock the data directory", after 3 attempts counted against it. Ashara recorded why it was given up as this: its attempts at the work did not succeed. ` +
        `Ashara keeps the detail in its own record of that task, record w1.`,
    );
    expect(body).toContain(`"Review the checks", after 1 attempt counted against it. Ashara recorded why it was given up as this: the review of the plan's checks found problems`);
    expect(body).toContain("the final check of the whole project did not pass on the project's main line. Ashara keeps the detail in its own record of that task, record w3.");
    expect(body).toContain("a step of Ashara's own work on it failed. Ashara keeps the detail in its own record of that task, record w4.");
    // The stored reasons are Ashara's internal wording: none reaches the client.
    for (const stored of ["attempts exhausted", "flock", "checks 2 and 5", "exited 1", "orchestrator error"]) expect(body).not.toContain(stored);
  });

  // Only the operator's resumption ends these halts (the probe ends only an infrastructure halt): a
  // report asking for a change would ask for something that cannot end the pause.
  test.each([
    { kind: "plan_repair", abandoned: [{ workItemId: "w1", title: "Port the importer", attempts: 2, cause: { source: "api", reason: "r" } }] },
    { kind: "check_dispute", dispute: { taskTitle: "Port the importer", checkName: "imports", reason: "r", disputes: 3 } },
    { kind: "suite_review", review: { times: 3, problems: ["p"] } },
  ] as const)("a $kind halt names the operator's resumption as its end and asks for no change", async (halt) => {
    const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, ...halt }]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).not.toMatch(/send a change|send it as|takes it in when work resumes/);
    expect(body).toContain("until the team's operator");
    expect(body).toContain("A change you send meanwhile does not end this pause: Ashara reads it and records it during the pause");
    // The report may be posted, or a spend limit reached, while that limit refuses the reading: the deployment's or the project's own.
    expect(body).toContain("unless a spending limit stops that reading (this project's own, or the one for all of Ashara's work), in which case it is read once that limit is raised");
    expect(body).not.toContain("records it at once");
  });

  // The reading during the pause is not certain: a change whose readings run out, or that the record cannot take
  // while paused (waits-for-halt), waits for the pause's end, whose exits set its count of failed readings back to none.
  test.each([
    ["its readings run out", "If reading it fails on every attempt"],
    ["the record cannot take it while paused", "or the project's record cannot take it while the pause lasts"],
  ] as const)("a halt's change-during-pause sentence, when %s, says the change is read afresh once work resumes", async (_, path) => {
    for (const halt of [
      { kind: "plan_repair", abandoned: [{ workItemId: "w1", title: "Port the importer", attempts: 2, cause: { source: "api", reason: "r" } }] },
      { kind: "check_dispute", dispute: { taskTitle: "Port the importer", checkName: "imports", reason: "r", disputes: 3 } },
      { kind: "suite_review", review: { times: 3, problems: ["p"] } },
    ] as const) {
      const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, ...halt }]);
      await reports.runPending();
      const body = posted[0].body;
      expect(body).toContain(path);
      expect(body).toContain(
        "If reading it fails on every attempt, or the project's record cannot take it while the pause lasts, Ashara reads it afresh once work resumes. " +
          "The plan is revised for it once work resumes.",
      );
    }
  });

  test("a task given up through the API is told as moved by hand, whatever its caller stored", async () => {
    const { reports, posted } = reportsFor([
      {
        subject: "project-blocked",
        episodeId: "e1",
        projectId,
        kind: "plan_repair",
        abandoned: [{ workItemId: "w1", title: "Port the importer", attempts: 2, cause: { source: "api", reason: "superseded by the new importer" } }],
      },
    ]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).toContain(`"Port the importer", after 2 attempts counted against it. Ashara recorded why it was given up as this: it was moved by hand through Ashara's API.`);
    expect(body).not.toContain("superseded by the new importer");
  });
});

// Every halt kind's report tells what a change sent during it does, as the inbound-message decision
// decides for the halt: read during the pause, or read once it ends for the budget or the model work
// that holds the reading.
describe("each halt kind's report tells what a change sent meanwhile does", () => {
  const cause = { errorClass: "SomethingFailed", reason: "the cause as recorded", spend: null, work: null };
  const halts = [
    ...(["budget_cap", "configuration", "fault", "planning_stopped", "replan_bound", "infrastructure", "replan_stopped", "replan_provider_failed", "model_failed", "provider_failed", "work_budget", "acceptance_uncovered", "client_wait"] as const).map(
      (kind) => ({ subject: "project-blocked", episodeId: "e1", projectId, kind, cause }) as const,
    ),
    { subject: "project-blocked", episodeId: "e1", projectId, kind: "plan_repair", abandoned: [{ workItemId: "w1", title: "Port", attempts: 2, cause: { source: "api", reason: "r" } }] } as const,
    { subject: "project-blocked", episodeId: "e1", projectId, kind: "check_dispute", dispute: { taskTitle: "Port", checkName: "imports", reason: "r", disputes: 3 } } as const,
    { subject: "project-blocked", episodeId: "e1", projectId, kind: "suite_review", review: { times: 3, problems: ["p"] } } as const,
  ];
  const WAIT_WORDS: Readonly<Record<string, string>> = {
    budget_cap: "Reading it takes model work, which the budget that paused this project does not allow, so Ashara reads it once the pause ends.",
    work_budget: "Reading it takes model work, which the budget that paused this project does not allow, so Ashara reads it once the pause ends.",
    model_failed: "Reading it takes model work, and what paused this project is model work failing",
    provider_failed: "Reading it takes model work, and what paused this project is model work failing",
    replan_stopped: "Reading it takes model work, and what paused this project is model work failing",
    replan_provider_failed: "Reading it takes model work, and what paused this project is model work failing",
  };

  test("the halts enumerated are every halt kind", () => {
    expect(halts.map((halt) => halt.kind).sort()).toEqual([...HALT_KINDS].sort());
  });

  test.each(halts.map((halt) => [halt.kind, halt] as const))("%s", async (kind, halt) => {
    const { reports, posted } = reportsFor([halt]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).toContain("A change you send meanwhile does not end this pause");
    expect(body).toContain("The plan is revised for it once work resumes.");
    const waits = WAIT_WORDS[kind];
    if (waits === undefined) {
      expect(body).toContain("Ashara reads it and records it during the pause");
      expect(body).not.toContain("Reading it takes model work");
    } else {
      expect(body).toContain(waits);
      expect(body).not.toContain("records it during the pause");
    }
  });

  // A halt opened before the tender is read (the tender's reading exhausted as Ashara's fault): a change
  // waits for the tender, which waits for the halt's end, whatever the halt.
  test.each(halts.map((halt) => [halt.kind, halt] as const))("%s, before the tender is read", async (_kind, halt) => {
    const { reports, posted } = reportsFor([{ ...halt, visionWritten: false }]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).toContain("A change you send meanwhile does not end this pause");
    expect(body).toContain("Ashara has not yet read the tender this project began with, and reads it once the pause ends");
    expect(body).not.toContain("records it during the pause");
    expect(body).not.toContain("Reading it takes model work");
    expect(body).not.toContain("The plan is revised for it once work resumes.");
  });
});

// What waits on the operator is said together with what of the client's input is still read during
// the halt, derived from the inbound-message decision: no halt report says nothing more is done while
// the decision still reads the client's answers or changes.
describe("each operator-awaited halt's report says what is still read during it, as the decision decides", () => {
  const cause = { errorClass: "SomethingFailed", reason: "the cause as recorded", spend: null, work: null };
  const kinds = ["budget_cap", "configuration", "fault", "planning_stopped", "replan_bound", "replan_stopped", "replan_provider_failed", "model_failed", "provider_failed", "work_budget", "acceptance_uncovered"] as const;
  const WORDS = { tender: "the tender this project began with", answer: "your answers", change: "your changes" } as const;

  test.each(kinds.flatMap((kind) => [true, false].map((visionWritten) => [kind, visionWritten] as const)))("%s, the first vision written %s", async (kind, visionWritten) => {
    const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, kind, cause, visionWritten }]);
    await reports.runPending();
    const body = posted[0].body;
    const read = (["tender", "answer", "change"] as const).filter((message) => inboundDecision({ lifecycle: "active", halt: kind, visionWritten }, message).reading === "now");
    const meanwhile =
      read.length === 0
        ? "Until then no more work is done on this project, and what you send, other than a stop, is read once work resumes."
        : `Until then no more work is done on this project, though Ashara still reads ${read.map((message) => WORDS[message]).join(" and ")} during the pause.`;
    expect(body).toContain(`${meanwhile} The team is waiting on its operator for this, and you will be told when work resumes.`);
    expect(body).not.toContain("nothing more is done");
  });
});

// A contract Ashara declines holds the project before work: no report on a halt of it, or on that
// halt's end, may tell the client that work resumes, goes on or is planned, whatever the halt. The
// standing the reports are composed for is the one the register they end with reads.
describe("no halt or resumption report on a held contract promises that work resumes", () => {
  const held = {
    id: "G1",
    statement: "Entries are kept.",
    interface: ["I1"],
    observation: "stored-data",
    refutedBy: ["an entry is missing"],
    source: { kind: "tender", quote: "Entries are kept." },
    basis: "client-stated",
    verification: "not-by-ashara",
    unverifiableBecause: "outside-interface",
  } as const;
  const HELD: RiskRecords = { kind: "read", version: { guarantees: [held], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } };
  const UNREAD: RiskRecords = { kind: "unreadable", detail: "vision v1 does not parse" };
  const PROMISES = [
    "work resumes",
    "Work on this project is paused",
    "has resumed",
    "goes on",
    "resumes the project",
    "resumes this project",
    "revised for it",
    "planned for it",
    "tried again",
    "revised again",
    "more work is done",
    "checked again",
    "Nothing more is built",
    "no more work is done",
  ];
  const cause = { errorClass: "SomethingFailed", reason: "the cause as recorded", spend: null, work: null };
  const halts: readonly Spelled[] = [
    ...(["budget_cap", "configuration", "fault", "planning_stopped", "replan_bound", "infrastructure", "replan_stopped", "replan_provider_failed", "model_failed", "provider_failed", "work_budget", "acceptance_uncovered", "client_wait"] as const).map(
      (kind) => ({ subject: "project-blocked", episodeId: "e1", projectId, kind, cause }) as const,
    ),
    { subject: "project-blocked", episodeId: "e1", projectId, kind: "plan_repair", abandoned: [{ workItemId: "w1", title: "Port", attempts: 2, cause: { source: "api", reason: "r" } }] },
    { subject: "project-blocked", episodeId: "e1", projectId, kind: "check_dispute", dispute: { taskTitle: "Port", checkName: "imports", reason: "r", disputes: 3 } },
    { subject: "project-blocked", episodeId: "e1", projectId, kind: "suite_review", review: { times: 3, problems: ["p"] } },
  ];
  const reports: ReadonlyArray<readonly [string, Spelled]> = [
    ...halts.flatMap((halt) => [true, false].map((visionWritten) => [`${halt.subject === "project-blocked" ? halt.kind : ""}, vision written ${visionWritten}`, { ...halt, visionWritten }] as const)),
    ...(["unblocked", "probe_passed", "answered"] as const).map((how) => [`resumed (${how})`, { subject: "project-resumed", episodeId: "e1", projectId, how }] as const),
  ];

  test("the halts enumerated are every halt kind", () => {
    expect(halts.flatMap((halt) => (halt.subject === "project-blocked" ? [halt.kind] : [])).sort()).toEqual([...HALT_KINDS].sort());
  });

  test.each(reports)("%s: held, no promise; the contract the register reads is the one declined", async (_name, report) => {
    const { reports: held, posted } = reportsFor([report], HELD);
    await held.runPending();
    const [{ body }] = posted;
    for (const promise of PROMISES) expect(body).not.toContain(promise);
    expect(body).toContain("Ashara cannot verify any guarantee of this contract as written");
  });

  test.each(reports)("%s: unread, no promise either way", async (_name, report) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { reports: unread, posted } = reportsFor([report], UNREAD);
    await unread.runPending();
    for (const promise of PROMISES) expect(posted[0].body).not.toContain(promise);
    warn.mockRestore();
  });

  test.each(reports)("%s: on a contract Ashara can verify, the report says what follows the pause", async (_name, report) => {
    const { reports: open, posted } = reportsFor([report]);
    await open.runPending();
    expect(PROMISES.some((promise) => posted[0].body.includes(promise))).toBe(true);
  });
});

// A project whose only work left waits on the client's answer is paused for that answer, not for
// the operator: its report asks for the reply, and its resumption names the answer as what ended it.
describe("a client_wait halt's report asks the client for the answer that ends it", () => {
  const cause = { errorClass: "ClientDecisionAwaited", reason: "question q1: Which command?", spend: null, work: null };

  test("the pause, its cause in the client's words, and that the answer read ends it; no operator awaited, nothing charged", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-blocked", episodeId: "e1", projectId, kind: "client_wait", cause }]);
    await reports.runPending();
    const body = posted[0].body;
    expect(body).toContain("every piece of work left on this project waits on your answer to a question the team asked you");
    expect(body).toContain("Reply to the question you were asked: Ashara reads your answer during the pause, and once it is read the pause ends by itself");
    expect(body).toContain("This pause is not charged as an attempt at the work, and nothing is given up for it.");
    expect(body).not.toContain("waiting on its operator");
  });

  test("its resumption names the answer read as what ended it", async () => {
    const { reports, posted } = reportsFor([{ subject: "project-resumed", episodeId: "e1", projectId, how: "answered" }]);
    await reports.runPending();
    expect(posted[0].body).toContain("your answer to the team's question was read");
  });
});
