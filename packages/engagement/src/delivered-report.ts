import type { SecondOpinionStrength } from "@ashara/finance";
import { keepEnds, renderElided, uncutText, wholeText } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";

// The Liaison's delivered report, a terminal message (terminal-report.ts):
// once a project is accepted on its sweep of main, the client is told, once, what was delivered:
// each goal task and how its record says it closed, and the guarantee table judged from that
// sweep's evidence: one verdict per guarantee, which a review of the checks can only hold back.
// Every sentence is rendered from a record: a close whose kind was not recorded is said to be so,
// and "not checked" is stated as not checked, never folded into "delivered" or into what passed: the
// opening claims only the run that happened. A tender whose first reading asked the
// client nothing is told with the strength of the second reading behind that, or that none answered.
// The only ways of running the product presented as verified are the commands acceptance ran and saw
// pass; the public interface file, none of whose entries acceptance runs, is quoted as unverified.

/** How a goal task's record says it closed. */
type GoalClose =
  | { readonly kind: "merged"; readonly commit: string }
  /**
   * Its checks passed on main at `commit` with nothing of its own merged; `by` is the task whose merge
   * made that commit, null when no task records it as its merge.
   */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  /** A commit is recorded, but not how it closed the task (a record from before merge kinds were recorded). */
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  /** Completed with no commit recorded at all. */
  | { readonly kind: "no-record" };

/**
 * How the tender's reading stood (intake_readings): its first reading asked the client
 * questions; or it asked none, and a second reading of the strength named asked none either or raised
 * the questions the client was sent; or no second reading answered. Or none is recorded.
 */
export type ReadingTold =
  | { readonly kind: "not-needed" }
  | { readonly kind: "confirmed"; readonly strength: SecondOpinionStrength }
  | { readonly kind: "questions-raised"; readonly strength: SecondOpinionStrength; readonly questions: number }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "unrecorded" };

/** An accepted project whose delivered report the client has not been sent. */
export interface DueDeliveredReport {
  readonly kind: "due";
  /** Failed attempts at this report so far (delivered_report_attempts.failures). */
  readonly failures: number;
  /** Failed reads of its public interface file so far (delivered_report_attempts.interface_read_failures). */
  readonly interfaceReadFailures: number;
  /** Failed attempts whose records did not make a report (delivered_report_attempts.record_failures). */
  readonly recordFailures: number;
  readonly sweepId: string;
  readonly projectId: ProjectId;
  /** The commit on main the acceptance sweep passed on. */
  readonly mainCommit: string;
  /** The project's target checkout, whose main holds the product. */
  readonly targetProjectPath: string;
  readonly goals: ReadonlyArray<{ readonly title: string; readonly close: GoalClose }>;
  /** The completed tasks whose stored checks the sweep ran, by title. */
  readonly checked: readonly string[];
  /** The completed tasks with no stored check, by title: nothing of theirs ran in the sweep. */
  readonly unchecked: readonly string[];
  /** Goal tasks given up, which the plan was repaired around, by title. */
  readonly givenUp: readonly string[];
  /** The stored checks the sweep ran and saw pass (acceptance_sweeps.check_outcomes, those passed). */
  readonly executed: ExecutedChecks;
  readonly reading: ReadingTold;
}

/**
 * The stored checks an accepted sweep ran on main and saw pass, by task title, with the command each
 * ran; or none recorded (a sweep recorded before they were), which verifies no way of running the product.
 */
export type ExecutedChecks =
  | { readonly kind: "recorded"; readonly checks: ReadonlyArray<{ readonly task: string; readonly name: string; readonly command: string }> }
  | { readonly kind: "unrecorded" };

/**
 * A passed sweep whose report its records could not be read for; `error` says why. `cause` is
 * "connection" when the database could not be reached, which says nothing of the records; "record"
 * for every other failure (a row that does not parse, a reference to nothing, Ashara's own reading
 * of them failing), which a retry meets again.
 */
export interface UnreadDeliveredReport {
  readonly kind: "unread";
  readonly cause: "record" | "connection";
  readonly failures: number;
  /** Failed attempts whose records did not read as a report (delivered_report_attempts.record_failures). */
  readonly recordFailures: number;
  readonly sweepId: string;
  readonly projectId: ProjectId;
  readonly error: unknown;
}

/**
 * A file of the product at one commit of its target checkout: its whole text, or absent from that
 * commit's tree; or, where no checkout is held (a replay of a kept run's records), why it is not read.
 */
type ProductFileAt =
  | { readonly kind: "present"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "not-held"; readonly reason: string };

/** The interface file as the report tells it: read, or every attempt to read it failed. */
export type InterfaceTold = ProductFileAt | { readonly kind: "unreadable"; readonly attempts: number; readonly sweepId: string };

