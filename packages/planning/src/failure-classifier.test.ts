import { describe, test, expect } from "vitest";
import type { ErrorEnvelope, ErrorLayer } from "@ashara/shared";
import { classifyFailure, shouldEscalate, tryParseEnvelope } from "./failure-classifier.js";
import { FailureRouter } from "./failure-router.js";

function layer(operation: string, message = "error", context?: Record<string, unknown>, cause?: ErrorLayer): ErrorLayer {
  return { boundary: "development", operation, message, context, cause, timestamp: new Date().toISOString() };
}

function envelope(chain: ErrorLayer, overrides: Partial<ErrorEnvelope> = {}): ErrorEnvelope {
  return { outcome: "failed", summary: "test failure", chain, ...overrides };
}

describe("classifyFailure", () => {
  test("TREE_REGRESSION — postMergeVerify operation", () => {
    expect(classifyFailure(envelope(layer("postMergeVerify", "verify failed")))).toBe("TREE_REGRESSION");
  });

  test("a task failing its stored checks post-merge is replanned, not abandoned as a tree regression", () => {
    const category = classifyFailure(envelope(layer("postMergeTaskChecks", "check exited 1")));
    expect(category).toBe("VERIFICATION_GAP");
    const decision = new FailureRouter(2).route({
      item: { id: "task-1" },
      failure: { detail: "Post-merge verify failed", raw: {} },
      priorAttempts: 1,
      category,
    });
    expect(decision).toMatchObject({ action: "replan", attempt: 2 });
  });

  test("VERIFICATION_GAP — entryPointRewriteCheck operation", () => {
    expect(classifyFailure(envelope(layer("entryPointRewriteCheck", "check failed")))).toBe("VERIFICATION_GAP");
  });

  test("COMPILATION_ERROR — compilation errors in agent execution", () => {
    const e = envelope(layer("agentExecution", "compilation fails: error 2345"));
    expect(classifyFailure(e)).toBe("COMPILATION_ERROR");
  });

  test("COMPILATION_ERROR — build failed in summary", () => {
    const e = envelope(
      layer("agentExecution", "agent failed"),
      { summary: "build failed with 3 errors" },
    );
    expect(classifyFailure(e)).toBe("COMPILATION_ERROR");
  });

  test("COMPILATION_ERROR — syntax error", () => {
    const e = envelope(layer("agentExecution", "syntax error in module.ts"));
    expect(classifyFailure(e)).toBe("COMPILATION_ERROR");
  });

  test("AGENT_STUCK — turn limit", () => {
    const e = envelope(layer("agentExecution", "agent hit turn limit after 50 turns"));
    expect(classifyFailure(e)).toBe("AGENT_STUCK");
  });

  test("AGENT_STUCK — nudge exhaustion", () => {
    const e = envelope(layer("agentExecution", "nudge attempts exhausted"));
    expect(classifyFailure(e)).toBe("AGENT_STUCK");
  });

  test("AGENT_STUCK — empty output", () => {
    const e = envelope(layer("agentExecution", "empty output from agent"));
    expect(classifyFailure(e)).toBe("AGENT_STUCK");
  });

  test("AGENT_STUCK — no file changes", () => {
    const e = envelope(layer("agentExecution", "no file changes detected"));
    expect(classifyFailure(e)).toBe("AGENT_STUCK");
  });

  test("AGENT_STUCK — finishReason context", () => {
    const e = envelope(layer("agentExecution", "agent stopped", { finishReason: "turn_limit" }));
    expect(classifyFailure(e)).toBe("AGENT_STUCK");
  });

  test("SPAWN_FAILURE — createWorkdir", () => {
    expect(classifyFailure(envelope(layer("createWorkdir", "failed to create workdir")))).toBe("SPAWN_FAILURE");
  });

  test("SPAWN_FAILURE — createWorktree", () => {
    expect(classifyFailure(envelope(layer("createWorktree", "git worktree add failed")))).toBe("SPAWN_FAILURE");
  });

  test("MERGE_CONFLICT — tentativeMerge with conflict", () => {
    const e = envelope(layer("tentativeMerge", "merge conflict in src/index.ts"));
    expect(classifyFailure(e)).toBe("MERGE_CONFLICT");
  });

  test("SPAWN_FAILURE — tentativeMerge without conflict", () => {
    const e = envelope(layer("tentativeMerge", "merge failed: branch not found"));
    expect(classifyFailure(e)).toBe("SPAWN_FAILURE");
  });

  test("VERIFICATION_GAP — unknown operation (fail-closed)", () => {
    const e = envelope(layer("unknownOp", "something went wrong"));
    expect(classifyFailure(e)).toBe("VERIFICATION_GAP");
  });

  test("classifies via nested cause chain", () => {
    const inner = layer("postMergeVerify", "verify failed");
    const outer = layer("execute", "execution failed", undefined, inner);
    expect(classifyFailure(envelope(outer))).toBe("TREE_REGRESSION");
  });

  test("COMPILATION_ERROR in cause chain takes precedence over outer unknown", () => {
    const inner = layer("agentExecution", "compilation error: type mismatch");
    const outer = layer("execute", "execution wrapper", undefined, inner);
    expect(classifyFailure(envelope(outer))).toBe("COMPILATION_ERROR");
  });
});

