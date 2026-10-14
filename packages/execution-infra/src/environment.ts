import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved } from "./errors.js";
import { runHostGitObjects } from "./host-git.js";

/** Where the definition lives; it is always part of the recipe. */
export const ENVIRONMENT_DEFINITION_PATH = "environment/environment.toml";
/** Every recipe file lives under it; nothing else about it is special (ADR-074 addendum 2 d72). */
const ENVIRONMENT_DIR = "environment/";

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

const command = z.string().refine((text) => text.trim() !== "", "must be a non-empty command");

/** The definition's fields; DEFINITION_FIELD_RULES describes exactly these keys, so the brief cannot drift from them. */
const definitionFields = {
  containerfile: recipeFile,
  recipe: uniqueFiles(recipeFile, "recipe files"),
  inputs: uniqueFiles(filePath, "inputs"),
  probe: command,
  build: command,
  test: command,
};

const DEFINITION_FIELD_RULES: Readonly<Record<keyof typeof definitionFields, string>> = {
  containerfile: `path of the container build file, a file under ${JSON.stringify(ENVIRONMENT_DIR)}. It is part of the recipe.`,
  recipe:
    `array of the other files under ${JSON.stringify(ENVIRONMENT_DIR)} the image build reads (scripts, configuration), ` +
    `possibly empty. The recipe is ${ENVIRONMENT_DEFINITION_PATH}, the containerfile and these files: only environment ` +
    `work may change them, and environment work may change nothing else.`,
  inputs:
    `array of product files the image build also reads, for example the product's dependency manifests, possibly ` +
    `empty. They are the product's: an input need not exist yet, and the build context holds only the recipe and the ` +
    `inputs that exist, so the containerfile must build while any input is still absent. Any task ` +
    `may change one, and a merge that changes one builds the image again and must pass the product's build, test and ` +
    `checks on it. Never name the product's source, its tests or its data here.`,
  probe:
    "shell command that proves the toolchain is present and runs; it must exit 0 within its time limit and print " +
    "non-empty output. It runs in a cell from the built image on a checkout that may hold no product at all, so it " +
    "must not build or test the product.",
  build:
    "shell command that builds the product from the repository root once the product exists; it must exit 0. It is " +
    "not run when the environment is defined: the product's first task sets up its layout so that it passes, and it " +
    "runs after every later merge.",
  test:
    "shell command that runs the product's tests from the repository root once the product exists; it must exit 0 and " +
    "print non-empty output. Like build, it is not run when the environment is defined.",
};

const definitionSchema = z
  .object(definitionFields)
  .strict()
  .superRefine((definition, ctx) => {
    if (definition.recipe.includes(definition.containerfile)) {
      ctx.addIssue({ code: "custom", path: ["recipe"], message: "the containerfile is already part of the recipe; list it only as containerfile" });
    }
    const recipe = new Set([ENVIRONMENT_DEFINITION_PATH, definition.containerfile, ...definition.recipe]);
    const overlap = definition.inputs.filter((path) => recipe.has(path));
    if (overlap.length > 0) {
      ctx.addIssue({ code: "custom", path: ["inputs"], message: `recipe files cannot also be inputs: ${JSON.stringify(overlap)}` });
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
    `- Only recipe files may be added, changed or deleted; any other path in the work is refused. The product's`,
    `  code, its manifests, its tests and its data are the product's tasks' work, never part of the environment.`,
    `- The image is built from the recipe and the inputs that exist. Then probe runs in a cell from that image on a`,
    `  fresh checkout of the committed work. The gate passes only when the image builds and probe exits 0 within its`,
    `  time limit with non-empty output: stdout and stderr together must hold more than whitespace.`,
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


/**
 * Parses `environment/environment.toml` text. `source` names where it was read from, for the error.
 */
export function parseEnvironmentDefinition(text: string, source: string): EnvironmentDefinition {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new EnvironmentDefinitionInvalid(source, [`invalid TOML: ${describeErrorChain(err)}`], { cause: err });
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
    throw new EnvironmentVersionUnresolved(gitDir, rev, `it does not name a commit: ${describeErrorChain(err)}`, { cause: err });
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
    throw new EnvironmentDefinitionInvalid(source, [`the file cannot be read at that commit: ${describeErrorChain(err)}`], { cause: err });
  }
  return parseEnvironmentDefinition(text.toString("utf8"), source);
}

/**
 * The recipe: the definition, its containerfile and the recipe files it names. Only environment work
 * changes them (ADR-074 addendum 2 d72 B1), and environment work changes nothing else.
 */
export function recipePaths(definition: EnvironmentDefinition): readonly string[] {
  return [ENVIRONMENT_DEFINITION_PATH, definition.containerfile, ...definition.recipe];
}

/**
 * Everything the image build reads: the recipe and the inputs. The environment version is the digest
 * of exactly these files, so a merge that changes any of them moves the version (d72 B3).
 */
export function buildContextPaths(definition: EnvironmentDefinition): readonly string[] {
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
  definition: EnvironmentDefinition,
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
  definition: EnvironmentDefinition,
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
