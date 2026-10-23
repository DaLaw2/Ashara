import { z } from "zod";
import type { ReportRecords } from "./client-reports.js";

/**
 * What every I4 checker of a report kind shares: the work item it reads, how it reads a report's
 * paragraphs, and the guarantee table every terminal message carries, judged against its sweep's
 * evidence (tableProblems).
 */

/** What I4 reads of a work item beyond its records. */
export interface ReportedItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly level: string;
  readonly workKind: string | null;
  readonly origin: string | null;
  readonly mergeCommit: string | null;
  readonly mergeKind: string | null;
  /** Its blocked_reason as stored, unparsed. */
  readonly blockedReason: unknown;
}

export interface ReportViolation {
  readonly key: string;
  readonly statement: string;
}

/** How a checker reports a violation: its key, naming the report and the record, never an id, and its statement. */
export type ReportAdd = (key: string, statement: string) => void;

/** An outbound report of the project. */
export type ReportRow = ReportRecords["reports"][number];

/** Every report of the project by its id. */
export type ReportsById = ReadonlyMap<string, ReportRow>;

export function requestCount(count: number): string {
  return `${count} model request${count === 1 ? "" : "s"}`;
}

/** The paragraph of a report that opens with `head`, or null. */
export function paragraph(body: string, head: string): string | null {
  return body.split("\n\n").find((part) => part.startsWith(head)) ?? null;
}

/** The lines of a paragraph that name a task (`- "<title>"...`). */
export function namedLines(part: string | null): string[] {
  return part === null ? [] : part.split("\n").filter((line) => line.startsWith(`- "`));
}

export const sweptAssumption = z.looseObject({
  key: z.string().min(1).optional(),
  statement: z.string().min(1),
  kind: z.enum(["client-visible", "internal-design"]).optional(),
});
/** A scope line as stored: with its side, or a bare string written before sides were recorded (no side on record). */
export const sweptScopeLine = z.union([
  z.looseObject({ text: z.string().min(1), side: z.enum(["in", "out"]) }),
  z.string().min(1),
]);
/** A guarantee as stored: its key and its statement, what a plan cites it by, and what would show it broken. */
export const sweptGuarantee = z.looseObject({
  id: z.string().min(1),
  statement: z.string().min(1),
  observable: z.looseObject({ observation: z.string() }).optional(),
  refutedBy: z.array(z.string()).optional(),
  verification: z.string().optional(),
});

/**
 * One guarantee of the version in force: its id, its statement, how a finding names it, and what a check of it can
 * show.
 */
export interface GuaranteeInForce {
  readonly id: string;
  readonly text: string;
  readonly named: string;
  /** Whether it names an observation that would show it broken: only such a guarantee can be decided by a check. */
  readonly checkable: boolean;
  /** Whether it is about stored data, which no check can show surviving a fault while no fault set is run. */
  readonly storedData: boolean;
  /**
   * Whether its contract marks it not verifiable by Ashara, as the client was told when it was proposed:
   * it is reported not verified, never passed, and acceptance does not wait on it.
   */
  readonly notVerifiable: boolean;
}

export const sweptContractForm = z.enum(["scope-lines", "guarantees"]);

/**
 * The guarantees of a version as the Vision reads them: a guarantees-form version's own; a version
 * written before guarantees were holds each scope line not out of scope, keyed by its place, and each
 * assumption not recorded as internal design, under its own key, as a guarantee.
 */
