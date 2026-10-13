import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved, OwnedPathNotAFile } from "./errors.js";
import { runHostGitObjects } from "./host-git.js";

const ENVIRONMENT_DEFINITION_PATH = "environment/environment.toml";
/** The one owned entry Ashara requires: the definition itself lives under it. */
const ENVIRONMENT_DIR = "environment/";

/** Why `path` is not a normalized repo-relative path, or null. A trailing "/" names a directory. */
function repoPathProblem(path: string): string | null {
  if (path.includes("\0")) return "contains NUL";
  if (path.startsWith("/")) return "is absolute";
  const body = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = body.split("/");
  if (segments.includes("..")) return "escapes the repository ('..')";
  if (segments.includes(".")) return "is not normalized ('.')";
  if (segments.includes("")) return "has an empty segment";
  return null;
}

const repoPath = z.string().superRefine((path, ctx) => {
  const problem = repoPathProblem(path);
  if (problem !== null) ctx.addIssue({ code: "custom", message: `${JSON.stringify(path)} ${problem}` });
});

const command = z.string().refine((text) => text.trim() !== "", "must be a non-empty command");

/** True when the owned entry `owned` contains `path` (itself, or anything under it). */
function covers(owned: string, path: string): boolean {
  return owned.endsWith("/") ? path.startsWith(owned) : path === owned || path.startsWith(`${owned}/`);
}

/** True when some owned entry contains `path`: the paths environment work may touch. */
export function ownedPathsCover(owned: readonly string[], path: string): boolean {
  return owned.some((entry) => covers(entry, path));
}

/**
 * The only directory an owned entry may name is `environment/`; every other entry is one file
 * (ADR-074 addendum 2 d64 a). Structural only: no stack is named.
 */
const ownedEntry = repoPath.superRefine((path, ctx) => {
  if (path.endsWith("/") && path !== ENVIRONMENT_DIR) {
    ctx.addIssue({
      code: "custom",
      message: `${JSON.stringify(path)} names a directory; the only owned directory is ${JSON.stringify(ENVIRONMENT_DIR)}, every other owned entry is one file`,
    });
  }
});

/** The definition's fields; DEFINITION_FIELD_RULES describes exactly these keys, so the brief cannot drift from them. */
const definitionFields = {
  owned: z
    .array(ownedEntry)
    .min(1)
    .refine((owned) => new Set(owned).size === owned.length, "owned paths must be unique")
    .refine((owned) => owned.includes(ENVIRONMENT_DIR), `owned must include ${JSON.stringify(ENVIRONMENT_DIR)}`),
  containerfile: repoPath.refine((path) => !path.endsWith("/"), "containerfile must name a file"),
  build: command,
  test: command,
};

const DEFINITION_FIELD_RULES: Readonly<Record<keyof typeof definitionFields, string>> = {
  owned:
    `array of repository paths: ${JSON.stringify(ENVIRONMENT_DIR)} (required, the one owned directory) plus individual ` +
    `files outside it (for example a dependency manifest or .gitignore), each without a trailing "/". No other ` +
    `directory can be owned: an entry that is a directory in the committed tree is refused.`,
  containerfile: "path of the container build file, inside an owned path; the image is built from the owned files only.",
  build: "shell command that builds the project; it must exit 0.",
  test:
    "shell command that proves the toolchain builds and runs; it must exit 0 within its time limit and print " +
    "non-empty output. Product behaviour is verified by the check author's checks, never by this command: it is " +
    "an owned path's, so no later task can extend it.",
};

const definitionSchema = z
  .object(definitionFields)
  .strict()
  .superRefine((definition, ctx) => {
    if (!definition.owned.some((owned) => covers(owned, definition.containerfile))) {
      ctx.addIssue({ code: "custom", path: ["containerfile"], message: "containerfile must be inside an owned path" });
    }
  });

/**
 * The definition's schema and the rules Z0 holds environment work to, as the environment role's
 * brief states them: generated from the fields above, naming no stack.
 */