describe("shouldEscalate", () => {
  test("VERIFICATION_GAP with prior occurrence → true", () => {
    expect(shouldEscalate("VERIFICATION_GAP", ["VERIFICATION_GAP"])).toBe(true);
  });

  test("AGENT_STUCK with prior occurrence → true", () => {
    expect(shouldEscalate("AGENT_STUCK", ["AGENT_STUCK"])).toBe(true);
  });

  test("VERIFICATION_GAP without prior occurrence → false", () => {
    expect(shouldEscalate("VERIFICATION_GAP", [])).toBe(false);
  });

  test("VERIFICATION_GAP with different prior → false", () => {
    expect(shouldEscalate("VERIFICATION_GAP", ["COMPILATION_ERROR"])).toBe(false);
  });

  test("COMPILATION_ERROR never escalates even with priors", () => {
    expect(shouldEscalate("COMPILATION_ERROR", ["COMPILATION_ERROR"])).toBe(false);
  });

  test("SPAWN_FAILURE never escalates even with priors", () => {
    expect(shouldEscalate("SPAWN_FAILURE", ["SPAWN_FAILURE"])).toBe(false);
  });

  test("MERGE_CONFLICT never escalates even with priors", () => {
    expect(shouldEscalate("MERGE_CONFLICT", ["MERGE_CONFLICT"])).toBe(false);
  });

  test("TREE_REGRESSION never escalates even with priors", () => {
    expect(shouldEscalate("TREE_REGRESSION", ["TREE_REGRESSION"])).toBe(false);
  });

  test("escalatable with mixed priors containing match → true", () => {
    expect(shouldEscalate("AGENT_STUCK", ["COMPILATION_ERROR", "AGENT_STUCK", "SPAWN_FAILURE"])).toBe(true);
  });
});

describe("tryParseEnvelope", () => {
  test("parses valid ErrorEnvelope", () => {
    const raw = {
      outcome: "failed",
      summary: "test failure",
      chain: {
        boundary: "development",
        operation: "postMergeTaskChecks",
        message: "check exited 1",
        timestamp: new Date().toISOString(),
      },
    };
    const result = tryParseEnvelope(raw);
    expect(result).not.toBeNull();
    expect(result!.chain.operation).toBe("postMergeTaskChecks");
  });

  test("returns null for invalid input", () => {
    expect(tryParseEnvelope({ foo: "bar" })).toBeNull();
  });

  test("returns null for missing chain", () => {
    expect(tryParseEnvelope({ outcome: "failed", summary: "test" })).toBeNull();
  });
});
