import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { BlockedReasonCorrupt, parseStoredBlockedReason, parseStoredTaskSpec } from "@ashara/delivery";
import {
  besides,
  carries,
  cites,
  citedOf,
  countsOf,
  figuresOf,
  kindsSaid,
  leadOf,
  openingOf,
  outsideFences,
  paragraphsOf,
  paragraphsSaying,
  says,
} from "./client-message-facts.js";
import type { Signature } from "./client-message-facts.js";
import { checkReports } from "./client-reports.js";
import type { Database } from "./database.js";
import { PLACEHOLDER_MARKER, PUBLIC_INTERFACE_PATH, isScaffoldInterface } from "./product.js";

/**
 * I9, text against fact: every fact a composer
 * states in what it writes for an agent or the client is the fact the store held when it composed
 * it. Judged by structure, not language: the oracle recomputes from the rows each fact a composer
 * is meant to state, and compares it with the structured part of what was written (a brief's vision
 * version and assumptions) or, in a client message, with the facts the message carries
 * (client-message-facts.ts), never with an expected whole sentence. Which composer each
 * check judges, which I4 (client-reports.ts) judges, and which none judges and why, is data:
 * TEXT_COVERED, TEXT_EXCLUDED and CLIENT_MESSAGE_WRITERS at the end of this file, which
 * text-coverage.test.ts holds to every composer and client_messages writer the source declares.
 * The expected facts, and the key terms that name a kind no id or figure carries, are written here,
 * never read from a composer: an oracle that asks production
 * what to expect can never find production wrong (boundary-rules.toml [integration] `named-only`).
 */

const visionRow = z.object({
  version: z.number(),
  inferences: z.unknown(),
  openQuestions: z.unknown(),
  guarantees: z.unknown(),
  interface: z.unknown(),
});
const briefRow = z.object({
  title: z.string(),
  visionAtCreation: z.number().nullable(),
  brief: z.unknown(),
  taskSpec: z.unknown(),
});
const messageRow = z.object({ id: z.string(), body: z.string() });
/** A question to the client: intake's reply to the tender, or a task's question, posted in reply to nothing. */
const questionRow = messageRow.extend({ intake: z.boolean() });
const replyRow = z.object({ answerId: z.string(), body: z.string() });
const deliveredRow = z.object({
  sweepId: z.string(),
  body: z.string(),
  mainCommit: z.string(),
  visionAtAcceptance: z.number().nullable(),
});
const firstPlanRow = z.object({ body: z.string() });
const planItemRow = z.object({ origin: z.string().nullable(), beforeReport: z.boolean(), blockedReason: z.unknown() });
const planRevisionRow = z.object({ revision: z.number(), beforeReport: z.boolean() });
const intakeReadingRow = z.object({
  confirmation: z.string(),
  secondStrength: z.string().nullable(),
  secondQuestions: z.number().nullable(),
});

