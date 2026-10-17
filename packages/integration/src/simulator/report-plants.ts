import { z } from "zod";
import { JsonParseFailed, parseJson } from "@ashara/shared";
import type { QueryPlant } from "./faults.js";

/**
 * Plants on what the client is told (I4): each rewrites one report as production posts it, at the
 * database seam, so the run must name the report against its records. Each returns null for a query
 * it leaves as it was, so a plant whose wording production no longer writes is counted as changing
 * nothing, and the run throws for it (run.ts PlantInert) instead of passing as "not caught".
 */

const sentText = z.union([z.string(), z.object({ text: z.string() }).loose()]);

function textOf(args: readonly unknown[]): string | null {
  const parsed = sentText.safeParse(args[0]);
  if (!parsed.success) return null;
  return typeof parsed.data === "string" ? parsed.data : parsed.data.text;
}

/** The parameters with each string `rewrite` applies to rewritten, or null when no parameter changed. */
function rewriteParams(params: readonly unknown[], rewrite: (param: string) => string | null): unknown[] | null {
  let changed = false;
  const rewritten = params.map((param: unknown) => {
    if (typeof param !== "string") return param;
    const next = rewrite(param);
    if (next === null || next === param) return param;
    changed = true;
    return next;
  });
  return changed ? rewritten : null;
}

/** Rewrites the body of an outbound report whose text `matches`, where drizzle sends it as a parameter. */
function rewriteReport(matches: (body: string) => boolean, rewrite: (body: string) => string): QueryPlant {
  return (args) => {
    const text = textOf(args);
    const params = args[1];
    if (text === null || !text.startsWith(`insert into "client_messages"`) || !Array.isArray(params)) return null;
    const rewritten = rewriteParams(params, (param) => (matches(param) ? rewrite(param) : null));
    return rewritten === null ? null : [args[0], rewritten, ...args.slice(2)];
  };
}

/** Drops the first line opening with `prefix` (by default one naming a task, `- "<title>"...`) from the paragraph opening with `head`. */
function dropFirstNamed(body: string, head: string, prefix = `- "`): string {
  const parts = body.split("\n\n");
  const at = parts.findIndex((part) => part.startsWith(head));
  const part = parts[at];
  if (part === undefined) return body;
  const lines = part.split("\n");
  const first = lines.findIndex((line) => line.startsWith(prefix));
  if (first < 0) return body;
  parts[at] = lines.filter((_, index) => index !== first).join("\n");
  return parts.join("\n\n");
}

const PAUSED = ["Work on this project is paused.", "Work on this project has stopped: the team cannot deliver"];

/** A halt report that states a fixed cause, chosen by nothing that happened. */
export const haltReportFixedCause = rewriteReport(
  (body) => PAUSED.some((opening) => body.startsWith(opening)),
  () => "Work on this project is paused.\n\nThe cause: a temporary problem on our side.\n\nYou will be told when work resumes.",
);

/** A stop report that leaves out the first merge on record. */
export const stopReportOmitsMerge = rewriteReport(
  (body) => body.startsWith("Work on this project has stopped at your request."),
  (body) => dropFirstNamed(body, "What is on main"),
);

/** A delivered report that leaves out the first goal's close. */
export const deliveredReportOmitsGoal = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) => dropFirstNamed(body, "What was delivered:"),
);

const UNCHECKED_HEAD = "These tasks are done but not checked by a stored check";

/** A delivered report whose unchecked list is wrong: dropped when there is one, the first goal named in it when there is none. */
export const deliveredReportMisstatesUnchecked = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) => {
    const parts = body.split("\n\n");
    if (parts.some((part) => part.startsWith(UNCHECKED_HEAD))) return parts.filter((part) => !part.startsWith(UNCHECKED_HEAD)).join("\n\n");
    const goal = parts.find((part) => part.startsWith("What was delivered:"))?.split("\n").find((line) => line.startsWith(`- "`));
    const title = goal === undefined ? null : /^- "(.*)": /.exec(goal)?.[1];
    if (title === null || title === undefined) return body;
    return [...parts.slice(0, 2), `${UNCHECKED_HEAD}: none was written for them, so nothing in the run above confirms them:\n- "${title}"`, ...parts.slice(2)].join("\n\n");
  },
);

