import { describe, test, expect } from "vitest";
import { ContractBodySchema, ContractDeltaSchema } from "./contract.js";

const body = {
  knowledge: {
    nodes: [
      { id: "lang", kind: "language", label: "TypeScript" },
      { id: "ep", kind: "entry_point", label: "src/index.ts", meta: { mountKind: "http" } },
    ],
    edges: [],
  },
};

describe("ContractBodySchema", () => {
  test("parse -> serialize -> parse is identical", () => {
    const parsed = ContractBodySchema.parse(body);
    const reparsed = ContractBodySchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  // t-cut-w8: the body is knowledge-only and strict, so a row still carrying
  // the retired HTTP registries fails closed instead of riding along unread.
  test("rejects the retired endpoint/module/mount registries", () => {
    for (const key of ["endpoints", "modules", "mounts", "excludePaths"]) {
      expect(() => ContractBodySchema.parse({ ...body, [key]: [] })).toThrow();
    }
  });
});

describe("ContractDeltaSchema", () => {
  test("accepts knowledge and rejects unknown keys", () => {
    const delta = ContractDeltaSchema.parse({ knowledge: body.knowledge });
    expect(delta.knowledge.nodes).toEqual(body.knowledge.nodes);
    expect(() => ContractDeltaSchema.parse({ knowledge: body.knowledge, endpoints: [] })).toThrow();
  });
});
