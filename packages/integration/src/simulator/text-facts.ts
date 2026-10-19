import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { BlockedReasonCorrupt, parseStoredBlockedReason, parseStoredTaskSpec } from "@ashara/delivery";
import { checkReports } from "./client-reports.js";
import type { Database } from "./database.js";
import { PUBLIC_INTERFACE_PATH, isScaffoldInterface } from "./product.js";

/**
 * I9, text against fact: every fact a composer
 * states in what it writes for an agent or the client is the fact the store held when it composed
 * it. Judged by structure, not language: the oracle recomputes from the rows each fact a composer
 * is meant to state, and compares it with the structured part of what was written (a brief's vision
 * version and assumptions) or with the fixed sentence shapes the text carries. Which composer each
 * check judges, which I4 (client-reports.ts) judges, and which none judges and why, is data:
 * TEXT_COVERED, TEXT_EXCLUDED and CLIENT_MESSAGE_WRITERS at the end of this file, which
 * text-coverage.test.ts holds to every composer and client_messages writer the source declares.
 * The expected wording is written here, never read from a composer: an oracle that asks production
 * what to expect can never find production wrong (boundary-rules.toml [integration] `named-only`).
 */

const visionRow = z.object({ version: z.number(), inferences: z.unknown(), openQuestions: z.unknown(), guarantees: z.unknown() });
const briefRow = z.object({ title: z.string(), visionAtCreation: z.number().nullable(), brief: z.unknown(), taskSpec: z.unknown() });
const messageRow = z.object({ id: z.string(), body: z.string() });
const replyRow = z.object({ answerId: z.string(), body: z.string() });
const deliveredRow = z.object({ sweepId: z.string(), body: z.string(), mainCommit: z.string(), visionAtAcceptance: z.number().nullable() });
const firstPlanRow = z.object({ body: z.string() });
const planItemRow = z.object({ origin: z.string().nullable(), beforeReport: z.boolean(), blockedReason: z.unknown() });
const planRevisionRow = z.object({ revision: z.number(), beforeReport: z.boolean() });
const intakeReadingRow = z.object({ confirmation: z.string(), secondStrength: z.string().nullable(), secondQuestions: z.number().nullable() });