export function guaranteesInForce(
  form: z.infer<typeof sweptContractForm>,
  scope: ReadonlyArray<z.infer<typeof sweptScopeLine>>,
  guarantees: ReadonlyArray<z.infer<typeof sweptGuarantee>>,
  inferences: ReadonlyArray<z.infer<typeof sweptAssumption>>,
): GuaranteeInForce[] {
  if (form === "guarantees") {
    return guarantees.map((g) => {
      const observation = g.observable?.observation;
      return {
        id: g.id,
        text: g.statement,
        named: `guarantee ${g.id} ("${g.statement.slice(0, 120)}")`,
        checkable:
          observation !== undefined &&
          observation !== "unclassified" &&
          // A guarantee whose drafter could not tell where it is seen is classified as nothing, so no check decides it.
          observation !== "undecided" &&
          /* eslint-disable-next-line no-restricted-syntax -- policy default: a guarantee that records nothing
             refuting it is not checkable, the fail-closed reading */
          (g.refutedBy ?? []).length > 0,
        storedData: observation === "stored-data",
        notVerifiable: g.verification === "not-by-ashara",
      };
    });
  }
  return [
    ...scope.flatMap((line, i) => {
      const id = `S${i + 1}`;
      const { text, side } = typeof line === "string" ? { text: line, side: "of no recorded side" } : line;
      if (side === "out") return [];
      const read = `${side === "in" ? "in scope" : side}, read as a guarantee`;
      return [
        {
          id,
          text,
          named: `scope line ${id} ("${text.slice(0, 120)}"), ${read}`,
          checkable: false,
          storedData: false,
          notVerifiable: false,
        },
      ];
    }),
    ...inferences.flatMap((record, i) => {
      const id = record.key ?? `A${i + 1}`;
      if (record.kind === "internal-design") return [];
      const named =
        `assumption ${id} ("${record.statement.slice(0, 120)}"), ` +
        `${record.kind ?? "of no recorded kind"}, read as a guarantee`;
      return [{ id, text: record.statement, named, checkable: false, storedData: false, notVerifiable: false }];
    }),
  ];
}

/**
 * A check's evidence on a guarantee as guarantee_evidence records it: how it ended, what kind of
 * evidence it is, and whether a review finding standing on its own check task lowers it.
 */
const checkEvidence = z.array(z.looseObject({ outcome: z.string(), class: z.string(), lowered: z.boolean() }));

/** A verdict as the oracle judges it: unjudged with why, else no reason. */
interface TableVerdict {
  readonly verdict: "pass" | "fail" | "unjudged";
  readonly reason: string | null;
}

const unjudged = (reason: string): TableVerdict => ({ verdict: "unjudged", reason });

/** The reason stored for a guarantee its contract marks not verifiable by Ashara; its table line says not verified. */
const NOT_VERIFIABLE = "not-verifiable-by-ashara";

/**
 * One guarantee's verdict from its evidence on the sweep, restated here by the rules the table
 * promises the client: nothing is judged off a commit, where one its contract marks not verifiable
 * by Ashara still reads so; an executed check that failed fails it; one
 * its contract marks not verifiable by Ashara is never verified; one that names nothing refuting it,
 * or is about stored data (no fault set is run), no check decides; it passes only on an executed
 * check that passed and that no review's doubt holds back, a doubt holding back only the checks of
 * the check task it was raised on.
 */
function judged(
  guarantee: GuaranteeInForce,
  evidence: { readonly checks: z.infer<typeof checkEvidence> },
  onCommit: boolean,
): TableVerdict {
  if (!onCommit) return unjudged(guarantee.notVerifiable ? NOT_VERIFIABLE : "no-sweep-on-commit");
  const executed = evidence.checks.filter(
    (check) => check.class === "witness" || check.class === "implementer-visible",
  );
  if (executed.some((check) => check.outcome === "failed")) return { verdict: "fail", reason: null };
  if (guarantee.notVerifiable) return unjudged(NOT_VERIFIABLE);
  if (!guarantee.checkable) return unjudged("not-checkable-as-written");
  if (guarantee.storedData) return unjudged("stored-data-unjudged");
  const reviews = evidence.checks.filter((check) => check.class === "review-only");
  const passed = executed.filter((check) => check.outcome === "passed");
  if (passed.length === 0) return unjudged(reviews.length > 0 ? "review-only" : "no-executed-evidence");
  if (passed.every((check) => check.lowered) || reviews.some((check) => check.outcome === "failed"))
    return unjudged("lowered-by-review");
  return { verdict: "pass", reason: null };
}

