import { PUBLIC_INTERFACE_PATH } from "../product.js";

// Every production prompt wording a stand-in recognises, each spelled once. A stand-in may import no
// product rule (boundary-rules.toml stand-ins), so it matches the wording as text: a production change to
// one of these strings changes what a stand-in reads, and only this module needs to follow it.

/** The brief section of an attempt handed its conflict with main (Quality merge.ts formatConflictForBrief). */
export const CONFLICT_HEADING = "## Merge with main in progress";

/**
 * What a suite review prompt says when it asks a second opinion within the first review's family to
 * start from what each check cannot observe (suite-review.ts angleSection), as a model reads it.
 */
export const BLIND_SPOTS_ASKED = "work out what it cannot observe";

/** What a revision prompt for a client's correction says, as the planner reads it (replan prompts causeSection). */
export const CORRECTION_REVISION = "changed what is built after work began";

/**
 * What an honest planner reads in a repair's evidence when acceptance refused a main whose public
 * interface file is still the scaffold's: Quality's sweep states it so (verification.ts), and the
 * planner answers it with a task of its own, since no goal task's checks ask for that file.
 */
export const PLACEHOLDER_INTERFACE_EVIDENCE =
  `${PUBLIC_INTERFACE_PATH} on main is byte-identical ` + `to the one the product scaffold wrote`;

/** What the planner reads when acceptance refused a main that holds no public interface file at all. */
export const MISSING_INTERFACE_EVIDENCE = `${PUBLIC_INTERFACE_PATH} is missing from main`;

/** The heading of the correction prompt's interface entries (Engagement correction.ts correctionPrompt). */
export const INTERFACE_HEADING = "Interface:";

/** The heading of the correction prompt's assumption entries (Engagement correction.ts correctionPrompt). */
export const ASSUMPTIONS_HEADING = "Assumptions:";

/**
 * The heading of the answer prompt's entries for every assumption but the question's (Engagement answers.ts
 * buildAnswerPrompt).
 */
export const OTHER_ASSUMPTIONS_HEADING = "Other assumptions:";

/** The files a conflict section lists, `- <path>` one per line; none when the prompt has no such section. */
export function conflictFilesOf(prompt: string): string[] {
  const at = prompt.indexOf(CONFLICT_HEADING);
  if (at < 0) return [];
  const files: string[] = [];
  for (const line of prompt.slice(at + CONFLICT_HEADING.length).split("\n")) {
    if (line.startsWith("- ")) files.push(line.slice(2).trim());
    else if (files.length > 0) break;
  }
  return files;
}

/**
 * The vision items the planner's prompt says a task must cite, as an honest planner
 * reads them; none when the prompt asks for none. Reads the prompt as text or as its JSON.
 */
export function itemsToCheck(prompt: string): string[] {
  const listed = /a plan that leaves one uncited is rejected: ([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)\./.exec(
    prompt,
  )?.[1];
  return listed === undefined ? [] : listed.split(", ");
}

/** The guarantees the planner's prompt lists, each by its id with its whole line, in the prompt's order. */
export function guaranteesListed(prompt: string): Array<{ readonly id: string; readonly line: string }> {
  return [...prompt.matchAll(/^- ([A-Za-z0-9_-]+) \(guarantee[;)].*$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [{ id: match[1], line: match[0] }],
  );
}

/** Whether the revision prompt's done section lists the task titled `title` (replan prompts doneSection). */
export function listsDoneTask(prompt: string, title: string): boolean {
  return prompt.includes(`\n- ${title}`);
}

/** Whether the correction prompt lists the guarantee `id` with `statement` as its contract entry. */
export function listsGuarantee(prompt: string, id: string, statement: string): boolean {
  return prompt.includes(`- ${id}: ${statement} (`);
}

/**
 * The `- <id>: <text>` entries of the prompt's section opening with `heading`, in order; none when it has no such
 * section.
 */
export function promptEntries(prompt: string, heading: string): Array<{ readonly id: string; readonly text: string }> {
  const lines = prompt.split("\n");
  const at = lines.indexOf(heading);
  const entries: Array<{ readonly id: string; readonly text: string }> = [];
  for (const line of at < 0 ? [] : lines.slice(at + 1)) {
    const entry = /^- ([A-Za-z0-9_-]+): (.*)$/.exec(line);
    if (entry?.[1] === undefined || entry[2] === undefined) break;
    entries.push({ id: entry[1], text: entry[2] });
  }
  return entries;
}
