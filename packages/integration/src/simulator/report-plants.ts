import { z } from "zod";
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

const UNCOVERED_HEAD = "These items of what you asked for are named by no acceptance criterion";

/** A delivered report that leaves out the first asked-for item no acceptance line cites. */
export const deliveredReportOmitsUncovered = rewriteReport(
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
 * states is not the one of the vision it carries. The
 * stand-ins' one assumption is asked about, and every brief carries it among its assumptions; no
 * stand-in task's text lists it (the stand-ins' plan cites scope lines only, and the suite review is
 * a structured call with no brief), so text-facts.test.ts holds the assumption-line clause.
 */
export const briefMisstatesStanding = rewriteInsert("dev_sessions", (param) => param.replaceAll(`"note":"Inferred; asked of the client, not yet answered;`, `"note":"Stated by the client;`));

/** A delivered report that says the client was told of an assumption it asked them about. */
export const deliveredReportMisstatesStanding = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) => body.replaceAll("Ashara's assumption, which you were asked about and have not answered:", "Ashara's assumption, which was reported to you:"),
);

/**
 * A delivered report whose how-to-run section is not main's: the quoted interface names another command, or, where
 * main holds no interface file, the report says it is empty instead of saying there is none.
 */
export const deliveredReportMisquotesInterface = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) =>
    body.includes("Run: sim <behaviour>")
      ? body.replace("Run: sim <behaviour>", "Run: tally <behaviour>")
      : body.replace("it has no public interface file.", "its public interface file is empty."),
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
