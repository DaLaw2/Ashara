import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import type { AcceptedAssumptionStanding } from "./vision-language/vision-assumption.js";
import { DeliveredReports } from "./delivered-report.js";
import type { DeliveredReportStore } from "./delivered-report.js";

const projectId = parseProjectId("00000000-0000-4000-8000-000000000021", "test");
const MAIN = "c".repeat(40);
const MERGE_A = "a".repeat(40);

type Due = Awaited<ReturnType<DeliveredReportStore["dueReports"]>>[number];
type Item = Extract<Due["vision"], { readonly kind: "recorded" }>["items"][number]["source"];

function scope(id: string, text: string, side: "in" | "out" | "unclassified" = "in"): Item {
  return { type: "scope", id, text, side };
}

function assumption(id: string, text: string, standing: AcceptedAssumptionStanding, kind: "client-visible" | "internal-design" | "unclassified"): Item {
  return { type: "assumption", id, text, standing, kind };
}

const WORKSPACE = "/work/target";
const INTERFACE_FILE = "PUBLIC_INTERFACE.md";
type InterfaceRead = Awaited<ReturnType<ConstructorParameters<typeof DeliveredReports>[1]["at"]>>;

async function render(fields: Omit<Due, "targetProjectPath">, read: InterfaceRead = { kind: "absent" }): Promise<string> {
  const due: Due = { ...fields, targetProjectPath: WORKSPACE };
  const posted: string[] = [];
  const reads: string[] = [];
  const reports = new DeliveredReports(
    {
      dueReports: async () => [due],
      postReport: async (sweepId, body) => {
        expect(sweepId).toBe(due.sweepId);
        posted.push(body);
        return "posted";
      },
    },
    {
      file: INTERFACE_FILE,
      at: async (targetProjectPath, commit) => {
        reads.push(`${targetProjectPath}@${commit}`);
        return read;
      },
    },
  );
  expect(await reports.runPending()).toEqual([{ kind: "posted", projectId }]);
  expect(posted).toHaveLength(1);
  expect(reads).toEqual([`${WORKSPACE}@${due.mainCommit}`]);
  return posted[0];
}

const BASE: Omit<Due, "targetProjectPath"> = {
  sweepId: "s9",
  projectId,
  mainCommit: MAIN,
  goals: [{ title: "Count words", close: { kind: "merged", commit: MERGE_A } }],
  checked: ["Count words"],
  unchecked: [],
  givenUp: [],
  vision: { kind: "unrecorded" },
};

/** The paragraph that tells the client how to run the product, up to the next section. */
function howToRun(body: string): string {
  const start = body.indexOf("How to run");
  const end = body.indexOf("\n\nWhich parts of what you asked for");
  expect(start).toBeGreaterThan(0);
  return body.slice(start, end);
}

// The report says how to run the product as main holds it, whatever file name the plan used.
describe("how to run the product", () => {
  test("quotes the public interface file from main as is, after what was delivered", async () => {
    const text = "Run: python wc.py <file>...\n\nPrints lines, words and bytes, then a total.\n";
    const body = await render(BASE, { kind: "present", text });
    expect(body.indexOf("What was delivered:")).toBeLessThan(body.indexOf("How to run"));
    expect(howToRun(body)).toBe(`How to run it: the product's public interface, quoted as ${INTERFACE_FILE} reads on main at commit ${MAIN}.\n\`\`\`\n${text}\`\`\``);
  });

  test("a file holding a fence is quoted in a longer one, so nothing in it closes the quote", async () => {
    const text = "Usage:\n```\nkv put <key> <value>\n```";
    const quote = howToRun(await render(BASE, { kind: "present", text }));
    expect(quote.endsWith(`\n\`\`\`\`\n${text}\n\`\`\`\``)).toBe(true);
  });

  test("with no public interface file, says the product has none and names the file looked for", async () => {
    expect(howToRun(await render(BASE))).toBe(
      `How to run the product is not on record: its public interface file is missing. ${INTERFACE_FILE} is not on main at commit ${MAIN}.`,
    );
  });

  test("where no checkout is held, says the file was not read and why, claiming neither its text nor its absence", async () => {
    expect(howToRun(await render(BASE, { kind: "not-held", reason: "no checkout here" }))).toBe(
      `How to run the product is not quoted: ${INTERFACE_FILE} on main at commit ${MAIN} was not read (no checkout here).`,
    );
  });

  test("an oversized file keeps its start and end, says it was cut, and marks how many characters are missing", async () => {
    const text = `${"H".repeat(3000)}${"m".repeat(10_000)}${"T".repeat(3000)}`;
    const quote = howToRun(await render(BASE, { kind: "present", text }));
    expect(quote).toContain(`It is longer than 4000 characters, so only its start and end are quoted;`);
    expect(quote).toContain(`\n\`\`\`\n${"H".repeat(1600)}\n[truncated by Ashara: 12000 characters cut here]\n${"T".repeat(2400)}\n\`\`\``);
  });
});

