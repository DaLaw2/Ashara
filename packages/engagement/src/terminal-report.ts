import { containEach, describeErrorChain, faultBackoffSeconds } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted, UnreadSubject } from "@ashara/shared";
import { blockedBody } from "./block-report.js";
import type { ProjectBlockedReport } from "./block-report.js";
import { MAX_INTERFACE_READ_FAILURES, MAX_UNREAD_ATTEMPTS, deliveredReport, unreadNotice } from "./delivered-report.js";
import type { DeliveredReportFailureRecord, DueDeliveredReport, InterfaceTold, ProductInterfaceSource, UnreadDeliveredReport } from "./delivered-report.js";
import { registerOf, registerParagraph, standingOfRegister } from "./early-warning.js";
import type { RiskRecords } from "./early-warning.js";
import { guaranteeSection } from "./guarantee-report.js";
import type { GuaranteeTable, TableVerdicts } from "./guarantee-report.js";
import { planningStoppedReport } from "./plan-report.js";
import type { TerminalKind } from "./predicates.js";
import { stopReport } from "./stop-report.js";
import type { DueStopReport } from "./stop-report.js";
import { NOTHING_VERIFIABLE } from "./vision-language/guarantee.js";

// Every terminal message the client is sent goes through here: the delivered report (or the
// acceptance notice in its place), the client's stop report, a halt's report, the report of a first
// planning that stopped, and the decline of a contract Ashara can verify no guarantee of. One due
// listing (the store's dueTerminals, repositories/terminal-report.ts) names every one owed, each keyed
// by the subject it is told once of, behind the record that tells it (terminalTold), so a restart
// neither tells one again nor drops it; one builder (guaranteeTableOf) makes the guarantee table
// each carries; and a TerminalMessage, the only thing the store posts, cannot be made without that
// table. Quality judges every verdict in the table; this module only renders it.

/** The subject a terminal message is told once of. */
export type TerminalSubject =
  | { readonly kind: "delivered"; readonly sweepId: string }
  | { readonly kind: "stopped"; readonly stopId: string }
  | { readonly kind: "halted"; readonly episodeId: string }
  | { readonly kind: "planning-stopped"; readonly projectId: ProjectId }
  | { readonly kind: "declined"; readonly projectId: ProjectId };

/**
 * What a terminal message tells, each kind with everything its words need: the closed set of
 * terminal messages. A delivered report whose records did not read is the acceptance notice
 * ("accepted"), told of the same sweep.
 */
export type TerminalEvent =
  | {
      readonly kind: "delivered";
      readonly projectId: ProjectId;
      readonly report: DueDeliveredReport;
      readonly interfaceFile: string;
      readonly productInterface: InterfaceTold;
    }
  | { readonly kind: "accepted"; readonly projectId: ProjectId; readonly sweepId: string; readonly attempts: number }
  | { readonly kind: "stopped"; readonly projectId: ProjectId; readonly stop: DueStopReport }
  | { readonly kind: "halted"; readonly projectId: ProjectId; readonly halt: ProjectBlockedReport; readonly risk: RiskRecords }
  | { readonly kind: "planning-stopped"; readonly projectId: ProjectId; readonly attempts: number; readonly risk: RiskRecords }
  | { readonly kind: "declined"; readonly projectId: ProjectId };

/** A terminal event the due listing reads whole from the records. */
type ListedEvent = Extract<TerminalEvent, { readonly kind: "stopped" | "halted" | "planning-stopped" | "declined" }>;

/** A table whose read failed for a reason a retry may not meet again (a lost connection): the message waits. */
export interface TableNotRead {
  readonly kind: "not-read";
  readonly error: unknown;
}

/**
 * A terminal message owed, as the due listing names it, with the guarantee table it carries: a
 * delivered report, its interface file still to be read; one whose records did not read, with its
 * table read on its own; or any other terminal, read whole.
 */
export type DueTerminal =
  | { readonly kind: "delivered"; readonly report: DueDeliveredReport; readonly table: GuaranteeTable }
  | { readonly kind: "delivered-unread"; readonly report: UnreadDeliveredReport; readonly table: GuaranteeTable | TableNotRead }
  | { readonly kind: "listed"; readonly event: ListedEvent; readonly table: GuaranteeTable };

