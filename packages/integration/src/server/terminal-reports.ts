import type { Database } from "@ashara/db";
import { BlockReports, TerminalMessage, TerminalReports, terminalTableOf } from "@ashara/engagement";
import type { BlockReportStore, DueTerminal, TerminalKind, TerminalReportStore } from "@ashara/engagement";
import { UnreadSubject, parseProjectId, systemClock } from "@ashara/shared";
import { memoryStepContainment } from "@ashara/shared/testing";
import { createBlockReportStore } from "@ashara/server/block-report-store";
import { createTerminalReportStore } from "@ashara/server/terminal-report-store";
import { sweepTerminalsOf } from "./terminal-sweeps.js";

type Due = DueTerminal | UnreadSubject;
type ProductInterface = ConstructorParameters<typeof TerminalReports>[1];
type Listed = Extract<Due, { readonly kind: "delivered" }>;
/** A delivered report due, as dueDeliveredOf names it: its records and its table, or why its records did not read. */
type DueDelivered = (Listed["report"] & { readonly guarantees: Listed["table"] }) | Extract<Due, { readonly kind: "delivered-unread" }>["report"];

type TerminalEvent = Parameters<typeof TerminalMessage.of>[0];
type Risk = Extract<TerminalEvent, { readonly kind: "halted" }>["risk"];

const NO_RISK: Risk = { kind: "read", version: { guarantees: [], assumptions: [] }, standing: { tasks: [], decided: [], burnZone: null } };

/**
 * A halt's terminal message on episode `episodeId`, as a retried or restarted post sends it again, with
 * the table the records reader reads for its project.
 * @testseam the integration tests of posting a terminal message twice; production builds it from the due listing
 */
export async function haltMessage(db: Database, projectId: string, episodeId: string): Promise<TerminalMessage> {
  const project = parseProjectId(projectId, "test project");
  const halt = { episodeId, projectId: project, kind: "fault", cause: { errorClass: null, reason: null, spend: null, work: null }, visionWritten: true } as const;
  return TerminalMessage.of({ kind: "halted", projectId: project, halt, risk: NO_RISK }, await terminalTableOf(db, { kind: "no-sweep", projectId: project }));
}

/**
 * A passed sweep's terminal message (its acceptance notice), as a retried or restarted post sends it
 * again, with the table the records reader reads for its sweep.
 * @testseam the integration tests of posting a terminal message twice; production builds it from the due listing
 */
export async function deliveredMessage(db: Database, projectId: string, sweepId: string): Promise<TerminalMessage> {
  const table = await terminalTableOf(db, { kind: "sweep", sweepId });
  return TerminalMessage.of({ kind: "accepted", projectId: parseProjectId(projectId, "test project"), sweepId, attempts: 5 }, table);
}

/**
 * The project a due terminal is of, as the due listing names it.
 * @testseam the integration tests that narrow the due listing to their own projects
 */
export function dueProjectOf(due: Due): string {
  if (due instanceof UnreadSubject) return due.projectId;
  return due.kind === "listed" ? due.event.projectId : due.report.projectId;
}

/**
 * The delivered report due of `projectId` as the terminal listing names it: its records with the
 * table it carries as `guarantees`, or why they did not read; undefined when none is due.
 * @testseam the integration tests of the delivered report's listing; production lists it in the terminal step
 */
export async function dueDeliveredOf(db: Database, projectId: string): Promise<DueDelivered | undefined> {
  for (const due of await createTerminalReportStore(db, systemClock).dueTerminals(["delivered"])) {
    if (due instanceof UnreadSubject || due.kind === "listed" || due.report.projectId !== projectId) continue;
    return due.kind === "delivered" ? { ...due.report, guarantees: due.table } : due.report;
  }
  return undefined;
}

/** Where no checkout of the product is held: the delivered report says the file was not read. */
const NOT_HELD: ProductInterface = { file: "PUBLIC_INTERFACE.md", at: async () => ({ kind: "not-held", reason: "no checkout is held in this test" }) };

interface TerminalReportsOptions {
  /** Reads the product's interface file for a delivered report; none held when omitted. */
  readonly productInterface?: ProductInterface;
  /** Whether a terminal's fault escapes the step rather than being contained to it; it escapes when omitted. */
  readonly escapes?: boolean;
  /** Lists the terminals without recording the terminal sweeps owed first. */
  readonly unswept?: boolean;
  /** Only these kinds of terminal, of those a run asks for; every kind it asks for when omitted. */
  readonly kinds?: readonly TerminalKind[];
  /** The store the messages are listed from and posted through; the production one when omitted. */
  readonly store?: TerminalReportStore;
}

/**
 * The Liaison's terminal step over the projects `ours` admits, every other suite's left alone: the
 * terminal sweeps each is owed recorded first, as the core loop runs them before it (unless
 * `unswept`), and every message posted through the production store.
 * @testseam the integration tests that post terminal messages outside the core loop; production runs it in the core loop
 */
export function terminalReportsOf(db: Database, ours: (projectId: string) => boolean, options: TerminalReportsOptions = {}): TerminalReports {
  const store = options.store ?? createTerminalReportStore(db, systemClock);
  const kinds = options.kinds;
  const scoped: TerminalReportStore = {
    ...store,
    dueTerminals: async (asked) => {
      if (options.unswept !== true) await sweepTerminalsOf(db, ours);
      return (await store.dueTerminals(kinds === undefined ? asked : asked.filter((kind) => kinds.includes(kind)))).filter((due) => ours(dueProjectOf(due)));
    },
  };
  return new TerminalReports(scoped, options.productInterface ?? NOT_HELD, memoryStepContainment(() => options.escapes !== false));
}

/** What a halt's or a resumption's report step reports of one subject. */
interface HaltReportOutcome {
  readonly kind: string;
  readonly projectId: string;
}

/** The step that tells the halts' reports, and what each told. */
export interface HaltReports {
  runPending(): Promise<HaltReportOutcome[]>;
}

/**
 * The reports a halt is told by over the projects `ours` admits: each halt's terminal message (its
 * terminal sweep recorded first), then each resumption's report, as the core loop runs them.
 */
export function haltReportsOf(db: Database, ours: (projectId: string) => boolean, options: { readonly escapes?: boolean } = {}): HaltReports {
  const terminal = terminalReportsOf(db, ours, { kinds: ["halted"], ...options });
  const store = createBlockReportStore(db);
  const scoped: BlockReportStore = { ...store, dueReports: async () => (await store.dueReports()).filter((due) => ours(due.projectId)) };
  const resumptions = new BlockReports(scoped, memoryStepContainment(() => options.escapes !== false));
  return { runPending: async () => [...(await terminal.runPending(["halted"])), ...(await resumptions.runPending())] };
}
