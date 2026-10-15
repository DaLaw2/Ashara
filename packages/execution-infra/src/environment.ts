import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved } from "./errors.js";
import { runHostGitObjects } from "./host-git.js";

// The environment definition is the platform role's work product in the repository; Execution
// Infrastructure owns only its build context (ADR-075 §5): the recipe and the inputs the image is
// built from, and the version that is their digest. The definition's commands, and the parse of
// the whole file, are Quality's, which runs them.

/** Where the definition lives; it is always part of the recipe. */
export const ENVIRONMENT_DEFINITION_PATH = "environment/environment.toml";
/** Every recipe file lives under it; nothing else about it is special (ADR-074 addendum 2 d72). */
export const ENVIRONMENT_DIR = "environment/";

/** Why `path` is not a normalized repo-relative file path, or null. */
function filePathProblem(path: string): string | null {
  if (path.includes("\0")) return "contains NUL";
  if (path.startsWith("/")) return "is absolute";
  if (path.endsWith("/")) return "names a directory; name each file";
  const segments = path.split("/");
  if (segments.includes("..")) return "escapes the repository ('..')";
  if (segments.includes(".")) return "is not normalized ('.')";
  if (segments.includes("")) return "has an empty segment";
  return null;
}

const filePath = z.string().superRefine((path, ctx) => {
  const problem = filePathProblem(path);
  if (problem !== null) ctx.addIssue({ code: "custom", message: `${JSON.stringify(path)} ${problem}` });
});

/** A file of the recipe: under `environment/`, so naming one can never fence the product's files. */
const recipeFile = filePath.superRefine((path, ctx) => {
  if (!path.startsWith(ENVIRONMENT_DIR) || path === ENVIRONMENT_DEFINITION_PATH) {
    ctx.addIssue({
      code: "custom",
      message: `${JSON.stringify(path)} must be a file under ${JSON.stringify(ENVIRONMENT_DIR)} other than the definition itself`,
    });
  }
});

const uniqueFiles = <T extends z.ZodType<string>>(entry: T, what: string) =>
  z.array(entry).refine((paths) => new Set(paths).size === paths.length, `${what} must be unique`);

/** The definition's build-context fields: what the image is built from. */
export const buildContextFields = {
  containerfile: recipeFile,
  recipe: uniqueFiles(recipeFile, "recipe files"),
  inputs: uniqueFiles(filePath, "inputs"),
};

/** The build context of an environment definition: the recipe and the product files the image build reads. */
export interface EnvironmentBuildContext {
  readonly containerfile: string;
  readonly recipe: readonly string[];
  readonly inputs: readonly string[];
}

/** The build context's rules across its fields, for the definition's schema to refine with. */
export function refineBuildContext(definition: EnvironmentBuildContext, ctx: z.RefinementCtx): void {
  if (definition.recipe.includes(definition.containerfile)) {
    ctx.addIssue({ code: "custom", path: ["recipe"], message: "the containerfile is already part of the recipe; list it only as containerfile" });
  }
  const recipe = new Set([ENVIRONMENT_DEFINITION_PATH, definition.containerfile, ...definition.recipe]);
  const overlap = definition.inputs.filter((path) => recipe.has(path));
  if (overlap.length > 0) {
    ctx.addIssue({ code: "custom", path: ["inputs"], message: `recipe files cannot also be inputs: ${JSON.stringify(overlap)}` });
  }
}

/**
 * Reads the definition committed at a commit and parses it with its owner's schema; the
 * composition passes Quality's, so a definition is parsed once, whole.
 */
export type EnvironmentDefinitionReader<D extends EnvironmentBuildContext> = (gitDir: string, commit: string) => Promise<D>;

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/**
 * Parses `environment/environment.toml` text with `schema`. `source` names where it was read from, for the error.
 */
export function parseEnvironmentFile<D>(text: string, source: string, schema: z.ZodType<D>): D {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new EnvironmentDefinitionInvalid(source, [`invalid TOML: ${describeErrorChain(err)}`], { cause: err });
  }
  const parsed = schema.safeParse(raw);
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
    throw new EnvironmentVersionUnresolved(gitDir, rev, `it does not name a commit: ${describeErrorChain(err)}`, { cause: err });
  }
  const hash = commitHash.safeParse(stdout.toString("utf8").trim());
  if (!hash.success) throw new EnvironmentVersionUnresolved(gitDir, rev, `rev-parse printed ${JSON.stringify(stdout.toString("utf8"))}`);
  return hash.data;
}

/**
 * Reads the definition as committed at `commit` (never from a work tree) and parses it with `schema`.
 */
export async function readEnvironmentFile<D>(gitDir: string, commit: string, schema: z.ZodType<D>): Promise<D> {
  const hash = await resolveCommit(gitDir, commit);
  const source = `${hash}:${ENVIRONMENT_DEFINITION_PATH}`;
  let text: Buffer;
  try {
    text = await runHostGitObjects(gitDir, ["cat-file", "blob", source]);
  } catch (err) {
    throw new EnvironmentDefinitionInvalid(source, [`the file cannot be read at that commit: ${describeErrorChain(err)}`], { cause: err });
  }
  return parseEnvironmentFile(text.toString("utf8"), source, schema);
}

/**
 * The recipe: the definition, its containerfile and the recipe files it names. Only environment work
 * changes them (ADR-074 addendum 2 d72 B1), and environment work changes nothing else.
 */