/** The paragraphs of a terminal message before its guarantee table and after it. */
interface TerminalParts {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** A terminal kind no wording is written for: unreachable while the switch over TerminalEvent is exhaustive. */
class TerminalKindUnworded extends Error {
  constructor(readonly event: never) {
    super(`no terminal message is worded for ${JSON.stringify(event)}`);
    this.name = "TerminalKindUnworded";
  }
}

/** The verdicts the table persists beside its message, through Quality. */
function tableVerdicts(table: GuaranteeTable): TableVerdicts {
  if (table.kind === "unreadable") return { sweepId: table.sweepId, verdicts: [] };
  const sweepId = table.sweep === null ? null : table.sweep.id;
  if (table.kind === "no-contract") return { sweepId, verdicts: [] };
  return {
    sweepId,
    verdicts: table.lines.map((line) => ({
      visionVersion: table.vision.version,
      basis: line.guarantee.basis,
      judged: { guaranteeId: line.guarantee.id, verdict: line.verdict, evidenceClass: line.evidenceClass },
    })),
  };
}

/** The decline of a contract Ashara can verify no guarantee of; the table that follows names why for each. */
function declinedReport(): TerminalParts {
  return { before: [`Ashara declines the contract drafted from your tender as written. ${NOTHING_VERIFIABLE}`], after: [] };
}

/** The register of guarantees at risk, reissued as the last paragraph of a halt's and a stopped planning's message. */
function withRegister(projectId: ProjectId, risk: RiskRecords, parts: TerminalParts): TerminalParts {
  return { before: parts.before, after: [...parts.after, registerParagraph(projectId, registerOf(risk))] };
}

/** Each event's own words around the table, by an exhaustive switch over the terminal kinds. */
function partsOf(event: TerminalEvent, table: GuaranteeTable): TerminalParts {
  switch (event.kind) {
    case "delivered":
      return deliveredReport(event.report, event.interfaceFile, event.productInterface);
    case "accepted":
      return unreadNotice(event.sweepId, event.attempts);
    case "stopped":
      return stopReport(event.stop);
    case "halted":
      return withRegister(event.projectId, event.risk, blockedBody(event.halt, standingOfRegister(registerOf(event.risk)), table));
    case "planning-stopped":
      return withRegister(event.projectId, event.risk, { before: [planningStoppedReport(event.attempts)], after: [] });
    case "declined":
      return declinedReport();
  }
  throw new TerminalKindUnworded(event);
}

function subjectOf(event: TerminalEvent): TerminalSubject {
  switch (event.kind) {
    case "delivered":
      return { kind: "delivered", sweepId: event.report.sweepId };
    case "accepted":
      return { kind: "delivered", sweepId: event.sweepId };
    case "stopped":
      return { kind: "stopped", stopId: event.stop.stopId };
    case "halted":
      return { kind: "halted", episodeId: event.halt.episodeId };
    case "planning-stopped":
    case "declined":
      return { kind: event.kind, projectId: event.projectId };
  }
  throw new TerminalKindUnworded(event);
}

/**
 * A terminal message as it is posted: its subject, its words and the verdicts of the table it
 * carries. Its constructor is private and `of` requires a table, which only guaranteeTableOf builds,
 * so no terminal message reaches the store without the table its records judge.
 */
export class TerminalMessage {
  private constructor(
    readonly subject: TerminalSubject,
    readonly projectId: ProjectId,
    readonly body: string,
    readonly verdicts: TableVerdicts,
  ) {}

