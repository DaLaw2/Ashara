import { describe, expect, test } from "vitest";
import { parseProjectId, recordingLogger } from "@ashara/shared";
import { pruneEnvironmentImages } from "./environment-build.js";
import { PodmanSubstrate } from "./podman.js";

// Every build_environment call leaves a tagged image. Pruning keeps main's current
// version and every image a container uses, and touches nothing without Ashara's labels. podman is
// a fake process runner here: the argv each call sends is the observation.

const projectId = parseProjectId("33333333-3333-4333-8333-333333333333", "test");
const id = (c: string) => c.repeat(64);
const CURRENT = "c".repeat(64);

function image(imageId: string, labels: Record<string, string> | null) {
  return { Id: imageId, Labels: labels, Names: [`localhost/ashara-env-${projectId}:x`] };
}

function ours(version: string | null): Record<string, string> {
  const labels: Record<string, string> = { "ashara.managed": "1", "ashara.project": projectId };
  if (version !== null) labels["ashara.env.version"] = version;
  return labels;
}

function substrateListing(images: unknown[], containers: unknown[], rmExit: (imageId: string) => number = () => 0) {
  const calls: string[][] = [];
  const done = (stdout: string, exitCode = 0, stderr = "") => ({
    exitCode, signal: null, stdout, stdoutCut: null, stderr, stderrCut: null, killedByHost: false, stdinError: null, statusReport: null,
  });
  const substrate = new PodmanSubstrate({ logger: recordingLogger(), 
    podmanPath: "podman",
    mountRoot: "/tmp",
    runner: async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === "images") return done(JSON.stringify(images));
      if (request.args[0] === "ps") return done(JSON.stringify(containers));
      if (request.args[0] === "image" && request.args[1] === "rm") {
        const exit = rmExit(request.args[2] ?? "");
        return done("", exit, exit === 0 ? "" : "image is in use by a container");
      }
      throw new Error(`unexpected podman ${request.args.join(" ")}`);
    },
  });
  return { substrate, calls };
}

describe("pruneEnvironmentImages", () => {
  test("removes old versions no container uses; keeps main's version, images in use and unlabelled versions", async () => {
    const { substrate, calls } = substrateListing(
      [
        image(id("1"), ours(CURRENT)),
        image(id("2"), ours("a".repeat(64))),
        image(id("2"), ours("a".repeat(64))),
        image(id("3"), ours("b".repeat(64))),
        image(id("4"), ours(null)),
      ],
      [{ Id: "cell", ImageID: id("3") }],
    );

    const pruned = await pruneEnvironmentImages(substrate, projectId, CURRENT);

    expect(pruned.removed).toEqual([{ imageId: id("2"), version: "a".repeat(64) }]);
    expect(pruned.kept.map((k) => [k.imageId, k.why])).toEqual([
      [id("1"), "current-version"],
      [id("3"), "in-use"],
      [id("4"), "no-version-label"],
    ]);
    expect(calls[0]).toEqual([
      "images", "--filter", "label=ashara.managed=1", "--filter", `label=ashara.project=${projectId}`, "--format", "json",
    ]);
    expect(calls.filter((c) => c[0] === "image")).toEqual([["image", "rm", id("2")]]);
  });

  test("an image podman refuses to remove is kept and reported", async () => {
    const { substrate } = substrateListing(
      [image(id("1"), ours(CURRENT)), image(id("2"), ours("a".repeat(64))), image(id("3"), ours("b".repeat(64)))],
      [],
      (imageId) => (imageId === id("2") ? 2 : 0),
    );

    const pruned = await pruneEnvironmentImages(substrate, projectId, CURRENT);

    expect(pruned.removed).toEqual([{ imageId: id("3"), version: "b".repeat(64) }]);
    expect(pruned.kept).toEqual([
      { imageId: id("1"), version: CURRENT, why: "current-version" },
      { imageId: id("2"), version: "a".repeat(64), why: "remove-failed", detail: "exit 2: image is in use by a container" },
    ]);
  });

  test("a listing that holds images with only one of the two labels, as a podman that ORs its filters returns: they are neither judged nor removed", async () => {
    const other = parseProjectId("44444444-4444-4444-8444-444444444444", "test");
    const { substrate, calls } = substrateListing(
      [
        image(id("1"), ours("a".repeat(64))),
        image(id("2"), { "ashara.project": projectId, "ashara.env.version": "b".repeat(64) }),
        image(id("3"), { "ashara.managed": "1", "ashara.project": other, "ashara.env.version": "b".repeat(64) }),
        image(id("4"), null),
      ],
      [],
    );

    const pruned = await pruneEnvironmentImages(substrate, projectId, CURRENT);

    expect(pruned).toEqual({ removed: [{ imageId: id("1"), version: "a".repeat(64) }], kept: [] });
    expect(calls.filter((c) => c[0] === "image")).toEqual([["image", "rm", id("1")]]);
  });
});
