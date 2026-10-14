import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { materializeSnapshot, snapshotEnvironment, type EnvironmentDefinition } from "./environment.js";
import { EnvironmentBuildFailed, EnvironmentBuildUnrecorded, InvalidCellRequest, PodmanCommandFailed } from "./errors.js";
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

export interface EnvironmentBuildRequest {
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

/** The last LOG_TAIL_CHARS characters of a build's log, and whether anything before them was cut. */
interface BuildLogTail {
  readonly text: string;
  readonly truncated: boolean;
}

export type BuiltEnvironment = EnvironmentBuildIdentity & { readonly imageId: string } & (
    /** An image already built for this project and version was used as is: no build ran, so there is no log. */
    | { readonly reused: true }
    | { readonly reused: false; readonly log: BuildLogTail }
  );


function tailOf(log: string): BuildLogTail {
  return log.length <= LOG_TAIL_CHARS ? { text: log, truncated: false } : { text: log.slice(-LOG_TAIL_CHARS), truncated: true };
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
    throw new PodmanCommandFailed("image inspect", inspectArgs, inspect.exitCode, `invalid JSON: ${describeErrorChain(err)}`);
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

const imageListSchema = z.array(
  z.object({
    Id: z.string().regex(/^[0-9a-f]{64}$/),
    Labels: z.record(z.string(), z.string()).nullable().optional(),
  }),
);
const containerListSchema = z.array(z.object({ Id: z.string().min(1), ImageID: z.string() }));

/** One image pruning left in place, and why. */
interface KeptImage {
  readonly imageId: string;
  readonly version: string | null;
  readonly why: "current-version" | "in-use" | "no-version-label" | "remove-failed";
  readonly detail?: string;
}

/** What one prune of a project's environment images did. */
export interface EnvironmentImagePrune {
  readonly removed: readonly { readonly imageId: string; readonly version: string }[];
  readonly kept: readonly KeptImage[];
}

async function podmanJson(substrate: PodmanSubstrate, operation: string, args: readonly string[]): Promise<unknown> {
  const result = await substrate.run(args);
  if (result.exitCode !== 0) throw new PodmanCommandFailed(operation, args, result.exitCode, result.stderr.trim() || "(no stderr)");
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new PodmanCommandFailed(operation, args, result.exitCode, `invalid JSON: ${describeErrorChain(err)}`);
  }
}

/**
 * Removes the project's environment images of every version other than `keepVersion` (main's
 * current one) that no container uses, live or stopped (third run
 * N12: every build_environment call left a tagged image). Only images labelled ashara.managed=1
 * and ashara.project=<projectId> are selected, and both labels are checked again on what podman
 * returns, so a change in its filter semantics removes nothing of anyone else's. An image that
 * cannot be removed is kept and reported; a podman failure listing images or containers throws.
 */
export async function pruneEnvironmentImages(
  substrate: PodmanSubstrate,
  projectId: ProjectId,
  keepVersion: string,
): Promise<EnvironmentImagePrune> {
  const tag = projectTagSchema.safeParse(projectId);
  if (!tag.success) throw new InvalidCellRequest("pruneEnvironmentImages", tag.error.issues.map((issue) => issue.message));

  const listArgs = ["images", "--filter", `label=${LABEL_MANAGED}=1`, "--filter", `label=${LABEL_PROJECT}=${projectId}`, "--format", "json"];
  const images = imageListSchema.safeParse(await podmanJson(substrate, "images", listArgs));
  if (!images.success) throw new PodmanCommandFailed("images", listArgs, 0, `unexpected shape: ${images.error.message}`);
  const foreign = images.data.filter((image) => image.Labels?.[LABEL_MANAGED] !== "1" || image.Labels[LABEL_PROJECT] !== projectId);
  if (foreign.length > 0) {
    throw new PodmanCommandFailed(
      "images", listArgs, 0,
      `the label filter returned ${foreign.length} image(s) without both labels (${foreign.map((image) => image.Id).join(", ")}); refusing to remove anything`,
    );
  }

  const psArgs = ["ps", "-a", "--format", "json"];
  const containers = containerListSchema.safeParse(await podmanJson(substrate, "ps", psArgs));
  if (!containers.success) throw new PodmanCommandFailed("ps", psArgs, 0, `unexpected shape: ${containers.error.message}`);
  const inUse = new Set(containers.data.map((container) => container.ImageID.replace(/^sha256:/, "")));

  const removed: Array<{ readonly imageId: string; readonly version: string }> = [];
  const kept: KeptImage[] = [];
  // podman lists an image once per name: each is judged once.
  const seen = new Set<string>();
  for (const image of images.data) {
    if (seen.has(image.Id)) continue;
    seen.add(image.Id);
    const version = image.Labels?.[LABEL_ENV_VERSION] ?? null;
    if (version === null) kept.push({ imageId: image.Id, version, why: "no-version-label" });
    else if (version === keepVersion) kept.push({ imageId: image.Id, version, why: "current-version" });
    else if (inUse.has(image.Id)) kept.push({ imageId: image.Id, version, why: "in-use" });
    else {
      // Without --force: podman refuses an image a container started meanwhile, and it stays.
      const rmArgs = ["image", "rm", image.Id];
      const result = await substrate.run(rmArgs);
      if (result.exitCode === 0) removed.push({ imageId: image.Id, version });
      else kept.push({ imageId: image.Id, version, why: "remove-failed", detail: `exit ${result.exitCode ?? "none"}: ${result.stderr.trim() || "(no stderr)"}` });
    }
  }
  return { removed, kept };
}

/**
 * Builds the project's environment image from the owned files at `commit` and nothing else, or
 * reuses the image already built for this version when its succeeded build is on record.
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
    const tail = tailOf(log);
    const error = new EnvironmentBuildFailed(
      request.projectId, snapshot.version, exitCode, timedOut, tail.text, tail.truncated, detail,
      cause === undefined ? undefined : { cause },
    );
    try {
      await deps.recorder.recordFailed({ ...identity, logDigest: sha256(log), error: error.message });
    } catch (recordErr) {
      throw new EnvironmentBuildFailed(
        request.projectId, snapshot.version, exitCode, timedOut, tail.text, tail.truncated,
        `${detail}; recording the failed build also failed: ${describeErrorChain(recordErr)}`,
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
      return await fail(null, false, "", `the owned files could not be exported: ${describeErrorChain(err)}`, err);
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
      return await fail(result.exitCode, false, log, `podman build succeeded but wrote no valid image id: ${describeErrorChain(err)}`, err);
    }
    try {
      await deps.recorder.recordSucceeded({ ...identity, imageId, logDigest: sha256(log) });
    } catch (err) {
      throw new EnvironmentBuildUnrecorded({ ...identity, imageId }, describeErrorChain(err), { cause: err });
    }
    return { ...identity, imageId, reused: false, log: tailOf(log) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
