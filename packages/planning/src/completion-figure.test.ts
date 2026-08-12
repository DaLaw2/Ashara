import { describe, expect, test } from "vitest";
import type { ProjectContract } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";
import { computeCompletionFigure } from "./completion-figure.js";
import type { CompletionEvidence, CompletionFigure } from "./completion-figure.js";

const PROJECT_ID = parseProjectId("11111111-1111-4111-8111-111111111111");

function makeContract(
  overrides: Partial<ProjectContract> = {},
): ProjectContract {
  return {
    projectId: PROJECT_ID,
    version: 1,
    endpoints: [],
    modules: [],
    mounts: [],
    excludePaths: [],
    knowledge: { nodes: [], edges: [] },
    ...overrides,
  };
}

const EMPTY_EVIDENCE: CompletionEvidence = {};

describe("computeCompletionFigure", () => {
  test("null contract returns unknown", () => {
    const result = computeCompletionFigure(null, EMPTY_EVIDENCE);
    expect(result).toEqual({
      kind: "unknown",
      reason: "no contract available",
    });
  });

  test("empty contract (no measurable items) returns unknown", () => {
    const contract = makeContract();
    const result = computeCompletionFigure(contract, EMPTY_EVIDENCE);
    expect(result).toEqual({
      kind: "unknown",
      reason: "contract declares no measurable items",
    });
  });

  test("3 endpoints, 2 satisfied yields ratio 2/3", () => {
    const contract = makeContract({
      endpoints: [
        { ref: "list", method: "GET", path: "/items", purpose: "list items" },
        { ref: "create", method: "POST", path: "/items", purpose: "create item" },
        { ref: "delete", method: "DELETE", path: "/items/:id", purpose: "delete item" },
      ],
    });
    const evidence: CompletionEvidence = {
      endpointProbes: new Map([
        ["list", { status: 200 }],
        ["create", { status: 201 }],
        ["delete", { status: 500 }],
      ]),
    };
    const result = computeCompletionFigure(contract, evidence);
    expect(result.kind).toBe("measured");
    const m = result as Extract<CompletionFigure, { kind: "measured" }>;
    expect(m.numerator).toBe(2);
    expect(m.denominator).toBe(3);
    expect(m.ratio).toBeCloseTo(2 / 3);
    expect(m.basis).toHaveLength(3);
  });

  test("mixed checks and endpoints with partial evidence", () => {
    const contract = makeContract({
      endpoints: [
        { ref: "health", method: "GET", path: "/health", purpose: "health check" },
      ],
      knowledge: {
        nodes: [
          {
            id: "c1",
            kind: "check",
            label: "type check",
            meta: { command: ["npm", "run", "typecheck"] },
          },
          {
            id: "c2",
            kind: "check",
            label: "lint",
            meta: { command: ["npm", "run", "lint"] },
          },
        ],
        edges: [],
      },
    });
    const evidence: CompletionEvidence = {
      endpointProbes: new Map([["health", { status: 200 }]]),
      checkResults: new Map([["npm run typecheck", true]]),
      // lint result absent — fail-closed
    };
    const result = computeCompletionFigure(contract, evidence);
    expect(result.kind).toBe("measured");
    const m = result as Extract<CompletionFigure, { kind: "measured" }>;
    // health OK + typecheck OK = 2 satisfied out of 3
    expect(m.numerator).toBe(2);
    expect(m.denominator).toBe(3);
    expect(m.ratio).toBeCloseTo(2 / 3);
  });

  test("no evidence for any item yields ratio 0 (measured, not unknown)", () => {
    const contract = makeContract({
      endpoints: [
        { ref: "a", method: "GET", path: "/a", purpose: "endpoint a" },
      ],
      modules: [
        { path: "src/main.ts", purpose: "entry point", reuseOnly: false },
      ],
    });
    const result = computeCompletionFigure(contract, EMPTY_EVIDENCE);
    expect(result.kind).toBe("measured");
    const m = result as Extract<CompletionFigure, { kind: "measured" }>;
    expect(m.numerator).toBe(0);
    expect(m.denominator).toBe(2);
    expect(m.ratio).toBe(0);
    expect(m.basis.every((b) => !b.satisfied)).toBe(true);
  });

  test("outOfScope endpoints excluded from denominator", () => {
    const contract = makeContract({
      endpoints: [
        { ref: "in-scope", method: "GET", path: "/ok", purpose: "relevant" },
        { ref: "excluded", method: "GET", path: "/nope", purpose: "irrelevant", outOfScope: true },
      ],
    });
    const evidence: CompletionEvidence = {
      endpointProbes: new Map([["in-scope", { status: 200 }]]),
    };
    const result = computeCompletionFigure(contract, evidence);
    expect(result.kind).toBe("measured");
    const m = result as Extract<CompletionFigure, { kind: "measured" }>;
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(1);
    expect(m.ratio).toBe(1);
    // The outOfScope endpoint must not appear in basis at all
    expect(m.basis.find((b) => b.label === "excluded")).toBeUndefined();
  });

  test("reuseOnly modules excluded from denominator", () => {
    const contract = makeContract({
      modules: [
        { path: "src/app.ts", purpose: "app", reuseOnly: false },
        { path: "src/shared.ts", purpose: "shared lib", reuseOnly: true },
      ],
    });
    const evidence: CompletionEvidence = {
      moduleExistence: new Map([
        ["src/app.ts", true],
        ["src/shared.ts", true],
      ]),
    };
    const result = computeCompletionFigure(contract, evidence);
    expect(result.kind).toBe("measured");
    const m = result as Extract<CompletionFigure, { kind: "measured" }>;
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(1);
    expect(m.basis.find((b) => b.label === "src/shared.ts")).toBeUndefined();
  });

  test("check nodes without a command array are not counted", () => {
    const contract = makeContract({
      knowledge: {
        nodes: [
          {
            id: "c1",
            kind: "check",
            label: "manual review",
            meta: { criterion: "looks good" },
            // no command — criterion-only, not measurable
          },
          {
            id: "c2",
            kind: "check",
            label: "build",
            meta: { command: ["make", "build"] },
          },
        ],
        edges: [],
      },
    });
    const evidence: CompletionEvidence = {
      checkResults: new Map([["make build", true]]),
    };
    const result = computeCompletionFigure(contract, evidence);
    expect(result.kind).toBe("measured");
    const m = result as Extract<CompletionFigure, { kind: "measured" }>;
    // Only the node with a command is counted
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(1);
  });
});
