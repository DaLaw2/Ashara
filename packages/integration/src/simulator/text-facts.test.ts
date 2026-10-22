import { describe, expect, it } from "vitest";
import { deliveredInterfaceText, publicInterfaceText } from "./product.js";
import { checkTextFacts, declinedWork } from "./text-facts.js";
import type { TextFactRecords } from "./text-facts.js";

// The expected wording is written here, never taken from a composer.
const none: TextFactRecords = {
  visions: [],
  briefs: [],
  questions: [],
  answerReplies: [],
  tenderReports: [],
  delivered: [],
  firstPlan: { report: null, items: [], revisions: [] }, workItems: 0,
  interfaceOnMain: { kind: "not-held" },
  placeholderOnMain: { kind: "not-held" },
  intakeReading: { confirmation: "not-needed", secondStrength: null, secondQuestions: null },
};

const asked = { key: "A1", statement: "Commands wait for the lock.", status: "Inferred", kind: "client-visible", disclosed: "asked" };
const confirmed = { ...asked, status: "Stated", clientAnswer: { messageId: "ans1", verdict: "confirms" } };
const v1 = { version: 1, inferences: [asked], openQuestions: [{ messageId: "q1", text: "Should commands wait?", assumptionKey: "A1" }], guarantees: [], interface: [{ id: "I1", text: "put KEY VALUE" }] };
const v2 = { version: 2, inferences: [confirmed], openQuestions: [], guarantees: [], interface: [{ id: "I1", text: "put KEY VALUE" }] };

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
      interfaceEntries: [{ key: "I1", text: "put KEY VALUE" }],
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

  it("names a brief whose public interface is not the one its vision states", () => {
    const stale = brief(2, "Stated by the client", "Stated by the client");
    const renamed = { ...stale, brief: { ...stale.brief, interfaceEntries: [{ key: "I1", text: "set KEY VALUE" }] } };
    expect(keysOf({ visions: [v1, v2], briefs: [renamed] })).toEqual(['brief-interface:Write the checks for "Lock"']);
  });

  it("names structured assumptions that are not the vision's", () => {
    expect(keysOf({ visions: [v1, v2], briefs: [brief(2, "Stated by the client", "Inferred; asked of the client, not yet answered")] })).toEqual([
      'brief-assumptions:Write the checks for "Lock"',
    ]);
  });
});