/**
 * Where the product states how it is run: its public interface file, one name for every product,
 * read at one commit of the project's target checkout. The composition root supplies it from the
 * context that owns the convention; what the file says is the product's, quoted as is.
 */
export interface ProductInterfaceSource {
  /** The file, at the repository root, the product's public interface is written in. */
  readonly file: string;
  at(targetProjectPath: string, commit: string): Promise<ProductFileAt>;
}

/** A failure at a delivered report, as recorded on its sweep. */
export interface DeliveredReportFailureRecord {
  /** The failure's cause chain: what Ashara's record of the delivery keeps. */
  readonly error: string;
  /** The public interface file could not be read: counted apart, against MAX_INTERFACE_READ_FAILURES. */
  readonly interfaceRead: boolean;
  /** The records did not make a report, for any cause but an unreachable database: counted apart, against MAX_UNREAD_ATTEMPTS. */
  readonly recordUnread: boolean;
  /**
   * The wait before the next attempt, for an attempt that failed; null when this attempt posts the
   * report without what failed, so no attempt is counted and no retry is set.
   */
  readonly retryAfterSeconds: number | null;
}

/** At most this many characters of the public interface file are quoted; a longer one keeps its start and end. */
const INTERFACE_QUOTE_CHARS = 4000;

/**
 * Failed attempts after which a report whose interface file still cannot be read is posted without
 * the quote, saying so: the client is told the project is delivered, never left waiting on a read.
 */
export const MAX_INTERFACE_READ_FAILURES = 3;

/**
 * Failed attempts after which a report whose records still cannot be read is posted as an
 * acceptance notice saying so: the client is told the project was accepted, never left waiting.
 */
export const MAX_UNREAD_ATTEMPTS = 5;

