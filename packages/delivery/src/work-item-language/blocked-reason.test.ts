import { describe, test, expect, expectTypeOf } from "vitest";
import { BLOCKED_REASON_SOURCES, blockedReasonToRecord, parseStoredBlockedReason, BlockedReasonCorrupt } from "./blocked-reason.js";
import type { StoredBlockedReason } from "./blocked-reason.js";

describe("parseStoredBlockedReason", () => {
  test("null and undefined return undefined (policy default: items without a reason)", () => {
    expect(parseStoredBlockedReason(null)).toBeUndefined();
    expect(parseStoredBlockedReason(undefined)).toBeUndefined();
  });

  test("a non-object value throws BlockedReasonCorrupt with structured context, a number too (not silently coerced)", () => {
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

  test("failure_given_up variant round-trips with all optional fields", () => {
    const input = {
      source: "failure_given_up",
      reason: "retry_budget_exhausted",
      attempts: 3,
      lastFailure: { detail: "gate failed", raw: {} },
      detail: "error detail",
    };
    const result = parseStoredBlockedReason(input);
    expect(result).toBeDefined();
    expect(result!.source).toBe("failure_given_up");
    if (result!.source === "failure_given_up") {
      expect(result!.reason).toBe("retry_budget_exhausted");
      expect(result!.attempts).toBe(3);
      expect(result!.detail).toBe("error detail");
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

describe("stored blocked reason schema", () => {
  test("replan variant rejects missing replanContext", () => {
    expect(() => parseStoredBlockedReason({ source: "replan" })).toThrow(BlockedReasonCorrupt);
  });
});

describe("blockedReasonToRecord", () => {
  test("preserves all typed fields on failure_given_up variant", () => {
    const reason: StoredBlockedReason = {
      source: "failure_given_up",
      reason: "retry exhausted",
      attempts: 3,
      lastFailure: { detail: "gate failed" },
    };
    const record = blockedReasonToRecord(reason);
    expect(record["source"]).toBe("failure_given_up");
    expect(record["reason"]).toBe("retry exhausted");
    expect(record["attempts"]).toBe(3);
    expect(record["lastFailure"]).toEqual({ detail: "gate failed" });
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

describe("BLOCKED_REASON_SOURCES", () => {
  test("names every source a stored reason can carry, each once", () => {
    // Its `satisfies` admits no member that is not a source; this is the converse, checked by tsc.
    expectTypeOf<(typeof BLOCKED_REASON_SOURCES)[number]>().toEqualTypeOf<StoredBlockedReason["source"]>();
    expect(new Set(BLOCKED_REASON_SOURCES).size).toBe(BLOCKED_REASON_SOURCES.length);
  });
});
