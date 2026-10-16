import { describe, expect, it } from "vitest";
import { deliveredInterfaceText, publicInterfaceText } from "./product.js";
import { checkTextFacts } from "./text-facts.js";
import type { TextFactRecords } from "./text-facts.js";

// The expected wording is written here, never taken from a composer (ADR-081).
const none: TextFactRecords = {
  visions: [],
  briefs: [],
  questions: [],
  answerReplies: [],
  tenderReports: [],
  delivered: [],
  sweepReplies: [],
  reviewSpec: null,
  firstPlan: { report: null, items: [], revisions: [] },
  interfaceOnMain: { kind: "not-held" },
};

const asked = { key: "A1", statement: "Commands wait for the lock.", status: "Inferred", kind: "client-visible", disclosed: "asked" };
const confirmed = { ...asked, status: "Stated", clientAnswer: { messageId: "ans1", verdict: "confirms" } };
const v1 = { version: 1, inferences: [asked], openQuestions: [{ messageId: "q1", text: "Should commands wait?", assumptionKey: "A1" }] };
const v2 = { version: 2, inferences: [confirmed], openQuestions: [] };

const keysOf = (records: Partial<TextFactRecords>): string[] => checkTextFacts({ ...none, ...records }).map((each) => each.key);

describe("checkTextFacts, briefs", () => {
  const checkAuthorGoal = (standing: string): string =>
    `Write the checks that decide whether "Lock" is done.\n\nVision items "Lock" cites:\n- S1 (in scope): put a value.\n- A1 (assumption; ${standing}; client-visible behaviour): Commands wait for the lock.`;
  const taskSpec = { goal: "Write the checks", endState: "every check is defined", scope: "the checks of Lock", deliverables: ["checks of Lock"] };
  const taskSection = "# Task\n\n## Goal\nWrite the checks\n\n## End State\nevery check is defined\n\n## Scope\nthe checks of Lock\n\n## Deliverables\n1. checks of Lock";
  const brief = (visionVersion: number, standing: string, note: string, context = `${taskSection}\n\n## Acceptance Criteria`) => ({
    title: "Write the checks for \"Lock\"",
    visionAtCreation: 2,
    taskSpec,
    brief: {
      goal: checkAuthorGoal(standing),
      context,
      visionVersion,
      assumptions: [{ key: "A1", statement: "Commands wait for the lock.", note: `${note}; client-visible behaviour` }],
    },
  });

  it("accepts a brief whose every assumption line states the standing of the vision it carries", () => {
    expect(keysOf({ visions: [v1, v2], briefs: [brief(2, "Stated by the client", "Stated by the client")] })).toEqual([]);
  });

  // A check author's description rendered at plan time can be dispatched after the client
  // confirmed the assumption, so a brief carrying the confirming vision can still say "not yet answered".
  it("names a brief that calls an answered assumption unanswered", () => {
    expect(keysOf({ visions: [v1, v2], briefs: [brief(2, "Inferred; asked of the client, not yet answered", "Stated by the client")] })).toEqual([
      'brief-standing:Write the checks for "Lock":A1',
    ]);
  });

  it("names a brief that carries a vision older than the one current when its session was recorded", () => {
    expect(keysOf({ visions: [v1, v2], briefs: [brief(1, "Inferred; asked of the client, not yet answered", "Inferred; asked of the client, not yet answered")] })).toEqual([
      'brief-vision:Write the checks for "Lock"',
    ]);
  });

  // development #3: a brief stated an end state its task_spec never recorded ("Implement: <title>").
  it("names a brief whose task section is not the task its work item records, and one with no task on record", () => {
    const invented = taskSection.replace("every check is defined", 'Implement: Write the checks for "Lock"');
    expect(keysOf({ visions: [v1, v2], briefs: [brief(2, "Stated by the client", "Stated by the client", invented)] })).toEqual([
      'brief-spec:Write the checks for "Lock"',
    ]);
    const unrecorded = { ...brief(2, "Stated by the client", "Stated by the client"), taskSpec: { goal: "Write the checks" } };
    expect(keysOf({ visions: [v1, v2], briefs: [unrecorded] })).toEqual(['brief-spec-unrecorded:Write the checks for "Lock"']);
  });

  it("names structured assumptions that are not the vision's", () => {
    expect(keysOf({ visions: [v1, v2], briefs: [brief(2, "Stated by the client", "Inferred; asked of the client, not yet answered")] })).toEqual([
      'brief-assumptions:Write the checks for "Lock"',
    ]);
  });
});

