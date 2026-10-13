import { describe, test, expect } from "vitest";
import {
  errorEnvelopeSchema,
  wrapError,
  flattenChain,
  renderChainForBrief,
} from "./error-envelope.js";
import type { ErrorLayer, ErrorEnvelope } from "./error-envelope.js";

// The layer schema is file-local; a layer is exercised as an envelope's chain.
function envelopeWithChain(chain: unknown): unknown {
  return { outcome: "failed", summary: "s", chain };
}

describe("error layer schema (via envelope chain)", () => {
  test("parses a minimal layer", () => {
    const layer = {
      boundary: "agent-runner",
      operation: "gateway.complete",
      message: "rate limit exceeded",
      timestamp: "2026-07-23T00:00:00.000Z",
    };
    const result = errorEnvelopeSchema.safeParse(envelopeWithChain(layer));
    expect(result.success).toBe(true);
    expect(result.data?.chain).toEqual(layer);
  });

  test("round-trips a nested chain through JSON", () => {
    const inner: ErrorLayer = {
      boundary: "origin",
      operation: "smokeTest",
      message: "missing endpoint POST /api/users",
      context: { exitCode: 1 },
      timestamp: "2026-07-23T00:00:00.000Z",
    };
    const outer: ErrorLayer = {
      boundary: "development",
      operation: "finalize",
      message: "gate failed",
      cause: inner,
      timestamp: "2026-07-23T00:01:00.000Z",
    };

    const serialized = JSON.stringify(outer);
    const parsed = errorEnvelopeSchema.parse(envelopeWithChain(JSON.parse(serialized))).chain;
    expect(parsed.boundary).toBe("development");
    expect(parsed.cause?.boundary).toBe("origin");
    expect(parsed.cause?.context).toEqual({ exitCode: 1 });
  });

  test("rejects missing required fields", () => {
    const result = errorEnvelopeSchema.safeParse(envelopeWithChain({ boundary: "x" }));
    expect(result.success).toBe(false);
  });

  test("parses 3+ layer deep nesting", () => {
    const layer3: ErrorLayer = {
      boundary: "origin",
      operation: "Error",
      message: "ECONNREFUSED",
      timestamp: "2026-07-23T00:00:00.000Z",
    };
    const layer2: ErrorLayer = {
      boundary: "agent-runner",
      operation: "gateway.complete",
      message: "LLM call failed",
      cause: layer3,
      timestamp: "2026-07-23T00:01:00.000Z",
    };
    const layer1: ErrorLayer = {
      boundary: "development",
      operation: "execute",
      message: "execution error",
      cause: layer2,
      timestamp: "2026-07-23T00:02:00.000Z",
    };

    const parsed = errorEnvelopeSchema.parse(envelopeWithChain(JSON.parse(JSON.stringify(layer1)))).chain;
    expect(parsed.cause?.cause?.message).toBe("ECONNREFUSED");
  });
});

describe("errorEnvelopeSchema", () => {
  test("round-trips a full envelope", () => {
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: "gate/smoke test failed for task-123",
      chain: {
        boundary: "development",
        operation: "finalizeSuccess",
        message: "smoke test failed",
        context: { taskId: "task-123" },
        timestamp: "2026-07-23T00:00:00.000Z",
      },
      agentOutput: { filesChanged: ["src/routes.ts"] },
    };

    const parsed = errorEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(parsed.outcome).toBe("failed");
    expect(parsed.chain.context?.taskId).toBe("task-123");
  });
});

