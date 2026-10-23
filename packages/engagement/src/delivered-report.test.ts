import { describe, expect, test } from "vitest";
import { parseProjectId } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import type { DeliveredReportFailureRecord, DueDeliveredReport, ProductInterfaceSource, UnreadDeliveredReport } from "./delivered-report.js";
import { guaranteeTableOf } from "./guarantee-report.js";
import type { GuaranteeTable, TableVerdicts } from "./guarantee-report.js";
import { TerminalReports } from "./terminal-report.js";
import type { DueTerminal, TerminalReportStore } from "./terminal-report.js";

// The delivered report is the terminal message of a passed acceptance sweep (terminal-report.ts):
// told once of its sweep, with the sweep's guarantee table.

const projectId = parseProjectId("00000000-0000-4000-8000-000000000021", "test");
const MAIN = "c".repeat(40);
const MERGE_A = "a".repeat(40);

type Due = DueDeliveredReport;
type Listed = Due | UnreadDeliveredReport;

/** A delivered report's terminal step over `store`, reading the interface file through `productInterface`. */
function deliveredReports(store: TerminalReportStore, productInterface: ProductInterfaceSource): TerminalReports {
  return new TerminalReports(store, productInterface, memoryStepContainment(() => true));
}

/** The listing of each delivered report, with the table each carries: an unread one's read on its own, or lost with the connection. */
function listedWith(listed: readonly Listed[], table: GuaranteeTable | "lost"): DueTerminal[] {
  return listed.map((report): DueTerminal => {
    if (report.kind === "due") return { kind: "delivered", report, table: NO_CONTRACT };
    return { kind: "delivered-unread", report, table: table === "lost" ? { kind: "not-read", error: new Error("Connection terminated unexpectedly") } : table };
  });
}
/**
 * A due report's records; `executed`, when not the case under test, is one check that ran, and
 * `reading` a first reading of the tender that asked the client questions.
 */
type Fields = Omit<Due, "targetProjectPath" | "kind" | "failures" | "interfaceReadFailures" | "recordFailures" | "executed" | "reading"> & {
  readonly executed?: Due["executed"];
  readonly reading?: Due["reading"];
};
const ONE_RUN: Due["executed"] = { kind: "recorded", checks: [{ task: "Count words", name: "counts", command: "python wc.py sample.txt" }] };

/** A table with no contract behind it; guarantee-report.test.ts judges the table's own text. */
const NO_CONTRACT: GuaranteeTable = guaranteeTableOf({ kind: "no-contract", sweep: { id: "s9", mainCommit: MAIN } });

const WORKSPACE = "/work/target";
const INTERFACE_FILE = "PUBLIC_INTERFACE.md";
type InterfaceRead = Awaited<ReturnType<ProductInterfaceSource["at"]>>;

async function render(fields: Fields, read: InterfaceRead = { kind: "absent" }): Promise<string> {
  const due: Due = { ...fields, executed: fields.executed ?? ONE_RUN, reading: fields.reading ?? { kind: "not-needed" }, kind: "due", failures: 0, interfaceReadFailures: 0, recordFailures: 0, targetProjectPath: WORKSPACE };
  const posted: string[] = [];
  const reads: string[] = [];
  const reports = deliveredReports(
    {
      dueTerminals: async () => listedWith([due], NO_CONTRACT),
      postTerminal: async (message) => {
        expect(message.subject).toEqual({ kind: "delivered", sweepId: due.sweepId });
        posted.push(message.body);
        return "posted";
      },
      recordDeliveredFailure: async () => expect.unreachable("no report failed"),
    },
    {
      file: INTERFACE_FILE,
      at: async (targetProjectPath, commit) => {
        reads.push(`${targetProjectPath}@${commit}`);
        return read;
      },
    },
  );
  expect(await reports.runPending()).toEqual([{ kind: "posted", projectId, terminal: "delivered" }]);
  expect(posted).toHaveLength(1);
  expect(reads).toEqual([`${WORKSPACE}@${due.mainCommit}`]);
  return posted[0];
}

const BASE: Fields = {
  sweepId: "s9",
  projectId,
  mainCommit: MAIN,
  goals: [{ title: "Count words", close: { kind: "merged", commit: MERGE_A } }],
  checked: ["Count words"],
  unchecked: [],
  givenUp: [],
};

