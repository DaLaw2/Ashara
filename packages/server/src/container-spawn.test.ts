import { describe, expect, test } from "vitest";
import {
  SANDBOX_IMAGE,
  SANDBOX_TAG,
  ContainerSpawnError,
} from "./container-spawn.js";

describe("SANDBOX_IMAGE and SANDBOX_TAG", () => {
  test("SANDBOX_IMAGE is a non-empty string", () => {
    expect(SANDBOX_IMAGE).toBe("alpine");
  });

  test("SANDBOX_TAG is a non-empty string", () => {
    expect(SANDBOX_TAG).toBe("3.20");
  });
});

describe("ContainerSpawnError", () => {
  const ctx = {
    operation: "spawn",
    containerName: "ashara-agent-test-1",
    taskId: "wi_abc-123",
    exitCode: 125,
    cause: "image not found",
    stderr: "Error: alpine:3.20 not found",
  } as const;

  test("constructs with structured context", () => {
    const err = new ContainerSpawnError(ctx);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ContainerSpawnError");
    expect(err.context).toEqual(ctx);
  });

  test("message includes operation, taskId, containerName, exitCode, and cause", () => {
    const err = new ContainerSpawnError(ctx);
    expect(err.message).toContain("spawn");
    expect(err.message).toContain("wi_abc-123");
    expect(err.message).toContain("ashara-agent-test-1");
    expect(err.message).toContain("125");
    expect(err.message).toContain("image not found");
  });

  test("handles null exitCode", () => {
    const err = new ContainerSpawnError({ ...ctx, exitCode: null });
    expect(err.context.exitCode).toBeNull();
    expect(err.message).toContain("exit=null");
  });
});
