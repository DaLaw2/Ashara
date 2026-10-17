import type { ProjectId } from "@ashara/shared";
import { describeErrorChain } from "@ashara/shared";
import type { BuiltEnvironment, EnvironmentBuildRequest, EnvironmentImagePrune } from "./environment-build.js";
import { environmentVersion } from "./environment.js";
import type { EnvironmentBuildContext, EnvironmentDefinitionReader } from "./environment.js";
import { EnvironmentBuildFailed, EnvironmentDefinitionInvalid, EnvironmentVersionUnresolved } from "./errors.js";
import { runHostGit } from "./host-git.js";
import type { HostRepo } from "./host-git.js";
import { targetRepo as hostRepoOf } from "./target-repo.js";

// Every task after Sprint 0 runs in cells built from the project's CURRENT environment version:
// the build context (recipe and inputs) of environment/environment.toml as committed on main. There is no
// other build path and no fallback to the BaseCell (s-platform-role-m1 C2).

const MAIN = "main";
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Builds (or reuses) the image of an environment version; the composition root wires buildEnvironmentImage. */
export interface EnvironmentImages {
  build(request: EnvironmentBuildRequest): Promise<BuiltEnvironment>;
  /** Removes the project's images of every version but `keepVersion` that no container uses; only images labelled ashara.managed are touched. */
  prune(projectId: ProjectId, keepVersion: string): Promise<EnvironmentImagePrune>;
}

/** The team's statement of the stack, read for the environment version a cell is built from. */
export interface EnvironmentStatementSource {
  /** The statement recorded for `version` in the project, or null when none was. */
  forVersion(projectId: ProjectId, version: string): Promise<string | null>;
}

/** The project's current environment: its version, the image built from it, and the team's statement. */
export interface CurrentEnvironment<D extends EnvironmentBuildContext = EnvironmentBuildContext> {
  readonly version: string;
  /** The last commit on main that touched the build context. */
  readonly commit: string;
  readonly imageId: string;
  readonly imageRef: string;
  /** Whether the image was already built for this version (no build ran). */
  readonly reused: boolean;
  /** The statement recorded with this version when the task that produced it merged. */
  readonly statement: string;
  /**
   * The definition on main: its recipe is fenced from every other role, its build context is what
   * no check file may overwrite, and its `build` and `test` run on every post-merge checkout, from
   * this image.
   */
  readonly definition: D;
}

type EnvironmentResolution<D extends EnvironmentBuildContext> =
  | { readonly kind: "current"; readonly environment: CurrentEnvironment<D> }
  /** Nothing a cell could be built from; `reason` says what is missing, for the operator. */
  | { readonly kind: "undefined"; readonly reason: string };

/** The builder reported a version other than the one resolved at the same commit. */
class EnvironmentVersionMismatch extends Error {
  constructor(
    readonly projectId: string,
    readonly commit: string,
    readonly resolved: string,
    readonly built: string,
  ) {
    super(`project ${projectId}: environment version at ${commit} resolved to ${resolved}, but the image was built for ${built}`);
    this.name = "EnvironmentVersionMismatch";
  }
}

/** main's commit, or why it cannot be read. */
async function mainCommit(repo: HostRepo): Promise<{ readonly commit: string } | { readonly problem: string }> {
  let stdout: string;
  try {
    ({ stdout } = await runHostGit(repo, ["rev-parse", "--verify", "--end-of-options", `${MAIN}^{commit}`]));
  } catch (err) {
    return { problem: `the target repository has no readable ${MAIN} branch: ${describeErrorChain(err)}` };
  }
  const hash = stdout.trim();
  return COMMIT_HASH.test(hash) ? { commit: hash } : { problem: `rev-parse ${MAIN} printed ${JSON.stringify(stdout)}` };
}

/**
 * Removes the project's environment images that main's current environment version does not use
 * and no container uses, since every build_environment call leaves one, after an environment task ends and at startup. When main
 * cannot be read, or its environment cannot be resolved (read by `readDefinition`, the definition's
 * owner's parse), nothing is removed: which version is current is unknown. Cleanup never fails its caller: any failure is logged at warn, and the
 * next environment task's end or startup tries again.
 */
