import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cellInstanceFor, reconcileCellsAtStartup } from "./cells.js";
import { PodmanSubstrate } from "./podman.js";

/*
 * What podman removes on reconciliation is integration/execution-infra/cell.podman.test.ts's, on
 * real cells; here only what startup adds to it, which needs no cell.
 */
describe("reconcileCellsAtStartup", () => {
  it("reconciles this deployment's instance, which no other deployment shares", async () => {
    const instance = cellInstanceFor("/srv/ashara/work");
    expect(instance).not.toBe(cellInstanceFor("/srv/another-deployment/work"));
    const asked: string[] = [];
    const recording = {
      reconcileOrphans: async (of: string): Promise<string[]> => {
        asked.push(of);
        return ["leaked-cell"];
      },
    };
    await reconcileCellsAtStartup(recording, instance);
    expect(asked).toEqual([instance]);
  });

  it("does not stop the boot on an unreachable substrate; tasks block at their own probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "ashara-reconcile-"));
    try {
      const missing = new PodmanSubstrate({ trace: () => "test-trace", podmanPath: join(root, "no-such-podman"), mountRoot: root });
      await expect(reconcileCellsAtStartup(missing, cellInstanceFor(root))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