const UNCOVERED_HEAD = "These items of what you asked for are decided by no stored check";

/** A delivered report that leaves out the first asked-for item no stored check decides. */
const deliveredReportOmitsUncovered = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) => dropFirstNamed(body, UNCOVERED_HEAD, "- "),
);

/**
 * Plants on what a composer states (I9). Each rewrites one fact in a text as production writes it,
 * where drizzle sends it as a parameter (a jsonb brief is sent as its JSON text).
 */
function rewriteInsert(table: string, rewrite: (param: string) => string): QueryPlant {
  return (args) => {
    const text = textOf(args);
    const params = args[1];
    if (text === null || !text.startsWith(`insert into "${table}"`) || !Array.isArray(params)) return null;
    const rewritten = rewriteParams(params, rewrite);
    return rewritten === null ? null : [args[0], rewritten, ...args.slice(2)];
  };
}

/**
 * A brief that calls an assumption the client was asked about Stated by the client: the standing it
 * states is not the one of the vision it carries. The stand-ins' asked assumption is carried by every
 * brief among its assumptions; a task's text that cites it states no standing (visionSourceCitation),
 * and the suite review is a structured call with no brief, so text-facts.test.ts holds the
 * assumption-line clause.
 */
export const briefMisstatesStanding = rewriteInsert("dev_sessions", (param) => param.replaceAll(`"note":"Inferred; asked of the client, not yet answered;`, `"note":"Stated by the client;`));

const UNVERIFIED_HEAD = "These assumptions were recorded as how the team builds the product";

/** A delivered report that leaves out the first internal-design assumption it must name as not verified by Ashara (ADR-083). */
export const deliveredReportOmitsUnverified = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) => dropFirstNamed(body, UNVERIFIED_HEAD, "- "),
);

/**
 * A delivered report whose how-to-run section is not main's: the quoted interface names another command, or, where
 * main holds no interface file, the report says it is empty instead of saying there is none.
 */
export const deliveredReportMisquotesInterface = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) =>
    // The run command both the scaffold's and the delivered interface file state.
    body.includes(": sim <behaviour>")
      ? body.replace(": sim <behaviour>", ": tally <behaviour>")
      : body.replace("its public interface file is missing.", "its public interface file is empty."),
);

const decidesParam = z.array(z.string().min(1)).min(1);

/** A parameter that is a stored check's `decides` (a JSON array of ids), or null: every other parameter of the insert is not one. */
function decidesOf(param: unknown): string[] | null {
  if (typeof param !== "string") return null;
  try {
    return parseJson(decidesParam, param, "task_checks insert parameter");
  } catch (err) {
    if (err instanceof JsonParseFailed) return null;
    throw err;
  }
}

/**
 * A check set stored with one cited item decided by none of its checks (ADR-083): the check author
 * wrote no check for it, and the set reached the store past Z0's rule. Each stored check of the
 * revision that names the set's last decided item names the set's first instead, so the revision's
 * rows decide every item but that one. A set deciding one item only is left as it is.
 */
export const checkSetSkipsItem: QueryPlant = (args) => {
  const text = textOf(args);
  const params = args[1];
  if (text === null || !text.startsWith(`insert into "task_checks"`) || !Array.isArray(params)) return null;
  // eslint-disable-next-line no-restricted-syntax -- policy default: plant test plumbing, a parameter that is no decides array adds no id; no oracle reads it
  const decided = [...new Set(params.flatMap((param: unknown) => decidesOf(param) ?? []))];
  const [first] = decided;
  const skipped = decided.at(-1);
  if (first === undefined || skipped === undefined || decided.length < 2) return null;
  const rewritten = params.map((param: unknown) => {
    const ids = decidesOf(param);
    return ids === null ? param : JSON.stringify([...new Set(ids.map((id) => (id === skipped ? first : id)))]);
  });
  return [args[0], rewritten, ...args.slice(2)];
};