export async function pruneStaleEnvironmentImages(
  projectId: ProjectId,
  targetProjectPath: string,
  images: Pick<EnvironmentImages, "prune">,
  readDefinition: EnvironmentDefinitionReader<EnvironmentBuildContext>,
): Promise<void> {
  try {
    const repo = hostRepoOf(targetProjectPath);
    const main = await mainCommit(repo);
    if ("problem" in main) {
      console.warn(`[environment-images] project ${projectId}: not pruned, the current version is unknown: ${main.problem}`);
      return;
    }
    let keep: string;
    try {
      const definition = await readDefinition(repo.gitDir, main.commit);
      keep = (await environmentVersion(repo.gitDir, main.commit, definition)).version;
    } catch (err) {
      if (!(err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved)) throw err;
      // Both classes also carry transient git failures (an unreadable file, a failed ls-tree), so an
      // unresolved environment is not evidence that main defines none: keep every image.
      console.warn(`[environment-images] project ${projectId}: not pruned, main's environment is unresolved: ${err.message}`);
      return;
    }
    const pruned = await images.prune(projectId, keep);
    const failed = pruned.kept.filter((image) => image.why === "remove-failed");
    console.log(
      `[environment-images] project ${projectId}: kept version ${keep}; removed ${pruned.removed.length} ` +
        `image(s)${pruned.removed.length > 0 ? ` [${pruned.removed.map((image) => image.version.slice(0, 16)).join(", ")}]` : ""}, ` +
        `kept ${pruned.kept.length}`,
    );
    for (const image of failed) {
      console.warn(`[environment-images] project ${projectId}: image ${image.imageId} could not be removed: ${image.detail ?? "(no detail)"}`);
    }
  } catch (err) {
    // eslint-disable-next-line ashara/catch-continue -- best effort: pruning stale images is cleanup, retried at the next environment task's end or startup; every image is kept meanwhile
    console.warn(`[environment-images] project ${projectId}: pruning failed; the next environment task's end or startup retries:`, err);
  }
}

/**
 * Resolves the environment version on the target's main (read from committed objects through
 * hardened git, never from a work tree), finds or builds its image (the build is recorded), and
 * reads the team's statement of the stack. The definition is read by `readDefinition`, its owner's
 * parse of the whole file. Anything missing is `undefined` with its reason; a substrate or store
 * failure throws.
 */
export async function resolveCurrentEnvironment<D extends EnvironmentBuildContext>(
  projectId: ProjectId,
  targetRepo: HostRepo,
  images: EnvironmentImages,
  statements: EnvironmentStatementSource,
  readDefinition: EnvironmentDefinitionReader<D>,
): Promise<EnvironmentResolution<D>> {
  const undefinedBecause = (reason: string): EnvironmentResolution<D> => ({ kind: "undefined", reason });

  const main = await mainCommit(targetRepo);
  if ("problem" in main) return undefinedBecause(main.problem);
  const { commit } = main;

  let definition: D;
  let version: string;
  try {
    definition = await readDefinition(targetRepo.gitDir, commit);
    version = (await environmentVersion(targetRepo.gitDir, commit, definition)).version;
  } catch (err) {
    if (err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved) {
      return undefinedBecause(`no environment is defined on ${MAIN} at ${commit}: ${err.message}`);
    }
    throw err;
  }

  // The statement belongs to a version, not to the project: one an environment task recorded for
  // another version (or none at all, as when a commit Ashara did not verify moved the version) says
  // nothing about the stack this version was chosen for.
  const statement = await statements.forVersion(projectId, version);
  if (statement === null) {
    return undefinedBecause(
      `environment version ${version} is on ${MAIN} at ${commit}, but no completed environment task or verified ` +
        `implementation merge recorded a statement ` +
        `for that version: no merge Ashara verified produced it`,
    );
  }

  let built: BuiltEnvironment;
  try {
    built = await images.build({ projectId, repoGitDir: targetRepo.gitDir, commit, definition });
  } catch (err) {
    if (err instanceof EnvironmentBuildFailed) {
      return undefinedBecause(`the image of environment version ${version} could not be built: ${err.message}`);
    }
    if (err instanceof EnvironmentVersionUnresolved) {
      return undefinedBecause(`environment version ${version} cannot be built: ${err.message}`);
    }
    throw err;
  }
  if (built.version !== version) throw new EnvironmentVersionMismatch(projectId, commit, version, built.version);

  return {
    kind: "current",
    environment: {
      version,
      commit: built.commit,
      imageId: built.imageId,
      imageRef: built.imageRef,
      reused: built.reused,
      statement,
      definition,
    },
  };
}
