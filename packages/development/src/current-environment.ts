import type { BuiltEnvironment, EnvironmentDefinition, HostRepo } from "@ashara/execution-infra";
import {
  EnvironmentBuildFailed,
  EnvironmentDefinitionInvalid,
  EnvironmentVersionUnresolved,
  environmentVersion,
  readEnvironmentDefinition,
  runHostGit,
} from "@ashara/execution-infra";
import type { ProjectId } from "@ashara/shared";
import type { EnvironmentImages, EnvironmentStatementStore } from "./environment-check.js";

// Every task after Sprint 0 runs in cells built from the project's CURRENT environment version:
// the owned files of environment/environment.toml as committed on the target's main. There is no
// other build path and no fallback to the BaseCell (s-platform-role-m1 C2).

const MAIN = "main";
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The project's current environment: its version, the image built from it, and the team's statement. */
export interface CurrentEnvironment {
  readonly version: string;
  /** The last commit on main that touched an owned path. */
  readonly commit: string;
  readonly imageId: string;
  readonly imageRef: string;
  /** Whether the image was already built for this version (no build ran). */
  readonly reused: boolean;
  /** The statement recorded with this version when the environment task that produced it merged. */
  readonly statement: string;
  /** The definition's `test` command on main: run on every post-merge checkout, from this image. */
  readonly test: string;
  /** The definition's owned paths on main: the environment's files, which no check may touch. */
  readonly owned: readonly string[];
}

export type EnvironmentResolution =
  | { readonly kind: "current"; readonly environment: CurrentEnvironment }
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
    return { problem: `the target repository has no readable ${MAIN} branch: ${err instanceof Error ? err.message : String(err)}` };
  }
  const hash = stdout.trim();
  return COMMIT_HASH.test(hash) ? { commit: hash } : { problem: `rev-parse ${MAIN} printed ${JSON.stringify(stdout)}` };
}

/**
 * Resolves the environment version on the target's main (read from committed objects through
 * hardened git, never from a work tree), finds or builds its image (the build is recorded), and
 * reads the team's statement of the stack. Anything missing is `undefined` with its reason; a
 * substrate or store failure throws.
 */
export async function resolveCurrentEnvironment(
  projectId: ProjectId,
  targetRepo: HostRepo,
  images: EnvironmentImages,
  statements: EnvironmentStatementStore,
): Promise<EnvironmentResolution> {
  const undefinedBecause = (reason: string): EnvironmentResolution => ({ kind: "undefined", reason });

  const main = await mainCommit(targetRepo);
  if ("problem" in main) return undefinedBecause(main.problem);
  const { commit } = main;

  let definition: EnvironmentDefinition;
  let version: string;
  try {
    definition = await readEnvironmentDefinition(targetRepo.gitDir, commit);
    version = (await environmentVersion(targetRepo.gitDir, commit, definition)).version;
  } catch (err) {
    if (err instanceof EnvironmentDefinitionInvalid || err instanceof EnvironmentVersionUnresolved) {
      return undefinedBecause(`no environment is defined on ${MAIN} at ${commit}: ${err.message}`);
    }
    throw err;
  }

  // The statement belongs to a version, not to the project: one an environment task recorded for
  // another version (or none at all, as when a non-environment commit moved the version) says
  // nothing about the stack this version was chosen for.
  const statement = await statements.forVersion(projectId, version);
  if (statement === null) {
    return undefinedBecause(
      `environment version ${version} is on ${MAIN} at ${commit}, but no completed environment task recorded a statement ` +
        `for that version: the version was not produced by an environment task`,
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
      test: definition.test,
      owned: definition.owned,
    },
  };
}
