import { describe, expect, test } from "vitest";

import type { ProductObservation, ProjectContract } from "@ashara/shared";
import { parseProjectId } from "@ashara/shared";

import { buildDeterministicGaps } from "./acceptance.js";

// ---------------------------------------------------------------------------
// Run 39 opened an acceptance gap titled "process boots and responds to HTTP"
// against a note-taking CLI. The expectation becomes the gap task's title
// verbatim, so a fixed HTTP string is a demand the project can never satisfy.
// ---------------------------------------------------------------------------

const NOT_BOOTED: ProductObservation = {
  booted: false,
  port: null,
  endpoints: [],
  bootOutput: "no package.json",
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

describe("boot expectation", () => {
  test("does not demand HTTP from a project that declares no endpoints", () => {
    const gaps = buildDeterministicGaps(NOT_BOOTED, contractWith([]));

    expect(gaps).toHaveLength(1);
    expect(gaps[0].expected).not.toMatch(/HTTP/i);
    expect(gaps[0].expected).toBe("the project starts and runs without failing");
  });

  test("does not demand HTTP when there is no contract at all", () => {
    const gaps = buildDeterministicGaps(NOT_BOOTED, null);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].expected).not.toMatch(/HTTP/i);
  });

  test("names the declared surface when the project does declare endpoints", () => {
    const gaps = buildDeterministicGaps(NOT_BOOTED, contractWith([ENDPOINT]));

    expect(gaps[0].expected).toContain("1 endpoint(s)");
  });

  test("an out-of-scope endpoint does not resurrect the HTTP demand", () => {
    const gaps = buildDeterministicGaps(NOT_BOOTED, contractWith([{ ...ENDPOINT, outOfScope: true }]));

    expect(gaps[0].expected).toBe("the project starts and runs without failing");
  });

  test("carries the observed boot failure rather than an empty string", () => {
    const gaps = buildDeterministicGaps({ ...NOT_BOOTED, bootOutput: "" }, null);

    expect(gaps[0].observed).toBe("the boot attempt produced no output");
  });
});

describe("endpoint probing is scoped to declared HTTP surfaces", () => {
  test("a booted project with no declared endpoints yields no endpoint gaps", () => {
    const observation: ProductObservation = {
      booted: true,
      port: 3000,
      endpoints: [{ method: "GET", path: "/", status: 404, detail: "HTTP 404" }],
      bootOutput: "started",
    };

    expect(buildDeterministicGaps(observation, contractWith([]))).toEqual([]);
  });

  test("a declared endpoint that probes 404 is still reported as not mounted", () => {
    const observation: ProductObservation = {
      booted: true,
      port: 3000,
      endpoints: [{ method: "GET", path: "/notes", status: 404, detail: "HTTP 404" }],
      bootOutput: "started",
    };

    const gaps = buildDeterministicGaps(observation, contractWith([ENDPOINT]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("not-mounted");
  });
});
