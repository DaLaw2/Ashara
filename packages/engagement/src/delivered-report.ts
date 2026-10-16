import { describeErrorChain, keepEnds, renderElided, uncutText, wholeText } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import type { AcceptedAssumptionStanding } from "./vision-language/vision-assumption.js";
import { checkDecides } from "./vision-language/vision-source.js";
import type { VisionSource } from "./vision-language/vision-source.js";

// The Liaison's delivered report (story s-independent-verify-m1 W7, design §2.8):
// once a project is accepted on its sweep of main, the client is told, once, what was delivered:
// each goal task and how its record says it closed, and which items of what they asked for no
// stored check covers. Every sentence is rendered from a record: a close
// whose kind was not recorded is said to be so, and "not checked" is stated as not checked, never
// folded into "delivered" or into what passed: the opening claims only the run that happened. Every
// assumption classed internal design is named as not verified by Ashara (ADR-083): no check decides it.

/** How a goal task's record says it closed. */
type GoalClose =
  | { readonly kind: "merged"; readonly commit: string }
  /** Its checks passed on main at `commit` with nothing of its own merged; `by` is the task whose merge made that commit. */
  | { readonly kind: "already-delivered"; readonly commit: string; readonly by: string | null }
  | { readonly kind: "unrecorded-kind"; readonly commit: string }
  | { readonly kind: "no-record" };

/**
 * An item of the vision the plan was reviewed against: a scope line, or an assumption with where it
 * stood with the client at acceptance (d95 a), never as the plan's copy of the vision recorded it.
 */
type AcceptedVisionItem =
  | Extract<VisionSource, { readonly type: "scope" }>
  | {
      readonly type: "assumption";
      readonly id: string;
      readonly text: string;
      readonly kind: Extract<VisionSource, { readonly type: "assumption" }>["kind"];
      readonly standing: AcceptedAssumptionStanding;
    };

/**
 * Every item of the vision the plan was reviewed against, each with whether a stored check the sweep
 * ran records that it decides it (ADR-083); or none recorded.
 */
type VisionCoverage =
  | { readonly kind: "recorded"; readonly items: ReadonlyArray<{ readonly source: AcceptedVisionItem; readonly checked: boolean }> }
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
  readonly vision: VisionCoverage;
}

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
  /** Posts the report on the accepted sweep unless one is posted. */
  postReport(sweepId: string, body: string): Promise<"posted" | "already-posted">;
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

/** The client's notice of acceptance when the delivered report cannot be written from the records. */
function unreadNotice(due: UnreadDeliveredReport, attempts: number): string {
  return [
    `Your project is accepted: its acceptance sweep passed on main. Its delivered report could not be written from Ashara's ` +
      `records in ${attempts} attempts. Ashara keeps the error in its record of this delivery, acceptance sweep ${due.sweepId}.`,
    `Nothing more is built on this project; it waits until you stop it.`,
  ].join("\n\n");
}

/** Wait before the next attempt at a failed report: doubling from a minute, at most an hour. */
function retryAfterSeconds(failures: number): number {
  return Math.min(60 * 2 ** Math.max(0, failures - 1), 3600);
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
  const text = renderElided(quoted);
  const fence = fenceFor(text);
  const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  const cut =
    uncutText(quoted) === null
      ? ` It is longer than ${INTERFACE_QUOTE_CHARS} characters, so only its start and end are quoted; the marker inside says how many characters were cut.`
      : "";
  return `Public interface (from ${file} on main at commit ${commit}), quoted as the file reads.${cut} ${INTERFACE_UNVERIFIED}\n${fence}\n${body}${fence}`;
}

/**
 * What Ashara checked of the quoted file, and what it did not: acceptance compares its bytes with
 * the product scaffold's placeholder and never judges what it says.
 */
const INTERFACE_UNVERIFIED =
  `This file changed since the product scaffold wrote it: acceptance refuses one left byte for byte as the scaffold ` +
  `wrote it, or missing. Ashara has not verified that it describes the delivered product.`;

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

/**
 * Whether the item is part of what the client asked for: a line the vision records as out
 * of scope is not, nor is an assumption recorded as the team's own design choice, which the client
 * was told their acceptance does not depend on. Everything else is, an unclassified one included.
 */
function askedFor(source: AcceptedVisionItem): boolean {
  return checkDecides(source);
}

/**
 * The assumptions recorded as the team's own design choices, by id and text: no check decides one,
 * so the client is told Ashara did not verify them (ADR-083). Empty when there are none.
 */
function unverifiedSection(vision: VisionCoverage): string[] {
  if (vision.kind === "unrecorded") return [];
  const design = vision.items.flatMap(({ source }) => (source.type === "assumption" && !checkDecides(source) ? [source] : []));
  if (design.length === 0) return [];
  return [
    [
      `These assumptions were recorded as how the team builds the product, not as behaviour you could observe, so no ` +
        `check decides them: they are not verified by Ashara.`,
      ...design.map((source) => `- ${source.id}: ${source.text}`),
    ].join("\n"),
  ];
}

