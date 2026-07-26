import { describe, test, expect } from "vitest";

import { ContractBodySchema, ContractDeltaSchema, normalizePath } from "./contract.js";

// A fully-populated body (every optional present) so round-trip equality is
// unambiguous — no undefined keys to reason about.
const fullBody = {
  knowledge: {
    nodes: [
      { id: "lang", kind: "language", label: "TypeScript" },
      { id: "rt", kind: "runtime", label: "node" },
      { id: "fw", kind: "framework", label: "hono" },
      { id: "pm", kind: "package_manager", label: "npm" },
      { id: "ep", kind: "entry_point", label: "src/index.ts", meta: { mountKind: "http" } },
      { id: "chk", kind: "check", label: "tsc passes", meta: { command: "npx tsc --noEmit" } },
    ],
    edges: [],
  },
  endpoints: [
    {
      ref: "auth.register",
      method: "POST" as const,
      path: "/api/register",
      purpose: "Register a new user",
      sourceModule: "src/routes/auth.ts",
      declaredBy: "11111111-1111-4111-8111-111111111111",
    },
    {
      ref: "todos.list",
      method: "GET" as const,
      path: "/api/todos",
      purpose: "List todos",
      sourceModule: "src/routes/todos.ts",
      declaredBy: "22222222-2222-4222-8222-222222222222",
    },
  ],
  modules: [
    {
      path: "src/db.ts",
      purpose: "Database access layer",
      exports: ["getDb", "migrate"],
      reuseOnly: true,
      providerWorkItem: "33333333-3333-4333-8333-333333333333",
    },
  ],
  mounts: [{ endpointRef: "auth.register", mountedAt: "/api" }],
};

describe("normalizePath — canonical endpoint path form (Run-10 blocker #2)", () => {
  test("unifies OpenAPI {id} and Express :id to the same canonical form", () => {
    expect(normalizePath("/api/todos/{id}")).toBe("/api/todos/:id");
    expect(normalizePath("/api/todos/:id")).toBe("/api/todos/:id");
    expect(normalizePath("/api/todos/{id}")).toBe(normalizePath("/api/todos/:id"));
    // multiple params, named
    expect(normalizePath("/users/{userId}/todos/{id}")).toBe("/users/:userId/todos/:id");
  });

  test("strips a trailing slash except on the root", () => {
    expect(normalizePath("/api/todos/")).toBe("/api/todos");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });

  test("collapses duplicate slashes and adds a missing leading slash", () => {
    expect(normalizePath("/api//todos")).toBe("/api/todos");
    expect(normalizePath("api/todos")).toBe("/api/todos");
  });

  test("is idempotent", () => {
    for (const p of ["/api/todos/{id}", "/api/todos/", "/", "api//x/{y}/"]) {
      expect(normalizePath(normalizePath(p))).toBe(normalizePath(p));
    }
  });
});

describe("normalizePath — strips trailing sentence punctuation (Run-10 blocker #4)", () => {
  test("strips a trailing period captured from prose", () => {
    // The Run-10 shape: "...validates the request body for POST /api/register.
    // Requirements: ..." — the endpoint regex's path char class admits `.` (for
    // genuine path syntax) and swallows the sentence-ending period too.
    expect(normalizePath("/api/register.")).toBe("/api/register");
    expect(normalizePath("/api/login.")).toBe("/api/login");
  });

  test("strips other trailing sentence punctuation and stacked runs", () => {
    expect(normalizePath("/api/register,")).toBe("/api/register");
    expect(normalizePath("/api/register.,")).toBe("/api/register");
  });

  test("leaves a param placeholder's own trailing punctuation stripped too", () => {
    expect(normalizePath("/api/todos/{id}.")).toBe("/api/todos/:id");
  });

  test("a dot with alphanumerics on both sides is NOT sentence punctuation — untouched", () => {
    expect(normalizePath("/files/report.pdf")).toBe("/files/report.pdf");
    expect(normalizePath("/v1.2/items")).toBe("/v1.2/items");
  });

  test("stays idempotent with trailing punctuation in the input", () => {
    for (const p of ["/api/register.", "/api/register,", "/files/report.pdf", "/v1.2/items"]) {
      expect(normalizePath(normalizePath(p))).toBe(normalizePath(p));
    }
  });
});

describe("ContractBodySchema round-trip", () => {
  test("parse -> serialize -> parse is identical", () => {
    const parsed = ContractBodySchema.parse(fullBody);
    const reparsed = ContractBodySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  test("round-trips a minimal body (no optional fields)", () => {
    const minimal = {
      knowledge: {
        nodes: [
          { id: "lang", kind: "language", label: "TypeScript" },
          { id: "rt", kind: "runtime", label: "node" },
          { id: "ep", kind: "entry_point", label: "src/cli.ts", meta: { mountKind: "cli" } },
        ],
        edges: [],
      },
      endpoints: [],
      modules: [{ path: "src/lib.ts", purpose: "core logic", reuseOnly: false }],
      mounts: [],
    };
    const parsed = ContractBodySchema.parse(minimal);
    const reparsed = ContractBodySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });
});

describe("schema rejects malformed input (fail closed at the boundary)", () => {
  test("unknown top-level key is rejected (strict)", () => {
    expect(() => ContractBodySchema.parse({ ...fullBody, extra: true })).toThrow();
  });

  test("invalid HTTP method is rejected", () => {
    const bad = { ...fullBody, endpoints: [{ ...fullBody.endpoints[0], method: "FETCH" }] };
    expect(() => ContractBodySchema.parse(bad)).toThrow();
  });

  test("non-uuid declaredBy is rejected", () => {
    const bad = { ...fullBody, endpoints: [{ ...fullBody.endpoints[0], declaredBy: "not-a-uuid" }] };
    expect(() => ContractBodySchema.parse(bad)).toThrow();
  });

  // ADR-046: knowledge became amendable (seed-once PER KIND, merged in
  // contract-merge.ts) because an empty seed otherwise made the graph
  // permanently empty. Strictness itself is unchanged — an unknown key still
  // fails closed.
  test("delta accepts knowledge and still rejects unknown keys", () => {
    const delta = ContractDeltaSchema.parse({ knowledge: fullBody.knowledge });
    expect(delta.knowledge?.nodes).toEqual(fullBody.knowledge.nodes);
    expect(() => ContractDeltaSchema.parse({ techStack: ["TypeScript"] })).toThrow();
  });

  test("delta accepts additive collections only", () => {
    const delta = ContractDeltaSchema.parse({ endpoints: [fullBody.endpoints[0]] });
    expect(delta.endpoints).toHaveLength(1);
  });
});
