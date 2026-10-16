import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { BlockedReasonCorrupt, parseStoredBlockedReason, parseStoredTaskSpec } from "@ashara/delivery";
import type { Database } from "./database.js";
import { PUBLIC_INTERFACE_PATH, isScaffoldInterface } from "./product.js";

/**
 * I9, text against fact (ADR-081): every fact a composer
 * states in what it writes for an agent or the client is the fact the store held when it composed
 * it. Judged by structure, not language: the oracle recomputes from the rows each fact a composer
 * is meant to state, and compares it with the structured part of what was written (a brief's vision
 * version and assumptions) or with the fixed sentence shapes the text carries. Covered:
 * - every brief a session recorded (implementer, check author, environment; the suite review is one
 *   structured call whose prompt no row keeps, so it is not judged): its vision version is the
 *   latest one written before the session was recorded, its assumptions are that version's, and
 *   every assumption line its goal or context states (`- A1 (assumption; <standing>; <kind>): <text>`)
 *   states that version's standing, kind and text for it, since a standing written into a task's
 *   description at plan time goes stale once an answer changes it; and its task section states the
 *   goal, end state, scope and deliverables its work item's task_spec records, a brief of a work
 *   item that records none of them being named, so no end state is invented from the title;
 * - every Liaison question: the assumption it says work proceeds on is the one its vision records
 *   for it, Inferred and asked;
 * - the assumptions report: exactly the assumptions intake recorded as reported, each under its kind;
 * - every reply to a client answer: what the plan assumed and what work now proceeds on, from the
 *   two vision versions around the answer, and only for an answer recorded as a change;
 * - the first-plan report: its decomposed and check task counts, of the plan that stood when it was
 *   posted;
 * - the delivered report: each assumption it lists stands with the client as the vision current at
 *   acceptance and the client's replies by then say; and the public interface file it
 *   quotes is the one main holds at the sweep's commit, or it says main holds none,
 *   judged only where the project's checkout is held.
 * Halt, stop and the rest of the delivered report are I4's (client-reports.ts). The expected
 * wording is written here, never read from a composer: an oracle that asks production what to
 * expect can never find production wrong (boundary-rules.toml [integration] `named-only`).
 */

const visionRow = z.object({ version: z.number(), inferences: z.unknown(), openQuestions: z.unknown() });
const briefRow = z.object({ title: z.string(), visionAtCreation: z.number().nullable(), brief: z.unknown(), taskSpec: z.unknown() });
const messageRow = z.object({ id: z.string(), body: z.string() });
const replyRow = z.object({ answerId: z.string(), body: z.string() });
const deliveredRow = z.object({ sweepId: z.string(), body: z.string(), mainCommit: z.string(), visionAtAcceptance: z.number().nullable() });
const sweepReplyRow = z.object({ sweepId: z.string(), questionId: z.string(), readByAcceptance: z.boolean() });
const firstPlanRow = z.object({ body: z.string() });
const planItemRow = z.object({ origin: z.string().nullable(), beforeReport: z.boolean(), blockedReason: z.unknown() });
const planRevisionRow = z.object({ revision: z.number(), beforeReport: z.boolean() });
const reviewRow = z.object({ taskSpec: z.unknown() });

export interface TextFactRecords {
  /** Every vision version of the project, oldest first. */
  readonly visions: ReadonlyArray<z.infer<typeof visionRow>>;
  /** Every recorded brief, with the latest vision version written before its session was. */
  readonly briefs: ReadonlyArray<z.infer<typeof briefRow>>;
  readonly questions: ReadonlyArray<z.infer<typeof messageRow>>;
  /** Outbound reports posted in reply to a client answer, other than the plan revision's report (which replies to the answer that asked for it). */
  readonly answerReplies: ReadonlyArray<z.infer<typeof replyRow>>;
  /** Outbound reports posted in reply to the tender: the assumptions report. */
  readonly tenderReports: ReadonlyArray<z.infer<typeof messageRow>>;
  /** Every posted delivered report, with the vision version current at its sweep. */
  readonly delivered: ReadonlyArray<z.infer<typeof deliveredRow>>;
  /** Each delivered report's sweep: the client answers sent by acceptance, by question, and whether read by then. */
  readonly sweepReplies: ReadonlyArray<z.infer<typeof sweepReplyRow>>;
  /**
   * The product's public interface file as main holds it at each delivered report's sweep commit,
   * by sweep id, read from the project's checkout; not held where no checkout is (a kept run's dump).
   */
  readonly interfaceOnMain: { readonly kind: "read"; readonly bySweep: ReadonlyMap<string, MainFile> } | { readonly kind: "not-held" };
  /** The latest Completed review task's task_spec (every item of the vision), or null. */
  readonly reviewSpec: unknown;
  readonly firstPlan: {
    readonly report: z.infer<typeof firstPlanRow> | null;
    readonly items: ReadonlyArray<z.infer<typeof planItemRow>>;
    readonly revisions: ReadonlyArray<z.infer<typeof planRevisionRow>>;
  };
}