/** `plant` on a run whose check set is stored with one cited item undecided (checkSetSkipsItem): that item is what the report then states. */
function onCheckSetSkippingItem(plant: QueryPlant): QueryPlant {
  return (args) => checkSetSkipsItem(args) ?? plant(args);
}

/**
 * A delivered report that leaves out the first asked-for item no stored check decides. The honest
 * check author decides every cited item, so the plant stores one check set with an item undecided
 * (I6 names that too).
 */
export const deliveredReportOmitsUncoveredOfSkippedItem = onCheckSetSkippingItem(deliveredReportOmitsUncovered);

/**
 * A delivered report that says an assumption the client was asked about was reported to them. The
 * report states the standing of an asked-for item no stored check decides, so the plant stores one
 * check set with an item undecided (I6 names that too).
 */
export const deliveredReportMisstatesStanding = onCheckSetSkippingItem(
  rewriteReport(
    (body) => body.startsWith("Your project is delivered."),
    (body) => body.replaceAll("Ashara's assumption, which you were asked about and have not answered:", "Ashara's assumption, which was reported to you:"),
  ),
);

/** A question that says work proceeds on an assumption its vision does not record. */
export const questionMisstatesAssumption = rewriteInsert("client_messages", (param) =>
  param.replace(/(Until you answer, we proceed on this assumption: )(.*)/, "$1Messages are in Latin."),
);

/** The delivered report is posted but its sweep never records it, so it is due, and posted, again. */
export const deliveredReportUnrecorded: QueryPlant = (args) => {
  const text = textOf(args);
  if (text === null || !text.startsWith(`update "acceptance_sweeps" set "report_id" = $1`)) return null;
  const planted = text.replace(`set "report_id" = $1`, `set "report_id" = nullif($1::uuid, $1::uuid)`);
  const parsed = sentText.safeParse(args[0]);
  return [parsed.success && typeof parsed.data !== "string" ? { ...parsed.data, text: planted } : planted, ...args.slice(1)];
};

/**
 * A clean review's claim that no other model family confirmed leaves no item undecided
 * (SuiteReviewJudgementRepository, migration 072): an insert of undecided_items rows that names a
 * claim is sent as a statement that writes nothing, so every item it covers reads as decided by a
 * stored check in the delivered report, as when no second review was asked of a clean one. The
 * statement keeps every parameter, each read as text, so the server binds what was sent.
 */
export const unconfirmedClaimDropped: QueryPlant = (args) => {
  const text = textOf(args);
  const params = args[1];
  if (text === null || !text.startsWith(`insert into "undecided_items"`) || !Array.isArray(params)) return null;
  const shape = /^insert into "undecided_items" \(([^)]*)\) values (.*?)(?: on conflict .*)?$/s.exec(text);
  if (shape === null) return null;
  const [, columns, values] = shape;
  if (columns === undefined || values === undefined) return null;
  const at = columns.split(", ").indexOf('"claim_id"');
  if (at < 0) return null;
  // A tuple's claim_id sent as a parameter that is not null names a claim.
  const claimed = [...values.matchAll(/\(([^()]*)\)/g)].some(([, tuple]) => {
    const placeholder = tuple === undefined ? null : /^\$(\d+)$/.exec(tuple.split(", ")[at] ?? "-");
    return placeholder !== null && params[Number(placeholder[1]) - 1] !== null;
  });
  if (!claimed) return null;
  const planted = `select ${params.map((_, i) => `$${i + 1}::text`).join(", ")} where false`;
  const parsed = sentText.safeParse(args[0]);
  return [parsed.success && typeof parsed.data !== "string" ? { ...parsed.data, text: planted } : planted, ...args.slice(1)];
};