type StatedStanding = Extract<AcceptedAssumptionStanding, "stated" | "confirmed" | "changed">;

/** What the client's answer made of a Stated assumption, as its record says, in the client's words. */
const STATED_BY_CLIENT: Readonly<Record<StatedStanding, string>> = {
  stated: "your answer",
  confirmed: "you confirmed this when asked",
  changed: "your answer, which changed what we had assumed",
};

/** How the client saw an Inferred assumption at acceptance, as the records say, in the client's words. */
const SEEN_BY_CLIENT: Readonly<Record<Exclude<AcceptedAssumptionStanding, StatedStanding>, string>> = {
  asked: "which you were asked about and have not answered",
  answered: "which you were asked about; your reply neither confirmed nor changed it",
  "answer-unread": "which you were asked about; your reply had not been read when the project was accepted",
  reported: "which was reported to you",
  unrecorded: "which Ashara has no record of showing you",
};

function isStated(standing: AcceptedAssumptionStanding): standing is StatedStanding {
  return standing === "stated" || standing === "confirmed" || standing === "changed";
}

function coverageLine(source: AcceptedVisionItem): string {
  if (source.type === "scope") {
    return source.side === "unclassified"
      ? `- ${source.text} (recorded without saying whether it is in or out of scope)`
      : `- ${source.text}`;
  }
  const unclassified = source.kind === "unclassified" ? " (not recorded as what you see or as how it is built)" : "";
  if (isStated(source.standing)) return `- ${source.text} (${STATED_BY_CLIENT[source.standing]})${unclassified}`;
  return `- Ashara's assumption, ${SEEN_BY_CLIENT[source.standing]}: ${source.text}${unclassified}`;
}

function coverageSection(vision: VisionCoverage): string {
  if (vision.kind === "unrecorded") {
    return "Which parts of what you asked for the checks cover is not on record for this plan, so none of it is stated as checked.";
  }
  const asked = vision.items.filter((item) => askedFor(item.source));
  if (asked.length === 0) return "The plan's record holds no item of what you asked for, so none of it is stated as checked.";
  const uncovered = asked.filter((item) => !item.checked);
  if (uncovered.length === 0) {
    return "Every item of what you asked for is decided by a stored check of a task whose stored checks passed on main.";
  }
  return [
    `These items of what you asked for are decided by no stored check of a task whose stored checks passed on ` +
      `main, so nothing confirms them either way:`,
    ...uncovered.map((item) => coverageLine(item.source)),
  ].join("\n");
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
    interfaceSection(file, due.mainCommit, productInterface),
    ...uncheckedSection(due.unchecked),
    ...givenUpSection(due.givenUp),
    coverageSection(due.vision),
    ...unverifiedSection(due.vision),
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
    return this.post(due, deliveredReport(due, this.productInterface.file, read));
  }

  /**
   * A report whose records cannot be read: retried; past its bound of records that do not read as a
   * report, the client is told it was accepted. A read the database's connection failed is only retried.
   */
  private async unread(due: UnreadDeliveredReport): Promise<DeliveredReportOutcome> {
    if (due.cause === "connection") return this.failed(due, due.error, "connection");
    const attempts = due.recordFailures + 1;
    if (attempts < MAX_UNREAD_ATTEMPTS) return this.failed(due, due.error, "record");
    await this.recordFailure(due.sweepId, { error: describeErrorChain(due.error), interfaceRead: false, recordUnread: true, retryAfterSeconds: null });
    console.warn(
      `[liaison-delivered-report] project ${due.projectId} (acceptance sweep ${due.sweepId}): its records did not read as a report in ` +
        `${attempts} attempts; the client is sent an acceptance notice without the report: ${describeErrorChain(due.error)}`,
    );
    return this.post(due, unreadNotice(due, attempts));
  }

  private async post(due: DueDeliveredReport | UnreadDeliveredReport, body: string): Promise<DeliveredReportOutcome> {
    try {
      const kind = await this.store.postReport(due.sweepId, body);
      return { kind, projectId: due.projectId };
    } catch (err) {
      return this.failed(due, err, "post");
    }
  }

  /** A failed attempt, counted and backed off; `what` failed says which bound, if any, it counts against too. */
  private async failed(
    due: DueDeliveredReport | UnreadDeliveredReport,
    err: unknown,
    what: "interface" | "record" | "connection" | "post",
  ): Promise<DeliveredReportOutcome> {
    const failures = due.failures + 1;
    const failure = new DeliveredReportFailed(due.projectId, due.sweepId, failures, retryAfterSeconds(failures), err);
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
