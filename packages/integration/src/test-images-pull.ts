import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describeErrorChain } from "@ashara/shared";
import { pinnedTestImages, pullCommand } from "./test-images.js";

// `just test-images` and CI's podman step: the one path that fetches the pinned test images. It only
// pulls; it never removes an image.

const run = promisify(execFile);
const PULL_TIMEOUT_MS = 600_000;

class TestImagePullFailed extends Error {
  constructor(
    readonly image: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`\`${pullCommand(image)}\` failed: ${detail}`, options);
    this.name = "TestImagePullFailed";
  }
}

async function main(): Promise<void> {
  for (const image of await pinnedTestImages()) {
    console.log(pullCommand(image));
    try {
      await run("podman", ["pull", image], { timeout: PULL_TIMEOUT_MS });
    } catch (err) {
      throw new TestImagePullFailed(image, describeErrorChain(err), { cause: err });
    }
  }
}

await main();