/** The guarantees in force at a vision version, or why the version cannot be read as a contract. */
function inForceAt(vision: ReportRecords["visions"][number]): GuaranteeInForce[] | string {
  const form = sweptContractForm.safeParse(vision.contractForm);
  const inferences = z.array(sweptAssumption).safeParse(vision.inferences);
  const scope = z.array(sweptScopeLine).safeParse(vision.scopeBoundaries);
  const guarantees = z.array(sweptGuarantee).safeParse(vision.guarantees);
  if (!form.success || !inferences.success || !scope.success || !guarantees.success) {
    const error = form.error ?? inferences.error ?? scope.error ?? guarantees.error;
    return (
      `vision v${vision.version} cannot be read as a contract: ` +
      `${error === undefined ? "" : z.prettifyError(error).slice(0, 200)}`
    );
  }
  return guaranteesInForce(form.data, scope.data, guarantees.data, inferences.data);
}

const TABLE_ON_COMMIT = "Each guarantee of your contract (vision v";
const TABLE_OFF_COMMIT = "No check could run on a commit of main for this report";
const PUNCH_HEAD = "The punch list";
const TABLE_UNREADABLE = "Ashara's records of this project's guarantees";

/** The ids at the head of a paragraph's `- <id>: ` lines, in order. */
function idsListed(part: string | null): string[] {
  return part === null
    ? []
    : part.split("\n").flatMap((line) => {
        const id = /^- ([A-Za-z]+\d+): /.exec(line)?.[1];
        return id === undefined ? [] : [id];
      });
}

/** What a table is judged from: its sweep, or none on record for the message, with the vision version current then. */
interface TableSource {
  readonly sweepId: string | null;
  readonly mainCommit: string | null;
  readonly visionVersion: number | null;
}

export function sweptSource(sweep: ReportRecords["tableSweeps"][number]): TableSource {
  return { sweepId: sweep.id, mainCommit: sweep.mainCommit, visionVersion: sweep.visionAtSweep };
}

export function unsweptSource(report: ReportRow): TableSource {
  return { sweepId: null, mainCommit: null, visionVersion: report.visionAtReport };
}

/**
 * Where a terminal message's guarantee table departs from its records: the verdicts stored beside it
 * name its sweep (none, for a message no sweep is on record for) and every guarantee in force once,
 * each as `judged` reads its evidence; the table lists every guarantee once, in the version's order,
 * with that verdict; and the punch list names every failure, then every unjudged guarantee, then
 * every pass stored as resting on an assumption the client has not confirmed. No vision then is no
 * contract, said so. A message may say its records do not hold together as a table only when the
 * oracle finds them so too, and then stores no verdict.
 */