export function environmentDefinitionRules(): string {
  return [
    `# The environment definition`,
    `Write ${ENVIRONMENT_DEFINITION_PATH} as TOML with exactly these top-level keys, no table and no other key:`,
    ...Object.entries(DEFINITION_FIELD_RULES).map(([field, rule]) => `- ${field}: ${rule}`),
    ``,
    `What decides this work:`,
    `- Only owned paths may be added, changed or deleted; any other path in the work is refused. Product code, its`,
    `  tests and its data are later tasks' work, not part of defining the environment.`,
    `- build, then test, run on a fresh checkout of the committed work, in a cell from the built image. Afterwards the`,
    `  checkout must be unchanged: every file build or test writes must be ignored by a committed .gitignore (then an`,
    `  owned file). Any untracked or modified file left behind is listed and refused.`,
    `- The gate passes only when build exits 0 and test exits 0 within its time limit with non-empty output: stdout`,
    `  and stderr together must hold more than whitespace. A test that exits 0 and prints nothing fails.`,
  ].join("\n");
}

/**
 * The project's environment as the platform role commits it. Ashara never interprets it: the
 * commands are the project's, run as given; nothing is defaulted or inferred.
 */
export type EnvironmentDefinition = z.infer<typeof definitionSchema>;

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parses `environment/environment.toml` text. `source` names where it was read from, for the error.
 */
export function parseEnvironmentDefinition(text: string, source: string): EnvironmentDefinition {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new EnvironmentDefinitionInvalid(source, [`invalid TOML: ${messageOf(err)}`], { cause: err });
  }
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) throw new EnvironmentDefinitionInvalid(source, issuesOf(parsed.error));
  return parsed.data;
}

const commitHash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

async function resolveCommit(gitDir: string, rev: string): Promise<string> {
  if (rev === "" || rev.startsWith("-")) {
    throw new EnvironmentVersionUnresolved(gitDir, rev, "the revision is empty or starts with '-'");
  }
  let stdout: Buffer;
  try {
    stdout = await runHostGitObjects(gitDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]);
  } catch (err) {
    throw new EnvironmentVersionUnresolved(gitDir, rev, `it does not name a commit: ${messageOf(err)}`, { cause: err });
  }
  const hash = commitHash.safeParse(stdout.toString("utf8").trim());
  if (!hash.success) throw new EnvironmentVersionUnresolved(gitDir, rev, `rev-parse printed ${JSON.stringify(stdout.toString("utf8"))}`);
  return hash.data;
}

/**
 * Reads and parses the definition as committed at `commit` (never from a work tree).
 */
export async function readEnvironmentDefinition(gitDir: string, commit: string): Promise<EnvironmentDefinition> {
  const hash = await resolveCommit(gitDir, commit);
  const source = `${hash}:${ENVIRONMENT_DEFINITION_PATH}`;
  let text: Buffer;
  try {
    text = await runHostGitObjects(gitDir, ["cat-file", "blob", source]);
  } catch (err) {
    throw new EnvironmentDefinitionInvalid(source, [`the file cannot be read at that commit: ${messageOf(err)}`], { cause: err });
  }
  return parseEnvironmentDefinition(text.toString("utf8"), source);
}

interface OwnedBlob {
  readonly mode: "100644" | "100755";
  readonly oid: string;
  readonly path: string;
}

/** What an environment version is: the owned tree's digest and the last commit that touched it. */
interface EnvironmentVersion {
  /** sha256 (hex) over the sorted `ls-tree -r` entries of the owned paths. */
  readonly version: string;
  /** The last commit at or before the requested one that touched an owned path. */
  readonly commit: string;
}

interface EnvironmentSnapshot extends EnvironmentVersion {
  /** The requested revision, resolved; the blobs are read from it. */
  readonly resolvedCommit: string;
  readonly blobs: readonly OwnedBlob[];
}

const lsTreeEntry = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t([^]+)$/;

