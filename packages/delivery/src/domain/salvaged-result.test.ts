import { describe, expect, test } from "vitest";
import { parseStoredBlockedReason } from "@ashara/shared";
import type { StoredBlockedReason } from "@ashara/shared";
import { salvagedReason } from "./salvaged-result.js";

describe("salvagedReason", () => {
  test("augments a variant with salvaged fields, preserving source", () => {
    const original: StoredBlockedReason = {
      source: "orchestrator_error",
      reason: "lifecycle route threw",
    };
    const augmented = salvagedReason(original, "completed", "task completed");
    expect(augmented.source).toBe("orchestrator_error");
    expect(augmented.salvagedOutcome).toBe("completed");
    expect(augmented.salvagedDetail).toBe("task completed");
    expect(typeof augmented.salvagedAt).toBe("string");
    expect(Number.isNaN(Date.parse(augmented.salvagedAt!))).toBe(false);
  });

  test("round-trips through parse after augmentation", () => {
    const original: StoredBlockedReason = {
      source: "task_failed",
      reason: "agent crashed",
    };
    const augmented = salvagedReason(original, "failed", "timed out");
    const parsed = parseStoredBlockedReason(augmented);
    expect(parsed).toBeDefined();
    expect(parsed!.salvagedOutcome).toBe("failed");
    expect(parsed!.salvagedDetail).toBe("timed out");
    expect(parsed!.salvagedAt).toBeDefined();
    expect(parsed!.source).toBe("task_failed");
  });
});