export function tableProblems(
  records: Pick<ReportRecords, "evidence" | "verdicts" | "visions">,
  report: ReportRow,
  source: TableSource,
): string[] {
  const stored = records.verdicts.filter((verdict) => verdict.reportId === report.id);
  const evidence = source.sweepId === null ? [] : records.evidence.filter((each) => each.sweepId === source.sweepId);
  const at = source.sweepId === null ? "" : ` at sweep ${source.sweepId}`;
  const saysUnreadable = paragraph(report.body, `${TABLE_UNREADABLE}${at} do not hold together`) !== null;
  const broken: string[] = [];
  const versions = [...new Set(evidence.map((each) => each.visionVersion))];
  if (versions.length > 1)
    broken.push(`its evidence${at} names vision versions ${versions.join(", ")}; one table cannot be judged from it`);
  const version = versions[0] ?? source.visionVersion;
  if (version === null) {
    const noContract = `No contract is on record for this project${at}, so no guarantee is judged.`;
    return [
      ...(stored.length === 0 ? [] : [`it stores ${stored.length} verdict(s) though no vision is on record${at}`]),
      ...(report.body.includes(noContract) ? [] : [`no vision is on record${at}, but it does not say "${noContract}"`]),
    ];
  }
  const vision = records.visions.find((each) => each.version === version);
  if (vision === undefined) broken.push(`its table${at} is judged against vision v${version}, which is not on record`);
  const inForce = vision === undefined ? null : inForceAt(vision);
  if (typeof inForce === "string") broken.push(inForce);
  const ids = Array.isArray(inForce) ? inForce.map((g) => g.id) : [];
  const recorded = evidence.map((each) => each.guaranteeId);
  const sameIds = JSON.stringify([...recorded].sort()) === JSON.stringify([...ids].sort());
  if (Array.isArray(inForce) && evidence.length > 0 && !sameIds) {
    broken.push(`its evidence${at} names [${recorded.join(", ")}]; vision v${version} holds [${ids.join(", ")}]`);
  }
  const unparsed = evidence
    .filter((each) => !checkEvidence.safeParse(each.checks).success)
    .map((each) => each.guaranteeId);
  if (unparsed.length > 0) broken.push(`the evidence of ${unparsed.join(", ")}${at} does not read as checks`);
  if (saysUnreadable) {
    return [
      ...(broken.length > 0
        ? []
        : [`it says its records do not hold together as a table, though they read as one at vision v${version}`]),
      ...(stored.length === 0
        ? []
        : [`it stores ${stored.length} verdict(s) though it says its records do not hold together`]),
    ];
  }
  if (!Array.isArray(inForce)) return broken;
  const problems: string[] = [...broken];
  const onCommit = source.mainCommit !== null;
  const expected = inForce.map((guarantee) => {
    const seen = evidence.find((each) => each.guaranteeId === guarantee.id);
    // A sweep recorded before evidence per guarantee, or no sweep, judges every guarantee on none, as
    // its table says; a sweep that records some and misses this one is named above.
    if (seen === undefined) return { guarantee, ...judged(guarantee, { checks: [] }, onCommit) };
    const checks = checkEvidence.safeParse(seen.checks);
    const read = { checks: checks.success ? checks.data : [] };
    return { guarantee, ...judged(guarantee, read, onCommit) };
  });

  for (const { guarantee, verdict, reason } of expected) {
    const rows = stored.filter((row) => row.guaranteeId === guarantee.id);
    const [row] = rows;
    if (rows.length !== 1 || row === undefined) {
      problems.push(
        `it stores ${rows.length} verdict(s) for ${guarantee.id}; every guarantee in force has exactly one`,
      );
      continue;
    }
    if (row.sweepId !== source.sweepId || row.visionVersion !== version) {
      problems.push(
        `its verdict on ${guarantee.id} names sweep ${row.sweepId ?? "none"} at vision v${row.visionVersion}; ` +
          `it was judged on sweep ${source.sweepId ?? "none"} at v${version}`,
      );
    }
    if (row.verdict !== verdict || row.reason !== reason) {
      const storedAs = `${row.verdict}${row.reason === null ? "" : ` (${row.reason})`}`;
      problems.push(
        `it stores ${guarantee.id} as ${storedAs}; its evidence reads ` +
          `${verdict}${reason === null ? "" : ` (${reason})`}`,
      );
    }
  }
  const strays = stored.filter((row) => !ids.includes(row.guaranteeId));
  if (strays.length > 0) {
    problems.push(
      `it stores verdicts for ${strays.map((row) => row.guaranteeId).join(", ")}, which vision v${version} ` +
        `does not hold`,
    );
  }

  const head =
    source.sweepId === null
      ? `${TABLE_OFF_COMMIT}: no sweep of main is on record for it, so each guarantee of your contract (vision ` +
        `v${version}) is unjudged.`
      : source.mainCommit === null
        ? `${TABLE_OFF_COMMIT}; why is in Ashara's record of that attempt, sweep ${source.sweepId}.`
        : `${TABLE_ON_COMMIT}${version}) is judged on main at commit ${source.mainCommit}, sweep ${source.sweepId}.`;
  const table = paragraph(report.body, head);
  if (table === null) return [...problems, `it carries no guarantee table opening "${head.slice(0, 120)}"`];
  const lines = table.split("\n").filter((line) => line.startsWith("- "));
  if (JSON.stringify(idsListed(table)) !== JSON.stringify(ids)) {
    problems.push(
      `its table lists [${idsListed(table).join(", ")}]; vision v${version} holds [${ids.join(", ")}], each once`,
    );
  }
  for (const { guarantee, verdict, reason } of expected) {
    const line = lines.find((each) => each.startsWith(`- ${guarantee.id}: `));
    const said = line === undefined ? null : /\| verdict: (pass|fail|unjudged|not verified)\b/.exec(line)?.[1];
    const told = reason === NOT_VERIFIABLE ? "not verified" : verdict;
    if (line !== undefined && said !== told)
      problems.push(`its table says ${guarantee.id} is ${said ?? "nothing"}; its evidence reads ${told}`);
  }
  const atRisk = new Set(
    stored.filter((row) => row.verdict === "pass" && row.basis === "assumed-unconfirmed").map((row) => row.guaranteeId),
  );
  const punched = [
    ...expected.filter((each) => each.verdict === "fail"),
    ...expected.filter((each) => each.verdict === "unjudged"),
    ...expected.filter((each) => each.verdict === "pass" && atRisk.has(each.guarantee.id)),
  ].map((each) => each.guarantee.id);
  const punch = paragraph(report.body, PUNCH_HEAD);
  if (punch === null) problems.push("it carries no punch list");
  else if (JSON.stringify(idsListed(punch)) !== JSON.stringify(punched)) {
    problems.push(
      `its punch list names [${idsListed(punch).join(", ")}]; the verdicts put [${punched.join(", ")}] on ` +
        `it, failures first`,
    );
  }
  return problems;
}

