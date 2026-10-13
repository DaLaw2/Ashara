import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkItemId, parseProjectId } from "@ashara/shared";
import { finalizeSuccess } from "./finalize.js";

describe("finalizeSuccess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("with no target workspace it fails instead of reporting a success that merged nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const workDir = await mkdtemp(join(tmpdir(), "ashara-finalize-"));
    const notRun = async (): Promise<{ exitCode: number; output: string }> => {
      throw new Error("no command may run without a target workspace");
    };
    try {
      const result = await finalizeSuccess(
        { runCommand: notRun, prepareRunCommand: notRun },
        workDir,
        {
          id: createWorkItemId(),
          projectId: parseProjectId("33333333-3333-4333-8333-333333333333"),
          title: "t",
          dispatchCount: 1,
          successCriteria: [],
        },
        null,
        1,
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errorLayer.message).toContain("nothing merged");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