describe("checkTextFacts, the Liaison's questions and replies", () => {
  const question = (statement: string) => ({ id: "q1", body: `Should commands wait?\n\nWhy it matters: x\n\nUntil you answer, we proceed on this assumption: ${statement}\n\nWhy this assumption: y` });

  it("holds a question to the assumption its vision records for it", () => {
    expect(keysOf({ visions: [v1], questions: [question("Commands wait for the lock.")] })).toEqual([]);
    expect(keysOf({ visions: [v1], questions: [question("Commands fail at once.")] })).toEqual(["question:A1"]);
    expect(keysOf({ visions: [v1], questions: [{ id: "q9", body: "Anything?" }] })).toEqual(["question-unrecorded:1"]);
  });

  it("holds a reply to a changing answer to the two vision versions around it, and refuses one for a confirmation", () => {
    const changed = { ...asked, statement: "Commands fail at once.", status: "Stated", clientAnswer: { messageId: "ans1", verdict: "changes" } };
    const reply = { answerId: "ans1", body: "Your answer changes an assumption.\n\nThe plan assumed: Commands wait for the lock.\n\nWork now proceeds on: Commands fail at once." };
    expect(keysOf({ visions: [v1, { ...v2, inferences: [changed] }], answerReplies: [reply] })).toEqual([]);
    expect(keysOf({ visions: [v1, v2], answerReplies: [reply] })).toEqual(["answer-reply:A1"]);
  });

  it("holds the assumptions report to exactly the assumptions reported, each under its kind", () => {
    const reported = { key: "A2", statement: "Keys are short.", status: "Inferred", kind: "internal-design", disclosed: "reported" };
    const vision = { ...v1, inferences: [asked, reported] };
    const opening = "Besides the questions we asked, the tender leaves these decisions open, and we proceed on them unless you object.";
    const under = (head: string) => ({ id: "r1", body: `${opening}\n\n${head}\n- A2: Keys are short. (why: z)\n\nIf any of these does not fit, send a change.` });
    expect(keysOf({ visions: [vision], tenderReports: [under("How we will build it (our own design choices):")] })).toEqual([]);
    expect(keysOf({ visions: [vision], tenderReports: [under("What the product will do:")] })).toEqual(["assumptions-report:A2"]);
    expect(keysOf({ visions: [vision], tenderReports: [] })).toEqual(["assumptions-report"]);
  });
});

describe("checkTextFacts, the first-plan report", () => {
  const body = (tasks: number, checks: number) =>
    `Ashara has made the first plan for this project from its vision: 1 epic ("E"), split into ${tasks} task${tasks === 1 ? "" : "s"} for what you asked for.\n\n` +
    `Before any of those tasks starts, team members write the checks (${checks} check task${checks === 1 ? "" : "s"}).`;
  const items = [
    { origin: "decomposition", beforeReport: true, blockedReason: null },
    { origin: "decomposition", beforeReport: true, blockedReason: { source: "superseded", planRevision: 2, requestedBy: "a1", reason: "replaced" } },
    { origin: "check", beforeReport: true, blockedReason: null },
    { origin: "decomposition", beforeReport: false, blockedReason: null },
  ];

  it("counts the plan that stood when the report was posted", () => {
    const revisions = [{ revision: 2, beforeReport: true }];
    expect(keysOf({ firstPlan: { report: { body: body(1, 1) }, items, revisions } })).toEqual([]);
    expect(keysOf({ firstPlan: { report: { body: body(2, 1) }, items, revisions } })).toEqual(["first-plan-counts"]);
    // A revision written after the report replaced its task later: then the task was in the plan reported.
    expect(keysOf({ firstPlan: { report: { body: body(2, 1) }, items, revisions: [{ revision: 2, beforeReport: false }] } })).toEqual([]);
  });
});

describe("checkTextFacts, the delivered report's standings", () => {
  const reviewSpec = { origin: "review", sources: [{ type: "assumption", id: "A1", text: "Commands wait for the lock.", status: "Inferred", standing: "asked", kind: "client-visible" }] };
  const delivered = (line: string, visionAtAcceptance: number) => ({
    sweepId: "s1",
    mainCommit: "c".repeat(40),
    visionAtAcceptance,
    body: `Your project is delivered.\n\nThese items of what you asked for are decided by no stored check of a task whose stored checks passed on main, so nothing confirms them either way:\n${line}`,
  });

  // An assumption the client confirmed is never reported as unanswered.
  it("holds each listed assumption to where it stood with the client at acceptance", () => {
    expect(keysOf({ visions: [v1, v2], reviewSpec, delivered: [delivered("- Commands wait for the lock. (you confirmed this when asked)", 2)] })).toEqual([]);
    expect(
      keysOf({ visions: [v1, v2], reviewSpec, delivered: [delivered("- Ashara's assumption, which you were asked about and have not answered: Commands wait for the lock.", 2)] }),
    ).toEqual(["delivered-standing:A1"]);
  });

  it("tells an answer read by acceptance from one not yet read", () => {
    const line = (seen: string) => delivered(`- Ashara's assumption, ${seen}: Commands wait for the lock.`, 1);
    const unread = [{ sweepId: "s1", questionId: "q1", readByAcceptance: false }];
    expect(keysOf({ visions: [v1], reviewSpec, delivered: [line("which you were asked about; your reply had not been read when the project was accepted")], sweepReplies: unread })).toEqual([]);
    expect(keysOf({ visions: [v1], reviewSpec, delivered: [line("which you were asked about and have not answered")], sweepReplies: unread })).toEqual(["delivered-standing:A1"]);
  });
});