  /** The event's own words with the table between them. */
  static of(event: TerminalEvent, table: GuaranteeTable): TerminalMessage {
    const parts = partsOf(event, table);
    return new TerminalMessage(subjectOf(event), event.projectId, [...parts.before, guaranteeSection(table), ...parts.after].join("\n\n"), tableVerdicts(table));
  }
}

/** Engagement's persistence port for terminal messages. */
export interface TerminalReportStore {
  /**
   * Every terminal message owed, each with its table, read on its own: one whose records do not read
   * is its UnreadSubject (a delivered report's, its own unread entry); a delivered report waiting
   * out the backoff of a failed attempt is listed once that time has passed.
   */
  dueTerminals(): Promise<ReadonlyArray<DueTerminal | UnreadSubject>>;
  /** Posts the message with its table's verdicts and records its subject told, unless it is told. */
  postTerminal(message: TerminalMessage): Promise<"posted" | "already-posted">;
  /** Records a failure at a sweep's delivered report (DeliveredReportFailureRecord). */
  recordDeliveredFailure(sweepId: string, failure: DeliveredReportFailureRecord): Promise<void>;
}

/** A failure at a delivered report could not be recorded on its sweep: the step fails, as its listing would. */
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

/** What one terminal message did: posted, already told, or, for a delivered report, an attempt that failed and is tried again. */
export type TerminalOutcome =
  | { readonly kind: "posted" | "already-posted"; readonly projectId: ProjectId; readonly terminal: TerminalKind }
  | { readonly kind: "failed"; readonly projectId: ProjectId; readonly terminal: "delivered"; readonly failure: DeliveredReportFailed };

/** What the core loop asks of the Liaison: every terminal message owed, each told once (no LLM call). */
export interface LiaisonTerminalReports {
  runPending(): Promise<ReadonlyArray<TerminalOutcome | StepFaulted>>;
}

/** The id a subject is contained under (containEach): its kind and the id it is told once of. */
export function terminalSubjectId(subject: TerminalSubject): string {
  switch (subject.kind) {
    case "delivered":
      return `delivered:${subject.sweepId}`;
    case "stopped":
      return `stopped:${subject.stopId}`;
    case "halted":
      return `halted:${subject.episodeId}`;
    case "planning-stopped":
    case "declined":
      return `${subject.kind}:${subject.projectId}`;
  }
}

/** The subject a due terminal is contained to (containEach), as the due listing names an unread one. */
function dueTerminalSubject(due: DueTerminal): { readonly id: string; readonly projectId: ProjectId } {
  if (due.kind === "listed") return { id: terminalSubjectId(subjectOf(due.event)), projectId: due.event.projectId };
  return { id: terminalSubjectId({ kind: "delivered", sweepId: due.report.sweepId }), projectId: due.report.projectId };
}

export class TerminalReports implements LiaisonTerminalReports {
  constructor(
    private readonly store: TerminalReportStore,
    private readonly productInterface: ProductInterfaceSource,
    /** Each terminal's own fault is contained to it (containEach). */
    private readonly containment: StepContainment,
  ) {}

  /**
   * One message per terminal owed, each contained to its subject (containEach): one that cannot be
   * read or posted is that subject's, and only a failure of the listing as a whole throws through. A
   * delivered report keeps its own record of failed attempts (DeliveredReportFailureRecord): its
   * interface file, records and post are retried after a backoff, past MAX_INTERFACE_READ_FAILURES
   * reads it is posted without the quote, and past MAX_UNREAD_ATTEMPTS attempts whose records did not
   * read as a report the client is sent the acceptance notice in its place.
   */
  async runPending(): Promise<ReadonlyArray<TerminalOutcome | StepFaulted>> {
    return containEach(this.containment, "terminal-report", await this.store.dueTerminals(), dueTerminalSubject, async (due) => {
      switch (due.kind) {
        case "delivered":
          return this.delivered(due.report, due.table);
        case "delivered-unread":
          return this.unread(due.report, due.table);
        case "listed":
          return { kind: await this.store.postTerminal(TerminalMessage.of(due.event, due.table)), projectId: due.event.projectId, terminal: due.event.kind };
      }
    });
  }