describe("checkTextFacts, the Liaison's questions and replies", () => {
  const question = (statement: string) => ({ id: "q1", intake: true, body: `Should commands wait?\n\nWhy it matters: x\n\nUntil you answer, we proceed on this assumption: ${statement}\n\nWhy this assumption: y` });

  it("holds a question to the assumption its vision records for it", () => {
    expect(keysOf({ visions: [v1], questions: [question("Commands wait for the lock.")] })).toEqual([]);
    expect(keysOf({ visions: [v1], questions: [question("Commands fail at once.")] })).toEqual(["question:A1"]);
    expect(keysOf({ visions: [v1], questions: [{ id: "q9", intake: true, body: "Anything?" }] })).toEqual(["question-unrecorded:1"]);
  });

  it("holds a reply to a changing answer to the two vision versions around it, and refuses one for a confirmation", () => {
    const changed = { ...asked, statement: "Commands fail at once.", status: "Stated", clientAnswer: { messageId: "ans1", verdict: "changes" } };
    const reply = { answerId: "ans1", body: "Your answer changes an assumption.\n\nThe plan assumed: Commands wait for the lock.\n\nWork now proceeds on: Commands fail at once." };
    expect(keysOf({ visions: [v1, { ...v2, inferences: [changed] }], answerReplies: [reply] })).toEqual([]);
    expect(keysOf({ visions: [v1, v2], answerReplies: [reply] })).toEqual(["answer-reply:A1"]);
  });

  it("holds the one contract draft to every guarantee of the first vision with its basis, and every assumption", () => {
    const design = { key: "A2", statement: "Keys are short.", status: "Inferred", kind: "internal-design", disclosed: "reported", underpins: [] };
    const vision = {
      ...v1,
      inferences: [{ ...asked, underpins: ["G1"] }, design],
      guarantees: [
        { id: "G1", statement: "put waits for the lock.", source: { kind: "tender", quote: "put" } },
        { id: "G2", statement: "get prints the value.", source: { kind: "tender", quote: "get" } },
      ],
    };
    const draft = (g1: string) => ({
      id: "r1",
      body: [
        "This is the contract we are working to, drafted from your tender.",
        `What we guarantee, each with what it rests on:\n- G1: put waits for the lock. (basis: ${g1})\n- G2: get prints the value. (basis: what your tender states)`,
        "The assumptions the guarantees rest on:\n- A1: Commands wait for the lock. (underpins G1; asked in a question)",
        "Basis of Design, our own design choices, which your acceptance does not depend on:\n- A2: Keys are short.",
      ].join("\n\n"),
    });
    const atRisk = "an assumption you have not confirmed; at risk until you confirm A1";
    expect(keysOf({ visions: [vision], tenderReports: [draft(atRisk)] })).toEqual([]);
    expect(keysOf({ visions: [vision], tenderReports: [draft("what your tender states")] })).toEqual(["contract-draft:G1"]);
    expect(keysOf({ visions: [vision], tenderReports: [] })).toEqual(["contract-draft"]);
    expect(keysOf({ visions: [vision], tenderReports: [draft(atRisk), { ...draft(atRisk), id: "r2" }] })).toEqual(["contract-draft"]);
    expect(keysOf({ visions: [v1], tenderReports: [draft(atRisk)] })).toEqual(["contract-draft"]);
  });

  // A contract whose every guarantee is marked not verifiable by Ashara is declined: each guarantee is
  // listed marked so, every intake message states the decline, and none says work is under way.
  it("holds a declined contract's draft and questions to the decline", () => {
    const marked = { id: "G1", statement: "put waits for the lock.", source: { kind: "tender", quote: "put" }, verification: "not-by-ashara" };
    const vision = { ...v1, inferences: [{ ...asked, underpins: ["G1"] }], guarantees: [marked] };
    const decline =
      "Ashara cannot verify any guarantee of this contract as written: no check Ashara can run today would show any of them holding. " +
      "Please restate the guarantees so that at least one is seen in what the product outputs. No work starts on this contract until you do: " +
      "confirming it as written does not start it.";
    const draft = (opening: string, g1: string) => ({
      id: "r1",
      body: [
        opening,
        `What we guarantee, each with what it rests on:\n- G1: put waits for the lock. (basis: ${g1})`,
        "The assumptions the guarantees rest on:\n- A1: Commands wait for the lock. (underpins G1; asked in a question)",
      ].join("\n\n"),
    });
    const listed = "an assumption you have not confirmed; at risk until you confirm A1; not verifiable by Ashara: no check Ashara can run today shows it holding";
    const question = { id: "q1", intake: true, body: `Should commands wait?\n\nWhy it matters: x\n\nUntil you answer, the contract rests on this assumption: Commands wait for the lock.\n\nWhy this assumption: y\n\n${decline}` };
    const declined = `This is the contract drafted from your tender, and Ashara declines it as written. ${decline}`;
    expect(keysOf({ visions: [vision], questions: [question], tenderReports: [draft(declined, listed)] })).toEqual([]);
    expect(keysOf({ visions: [vision], questions: [question], tenderReports: [draft(declined, "an assumption you have not confirmed; at risk until you confirm A1")] })).toEqual([
      "contract-draft:G1",
    ]);
    expect(keysOf({ visions: [vision], questions: [question], tenderReports: [draft(`${declined} Work has started on this list.`, listed)] })).toEqual([
      "declined-intake:2",
    ]);
    expect(keysOf({ visions: [vision], questions: [{ ...question, body: question.body.replace(decline, "") }], tenderReports: [draft(declined, listed)] })).toEqual([
      "declined-intake:1",
    ]);
    const proceeds = question.body.replace("the contract rests on this assumption", "we proceed on this assumption");
    expect(keysOf({ visions: [vision], questions: [{ ...question, body: proceeds }], tenderReports: [draft(declined, listed)] })).toEqual(["declined-intake:1"]);
    // A task's question, posted once work is under way on a restated contract, is no intake message.
    const taskQuestion = { id: "q2", intake: false, body: "Which start command?" };
    expect(keysOf({ visions: [vision], questions: [question, taskQuestion], tenderReports: [draft(declined, listed)] }).filter((key) => key.startsWith("declined-intake"))).toEqual([]);
  });

  it("finds work on a project whose every vision version is declined, and none once a version holds a guarantee Ashara can verify", () => {
    const at = (version: number, verification: string) => ({ ...v1, version, guarantees: [{ id: "G1", statement: "s", source: { kind: "tender", quote: "s" }, verification }] });
    expect(declinedWork({ ...none, visions: [at(1, "not-by-ashara"), at(2, "not-by-ashara")], workItems: 3 })).toContain("every vision version it held (v1-v2)");
    expect(declinedWork({ ...none, visions: [at(1, "not-by-ashara")], workItems: 0 })).toBeNull();
    expect(declinedWork({ ...none, visions: [at(1, "not-by-ashara"), at(2, "by-ashara")], workItems: 3 })).toBeNull();
    // A guarantee stored before the mark is never read as declined.
    expect(declinedWork({ ...none, visions: [{ ...v1, guarantees: [{ id: "G1", statement: "s", source: { kind: "tender", quote: "s" } }] }], workItems: 3 })).toBeNull();
  });
});