/** A file of main at one commit, as the observer's own git reads it. */
type MainFile = { readonly kind: "present"; readonly text: string } | { readonly kind: "absent" };

/** The observer could not read a file of main: the report would be judged against nothing. */
class MainFileUnreadable extends Error {
  constructor(
    readonly checkout: string,
    readonly commit: string,
    readonly path: string,
    options: { readonly cause: unknown },
  ) {
    super(`git of ${checkout} could not read ${path} at ${commit}: ${describeErrorChain(options.cause)}`, options);
    this.name = "MainFileUnreadable";
  }
}

const runGit = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** `path` at `commit` of `checkout`, read by the host's git outside every seam (the observer is never faulted). */
async function mainFileAt(checkout: string, commit: string, path: string): Promise<MainFile> {
  try {
    const { stdout: listed } = await runGit("git", ["-C", checkout, "ls-tree", "--name-only", commit, "--", path], { maxBuffer: GIT_MAX_BUFFER });
    if (listed === "") return { kind: "absent" };
    const { stdout: text } = await runGit("git", ["-C", checkout, "cat-file", "blob", `${commit}:${path}`], { maxBuffer: GIT_MAX_BUFFER });
    return { kind: "present", text };
  } catch (err) {
    throw new MainFileUnreadable(checkout, commit, path, { cause: err });
  }
}

/** `checkout` is the project's target checkout, or null where none is held: then no file of main is read. */
export async function readTextFactRecords(db: Database, projectId: string, checkout: string | null): Promise<TextFactRecords> {
  const rows = async <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>): Promise<T[]> => z.array(schema).parse((await db.execute(query)).rows);
  const records = await readStoreRecords(rows, projectId);
  if (checkout === null) return { ...records, interfaceOnMain: { kind: "not-held" } };
  const bySweep = new Map<string, MainFile>();
  for (const report of records.delivered) bySweep.set(report.sweepId, await mainFileAt(checkout, report.mainCommit, PUBLIC_INTERFACE_PATH));
  return { ...records, interfaceOnMain: { kind: "read", bySweep } };
}

type Rows = <T>(schema: z.ZodType<T>, query: ReturnType<typeof sql>) => Promise<T[]>;

async function readStoreRecords(rows: Rows, projectId: string): Promise<Omit<TextFactRecords, "interfaceOnMain">> {
  const [firstPlan] = await rows(
    firstPlanRow,
    sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND reports_on = 'first-plan'`,
  );
  // Times are compared in the database: its microseconds, not a Date's milliseconds, order the rows.
  const reportAt = sql`(SELECT created_at FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND reports_on = 'first-plan')`;
  return {
    visions: await rows(
      visionRow,
      sql`SELECT version, inferences, open_questions AS "openQuestions" FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`,
    ),
    briefs: await rows(
      briefRow,
      sql`SELECT w.title, s.brief, w.task_spec AS "taskSpec",
                 (SELECT max(v.version) FROM vision_documents v WHERE v.project_id = w.project_id AND v.created_at <= s.created_at) AS "visionAtCreation"
          FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
          WHERE w.project_id = ${projectId} AND s.brief IS NOT NULL
          ORDER BY s.created_at, s.id`,
    ),
    questions: await rows(
      messageRow,
      sql`SELECT id, body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'question' ORDER BY created_at, position`,
    ),
    answerReplies: await rows(
      replyRow,
      sql`SELECT a.id AS "answerId", r.body FROM client_messages r JOIN client_messages a ON a.id = r.in_reply_to
          WHERE r.project_id = ${projectId} AND r.direction = 'outbound' AND a.direction = 'inbound' AND a.kind = 'answer'
            AND NOT EXISTS (SELECT 1 FROM plan_revisions p WHERE p.report_id = r.id)
          ORDER BY r.created_at, r.id`,
    ),
    tenderReports: await rows(
      messageRow,
      sql`SELECT r.id, r.body FROM client_messages r JOIN client_messages t ON t.id = r.in_reply_to
          WHERE r.project_id = ${projectId} AND r.direction = 'outbound' AND r.kind = 'report' AND t.direction = 'inbound' AND t.kind = 'tender'
          ORDER BY r.created_at, r.id`,
    ),
    delivered: await rows(
      deliveredRow,
      sql`SELECT s.id AS "sweepId", m.body, s.main_commit AS "mainCommit",
                 (SELECT max(v.version) FROM vision_documents v WHERE v.project_id = s.project_id AND v.created_at <= s.created_at) AS "visionAtAcceptance"
          FROM acceptance_sweeps s JOIN client_messages m ON m.id = s.report_id
          WHERE s.project_id = ${projectId} AND s.passed ORDER BY s.created_at, s.id`,
    ),
    sweepReplies: await rows(
      sweepReplyRow,
      sql`SELECT s.id AS "sweepId", a.in_reply_to AS "questionId",
                 (a.consumed_at IS NOT NULL AND a.consumed_at <= s.created_at) AS "readByAcceptance"
          FROM acceptance_sweeps s JOIN client_messages a ON a.project_id = s.project_id
          WHERE s.project_id = ${projectId} AND s.passed AND s.report_id IS NOT NULL
            AND a.direction = 'inbound' AND a.kind = 'answer' AND a.in_reply_to IS NOT NULL AND a.created_at <= s.created_at
          ORDER BY a.created_at, a.id`,
    ),
    reviewSpec:
      (
        await rows(
          reviewRow,
          sql`SELECT task_spec AS "taskSpec" FROM work_items
              WHERE project_id = ${projectId} AND status = 'Completed' AND task_spec->>'origin' = 'review'
              ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
      )[0]?.taskSpec ?? null,
    firstPlan: {
      report: firstPlan ?? null,
      items:
        firstPlan === undefined
          ? []
          : await rows(
              planItemRow,
              sql`SELECT task_spec->>'origin' AS origin, created_at <= ${reportAt} AS "beforeReport", blocked_reason AS "blockedReason"
                  FROM work_items WHERE project_id = ${projectId} AND level = 'Task' ORDER BY created_at, id`,
            ),
      revisions:
        firstPlan === undefined
          ? []
          : await rows(planRevisionRow, sql`SELECT revision, created_at <= ${reportAt} AS "beforeReport" FROM plan_revisions WHERE project_id = ${projectId}`),
    },
  };
}

