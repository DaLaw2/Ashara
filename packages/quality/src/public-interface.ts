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
  readonly mergeCommit: string;
}

/**
 * The public interface file on main against the one the product scaffold wrote: compared and
 * changed since, compared and byte for byte the scaffold's, absent from main (so main describes no
 * interface at all), or not compared because the sweep stopped before it.
 */
export type InterfaceStanding =
  | { readonly kind: "described" }
  | { readonly kind: "scaffold-placeholder"; readonly file: string; readonly scaffoldTaskId: string; readonly scaffoldCommit: string }
  | { readonly kind: "absent"; readonly file: string }
  | { readonly kind: "not-compared" };

type ComparedStanding = Exclude<InterfaceStanding, { readonly kind: "not-compared" }>;

/** A commit handed to the comparison that is not a commit id: it is never handed to git. */
class InterfaceCommitInvalid extends Error {
  constructor(readonly commit: string) {
    super(`${JSON.stringify(commit)} is not a commit id; ${PUBLIC_INTERFACE_FILE} is not read at it`);
    this.name = "InterfaceCommitInvalid";
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
 * Whether main holds the public interface file, and whether exactly as a product scaffold of the
 * project wrote it: then it describes the scaffold's placeholder, not the delivered product. Byte
 * identity is the test (the blob ids), so no wording of any product is read. A main with no such
 * file states no interface, which is never read as described. Scaffolds that wrote none hold
 * nothing of a scaffold's.
 */
export async function interfaceStandingOnMain(targetProjectPath: string, main: string, scaffolds: readonly ScaffoldMerge[]): Promise<ComparedStanding> {
  const onMain = await interfaceBlobAt(targetProjectPath, main);
  if (onMain === null) return { kind: "absent", file: PUBLIC_INTERFACE_FILE };
  for (const scaffold of scaffolds) {
    if ((await interfaceBlobAt(targetProjectPath, scaffold.mergeCommit)) === onMain) {
      return { kind: "scaffold-placeholder", file: PUBLIC_INTERFACE_FILE, scaffoldTaskId: scaffold.taskId, scaffoldCommit: scaffold.mergeCommit };
    }
  }
  return { kind: "described" };
}

/** What the sweep's details say first of a main whose public interface fails it; null when main's describes the product. */
export function interfaceDefectLine(standing: ComparedStanding): string | null {
  switch (standing.kind) {
    case "described":
      return null;
    case "absent":
      return (
        `${standing.file} is missing from main: no file states the delivered product's public interface. ` +
        `Restore ${standing.file} so it states how the delivered product is started, configured and called.`
      );
    case "scaffold-placeholder":
      return (
        `${standing.file} on main is byte-identical to the one the product scaffold wrote (task ${standing.scaffoldTaskId}, ` +
        `merged as ${standing.scaffoldCommit}): it describes the scaffold's placeholder, not the delivered product. ` +
        `Update ${standing.file} so it states how the delivered product is started, configured and called.`
      );
  }
}