describe("checkTextFacts, the tender's reading", () => {
  const confirmed = { confirmation: "confirmed", secondStrength: "same-family-other-model", secondQuestions: 0 };
  const told = { id: "r2", body: "We read your tender and found nothing in it we need to ask you. A second reading of it, by another model of the same family as the first reading, which shares more, found nothing to ask either." };
  const delivered = (sentence: string) => ({ sweepId: "s1", body: `Your project is delivered.\n\n${sentence}\n\nNothing more is built.`, mainCommit: "c".repeat(40), visionAtAcceptance: 1 });

  it("holds a reading that asked nothing to one report naming the second reading's strength, and the delivered report too", () => {
    const sentence = "When your tender was read, the first reading found nothing in it to ask you, and a second reading, by another model of the same family as the first reading, found nothing to ask either.";
    expect(keysOf({ intakeReading: confirmed, tenderReports: [told], delivered: [delivered(sentence)] })).toEqual([]);
    expect(keysOf({ intakeReading: { ...confirmed, secondStrength: "other-family" }, tenderReports: [told], delivered: [delivered(sentence)] })).toEqual(["reading-report", "delivered-reading"]);
    expect(keysOf({ intakeReading: confirmed, tenderReports: [], delivered: [] })).toEqual(["reading-report"]);
  });

  it("holds an unconfirmed reading to a report that says so, and a delivered report that names it not verified", () => {
    const unconfirmed = { confirmation: "unconfirmed", secondStrength: null, secondQuestions: null };
    const report = { id: "r3", body: "We read your tender and found nothing in it to ask, but no second reading of it could be had to confirm that, so that reading is unconfirmed." };
    const sentence = "When your tender was read, it found nothing in it to ask you, and no second reading could be had to confirm that: that your tender left nothing to ask is not verified by Ashara.";
    expect(keysOf({ intakeReading: unconfirmed, tenderReports: [report], delivered: [delivered(sentence)] })).toEqual([]);
    expect(keysOf({ intakeReading: unconfirmed, tenderReports: [report], delivered: [delivered("When your tender was read, it was fine.")] })).toEqual(["delivered-reading"]);
  });

  it("names a reading report for a reading that asked questions, and a delivered report silent on a reading not on record", () => {
    expect(keysOf({ tenderReports: [told] })).toEqual(["reading-report"]);
    expect(keysOf({ intakeReading: null, delivered: [delivered("Nothing about the tender.")] })).toEqual(["delivered-reading"]);
    expect(keysOf({ intakeReading: null, delivered: [delivered("How your tender was read is not on record for this project.")] })).toEqual([]);
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

describe("checkTextFacts, the delivered report's assumptions", () => {
  const delivered = (lines: readonly string[], visionAtAcceptance: number) => ({
    sweepId: "s1",
    mainCommit: "c".repeat(40),
    visionAtAcceptance,
    body: `Your project is delivered.\n\nThe assumptions the guarantees rest on:\n${lines.join("\n")}\n\nWhat is left out: nothing is excluded on record.`,
  });

  // An assumption the client has not stated is never told to them as theirs, and one they stated always is.
  it("holds each assumption to whether the client stated it in the vision at acceptance", () => {
    expect(keysOf({ visions: [v1, v2], delivered: [delivered(["- A1: Commands wait for the lock. (underpins G1; stated by you)"], 2)] })).toEqual([]);
    expect(keysOf({ visions: [v1, v2], delivered: [delivered(["- A1: Commands wait for the lock. (not confirmed by you)"], 1)] })).toEqual([]);
    expect(keysOf({ visions: [v1, v2], delivered: [delivered(["- A1: Commands wait for the lock. (stated by you)"], 1)] })).toEqual(["delivered-standing:A1"]);
    expect(keysOf({ visions: [v1, v2], delivered: [delivered(["- A1: Commands wait for the lock. (not confirmed by you)"], 2)] })).toEqual(["delivered-standing:A1"]);
  });

  it("names an assumption left out, listed twice, or one the vision does not hold", () => {
    expect(keysOf({ visions: [v1], delivered: [delivered([], 1)] })).toEqual(["delivered-standing:A1"]);
    const line = "- A1: Commands wait for the lock. (not confirmed by you)";
    expect(keysOf({ visions: [v1], delivered: [delivered([line, line], 1)] })).toEqual(["delivered-standing:A1"]);
    expect(keysOf({ visions: [v1], delivered: [delivered([line, "- A9: Something else. (not confirmed by you)"], 1)] })).toEqual(["delivered-standing:A9"]);
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

  it("names a delivery whose main still holds the scaffold placeholder's marker, in any file", () => {
    const markers = (at: readonly string[]): TextFactRecords["placeholderOnMain"] => ({ kind: "read", bySweep: new Map([["s1", at]]) });
    const section = "Nothing about the interface.";
    expect(keysOf({ delivered: [report(section)], placeholderOnMain: markers(["src/refuse.c:2"]) })).toEqual(["delivered-placeholder-refusal"]);
    expect(keysOf({ delivered: [report(section)], placeholderOnMain: markers([]) })).toEqual([]);
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

  it("models a delivered interface file written whole, never the scaffold's with a line added", () => {
    // Acceptance refuses only a byte-identical file: a stand-in passing it by an edit would feed that loophole.
    for (const form of ["short", "oversized"] as const) {
      const kept = new Set(deliveredInterfaceText(form).split("\n"));
      const placeholder = publicInterfaceText(form).split("\n").filter((line) => line.trim() !== "" && !line.startsWith("```"));
      expect(placeholder.filter((line) => kept.has(line))).toEqual([]);
    }
  });
});