/** One assumption of a vision version as I9 reads it, every field the composers state about it recomputed here. */
interface Assumption {
  readonly key: string;
  readonly statement: string;
  readonly status: string;
  readonly standing: "stated" | "asked" | "reported" | "unrecorded";
  readonly kind: "client-visible" | "internal-design" | "unclassified";
  /** The answer recorded as making it Stated, with what that answer did, when the record holds one. */
  readonly answer: { readonly messageId: string; readonly verdict: string | null } | null;
}

const storedAssumption = z.looseObject({
  key: z.string().min(1).optional(),
  statement: z.string().min(1),
  status: z.string().min(1),
  kind: z.enum(["client-visible", "internal-design"]).optional(),
  disclosed: z.enum(["asked", "reported"]).optional(),
  clientAnswer: z.looseObject({ messageId: z.string().min(1), verdict: z.string().optional() }).optional(),
});
const openQuestion = z.looseObject({ messageId: z.string().min(1), text: z.string(), assumptionKey: z.string().min(1) });

/** A vision version's assumptions, keyed (a record without a key by its place), or why they cannot be read. */
type VisionReading =
  | { readonly kind: "read"; readonly assumptions: readonly Assumption[]; readonly questions: ReadonlyArray<z.infer<typeof openQuestion>> }
  | { readonly kind: "unreadable"; readonly detail: string };

function readVision(vision: z.infer<typeof visionRow>): VisionReading {
  const inferences = z.array(storedAssumption).safeParse(vision.inferences);
  if (!inferences.success) return { kind: "unreadable", detail: `vision v${vision.version} assumptions: ${z.prettifyError(inferences.error)}` };
  const questions = z.array(openQuestion).safeParse(vision.openQuestions);
  if (!questions.success) return { kind: "unreadable", detail: `vision v${vision.version} open questions: ${z.prettifyError(questions.error)}` };
  return {
    kind: "read",
    questions: questions.data,
    assumptions: inferences.data.map((record, i) => ({
      key: record.key ?? `A${i + 1}`,
      statement: record.statement,
      status: record.status,
      standing: record.status === "Stated" ? "stated" : (record.disclosed ?? "unrecorded"),
      kind: record.kind ?? "unclassified",
      answer: record.clientAnswer === undefined ? null : { messageId: record.clientAnswer.messageId, verdict: record.clientAnswer.verdict ?? null },
    })),
  };
}

/** How a brief must word each standing and kind (the wording of Ashara's own prompts), stated here. */
const STANDING_WORDS: Readonly<Record<Assumption["standing"], string>> = {
  stated: "Stated by the client",
  asked: "Inferred; asked of the client, not yet answered",
  reported: "Inferred; reported to the client",
  unrecorded: "Inferred; whether the client was shown it is not on record",
};
const KIND_WORDS: Readonly<Record<Assumption["kind"], string>> = {
  "client-visible": "client-visible behaviour",
  "internal-design": "internal design",
  unclassified: "not classified",
};
const STANDINGS: ReadonlyArray<Assumption["standing"]> = ["stated", "asked", "reported", "unrecorded"];

function standingOfWords(words: string): Assumption["standing"] | null {
  return STANDINGS.find((standing) => STANDING_WORDS[standing] === words) ?? null;
}

/** An assumption line of a brief's text: `- <id> (assumption; <standing>; <kind>[, not citable]): <text>`. */
const ASSUMPTION_LINE = /^- (\S+) \(assumption; (.+); (client-visible behaviour|internal design|not classified)(, not citable)?\): (.*)$/;