export interface TextFactRecords {
  /** Every vision version of the project, oldest first. */
  readonly visions: ReadonlyArray<z.infer<typeof visionRow>>;
  /** Every recorded brief, with the latest vision version written before its session was. */
  readonly briefs: ReadonlyArray<z.infer<typeof briefRow>>;
  readonly questions: ReadonlyArray<z.infer<typeof questionRow>>;
  /**
   * Outbound reports posted in reply to a client answer, other than its receipt and the plan revision's report (which
   * replies to the answer that asked for it).
   */
  readonly answerReplies: ReadonlyArray<z.infer<typeof replyRow>>;
  /**
   * Outbound reports posted in reply to the tender, other than its receipt: the contract draft and the reading report.
   */
  readonly tenderReports: ReadonlyArray<z.infer<typeof messageRow>>;
  /** Every decline of a contract version Ashara can verify no guarantee of (reports_on 'declined'). */
  readonly declines: ReadonlyArray<z.infer<typeof messageRow>>;
  /** The tender's reading as intake_readings records it, or null when none is. */
  readonly intakeReading: z.infer<typeof intakeReadingRow> | null;
  /** Every posted delivered report, with the vision version current at its sweep. */
  readonly delivered: ReadonlyArray<z.infer<typeof deliveredRow>>;
  /**
   * The product's public interface file as main holds it at each delivered report's sweep commit,
   * by sweep id, read from the project's checkout; not held where no checkout is (a kept run's dump).
   */
  readonly interfaceOnMain:
    { readonly kind: "read"; readonly bySweep: ReadonlyMap<string, MainFile> } | { readonly kind: "not-held" };
  /**
   * Every file:line of main holding the scaffold placeholder's marker at each delivered report's sweep
   * commit, by sweep id, read from the project's checkout; not held where no checkout is.
   */
  readonly placeholderOnMain:
    | { readonly kind: "read"; readonly bySweep: ReadonlyMap<string, readonly string[]> }
    | { readonly kind: "not-held" };
  readonly firstPlan: {
    readonly report: z.infer<typeof firstPlanRow> | null;
    readonly items: ReadonlyArray<z.infer<typeof planItemRow>>;
    readonly revisions: ReadonlyArray<z.infer<typeof planRevisionRow>>;
  };
  /** How many work items the project has, of any level or origin. */
  readonly workItems: number;
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
    const { stdout: listed } = await runGit("git", ["-C", checkout, "ls-tree", "--name-only", commit, "--", path], {
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (listed === "") return { kind: "absent" };
    const { stdout: text } = await runGit("git", ["-C", checkout, "cat-file", "blob", `${commit}:${path}`], {
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { kind: "present", text };
  } catch (err) {
    throw new MainFileUnreadable(checkout, commit, path, { cause: err });
  }
}

/** execFile's rejection carries the exit status as a number `code`. */
function exitCodeOf(err: unknown): number | null {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "number" ? err.code : null;
}

/**
 * Every tracked file and line of `commit` holding the placeholder marker, as `file:line`, read by the host's git
 * outside every seam; git's exit 1 is no match, any other failure throws.
 */
async function markersAt(checkout: string, commit: string): Promise<readonly string[]> {
  let printed: string;
  try {
    const search = ["grep", "--text", "--line-number", "--null", "--fixed-strings", "-e", PLACEHOLDER_MARKER, commit];
    const args = ["-C", checkout, ...search];
    printed = (await runGit("git", args, { maxBuffer: GIT_MAX_BUFFER })).stdout;
  } catch (err) {
    if (exitCodeOf(err) === 1) return [];
    throw new MainFileUnreadable(checkout, commit, `every file holding ${PLACEHOLDER_MARKER}`, { cause: err });
  }
  const prefix = `${commit}:`;
  return printed
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const [file, at] = line.slice(prefix.length).split("\0");
      return `${file}:${at}`;
    });
}

/** `checkout` is the project's target checkout, or null where none is held: then no file of main is read. */
export async function readTextFactRecords(
  db: Database,
  projectId: string,
  checkout: string | null,
): Promise<TextFactRecords> {
  const rows = async <T>(schema: z.ZodType<T>, query: SQL): Promise<T[]> =>
    z.array(schema).parse((await db.execute(query)).rows);
  const records = await readStoreRecords(rows, projectId);
  if (checkout === null) {
    return { ...records, interfaceOnMain: { kind: "not-held" }, placeholderOnMain: { kind: "not-held" } };
  }
  const bySweep = new Map<string, MainFile>();
  const markersBySweep = new Map<string, readonly string[]>();
  for (const report of records.delivered) {
    bySweep.set(report.sweepId, await mainFileAt(checkout, report.mainCommit, PUBLIC_INTERFACE_PATH));
    markersBySweep.set(report.sweepId, await markersAt(checkout, report.mainCommit));
  }
  return {
    ...records,
    interfaceOnMain: { kind: "read", bySweep },
    placeholderOnMain: { kind: "read", bySweep: markersBySweep },
  };
}

type Rows = <T>(schema: z.ZodType<T>, query: SQL) => Promise<T[]>;

async function readStoreRecords(
  rows: Rows,
  projectId: string,
): Promise<Omit<TextFactRecords, "interfaceOnMain" | "placeholderOnMain">> {
  const [firstPlan] = await rows(
    firstPlanRow,
    sql`SELECT body FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound'
           AND reports_on = 'first-plan'`,
  );
  // Times are compared in the database: its microseconds, not a Date's milliseconds, order the rows.
  const reportAt = sql`(SELECT created_at FROM client_messages WHERE project_id = ${projectId}
              AND direction = 'outbound' AND reports_on = 'first-plan')`;
  const [intakeReading] = await rows(
    intakeReadingRow,
    sql`SELECT confirmation, second_strength AS "secondStrength", second_questions AS "secondQuestions"
           FROM intake_readings WHERE project_id = ${projectId}`,
  );
  return {
    intakeReading: intakeReading === undefined ? null : intakeReading,
    visions: await rows(
      visionRow,
      sql`SELECT version, inferences, open_questions AS "openQuestions", guarantees, interface FROM vision_documents
             WHERE project_id = ${projectId} ORDER BY version`,
    ),
    briefs: await rows(
      briefRow,
      sql`SELECT w.title, s.brief, w.task_spec AS "taskSpec",
                 (SELECT max(v.version) FROM vision_documents v WHERE v.project_id = w.project_id
                   AND v.created_at <= s.created_at) AS "visionAtCreation"
          FROM dev_sessions s JOIN work_items w ON w.id = s.task_id
          WHERE w.project_id = ${projectId} AND s.brief IS NOT NULL
          ORDER BY s.created_at, s.id`,
    ),
    questions: await rows(
      questionRow,
      sql`SELECT id, body, in_reply_to IS NOT NULL AS intake FROM client_messages
          WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'question'
          ORDER BY created_at, position`,
    ),
    answerReplies: await rows(
      replyRow,
      sql`SELECT a.id AS "answerId", r.body FROM client_messages r JOIN client_messages a ON a.id = r.in_reply_to
          WHERE r.project_id = ${projectId} AND r.direction = 'outbound' AND a.direction = 'inbound'
            AND a.kind = 'answer'
            AND r.receipt_of IS NULL AND NOT EXISTS (SELECT 1 FROM told_reports p WHERE p.subject_kind = 'plan-revision'
              AND p.report_id = r.id)
          ORDER BY r.created_at, r.id`,
    ),
    tenderReports: await rows(
      messageRow,
      sql`SELECT r.id, r.body FROM client_messages r JOIN client_messages t ON t.id = r.in_reply_to
          WHERE r.project_id = ${projectId} AND r.direction = 'outbound' AND r.kind = 'report'
            AND t.direction = 'inbound' AND t.kind = 'tender'
            AND r.receipt_of IS NULL
          ORDER BY r.created_at, r.id`,
    ),
    declines: await rows(
      messageRow,
      sql`SELECT id, body FROM client_messages
          WHERE project_id = ${projectId} AND direction = 'outbound' AND kind = 'report' AND reports_on = 'declined'
          ORDER BY created_at, id`,
    ),
    delivered: await rows(
      deliveredRow,
      sql`SELECT s.id AS "sweepId", m.body, s.main_commit AS "mainCommit",
                 (SELECT max(v.version) FROM vision_documents v WHERE v.project_id = s.project_id
                   AND v.created_at <= s.created_at) AS "visionAtAcceptance"
          FROM acceptance_sweeps s JOIN told_reports t ON t.subject_kind = 'delivered' AND t.subject_id = s.id
          JOIN client_messages m ON m.id = t.report_id
          WHERE s.project_id = ${projectId} AND s.passed ORDER BY s.created_at, s.id`,
    ),
    workItems: (
      await rows(
        z.object({ count: z.number() }),
        sql`SELECT count(*)::int AS count FROM work_items WHERE project_id = ${projectId}`,
      )
    ).reduce((sum, row) => sum + row.count, 0),
    firstPlan: {
      report: firstPlan ?? null,
      items:
        firstPlan === undefined
          ? []
          : await rows(
              planItemRow,
              sql`SELECT task_spec->>'origin' AS origin, created_at <= ${reportAt} AS "beforeReport",
                     blocked_reason AS "blockedReason"
                  FROM work_items WHERE project_id = ${projectId} AND level = 'Task' ORDER BY created_at, id`,
            ),
      revisions:
        firstPlan === undefined
          ? []
          : await rows(
              planRevisionRow,
              sql`SELECT revision, created_at <= ${reportAt} AS "beforeReport" FROM plan_revisions
                     WHERE project_id = ${projectId}`,
            ),
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
const openQuestion = z.looseObject({
  messageId: z.string().min(1),
  text: z.string(),
  assumptionKey: z.string().min(1),
});

/** A vision version's assumptions, keyed (a record without a key by its place), or why they cannot be read. */
type VisionReading =
  | {
      readonly kind: "read";
      readonly assumptions: readonly Assumption[];
      readonly questions: ReadonlyArray<z.infer<typeof openQuestion>>;
      /** The public interface the version states, each entry by its key. */
      readonly interfaceEntries: ReadonlyArray<{ readonly key: string; readonly text: string }>;
    }
  | { readonly kind: "unreadable"; readonly detail: string };

function readVision(vision: z.infer<typeof visionRow>): VisionReading {
  const inferences = z.array(storedAssumption).safeParse(vision.inferences);
  if (!inferences.success)
    return {
      kind: "unreadable",
      detail: `vision v${vision.version} assumptions: ${z.prettifyError(inferences.error)}`,
    };
  const questions = z.array(openQuestion).safeParse(vision.openQuestions);
  if (!questions.success)
    return {
      kind: "unreadable",
      detail: `vision v${vision.version} open questions: ${z.prettifyError(questions.error)}`,
    };
  const entries = z.array(z.looseObject({ id: z.string(), text: z.string() })).safeParse(vision.interface);
  if (!entries.success)
    return {
      kind: "unreadable",
      detail: `vision v${vision.version} interface: ${z.prettifyError(entries.error)}`,
    };
  return {
    kind: "read",
    questions: questions.data,
    interfaceEntries: entries.data.map((entry) => ({ key: entry.id, text: entry.text })),
    assumptions: inferences.data.map((record, i) => ({
      key: record.key ?? `A${i + 1}`,
      statement: record.statement,
      status: record.status,
      standing: record.status === "Stated" ? "stated" : (record.disclosed ?? "unrecorded"),
      kind: record.kind ?? "unclassified",
      answer:
        record.clientAnswer === undefined
          ? null
          : { messageId: record.clientAnswer.messageId, verdict: record.clientAnswer.verdict ?? null },
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
const ASSUMPTION_LINE =
  /^- (\S+) \(assumption; (.+); (client-visible behaviour|internal design|not classified)(, not citable)?\): (.*)$/;

/**
 * A brief's structured assumption: the key, the statement and a note of the record's standing and
 * kind, in the words above; a brief recorded before the note carried the record's own fields.
 */
const briefAssumption = z.union([
  z
    .strictObject({ key: z.string(), statement: z.string(), note: z.string() })
    .transform((a) => ({ form: "noted" as const, ...a })),
  z
    .looseObject({
      key: z.string(),
      status: z.string(),
      statement: z.string(),
      standing: z.string().optional(),
      kind: z.string().optional(),
    })
    .transform((a) => ({
      form: "fields" as const,
      key: a.key,
      status: a.status,
      statement: a.statement,
      standing: a.standing,
      kind: a.kind,
    })),
]);

const storedBrief = z.looseObject({
  goal: z.string(),
  context: z.string(),
  visionVersion: z.number().int(),
  assumptions: z.array(briefAssumption),
  interfaceEntries: z.array(z.object({ key: z.string(), text: z.string() })),
});

interface TextViolation {
  readonly key: string;
  readonly statement: string;
}

type Add = (key: string, statement: string) => void;
type Versions = ReadonlyMap<number, VisionReading>;
type TextCheck = (records: TextFactRecords, add: Add, versions: Versions) => void;

/**
 * I9 on one project's records: every check TEXT_COVERED names, once each, in the list's order. Keys name the composer's
 * subject (a task's title, an assumption's id), never a row id.
 */
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
    add(
      `brief-unreadable:${title}`,
      `the brief of "${title}" does not read as a brief: ${z.prettifyError(parsed.error).slice(0, 200)}`,
    );
    return;
  }
  const brief = parsed.data;
  checkBriefTask(title, brief.context, row.taskSpec, add);
  if (row.visionAtCreation !== brief.visionVersion) {
    add(
      `brief-vision:${title}`,
      `the brief of "${title}" carries vision v${brief.visionVersion}; v${row.visionAtCreation ?? "none"} ` +
        `was the latest written before its session`,
    );
  }
  const vision = versions.get(brief.visionVersion);
  if (vision === undefined || vision.kind === "unreadable") {
    add(
      `brief-vision-unreadable:${title}`,
      `the brief of "${title}" carries vision v${brief.visionVersion}, which ` +
        `${vision === undefined ? "is not on record" : `cannot be read: ${vision.detail.slice(0, 200)}`}`,
    );
    return;
  }
  // A brief written before standings and kinds were recorded states neither: only what it states is judged.
  const expected = vision.assumptions.map((a, i) => {
    const said = brief.assumptions[i];
    if (said?.form === "noted")
      return JSON.stringify([a.key, a.statement, `${STANDING_WORDS[a.standing]}; ${KIND_WORDS[a.kind]}`]);
    return JSON.stringify([
      a.key,
      a.status,
      a.statement,
      said?.standing === undefined ? null : a.standing,
      said?.kind === undefined ? null : a.kind,
    ]);
  });
  const stated = brief.assumptions.map((a) =>
    a.form === "noted"
      ? JSON.stringify([a.key, a.statement, a.note])
      : JSON.stringify([a.key, a.status, a.statement, a.standing ?? null, a.kind ?? null]),
  );
  if (JSON.stringify(expected) !== JSON.stringify(stated)) {
    add(
      `brief-assumptions:${title}`,
      `the brief of "${title}" states the assumptions ${stated.join(" ").slice(0, 200)}; vision ` +
        `v${brief.visionVersion} records ${expected.join(" ").slice(0, 200)}`,
    );
  }
  const interfaceStated = JSON.stringify(brief.interfaceEntries.map((entry) => [entry.key, entry.text]));
  const interfaceRecorded = JSON.stringify(vision.interfaceEntries.map((entry) => [entry.key, entry.text]));
  if (interfaceStated !== interfaceRecorded) {
    add(
      `brief-interface:${title}`,
      `the brief of "${title}" states the public interface ${interfaceStated.slice(0, 200)}; vision ` +
        `v${brief.visionVersion} records ${interfaceRecorded.slice(0, 200)}`,
    );
  }
  const byKey = new Map(vision.assumptions.map((a) => [a.key, a]));
  const lines = new Set([...brief.goal.split("\n"), ...brief.context.split("\n")]);
  for (const line of lines) {
    const match = ASSUMPTION_LINE.exec(line);
    if (match === null) continue;
    const [, id = "", standingWords = "", kindWords = "", notCitable, text = ""] = match;
    const recorded = byKey.get(id);
    if (recorded === undefined) {
      add(
        `brief-assumption:${title}:${id}`,
        `the brief of "${title}" states assumption ${id}, which vision v${brief.visionVersion} does not hold`,
      );
      continue;
    }
    if (standingOfWords(standingWords) !== recorded.standing) {
      add(
        `brief-standing:${title}:${id}`,
        `the brief of "${title}" says assumption ${id} is "${standingWords}"; vision ` +
          `v${brief.visionVersion}, the one it carries, records it "${STANDING_WORDS[recorded.standing]}"`,
      );
    }
    // Every kind but internal design is citable: no recorded kind is not evidence no client could see it.
    const citable = recorded.kind !== "internal-design";
    if (
      kindWords !== KIND_WORDS[recorded.kind] ||
      (notCitable === undefined) !== citable ||
      text !== recorded.statement
    ) {
      add(
        `brief-assumption:${title}:${id}`,
        // eslint-disable-next-line no-restricted-syntax -- policy default: message text only
        `the brief of "${title}" states assumption ${id} as "${kindWords}${notCitable ?? ""}: ` +
          `${text.slice(0, 120)}"; vision v${brief.visionVersion} records "${KIND_WORDS[recorded.kind]}: ` +
          `${recorded.statement.slice(0, 120)}"`,
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
    add(
      `brief-spec-unrecorded:${title}`,
      `a brief of "${title}" was recorded, but its task_spec does not record a goal, end state, scope and ` +
        `deliverables for it to state`,
    );
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
    add(
      `brief-spec:${title}`,
      `the brief of "${title}" does not open with the task its task_spec records ` +
        `("${expected.slice(0, 160)}"); it reads "${context.slice(0, 160)}"`,
    );
  }
}

/**
 * Every Liaison question: it carries the statement of the assumption its vision records for it, Inferred and asked,
 * and no other assumption's of that version, whatever words lead it in.
 */
function checkQuestions(records: TextFactRecords, add: Add, versions: Versions): void {
  for (const [index, question] of records.questions.entries()) {
    const at = [...versions.values()]
      .flatMap((vision) => (vision.kind === "read" ? [vision] : []))
      .find((vision) => vision.questions.some((q) => q.messageId === question.id));
    const open = at?.questions.find((q) => q.messageId === question.id);
    if (at === undefined || open === undefined) {
      add(
        `question-unrecorded:${index + 1}`,
        `question ${index + 1} ("${question.body.slice(0, 80)}") is named by no vision version's open questions`,
      );
      continue;
    }
    const assumption = at.assumptions.find((a) => a.key === open.assumptionKey);
    if (assumption === undefined) {
      add(
        `question:${open.assumptionKey}`,
        `question "${open.text.slice(0, 80)}" names assumption ${open.assumptionKey}, which its vision does not hold`,
      );
      continue;
    }
    const problems = [
      ...(carries(openingOf(question.body), open.text)
        ? []
        : [`does not open with its recorded text "${open.text.slice(0, 80)}"`]),
      ...(carries(question.body, assumption.statement)
        ? []
        : [`does not state the assumption it asks about, "${assumption.statement.slice(0, 120)}"`]),
      ...at.assumptions
        .filter(
          (other) =>
            other.key !== assumption.key &&
            !carries(assumption.statement, other.statement) &&
            !carries(other.statement, assumption.statement) &&
            carries(question.body, other.statement),
        )
        .map((other) => `states ${other.key}'s statement "${other.statement.slice(0, 80)}", not asked about`),
      ...(assumption.status === "Inferred" && assumption.standing === "asked"
        ? []
        : [
            `asks about ${open.assumptionKey}, which the vision records as ${assumption.status}, ` +
              `${assumption.standing}`,
          ]),
    ];
    if (problems.length > 0)
      add(`question:${open.assumptionKey}`, `the question on ${open.assumptionKey} ${problems.join("; ")}`);
  }
}

/**
 * Every reply to a client answer: for every assumption the answer changed, it carries what the plan
 * assumed and what work now proceeds on, the statements of the two vision versions around the answer,
 * and only for an answer that changed at least one.
 */
function checkAnswerReplies(records: TextFactRecords, add: Add, versions: Versions): void {
  for (const reply of records.answerReplies) {
    const recordedBy = [...versions.entries()].flatMap(([version, vision]) =>
      vision.kind === "read"
        ? vision.assumptions
            .filter((a) => a.answer?.messageId === reply.answerId)
            .map((a) => ({ version, assumption: a }))
        : [],
    );
    const [firstRecorded] = recordedBy;
    if (firstRecorded === undefined) {
      add(
        "answer-reply-unrecorded",
        `a reply to a client answer was posted ("${reply.body.slice(0, 80)}...") but no vision version ` +
          `records that answer`,
      );
      continue;
    }
    // The version the answer wrote: every later one carries its records over.
    const { version } = firstRecorded;
    const before = versions.get(version - 1);
    const stated = recordedBy
      .filter((recorded) => recorded.version === version)
      .map(({ assumption }) => {
        const prior = before?.kind === "read" ? before.assumptions.find((a) => a.key === assumption.key) : undefined;
        // An answer recorded without a verdict changed the assumption when the two versions' statements differ.
        const verdict =
          assumption.answer?.verdict ??
          (prior === undefined ? null : prior.statement === assumption.statement ? "confirms" : "changes");
        return { assumption, prior, verdict };
      });
    const changed = stated.filter((each) => each.verdict === "changes");
    const [shown] = stated;
    if (changed.length === 0 && shown !== undefined) {
      const { assumption, verdict } = shown;
      add(
        `answer-reply:${assumption.key}`,
        `the reply to the answer on ${assumption.key} tells the client their answer changed it, which the vision ` +
          `records as ${verdict ?? "no verdict and no prior statement"}`,
      );
      continue;
    }
    for (const { assumption, prior } of changed) {
      const problems = [
        ...(prior !== undefined && carries(reply.body, prior.statement)
          ? []
          : [
              `does not state what the plan assumed as v${version - 1} records it ` +
                `("${prior?.statement.slice(0, 120) ?? "no record"}")`,
            ]),
        ...(carries(reply.body, assumption.statement)
          ? []
          : [`does not state work now proceeds on "${assumption.statement.slice(0, 120)}" (v${version})`]),
      ];
      if (problems.length > 0)
        add(`answer-reply:${assumption.key}`, `the reply to the answer on ${assumption.key} ${problems.join("; ")}`);
    }
  }
}

/** The key terms by which a tender report opens as the contract draft, which one Ashara declines opens with too. */
const CONTRACT_OPENING = ["contract"];

/** What a guarantee of the draft rests on, as the oracle reads it there. */
type DraftBasis = "at-risk" | "tender" | "reading";
/** The key terms that tell each basis apart in a guarantee's line, written here and never read from the composer. */
const BASIS_TERMS = {
  "at-risk": { all: ["not confirmed"] },
  tender: { all: ["tender states"] },
  reading: { all: ["reading"] },
} as const satisfies Record<DraftBasis, Signature>;
const BASES: readonly DraftBasis[] = ["at-risk", "tender", "reading"];
/** The key terms by which the draft marks a guarantee Ashara cannot verify. */
const NOT_VERIFIABLE_TERMS = ["not verifiable"];
/** The key terms by which the draft marks a guarantee whose drafter could not tell where it is observed. */
const UNDECIDED_TERMS = ["could not tell"];

const draftedGuarantee = z.looseObject({
  id: z.string().min(1),
  statement: z.string().min(1),
  verification: z.string().optional(),
  source: z.looseObject({ kind: z.string(), id: z.string().optional() }),
});
const draftedAssumption = z.looseObject({
  key: z.string().min(1),
  statement: z.string().min(1),
  kind: z.string(),
  underpins: z.array(z.string()),
});

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
  const reports = records.tenderReports.filter((report) => says(openingOf(report.body), CONTRACT_OPENING));
  const guarantees = z.array(draftedGuarantee).safeParse(first?.guarantees);
  if (first === undefined || !guarantees.success || guarantees.data.length === 0) {
    if (reports.length > 0)
      add("contract-draft", "a contract draft was posted for a project whose first vision holds no guarantees");
    return;
  }
  const [report, ...more] = reports;
  if (report === undefined || more.length > 0) {
    add(
      "contract-draft",
      `vision v${first.version} holds ${guarantees.data.length} guarantee(s), told in ${reports.length} ` +
        `contract draft(s); expected exactly one`,
    );
    return;
  }
  const inferences = z.array(draftedAssumption).safeParse(first.inferences);
  if (!inferences.success) {
    add(
      "contract-draft-unreadable",
      `vision v${first.version} assumptions cannot be read with what each underpins: ` +
        `${z.prettifyError(inferences.error).slice(0, 200)}`,
    );
    return;
  }
  const lines = report.body.split("\n");
  const keys = inferences.data.map((a) => a.key);
  for (const g of guarantees.data) {
    const resting = inferences.data
      .filter((a) => a.underpins.includes(g.id) || (g.source.kind === "assumption" && g.source.id === a.key))
      .map((a) => a.key);
    const basis: DraftBasis = resting.length > 0 ? "at-risk" : g.source.kind === "tender" ? "tender" : "reading";
    const listed = lines.filter((each) => each.startsWith(`- ${g.id}: `));
    const [line] = listed;
    const facts = line === undefined ? "" : besides(line.slice(`- ${g.id}: `.length), g.statement);
    const bases = kindsSaid(facts, BASES, BASIS_TERMS);
    const cited = citedOf(facts, keys);
    // One whose drafter could not tell where it is observed, and one Ashara cannot verify, is marked so beside its
    // basis, as v1 records it.
    const problems = [
      ...(line === undefined || listed.length > 1 ? [`lists it ${listed.length} time(s)`] : []),
      ...(line === undefined || carries(line, g.statement)
        ? []
        : [`does not state it as "${g.statement.slice(0, 120)}"`]),
      ...(bases.length === 1 && bases[0] === basis
        ? []
        : [`states its basis as [${bases.join(", ")}], recorded ${basis}`]),
      ...(cited.join(",") === resting.join(",")
        ? []
        : [`rests it on [${cited.join(", ")}], recorded [${resting.join(", ")}]`]),
      ...(says(facts, UNDECIDED_TERMS) === (g.verification === "undecided")
        ? []
        : ["marks it undecided where v1 does not, or not where it does"]),
      ...(says(facts, NOT_VERIFIABLE_TERMS) === (g.verification === "not-by-ashara")
        ? []
        : ["marks it not verifiable by Ashara where v1 does not, or not where it does"]),
    ];
    if (problems.length > 0)
      add(
        `contract-draft:${g.id}`,
        `the contract draft does not list ${g.id} as v${first.version} records it: ${problems.join("; ")}`,
      );
  }
  for (const a of inferences.data) {
    const listed =
      a.kind === "internal-design"
        ? lines.includes(`- ${a.key}: ${a.statement}`)
        : lines.some((each) => each.startsWith(`- ${a.key}: ${a.statement} (`));
    if (!listed)
      add(
        `contract-draft:${a.key}`,
        `the contract draft does not list assumption ${a.key} ("${a.statement.slice(0, 120)}"), ${a.kind}`,
      );
  }
}

/**
 * The key terms of the decline of a contract, each a fact its terminal message states, once: that Ashara
 * cannot verify a guarantee as written, that the client is asked to restate them, and that confirming it
 * does not start work.
 */
const DECLINE_TERMS = ["cannot verify", "restate", "does not start"];
/** The key terms every intake message on a declined contract says in the decline's place: work has not started. */
const NOT_STARTED_TERMS = ["not started"];
/** The key terms no message posted for a declined contract says: each tells the client work is under way or waits. */
const UNDER_WAY_TERMS = ["work does not wait", "work proceeds", "work has started", "nothing waits", "we proceed"];

const markedGuarantee = z.looseObject({ verification: z.string().optional() });

/**
 * Whether a vision version is one Ashara declines, read from its stored guarantees as the oracle reads
 * them: it holds guarantees and every one is marked not verifiable by Ashara or undecided; null when they do
 * not read.
 */
function declinedVersion(vision: z.infer<typeof visionRow>): boolean | null {
  const guarantees = z.array(markedGuarantee).safeParse(vision.guarantees);
  if (!guarantees.success) return null;
  return (
    guarantees.data.length > 0 &&
    guarantees.data.every((g) => g.verification === "not-by-ashara" || g.verification === "undecided")
  );
}

/**
 * A contract Ashara can verify no guarantee of is declined at proposal, by its terminal message alone:
 * when vision v1 is one, every message intake posted with it (the questions, the contract draft and the
 * reading report) says work has not started, never restates the decline and never says work is under
 * way; and every decline message states the decline, asks for the guarantees restated and says no
 * confirmation starts work.
 */
function checkDeclinedContract(records: TextFactRecords, add: Add): void {
  for (const [index, message] of records.declines.entries()) {
    const missing = DECLINE_TERMS.filter((term) => !says(message.body, [term]));
    const named = missing.map((w) => `"${w}"`).join(", ");
    if (missing.length > 0) add(`declined-message:${index + 1}`, `decline ${index + 1} does not state ${named}`);
  }
  const [first] = records.visions;
  if (first === undefined) return;
  const declined = declinedVersion(first);
  if (declined === null) {
    add("declined-unreadable", `vision v${first.version}'s guarantees cannot be read with their verification marks`);
    return;
  }
  if (declined) {
    const intakeQuestions = records.questions.filter((question) => question.intake);
    for (const [index, message] of [...intakeQuestions, ...records.tenderReports].entries()) {
      const missing = NOT_STARTED_TERMS.filter((term) => !says(message.body, [term]));
      const restated = says(message.body, DECLINE_TERMS) ? DECLINE_TERMS : [];
      const underWay = UNDER_WAY_TERMS.filter((term) => says(message.body, [term]));
      const quoted = (words: readonly string[]): string => words.map((w) => `"${w}"`).join(", ");
      const faults = [
        ...(missing.length > 0 ? [`does not state ${quoted(missing)}`] : []),
        ...(restated.length > 0 ? [`restates the decline its terminal message tells (${quoted(restated)})`] : []),
        ...(underWay.length > 0 ? [`says ${quoted(underWay)}`] : []),
      ];
      const opening = message.body.slice(0, 80);
      if (faults.length > 0)
        add(
          `declined-intake:${index + 1}`,
          `intake message ${index + 1} ("${opening}") on a contract Ashara declines ${faults.join(" and ")}`,
        );
    }
  }
}

/**
 * No work starts on a contract Ashara declines: while no version the project held is one Ashara can
 * verify a guarantee of, whatever the client confirmed, the project has no work item. Null when it
 * holds; the violation's statement otherwise. Judged on every snapshot (I6), since a restatement later
 * in the run would hide work started before it.
 */
export function declinedWork(records: TextFactRecords): string | null {
  if (records.visions.length === 0 || records.workItems === 0) return null;
  const declined = records.visions.map(declinedVersion);
  if (declined.some((each) => each === null))
    return "a vision version's guarantees cannot be read with their verification marks";
  if (!declined.every((each) => each === true)) return null;
  return (
    `the project has ${records.workItems} work item(s), yet every vision version it held ` +
    `(v1-v${records.visions.length}) ` +
    `is one Ashara declines, holding no guarantee Ashara can verify`
  );
}

/** The key terms by which a tender report opens as the reading report: the tender's first reading found nothing. */
const READING_OPENING = ["tender", "found nothing"];
/** The key terms of a paragraph telling how the tender was read, and of one saying that is not on record. */
const READ_TERMS = ["tender", "read"];
const READ_UNRECORDED = ["tender", "not on record"];

/** The strengths of a second reading, by the keys intake_readings records them under. */
const STRENGTHS = ["other-family", "same-family-other-model", "same-model"] as const;
/** The key terms that tell each strength apart, written here and never read from the composer. */
const STRENGTH_TERMS = {
  "other-family": { all: ["model family"] },
  "same-family-other-model": { all: ["same family"] },
  "same-model": { all: ["same model"] },
} as const satisfies Record<(typeof STRENGTHS)[number], Signature>;

/** What a second reading found: nothing either, the questions it raised, or none could be had. */
type ReadingOutcome = "confirmed" | "questions-raised" | "unconfirmed";
const OUTCOME_TERMS = {
  confirmed: { all: ["nothing to ask either"] },
  "questions-raised": { all: ["question|questions"] },
  unconfirmed: { all: ["no second reading"] },
} as const satisfies Record<ReadingOutcome, Signature>;
const OUTCOMES: readonly ReadingOutcome[] = ["confirmed", "questions-raised", "unconfirmed"];

/** The questions a text says a second reading raised: its one figure, or one when it names a question and no figure. */
function questionsStated(text: string): number | null {
  const figures = figuresOf(text);
  if (figures.length === 1) return figures[0] ?? null;
  return figures.length === 0 && says(text, ["question"]) && !says(text, ["questions"]) ? 1 : null;
}

/**
 * Where a text departs from a recorded reading that asked nothing, by the facts it carries: what the
 * second reading found alone, and, where one could be had, its strength alone and, where it raised
 * questions, how many.
 */
function readingProblems(reading: NonNullable<TextFactRecords["intakeReading"]>, text: string): string[] {
  const outcome: ReadingOutcome =
    reading.confirmation === "unconfirmed" || reading.confirmation === "confirmed"
      ? reading.confirmation
      : "questions-raised";
  const outcomes = kindsSaid(text, OUTCOMES, OUTCOME_TERMS);
  const problems =
    outcomes.length === 1 && outcomes[0] === outcome
      ? []
      : [`it states the second reading as [${outcomes.join(", ")}]`];
  if (outcome === "unconfirmed") return problems;
  const strengths = kindsSaid(text, STRENGTHS, STRENGTH_TERMS);
  if (strengths.length !== 1 || strengths[0] !== reading.secondStrength)
    problems.push(`it names the strength [${strengths.join(", ")}], recorded ${reading.secondStrength ?? "none"}`);
  const asked = questionsStated(text);
  if (outcome === "questions-raised" && (reading.secondQuestions === null || asked !== reading.secondQuestions))
    problems.push(`it states ${asked ?? "no count of"} question(s), recorded ${reading.secondQuestions ?? "none"}`);
  return problems;
}

/**
 * The reading report and the delivered report's paragraph on the tender's reading, against
 * intake_readings, by the facts they carry: a reading that asked nothing is told once, at intake, with
 * the strength of the second reading and what it found or that none answered, and so is every
 * delivered report; a reading that asked questions is told neither way; one not on record is said to
 * be so in the delivered report.
 */
function checkIntakeReading(records: TextFactRecords, add: Add): void {
  const reading = records.intakeReading;
  const told = records.tenderReports.filter((report) => says(openingOf(report.body), READING_OPENING));
  if (reading === null || reading.confirmation === "not-needed") {
    if (told.length > 0)
      add(
        "reading-report",
        `a reading report was posted, but intake_readings records ` +
          `${reading === null ? "no reading" : "a reading that asked questions"}`,
      );
    for (const report of records.delivered) {
      const parts = paragraphsSaying(outsideFences(report.body), READ_TERMS);
      const unrecorded = parts.filter((part) => says(leadOf(part), READ_UNRECORDED));
      if (parts.length !== unrecorded.length || (unrecorded.length > 0) !== (reading === null)) {
        add(
          "delivered-reading",
          `the delivered report's sentence on the tender's reading does not fit intake_readings ` +
            `(${reading === null ? "no row" : "not-needed"})`,
        );
      }
    }
    return;
  }
  if (told.length !== 1) {
    add(
      "reading-report",
      `intake_readings records a reading that asked nothing (${reading.confirmation}), told in ` +
        `${told.length} reading report(s); expected exactly one`,
    );
  }
  for (const report of told) {
    const problems = readingProblems(reading, openingOf(report.body));
    if (problems.length > 0)
      add(
        "reading-report",
        `the reading report, for a reading recorded ${reading.confirmation}: ${problems.join("; ")}`,
      );
  }
  for (const report of records.delivered) {
    const parts = paragraphsSaying(outsideFences(report.body), READ_TERMS).filter(
      (part) => !says(leadOf(part), READ_UNRECORDED),
    );
    const [part] = parts;
    const problems =
      part === undefined || parts.length > 1
        ? [`${parts.length} of its paragraphs tell how the tender was read; one does`]
        : readingProblems(reading, leadOf(part));
    if (problems.length > 0)
      add(
        "delivered-reading",
        `the delivered report, for a reading recorded ${reading.confirmation}: ${problems.join("; ")}`,
      );
  }
}

/**
 * The first-plan report's decomposed and check task counts, each the one count it states of its unit,
 * of the plan that stood when it was reported: tasks written by then, less those a revision written
 * by then superseded.
 */
function checkFirstPlan(records: TextFactRecords, add: Add): void {
  const { report, items, revisions } = records.firstPlan;
  if (report === null) return;
  const revisedBefore = new Set(
    revisions.filter((revision) => revision.beforeReport).map((revision) => revision.revision),
  );
  let corrupt = 0;
  const standing = items.filter((item) => {
    if (!item.beforeReport) return false;
    try {
      const reason = parseStoredBlockedReason(item.blockedReason);
      return !(reason?.source === "superseded" && revisedBefore.has(reason.planRevision));
    } catch (err) {
      if (!(err instanceof BlockedReasonCorrupt)) throw err;
      corrupt += 1;
      /* eslint-disable-next-line no-restricted-syntax -- policy default: a task whose reason does not parse is
         counted as corrupt and reported as first-plan-unreadable below */
      return false;
    }
  });
  if (corrupt > 0) {
    add(
      "first-plan-unreadable",
      `${corrupt} task(s) of the first plan carry a stored reason that does not parse, so the plan the ` +
        `report counts is not on record`,
    );
    return;
  }
  const decomposed = standing.filter((item) => item.origin === "decomposition").length;
  const checks = standing.filter((item) => item.origin === "check").length;
  const prose = paragraphsOf(report.body).map((part) => leadOf(part)).join("\n\n");
  for (const [unit, count] of [
    ["task", decomposed],
    ["check task", checks],
  ] as const) {
    const stated = countsOf(prose, unit);
    if (stated.length !== 1 || stated[0] !== count)
      add(
        "first-plan-counts",
        `the first-plan report counts [${stated.join(", ")}] ${unit}(s); the plan that stood when it was posted ` +
          `holds ${count}`,
      );
  }
}

/** The key terms of the paragraph listing the assumptions the guarantees rest on. */
const ASSUMPTIONS_TERMS = ["assumptions"];

/** Whether the client stated an assumption, as the vision records it. */
type TableStanding = "stated" | "unconfirmed";
/** The key terms that tell each standing apart in an assumption's line, written here, never read from the composer. */
const TABLE_STANDING_TERMS = {
  stated: { all: ["stated by you"] },
  unconfirmed: { all: ["not confirmed"] },
} as const satisfies Record<TableStanding, Signature>;
const TABLE_STANDINGS: readonly TableStanding[] = ["stated", "unconfirmed"];

/**
 * The assumptions paragraph of the delivered report's guarantee table names every assumption of
 * the vision at acceptance not recorded as internal design, once, by its key and statement, and states
 * whether the client stated it, as that version records it, by the facts its line carries: an
 * assumption the client has not stated is never told to them as theirs.
 */
function checkTableAssumptions(records: TextFactRecords, add: Add, versions: Versions): void {
  for (const report of records.delivered) {
    const vision = report.visionAtAcceptance === null ? undefined : versions.get(report.visionAtAcceptance);
    if (vision === undefined) continue;
    if (vision.kind === "unreadable") {
      add(
        "delivered-standing-unreadable",
        `the delivered report's table rests on a vision at acceptance that cannot be read: ` +
          `${vision.detail.slice(0, 200)}`,
      );
      continue;
    }
    const listed = paragraphsSaying(outsideFences(report.body), ASSUMPTIONS_TERMS)
      .flatMap((part) => part.split("\n"))
      .filter((line) => line.startsWith("- "));
    const visible = vision.assumptions.filter((assumption) => assumption.kind !== "internal-design");
    for (const assumption of visible) {
      const lines = listed.filter((line) => line.startsWith(`- ${assumption.key}: `));
      const standing: TableStanding = assumption.status === "Stated" ? "stated" : "unconfirmed";
      const [line] = lines;
      if (lines.length !== 1 || line === undefined) {
        add(
          `delivered-standing:${assumption.key}`,
          `the delivered report names assumption ${assumption.key} ${lines.length} time(s) among the ` +
            `assumptions the guarantees rest on; it must once`,
        );
      } else {
        const standings = kindsSaid(besides(line, assumption.statement), TABLE_STANDINGS, TABLE_STANDING_TERMS);
        if (!carries(line, assumption.statement) || standings.length !== 1 || standings[0] !== standing)
          add(
            `delivered-standing:${assumption.key}`,
            `the delivered report says "${line.slice(0, 200)}", its standing [${standings.join(", ")}]; at ` +
              `acceptance ${assumption.key} is "${assumption.statement.slice(0, 120)}", ${assumption.status}`,
          );
      }
    }
    const known = new Set(visible.map((assumption) => assumption.key));
    for (const line of listed) {
      const key = /^- ([^:]+): /.exec(line)?.[1];
      if (key === undefined || !known.has(key))
        add(
          `delivered-standing:${key ?? "unkeyed"}`,
          `the delivered report names "${line.slice(0, 120)}" as an assumption the guarantees rest on; the ` +
            `vision at acceptance holds no such client-visible assumption`,
        );
    }
  }
}

/** Whether a line names the public interface file at `commit`: the facts that lead its quote, or say it is missing. */
function namesInterfaceAt(line: string, commit: string): boolean {
  return cites(line, PUBLIC_INTERFACE_PATH) && cites(line, commit);
}

/** The key terms by which the report says main holds no public interface file. */
const MISSING_TERMS = ["missing"];
/** The key terms by which the quote's lead says the file was cut. */
const CUT_TERMS = ["start and end"];
/** The key terms by which the quote's lead says Ashara did not check whether the file describes the product. */
const UNJUDGED_TERMS = ["not verified"];
const CUT_MARKER = /(?:^|\n)\[truncated by Ashara: (\d+) characters cut here\]\n/g;
const FENCE = /^`{3,}$/;

/**
 * The line that leads the quote of the public interface file at `commit`, opening a paragraph and
 * naming the file and the commit, and the fenced block's text after it; null when the report holds no
 * such block.
 */
function quotedBlock(body: string, commit: string): { readonly said: string; readonly quoted: string } | null {
  const lines = body.split("\n");
  const at = lines.findIndex((line, i) => {
    const next = lines[i + 1];
    return (i === 0 || lines[i - 1] === "") && namesInterfaceAt(line, commit) && next !== undefined && FENCE.test(next);
  });
  if (at < 0) return null;
  const [said = "", fence = "", ...rest] = lines.slice(at);
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
 * file was accepted with no description at all. A delivered main any tracked file of which still
 * holds the scaffold placeholder's marker was accepted with an entry that still answers with the
 * scaffold's refusal. Not judged where no checkout is held.
 */
function checkDeliveredInterface(records: TextFactRecords, add: Add): void {
  const placeholders = records.placeholderOnMain;
  if (placeholders.kind === "read") {
    for (const report of records.delivered) {
      const at = placeholders.bySweep.get(report.sweepId);
      if (at === undefined || at.length > 0) {
        const where = at === undefined ? "not searched for" : `still at ${at.join(", ")}`;
        add(
          "delivered-placeholder-refusal",
          `the project was delivered with the scaffold's placeholder refusal (${PLACEHOLDER_MARKER}) ` +
            `${where} on main at commit ${report.mainCommit.slice(0, 12)}`,
        );
      }
    }
  }
  const onMain = records.interfaceOnMain;
  if (onMain.kind === "not-held") return;
  for (const report of records.delivered) {
    const file = onMain.bySweep.get(report.sweepId);
    const commit = report.mainCommit;
    if (file === undefined) {
      add(
        "delivered-interface-unread",
        `${PUBLIC_INTERFACE_PATH} was not read at commit ${commit.slice(0, 12)} for a delivered report`,
      );
      continue;
    }
    const block = quotedBlock(report.body, commit);
    if (file.kind === "absent") {
      add(
        "delivered-absent-interface",
        `the project was delivered with no ${PUBLIC_INTERFACE_PATH} on main at commit ${commit.slice(0, 12)}`,
      );
      const saysMissing = paragraphsSaying(outsideFences(report.body), MISSING_TERMS).some((part) =>
        namesInterfaceAt(part, commit),
      );
      if (block !== null || !saysMissing) {
        add(
          "delivered-interface",
          `main holds no ${PUBLIC_INTERFACE_PATH} at commit ${commit.slice(0, 12)}, but the delivered report ` +
            `${block === null ? "does not say it is missing there" : "quotes a block of it"}`,
        );
      }
      continue;
    }
    if (isScaffoldInterface(file.text)) {
      add(
        "delivered-placeholder-interface",
        `the project was delivered with ${PUBLIC_INTERFACE_PATH} at commit ${commit.slice(0, 12)} still the ` +
          `scaffold's placeholder`,
      );
    }
    if (block === null) {
      add(
        "delivered-interface",
        `main holds ${PUBLIC_INTERFACE_PATH} at commit ${commit.slice(0, 12)}, but the delivered report ` +
          `quotes no block of it after a line naming it at that commit`,
      );
      continue;
    }
    const quote = quoteOf(block.quoted, file.text);
    if (quote === null) {
      add(
        "delivered-interface",
        `the delivered report's quoted block is not ${PUBLIC_INTERFACE_PATH} as main holds it at ` +
          `${commit.slice(0, 12)}: it reads "${block.quoted.slice(0, 120)}", main "${file.text.slice(0, 120)}"`,
      );
      continue;
    }
    if ((quote === "cut") !== says(block.said, CUT_TERMS)) {
      add(
        "delivered-interface-cut",
        `the delivered report quotes ${PUBLIC_INTERFACE_PATH} ${quote}, but ` +
          `${quote === "cut" ? "does not say" : "says"} it was cut: "${block.said.slice(0, 200)}"`,
      );
    }
    if (!says(block.said, UNJUDGED_TERMS)) {
      add(
        "delivered-interface-claim",
        `the delivered report quotes ${PUBLIC_INTERFACE_PATH} without saying Ashara has not verified it describes ` +
          `the product: ` +
          `acceptance compares its bytes with the scaffold's, never what it says`,
      );
    }
  }
}

/** Who judges a composer's text: a check of I9 here, or I4 (client-reports.ts) by the violation key it reports. */
type TextJudge =
  | { readonly by: "I9"; readonly check: TextCheck }
  | { readonly by: "I4"; readonly check: typeof checkReports; readonly key: string };

/**
 * A composer whose text an oracle judges. `source` is `<repo-relative path>#<name>`, a method's name `Class.method`.
 */
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
const EVALUATION = "packages/evaluation/src";
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
  // The brief's vision version and assumptions, its assumption lines, and its task section against the work item's
  // task_spec.
  { source: `${DELIVERY}/dispatch/execute-task.ts#buildBrief`, judges: [i9(checkBriefs)] },
  { source: `${WORKPLACE}/prompt.ts#buildTaskPrompt`, judges: [i9(checkBriefs)] },
  { source: `${WORKPLACE}/prompt.ts#assumptionsSection`, judges: [i9(checkBriefs)] },
  { source: `${WORKPLACE}/prompt.ts#interfaceSection`, judges: [i9(checkBriefs)] },
  { source: `${ENGAGEMENT}/intake.ts#questionBody`, judges: [i9(checkQuestions), i9(checkDeclinedContract)] },
  { source: `${ENGAGEMENT}/client-question.ts#questionBody`, judges: [i9(checkQuestions)] },
  { source: `${ENGAGEMENT}/answers.ts#replanReport`, judges: [i9(checkAnswerReplies)] },
  // A contract Ashara declines: the draft, like every intake message, says work has not started and
  // leaves the decline to its terminal message.
  {
    source: `${ENGAGEMENT}/intake.ts#contractDraftReport`,
    judges: [i9(checkContractDraft), i9(checkDeclinedContract)],
  },
  // A reading that asked nothing: its confirmation's strength and what it found, against intake_readings.
  { source: `${ENGAGEMENT}/intake.ts#readingReport`, judges: [i9(checkIntakeReading), i9(checkDeclinedContract)] },
  { source: `${ENGAGEMENT}/delivered-report.ts#readingSection`, judges: [i9(checkIntakeReading)] },
  { source: `${ENGAGEMENT}/plan-report.ts#firstPlanReport`, judges: [i9(checkFirstPlan)] },
  // Every terminal message's table: each guarantee in force once with the verdict its sweep's evidence
  // reads, stored beside it, the punch list, and each assumption with whether the client stated it.
  {
    source: `${ENGAGEMENT}/guarantee-report.ts#guaranteeSection`,
    judges: [i4("guarantee-table"), i9(checkTableAssumptions)],
  },
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
  { source: `${ENGAGEMENT}/stop-report.ts#stopReport`, judges: [i4("stop-merges")] },
  // The decline of a contract Ashara can verify no guarantee of: a terminal message, its table on no sweep.
  {
    source: `${ENGAGEMENT}/terminal-report.ts#declinedReport`,
    judges: [i4("guarantee-table:declined"), i9(checkDeclinedContract)],
  },
  // The work ledger's early warning: its figures against its own record and the ledger, its zone, once per revision.
  {
    source: `${ENGAGEMENT}/burn-warning.ts#burnWarningReport`,
    judges: [i4("burn-warning"), i4("burn-warning-zone"), i4("burn-warning-repeated")],
  },
  { source: `${ENGAGEMENT}/burn-warning.ts#operatorBurnReport`, judges: [i4("burn-warning-operator")] },
];

const I9_CHECKS: readonly TextCheck[] = [
  ...new Set(
    TEXT_COVERED.flatMap((entry) => entry.judges.flatMap((judge) => (judge.by === "I9" ? [judge.check] : []))),
  ),
];

/** @testseam text-coverage.test.ts holds it to the source: the composers no oracle judges, each with its reason */
export const TEXT_EXCLUDED: readonly ExcludedText[] = [
  {
    source: `${EVALUATION}/run-report-body.ts#runReport`,
    kind: "not-a-composer",
    reason: "the operator's run report; no agent or client reads it",
  },
  {
    source: `${EVALUATION}/run-report-format.ts#formatRunReport`,
    kind: "not-a-composer",
    reason: "the operator's run report; no agent or client reads it",
  },
  {
    source: `${ENGAGEMENT}/block-report.ts#blockedBody`,
    kind: "not-a-composer",
    reason: "joins the halt's own text and the guarantee table, each placed on its own",
  },
  {
    source: `${ENGAGEMENT}/repositories/block-report.ts#postResumptionReport`,
    kind: "not-a-composer",
    reason: "posts the body it is given, through insertOutboundReport",
  },
  {
    source: `${ENGAGEMENT}/repositories/block-report.ts#notCoveredByPlanningStoppedReport`,
    kind: "not-a-composer",
    reason: "a predicate on which halts a planning-stopped message already tells; it composes no text",
  },
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#insertOutboundReport`,
    kind: "not-a-composer",
    reason: "posts the body it is given",
  },
  {
    source: `${ENGAGEMENT}/repositories/plan-report.ts#postPlanReport`,
    kind: "not-a-composer",
    reason: "posts the body it is given",
  },
  {
    source: `${ENGAGEMENT}/repositories/plan-report.ts#postPlanRevisionReport`,
    kind: "not-a-composer",
    reason: "posts the body it is given",
  },
  {
    source: `${DELIVERY}/dispatch/dispatch-records.ts#DispatchRecords.writeBrief`,
    kind: "not-a-composer",
    reason: "writes the composed brief to the conversation record as it is",
  },
  {
    source: `${WORKPLACE}/agent-brief.ts#createAgentBrief`,
    kind: "not-a-composer",
    reason: "parses a composed brief against its schema; DispatchService.buildBrief composes it",
  },
  {
    source: `${WORKPLACE}/prompt.ts#buildSystemPrompt`,
    kind: "not-a-composer",
    reason: "joins the charter's duties to the sections placed on their own",
  },
  {
    source: "packages/execution-infra/src/podman.ts#parseStatusReport",
    kind: "not-a-composer",
    reason: "parses podman's status output",
  },
  {
    source: "packages/finance/src/llm-call-ledger.ts#NO_USAGE_REPORT",
    kind: "not-a-composer",
    reason: "a cost measurement value, not text",
  },
  {
    source: "packages/model-access/src/turn.ts#cachedTurnPrompt",
    kind: "not-a-composer",
    reason: "places cache breakpoints on a prompt already composed",
  },
  {
    source: "packages/server/src/client-channel.ts#readJsonBody",
    kind: "not-a-composer",
    reason: "reads an HTTP request body",
  },
  {
    source: "packages/server/src/fail-closed.ts#fatalReport",
    kind: "not-a-composer",
    reason: "the operator's log line for a fatal error; no agent or client reads it",
  },

  { source: `${QUALITY}/suite-review.ts#reviewPrompt`, kind: "not-kept", reason: "the suite review's prompt" },
  { source: `${QUALITY}/suite-review.ts#suiteSection`, kind: "not-kept", reason: "part of the suite review's prompt" },
  {
    source: `${QUALITY}/suite-review.ts#interfaceSection`,
    kind: "not-kept",
    reason: "part of the suite review's prompt",
  },
  {
    source: `${QUALITY}/suite-review.ts#angleSection`,
    kind: "not-kept",
    reason: "part of a second opinion's suite review prompt",
  },
  {
    source: "packages/model-access/src/gateway.ts#textStructuredPrompt",
    kind: "not-kept",
    reason: "a structured request's prompt with the schema it must answer, for a provider that takes no schema",
  },
  {
    source: `${DELIVERY}/decomposition.ts#DecompositionEngine.buildDecomposePrompt`,
    kind: "not-kept",
    reason: "the planner's prompt",
  },
  {
    source: `${DELIVERY}/replan-prompts.ts#causeSection`,
    kind: "not-kept",
    reason: "part of a plan revision's planner prompt",
  },
  {
    source: `${DELIVERY}/replan-prompts.ts#abandonmentSection`,
    kind: "not-kept",
    reason: "part of a plan revision's planner and environment prompts",
  },
  {
    source: `${DELIVERY}/replan-prompts.ts#doneSection`,
    kind: "not-kept",
    reason: "part of a plan revision's planner prompt",
  },
  {
    source: `${DELIVERY}/replan-prompts.ts#environmentPrompt`,
    kind: "not-kept",
    reason: "the prompt asking whether a plan revision needs the environment changed",
  },
  {
    source: "packages/organization/src/derivation.ts#buildPrompt",
    kind: "not-kept",
    reason: "the prompt that derives the project's team",
  },
  { source: `${ENGAGEMENT}/intake.ts#buildIntakePrompt`, kind: "not-kept", reason: "the prompt that reads a tender" },
  {
    source: `${ENGAGEMENT}/intake.ts#secondReadingPrompt`,
    kind: "not-kept",
    reason: "the prompt of a second reading of a tender whose first reading asked nothing",
  },
  {
    source: `${ENGAGEMENT}/intake.ts#readingAngleSection`,
    kind: "not-kept",
    reason: "part of a second reading's prompt within the first reading's model family",
  },
  {
    source: `${ENGAGEMENT}/answers.ts#buildAnswerPrompt`,
    kind: "not-kept",
    reason: "the prompt that reads a client answer",
  },

  {
    source: `${ENGAGEMENT}/correction.ts#correctionPrompt`,
    kind: "not-kept",
    reason: "the prompt that reads a client change",
  },
  {
    source: `${ENGAGEMENT}/correction.ts#correctionReport`,
    kind: "unjudged",
    reason:
      "states a correction's operations, the tasks citing its keys and its cost band; no oracle compares " +
      "them with the records",
  },

  {
    source: `${ENGAGEMENT}/client-receipt.ts#receiptReport`,
    kind: "unjudged",
    reason:
      "states the project's state and what happens to the message; I4's receipt clause (receipts.ts) judges " +
      "only that every message has its one receipt by the end of the next clean cycle",
  },
  {
    source: `${ENGAGEMENT}/block-report.ts#projectResumedReport`,
    kind: "unjudged",
    reason: "states how the halt ended; I4 judges only that it is its episode's one report",
  },
  {
    source: `${ENGAGEMENT}/plan-report.ts#planRevisionReport`,
    kind: "unjudged",
    reason:
      "states the revision's task counts and what it set aside; I4 judges only that it is its revision's one report",
  },
  {
    source: `${ENGAGEMENT}/plan-report.ts#planningStoppedReport`,
    kind: "unjudged",
    reason: "states the count of failed planning attempts",
  },
  {
    source: `${ENGAGEMENT}/stack-choice.ts#stackChoiceReport`,
    kind: "unjudged",
    reason: "quotes the environment's recorded statement",
  },
  {
    source: `${ENGAGEMENT}/delivered-report.ts#executedSection`,
    kind: "unjudged",
    reason:
      "quotes the stored checks the acceptance sweep records it ran on main; no oracle compares them with " +
      "the sweep's record",
  },
  {
    source: `${DELIVERY}/domain/stale-checks.ts#disputeBrief`,
    kind: "unjudged",
    reason: "states the dispute a reopened check task's brief carries",
  },
  {
    source: `${DELIVERY}/domain/stale-checks.ts#reviewBrief`,
    kind: "unjudged",
    reason: "states the review problems a reopened check task's brief carries",
  },
  {
    source: `${QUALITY}/task-checks.ts#formatChecksForBrief`,
    kind: "unjudged",
    reason: "states the stored checks in a brief's context, past the task section checkBriefs judges",
  },
  { source: `${QUALITY}/task-checks.ts#checkFilesForBrief`, kind: "unjudged", reason: "part of formatChecksForBrief" },
  {
    source: `${QUALITY}/task-checks.ts#formatProjectChecksForCheckAuthor`,
    kind: "unjudged",
    reason: "states the project's stored checks in a check author's brief context",
  },
  {
    source: `${QUALITY}/task-checks.ts#formatFoundationForCheckAuthor`,
    kind: "unjudged",
    reason: "names the plan's foundation task in a check author's brief context",
  },
  {
    source: `${QUALITY}/merge.ts#formatConflictForBrief`,
    kind: "unjudged",
    reason: "states a conflict with main in a brief's context",
  },
  {
    source: `${QUALITY}/check-verdict.ts#formatCheckRunReport`,
    kind: "unjudged",
    reason: "run_checks' result as the agent reads it",
  },
  {
    source: `${QUALITY}/environment-verdict.ts#commandSection`,
    kind: "unjudged",
    reason: "an environment command's run as the model and the gate's failure record read it",
  },
  { source: `${QUALITY}/environment-verdict.ts#logSection`, kind: "unjudged", reason: "part of commandSection" },
  {
    source: `${WORKPLACE}/error-envelope.ts#renderChainForBrief`,
    kind: "unjudged",
    reason: "states a prior attempt's error chain in a brief",
  },
  {
    source: `${WORKPLACE}/prompt.ts#staticPrompt`,
    kind: "unjudged",
    reason: "states the charter's identity and the workspace's rules in the system prompt",
  },
  {
    source: `${WORKPLACE}/prompt.ts#protectedPathsSection`,
    kind: "unjudged",
    reason: "states the brief's protected paths in the system prompt",
  },
  {
    source: `${WORKPLACE}/prompt.ts#environmentSection`,
    kind: "unjudged",
    reason: "states the brief's environment version and statement in the system prompt",
  },
];

/**
 * @testseam text-coverage.test.ts holds it to the source: every client_messages writer, with the composers whose text
 * it posts
 */
export const CLIENT_MESSAGE_WRITERS: readonly ClientMessageWriter[] = [
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#postOnSubject`,
    posts: [
      `${ENGAGEMENT}/plan-report.ts#firstPlanReport`,
      `${ENGAGEMENT}/plan-report.ts#planningStoppedReport`,
      `${ENGAGEMENT}/stop-report.ts#stopReport`,
      `${ENGAGEMENT}/terminal-report.ts#declinedReport`,
      `${ENGAGEMENT}/stack-choice.ts#stackChoiceReport`,
      `${ENGAGEMENT}/intake.ts#contractDraftReport`,
    ],
    clientWords: false,
  },
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#insertOutboundReport`,
    posts: [
      `${ENGAGEMENT}/plan-report.ts#planRevisionReport`,
      `${ENGAGEMENT}/block-report.ts#projectBlockedReport`,
      `${ENGAGEMENT}/block-report.ts#planRepairBoundReport`,
      `${ENGAGEMENT}/block-report.ts#disputeBoundReport`,
      `${ENGAGEMENT}/block-report.ts#suiteReviewBoundReport`,
      `${ENGAGEMENT}/block-report.ts#projectResumedReport`,
      `${ENGAGEMENT}/delivered-report.ts#deliveredReport`,
      `${ENGAGEMENT}/delivered-report.ts#unreadNotice`,
      `${ENGAGEMENT}/answers.ts#replanReport`,
      `${ENGAGEMENT}/burn-warning.ts#burnWarningReport`,
    ],
    clientWords: false,
  },
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#ClientMessageRepository.insert`,
    posts: [
      `${ENGAGEMENT}/intake.ts#readingReport`,
      `${ENGAGEMENT}/correction.ts#correctionReport`,
      `${ENGAGEMENT}/client-question.ts#questionBody`,
    ],
    clientWords: true,
  },
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#ClientMessageRepository.insertQuestions`,
    posts: [`${ENGAGEMENT}/intake.ts#questionBody`],
    clientWords: false,
  },
  {
    source: `${ENGAGEMENT}/repositories/client-message.ts#postReceiptOf`,
    posts: [`${ENGAGEMENT}/client-receipt.ts#receiptReport`],
    clientWords: false,
  },
];