export interface TextFactRecords {
  /** Every vision version of the project, oldest first. */
  readonly visions: ReadonlyArray<z.infer<typeof visionRow>>;
  /** Every recorded brief, with the latest vision version written before its session was. */
  readonly briefs: ReadonlyArray<z.infer<typeof briefRow>>;
  readonly questions: ReadonlyArray<z.infer<typeof messageRow>>;
  /** Outbound reports posted in reply to a client answer, other than the plan revision's report (which replies to the answer that asked for it). */
  readonly answerReplies: ReadonlyArray<z.infer<typeof replyRow>>;
  /** Outbound reports posted in reply to the tender: the contract draft and the reading report. */
  readonly tenderReports: ReadonlyArray<z.infer<typeof messageRow>>;
  /** The tender's reading as intake_readings records it, or null when none is. */
  readonly intakeReading: z.infer<typeof intakeReadingRow> | null;
  /** Every posted delivered report, with the vision version current at its sweep. */
  readonly delivered: ReadonlyArray<z.infer<typeof deliveredRow>>;
  /**
   * The product's public interface file as main holds it at each delivered report's sweep commit,
   * by sweep id, read from the project's checkout; not held where no checkout is (a kept run's dump).
   */
  readonly interfaceOnMain: { readonly kind: "read"; readonly bySweep: ReadonlyMap<string, MainFile> } | { readonly kind: "not-held" };
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
  const [intakeReading] = await rows(
    intakeReadingRow,
    sql`SELECT confirmation, second_strength AS "secondStrength", second_questions AS "secondQuestions" FROM intake_readings WHERE project_id = ${projectId}`,
  );
  return {
    intakeReading: intakeReading === undefined ? null : intakeReading,
    visions: await rows(
      visionRow,
      sql`SELECT version, inferences, open_questions AS "openQuestions", guarantees FROM vision_documents WHERE project_id = ${projectId} ORDER BY version`,
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
 * kind, in the words above; a brief recorded before the note carried the record's own fields.
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

type Add = (key: string, statement: string) => void;
type Versions = ReadonlyMap<number, VisionReading>;
type TextCheck = (records: TextFactRecords, add: Add, versions: Versions) => void;

/** I9 on one project's records: every check TEXT_COVERED names, once each, in the list's order. Keys name the composer's subject (a task's title, an assumption's id), never a row id. */
export function checkTextFacts(records: TextFactRecords): TextViolation[] {
  const found: TextViolation[] = [];
  const add = (key: string, statement: string): void => {
    found.push({ key, statement });
  };
  const versions = new Map(records.visions.map((vision) => [vision.version, readVision(vision)]));
  for (const check of I9_CHECKS) check(records, add, versions);
  return found;
}

/**
 * Every brief a session recorded (implementer, check author, environment): its vision version is
 * the latest one written before the session was recorded, its assumptions are that version's, and
 * every assumption line its goal or context states (`- A<n> (assumption; <standing>; <kind>): <text>`)
 * states that version's standing, kind and text for it, since a standing written into a task's
 * description at plan time goes stale once an answer changes it; and its task section states the
 * goal, end state, scope and deliverables its work item's task_spec records, a brief of a work item
 * that records none of them being named, so no end state is invented from the title.
 */
function checkBriefs(records: TextFactRecords, add: Add, versions: Versions): void {
  for (const row of records.briefs) checkBrief(row, versions, add);
}

function checkBrief(row: z.infer<typeof briefRow>, versions: Versions, add: Add): void {
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
  // A brief written before standings and kinds were recorded states neither: only what it states is judged.
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
    // Every kind but internal design is citable: no recorded kind is not evidence no client could see it.
    const citable = recorded.kind !== "internal-design";
    if (kindWords !== KIND_WORDS[recorded.kind] || (notCitable === undefined) !== citable || text !== recorded.statement) {
      add(
        `brief-assumption:${title}:${id}`,
        // eslint-disable-next-line no-restricted-syntax -- policy default: message text only
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
  const [goal, endState, scope, deliverables] = [spec?.goal, spec?.endState, spec?.scope, spec?.deliverables];
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

/** Every Liaison question: the assumption it says work proceeds on is the one its vision records for it, Inferred and asked. */
function checkQuestions(records: TextFactRecords, add: Add, versions: Versions): void {
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

/**
 * Every reply to a client answer: what the plan assumed and what work now proceeds on, from the two
 * vision versions around the answer, and only for an answer recorded as a change.
 */
function checkAnswerReplies(records: TextFactRecords, add: Add, versions: Versions): void {
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
    // An answer recorded without a verdict changed the assumption when the two versions' statements differ.
    const verdict = assumption.answer?.verdict ?? (prior === undefined ? null : prior.statement === assumption.statement ? "confirms" : "changes");
    const problems = [
      ...(verdict === "changes" ? [] : [`tells the client their answer changed ${assumption.key}, which the vision records as ${verdict ?? "no verdict and no prior statement"}`]),
      ...(prior !== undefined && reply.body.includes(`The plan assumed: ${prior.statement}`) ? [] : [`does not state what the plan assumed as v${version - 1} records it ("${prior?.statement.slice(0, 120) ?? "no record"}")`]),
      ...(reply.body.includes(`Work now proceeds on: ${assumption.statement}`) ? [] : [`does not state work now proceeds on "${assumption.statement.slice(0, 120)}" (v${version})`]),
    ];
    if (problems.length > 0) add(`answer-reply:${assumption.key}`, `the reply to the answer on ${assumption.key} ${problems.join("; ")}`);
  }
}

/** How the contract draft opens, as the oracle words it. */
const CONTRACT_OPENING = "This is the contract we are working to";

const draftedGuarantee = z.looseObject({ id: z.string().min(1), statement: z.string().min(1), source: z.looseObject({ kind: z.string(), id: z.string().optional() }) });
const draftedAssumption = z.looseObject({ key: z.string().min(1), statement: z.string().min(1), kind: z.string(), underpins: z.array(z.string()) });

/**
 * The contract draft: exactly one, posted with a first vision that holds guarantees, and none
 * otherwise. It lists every guarantee of that vision with its basis as the oracle computes it there
 * (every assumption of a first vision is Inferred, so a guarantee sourced from one or underpinned by
 * one is at risk until each is confirmed; one quoting the tender and resting on none is what the
 * tender states), every assumption a client could observe, and every design choice on its own line.
 */
function checkContractDraft(records: TextFactRecords, add: Add): void {
  const first = records.visions[0];
  // The reading report replies to the tender too: the contract draft is told by its opening.
  const reports = records.tenderReports.filter((report) => report.body.startsWith(CONTRACT_OPENING));
  const guarantees = z.array(draftedGuarantee).safeParse(first?.guarantees);
  if (first === undefined || !guarantees.success || guarantees.data.length === 0) {
    if (reports.length > 0) add("contract-draft", "a contract draft was posted for a project whose first vision holds no guarantees");
    return;
  }
  const [report, ...more] = reports;
  if (report === undefined || more.length > 0) {
    add("contract-draft", `vision v${first.version} holds ${guarantees.data.length} guarantee(s), told in ${reports.length} contract draft(s); expected exactly one`);
    return;
  }
  const inferences = z.array(draftedAssumption).safeParse(first.inferences);
  if (!inferences.success) {
    add("contract-draft-unreadable", `vision v${first.version} assumptions cannot be read with what each underpins: ${z.prettifyError(inferences.error).slice(0, 200)}`);
    return;
  }
  const lines = report.body.split("\n");
  for (const g of guarantees.data) {
    const resting = inferences.data.filter((a) => a.underpins.includes(g.id) || (g.source.kind === "assumption" && g.source.id === a.key)).map((a) => a.key);
    const basis =
      resting.length > 0
        ? `an assumption you have not confirmed; at risk until you confirm ${resting.join(", ")}`
        : g.source.kind === "tender" ? "what your tender states" : "our reading of your tender";
    const line = `- ${g.id}: ${g.statement} (basis: ${basis})`;
    if (!lines.includes(line)) add(`contract-draft:${g.id}`, `the contract draft does not list ${g.id} with its basis as v${first.version} records it ("${line.slice(0, 200)}")`);
  }
  for (const a of inferences.data) {
    const listed = a.kind === "internal-design" ? lines.includes(`- ${a.key}: ${a.statement}`) : lines.some((each) => each.startsWith(`- ${a.key}: ${a.statement} (`));
    if (!listed) add(`contract-draft:${a.key}`, `the contract draft does not list assumption ${a.key} ("${a.statement.slice(0, 120)}"), ${a.kind}`);
  }
}

/** How a reading report opens, as the oracle words it: the first reading asked the client nothing. */
const READING_OPENINGS = ["We read your tender and found nothing", "Our first reading of your tender found nothing"];

/** The words that name each strength of second reading, as the oracle words them. */
const READING_STRENGTH_WORDS: Readonly<Record<string, string>> = {
  "other-family": "by another model family",
  "same-family-other-model": "by another model of the same family as the first reading",
  "same-model": "by the same model as the first reading",
};

/** What a text must state of a recorded reading that asked nothing: its strength and what it found, or that it is unconfirmed. */
function readingClaims(reading: NonNullable<TextFactRecords["intakeReading"]>, delivered: boolean): string[] {
  if (reading.confirmation === "unconfirmed") return delivered ? ["no second reading could be had", "not verified by Ashara"] : ["no second reading of it could be had", "unconfirmed"];
  const strength = reading.secondStrength === null ? undefined : READING_STRENGTH_WORDS[reading.secondStrength];
  const by = strength === undefined ? [`a strength the oracle knows (recorded ${reading.secondStrength ?? "none"})`] : [strength];
  if (reading.confirmation === "confirmed") return [...by, "found nothing to ask either"];
  const asked = reading.secondQuestions;
  if (asked === null) return [...by, "a recorded count of questions"];
  if (delivered) return [...by, `found ${asked} question`];
  return [...by, asked === 1 ? "found the question we have sent you" : `found the ${asked} questions we have sent you`];
}

/**
 * The reading report and the delivered report's sentence on the tender's reading,
 * against intake_readings: a reading that asked nothing is told once, at
 * intake, with the strength of the second reading and what it found or that none answered, and so is
 * every delivered report; a reading that asked questions is told neither way; one not on record is
 * said to be so in the delivered report.
 */
function checkIntakeReading(records: TextFactRecords, add: Add): void {
  const reading = records.intakeReading;
  const told = records.tenderReports.filter((report) => READING_OPENINGS.some((opening) => report.body.startsWith(opening)));
  if (reading === null || reading.confirmation === "not-needed") {
    if (told.length > 0) add("reading-report", `a reading report was posted, but intake_readings records ${reading === null ? "no reading" : "a reading that asked questions"}`);
    for (const report of records.delivered) {
      const unrecorded = report.body.includes("How your tender was read is not on record");
      if (report.body.includes("When your tender was read") || unrecorded !== (reading === null)) {
        add("delivered-reading", `the delivered report's sentence on the tender's reading does not fit intake_readings (${reading === null ? "no row" : "not-needed"})`);
      }
    }
    return;
  }
  if (told.length !== 1) {
    add("reading-report", `intake_readings records a reading that asked nothing (${reading.confirmation}), told in ${told.length} reading report(s); expected exactly one`);
  }
  for (const report of told) {
    const missing = readingClaims(reading, false).filter((claim) => !report.body.includes(claim));
    if (missing.length > 0) add("reading-report", `the reading report does not state ${missing.map((claim) => `"${claim}"`).join(", ")} for a reading recorded ${reading.confirmation}`);
  }
  for (const report of records.delivered) {
    const sentence = report.body.split("\n\n").find((part) => part.startsWith("When your tender was read"));
    const missing = sentence === undefined ? ["When your tender was read"] : readingClaims(reading, true).filter((claim) => !sentence.includes(claim));
    if (missing.length > 0) add("delivered-reading", `the delivered report does not state ${missing.map((claim) => `"${claim}"`).join(", ")} for a reading recorded ${reading.confirmation}`);
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The first-plan report's decomposed and check task counts, of the plan that stood when it was
 * reported: tasks written by then, less those a revision written by then superseded.
 */
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
      // eslint-disable-next-line no-restricted-syntax -- policy default: a task whose reason does not parse is counted as corrupt and reported as first-plan-unreadable below
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

const ASSUMPTIONS_HEAD = "The assumptions the guarantees rest on:";

/**
 * The assumptions paragraph of the delivered report's guarantee table names every assumption of
 * the vision at acceptance not recorded as internal design, once, by its key and statement, and says
 * whether the client stated it, as that version records it: an assumption the client has not stated
 * is never told to them as theirs.
 */
function checkTableAssumptions(records: TextFactRecords, add: Add, versions: Versions): void {
  for (const report of records.delivered) {
    const vision = report.visionAtAcceptance === null ? undefined : versions.get(report.visionAtAcceptance);
    if (vision === undefined) continue;
    if (vision.kind === "unreadable") {
      add("delivered-standing-unreadable", `the delivered report's table rests on a vision at acceptance that cannot be read: ${vision.detail.slice(0, 200)}`);
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- policy default: an absent paragraph lists no assumption, so each one the vision holds is named missing below
    const listed = (report.body.split("\n\n").find((part) => part.startsWith(ASSUMPTIONS_HEAD)) ?? "").split("\n").filter((line) => line.startsWith("- "));
    const visible = vision.assumptions.filter((assumption) => assumption.kind !== "internal-design");
    for (const assumption of visible) {
      const lines = listed.filter((line) => line.startsWith(`- ${assumption.key}: `));
      const said = assumption.status === "Stated" ? "stated by you)" : "not confirmed by you)";
      const [line] = lines;
      if (lines.length !== 1 || line === undefined) {
        add(`delivered-standing:${assumption.key}`, `the delivered report names assumption ${assumption.key} ${lines.length} time(s) among the assumptions the guarantees rest on; it must once`);
      } else if (!line.startsWith(`- ${assumption.key}: ${assumption.statement} (`) || !line.endsWith(said)) {
        add(`delivered-standing:${assumption.key}`, `the delivered report says "${line.slice(0, 200)}"; at acceptance ${assumption.key} is "${assumption.statement.slice(0, 120)}", ${assumption.status}, so it must end "${said}"`);
      }
    }
    const known = new Set(visible.map((assumption) => assumption.key));
    for (const line of listed) {
      const key = /^- ([^:]+): /.exec(line)?.[1];
      if (key === undefined || !known.has(key)) add(`delivered-standing:${key ?? "unkeyed"}`, `the delivered report names "${line.slice(0, 120)}" as an assumption the guarantees rest on; the vision at acceptance holds no such client-visible assumption`);
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

/** Who judges a composer's text: a check of I9 here, or I4 (client-reports.ts) by the violation key it reports. */
type TextJudge = { readonly by: "I9"; readonly check: TextCheck } | { readonly by: "I4"; readonly check: typeof checkReports; readonly key: string };

/** A composer whose text an oracle judges. `source` is `<repo-relative path>#<name>`, a method's name `Class.method`. */
interface CoveredText {
  readonly source: string;
  readonly judges: readonly [TextJudge, ...TextJudge[]];
}

/**
 * A composer no oracle judges, and why: `not-a-composer`, named like one but composing no text an
 * agent or the client reads; `not-kept`, a model call's prompt, which no row keeps (llm_calls
 * records the call, never its prompt), so no oracle can read it back; `fixed-text`, the same text
 * whatever the records hold; `unjudged`, text Ashara composes from its records that no oracle
 * judges.
 */
interface ExcludedText {
  readonly source: string;
  readonly kind: "not-a-composer" | "not-kept" | "fixed-text" | "unjudged";
  readonly reason: string;
}

/** A writer of client_messages rows and the composers whose text it posts, each on TEXT_COVERED or TEXT_EXCLUDED. */
interface ClientMessageWriter {
  readonly source: string;
  readonly posts: readonly [string, ...string[]];
  /** It also writes rows the client sent: the client's own words, of which Ashara composes none. */
  readonly clientWords: boolean;
}

const DELIVERY = "packages/delivery/src";
const ENGAGEMENT = "packages/engagement/src";
const QUALITY = "packages/quality/src";
const WORKPLACE = "packages/workplace/src";

const i9 = (check: TextCheck): TextJudge => ({ by: "I9", check });
const i4 = (key: string): TextJudge => ({ by: "I4", check: checkReports, key });

/**
 * Every composer an oracle judges. I9's dispatcher runs each I9 check named here, once, in the
 * order of its first entry; text-coverage.test.ts fails on a composer or writer the source declares
 * that is on none of TEXT_COVERED, TEXT_EXCLUDED and CLIENT_MESSAGE_WRITERS.
 * @testseam text-coverage.test.ts holds it to the source; checkTextFacts is its production caller
 */
export const TEXT_COVERED: readonly CoveredText[] = [
  // The brief's vision version and assumptions, its assumption lines, and its task section against the work item's task_spec.
  { source: `${DELIVERY}/dispatch/dispatch-service.ts#DispatchService.buildBrief`, judges: [i9(checkBriefs)] },
  { source: `${WORKPLACE}/prompt.ts#buildTaskPrompt`, judges: [i9(checkBriefs)] },
  { source: `${WORKPLACE}/prompt.ts#assumptionsSection`, judges: [i9(checkBriefs)] },
  { source: `${ENGAGEMENT}/intake.ts#questionBody`, judges: [i9(checkQuestions)] },
  { source: `${ENGAGEMENT}/answers.ts#replanReport`, judges: [i9(checkAnswerReplies)] },
  { source: `${ENGAGEMENT}/intake.ts#contractDraftReport`, judges: [i9(checkContractDraft)] },
  // A reading that asked nothing: its confirmation's strength and what it found, against intake_readings.
  { source: `${ENGAGEMENT}/intake.ts#readingReport`, judges: [i9(checkIntakeReading)] },
  { source: `${ENGAGEMENT}/delivered-report.ts#readingSection`, judges: [i9(checkIntakeReading)] },
  { source: `${ENGAGEMENT}/plan-report.ts#firstPlanReport`, judges: [i9(checkFirstPlan)] },
  // Every terminal message's table: each guarantee in force once with the verdict its sweep's evidence
  // reads, stored beside it, the punch list, and each assumption with whether the client stated it.
  { source: `${ENGAGEMENT}/guarantee-report.ts#guaranteeSection`, judges: [i4("guarantee-table"), i9(checkTableAssumptions)] },
  { source: `${ENGAGEMENT}/delivered-report.ts#interfaceSection`, judges: [i9(checkDeliveredInterface)] },
  { source: `${ENGAGEMENT}/delivered-report.ts#deliveredReport`, judges: [i4("delivered-close")] },
  { source: `${ENGAGEMENT}/delivered-report.ts#uncheckedSection`, judges: [i4("delivered-unchecked")] },
  { source: `${ENGAGEMENT}/delivered-report.ts#givenUpSection`, judges: [i4("delivered-given-up")] },
  { source: `${ENGAGEMENT}/delivered-report.ts#unreadNotice`, judges: [i4("delivered-notice-unfounded")] },
  { source: `${ENGAGEMENT}/block-report.ts#projectBlockedReport`, judges: [i4("halt-cause")] },
  { source: `${ENGAGEMENT}/block-report.ts#haltBody`, judges: [i4("halt-cause")] },
  { source: `${ENGAGEMENT}/block-report.ts#planRepairBoundReport`, judges: [i4("halt-cause:plan_repair")] },
  // No code path writes a check_dispute or suite_review halt; I4 names any one a run writes.
  { source: `${ENGAGEMENT}/block-report.ts#disputeBoundReport`, judges: [i4("halt-kind-retired")] },
  { source: `${ENGAGEMENT}/block-report.ts#suiteReviewBoundReport`, judges: [i4("halt-kind-retired")] },
  { source: `${ENGAGEMENT}/client-stop.ts#stopReport`, judges: [i4("stop-merges")] },
  // The work ledger's early warning: its figures against its own record and the ledger, its zone, once per revision.
  { source: `${ENGAGEMENT}/burn-warning.ts#burnWarningReport`, judges: [i4("burn-warning"), i4("burn-warning-zone"), i4("burn-warning-repeated")] },
  { source: `${ENGAGEMENT}/burn-warning.ts#operatorBurnReport`, judges: [i4("burn-warning-operator")] },
];

const I9_CHECKS: readonly TextCheck[] = [...new Set(TEXT_COVERED.flatMap((entry) => entry.judges.flatMap((judge) => (judge.by === "I9" ? [judge.check] : []))))];

/** @testseam text-coverage.test.ts holds it to the source: the composers no oracle judges, each with its reason */
export const TEXT_EXCLUDED: readonly ExcludedText[] = [
  { source: `${ENGAGEMENT}/block-report.ts#blockedBody`, kind: "not-a-composer", reason: "joins the halt's own text and the guarantee table, each placed on its own" },
  { source: `${ENGAGEMENT}/repositories/block-report.ts#postProjectBlockReport`, kind: "not-a-composer", reason: "posts the body it is given, through insertReport" },
  { source: `${ENGAGEMENT}/repositories/block-report.ts#insertReport`, kind: "not-a-composer", reason: "posts the body it is given" },
  { source: `${ENGAGEMENT}/repositories/delivered-report.ts#postDeliveredReport`, kind: "not-a-composer", reason: "posts the body it is given" },
  { source: `${ENGAGEMENT}/repositories/client-stop.ts#postClientStopReport`, kind: "not-a-composer", reason: "posts the body it is given" },
  { source: `${DELIVERY}/repositories/plan-report.ts#postPlanReport`, kind: "not-a-composer", reason: "posts the body it is given" },
  { source: `${DELIVERY}/repositories/replan.ts#postPlanRevisionReport`, kind: "not-a-composer", reason: "posts the body it is given" },
  { source: `${DELIVERY}/dispatch/dispatch-records.ts#DispatchRecords.writeBrief`, kind: "not-a-composer", reason: "writes the composed brief to the conversation record as it is" },
  { source: `${WORKPLACE}/agent-brief.ts#createAgentBrief`, kind: "not-a-composer", reason: "parses a composed brief against its schema; DispatchService.buildBrief composes it" },
  { source: `${WORKPLACE}/prompt.ts#buildSystemPrompt`, kind: "not-a-composer", reason: "joins the charter's duties to the sections placed on their own" },
  { source: "packages/execution-infra/src/podman.ts#parseStatusReport", kind: "not-a-composer", reason: "parses podman's status output" },
  { source: "packages/finance/src/llm-call-ledger.ts#NO_USAGE_REPORT", kind: "not-a-composer", reason: "a cost measurement value, not text" },
  { source: "packages/model-access/src/turn.ts#cachedTurnPrompt", kind: "not-a-composer", reason: "places cache breakpoints on a prompt already composed" },
  { source: "packages/server/src/client-channel.ts#readJsonBody", kind: "not-a-composer", reason: "reads an HTTP request body" },
  { source: "packages/server/src/fail-closed.ts#fatalReport", kind: "not-a-composer", reason: "the operator's log line for a fatal error; no agent or client reads it" },

  { source: `${QUALITY}/suite-review.ts#reviewPrompt`, kind: "not-kept", reason: "the suite review's prompt" },
  { source: `${QUALITY}/suite-review.ts#suiteSection`, kind: "not-kept", reason: "part of the suite review's prompt" },
  { source: `${QUALITY}/suite-review.ts#interfaceSection`, kind: "not-kept", reason: "part of the suite review's prompt" },
  { source: `${QUALITY}/suite-review.ts#angleSection`, kind: "not-kept", reason: "part of a second opinion's suite review prompt" },
  { source: "packages/model-access/src/gateway.ts#textStructuredPrompt", kind: "not-kept", reason: "a structured request's prompt with the schema it must answer, for a provider that takes no schema" },
  { source: `${DELIVERY}/decomposition.ts#DecompositionEngine.buildDecomposePrompt`, kind: "not-kept", reason: "the planner's prompt" },
  { source: `${DELIVERY}/replan.ts#causeSection`, kind: "not-kept", reason: "part of a plan revision's planner prompt" },
  { source: `${DELIVERY}/replan.ts#abandonmentSection`, kind: "not-kept", reason: "part of a plan revision's planner and environment prompts" },
  { source: `${DELIVERY}/replan.ts#doneSection`, kind: "not-kept", reason: "part of a plan revision's planner prompt" },
  { source: `${DELIVERY}/replan.ts#environmentPrompt`, kind: "not-kept", reason: "the prompt asking whether a plan revision needs the environment changed" },
  { source: "packages/organization/src/derivation.ts#buildPrompt", kind: "not-kept", reason: "the prompt that derives the project's team" },
  { source: `${ENGAGEMENT}/intake.ts#buildIntakePrompt`, kind: "not-kept", reason: "the prompt that reads a tender" },
  { source: `${ENGAGEMENT}/intake.ts#secondReadingPrompt`, kind: "not-kept", reason: "the prompt of a second reading of a tender whose first reading asked nothing" },
  { source: `${ENGAGEMENT}/intake.ts#readingAngleSection`, kind: "not-kept", reason: "part of a second reading's prompt within the first reading's model family" },
  { source: `${ENGAGEMENT}/answers.ts#buildAnswerPrompt`, kind: "not-kept", reason: "the prompt that reads a client answer" },

  { source: `${ENGAGEMENT}/correction.ts#correctionPrompt`, kind: "not-kept", reason: "the prompt that reads a client change" },
  { source: `${ENGAGEMENT}/correction.ts#correctionReport`, kind: "unjudged", reason: "states a correction's operations, the tasks citing its keys and its cost band; no oracle compares them with the records" },

  { source: `${ENGAGEMENT}/block-report.ts#projectResumedReport`, kind: "unjudged", reason: "states how the halt ended; I4 judges only that it is its episode's one report" },
  { source: `${ENGAGEMENT}/plan-report.ts#planRevisionReport`, kind: "unjudged", reason: "states the revision's task counts and what it set aside; I4 judges only that it is its revision's one report" },
  { source: `${ENGAGEMENT}/plan-report.ts#planningStoppedReport`, kind: "unjudged", reason: "states the count of failed planning attempts" },
  { source: `${ENGAGEMENT}/stack-choice.ts#stackChoiceReport`, kind: "unjudged", reason: "quotes the environment's recorded statement" },
  { source: `${ENGAGEMENT}/delivered-report.ts#executedSection`, kind: "unjudged", reason: "quotes the stored checks the acceptance sweep records it ran on main; no oracle compares them with the sweep's record" },
  { source: `${DELIVERY}/domain/stale-checks.ts#disputeBrief`, kind: "unjudged", reason: "states the dispute a reopened check task's brief carries" },
  { source: `${DELIVERY}/domain/stale-checks.ts#reviewBrief`, kind: "unjudged", reason: "states the review problems a reopened check task's brief carries" },
  { source: `${QUALITY}/task-checks.ts#formatChecksForBrief`, kind: "unjudged", reason: "states the stored checks in a brief's context, past the task section checkBriefs judges" },
  { source: `${QUALITY}/task-checks.ts#checkFilesForBrief`, kind: "unjudged", reason: "part of formatChecksForBrief" },
  { source: `${QUALITY}/task-checks.ts#formatProjectChecksForCheckAuthor`, kind: "unjudged", reason: "states the project's stored checks in a check author's brief context" },
  { source: `${QUALITY}/task-checks.ts#formatFoundationForCheckAuthor`, kind: "unjudged", reason: "names the plan's foundation task in a check author's brief context" },
  { source: `${QUALITY}/merge.ts#formatConflictForBrief`, kind: "unjudged", reason: "states a conflict with main in a brief's context" },
  { source: `${QUALITY}/check-verdict.ts#formatCheckRunReport`, kind: "unjudged", reason: "run_checks' result as the agent reads it" },
  { source: `${QUALITY}/environment-verdict.ts#commandSection`, kind: "unjudged", reason: "an environment command's run as the model and the gate's failure record read it" },
  { source: `${QUALITY}/environment-verdict.ts#logSection`, kind: "unjudged", reason: "part of commandSection" },
  { source: `${WORKPLACE}/error-envelope.ts#renderChainForBrief`, kind: "unjudged", reason: "states a prior attempt's error chain in a brief" },
  { source: `${WORKPLACE}/prompt.ts#staticPrompt`, kind: "unjudged", reason: "states the charter's identity and the workspace's rules in the system prompt" },
  { source: `${WORKPLACE}/prompt.ts#protectedPathsSection`, kind: "unjudged", reason: "states the brief's protected paths in the system prompt" },
  { source: `${WORKPLACE}/prompt.ts#environmentSection`, kind: "unjudged", reason: "states the brief's environment version and statement in the system prompt" },
];

/** @testseam text-coverage.test.ts holds it to the source: every client_messages writer, with the composers whose text it posts */
export const CLIENT_MESSAGE_WRITERS: readonly ClientMessageWriter[] = [
  { source: `${DELIVERY}/repositories/plan-report.ts#postPlanReport`, posts: [`${ENGAGEMENT}/plan-report.ts#firstPlanReport`, `${ENGAGEMENT}/plan-report.ts#planningStoppedReport`], clientWords: false },
  { source: `${DELIVERY}/repositories/replan.ts#postPlanRevisionReport`, posts: [`${ENGAGEMENT}/plan-report.ts#planRevisionReport`], clientWords: false },
  {
    source: `${ENGAGEMENT}/repositories/block-report.ts#insertReport`,
    posts: [
      `${ENGAGEMENT}/block-report.ts#projectBlockedReport`,
      `${ENGAGEMENT}/block-report.ts#planRepairBoundReport`,
      `${ENGAGEMENT}/block-report.ts#disputeBoundReport`,
      `${ENGAGEMENT}/block-report.ts#suiteReviewBoundReport`,
      `${ENGAGEMENT}/block-report.ts#projectResumedReport`,
    ],
    clientWords: false,
  },
  { source: `${ENGAGEMENT}/repositories/client-answer.ts#writeClientAnswer`, posts: [`${ENGAGEMENT}/answers.ts#replanReport`], clientWords: false },
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#ClientMessageRepository.insert`,
    posts: [`${ENGAGEMENT}/intake.ts#readingReport`, `${ENGAGEMENT}/correction.ts#correctionReport`],
    clientWords: true,
  },
  { source: `${ENGAGEMENT}/repositories/tender-intake.ts#recordTenderIntake`, posts: [`${ENGAGEMENT}/intake.ts#contractDraftReport`], clientWords: false },
  { source: `${ENGAGEMENT}/repositories/client-message.ts#ClientMessageRepository.insertQuestions`, posts: [`${ENGAGEMENT}/intake.ts#questionBody`], clientWords: false },
  { source: `${ENGAGEMENT}/repositories/client-stop.ts#postClientStopReport`, posts: [`${ENGAGEMENT}/client-stop.ts#stopReport`], clientWords: false },
  {
    source: `${ENGAGEMENT}/repositories/delivered-report.ts#postDeliveredReport`,
    posts: [`${ENGAGEMENT}/delivered-report.ts#deliveredReport`, `${ENGAGEMENT}/delivered-report.ts#unreadNotice`],
    clientWords: false,
  },
  { source: `${ENGAGEMENT}/repositories/stack-choice.ts#recordStackChoice`, posts: [`${ENGAGEMENT}/stack-choice.ts#stackChoiceReport`], clientWords: false },
  { source: `${ENGAGEMENT}/repositories/burn-warning.ts#postBurnWarning`, posts: [`${ENGAGEMENT}/burn-warning.ts#burnWarningReport`], clientWords: false },
];
