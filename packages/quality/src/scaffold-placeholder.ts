import { runHostGit, targetRepo } from "@ashara/execution-infra";
import { describeErrorChain } from "@ashara/shared";
import { PUBLIC_INTERFACE_FILE } from "./public-interface.js";

/**
 * The token every refusal of the product scaffold's placeholder carries. Ashara's own convention,
 * the same for every product and language: an id-like token no product's own text uses, so finding
 * its bytes anywhere on main says an entry still answers with the scaffold's refusal. A refusal
 * without it is indistinguishable from the product's own errors, and its absence would read as done.
 */
export const SCAFFOLD_PLACEHOLDER_MARKER = "ashara-scaffold-refusal-7c41e09d";

/** One place main still carries the marker: the tracked file, and the 1-based line it is on. */
export interface PlaceholderMarkerHit {
  readonly file: string;
  readonly line: number;
}

/** Main searched for the marker, with every place it still holds it, or not searched (a sweep not for acceptance). */
export type PlaceholderStanding =
  | { readonly kind: "not-searched" }
  | { readonly kind: "searched"; readonly hits: readonly PlaceholderMarkerHit[] };

/** A commit handed to the search that is not a commit id: it is never handed to git. */
class MarkerCommitInvalid extends Error {
  constructor(readonly commit: string) {
    super(`${JSON.stringify(commit)} is not a commit id; ${SCAFFOLD_PLACEHOLDER_MARKER} is not searched for at it`);
    this.name = "MarkerCommitInvalid";
  }
}

/** git grep printed output that is not one record per match in the form asked for. */
class MarkerSearchUnreadable extends Error {
  constructor(
    readonly commit: string,
    readonly unread: string,
  ) {
    super(`git grep for ${SCAFFOLD_PLACEHOLDER_MARKER} at ${commit} printed ${JSON.stringify(unread.slice(0, 200))}, not a match record`);
    this.name = "MarkerSearchUnreadable";
  }
}

/** git grep failed for a reason other than finding nothing. */
class MarkerSearchFailed extends Error {
  constructor(
    readonly commit: string,
    options: { readonly cause: unknown },
  ) {
    super(`git grep for ${SCAFFOLD_PLACEHOLDER_MARKER} at ${commit} failed: ${describeErrorChain(options.cause)}`, { cause: options.cause });
    this.name = "MarkerSearchFailed";
  }
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/** execFile's rejection carries the exit status as a number `code` and the child's stderr as a string. */
function exitOf(e: unknown): { readonly code: number | null; readonly stderr: string | null } {
  if (typeof e !== "object" || e === null) return { code: null, stderr: null };
  return {
    code: "code" in e && typeof e.code === "number" ? e.code : null,
    stderr: "stderr" in e && typeof e.stderr === "string" ? e.stderr : null,
  };
}

/**
 * Every tracked file and line of `commit`'s tree that holds the placeholder marker, as plain bytes,
 * in path order, each line once. Binary files are searched as text: a built placeholder committed to
 * main refuses just the same, so its bytes count. No match is the empty list; any other failure of
 * git throws, never reading as a clean main.
 */
export async function placeholderMarkersAt(targetProjectPath: string, commit: string): Promise<PlaceholderMarkerHit[]> {
  if (!COMMIT_ID.test(commit)) throw new MarkerCommitInvalid(commit);
  let printed: string;
  try {
    const { stdout } = await runHostGit(targetRepo(targetProjectPath), [
      "grep", "--text", "--line-number", "--only-matching", "--null", "--fixed-strings", "-e", SCAFFOLD_PLACEHOLDER_MARKER, commit,
    ]);
    printed = stdout;
  } catch (e) {
    const { code, stderr } = exitOf(e);
    if (code === 1 && stderr?.trim() === "") return [];
    throw new MarkerSearchFailed(commit, { cause: e });
  }
  return parseMatches(commit, printed);
}

/** `<commit>:<path>\0<line>\0<marker>\n` per match: --null keeps any byte of a path, a newline included, inside its record. */
function parseMatches(commit: string, printed: string): PlaceholderMarkerHit[] {
  const record = new RegExp(`${commit}:([^\\0]*)\\0([1-9][0-9]*)\\0${SCAFFOLD_PLACEHOLDER_MARKER}\\n`, "y");
  const hits: PlaceholderMarkerHit[] = [];
  const seen = new Set<string>();
  while (record.lastIndex < printed.length) {
    const at = record.lastIndex;
    const match = record.exec(printed);
    const file = match?.[1];
    const line = match?.[2];
    if (file === undefined || line === undefined) throw new MarkerSearchUnreadable(commit, printed.slice(at));
    const key = `${file}\0${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ file, line: Number(line) });
  }
  return hits;
}

/**
 * What the sweep's details say of a main that still carries the marker: each file:line, and that
 * the entries refused there are not delivered. Null when main carries none.
 */
export function placeholderDefectLine(hits: readonly PlaceholderMarkerHit[]): string | null {
  if (hits.length === 0) return null;
  const where = hits.map((hit) => `${hit.file}:${hit.line}`).join(", ");
  return (
    `The product scaffold's placeholder refusal (marked ${SCAFFOLD_PLACEHOLDER_MARKER}) is still on main at ${where}: ` +
    "every entry that answers with it is not delivered. Implement each such entry and remove the marker."
  );
}

/**
 * Why the product scaffold's merge is refused for carrying no marked refusal, or null when a
 * product file holds the marker. The interface file does not count: it describes the product and
 * refuses nothing. A scaffold whose refusals lack the marker would make every later sweep read its
 * surviving placeholder as a delivered product, so its absence fails the scaffold, never passes it.
 */
export function scaffoldUnmarkedLine(hits: readonly PlaceholderMarkerHit[]): string | null {
  if (hits.some((hit) => hit.file !== PUBLIC_INTERFACE_FILE)) return null;
  return (
    `The product scaffold's merge holds no placeholder refusal marked ${SCAFFOLD_PLACEHOLDER_MARKER} in any tracked file ` +
    `(${PUBLIC_INTERFACE_FILE} does not count): every refusal of its placeholder must carry that exact text, so the ` +
    "acceptance of the product can tell an entry still refused from one delivered."
  );
}
