import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { loadBaseCell } from "@ashara/execution-infra";
import { describeErrorChain, parseJson } from "@ashara/shared";

// The container images the podman tests run, beside the BaseCell config/base-cell.toml names. Every
// one is pinned by digest and run with --pull=never, so a run finds each in local podman storage or
// cannot run at all; test-images-guard.ts checks that before any test, and test-images-pull.ts
// fetches them, the only path that does.

/** Module-anchored, so the cwd of a run cannot change which file is read. */
const TEST_IMAGES_PATH = fileURLToPath(new URL("../test-images.json", import.meta.url));
const PODMAN_TIMEOUT_MS = 30_000;
/** `podman image exists` exits 1 for an image that is absent, 125 when podman itself fails. */
const IMAGE_ABSENT_EXIT = 1;

const pinnedReference = z.string().regex(/^[^\s-][^\s@]*@sha256:[0-9a-f]{64}$/, "an image reference pinned by @sha256:<64 hex> digest");

const testImagesSchema = z
  .object({
    /** A busybox image with wget and timeout. */
    alpine: pinnedReference,
    /** An image with a git client and no entrypoint. */
    git: pinnedReference,
  })
  .strict();

/** @testseam the podman tests run these images; the guard and the pull read them through pinnedTestImages */
export const TEST_IMAGES = parseJson(testImagesSchema, readFileSync(TEST_IMAGES_PATH, "utf8"), TEST_IMAGES_PATH);

/** Every image a test run needs present: the BaseCell and the images of test-images.json. */
export async function pinnedTestImages(): Promise<readonly string[]> {
  const base = await loadBaseCell();
  return [...new Set([base.image, TEST_IMAGES.alpine, TEST_IMAGES.git])];
}

/** The command that fetches one image, as the guard's message names it. */
export function pullCommand(image: string): string {
  return `podman pull ${image}`;
}

/** Pinned images absent from local podman storage; the run stops before any test. */
class TestImagesMissingError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `${missing.length} pinned test image(s) absent from local podman storage, so no test runs; a test run never ` +
        "pulls on its own. Fetch them all with `just test-images`, or each with:\n" +
        missing.map((image) => `  ${pullCommand(image)}`).join("\n"),
    );
    this.name = "TestImagesMissingError";
  }
}

/** podman could not say whether an image is present; that is no evidence it is. */
class TestImagesCheckFailed extends Error {
  constructor(
    readonly image: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`test images: \`podman image exists ${image}\` failed, so its presence is unknown: ${detail}`, options);
    this.name = "TestImagesCheckFailed";
  }
}

const run = promisify(execFile);

async function imagePresent(image: string): Promise<boolean> {
  try {
    await run("podman", ["image", "exists", image], { timeout: PODMAN_TIMEOUT_MS });
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === IMAGE_ABSENT_EXIT) return false;
    throw new TestImagesCheckFailed(image, describeErrorChain(err), { cause: err });
  }
}

/** Throws TestImagesMissingError naming every pinned image absent from local storage. */
export async function checkTestImages(): Promise<void> {
  const missing: string[] = [];
  for (const image of await pinnedTestImages()) {
    if (!(await imagePresent(image))) missing.push(image);
  }
  if (missing.length > 0) throw new TestImagesMissingError(missing);
}