/** @internal used by environment-build.ts */
export async function snapshotEnvironment(
  gitDir: string,
  commit: string,
  definition: EnvironmentDefinition,
): Promise<EnvironmentSnapshot> {
  const resolvedCommit = await resolveCommit(gitDir, commit);
  const fail = (reason: string, cause?: unknown): never => {
    throw new EnvironmentVersionUnresolved(gitDir, resolvedCommit, reason, cause === undefined ? undefined : { cause });
  };

  let listing: Buffer;
  try {
    listing = await runHostGitObjects(gitDir, ["ls-tree", "-r", "-z", "--full-tree", resolvedCommit, "--", ...definition.owned]);
  } catch (err) {
    return fail(`ls-tree failed: ${messageOf(err)}`, err);
  }
  const blobs: OwnedBlob[] = [];
  for (const record of listing.toString("utf8").split("\0")) {
    if (record === "") continue;
    const match = lsTreeEntry.exec(record);
    if (match === null) return fail(`unexpected ls-tree record ${JSON.stringify(record)}`);
    const [, mode, type, oid, path] = match;
    if (mode === undefined || type === undefined || oid === undefined || path === undefined) {
      return fail(`unexpected ls-tree record ${JSON.stringify(record)}`);
    }
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      // A submodule's content is not in this repository and a symlink's target is outside the
      // owned set: neither can be part of a build context made of owned files only.
      return fail(`owned entry ${JSON.stringify(path)} is a ${type} with mode ${mode}; only regular files can be owned`);
    }
    const problem = repoPathProblem(path);
    if (problem !== null) return fail(`owned entry ${JSON.stringify(path)} ${problem}`);
    blobs.push({ mode, oid, path });
  }
  for (const owned of definition.owned) {
    if (owned.endsWith("/")) continue;
    const inside = blobs.find((blob) => blob.path.startsWith(`${owned}/`));
    if (inside !== undefined) throw new OwnedPathNotAFile(gitDir, resolvedCommit, owned, inside.path);
  }
  const unmatched = definition.owned.filter((owned) => !blobs.some((blob) => covers(owned, blob.path)));
  if (unmatched.length > 0) return fail(`owned path(s) ${JSON.stringify(unmatched)} match no file at this commit`);
  if (!blobs.some((blob) => blob.path === definition.containerfile)) {
    return fail(`containerfile ${JSON.stringify(definition.containerfile)} is not a file at this commit`);
  }

  blobs.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const digest = createHash("sha256");
  for (const blob of blobs) digest.update(`${blob.mode} blob ${blob.oid}\t${blob.path}\0`);

  let lastTouch: Buffer;
  try {
    lastTouch = await runHostGitObjects(gitDir, ["log", "-1", "--format=%H", resolvedCommit, "--", ...definition.owned]);
  } catch (err) {
    return fail(`log failed: ${messageOf(err)}`, err);
  }
  const touched = commitHash.safeParse(lastTouch.toString("utf8").trim());
  if (!touched.success) return fail(`no commit touching the owned paths: log printed ${JSON.stringify(lastTouch.toString("utf8"))}`);

  return { version: digest.digest("hex"), commit: touched.data, resolvedCommit, blobs };
}

/**
 * The environment version at `commit`: unchanged by commits that touch no owned path.
 */
export async function environmentVersion(
  gitDir: string,
  commit: string,
  definition: EnvironmentDefinition,
): Promise<EnvironmentVersion> {
  const snapshot = await snapshotEnvironment(gitDir, commit, definition);
  return { version: snapshot.version, commit: snapshot.commit };
}

/**
 * Writes exactly the snapshot's blobs under `dir` (which must be empty): the build context holds
 * owned files only, never a work-tree file or anything else in the repository.
 * @internal used by environment-build.ts
 */
export async function materializeSnapshot(gitDir: string, snapshot: EnvironmentSnapshot, dir: string): Promise<void> {
  for (const blob of snapshot.blobs) {
    const target = join(dir, blob.path);
    const fromDir = relative(dir, target);
    if (fromDir === "" || fromDir.startsWith(`..${sep}`) || fromDir === "..") {
      throw new EnvironmentVersionUnresolved(gitDir, snapshot.resolvedCommit, `owned entry ${JSON.stringify(blob.path)} leaves the build context`);
    }
    const content = await runHostGitObjects(gitDir, ["cat-file", "blob", blob.oid]);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: blob.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
  }
}