  /**
   * One delivered report, its every failure its own: one no step below handled (a report that cannot
   * be rendered from what was read) is a report its records did not make, counted toward the notice
   * like any other. Only a failure to record a failure throws through.
   */
  private async delivered(due: DueDeliveredReport, table: GuaranteeTable): Promise<TerminalOutcome> {
    try {
      let read: InterfaceTold;
      try {
        read = await this.productInterface.at(due.targetProjectPath, due.mainCommit);
      } catch (err) {
        const reads = due.interfaceReadFailures + 1;
        if (reads < MAX_INTERFACE_READ_FAILURES) return await this.failed(due, err, "interface");
        await this.recordFailure(due.sweepId, { error: describeErrorChain(err), interfaceRead: true, recordUnread: false, retryAfterSeconds: null });
        console.warn(
          `[liaison-delivered-report] project ${due.projectId} (acceptance sweep ${due.sweepId}): ${this.productInterface.file} ` +
            `could not be read in ${reads} attempts; the report is posted without it: ${describeErrorChain(err)}`,
        );
        read = { kind: "unreadable", attempts: reads, sweepId: due.sweepId };
      }
      const event: TerminalEvent = { kind: "delivered", projectId: due.projectId, report: due, interfaceFile: this.productInterface.file, productInterface: read };
      return await this.post(due, TerminalMessage.of(event, table));
    } catch (err) {
      if (err instanceof DeliveredReportFailureUnrecorded) throw err;
      return this.unread({ kind: "unread", cause: "record", failures: due.failures, recordFailures: due.recordFailures, sweepId: due.sweepId, projectId: due.projectId, error: err }, table);
    }
  }

  /**
   * A delivered report whose records cannot be read: retried; past its bound of records that do not
   * read as a report, the client is told it was accepted, with the sweep's guarantee table. A read
   * the database's connection failed, of the report or of its table, is only retried.
   */
  private async unread(due: UnreadDeliveredReport, table: GuaranteeTable | TableNotRead): Promise<TerminalOutcome> {
    if (due.cause === "connection") return this.failed(due, due.error, "connection");
    const attempts = due.recordFailures + 1;
    if (attempts < MAX_UNREAD_ATTEMPTS) return this.failed(due, due.error, "record");
    if (table.kind === "not-read") return this.failed(due, table.error, "table");
    await this.recordFailure(due.sweepId, { error: describeErrorChain(due.error), interfaceRead: false, recordUnread: true, retryAfterSeconds: null });
    console.warn(
      `[liaison-delivered-report] project ${due.projectId} (acceptance sweep ${due.sweepId}): its records did not read as a report in ` +
        `${attempts} attempts; the client is sent an acceptance notice without the report: ${describeErrorChain(due.error)}`,
    );
    return this.post(due, TerminalMessage.of({ kind: "accepted", projectId: due.projectId, sweepId: due.sweepId, attempts }, table));
  }

  private async post(due: DueDeliveredReport | UnreadDeliveredReport, message: TerminalMessage): Promise<TerminalOutcome> {
    try {
      return { kind: await this.store.postTerminal(message), projectId: due.projectId, terminal: "delivered" };
    } catch (err) {
      return this.failed(due, err, "post");
    }
  }

  /** Records a failure on the sweep; a failure to record it is marked, so it is never taken for the report's own. */
  private async recordFailure(sweepId: string, failure: DeliveredReportFailureRecord): Promise<void> {
    try {
      await this.store.recordDeliveredFailure(sweepId, failure);
    } catch (err) {
      throw new DeliveredReportFailureUnrecorded(sweepId, err);
    }
  }

  /** A failed attempt, counted and backed off; `what` failed says which bound, if any, it counts against too. */
  private async failed(
    due: DueDeliveredReport | UnreadDeliveredReport,
    err: unknown,
    what: "interface" | "record" | "connection" | "table" | "post",
  ): Promise<TerminalOutcome> {
    const failures = due.failures + 1;
    const failure = new DeliveredReportFailed(due.projectId, due.sweepId, failures, faultBackoffSeconds(failures), err);
    await this.recordFailure(due.sweepId, {
      error: describeErrorChain(err),
      interfaceRead: what === "interface",
      recordUnread: what === "record",
      retryAfterSeconds: failure.retryAfterSeconds,
    });
    console.warn(`[liaison-delivered-report] ${failure.message}`);
    return { kind: "failed", projectId: due.projectId, terminal: "delivered", failure };
  }
}