/** The paragraphs of a terminal message before its guarantee table and after it (terminal-report.ts). */
interface AroundTable {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * The client's notice of acceptance when the delivered report cannot be written from the records: a
 * terminal message like the report, so the sweep's guarantee table follows its first paragraph.
 */
export function unreadNotice(sweepId: string, attempts: number): AroundTable {
  return {
    before: [
      `Your project is accepted: its acceptance sweep passed on main. Its delivered report could not be written from Ashara's ` +
        `records in ${attempts} attempts. Ashara keeps the error in its record of this delivery, acceptance sweep ${sweepId}.`,
    ],
    after: [`Nothing more is built on this project; it waits until you stop it.`],
  };
}

/** A fence no run of backticks in `text` can close early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The product's public interface file as main holds it at the accepted commit, quoted as is (never
 * reworded, so the report states nothing of the product the product does not) under a title that
 * names the file, bounded and marked where cut; or that the product has none, naming the file
 * looked for; or that it could not be read, naming the record that holds why.
 */
function interfaceSection(file: string, commit: string, read: InterfaceTold): string {
  if (read.kind === "absent") {
    return `How to run the product is not on record: its public interface file is missing. ${file} is not on main at commit ${commit}.`;
  }
  if (read.kind === "not-held") return `How to run the product is not quoted: ${file} on main at commit ${commit} was not read (${read.reason}).`;
  if (read.kind === "unreadable") {
    return (
      `How to run the product is not quoted: ${file} on main at commit ${commit} could not be read in ${read.attempts} attempts. ` +
      `Ashara keeps the error in its record of this delivery, acceptance sweep ${read.sweepId}.`
    );
  }
  const quoted = keepEnds(wholeText(read.text), INTERFACE_QUOTE_CHARS);
  const cut =
    uncutText(quoted) === null
      ? ` It is longer than ${INTERFACE_QUOTE_CHARS} characters, so only its start and end are quoted; the marker inside says how many characters were cut.`
      : "";
  return `Public interface (from ${file} on main at commit ${commit}), quoted as the file reads.${cut} ${INTERFACE_UNVERIFIED}\n${fenced(renderElided(quoted))}`;
}

/** `text` in a fence nothing in it can close, ending its last line. */
function fenced(text: string): string {
  const fence = fenceFor(text);
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${fence}\n${body}${fence}`;
}

/**
 * What Ashara did not do with the quoted file: acceptance runs none of its entries, so an entry a
 * later change left stale reads here as the file wrote it and is never presented as verified.
 */
const INTERFACE_UNVERIFIED =
  `Acceptance ran none of what this file documents, and Ashara has not verified that it describes the delivered product. ` +
  `Where it differs from the commands acceptance ran, only those commands are verified.`;

/** At most this many characters of one check's command are quoted; a longer one keeps its start and end. */
const COMMAND_QUOTE_CHARS = 2000;

/**
 * How the product was run in acceptance, and only that: each stored check the sweep records it ran
 * on main and saw pass, by its task, with the command quoted as it ran. These are the only ways of
 * running the product the report presents as verified; with none recorded it says no way is.
 */
function executedSection(commit: string, executed: ExecutedChecks): string {
  if (executed.kind === "unrecorded") {
    return `Which commands acceptance ran is not on record for this delivery, so no way of running the product is stated as verified.`;
  }
  if (executed.checks.length === 0) return `No stored check ran in acceptance, so no way of running the product is verified.`;
  return [
    `How the product was run in acceptance: each command below is a stored check that ran from the repository root of main ` +
      `at commit ${commit}, inside the project environment, and passed. These are the only ways of running the product Ashara verified.`,
    ...executed.checks.map((check) => `- "${check.task}", check "${check.name}":\n${fenced(renderElided(keepEnds(wholeText(check.command), COMMAND_QUOTE_CHARS)))}`),
  ].join("\n");
}

function closeLine(title: string, close: GoalClose): string {
  switch (close.kind) {
    case "merged":
      return `- "${title}": built and merged, commit ${close.commit}.`;
    case "already-delivered":
      return (
        `- "${title}": already delivered when its turn came; nothing of its own was merged. Its checks, and every ` +
        `check of the work before it, passed on commit ${close.commit}` +
        (close.by === null ? ", which no task's merge is recorded as making." : `, the merge of "${close.by}".`)
      );
    case "unrecorded-kind":
      return `- "${title}": closed on commit ${close.commit}; whether it was merged or already delivered there is not on record.`;
    case "no-record":
      return `- "${title}": closed with no commit on record.`;
  }
}

/** Who gave the second reading of the tender, in the client's words: a weaker strength says what it shares. */
const READ_BY: Readonly<Record<SecondOpinionStrength, string>> = {
  "other-family": "another model family",
  "same-family-other-model": "another model of the same family as the first reading, which shares more of its blind spots than another family would",
  "same-model": "the same model as the first reading asked again to look for what is ambiguous or assumed, which shares every one of its blind spots",
};

/**
 * How the tender was read, where its first reading asked the client nothing: the strength of the second reading that confirmed it or raised the questions the
 * client was sent, or that none answered, so that the tender left nothing to ask is not verified by
 * Ashara. Not on record is said so. Empty when the first reading asked questions.
 */
function readingSection(reading: ReadingTold): string[] {
  switch (reading.kind) {
    case "not-needed":
      return [];
    case "confirmed":
      return [`When your tender was read, the first reading found nothing in it to ask you, and a second reading, by ${READ_BY[reading.strength]}, found nothing to ask either.`];
    case "questions-raised":
      return [
        `When your tender was read, the first reading found nothing in it to ask you; a second reading, by ${READ_BY[reading.strength]}, ` +
          `found ${plural(reading.questions, "question")}, which you were sent.`,
      ];
    case "unconfirmed":
      return [`When your tender was read, it found nothing in it to ask you, and no second reading could be had to confirm that: that your tender left nothing to ask is not verified by Ashara.`];
    case "unrecorded":
      return [`How your tender was read is not on record for this project, so whether a second reading confirmed it is not stated.`];
  }
}

/** What ran on main, and only that: the environment's test and the stored checks of the tasks named. */
function opening(due: DueDeliveredReport): string {
  const ran =
    due.checked.length === 0
      ? `the environment's test passed on main, commit ${due.mainCommit}; no stored check of any task ran with it`
      : `the environment's test and the stored checks of ${plural(due.checked.length, "completed task")} passed together on main, commit ${due.mainCommit}`;
  return `Your project is delivered. Every task of the plan is settled, and ${ran}.`;
}

/** Completed tasks with no stored check: done, but nothing confirmed them, kept apart from what passed. */
function uncheckedSection(unchecked: readonly string[]): string[] {
  if (unchecked.length === 0) return [];
  return [
    [
      `These tasks are done but not checked by a stored check: none was written for them, so nothing in the run above confirms them:`,
      ...unchecked.map((title) => `- "${title}"`),
    ].join("\n"),
  ];
}

function givenUpSection(givenUp: readonly string[]): string[] {
  if (givenUp.length === 0) return [];
  return [[`These tasks were given up, and the plan was revised around them:`, ...givenUp.map((title) => `- "${title}"`)].join("\n")];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The client's delivered report, every line from the records; the sweep's guarantee table goes between its two parts. */
export function deliveredReport(due: DueDeliveredReport, file: string, productInterface: InterfaceTold): AroundTable {
  return {
    before: [
      opening(due),
      `What was delivered:\n${due.goals.map((goal) => closeLine(goal.title, goal.close)).join("\n")}`,
      executedSection(due.mainCommit, due.executed),
      interfaceSection(file, due.mainCommit, productInterface),
      ...uncheckedSection(due.unchecked),
      ...givenUpSection(due.givenUp),
    ],
    after: [...readingSection(due.reading), `Nothing more is built on this project; it waits until you stop it.`],
  };
}
