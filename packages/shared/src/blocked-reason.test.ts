import { describe, test, expect } from "vitest";
import { blockedReasonToRecord, parseStoredBlockedReason, BlockedReasonCorrupt, storedBlockedReasonSchema, withSubstitutedBy } from "./blocked-reason.js";
import type { StoredBlockedReason } from "./blocked-reason.js";

describe("parseStoredBlockedReason", () => {
  test("null returns undefined (policy default: items without a reason)", () => {
    expect(parseStoredBlockedReason(null)).toBeUndefined();
  });

  test("undefined returns undefined", () => {
    expect(parseStoredBlockedReason(undefined)).toBeUndefined();
  });

  test("non-object value throws BlockedReasonCorrupt with structured context", () => {
    const corrupt = "not an object";
    try {
      parseStoredBlockedReason(corrupt);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BlockedReasonCorrupt);
      const err = e as BlockedReasonCorrupt;
      expect(err.raw).toBe(corrupt);
      expect(err.detail).toBeTruthy();
      expect(err.name).toBe("BlockedReasonCorrupt");
      expect(err.message).toContain("stored blocked_reason is not a valid object");
    }
  });

  test("number throws BlockedReasonCorrupt (not silently coerced)", () => {
    expect(() => parseStoredBlockedReason(42)).toThrow(BlockedReasonCorrupt);
  });

  test("object without source throws BlockedReasonCorrupt (no silent undefined source)", () => {
    expect(() => parseStoredBlockedReason({ reason: "task_failed" })).toThrow(BlockedReasonCorrupt);
  });

  test("object with unknown source throws BlockedReasonCorrupt (closed enum)", () => {
    expect(() =>
      parseStoredBlockedReason({ source: "nonexistent_producer", reason: "something" }),
    ).toThrow(BlockedReasonCorrupt);
  });
});

