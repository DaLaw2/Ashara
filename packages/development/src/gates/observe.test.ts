import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { observeProduct } from "./observe.js";

// ---------------------------------------------------------------------------
// Run 39's Go CLI produced `booted: false, bootOutput: "no package.json"`, and
// acceptance published that as a product defect. Ashara must instead say "I
// cannot observe this" — a claim about the observer, not about the product.
// ---------------------------------------------------------------------------

const NOTES_ENDPOINT = [{ method: "GET", path: "/notes" }] as const;

let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "ashara-observe-"));
});

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

describe("a product this observer cannot judge", () => {
  test("a project with no declared HTTP surface is not-observable, never a failed boot", async () => {
    await writeFile(join(projectPath, "main.go"), "package main\n\nfunc main() {}\n");

    const observation = await observeProduct({ targetProjectPath: projectPath, contractEntryPoint: null, contractEndpoints: null });

    expect(observation.kind).toBe("not-observable");
    if (observation.kind !== "not-observable") throw new Error("unreachable");
    expect(observation.cause).toBe("no-declared-surface");
    expect(observation.detail).toContain("limit of the observer");
  });

  test("a missing package.json is not evidence about the product", async () => {
    const observation = await observeProduct({ targetProjectPath: projectPath, contractEntryPoint: null, contractEndpoints: null });

    expect(observation.kind).not.toBe("boot-failed");
    if (observation.kind !== "not-observable") throw new Error("unreachable");
    expect(observation.detail).not.toBe("no package.json");
  });

  test("a declared HTTP surface with nothing declaring how to start it refuses instead of guessing a runtime", async () => {
    await writeFile(join(projectPath, "server.go"), "package main\n");

    const observation = await observeProduct({
      targetProjectPath: projectPath,
      contractEntryPoint: "cmd/server/main.go",
      contractEndpoints: NOTES_ENDPOINT,
    });

    expect(observation.kind).toBe("not-observable");
    if (observation.kind !== "not-observable") throw new Error("unreachable");
    expect(observation.cause).toBe("no-launch-command");
    // Both rungs decline by name, so the refusal is self-diagnosing.
    expect(observation.detail).toContain("no package.json");
    expect(observation.detail).toContain("not an executable file");
  });

  test("a tree that cannot be made runnable is charged to the toolchain, not to the product", async () => {
    await writeFile(join(projectPath, "package.json"), JSON.stringify({ scripts: { start: "node index.js" } }));

    const observation = await observeProduct({
      targetProjectPath: projectPath,
      contractEntryPoint: null,
      contractEndpoints: NOTES_ENDPOINT,
      deps: { prepareToolchain: async () => { throw new Error("registry unreachable"); } },
    });

    expect(observation.kind).toBe("not-observable");
    if (observation.kind !== "not-observable") throw new Error("unreachable");
    expect(observation.cause).toBe("toolchain-unprepared");
  });
});