/**
 * A brief's structured assumption: the key, the statement and a note of the record's standing and
 * kind, in the words above (O9); a brief recorded before the note carried the record's own fields.
 */
const briefAssumption = z.union([
  z.strictObject({ key: z.string(), statement: z.string(), note: z.string() }).transform((a) => ({ form: "noted" as const, ...a })),
  z
    .looseObject({ key: z.string(), status: z.string(), statement: z.string(), standing: z.string().optional(), kind: z.string().optional() })
    .transform((a) => ({ form: "fields" as const, key: a.key, status: a.status, statement: a.statement, standing: a.standing, kind: a.kind })),
]);

const storedBrief = z.looseObject({
  goal: z.string(),
  context: z.string(),
  visionVersion: z.number().int(),
  assumptions: z.array(briefAssumption),
});

interface TextViolation {
  readonly key: string;
  readonly statement: string;
}

/** I9 on one project's records. Keys name the composer's subject (a task's title, an assumption's id), never a row id. */
export function checkTextFacts(records: TextFactRecords): TextViolation[] {
  const found: TextViolation[] = [];
  const add = (key: string, statement: string): void => {
    found.push({ key, statement });
  };
  const versions = new Map(records.visions.map((vision) => [vision.version, readVision(vision)]));

  for (const row of records.briefs) checkBrief(row, versions, add);
  checkQuestions(records, versions, add);
  checkAnswerReplies(records, versions, add);
  checkAssumptionsReport(records, versions, add);
  checkFirstPlan(records, add);
  checkDeliveredStandings(records, versions, add);
  checkDeliveredInterface(records, add);
  return found;
}

type Add = (key: string, statement: string) => void;

function checkBrief(row: z.infer<typeof briefRow>, versions: ReadonlyMap<number, VisionReading>, add: Add): void {
  const { title } = row;
  const parsed = storedBrief.safeParse(row.brief);
  if (!parsed.success) {
    add(`brief-unreadable:${title}`, `the brief of "${title}" does not read as a brief: ${z.prettifyError(parsed.error).slice(0, 200)}`);
    return;
  }
  const brief = parsed.data;
  checkBriefTask(title, brief.context, row.taskSpec, add);
  if (row.visionAtCreation !== brief.visionVersion) {
    add(`brief-vision:${title}`, `the brief of "${title}" carries vision v${brief.visionVersion}; v${row.visionAtCreation ?? "none"} was the latest written before its session`);
  }
  const vision = versions.get(brief.visionVersion);
  if (vision === undefined || vision.kind === "unreadable") {
    add(`brief-vision-unreadable:${title}`, `the brief of "${title}" carries vision v${brief.visionVersion}, which ${vision === undefined ? "is not on record" : `cannot be read: ${vision.detail.slice(0, 200)}`}`);
    return;
  }
  // A brief written before standings and kinds were recorded (d89) states neither: only what it states is judged.
  const expected = vision.assumptions.map((a, i) => {
    const said = brief.assumptions[i];
    if (said?.form === "noted") return JSON.stringify([a.key, a.statement, `${STANDING_WORDS[a.standing]}; ${KIND_WORDS[a.kind]}`]);
    return JSON.stringify([a.key, a.status, a.statement, said?.standing === undefined ? null : a.standing, said?.kind === undefined ? null : a.kind]);
  });
  const stated = brief.assumptions.map((a) =>
    a.form === "noted" ? JSON.stringify([a.key, a.statement, a.note]) : JSON.stringify([a.key, a.status, a.statement, a.standing ?? null, a.kind ?? null]),
  );
  if (JSON.stringify(expected) !== JSON.stringify(stated)) {
    add(`brief-assumptions:${title}`, `the brief of "${title}" states the assumptions ${stated.join(" ").slice(0, 200)}; vision v${brief.visionVersion} records ${expected.join(" ").slice(0, 200)}`);
  }
  const byKey = new Map(vision.assumptions.map((a) => [a.key, a]));
  const lines = new Set([...brief.goal.split("\n"), ...brief.context.split("\n")]);
  for (const line of lines) {
    const match = ASSUMPTION_LINE.exec(line);
    if (match === null) continue;
    const [, id = "", standingWords = "", kindWords = "", notCitable, text = ""] = match;
    const recorded = byKey.get(id);
    if (recorded === undefined) {
      add(`brief-assumption:${title}:${id}`, `the brief of "${title}" states assumption ${id}, which vision v${brief.visionVersion} does not hold`);
      continue;
    }
    if (standingOfWords(standingWords) !== recorded.standing) {
      add(
        `brief-standing:${title}:${id}`,
        `the brief of "${title}" says assumption ${id} is "${standingWords}"; vision v${brief.visionVersion}, the one it carries, records it "${STANDING_WORDS[recorded.standing]}"`,
      );
    }
    // Every kind but internal design is citable (ADR-083): no recorded kind is not evidence no client could see it.
    const citable = recorded.kind !== "internal-design";
    if (kindWords !== KIND_WORDS[recorded.kind] || (notCitable === undefined) !== citable || text !== recorded.statement) {
      add(
        `brief-assumption:${title}:${id}`,
        `the brief of "${title}" states assumption ${id} as "${kindWords}${notCitable ?? ""}: ${text.slice(0, 120)}"; vision v${brief.visionVersion} records "${KIND_WORDS[recorded.kind]}: ${recorded.statement.slice(0, 120)}"`,
      );
    }
  }
}