/**
 * The coverage rule, restated as the oracle reads it: a project is accepted only on a passed sweep
 * whose recorded evidence judges every guarantee of the version it was recorded against pass, each as
 * `judged` reads it, except one its contract marks not verifiable by Ashara, which lies outside
 * coverage. Only a guarantee about stored data may carry that mark while no fault set is run: one that
 * a check could decide, marked so, would excuse it from coverage. A passed sweep with no evidence,
 * evidence of more than one version, a version that does not read or holds no guarantee within
 * coverage, or a guarantee with no evidence row covers nothing, so an accepted project resting on it
 * is a finding. One finding per guarantee, keyed by its id, or per record that does not read.
 */
export function uncoveredAcceptance(
  records: Pick<ReportRecords, "sweeps" | "tableSweeps" | "evidence" | "visions">,
): ReportViolation[] {
  const passed = records.sweeps.filter((sweep) => sweep.passed);
  if (passed.length === 0)
    return [{ key: "no-passed-sweep", statement: "the project is accepted with no passed sweep on record" }];
  const found = new Map<string, string>();
  for (const sweep of passed) {
    const at = `passed sweep ${sweep.id}`;
    const swept = records.tableSweeps.find((each) => each.id === sweep.id);
    const onCommit = swept !== undefined && swept.mainCommit !== null;
    const evidence = records.evidence.filter((each) => each.sweepId === sweep.id);
    const versions = [...new Set(evidence.map((each) => each.visionVersion))];
    const [version] = versions;
    if (versions.length !== 1 || version === undefined) {
      found.set(
        "evidence-unread",
        `${at} records evidence of ${versions.length} vision version(s), so no guarantee is judged on it`,
      );
      continue;
    }
    const vision = records.visions.find((each) => each.version === version);
    const inForce = vision === undefined ? `vision v${version} is not on record` : inForceAt(vision);
    if (typeof inForce === "string") {
      found.set("vision-unread", `${at}: ${inForce}, so no guarantee is judged on it`);
      continue;
    }
    if (inForce.every((guarantee) => guarantee.notVerifiable))
      found.set("no-guarantee", `${at}: vision v${version} holds no guarantee Ashara can verify, so nothing is judged`);
    for (const guarantee of inForce) {
      if (guarantee.notVerifiable) {
        if (!guarantee.storedData)
          found.set(guarantee.id, `${guarantee.named} is marked not verifiable by Ashara though a check can decide it`);
        continue;
      }
      const seen = evidence.find((each) => each.guaranteeId === guarantee.id);
      const checks = checkEvidence.safeParse(seen?.checks);
      if (seen === undefined || !checks.success) {
        found.set(guarantee.id, `${guarantee.named} has no readable evidence on ${at}`);
        continue;
      }
      const verdict = judged(guarantee, { checks: checks.data }, onCommit);
      const why = verdict.reason === null ? "" : ` (${verdict.reason})`;
      if (verdict.verdict !== "pass")
        found.set(guarantee.id, `${guarantee.named} reads ${verdict.verdict}${why} on ${at}`);
    }
  }
  return [...found].map(([key, statement]) => ({ key, statement: `${statement}, yet the project is accepted` }));
}
