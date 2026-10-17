import { checkTestImages } from "./test-images.js";

// vitest's globalSetup, first in the list: a pinned image absent from local podman storage stops the
// run before any test, with one error naming every such image and its pull command, rather than as
// `image not known` inside whichever test reaches it first.

/** @testseam vitest.config.ts names this file as globalSetup, a reference knip does not read */
export default async function setup(): Promise<void> {
  await checkTestImages();
}