/**
 * A brief's task section, as the oracle words it: the stored goal, end state, scope and deliverables,
 * each under its heading, at the head of the brief's context. A work item whose task_spec records
 * none of one of them can have no truthful brief; a corrupt task_spec throws TaskSpecCorrupt, so the
 * run fails rather than passing unjudged.
 */
function checkBriefTask(title: string, context: string, rawSpec: unknown, add: Add): void {
  const spec = parseStoredTaskSpec(rawSpec);
  const { goal, endState, scope, deliverables } = spec ?? {};
  if (goal === undefined || endState === undefined || scope === undefined || deliverables === undefined) {
    add(`brief-spec-unrecorded:${title}`, `a brief of "${title}" was recorded, but its task_spec does not record a goal, end state, scope and deliverables for it to state`);
    return;
  }
  const expected = [
    "# Task",
    "",
    "## Goal",
    goal,
    "",
    "## End State",
    endState,
    "",
    "## Scope",
    scope,
    "",
    "## Deliverables",
    ...deliverables.map((deliverable, i) => `${i + 1}. ${deliverable}`),
  ].join("\n");
  if (!context.startsWith(expected)) {
    add(`brief-spec:${title}`, `the brief of "${title}" does not open with the task its task_spec records ("${expected.slice(0, 160)}"); it reads "${context.slice(0, 160)}"`);
  }
}

/** What the client reads before a question's assumption, as the oracle words it. */
const PROCEEDS_ON = "Until you answer, we proceed on this assumption:";

function checkQuestions(records: TextFactRecords, versions: ReadonlyMap<number, VisionReading>, add: Add): void {
  for (const [index, question] of records.questions.entries()) {
    const at = [...versions.values()].flatMap((vision) => (vision.kind === "read" ? [vision] : [])).find((vision) => vision.questions.some((q) => q.messageId === question.id));
    const open = at?.questions.find((q) => q.messageId === question.id);
    if (at === undefined || open === undefined) {
      add(`question-unrecorded:${index + 1}`, `question ${index + 1} ("${question.body.slice(0, 80)}") is named by no vision version's open questions`);
      continue;
    }
    const assumption = at.assumptions.find((a) => a.key === open.assumptionKey);
    if (assumption === undefined) {
      add(`question:${open.assumptionKey}`, `question "${open.text.slice(0, 80)}" names assumption ${open.assumptionKey}, which its vision does not hold`);
      continue;
    }
    const problems = [
      ...(question.body.startsWith(open.text) ? [] : [`does not open with its recorded text "${open.text.slice(0, 80)}"`]),
      ...(question.body.includes(`${PROCEEDS_ON} ${assumption.statement}`) ? [] : [`does not say work proceeds on "${assumption.statement.slice(0, 120)}"`]),
      ...(assumption.status === "Inferred" && assumption.standing === "asked" ? [] : [`asks about ${open.assumptionKey}, which the vision records as ${assumption.status}, ${assumption.standing}`]),
    ];
    if (problems.length > 0) add(`question:${open.assumptionKey}`, `the question on ${open.assumptionKey} ${problems.join("; ")}`);
  }
}

function checkAnswerReplies(records: TextFactRecords, versions: ReadonlyMap<number, VisionReading>, add: Add): void {
  for (const reply of records.answerReplies) {
    const recordedBy = [...versions.entries()].flatMap(([version, vision]) =>
      vision.kind === "read" ? vision.assumptions.filter((a) => a.answer?.messageId === reply.answerId).map((a) => ({ version, assumption: a })) : [],
    )[0];
    if (recordedBy === undefined) {
      add("answer-reply-unrecorded", `a reply to a client answer was posted ("${reply.body.slice(0, 80)}...") but no vision version records that answer`);
      continue;
    }
    const { version, assumption } = recordedBy;
    const before = versions.get(version - 1);
    const prior = before?.kind === "read" ? before.assumptions.find((a) => a.key === assumption.key) : undefined;
    // An answer recorded before its verdict was (d95 a) changed the assumption when the two versions' statements differ.
    const verdict = assumption.answer?.verdict ?? (prior === undefined ? null : prior.statement === assumption.statement ? "confirms" : "changes");
    const problems = [
      ...(verdict === "changes" ? [] : [`tells the client their answer changed ${assumption.key}, which the vision records as ${verdict ?? "no verdict and no prior statement"}`]),
      ...(prior !== undefined && reply.body.includes(`The plan assumed: ${prior.statement}`) ? [] : [`does not state what the plan assumed as v${version - 1} records it ("${prior?.statement.slice(0, 120) ?? "no record"}")`]),
      ...(reply.body.includes(`Work now proceeds on: ${assumption.statement}`) ? [] : [`does not state work now proceeds on "${assumption.statement.slice(0, 120)}" (v${version})`]),
    ];
    if (problems.length > 0) add(`answer-reply:${assumption.key}`, `the reply to the answer on ${assumption.key} ${problems.join("; ")}`);
  }
}