// Story s-independent-verify-m1 W7: the delivered report, every line from a record.
describe("the delivered report", () => {
  test("names each goal task with how its record says it closed, and each vision item no check covers as not checked", async () => {
    const body = await render({
      sweepId: "s1",
      projectId,
      mainCommit: MAIN,
      goals: [
        { title: "Store and read keys", close: { kind: "merged", commit: MERGE_A } },
        { title: "Delete keys", close: { kind: "already-delivered", commit: MERGE_A, by: "Store and read keys" } },
        { title: "List keys", close: { kind: "unrecorded-kind", commit: MERGE_A } },
      ],
      checked: ["Store and read keys", "Delete keys", "List keys"],
      unchecked: [],
      givenUp: [],
      vision: {
        kind: "recorded",
        items: [
          { source: scope("S1", "A key can be stored and read back"), checked: true },
          { source: scope("S2", "A key can be deleted"), checked: true },
          { source: scope("S3", "Concurrent writers never corrupt the store"), checked: false },
        ],
      },
    });
    expect(body).toContain(`the environment's test and the stored checks of 3 completed tasks passed together on main, commit ${MAIN}`);
    expect(body).toContain(`"Store and read keys": built and merged, commit ${MERGE_A}.`);
    expect(body).toContain(`"Delete keys": already delivered when its turn came; nothing of its own was merged.`);
    expect(body).toContain(`the merge of "Store and read keys".`);
    expect(body).toContain(`"List keys": closed on commit ${MERGE_A}; whether it was merged or already delivered there is not on record.`);
    expect(body).toContain("named by no acceptance criterion of a task whose stored checks passed on main");
    expect(body).toContain("- Concurrent writers never corrupt the store");
    expect(body).not.toContain("- A key can be deleted\n");
  });

  test("with no coverage on record, nothing is stated as checked", async () => {
    const body = await render({
      sweepId: "s2",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      vision: { kind: "unrecorded" },
    });
    expect(body).toContain("is not on record for this plan, so none of it is stated as checked");
  });

  test("every vision item covered is said so, and nothing else is claimed", async () => {
    const body = await render({
      sweepId: "s3",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      vision: { kind: "recorded", items: [{ source: scope("S1", "Keys can be stored"), checked: true }] },
    });
    expect(body).toContain("Every item of what you asked for is named by an acceptance criterion of a task whose stored checks passed on main.");
    expect(body).not.toContain("not checked");
  });

  test("a record with no item of what the client asked for claims no coverage", async () => {
    const body = await render({
      sweepId: "s3b",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      vision: { kind: "recorded", items: [{ source: scope("S1", "Any network service", "out"), checked: false }] },
    });
    expect(body).toContain("The plan's record holds no item of what you asked for, so none of it is stated as checked.");
    expect(body).not.toContain("Every item");
  });

  // Exclusions and internal-design assumptions are never unchecked items of what the client asked
  // for. The vision below has scope lines on both sides and assumptions of every kind.
  test("a vision with exclusions and design choices: exclusions and the team's design choices are never listed; an uncited assumption is Ashara's, as the client saw it", async () => {
    const body = await render({
      sweepId: "s6",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Implement persistent put and get with required data directory", close: { kind: "merged", commit: MAIN } }],
      checked: ["Implement persistent put and get with required data directory"],
      unchecked: ["Set up the product's layout"],
      givenUp: [],
      vision: {
        kind: "recorded",
        items: [
          { source: scope("S1", "put stores a value under a key"), checked: true },
          { source: scope("S2", "Several processes may use the same data directory at the same time"), checked: true },
          { source: scope("S3", "A partly written final log record is ignored on recovery"), checked: true },
          { source: scope("S4", "Any network service or remote access; this is a local CLI tool.", "out"), checked: false },
          { source: scope("S5", "Non-Linux platforms.", "out"), checked: false },
          { source: assumption("A4", "Commands wait for the data-directory lock.", "stated", "client-visible"), checked: true },
          { source: assumption("A2", "Keys and values are UTF-8 text.", "stated", "client-visible"), checked: false },
          { source: assumption("A8", "The tool uses an OS advisory lock on a lock file.", "reported", "internal-design"), checked: false },
          { source: assumption("A10", "Each log record is length-prefixed with a checksum.", "reported", "internal-design"), checked: false },
          { source: assumption("A20", "No artificial limit is imposed on key or value size.", "reported", "client-visible"), checked: false },
          { source: assumption("A26", "Values print with a trailing newline.", "asked", "client-visible"), checked: false },
          { source: assumption("A27", "Empty keys are refused.", "unrecorded", "unclassified"), checked: false },
        ],
      },
    });
    const coverage = body.split("\n\n").find((section) => section.includes("acceptance criterion"));
    expect(coverage).toBe(
      [
        "These items of what you asked for are named by no acceptance criterion of a task whose stored checks passed on main, so nothing confirms them either way:",
        "- Keys and values are UTF-8 text. (your answer)",
        "- Ashara's assumption, which was reported to you: No artificial limit is imposed on key or value size.",
        "- Ashara's assumption, which you were asked about and have not answered: Values print with a trailing newline.",
        "- Ashara's assumption, which Ashara has no record of showing you: Empty keys are refused. (not recorded as what you see or as how it is built)",
      ].join("\n"),
    );
    expect(body).not.toContain("network");
    expect(body).not.toContain("advisory lock");
    expect(body).not.toContain("Several processes");
  });

  // d95 a: each uncited assumption is worded by where it stood at acceptance, an answer included.
  test("an answered assumption is never said to be unanswered: each standing at acceptance has its own words", async () => {
    const body = await render({
      sweepId: "s8",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Count words", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Count words"],
      unchecked: [],
      givenUp: [],
      vision: {
        kind: "recorded",
        items: [
          { source: assumption("A1", "Python 3.12 is the runtime.", "confirmed", "client-visible"), checked: false },
          { source: assumption("A2", "Totals print last.", "changed", "client-visible"), checked: false },
          { source: assumption("A3", "No argument prints usage.", "answered", "client-visible"), checked: false },
          { source: assumption("A4", "Missing files exit 1.", "answer-unread", "client-visible"), checked: false },
        ],
      },
    });
    expect(body).toContain(
      [
        "- Python 3.12 is the runtime. (you confirmed this when asked)",
        "- Totals print last. (your answer, which changed what we had assumed)",
        "- Ashara's assumption, which you were asked about; your reply neither confirmed nor changed it: No argument prints usage.",
        "- Ashara's assumption, which you were asked about; your reply had not been read when the project was accepted: Missing files exit 1.",
      ].join("\n"),
    );
    expect(body).not.toContain("have not answered");
  });

  test("a scope line recorded without its side is listed, and says so", async () => {
    const body = await render({
      sweepId: "s7",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: [],
      givenUp: [],
      vision: { kind: "recorded", items: [{ source: scope("S1", "Out of scope: non-Linux platforms.", "unclassified"), checked: false }] },
    });
    expect(body).toContain("- Out of scope: non-Linux platforms. (recorded without saying whether it is in or out of scope)");
  });

  test("a completed task with no stored check is listed as not checked, apart from what passed, and the opening claims only what ran", async () => {
    const body = await render({
      sweepId: "s4",
      projectId,
      mainCommit: MAIN,
      goals: [{ title: "Store keys", close: { kind: "merged", commit: MERGE_A } }],
      checked: ["Store keys"],
      unchecked: ["Set up the product's module root"],
      givenUp: ["Shard the store"],
      vision: { kind: "recorded", items: [{ source: scope("S1", "Keys can be stored"), checked: true }] },
    });
    const [opening] = body.split("\n\n");
    expect(opening).toBe(
      `Your project is delivered. Every task of the plan is settled, and the environment's test and the stored checks of ` +
        `1 completed task passed together on main, commit ${MAIN}.`,
    );
    expect(opening).not.toContain("every");
    expect(body).toContain(`These tasks are done but not checked by a stored check: none was written for them, so nothing in the run above confirms them:\n- "Set up the product's module root"`);
    expect(body).toContain(`These tasks were given up, and the plan was revised around them:\n- "Shard the store"`);
  });

  test("with no stored check run at all, the opening says only the environment's test passed", async () => {
    const body = await render({
      sweepId: "s5",
      projectId,
      mainCommit: MAIN,
      goals: [],
      checked: [],
      unchecked: ["Set up the product's module root"],
      givenUp: [],
      vision: { kind: "unrecorded" },
    });
    expect(body).toContain(`the environment's test passed on main, commit ${MAIN}; no stored check of any task ran with it.`);
    expect(body).not.toContain("passed together");
  });
});
