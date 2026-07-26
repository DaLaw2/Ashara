import { describe, expect, test } from "vitest";

import { parseProjectId } from "@ashara/shared";
import type { ProductObservation, ProjectContract } from "@ashara/shared";

import { runAcceptanceCheck } from "./termination-snapshot.js";
import type { AcceptanceCheckDeps } from "./termination-snapshot.js";

// ---------------------------------------------------------------------------
// E2E Run 39, verbatim: "Run completed — vision acceptance check confirmed all
// requirements are met. ... 5 coverage gap(s) left undone: Implement 'jot list'
// ... Implement 'jot search'". The product agreed with the second half.
// ---------------------------------------------------------------------------

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const VISION_TEXT = "A note-taking CLI: jot add, jot list, jot search.";

/** What observe.ts returns for Run 39's Go CLI: it cannot probe a non-HTTP product. */
const GO_CLI: ProductObservation = {
  kind: "not-observable",
  cause: "no-declared-surface",
  detail: "the project declares no HTTP endpoint, and this observer probes nothing else",
};

const ENDPOINT = { ref: "list-notes", method: "GET", path: "/notes", purpose: "list notes" } as const;

const CONTRACT: ProjectContract = {
  projectId: parseProjectId(ROOT_ID),
  version: 1,
  endpoints: [ENDPOINT],
  modules: [],
  mounts: [],
  excludePaths: [],
  knowledge: { nodes: [], edges: [] },
};

function llmFinding(...evidence: string[]): AcceptanceCheckDeps["acceptanceLlm"] {
  return {
    checkVisionGaps: async () => ({
      gaps: evidence.map((e) => ({ title: e, description: `Implement '${e}'`, visionEvidence: e })),
      reasoning: "",
    }),
  };
}

function baseDeps(overrides: Partial<AcceptanceCheckDeps> = {}): AcceptanceCheckDeps {
  return {
    config: { maxAcceptanceAttempts: 2 },
    visionRepo: { getLatest: async () => ({ visionText: VISION_TEXT, projectPath: "/tmp/jot" }) },
    workItemRepo: { listAll: async () => [{ id: ROOT_ID }] },
    contractRepo: { getLatest: async () => CONTRACT },
    acceptanceLlm: llmFinding("jot search"),
    observeProduct: async () => GO_CLI,
    acceptanceAttempts: 1,
    ...overrides,
  };
}

const SHIPPED = [{ id: ROOT_ID, title: "jot add", status: "Completed" }];

describe("path 1: the attempt cap", () => {
  test("the Run 39 trace — cap reached on re-entry yields unverified, not accepted", async () => {
    // Attempt 1 already spent, so this evaluation lands exactly on the cap.
    const deps = baseDeps({ acceptanceAttempts: 1 });

    const first = await runAcceptanceCheck(deps, SHIPPED);
    expect(first.outcome).toBe("accepted-with-caveats");
    expect(first.gaps).toHaveLength(1);
    expect(deps.acceptanceAttempts).toBe(2);

    // runner.ts:145 — "Termination (accepted-with-caveats) superseded by
    // newly-arrived work (NOTIFY); re-cycling instead of stopping". Same deps
    // object, re-entered; the cap guard now fires.
    const second = await runAcceptanceCheck(deps, SHIPPED);

    expect(second.outcome).toBe("unverified");
    expect(second.unverifiedReason).toContain("attempts-exhausted");
  });

  test("the cap carries the last completed check's gaps instead of publishing none", async () => {
    const deps = baseDeps({ acceptanceAttempts: 1 });

    await runAcceptanceCheck(deps, SHIPPED);
    const second = await runAcceptanceCheck(deps, SHIPPED);

    expect(second.gaps).toHaveLength(1);
    expect(second.unverifiedReason).toContain("last completed check left 1 gap(s) open");
  });

  test("a cap hit with no earlier check says so rather than implying a clean one", async () => {
    const deps = baseDeps({ acceptanceAttempts: 2 });

    const verdict = await runAcceptanceCheck(deps, SHIPPED);

    expect(verdict.outcome).toBe("unverified");
    expect(verdict.gaps).toEqual([]);
    expect(verdict.unverifiedReason).toContain("no earlier check left findings");
  });
});

describe("path 4: a tier that does not run", () => {
  test("an unwired product observer is recorded, not assumed to have passed", async () => {
    const deps = baseDeps({ acceptanceAttempts: 0, observeProduct: undefined, acceptanceLlm: llmFinding() });

    const verdict = await runAcceptanceCheck(deps, SHIPPED);

    expect(verdict.outcome).toBe("unverified");
    expect(verdict.unverifiedReason).toContain("no product observer is wired");
  });

  test("a vision with no projectPath leaves the deterministic tier unrun and unclaimed", async () => {
    const deps = baseDeps({
      acceptanceAttempts: 0,
      acceptanceLlm: llmFinding(),
      visionRepo: { getLatest: async () => ({ visionText: VISION_TEXT, projectPath: null }) },
    });

    const verdict = await runAcceptanceCheck(deps, SHIPPED);

    expect(verdict.outcome).toBe("unverified");
    expect(verdict.unverifiedReason).toContain("no product to observe");
  });

  test("an unwired acceptance LLM is recorded even when the deterministic tier is clean", async () => {
    const deps = baseDeps({
      acceptanceAttempts: 0,
      acceptanceLlm: undefined,
      observeProduct: async () => ({
        kind: "booted",
        port: 3000,
        endpoints: [{ method: "GET", path: "/notes", status: 200, detail: "HTTP 200" }],
        bootOutput: "",
      }),
    });

    const verdict = await runAcceptanceCheck(deps, SHIPPED);

    expect(verdict.outcome).toBe("unverified");
    expect(verdict.unverifiedReason).toContain("no acceptance LLM is wired");
  });
});

describe("accepted stays reachable", () => {
  test("both tiers ran, every declared endpoint was probed, nothing was found", async () => {
    const deps = baseDeps({
      acceptanceAttempts: 0,
      acceptanceLlm: llmFinding(),
      observeProduct: async () => ({
        kind: "booted",
        port: 3000,
        endpoints: [{ method: "GET", path: "/notes", status: 200, detail: "HTTP 200" }],
        bootOutput: "",
      }),
    });

    const verdict = await runAcceptanceCheck(deps, SHIPPED);

    expect(verdict.outcome).toBe("accepted");
    expect(verdict.unverifiedReason).toBeUndefined();
  });
});