export function recipePaths(definition: EnvironmentBuildContext): readonly string[] {
  return [ENVIRONMENT_DEFINITION_PATH, definition.containerfile, ...definition.recipe];
}

/**
 * Everything the image build reads: the recipe and the inputs. The environment version is the digest
 * of exactly these files, so a merge that changes any of them moves the version (d72 B3).
 */
export function buildContextPaths(definition: EnvironmentBuildContext): readonly string[] {
  return [...recipePaths(definition), ...definition.inputs];
}

interface ContextBlob {
  readonly mode: "100644" | "100755";
  readonly oid: string;
  readonly path: string;
}

/** What an environment version is: the build context's digest and the last commit that touched it. */
interface EnvironmentVersion {
  /** sha256 (hex) over the sorted `ls-tree -r` entries of the build context's files. */
  readonly version: string;
  /** The last commit at or before the requested one that touched a build context path. */
  readonly commit: string;
}

interface EnvironmentSnapshot extends EnvironmentVersion {
  /** The requested revision, resolved; the blobs are read from it. */
  readonly resolvedCommit: string;
  readonly blobs: readonly ContextBlob[];
}

const lsTreeEntry = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t([^]+)$/;

/**
 * The build context at `commit`: every recipe file must be a regular file there; an input may be
 * absent (the product has not written it yet) but never a directory, a link or a submodule.
 * @internal used by environment-build.ts
 */
export async function snapshotEnvironment(
  gitDir: string,
  commit: string,
  definition: EnvironmentBuildContext,
): Promise<EnvironmentSnapshot> {
  const resolvedCommit = await resolveCommit(gitDir, commit);
  const fail = (reason: string, cause?: unknown): never => {
    throw new EnvironmentVersionUnresolved(gitDir, resolvedCommit, reason, cause === undefined ? undefined : { cause });
  };
  const paths = buildContextPaths(definition);

  let listing: Buffer;
  try {
    listing = await runHostGitObjects(gitDir, ["ls-tree", "-r", "-z", "--full-tree", resolvedCommit, "--", ...paths]);
  } catch (err) {
    return fail(`ls-tree failed: ${describeErrorChain(err)}`, err);
  }
  const blobs: ContextBlob[] = [];
  for (const record of listing.toString("utf8").split("\0")) {
    if (record === "") continue;
    const match = lsTreeEntry.exec(record);
    if (match === null) return fail(`unexpected ls-tree record ${JSON.stringify(record)}`);
    const [, mode, type, oid, path] = match;
    if (mode === undefined || type === undefined || oid === undefined || path === undefined) {
      return fail(`unexpected ls-tree record ${JSON.stringify(record)}`);
    }
    if (!paths.includes(path)) {
      // ls-tree lists a directory's files under its name: a named file that is a directory here.
      const named = paths.find((entry) => path.startsWith(`${entry}/`)) ?? path;
      return fail(
        `build context entry ${JSON.stringify(named)} is a directory at this commit (it holds ${JSON.stringify(path)}); every entry must be one file`,
      );
    }
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      // A submodule's content is not in this repository and a symlink's target is outside the
      // build context: neither can be part of it.
      return fail(`build context entry ${JSON.stringify(path)} is a ${type} with mode ${mode}; only regular files can be built from`);
    }
    blobs.push({ mode, oid, path });
  }
  const missing = recipePaths(definition).filter((path) => !blobs.some((blob) => blob.path === path));
  if (missing.length > 0) return fail(`recipe file(s) ${JSON.stringify(missing)} are not files at this commit`);

  blobs.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const digest = createHash("sha256");
  for (const blob of blobs) digest.update(`${blob.mode} blob ${blob.oid}\t${blob.path}\0`);

  let lastTouch: Buffer;
  try {
    lastTouch = await runHostGitObjects(gitDir, ["log", "-1", "--format=%H", resolvedCommit, "--", ...paths]);
  } catch (err) {
    return fail(`log failed: ${describeErrorChain(err)}`, err);
  }
  const touched = commitHash.safeParse(lastTouch.toString("utf8").trim());
  if (!touched.success) return fail(`no commit touching the build context: log printed ${JSON.stringify(lastTouch.toString("utf8"))}`);

  return { version: digest.digest("hex"), commit: touched.data, resolvedCommit, blobs };
}

/**
 * The environment version at `commit`: unchanged by commits that touch no build context path.
 */
export async function environmentVersion(
  gitDir: string,
  commit: string,
  definition: EnvironmentBuildContext,
): Promise<EnvironmentVersion> {
  const snapshot = await snapshotEnvironment(gitDir, commit, definition);
  return { version: snapshot.version, commit: snapshot.commit };
}

/**
 * Writes exactly the snapshot's blobs under `dir` (which must be empty): the build context holds
 * the recipe and the existing inputs only, never a work-tree file or anything else in the repository.
 * @internal used by environment-build.ts
 */
export async function materializeSnapshot(gitDir: string, snapshot: EnvironmentSnapshot, dir: string): Promise<void> {
  for (const blob of snapshot.blobs) {
    const target = join(dir, blob.path);
    const fromDir = relative(dir, target);
    if (fromDir === "" || fromDir.startsWith(`..${sep}`) || fromDir === "..") {
      throw new EnvironmentVersionUnresolved(gitDir, snapshot.resolvedCommit, `build context entry ${JSON.stringify(blob.path)} leaves the build context`);
    }
    const content = await runHostGitObjects(gitDir, ["cat-file", "blob", blob.oid]);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: blob.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
  }
}
