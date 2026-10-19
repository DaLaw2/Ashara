import type { SecondOpinionStrength } from "@ashara/finance";
import { describeErrorChain, faultBackoffSeconds, keepEnds, renderElided, uncutText, wholeText } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { guaranteeSection, tableVerdicts } from "./guarantee-report.js";
import type { GuaranteeTable, TableVerdicts } from "./guarantee-report.js";

// The Liaison's delivered report:
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
  /** Its checks passed on main at `commit` with nothing of its own merged; `by` is the task whose merge made that commit. */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  | { readonly kind: "no-record" };

/**
 * How independent of the first reading of the tender its second reading was: another model family,
 * another model of the same family, or the same model asked again from another angle.
 */
type ReviewStrength = SecondOpinionStrength;

/**
 * How the tender's reading stood (intake_readings): its first reading asked the client
 * questions; or it asked none, and a second reading of the strength named asked none either or raised
 * the questions the client was sent; or no second reading answered. Or none is recorded.
 */
export type ReadingTold =
  | { readonly kind: "not-needed" }
  | { readonly kind: "confirmed"; readonly strength: ReviewStrength }
  | { readonly kind: "questions-raised"; readonly strength: ReviewStrength; readonly questions: number }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "unrecorded" };

/** An accepted project whose delivered report the client has not been sent. */
interface DueDeliveredReport {
  readonly kind: "due";
  /** Failed attempts at this report so far (acceptance_sweeps.report_failures). */
  readonly failures: number;
  /** Failed reads of its public interface file so far (acceptance_sweeps.report_interface_read_failures). */
  readonly interfaceReadFailures: number;
  /** Failed attempts whose records did not make a report (acceptance_sweeps.report_record_failures). */
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
  /** The guarantee table judged from the sweep's evidence. */
  readonly guarantees: GuaranteeTable;
  readonly reading: ReadingTold;
}

/**
 * The stored checks an accepted sweep ran on main and saw pass, by task title, with the command each
 * ran; or none recorded (a sweep recorded before they were), which verifies no way of running the product.
 */
type ExecutedChecks =
  | { readonly kind: "recorded"; readonly checks: ReadonlyArray<{ readonly task: string; readonly name: string; readonly command: string }> }
  | { readonly kind: "unrecorded" };

/**
 * A passed sweep whose report its records could not be read for; `error` says why. `cause` is
 * "connection" when the database could not be reached, which says nothing of the records; "record"
 * for every other failure (a row that does not parse, a reference to nothing, Ashara's own reading
 * of them failing), which a retry meets again.
 */
interface UnreadDeliveredReport {
  readonly kind: "unread";
  readonly cause: "record" | "connection";
  readonly failures: number;
  /** Failed attempts whose records did not read as a report (acceptance_sweeps.report_record_failures). */
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
type InterfaceTold = ProductFileAt | { readonly kind: "unreadable"; readonly attempts: number; readonly sweepId: string };

/**
 * Where the product states how it is run: its public interface file, one name for every product,
 * read at one commit of the project's target checkout. The composition root supplies it from the
 * context that owns the convention; what the file says is the product's, quoted as is.
 */
interface ProductInterfaceSource {
  /** The file, at the repository root, the product's public interface is written in. */
  readonly file: string;
  at(targetProjectPath: string, commit: string): Promise<ProductFileAt>;
}

/** Engagement's persistence port for delivered reports. */
export interface DeliveredReportStore {
  /**
   * Every report due, each assembled from its records or the reason it could not be; a sweep whose
   * last failed attempt set a retry time is listed once that time has passed.
   */
  dueReports(): Promise<ReadonlyArray<DueDeliveredReport | UnreadDeliveredReport>>;
  /**
   * The sweep's guarantee table read on its own, for the acceptance notice; records that do not hold
   * together as a table read as the unreadable table.
   */
  guaranteeTable(sweepId: string): Promise<GuaranteeTable>;
  /** Posts the report on the accepted sweep unless one is posted, with its table's verdicts. */
  postReport(sweepId: string, body: string, verdicts: TableVerdicts): Promise<"posted" | "already-posted">;
  /** Records a failure at the sweep's report (DeliveredReportFailureRecord). */
  recordReportFailure(sweepId: string, failure: DeliveredReportFailureRecord): Promise<void>;
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

/** A failure at a delivered report could not be recorded on its sweep: the cycle's step fails, as its listing would. */
class DeliveredReportFailureUnrecorded extends Error {
  constructor(
    readonly sweepId: string,
    cause: unknown,
  ) {
    super(`a failed delivered report could not be recorded on acceptance sweep ${sweepId}`, { cause });
    this.name = "DeliveredReportFailureUnrecorded";
  }
}

/** One project's delivered report failed this cycle; it is tried again after `retryAfterSeconds`. */
class DeliveredReportFailed extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly sweepId: string,
    readonly failures: number,
    readonly retryAfterSeconds: number,
    cause: unknown,
  ) {
    super(
      `delivered report of project ${projectId} (acceptance sweep ${sweepId}) failed, attempt ${failures}; tried again in ` +
        `${retryAfterSeconds}s: ${describeErrorChain(cause)}`,
      { cause },
    );
    this.name = "DeliveredReportFailed";
  }
}

