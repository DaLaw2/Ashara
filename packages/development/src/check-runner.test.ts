import { describe, test, expect } from "vitest";

import { isAllowedCheck, isHttpCheck } from "./check-runner.js";

describe("isHttpCheck", () => {
  test("recognizes GET with exact status", () => {
    expect(isHttpCheck("GET /path returns 200")).toBe(true);
  });

  test("recognizes POST with exact status", () => {
    expect(isHttpCheck("POST /api/items returns 201")).toBe(true);
  });

  test("recognizes DELETE with exact status", () => {
    expect(isHttpCheck("DELETE /api/items/1 returns 204")).toBe(true);
  });

  test("recognizes PUT with exact status", () => {
    expect(isHttpCheck("PUT /api/items/1 returns 200")).toBe(true);
  });

  test("recognizes PATCH with exact status", () => {
    expect(isHttpCheck("PATCH /api/items/1 returns 200")).toBe(true);
  });

  test("recognizes HEAD with exact status", () => {
    expect(isHttpCheck("HEAD /health returns 200")).toBe(true);
  });

  test("recognizes range status pattern (3xx)", () => {
    expect(isHttpCheck("GET /:code returns 3xx")).toBe(true);
  });

  test("recognizes range status pattern (2xx)", () => {
    expect(isHttpCheck("POST /api/items returns 2xx")).toBe(true);
  });

  test("recognizes paths with route params", () => {
    expect(isHttpCheck("GET /:code returns 302")).toBe(true);
  });

  test("rejects natural language", () => {
    expect(isHttpCheck("npx tsc --noEmit passes")).toBe(false);
  });

  test("rejects shell commands", () => {
    expect(isHttpCheck("npm test")).toBe(false);
  });

  test("rejects invalid HTTP methods", () => {
    expect(isHttpCheck("FETCH /path returns 200")).toBe(false);
  });

  test("rejects missing path", () => {
    expect(isHttpCheck("GET returns 200")).toBe(false);
  });

  test("rejects non-numeric status", () => {
    expect(isHttpCheck("GET /path returns abc")).toBe(false);
  });

  test("rejects path not starting with /", () => {
    expect(isHttpCheck("GET path returns 200")).toBe(false);
  });
});

describe("isAllowedCheck — HTTP checks pass the allowlist", () => {
  test("HTTP check is allowed", () => {
    expect(isAllowedCheck("GET /path returns 200")).toBe(true);
  });

  test("HTTP check with route params is allowed", () => {
    expect(isAllowedCheck("GET /:code returns 302")).toBe(true);
  });

  test("HTTP check with range status is allowed", () => {
    expect(isAllowedCheck("GET /path returns 3xx")).toBe(true);
  });

  test("shell commands still work", () => {
    expect(isAllowedCheck("npm test")).toBe(true);
    expect(isAllowedCheck("npx tsc --noEmit")).toBe(true);
  });

  test("natural language still rejected", () => {
    expect(isAllowedCheck("npx tsc --noEmit passes")).toBe(false);
  });
});
