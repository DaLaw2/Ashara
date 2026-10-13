import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ProjectId } from "@ashara/shared";
import { materializeSnapshot, snapshotEnvironment, type EnvironmentDefinition } from "./environment.js";
import { EnvironmentBuildFailed, InvalidCellRequest, PodmanCommandFailed } from "./errors.js";
import type { PodmanSubstrate } from "./podman.js";

/**
 * podman build's own default network namespace. ADR-074 addendum 2 d62: only this Z0-run build of
 * the environment reaches the network; every cell keeps --network=none.
 */
const BUILD_NETWORK = "private";
const LOG_TAIL_CHARS = 4000;
const VERSION_TAG_CHARS = 16;

const LABEL_MANAGED = "ashara.managed";
const LABEL_PROJECT = "ashara.project";
const LABEL_ENV_VERSION = "ashara.env.version";

const imageIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const inspectSchema = z.array(
  z.object({
    Id: z.string().regex(/^[0-9a-f]{64}$/),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
).length(1);

/** A repository name component: podman lowercases nothing for us, so an invalid id is refused. */
const projectTagSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/, "a project id must be a lowercase image name component");

interface EnvironmentBuildIdentity {
  readonly projectId: ProjectId;
  readonly version: string;
  /** The environment version's commit: the last one that touched an owned path. */
  readonly commit: string;
  readonly imageRef: string;
  /** The network the build ran with; recorded because builds are the one thing that may reach it. */
  readonly network: string;
}

interface SucceededEnvironmentBuild extends EnvironmentBuildIdentity {
  readonly imageId: string;
  /** sha256 (hex) of the captured build log. */
  readonly logDigest: string;
}

interface FailedEnvironmentBuild extends EnvironmentBuildIdentity {
  readonly logDigest: string;
  readonly error: string;
}

/** Persistence of environment builds (environment_builds, migration 032), supplied by the composition root. */
interface EnvironmentBuildRecorder {
  findSucceeded(projectId: ProjectId, version: string): Promise<{ readonly imageId: string } | null>;
  /** The one succeeded build of (project, version); a rebuild replaces it. */
  recordSucceeded(build: SucceededEnvironmentBuild): Promise<unknown>;
  recordFailed(build: FailedEnvironmentBuild): Promise<unknown>;
}

interface EnvironmentBuildRequest {
  readonly projectId: ProjectId;
  /** The target repository's git dir, read for committed objects only. */
  readonly repoGitDir: string;
  readonly commit: string;
  readonly definition: EnvironmentDefinition;
}

interface EnvironmentBuildDeps {
  readonly substrate: PodmanSubstrate;
  readonly recorder: EnvironmentBuildRecorder;
  /** Wall-clock limit of `podman build`; the client is killed after it. */
  readonly timeoutMs: number;
}

interface BuiltEnvironment extends EnvironmentBuildIdentity {
  readonly imageId: string;
  /** True when an image already built for this project and version was used as is. */
  readonly reused: boolean;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function existingImageId(substrate: PodmanSubstrate, imageRef: string, projectId: string, version: string): Promise<string | null> {
  const existsArgs = ["image", "exists", imageRef];
  const exists = await substrate.run(existsArgs);
  if (exists.exitCode === 1) return null;
  if (exists.exitCode !== 0) {
    throw new PodmanCommandFailed("image exists", existsArgs, exists.exitCode, exists.stderr.trim() || "(no stderr)");
  }
  const inspectArgs = ["image", "inspect", "--format", "json", imageRef];
  const inspect = await substrate.run(inspectArgs);
  if (inspect.exitCode !== 0) {
    throw new PodmanCommandFailed("image inspect", inspectArgs, inspect.exitCode, inspect.stderr.trim() || "(no stderr)");
  }
  let json: unknown;
  try {
    json = JSON.parse(inspect.stdout);
  } catch (err) {
    throw new PodmanCommandFailed("image inspect", inspectArgs, inspect.exitCode, `invalid JSON: ${messageOf(err)}`);
  }
  const parsed = inspectSchema.safeParse(json);
  if (!parsed.success) {
    throw new PodmanCommandFailed("image inspect", inspectArgs, inspect.exitCode, `unexpected shape: ${parsed.error.message}`);
  }
  const [image] = parsed.data;
  // A tag is mutable: only an image that carries this project's and version's labels is ours.
  if (image === undefined || image.Labels?.[LABEL_PROJECT] !== projectId || image.Labels[LABEL_ENV_VERSION] !== version) return null;
  return `sha256:${image.Id}`;
}

/**
 * Builds the project's environment image from the owned files at `commit` and nothing else, or
 * reuses the image already built for this version when its succeeded build is on record.
 * @testseam adopted by t-dispatch-by-env-version (s-platform-role-m1)
 */
export async function buildEnvironmentImage(request: EnvironmentBuildRequest, deps: EnvironmentBuildDeps): Promise<BuiltEnvironment> {
  const issues: string[] = [];
  const tag = projectTagSchema.safeParse(request.projectId);
  if (!tag.success) issues.push(`projectId: ${tag.error.issues.map((issue) => issue.message).join(", ")}`);
  if (!Number.isInteger(deps.timeoutMs) || deps.timeoutMs <= 0) issues.push(`timeoutMs must be a positive integer, got ${deps.timeoutMs}`);
  if (issues.length > 0) throw new InvalidCellRequest("buildEnvironmentImage", issues);

  const snapshot = await snapshotEnvironment(request.repoGitDir, request.commit, request.definition);
  const identity: EnvironmentBuildIdentity = {
    projectId: request.projectId,
    version: snapshot.version,
    commit: snapshot.commit,
    imageRef: `localhost/ashara-env-${request.projectId}:${snapshot.version.slice(0, VERSION_TAG_CHARS)}`,
    network: BUILD_NETWORK,
  };

  const existing = await existingImageId(deps.substrate, identity.imageRef, request.projectId, snapshot.version);
  if (existing !== null) {
    const recorded = await deps.recorder.findSucceeded(request.projectId, snapshot.version);
    if (recorded !== null && recorded.imageId === existing) return { ...identity, imageId: existing, reused: true };
  }

  const fail = async (exitCode: number | null, timedOut: boolean, log: string, detail: string, cause?: unknown): Promise<never> => {
    const error = new EnvironmentBuildFailed(
      request.projectId, snapshot.version, exitCode, timedOut, log.slice(-LOG_TAIL_CHARS), detail,
      cause === undefined ? undefined : { cause },
    );
    try {
      await deps.recorder.recordFailed({ ...identity, logDigest: sha256(log), error: error.message });
    } catch (recordErr) {
      throw new EnvironmentBuildFailed(
        request.projectId, snapshot.version, exitCode, timedOut, log.slice(-LOG_TAIL_CHARS),
        `${detail}; recording the failed build also failed: ${messageOf(recordErr)}`,
        { cause: error },
      );
    }
    throw error;
  };

  const workDir = await mkdtemp(join(tmpdir(), "ashara-env-build-"));
  try {
    const context = join(workDir, "context");
    const iidFile = join(workDir, "image-id");
    try {
      await mkdir(context);
      await materializeSnapshot(request.repoGitDir, snapshot, context);
    } catch (err) {
      return await fail(null, false, "", `the owned files could not be exported: ${messageOf(err)}`, err);
    }

    const args = [
      "build",
      `--network=${BUILD_NETWORK}`,
      "--pull=missing",
      "--label", `${LABEL_MANAGED}=1`,
      "--label", `${LABEL_PROJECT}=${request.projectId}`,
      "--label", `${LABEL_ENV_VERSION}=${snapshot.version}`,
      "--iidfile", iidFile,
      "-f", join(context, request.definition.containerfile),
      "-t", identity.imageRef,
      context,
    ];
    const result = await deps.substrate.run(args, { killAfterMs: deps.timeoutMs });
    const truncated = result.stdoutTruncated || result.stderrTruncated ? "\n[output truncated]" : "";
    const log = `${result.stdout}${result.stderr}${truncated}`;
    if (result.killedByHost) return await fail(null, true, log, `podman build ran past ${deps.timeoutMs} ms and was killed`);
    if (result.exitCode !== 0) {
      return await fail(result.exitCode, false, log, `podman build exited ${result.exitCode ?? `by signal ${result.signal ?? "unknown"}`}`);
    }

    let imageId: string;
    try {
      imageId = imageIdSchema.parse((await readFile(iidFile, "utf8")).trim());
    } catch (err) {
      return await fail(result.exitCode, false, log, `podman build succeeded but wrote no valid image id: ${messageOf(err)}`, err);
    }
    await deps.recorder.recordSucceeded({ ...identity, imageId, logDigest: sha256(log) });
    return { ...identity, imageId, reused: false };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