/** The section that says how acceptance ran the product, up to the interface file's. */
function asRun(body: string): string {
  const start = body.indexOf("\n\nWhat was delivered:");
  const from = body.indexOf("\n\n", start + 2) + 2;
  const quoted = body.indexOf("\n\nPublic interface (from ");
  const end = quoted >= 0 ? quoted : body.indexOf("\n\nHow to run", from);
  expect(end).toBeGreaterThan(from);
  return body.slice(from, end);
}

/** The section that quotes the product's public interface file, or says why not, up to the next section. */
function howToRun(body: string): string {
  const quoted = body.indexOf("Public interface (from ");
  const start = quoted >= 0 ? quoted : body.indexOf("How to run");
  const end = body.indexOf("\n\nNo contract is on record");
  expect(start).toBeGreaterThan(0);
  return body.slice(start, end);
}

// The report says how to run the product as main holds it, whatever file name the plan used.
describe("how to run the product", () => {
  test("quotes the public interface file from main as is, titled by the file it is, after what was delivered", async () => {
    const text = "Run: python wc.py <file>...\n\nPrints lines, words and bytes, then a total.\n";
    const body = await render(BASE, { kind: "present", text });
    expect(body.indexOf("What was delivered:")).toBeLessThan(body.indexOf("Public interface"));
    expect(howToRun(body)).toBe(
      `Public interface (from ${INTERFACE_FILE} on main at commit ${MAIN}), quoted as the file reads. ` +
        `Acceptance ran none of what this file documents, and Ashara has not verified that it describes the delivered product. ` +
        `Where it differs from the commands acceptance ran, only those commands are verified.\n\`\`\`\n${text}\`\`\``,
    );
    expect(body).not.toContain("How to run it");
  });

  // The client is never told a stale way to run the product as verified.
  test("the CLI changed and the interface file did not: only what acceptance ran is verified, and the stale entry is quoted as unverified", async () => {
    const stale = "Run: kv put <key> <value>\n";
    const executed = { kind: "recorded" as const, checks: [{ task: "Store keys", name: "set then get", command: "./kv set a 1 && ./kv get a | grep -qx 1" }] };
    const body = await render({ ...BASE, executed }, { kind: "present", text: stale });
    const verified = asRun(body);
    expect(verified).toBe(
      `How the product was run in acceptance: each command below is a stored check that ran from the repository root of main at commit ${MAIN}, ` +
        `inside the project environment, and passed. These are the only ways of running the product Ashara verified.\n` +
        `- "Store keys", check "set then get":\n\`\`\`\n./kv set a 1 && ./kv get a | grep -qx 1\n\`\`\``,
    );
    expect(verified).not.toContain("kv put");
    const quote = howToRun(body);
    expect(quote).toContain("Acceptance ran none of what this file documents, and Ashara has not verified that it describes the delivered product.");
    expect(quote).toContain(stale);
    expect(body.indexOf(verified)).toBeLessThan(body.indexOf(quote));
  });

  test("with nothing on record of what acceptance ran, or nothing run, no way of running the product is stated as verified", async () => {
    const text = "Run: kv put <key> <value>\n";
    expect(asRun(await render({ ...BASE, executed: { kind: "unrecorded" } }, { kind: "present", text }))).toBe(
      "Which commands acceptance ran is not on record for this delivery, so no way of running the product is stated as verified.",
    );
    expect(asRun(await render({ ...BASE, executed: { kind: "recorded", checks: [] } }, { kind: "present", text }))).toBe(
      "No stored check ran in acceptance, so no way of running the product is verified.",
    );
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

// The delivered report, every line from a record.
describe("the delivered report", () => {
  test("names each goal task with how its record says it closed", async () => {
    const body = await render({
      ...BASE,
      sweepId: "s1",
      goals: [
        { title: "Store and read keys", close: { kind: "merged", commit: MERGE_A } },
        { title: "Delete keys", close: { kind: "already-delivered", commit: MERGE_A, by: "Store and read keys" } },
        { title: "List keys", close: { kind: "unrecorded-kind", commit: MERGE_A } },
        { title: "Rename keys", close: { kind: "no-record" } },
      ],
      checked: ["Store and read keys", "Delete keys", "List keys"],
    });
    expect(body).toContain(`the environment's test and the stored checks of 3 completed tasks passed together on main, commit ${MAIN}`);
    expect(body).toContain(`"Store and read keys": built and merged, commit ${MERGE_A}.`);
    expect(body).toContain(`"Delete keys": already delivered when its turn came; nothing of its own was merged.`);
    expect(body).toContain(`the merge of "Store and read keys".`);
    expect(body).toContain(`"List keys": closed on commit ${MERGE_A}; whether it was merged or already delivered there is not on record.`);
    expect(body).toContain(`"Rename keys": closed with no commit on record.`);
  });

  // The table replaces every count of items "decided and confirmed": a review never stands behind a pass.
  test("carries the sweep's guarantee table after what ran, before how the tender was read and the closing line", async () => {
    const body = await render({ ...BASE, reading: { kind: "unconfirmed" } });
    const parts = body.split("\n\n");
    const table = parts.indexOf("No contract is on record for this project at sweep s9, so no guarantee is judged.");
    expect(table).toBeGreaterThan(parts.findIndex((part) => part.startsWith("What was delivered:")));
    expect(table).toBeLessThan(parts.findIndex((part) => part.startsWith("When your tender was read")));
    expect(parts.at(-1)).toBe("Nothing more is built on this project; it waits until you stop it.");
    expect(body).not.toMatch(/second review of those checks|decided by no stored check/);
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
    });
    expect(body).toContain(`the environment's test passed on main, commit ${MAIN}; no stored check of any task ran with it.`);
    expect(body).not.toContain("passed together");
  });
});

// The second-opinion rule applied to intake: a tender's first reading that asked the client nothing is
// told with the strength of the second reading behind it, and one no second reading confirmed is
// named not verified; a reading that asked questions adds nothing, and one not on record says so.
describe("how the tender was read", () => {
  const SENTENCE = "When your tender was read";
  test("a reading that asked questions adds no sentence", async () => {
    expect(await render({ ...BASE, reading: { kind: "not-needed" } })).not.toContain(SENTENCE);
  });

  test("a confirmed reading names the strength of the second reading", async () => {
    const body = await render({ ...BASE, reading: { kind: "confirmed", strength: "same-family-other-model" } });
    expect(body).toContain(
      "When your tender was read, the first reading found nothing in it to ask you, and a second reading, by another model of the same family as the first reading, which shares more of its blind spots than another family would, found nothing to ask either.",
    );
  });

  test("a second reading that raised questions says how many the client was sent", async () => {
    const body = await render({ ...BASE, reading: { kind: "questions-raised", strength: "other-family", questions: 2 } });
    expect(body).toContain("a second reading, by another model family, found 2 questions, which you were sent.");
  });

  test("an unconfirmed reading is named not verified by Ashara", async () => {
    const body = await render({ ...BASE, reading: { kind: "unconfirmed" } });
    expect(body).toContain("no second reading could be had to confirm that: that your tender left nothing to ask is not verified by Ashara.");
  });

  test("a reading not on record is said to be so", async () => {
    expect(await render({ ...BASE, reading: { kind: "unrecorded" } })).toContain("How your tender was read is not on record for this project");
  });
});

// One project's report failing never stops another's, and is recorded, retried with a backoff and,
// past its bound of interface reads, posted saying the file could not be read.
describe("a delivered report that fails is its own project's", () => {
  const otherId = parseProjectId("00000000-0000-4000-8000-000000000022", "test");
  const BROKEN = "/work/broken";
  /** A workspace whose interface file reads, and whose report then fails to render: a failure no step names. */
  const UNRENDERABLE = "/work/unrenderable";

  function store(listed: readonly Listed[], post: "posts" | "fails" = "posts", table: GuaranteeTable | "lost" = NO_CONTRACT) {
    const posted: Array<{ sweepId: string; body: string; verdicts: TableVerdicts }> = [];
    const failures: Array<{ sweepId: string } & DeliveredReportFailureRecord> = [];
    const reportStore: TerminalReportStore = {
      dueTerminals: async () => listedWith(listed, table),
      postTerminal: async ({ subject, body, verdicts }) => {
        if (post === "fails") throw new Error("client_messages insert failed: connection reset");
        posted.push({ sweepId: subject.kind === "delivered" ? subject.sweepId : expect.unreachable("a delivered report"), body, verdicts });
        return "posted";
      },
      recordDeliveredFailure: async (sweepId, failure) => {
        failures.push({ sweepId, ...failure });
      },
    };
    const reports = deliveredReports(reportStore, {
      file: INTERFACE_FILE,
      at: async (targetProjectPath) => {
        if (targetProjectPath === BROKEN) throw new Error("git ls-tree: fatal: not a git repository");
        if (targetProjectPath === UNRENDERABLE) {
          return {
            kind: "present",
            get text(): string {
              throw new TypeError("cannot read properties of undefined (reading 'length')");
            },
          };
        }
        return { kind: "absent" };
      },
    });
    return { reports, posted, failures };
  }

  const due = (sweepId: string, id: typeof projectId, targetProjectPath: string, failures: number, interfaceReadFailures = failures): Due => ({
    ...BASE,
    executed: ONE_RUN,
    reading: { kind: "not-needed" },
    kind: "due",
    failures,
    interfaceReadFailures,
    recordFailures: 0,
    sweepId,
    projectId: id,
    targetProjectPath,
  });

  test("a report that cannot be rendered from what was read is that project's: counted toward the notice, the other project's posted", async () => {
    const { reports, posted, failures } = store([due("s-bad", otherId, UNRENDERABLE, 0), due("s-ok", projectId, WORKSPACE, 0)]);

    expect((await reports.runPending()).map((o) => [o.kind, o.projectId])).toEqual([
      ["failed", otherId],
      ["posted", projectId],
    ]);
    expect(posted.map((p) => p.sweepId)).toEqual(["s-ok"]);
    expect(failures).toEqual([{ sweepId: "s-bad", error: expect.stringContaining("TypeError"), interfaceRead: false, recordUnread: true, retryAfterSeconds: 60 }]);
  });

  test("a failure that cannot be recorded throws through: a report's failure is never dropped", async () => {
    const unread: Listed = { kind: "unread", cause: "record", failures: 0, recordFailures: 0, sweepId: "s-unread", projectId: otherId, error: new Error("bad record") };
    const reports = deliveredReports(
      {
        dueTerminals: async () => listedWith([unread], NO_CONTRACT),
        postTerminal: async () => "posted",
        recordDeliveredFailure: async () => Promise.reject(new Error("ledger down")),
      },
      { file: INTERFACE_FILE, at: async () => ({ kind: "absent" }) },
    );
    await expect(reports.runPending()).rejects.toMatchObject({ name: "DeliveredReportFailureUnrecorded" });
  });

  test("two projects, one whose interface file git cannot read: the other is posted, the failure recorded with a backoff", async () => {
    const { reports, posted, failures } = store([due("s-broken", otherId, BROKEN, 0), due("s-ok", projectId, WORKSPACE, 0)]);

    const outcomes = await reports.runPending();

    expect(outcomes.map((o) => [o.kind, o.projectId])).toEqual([
      ["failed", otherId],
      ["posted", projectId],
    ]);
    expect(posted.map((p) => p.sweepId)).toEqual(["s-ok"]);
    expect(failures).toEqual([{ sweepId: "s-broken", error: expect.stringContaining("not a git repository"), interfaceRead: true, recordUnread: false, retryAfterSeconds: 60 }]);
    const [failed] = outcomes;
    if (failed?.kind !== "failed") return expect.unreachable("the broken project's report did not fail");
    expect(failed.failure.message).toContain(`project ${otherId} (acceptance sweep s-broken) failed, attempt 1; tried again in 60s`);
  });

  test("a report whose records do not read as a report is recorded and retried, the backoff doubling with each failure", async () => {
    const unread: Listed = { kind: "unread", cause: "record", failures: 2, recordFailures: 2, sweepId: "s-unread", projectId: otherId, error: new Error("project records no workspace_path") };
    const { reports, posted, failures } = store([unread, due("s-ok", projectId, WORKSPACE, 0)]);

    expect((await reports.runPending()).map((o) => o.kind)).toEqual(["failed", "posted"]);
    expect(posted.map((p) => p.sweepId)).toEqual(["s-ok"]);
    expect(failures).toEqual([{ sweepId: "s-unread", error: expect.stringContaining("workspace_path"), interfaceRead: false, recordUnread: true, retryAfterSeconds: 240 }]);
  });

  test("past its bound of records that do not read as a report, the client is told the project was accepted, where the error is kept, and the sweep's table", async () => {
    const unread: Listed = { kind: "unread", cause: "record", failures: 4, recordFailures: 4, sweepId: "s-unread", projectId: otherId, error: new Error("project records no workspace_path") };
    const { reports, posted, failures } = store([unread]);

    expect((await reports.runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(failures).toEqual([{ sweepId: "s-unread", error: expect.stringContaining("workspace_path"), interfaceRead: false, recordUnread: true, retryAfterSeconds: null }]);
    expect(posted[0]?.body).toBe(
      `Your project is accepted: its acceptance sweep passed on main. Its delivered report could not be written from Ashara's ` +
        `records in 5 attempts. Ashara keeps the error in its record of this delivery, acceptance sweep s-unread.\n\n` +
        `No contract is on record for this project at sweep s9, so no guarantee is judged.\n\n` +
        `Nothing more is built on this project; it waits until you stop it.`,
    );
    expect(posted[0]?.verdicts).toEqual({ sweepId: "s9", verdicts: [] });
  });

  test("an acceptance notice whose table cannot be read for a lost connection is retried, never posted without it", async () => {
    const unread: Listed = { kind: "unread", cause: "record", failures: 4, recordFailures: 4, sweepId: "s-unread", projectId: otherId, error: new Error("project records no workspace_path") };
    const { reports, posted, failures } = store([unread], "posts", "lost");

    expect((await reports.runPending()).map((o) => o.kind)).toEqual(["failed"]);
    expect(posted).toEqual([]);
    expect(failures).toEqual([{ sweepId: "s-unread", error: expect.stringContaining("Connection terminated"), interfaceRead: false, recordUnread: false, retryAfterSeconds: expect.any(Number) }]);
  });

  test("a read of the records that failed (a lost connection) is retried and never counts toward the notice, however often", async () => {
    const lost: Listed = { kind: "unread", cause: "connection", failures: 9, recordFailures: 0, sweepId: "s-lost", projectId: otherId, error: new Error("Connection terminated unexpectedly") };
    const { reports, posted, failures } = store([lost]);

    expect((await reports.runPending()).map((o) => o.kind)).toEqual(["failed"]);
    expect(posted).toEqual([]);
    expect(failures).toEqual([{ sweepId: "s-lost", error: expect.stringContaining("Connection terminated"), interfaceRead: false, recordUnread: false, retryAfterSeconds: 3600 }]);
  });

  test("past its bound of failed reads, the report is posted saying the file could not be read and where the error is kept", async () => {
    const { reports, posted, failures } = store([due("s-broken", otherId, BROKEN, 2)]);

    expect((await reports.runPending()).map((o) => o.kind)).toEqual(["posted"]);
    expect(failures).toEqual([{ sweepId: "s-broken", error: expect.stringContaining("not a git repository"), interfaceRead: true, recordUnread: false, retryAfterSeconds: null }]);
    expect(howToRun(posted[0]?.body ?? "")).toBe(
      `How to run the product is not quoted: ${INTERFACE_FILE} on main at commit ${MAIN} could not be read in 3 attempts. ` +
        `Ashara keeps the error in its record of this delivery, acceptance sweep s-broken.`,
    );
    expect(posted[0]?.body).not.toContain("not a git repository");
  });

  test("failures of other kinds do not count against the interface file's reads: one failed read is retried, never posted without the quote", async () => {
    const { reports, posted, failures } = store([due("s-broken", otherId, BROKEN, 4, 0)]);

    expect((await reports.runPending()).map((o) => o.kind)).toEqual(["failed"]);
    expect(posted).toEqual([]);
    expect(failures).toEqual([{ sweepId: "s-broken", error: expect.stringContaining("not a git repository"), interfaceRead: true, recordUnread: false, retryAfterSeconds: 960 }]);
  });

  test("a post that fails after the reads ran out counts one failed attempt, the attempt the log names", async () => {
    const { reports, failures } = store([due("s-broken", otherId, BROKEN, 2)], "fails");

    const [outcome] = await reports.runPending();

    if (outcome?.kind !== "failed") return expect.unreachable("the post did not fail");
    expect(failures.map((f) => [f.interfaceRead, f.retryAfterSeconds])).toEqual([
      [true, null],
      [false, 240],
    ]);
    expect(failures.filter((f) => f.retryAfterSeconds !== null)).toHaveLength(1);
    expect(outcome.failure.message).toContain("failed, attempt 3; tried again in 240s");
  });
});
