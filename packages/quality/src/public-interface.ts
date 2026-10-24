import { runHostGit, targetRepo } from "@ashara/execution-infra";

/**
 * Where the product scaffold writes down the product's public interface, which every check author
 * and the suite review read. Ashara's own convention, the same for every
 * product; what the interface is, is the product's.
 */
export const PUBLIC_INTERFACE_FILE = "PUBLIC_INTERFACE.md";

/** A Completed product scaffold of a project, with the merge on main its completion recorded. */
export interface ScaffoldMerge {
  readonly taskId: string;
  readonly mergeCommit: string;
}

/**
 * The public interface file on main against the one the product scaffold wrote: present and not
 * the scaffold's placeholder, compared and byte for byte the scaffold's, absent from main (so main
 * describes no interface at all), or not compared because the sweep stopped before it.
 * "not-placeholder" says only that the bytes differ from every scaffold's: no entry of the file is
 * run, so it is no evidence that the file describes the delivered product. What the delivered
 * report presents as verified is only what acceptance's stored checks ran and saw pass.
 */
export type InterfaceStanding =
  | { readonly kind: "not-placeholder" }
  | { readonly kind: "scaffold-placeholder"; readonly file: string; readonly scaffoldTaskId: string; readonly scaffoldCommit: string }
  | { readonly kind: "absent"; readonly file: string }
  | { readonly kind: "not-compared" };

type ComparedStanding = Exclude<InterfaceStanding, { readonly kind: "not-compared" }>;

/** A commit that is not a commit id: it is never handed to git. `source` names where the value came from. */
class InterfaceCommitInvalid extends Error {
  constructor(
    readonly commit: string,
    readonly source: "recorded" | "compared",
  ) {
    super(
      source === "recorded"
        ? `the recorded commit ${JSON.stringify(commit)} (a suite's baseline or a delivered main, read back from the database) is not a commit id; ${PUBLIC_INTERFACE_FILE} is not read at it`
        : `the commit ${JSON.stringify(commit)} handed to the interface comparison is not a commit id; ${PUBLIC_INTERFACE_FILE} is not read at it`,
    );
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

/** The product's public interface as it stood at one commit of the target checkout. */
export type PublicInterface = { readonly kind: "present"; readonly text: string } | { readonly kind: "absent" };

/** Reads PUBLIC_INTERFACE.md at a commit of the project's target checkout. */
export interface PublicInterfaceReader {
  at(targetProjectPath: string, commit: string): Promise<PublicInterface>;
}

/** The target checkout's git: absent when the commit's tree holds no such file; any git failure throws. */
export const gitPublicInterface: PublicInterfaceReader = {
  async at(targetProjectPath, commit) {
    if (!COMMIT_ID.test(commit)) throw new InterfaceCommitInvalid(commit, "recorded");
    const repo = targetRepo(targetProjectPath);
    const { stdout: listed } = await runHostGit(repo, ["ls-tree", "--name-only", commit, "--", PUBLIC_INTERFACE_FILE]);
    if (listed.trim() === "") return { kind: "absent" };
    const { stdout: text } = await runHostGit(repo, ["show", `${commit}:${PUBLIC_INTERFACE_FILE}`]);
    return { kind: "present", text };
  },
};

/** The blob id of the public interface file in `commit`'s tree, or null when that tree holds none. */
async function interfaceBlobAt(targetProjectPath: string, commit: string): Promise<string | null> {
  if (!COMMIT_ID.test(commit)) throw new InterfaceCommitInvalid(commit, "compared");
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
 * file states no interface. Any other file is "not-placeholder", whatever it says: a one-byte edit
 * passes this test, so it verifies nothing, and the delivered report quotes the file as unverified.
 * Scaffolds that wrote none hold nothing of a scaffold's.
 */
export async function interfaceStandingOnMain(targetProjectPath: string, main: string, scaffolds: readonly ScaffoldMerge[]): Promise<ComparedStanding> {
  const onMain = await interfaceBlobAt(targetProjectPath, main);
  if (onMain === null) return { kind: "absent", file: PUBLIC_INTERFACE_FILE };
  for (const scaffold of scaffolds) {
    if ((await interfaceBlobAt(targetProjectPath, scaffold.mergeCommit)) === onMain) {
      return { kind: "scaffold-placeholder", file: PUBLIC_INTERFACE_FILE, scaffoldTaskId: scaffold.taskId, scaffoldCommit: scaffold.mergeCommit };
    }
  }
  return { kind: "not-placeholder" };
}

/**
 * What the sweep's details say first of a main whose public interface fails it; null when main's is
 * not a scaffold's placeholder, which refuses nothing and verifies nothing of what the file says.
 */
export function interfaceDefectLine(standing: ComparedStanding): string | null {
  switch (standing.kind) {
    case "not-placeholder":
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