// The report says how to run the product from the interface file the scaffold wrote on main.
describe("checkTextFacts, the delivered report's quote of the public interface", () => {
  const commit = "d".repeat(40);
  const intro = `Public interface (from PUBLIC_INTERFACE.md on main at commit ${commit}), quoted as the file reads.`;
  const unjudged = "Ashara has not verified that it describes the delivered product.";
  const lead = `${intro} ${unjudged}`;
  const none = `How to run the product is not on record: its public interface file is missing. PUBLIC_INTERFACE.md is not on main at commit ${commit}.`;
  const report = (section: string) => ({ sweepId: "s1", mainCommit: commit, visionAtAcceptance: 1, body: `Your project is delivered.\n\n${section}\n\nNothing more is built.` });
  const onMain = (text: string | null): TextFactRecords["interfaceOnMain"] => ({
    kind: "read",
    bySweep: new Map([["s1", text === null ? { kind: "absent" as const } : { kind: "present" as const, text }]]),
  });
  const judged = (text: string | null, section: string) => keysOf({ delivered: [report(section)], interfaceOnMain: onMain(text) });

  it("holds the quoted block to the file on main, whole", () => {
    const file = "Run: wc.py <file>\n\nPrints counts.\n";
    expect(judged(file, `${lead}\n\`\`\`\n${file}\`\`\``)).toEqual([]);
    expect(judged("Run: wc.py <file>", `${lead}\n\`\`\`\nRun: wc.py <file>\n\`\`\``)).toEqual([]);
    expect(judged(file, `${lead}\n\`\`\`\nRun: tally.py <file>\n\nPrints counts.\n\`\`\``)).toEqual(["delivered-interface"]);
    expect(judged(file, none)).toEqual(["delivered-interface"]);
  });

  // Acceptance compares the file's bytes with the scaffold's; a quote that does not say so passes it off as checked.
  it("names a faithful quote that does not say Ashara never verified what the file describes", () => {
    const file = "Run: wc.py <file>\n";
    expect(judged(file, `${intro}\n\`\`\`\n${file}\`\`\``)).toEqual(["delivered-interface-claim"]);
  });

  it("holds the report to saying the product has none exactly when main holds none", () => {
    // Acceptance refuses a main with no interface file, so a delivery of one is named whatever the report says.
    expect(judged(null, none)).toEqual(["delivered-absent-interface"]);
    expect(judged(null, `${lead}\n\`\`\`\nRun: wc.py\n\`\`\``)).toEqual(["delivered-absent-interface", "delivered-interface"]);
  });

  it("accepts a cut quote only with its start, its end, an exact count, and a sentence saying so", () => {
    const file = `${"H".repeat(10)}${"m".repeat(50)}${"T".repeat(10)}`;
    const said = `${intro} It is longer than 20 characters, so only its start and end are quoted; the marker inside says how many characters were cut. ${unjudged}`;
    const quote = (cut: number) => `\`\`\`\n${"H".repeat(10)}\n[truncated by Ashara: ${cut} characters cut here]\n${"T".repeat(10)}\n\`\`\``;
    expect(judged(file, `${said}\n${quote(50)}`)).toEqual([]);
    expect(judged(file, `${said}\n${quote(49)}`)).toEqual(["delivered-interface"]);
    expect(judged(file, `${lead}\n${quote(50)}`)).toEqual(["delivered-interface-cut"]);
  });

  it("judges nothing where no checkout is held", () => {
    expect(keysOf({ delivered: [report("Nothing about the interface.")] })).toEqual([]);
  });

  it("names a delivery whose main still holds the scaffold's interface file, however faithfully it is quoted", () => {
    const fence = "`".repeat(4);
    const scaffold = publicInterfaceText("short");
    expect(judged(scaffold, `${lead}\n${fence}\n${scaffold}${fence}`)).toEqual(["delivered-placeholder-interface"]);
    const delivered = deliveredInterfaceText("short");
    expect(judged(delivered, `${lead}\n${fence}\n${delivered}${fence}`)).toEqual([]);
  });
});