describe("source variant round-trips", () => {
  test("task_failed variant round-trips", () => {
    const input = { source: "task_failed", reason: "task_failed" };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("task_failed");
    if (result!.source === "task_failed") {
      expect(result!.reason).toBe("task_failed");
    }
  });

  test("orchestrator_error variant round-trips", () => {
    const input = { source: "orchestrator_error", reason: "orchestrator error" };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("orchestrator_error");
    if (result!.source === "orchestrator_error") {
      expect(result!.reason).toBe("orchestrator error");
    }
  });

  test("replan variant round-trips with replanContext", () => {
    const input = {
      source: "replan",
      replanContext: { attempt: 2, detail: "gate check failed", raw: { stderr: "error" } },
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("replan");
    if (result!.source === "replan") {
      expect(result!.replanContext.attempt).toBe(2);
      expect(result!.replanContext.detail).toBe("gate check failed");
      expect(result!.replanContext.raw).toEqual({ stderr: "error" });
    }
  });

  test("failure_router variant round-trips with all optional fields", () => {
    const input = {
      source: "failure_router",
      reason: "retry_budget_exhausted",
      attempts: 3,
      lastFailure: { detail: "gate failed", raw: {} },
      detail: "error detail",
      substitutedBy: "wi-abc-123",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("failure_router");
    if (result!.source === "failure_router") {
      expect(result!.reason).toBe("retry_budget_exhausted");
      expect(result!.attempts).toBe(3);
      expect(result!.detail).toBe("error detail");
      expect(result!.substitutedBy).toBe("wi-abc-123");
    }
  });

  test("split_on_failure variant round-trips", () => {
    const input = {
      source: "split_on_failure",
      reason: "split into subtasks",
      attempts: 1,
      substitutedBy: "wi-part-b",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("split_on_failure");
    expect(result!.substitutedBy).toBe("wi-part-b");
  });

  test("shutdown-reconciler variant round-trips", () => {
    const input = {
      source: "shutdown-reconciler",
      reason: "run terminated",
      previousStatus: "InProgress",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("shutdown-reconciler");
    if (result!.source === "shutdown-reconciler") {
      expect(result!.previousStatus).toBe("InProgress");
    }
  });

  test("startup-reconciler variant round-trips", () => {
    const input = {
      source: "startup-reconciler",
      reason: "orphaned by a previous run",
      previousScope: "run-dead-beef",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("startup-reconciler");
    if (result!.source === "startup-reconciler") {
      expect(result!.previousScope).toBe("run-dead-beef");
    }
  });

  test("api variant round-trips and preserves user-supplied fields via passthrough", () => {
    const input = {
      source: "api",
      note: "abandoned via API",
      customField: "user-data",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("api");
    // Passthrough preserves unknown fields
    const record = result as Record<string, unknown>;
    expect(record["note"]).toBe("abandoned via API");
    expect(record["customField"]).toBe("user-data");
  });
});

describe("substitutedBy on all variants", () => {
  test("substitutedBy is accepted on a non-api variant", () => {
    const input = {
      source: "task_failed",
      reason: "task_failed",
      substitutedBy: "wi-replacement",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.substitutedBy).toBe("wi-replacement");
  });
});

describe("withSubstitutedBy helper", () => {
  test("augments a variant with substitutedBy, preserving source", () => {
    const original: StoredBlockedReason = {
      source: "failure_router",
      reason: "retry exhausted",
    };
    const augmented = withSubstitutedBy(original, "wi-new-123");
    expect(augmented.source).toBe("failure_router");
    expect(augmented.substitutedBy).toBe("wi-new-123");
  });
});

describe("storedBlockedReasonSchema", () => {
  test("replan variant rejects missing replanContext", () => {
    const result = storedBlockedReasonSchema.safeParse({ source: "replan" });
    expect(result.success).toBe(false);
  });

  test("shutdown-reconciler rejects missing previousStatus", () => {
    const result = storedBlockedReasonSchema.safeParse({
      source: "shutdown-reconciler",
      reason: "run terminated",
    });
    expect(result.success).toBe(false);
  });

  test("startup-reconciler rejects missing previousScope", () => {
    const result = storedBlockedReasonSchema.safeParse({
      source: "startup-reconciler",
      reason: "orphaned",
    });
    expect(result.success).toBe(false);
  });
});

describe("blockedReasonToRecord", () => {
  test("preserves all typed fields on failure_router variant", () => {
    const reason: StoredBlockedReason = {
      source: "failure_router",
      reason: "retry exhausted",
      attempts: 3,
      lastFailure: { detail: "gate failed" },
      substitutedBy: "wi-replacement",
    };
    const record = blockedReasonToRecord(reason);
    expect(record["source"]).toBe("failure_router");
    expect(record["reason"]).toBe("retry exhausted");
    expect(record["attempts"]).toBe(3);
    expect(record["lastFailure"]).toEqual({ detail: "gate failed" });
    expect(record["substitutedBy"]).toBe("wi-replacement");
  });

  test("preserves passthrough fields on api variant", () => {
    const parsed = parseStoredBlockedReason({
      source: "api",
      note: "abandoned via API",
      customField: 42,
    })!;
    const record = blockedReasonToRecord(parsed);
    expect(record["source"]).toBe("api");
    expect(record["note"]).toBe("abandoned via API");
    expect(record["customField"]).toBe(42);
  });

  test("variants without attempts return undefined for that key", () => {
    const reason: StoredBlockedReason = {
      source: "task_failed",
      reason: "compilation error",
    };
    const record = blockedReasonToRecord(reason);
    expect(record["source"]).toBe("task_failed");
    expect(record["reason"]).toBe("compilation error");
    expect(record["attempts"]).toBeUndefined();
  });

  test("replan variant carries replanContext, not reason", () => {
    const reason: StoredBlockedReason = {
      source: "replan",
      replanContext: { attempt: 1, detail: "gate failed", raw: {} },
    };
    const record = blockedReasonToRecord(reason);
    expect(record["source"]).toBe("replan");
    expect(record["reason"]).toBeUndefined();
    expect(record["replanContext"]).toEqual({ attempt: 1, detail: "gate failed", raw: {} });
  });
});
