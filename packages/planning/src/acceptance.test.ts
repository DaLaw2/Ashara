import { describe, expect, test } from "vitest";
import type { ProductObservation, ProjectContract } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";
import { assessProductObservation, buildAcceptanceVerdict } from "./acceptance.js";

// ---------------------------------------------------------------------------
// Run 39 told its owner "all requirements are met" while listing the ones that
// were not. Every test here pins one of the ways a NON-observation used to be
// encoded as a clean observation.
// ---------------------------------------------------------------------------

const NOT_OBSERVABLE: ProductObservation = {
  kind: "not-observable",
  cause: "no-declared-surface",
  detail: "the project declares no HTTP endpoint, and this observer probes nothing else",
};

const BOOT_FAILED: ProductObservation = {
  kind: "boot-failed",
  detail: "the process exited instead of serving",
};

function contractWith(endpoints: ProjectContract["endpoints"]): ProjectContract {
  return {
    projectId: parseProjectId("11111111-1111-4111-8111-111111111111"),
    version: 1,
    endpoints,
    modules: [],
    mounts: [],
    excludePaths: [],
    knowledge: { nodes: [], edges: [] },
  };
}

const ENDPOINT = {
  ref: "list-notes",
  method: "GET",
  path: "/notes",
  purpose: "list notes",
} as const;

function booted(
  head: { method: string; path: string; status: number | null; detail: string },
  ...rest: Array<{ method: string; path: string; status: number | null; detail: string }>
): ProductObservation {
  return { kind: "booted", port: 3000, endpoints: [head, ...rest] };
}

describe("boot expectation", () => {
  test("does not demand HTTP from a project that declares no endpoints", () => {
    const { gaps } = assessProductObservation(BOOT_FAILED, contractWith([]));

    expect(gaps).toHaveLength(1);
    expect(gaps[0].expected).not.toMatch(/HTTP/i);
    expect(gaps[0].expected).toBe("the project starts and runs without failing");
  });

  test("names the declared surface when the project does declare endpoints", () => {
    const { gaps } = assessProductObservation(BOOT_FAILED, contractWith([ENDPOINT]));

    expect(gaps[0].expected).toContain("1 endpoint(s)");
  });

  test("an out-of-scope endpoint does not resurrect the HTTP demand", () => {
    const { gaps } = assessProductObservation(BOOT_FAILED, contractWith([{ ...ENDPOINT, outOfScope: true }]));

    expect(gaps[0].expected).toBe("the project starts and runs without failing");
  });
});

// --- Path 2: a missing contract used to yield zero gaps -------------------
describe("a missing contract is unchecked, not clean", () => {
  test("no contract produces no gaps but records that nothing declared the standard", () => {
    const { gaps, unchecked } = assessProductObservation(booted({ method: "GET", path: "/", status: 200, detail: "HTTP 200" }), null);

    expect(gaps).toEqual([]);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toContain("no ProjectContract exists");
  });

  test("a boot failure with no contract is still a gap, and still unchecked", () => {
    const { gaps, unchecked } = assessProductObservation(BOOT_FAILED, null);

    expect(gaps).toHaveLength(1);
    expect(unchecked).toHaveLength(1);
  });
});

// --- Path 3: a declared endpoint that was never probed --------------------
describe("an unprobed endpoint is unchecked, not healthy", () => {
  test("a declared endpoint missing from the observation is reported as unknown, not silence", () => {
    const observation = booted({ method: "GET", path: "/other", status: 200, detail: "HTTP 200" });

    const { gaps, unchecked } = assessProductObservation(observation, contractWith([ENDPOINT]));

    expect(gaps).toEqual([]);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toContain("GET /notes");
    expect(unchecked[0]).toContain("never probed");
  });

  test("a declared endpoint that probes 404 is evidence, not ignorance", () => {
    const observation = booted({ method: "GET", path: "/notes", status: 404, detail: "HTTP 404" });

    const { gaps, unchecked } = assessProductObservation(observation, contractWith([ENDPOINT]));

    expect(unchecked).toEqual([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("not-mounted");
  });
});

// --- The observe.ts root cause: "I could not look" is not "it is broken" ---
describe("a product that could not be observed", () => {
  test("produces no gap at all — a refusal is never charged to the product", () => {
    const { gaps, unchecked } = assessProductObservation(NOT_OBSERVABLE, contractWith([]));

    expect(gaps).toEqual([]);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toContain("no-declared-surface");
  });
});

// --- The verdict rule that all of the above feeds ------------------------
describe("buildAcceptanceVerdict", () => {
  test("no gaps AND nothing unchecked is the only route to accepted", () => {
    expect(buildAcceptanceVerdict([], [], 1, 2).outcome).toBe("accepted");
  });

  test("no gaps but something unchecked is unverified, not accepted", () => {
    const verdict = buildAcceptanceVerdict([], ["the product could not be observed"], 1, 2);

    expect(verdict.outcome).toBe("unverified");
    expect(verdict.unverifiedReason).toContain("check-incomplete");
    expect(verdict.unverifiedReason).toContain("could not be observed");
  });

  test("gaps below the cap are rejected so the loop can act on them", () => {
    const gaps = [{ ref: "r", kind: "missing-feature" as const, expected: "e", observed: "o" }];

    expect(buildAcceptanceVerdict(gaps, [], 1, 2).outcome).toBe("rejected");
  });

  test("gaps at the cap reach accepted-with-caveats — the branch the empty list made unreachable", () => {
    const gaps = [{ ref: "r", kind: "missing-feature" as const, expected: "e", observed: "o" }];

    expect(buildAcceptanceVerdict(gaps, [], 2, 2).outcome).toBe("accepted-with-caveats");
  });
});