type DeliveredReportOutcome =
  | { readonly kind: "posted" | "already-posted"; readonly projectId: ProjectId }
  | { readonly kind: "failed"; readonly projectId: ProjectId; readonly failure: DeliveredReportFailed };

/** At most this many characters of the public interface file are quoted; a longer one keeps its start and end. */
const INTERFACE_QUOTE_CHARS = 4000;

/**
 * Failed attempts after which a report whose interface file still cannot be read is posted without
 * the quote, saying so: the client is told the project is delivered, never left waiting on a read.
 */
const MAX_INTERFACE_READ_FAILURES = 3;

/**
 * Failed attempts after which a report whose records still cannot be read is posted as an
 * acceptance notice saying so: the client is told the project was accepted, never left waiting.
 */
const MAX_UNREAD_ATTEMPTS = 5;

/**
 * The client's notice of acceptance when the delivered report cannot be written from the records: a
 * terminal message like the report, so it carries the sweep's guarantee table.
 */
function unreadNotice(due: UnreadDeliveredReport, attempts: number, guarantees: GuaranteeTable): string {
  return [
    `Your project is accepted: its acceptance sweep passed on main. Its delivered report could not be written from Ashara's ` +
      `records in ${attempts} attempts. Ashara keeps the error in its record of this delivery, acceptance sweep ${due.sweepId}.`,
    guaranteeSection(guarantees),
    `Nothing more is built on this project; it waits until you stop it.`,
  ].join("\n\n");
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

/** What the core loop asks of the Liaison each cycle (no LLM call). */
export interface LiaisonDeliveredReports {
  runPending(): Promise<readonly DeliveredReportOutcome[]>;
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
const READ_BY: Readonly<Record<ReviewStrength, string>> = {
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

/** The client's delivered report, every line from the records. */
function deliveredReport(due: DueDeliveredReport, file: string, productInterface: InterfaceTold): string {
  return [
    opening(due),
    `What was delivered:\n${due.goals.map((goal) => closeLine(goal.title, goal.close)).join("\n")}`,
    executedSection(due.mainCommit, due.executed),
    interfaceSection(file, due.mainCommit, productInterface),
    ...uncheckedSection(due.unchecked),
    ...givenUpSection(due.givenUp),
    guaranteeSection(due.guarantees),
    ...readingSection(due.reading),
    `Nothing more is built on this project; it waits until you stop it.`,
  ].join("\n\n");
}

export class DeliveredReports implements LiaisonDeliveredReports {
  constructor(
    private readonly store: DeliveredReportStore,
    private readonly productInterface: ProductInterfaceSource,
  ) {}

  /**
   * One report per due sweep. A failure of one project's report (its records, its interface file,
   * its post) is that project's: recorded on its sweep, logged at warn and tried again after a
   * backoff, never thrown into the cycle. Past MAX_INTERFACE_READ_FAILURES reads the report is
   * posted without the quote; past MAX_UNREAD_ATTEMPTS attempts whose records did not read as a
   * report the client is sent an acceptance notice instead of it. A read of the records the database's
   * connection failed is retried and never counted toward that notice: a lost connection says nothing
   * of the records. Only a failure to list the reports or to record a failure throws through.
   */
  async runPending(): Promise<readonly DeliveredReportOutcome[]> {
    const outcomes: DeliveredReportOutcome[] = [];
    for (const due of await this.store.dueReports()) outcomes.push(await this.contained(due));
    return outcomes;
  }

  /**
   * One report, its every failure its own: one no step below handled (a report that cannot be
   * rendered from what was read) is a report its records did not make, counted toward the notice
   * like any other. Only a failure to record a failure throws through.
   */
  private async contained(due: DueDeliveredReport | UnreadDeliveredReport): Promise<DeliveredReportOutcome> {
    try {
      return await this.report(due);
    } catch (err) {
      if (err instanceof DeliveredReportFailureUnrecorded) throw err;
      return this.unread({ kind: "unread", cause: "record", failures: due.failures, recordFailures: due.recordFailures, sweepId: due.sweepId, projectId: due.projectId, error: err });
    }
  }

  /** Records a failure on the sweep; a failure to record it is marked, so it is never taken for the report's own. */
  private async recordFailure(sweepId: string, failure: DeliveredReportFailureRecord): Promise<void> {
    try {
      await this.store.recordReportFailure(sweepId, failure);
    } catch (err) {
      throw new DeliveredReportFailureUnrecorded(sweepId, err);
    }
  }

  private async report(due: DueDeliveredReport | UnreadDeliveredReport): Promise<DeliveredReportOutcome> {
    if (due.kind === "unread") return this.unread(due);
    let read: InterfaceTold;
    try {
      read = await this.productInterface.at(due.targetProjectPath, due.mainCommit);
    } catch (err) {
      const reads = due.interfaceReadFailures + 1;
      if (reads < MAX_INTERFACE_READ_FAILURES) return this.failed(due, err, "interface");
      await this.recordFailure(due.sweepId, { error: describeErrorChain(err), interfaceRead: true, recordUnread: false, retryAfterSeconds: null });
      console.warn(
        `[liaison-delivered-report] project ${due.projectId} (acceptance sweep ${due.sweepId}): ${this.productInterface.file} ` +
          `could not be read in ${reads} attempts; the report is posted without it: ${describeErrorChain(err)}`,
      );
      read = { kind: "unreadable", attempts: reads, sweepId: due.sweepId };
    }
    return this.post(due, deliveredReport(due, this.productInterface.file, read), tableVerdicts(due.guarantees));
  }

  /**
   * A report whose records cannot be read: retried; past its bound of records that do not read as a
   * report, the client is told it was accepted, with the sweep's guarantee table. A read the
   * database's connection failed, of the report or of its table, is only retried.
   */
  private async unread(due: UnreadDeliveredReport): Promise<DeliveredReportOutcome> {
    if (due.cause === "connection") return this.failed(due, due.error, "connection");
    const attempts = due.recordFailures + 1;
    if (attempts < MAX_UNREAD_ATTEMPTS) return this.failed(due, due.error, "record");
    let guarantees: GuaranteeTable;
    try {
      guarantees = await this.store.guaranteeTable(due.sweepId);
    } catch (err) {
      return this.failed(due, err, "table");
    }
    await this.recordFailure(due.sweepId, { error: describeErrorChain(due.error), interfaceRead: false, recordUnread: true, retryAfterSeconds: null });
    console.warn(
      `[liaison-delivered-report] project ${due.projectId} (acceptance sweep ${due.sweepId}): its records did not read as a report in ` +
        `${attempts} attempts; the client is sent an acceptance notice without the report: ${describeErrorChain(due.error)}`,
    );
    return this.post(due, unreadNotice(due, attempts, guarantees), tableVerdicts(guarantees));
  }

  private async post(due: DueDeliveredReport | UnreadDeliveredReport, body: string, verdicts: TableVerdicts): Promise<DeliveredReportOutcome> {
    try {
      const kind = await this.store.postReport(due.sweepId, body, verdicts);
      return { kind, projectId: due.projectId };
    } catch (err) {
      return this.failed(due, err, "post");
    }
  }

  /** A failed attempt, counted and backed off; `what` failed says which bound, if any, it counts against too. */
  private async failed(
    due: DueDeliveredReport | UnreadDeliveredReport,
    err: unknown,
    what: "interface" | "record" | "connection" | "table" | "post",
  ): Promise<DeliveredReportOutcome> {
    const failures = due.failures + 1;
    const failure = new DeliveredReportFailed(due.projectId, due.sweepId, failures, faultBackoffSeconds(failures), err);
    await this.recordFailure(due.sweepId, {
      error: describeErrorChain(err),
      interfaceRead: what === "interface",
      recordUnread: what === "record",
      retryAfterSeconds: failure.retryAfterSeconds,
    });
    console.warn(`[liaison-delivered-report] ${failure.message}`);
    return { kind: "failed", projectId: due.projectId, failure };
  }
}