/** How the assumptions report opens, as the oracle words it. */
const ASSUMPTIONS_OPENING = "Besides the questions we asked, the tender leaves these decisions open";

function checkAssumptionsReport(records: TextFactRecords, versions: ReadonlyMap<number, VisionReading>, add: Add): void {
  const first = records.visions[0];
  const vision = first === undefined ? undefined : versions.get(first.version);
  if (vision === undefined) {
    if (records.tenderReports.length > 0) add("assumptions-report", "an assumptions report was posted for a project with no vision on record");
    return;
  }
  if (vision.kind === "unreadable") {
    add("assumptions-report-unreadable", `the first vision cannot be read, so no assumptions report can be judged: ${vision.detail.slice(0, 200)}`);
    return;
  }
  const reported = vision.assumptions.filter((a) => a.standing === "reported");
  // A failed intake's report replies to the tender too: the assumptions report is told by its opening.
  const reports = records.tenderReports.filter((report) => report.body.startsWith(ASSUMPTIONS_OPENING));
  if (reported.length === 0) {
    if (reports.length > 0) add("assumptions-report", `an assumptions report was posted, but vision v${first?.version ?? 1} records no assumption as reported`);
    return;
  }
  if (reports.length !== 1) {
    add("assumptions-report", `vision v${first?.version ?? 1} records ${reported.length} assumption(s) as reported, told in ${reports.length} report(s); expected exactly one`);
    return;
  }
  const [report] = reports;
  if (report === undefined) return;
  const parts = report.body.split("\n\n");
  const listed = report.body.split("\n").filter((line) => /^- \S+: /.test(line));
  const behaviour = parts.find((part) => part.startsWith("What the product will do:")) ?? "";
  const design = parts.find((part) => part.startsWith("How we will build it")) ?? "";
  for (const assumption of reported) {
    const under = assumption.kind === "client-visible" ? behaviour : assumption.kind === "internal-design" ? design : null;
    const line = `- ${assumption.key}: ${assumption.statement} (why: `;
    if (under === null || !under.split("\n").some((each) => each.startsWith(line))) {
      add(`assumptions-report:${assumption.key}`, `the assumptions report does not list ${assumption.key} ("${assumption.statement.slice(0, 120)}") under its kind, ${assumption.kind}`);
    }
  }
  if (listed.length !== reported.length) add("assumptions-report", `the assumptions report lists ${listed.length} assumption(s); the vision records ${reported.length} as reported`);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The plan that stood when the first plan was reported: tasks written by then, less those a revision written by then superseded. */
function checkFirstPlan(records: TextFactRecords, add: Add): void {
  const { report, items, revisions } = records.firstPlan;
  if (report === null) return;
  const revisedBefore = new Set(revisions.filter((revision) => revision.beforeReport).map((revision) => revision.revision));
  let corrupt = 0;
  const standing = items.filter((item) => {
    if (!item.beforeReport) return false;
    try {
      const reason = parseStoredBlockedReason(item.blockedReason);
      return !(reason?.source === "superseded" && revisedBefore.has(reason.planRevision));
    } catch (err) {
      if (!(err instanceof BlockedReasonCorrupt)) throw err;
      corrupt += 1;
      return false;
    }
  });
  if (corrupt > 0) {
    add("first-plan-unreadable", `${corrupt} task(s) of the first plan carry a stored reason that does not parse, so the plan the report counts is not on record`);
    return;
  }
  const decomposed = standing.filter((item) => item.origin === "decomposition").length;
  const checks = standing.filter((item) => item.origin === "check").length;
  const expected = [`split into ${plural(decomposed, "task")} for what you asked for.`, `(${plural(checks, "check task")})`];
  for (const phrase of expected) {
    if (!report.body.includes(phrase)) add("first-plan-counts", `the first-plan report does not say "${phrase}", the plan that stood when it was posted; it reads "${report.body.slice(0, 200)}"`);
  }
}

/** Where an assumption stands with the client at acceptance, as d95 a defines it, recomputed here. */
type AcceptedStanding = "stated" | "confirmed" | "changed" | "answered" | "answer-unread" | "asked" | "reported" | "unrecorded";

const ACCEPTED_STATED: Readonly<Partial<Record<AcceptedStanding, string>>> = {
  stated: "your answer",
  confirmed: "you confirmed this when asked",
  changed: "your answer, which changed what we had assumed",
};
const ACCEPTED_INFERRED: Readonly<Partial<Record<AcceptedStanding, string>>> = {
  asked: "which you were asked about and have not answered",
  answered: "which you were asked about; your reply neither confirmed nor changed it",
  "answer-unread": "which you were asked about; your reply had not been read when the project was accepted",
  reported: "which was reported to you",
  unrecorded: "which Ashara has no record of showing you",
};

function acceptedStanding(
  assumption: Assumption,
  vision: Extract<VisionReading, { readonly kind: "read" }>,
  replies: ReadonlyArray<z.infer<typeof sweepReplyRow>>,
): AcceptedStanding | { readonly unreadable: string } {
  if (assumption.status === "Stated") {
    if (assumption.answer === null) return { unreadable: `${assumption.key} is Stated with no client answer recorded` };
    if (assumption.answer.verdict === null) return "stated";
    return assumption.answer.verdict === "confirms" ? "confirmed" : "changed";
  }
  if (assumption.standing !== "asked") return assumption.standing;
  const question = vision.questions.find((open) => open.assumptionKey === assumption.key);
  if (question === undefined) return { unreadable: `${assumption.key} was asked about and is not Stated, yet no open question names it` };
  const reply = replies.find((each) => each.questionId === question.messageId);
  if (reply === undefined) return "asked";
  return reply.readByAcceptance ? "answered" : "answer-unread";
}

function acceptedLine(assumption: Assumption, standing: AcceptedStanding): string {
  const unclassified = assumption.kind === "unclassified" ? " (not recorded as what you see or as how it is built)" : "";
  const stated = ACCEPTED_STATED[standing];
  if (stated !== undefined) return `- ${assumption.statement} (${stated})${unclassified}`;
  return `- Ashara's assumption, ${ACCEPTED_INFERRED[standing] ?? standing}: ${assumption.statement}${unclassified}`;
}

const UNCOVERED_HEAD = "These items of what you asked for are named by no acceptance criterion";

function checkDeliveredStandings(records: TextFactRecords, versions: ReadonlyMap<number, VisionReading>, add: Add): void {
  if (records.delivered.length === 0) return;
  // A corrupt task_spec throws TaskSpecCorrupt: the run fails, never passes unjudged.
  const reviewed = (parseStoredTaskSpec(records.reviewSpec)?.sources ?? []).filter((source) => source.type === "assumption");
  for (const report of records.delivered) {
    const listed = (report.body.split("\n\n").find((part) => part.startsWith(UNCOVERED_HEAD)) ?? "").split("\n").filter((line) => line.startsWith("- "));
    if (reviewed.length === 0 || listed.length === 0) continue;
    const vision = report.visionAtAcceptance === null ? undefined : versions.get(report.visionAtAcceptance);
    if (vision === undefined || vision.kind === "unreadable") {
      add("delivered-standing-unreadable", `the delivered report lists items of the vision, but the vision at acceptance ${vision === undefined ? "is not on record" : `cannot be read: ${vision.detail.slice(0, 200)}`}`);
      continue;
    }
    const replies = records.sweepReplies.filter((reply) => reply.sweepId === report.sweepId);
    for (const source of reviewed) {
      const line = listed.find((each) => each.includes(source.text));
      if (line === undefined) continue;
      const assumption = vision.assumptions.find((a) => a.key === source.id);
      if (assumption === undefined) {
        add(`delivered-standing:${source.id}`, `the delivered report lists assumption ${source.id}, which the vision at acceptance (v${report.visionAtAcceptance ?? "?"}) does not hold`);
        continue;
      }
      const standing = acceptedStanding(assumption, vision, replies);
      if (typeof standing !== "string") {
        add(`delivered-standing-unreadable:${source.id}`, `the delivered report lists ${source.id}, whose standing at acceptance cannot be read: ${standing.unreadable}`);
        continue;
      }
      const expected = acceptedLine(assumption, standing);
      if (line !== expected) add(`delivered-standing:${source.id}`, `the delivered report says "${line.slice(0, 200)}"; at acceptance ${source.id} stood ${standing}: "${expected.slice(0, 200)}"`);
    }
  }
}

/** How the delivered report introduces the quoted public interface, as the oracle words it. */
function quotedLead(commit: string): string {
  return `Public interface (from ${PUBLIC_INTERFACE_PATH} on main at commit ${commit}), quoted as the file reads.`;
}

/** How the delivered report says the product has no public interface file, as the oracle words it. */
function noneLine(commit: string): string {
  return `How to run the product is not on record: its public interface file is missing. ${PUBLIC_INTERFACE_PATH} is not on main at commit ${commit}.`;
}

const CUT_SAID = "so only its start and end are quoted";
/** What the quote must say Ashara did not check: whether the file describes the product. */
const INTERFACE_UNJUDGED = "Ashara has not verified that it describes the delivered product.";
const CUT_MARKER = /(?:^|\n)\[truncated by Ashara: (\d+) characters cut here\]\n/g;
const FENCE = /^`{3,}$/;

/** The sentence that leads the quote and the fenced block's text, or null when the report holds no such block. */
function quotedBlock(body: string, lead: string): { readonly said: string; readonly quoted: string } | null {
  const at = body.indexOf(`\n\n${lead}`);
  if (at < 0) return null;
  const [said = "", fence = "", ...rest] = body.slice(at + 2).split("\n");
  if (!FENCE.test(fence)) return null;
  const close = rest.indexOf(fence);
  if (close < 0) return null;
  const inner = rest.slice(0, close);
  return { said, quoted: inner.length === 0 ? "" : `${inner.join("\n")}\n` };
}

/** `text`, and `text` less the one newline a quote may have added to end its line. */
function withAddedNewline(text: string): string[] {
  return text.endsWith("\n") ? [text, text.slice(0, -1)] : [text];
}

/**
 * Whether `quoted` is `file` as is ("whole"), or its start and end with one marker counting exactly
 * the characters between them ("cut"); null when it is neither.
 */
function quoteOf(quoted: string, file: string): "whole" | "cut" | null {
  const markers = [...quoted.matchAll(CUT_MARKER)];
  if (markers.length === 0) return quoted === file || (!file.endsWith("\n") && quoted === `${file}\n`) ? "whole" : null;
  const [marker] = markers;
  if (markers.length > 1 || marker === undefined) return null;
  const cut = Number(marker[1]);
  const head = quoted.slice(0, marker.index + (marker[0].startsWith("\n") ? 1 : 0));
  const tail = quoted.slice(marker.index + marker[0].length);
  for (const h of withAddedNewline(head)) {
    for (const t of withAddedNewline(tail)) {
      if (h.length + cut + t.length === file.length && file.startsWith(h) && file.endsWith(t)) return "cut";
    }
  }
  return null;
}

/**
 * The delivered report's how-to-run section against main: the quoted block is the public
 * interface file as main holds it at the sweep's commit, whole or its start and end around one
 * marker counting exactly what was cut, and the report says it was cut exactly when it was; with no
 * such file on main, the report says the product has none, naming the file. A delivered main whose
 * file is still a scripted scaffold's was accepted on a placeholder's description: the report then
 * quotes something false to the client however faithfully it quotes. A delivered main with no such
 * file was accepted with no description at all. Not judged where no checkout is held.
 */
function checkDeliveredInterface(records: TextFactRecords, add: Add): void {
  const onMain = records.interfaceOnMain;
  if (onMain.kind === "not-held") return;
  for (const report of records.delivered) {
    const file = onMain.bySweep.get(report.sweepId);
    const commit = report.mainCommit;
    if (file === undefined) {
      add("delivered-interface-unread", `${PUBLIC_INTERFACE_PATH} was not read at commit ${commit.slice(0, 12)} for a delivered report`);
      continue;
    }
    const block = quotedBlock(report.body, quotedLead(commit));
    if (file.kind === "absent") {
      add("delivered-absent-interface", `the project was delivered with no ${PUBLIC_INTERFACE_PATH} on main at commit ${commit.slice(0, 12)}`);
      if (block !== null || !report.body.includes(`\n\n${noneLine(commit)}`)) {
        add("delivered-interface", `main holds no ${PUBLIC_INTERFACE_PATH} at commit ${commit.slice(0, 12)}, but the delivered report does not say "${noneLine(commit)}"`);
      }
      continue;
    }
    if (isScaffoldInterface(file.text)) {
      add("delivered-placeholder-interface", `the project was delivered with ${PUBLIC_INTERFACE_PATH} at commit ${commit.slice(0, 12)} still the scaffold's placeholder`);
    }
    if (block === null) {
      add("delivered-interface", `main holds ${PUBLIC_INTERFACE_PATH} at commit ${commit.slice(0, 12)}, but the delivered report quotes no block of it after "${quotedLead(commit)}"`);
      continue;
    }
    const quote = quoteOf(block.quoted, file.text);
    if (quote === null) {
      add(
        "delivered-interface",
        `the delivered report's quoted block is not ${PUBLIC_INTERFACE_PATH} as main holds it at ${commit.slice(0, 12)}: it reads "${block.quoted.slice(0, 120)}", main "${file.text.slice(0, 120)}"`,
      );
      continue;
    }
    if ((quote === "cut") !== block.said.includes(CUT_SAID)) {
      add(
        "delivered-interface-cut",
        `the delivered report quotes ${PUBLIC_INTERFACE_PATH} ${quote}, but ${quote === "cut" ? "does not say" : "says"} it was cut: "${block.said.slice(0, 200)}"`,
      );
    }
    if (!block.said.includes(INTERFACE_UNJUDGED)) {
      add("delivered-interface-claim", `the delivered report quotes ${PUBLIC_INTERFACE_PATH} without saying "${INTERFACE_UNJUDGED}": acceptance compares its bytes with the scaffold's, never what it says`);
    }
  }
}
