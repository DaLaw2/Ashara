import { runHostGit, targetRepo } from "@ashara/execution-infra";

/**
 * Where the product scaffold writes down the product's public interface, which every check author
 * and the suite review read. Ashara's own convention, the same for every
 * product; what the interface is, is the product's.
 */
export const PUBLIC_INTERFACE_FILE = "PUBLIC_INTERFACE.md";

/** A Completed product scaffold of a project, with the merge on main its completion recorded (migration 041). */
export interface ScaffoldMerge {
  readonly taskId: string;
  /** null on a scaffold whose merge is not on record: what it wrote is not known. */
  readonly mergeCommit: string | null;
}

/**
 * The public interface file on main against the one the product scaffold wrote: compared and
 * changed since (or absent from main, so nothing of the scaffold's stands), compared and byte for
 * byte the scaffold's, or not compared because the sweep stopped before it.
 */
export type InterfaceStanding =
  | { readonly kind: "described" }
  | { readonly kind: "scaffold-placeholder"; readonly file: string; readonly scaffoldTaskId: string; readonly scaffoldCommit: string }
  | { readonly kind: "not-compared" };

/** A commit handed to the comparison that is not a commit id: it is never handed to git. */
class InterfaceCommitInvalid extends Error {
  constructor(readonly commit: string) {
    super(`${JSON.stringify(commit)} is not a commit id; ${PUBLIC_INTERFACE_FILE} is not read at it`);
    this.name = "InterfaceCommitInvalid";
  }
}

/** A Completed product scaffold records no merge: what it wrote cannot be compared with main. */
class ScaffoldMergeUnrecorded extends Error {
  constructor(readonly scaffoldTaskId: string) {
    super(
      `the product scaffold ${scaffoldTaskId} is Completed with no merge commit on record, so the ${PUBLIC_INTERFACE_FILE} ` +
        `it wrote is not known and main's cannot be compared with it`,
    );
    this.name = "ScaffoldMergeUnrecorded";
  }
}

/** git listed the file at a commit in a form other than one blob entry. */
class InterfaceEntryUnreadable extends Error {
  constructor(
    readonly commit: string,
    readonly listed: string,
  ) {
    super(`git ls-tree at ${commit} listed ${PUBLIC_INTERFACE_FILE} as ${JSON.stringify(listed.slice(0, 200))}, not one blob entry`);
    this.name = "InterfaceEntryUnreadable";
  }
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/;
const BLOB_ENTRY = /^\d{6} blob ([0-9a-f]{40,64})\t/;

/** The blob id of the public interface file in `commit`'s tree, or null when that tree holds none. */
async function interfaceBlobAt(targetProjectPath: string, commit: string): Promise<string | null> {
  if (!COMMIT_ID.test(commit)) throw new InterfaceCommitInvalid(commit);
  const { stdout } = await runHostGit(targetRepo(targetProjectPath), ["ls-tree", commit, "--", PUBLIC_INTERFACE_FILE]);
  const listed = stdout.trim();
  if (listed === "") return null;
  const blob = BLOB_ENTRY.exec(listed)?.[1];
  if (blob === undefined || listed.includes("\n")) throw new InterfaceEntryUnreadable(commit, listed);
  return blob;
}

/**
 * Whether main still holds the public interface file exactly as a product scaffold of the project
 * wrote it: then it describes the scaffold's placeholder, not the delivered product. Byte identity
 * is the test (the blob ids), so no wording of any product is read. A main with no such file, or
 * scaffolds that wrote none, hold nothing of a scaffold's. A scaffold with no merge on record
 * throws: what it wrote is unknown, never read as different.
 */
export async function interfaceStandingOnMain(
  targetProjectPath: string,
  main: string,
  scaffolds: readonly ScaffoldMerge[],
): Promise<Exclude<InterfaceStanding, { readonly kind: "not-compared" }>> {
  const recorded: Array<{ readonly taskId: string; readonly mergeCommit: string }> = [];
  for (const scaffold of scaffolds) {
    if (scaffold.mergeCommit === null) throw new ScaffoldMergeUnrecorded(scaffold.taskId);
    recorded.push({ taskId: scaffold.taskId, mergeCommit: scaffold.mergeCommit });
  }
  const onMain = await interfaceBlobAt(targetProjectPath, main);
  if (onMain === null) return { kind: "described" };
  for (const scaffold of recorded) {
    if ((await interfaceBlobAt(targetProjectPath, scaffold.mergeCommit)) === onMain) {
      return { kind: "scaffold-placeholder", file: PUBLIC_INTERFACE_FILE, scaffoldTaskId: scaffold.taskId, scaffoldCommit: scaffold.mergeCommit };
    }
  }
  return { kind: "described" };
}

/** What the sweep's details say first of a main whose public interface file is the scaffold's. */
export function placeholderInterfaceLine(standing: Extract<InterfaceStanding, { readonly kind: "scaffold-placeholder" }>): string {
  return (
    `${standing.file} on main is byte-identical to the one the product scaffold wrote (task ${standing.scaffoldTaskId}, ` +
    `merged as ${standing.scaffoldCommit}): it describes the scaffold's placeholder, not the delivered product. ` +
    `Update ${standing.file} so it states how the delivered product is started, configured and called.`
  );
}
