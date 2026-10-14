import { z } from "zod";
import type { QueryPlant } from "./faults.js";

/**
 * Plants on what the client is told (I4): each rewrites one report as production posts it, at the
 * database seam, so the run must name the report against its records. A plant that matches nothing
 * plants nothing, and its test then fails for the run that should have caught it.
 */

const sentText = z.union([z.string(), z.object({ text: z.string() }).loose()]);

function textOf(args: readonly unknown[]): string | null {
  const parsed = sentText.safeParse(args[0]);
  if (!parsed.success) return null;
  return typeof parsed.data === "string" ? parsed.data : parsed.data.text;
}

/** Rewrites the body of an outbound report whose text `matches`, where drizzle sends it as a parameter. */
function rewriteReport(matches: (body: string) => boolean, rewrite: (body: string) => string): QueryPlant {
  return (args) => {
    const text = textOf(args);
    const params = args[1];
    if (text === null || !text.startsWith(`insert into "client_messages"`) || !Array.isArray(params)) return [...args];
    const rewritten: unknown[] = params.map((param: unknown) => (typeof param === "string" && matches(param) ? rewrite(param) : param));
    return [args[0], rewritten, ...args.slice(2)];
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

/** A halt report that states a fixed cause, chosen by nothing that happened (M2 trial M3's defect). */
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

/** A delivered report that leaves out the first asked-for item no acceptance line cites (W11c D3's list). */
export const deliveredReportOmitsUncovered = rewriteReport(
  (body) => body.startsWith("Your project is delivered."),
  (body) => dropFirstNamed(body, UNCOVERED_HEAD, "- "),
);

/** The delivered report is posted but its sweep never records it, so it is due, and posted, again. */
export const deliveredReportUnrecorded: QueryPlant = (args) => {
  const text = textOf(args);
  if (text === null || !text.startsWith(`update "acceptance_sweeps" set "report_id" = $1`)) return [...args];
  const planted = text.replace(`set "report_id" = $1`, `set "report_id" = nullif($1::uuid, $1::uuid)`);
  const parsed = sentText.safeParse(args[0]);
  return [parsed.success && typeof parsed.data !== "string" ? { ...parsed.data, text: planted } : planted, ...args.slice(1)];
};