describe("wrapError", () => {
  test("wraps a plain string", () => {
    const layer = wrapError("orchestrator", "processTask", "something broke");
    expect(layer.boundary).toBe("orchestrator");
    expect(layer.operation).toBe("processTask");
    expect(layer.message).toBe("something broke");
    expect(layer.cause).toBeUndefined();
    expect(layer.timestamp).toBeTruthy();
  });

  test("wraps a standard Error", () => {
    const err = new Error("connection refused");
    const layer = wrapError("agent-runner", "gateway.complete", err);
    expect(layer.message).toBe("connection refused");
    expect(layer.cause).toBeUndefined();
  });

  test("wraps an Error with structured context as cause", () => {
    class AgentSpawnError extends Error {
      context: Record<string, unknown>;
      constructor(message: string, context: Record<string, unknown>) {
        super(message);
        this.name = "AgentSpawnError";
        this.context = context;
      }
    }
    const inner = new AgentSpawnError("spawn failed", { pid: 1234 });
    const layer = wrapError("development", "execute", inner, { taskId: "t-1" });

    expect(layer.message).toBe("spawn failed");
    expect(layer.context).toEqual({ taskId: "t-1" });
    expect(layer.cause).toBeDefined();
    expect(layer.cause?.boundary).toBe("origin");
    expect(layer.cause?.operation).toBe("AgentSpawnError");
    expect(layer.cause?.context).toEqual({ pid: 1234 });
  });

  test("wraps an existing ErrorLayer as cause", () => {
    const inner: ErrorLayer = {
      boundary: "agent-runner",
      operation: "gateway.complete",
      message: "rate limit",
      timestamp: "2026-07-23T00:00:00.000Z",
    };
    const layer = wrapError("development", "execute", inner);

    expect(layer.message).toBe("rate limit");
    expect(layer.cause).toBeDefined();
    expect(layer.cause?.boundary).toBe("agent-runner");
  });

  test("includes context when provided", () => {
    const layer = wrapError("dev", "op", "err", { attempt: 3, taskId: "t-5" });
    expect(layer.context).toEqual({ attempt: 3, taskId: "t-5" });
  });
});

describe("flattenChain", () => {
  test("flattens a single layer", () => {
    const layer: ErrorLayer = {
      boundary: "a",
      operation: "op",
      message: "m",
      timestamp: "2026-07-23T00:00:00.000Z",
    };
    expect(flattenChain(layer)).toEqual([layer]);
  });

  test("flattens outermost first", () => {
    const inner: ErrorLayer = {
      boundary: "inner",
      operation: "op3",
      message: "root cause",
      timestamp: "2026-07-23T00:00:00.000Z",
    };
    const mid: ErrorLayer = {
      boundary: "mid",
      operation: "op2",
      message: "mid failure",
      cause: inner,
      timestamp: "2026-07-23T00:01:00.000Z",
    };
    const outer: ErrorLayer = {
      boundary: "outer",
      operation: "op1",
      message: "top failure",
      cause: mid,
      timestamp: "2026-07-23T00:02:00.000Z",
    };

    const flat = flattenChain(outer);
    expect(flat).toHaveLength(3);
    expect(flat[0]!.boundary).toBe("outer");
    expect(flat[1]!.boundary).toBe("mid");
    expect(flat[2]!.boundary).toBe("inner");
  });
});

describe("renderChainForBrief", () => {
  test("renders single-layer envelope", () => {
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: "test failed",
      chain: {
        boundary: "dev",
        operation: "smokeTest",
        message: "missing endpoint",
        context: { exitCode: 1 },
        timestamp: "2026-07-23T00:00:00.000Z",
      },
    };

    const output = renderChainForBrief(envelope);
    expect(output).toContain("# Error Chain (1 layer)");
    expect(output).toContain("[dev/smokeTest] missing endpoint");
    expect(output).toContain("exitCode: 1");
  });

  test("renders multi-layer with indentation", () => {
    const envelope: ErrorEnvelope = {
      outcome: "blocked",
      summary: "blocked",
      chain: {
        boundary: "orchestrator",
        operation: "processTask",
        message: "execution failed",
        cause: {
          boundary: "development",
          operation: "finalize",
          message: "gate failed",
          context: { gate: "smoke" },
          cause: {
            boundary: "origin",
            operation: "smokeTest",
            message: "POST /api/users returned 404",
            timestamp: "2026-07-23T00:00:00.000Z",
          },
          timestamp: "2026-07-23T00:01:00.000Z",
        },
        timestamp: "2026-07-23T00:02:00.000Z",
      },
    };

    const output = renderChainForBrief(envelope);
    expect(output).toContain("# Error Chain (3 layers)");
    expect(output).toContain("[orchestrator/processTask] execution failed");
    expect(output).toContain("  [development/finalize] gate failed");
    expect(output).toContain("  gate: smoke");
    expect(output).toContain("    [origin/smokeTest] POST /api/users returned 404");
  });

  test("renders context values as JSON when not strings", () => {
    const envelope: ErrorEnvelope = {
      outcome: "failed",
      summary: "s",
      chain: {
        boundary: "b",
        operation: "o",
        message: "m",
        context: { tags: ["a", "b"], count: 42 },
        timestamp: "2026-07-23T00:00:00.000Z",
      },
    };

    const output = renderChainForBrief(envelope);
    expect(output).toContain('tags: ["a","b"]');
    expect(output).toContain("count: 42");
  });
});
