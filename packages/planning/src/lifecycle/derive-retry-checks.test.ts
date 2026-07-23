import { describe, it, expect } from "vitest";
import { deriveRetryChecks, deriveRetryDeliverables } from "./derive-retry-checks.js";
import type { RawFailureContext } from "../failure-router.js";

function failure(detail: string, raw: Record<string, unknown> = {}): RawFailureContext {
  return { detail, raw };
}

describe("deriveRetryChecks", () => {
  it("returns existing checks unchanged when no HTTP failures found", () => {
    const existing = ["npx tsc --noEmit"];
    const result = deriveRetryChecks(failure("tsc failed with 3 errors"), existing);
    expect(result).toEqual(["npx tsc --noEmit"]);
  });

  it("extracts check from check-runner output format in detail", () => {
    const result = deriveRetryChecks(
      failure("GET /:code -> 404 (expected 302)"),
      [],
    );
    expect(result).toEqual(["GET /:code returns 302"]);
  });

  it("extracts check from narrative 'returned' pattern", () => {
    const result = deriveRetryChecks(
      failure("GET /:code returned 404"),
      [],
    );
    expect(result).toEqual(["GET /:code returns 2xx"]);
  });

  it("extracts check from unicode arrow pattern", () => {
    const result = deriveRetryChecks(
      failure("GET /:code → 404"),
      [],
    );
    expect(result).toEqual(["GET /:code returns 2xx"]);
  });

  it("deduplicates against existing checks", () => {
    const existing = ["GET /:code returns 302"];
    const result = deriveRetryChecks(
      failure("GET /:code -> 404 (expected 302)"),
      existing,
    );
    expect(result).toEqual(["GET /:code returns 302"]);
  });

  it("merges new checks with existing ones", () => {
    const existing = ["npx tsc --noEmit"];
    const result = deriveRetryChecks(
      failure("GET /api/items -> 500 (expected 2xx)"),
      existing,
    );
    expect(result).toEqual(["npx tsc --noEmit", "GET /api/items returns 2xx"]);
  });

  it("extracts from error chain in raw", () => {
    const result = deriveRetryChecks(
      failure("gate failed", {
        chain: {
          boundary: "development",
          operation: "smoke",
          message: "GET /health -> 503 (expected 200)",
        },
      }),
      [],
    );
    expect(result).toEqual(["GET /health returns 200"]);
  });

  it("extracts from gate results with failed checks", () => {
    const result = deriveRetryChecks(
      failure("gate/smoke test failed", {
        gateResults: {
          smoke: {
            tier: {
              status: "fail",
              checks: [
                { name: "GET /api/items returns 200", passed: false, output: "GET /api/items -> 404 (expected 200)" },
                { name: "npx tsc --noEmit", passed: true, output: "" },
              ],
            },
          },
        },
      }),
      [],
    );
    expect(result).toContain("GET /api/items returns 200");
  });

  it("handles multiple HTTP failures in one detail string", () => {
    const detail = "GET /a -> 404 (expected 200)\nPOST /b -> 500 (expected 201)";
    const result = deriveRetryChecks(failure(detail), []);
    expect(result).toEqual(["GET /a returns 200", "POST /b returns 201"]);
  });

  it("deduplicates when same endpoint appears in detail and raw", () => {
    const result = deriveRetryChecks(
      failure("GET /:code -> 404 (expected 302)", {
        chain: {
          boundary: "development",
          operation: "smoke",
          message: "GET /:code -> 404 (expected 302)",
        },
      }),
      [],
    );
    expect(result).toEqual(["GET /:code returns 302"]);
  });

  it("prefers check-runner format over narrative for same endpoint", () => {
    const detail = "GET /:code -> 404 (expected 302). Also GET /:code returned 404";
    const result = deriveRetryChecks(failure(detail), []);
    expect(result).toEqual(["GET /:code returns 302"]);
  });

  it("handles nested error chain causes", () => {
    const result = deriveRetryChecks(
      failure("task failed", {
        chain: {
          boundary: "orchestrator",
          operation: "process",
          message: "gate failed",
          cause: {
            boundary: "development",
            operation: "smoke",
            message: "POST /api/shorten -> 500 (expected 201)",
          },
        },
      }),
      [],
    );
    expect(result).toEqual(["POST /api/shorten returns 201"]);
  });
});

describe("deriveRetryDeliverables", () => {
  it("returns existing deliverables unchanged when no HTTP failures found", () => {
    const existing = ["Implement the API"];
    const result = deriveRetryDeliverables(failure("tsc failed"), existing);
    expect(result).toEqual(["Implement the API"]);
  });

  it("derives deliverable from HTTP failure", () => {
    const result = deriveRetryDeliverables(
      failure("GET /:code -> 404 (expected 302)"),
      [],
    );
    expect(result).toEqual(["Route GET /:code must be mounted and respond with HTTP 302"]);
  });

  it("merges with existing deliverables", () => {
    const existing = ["Implement redirect endpoint"];
    const result = deriveRetryDeliverables(
      failure("GET /:code -> 404 (expected 302)"),
      existing,
    );
    expect(result).toEqual([
      "Implement redirect endpoint",
      "Route GET /:code must be mounted and respond with HTTP 302",
    ]);
  });

  it("deduplicates deliverables", () => {
    const existing = ["Route GET /:code must be mounted and respond with HTTP 302"];
    const result = deriveRetryDeliverables(
      failure("GET /:code -> 404 (expected 302)"),
      existing,
    );
    expect(result).toEqual(["Route GET /:code must be mounted and respond with HTTP 302"]);
  });
});
