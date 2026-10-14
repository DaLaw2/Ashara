import { describe, expect, test } from "vitest";
import { describeErrorChain, serializeError, serializedErrorSchema } from "./error-chain.js";
import { projectBlockCause } from "./work-item-row.js";

class CellExecFailed extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`exec exited ${exitCode}`, options);
    this.name = "CellExecFailed";
  }
}

function threeDeep(stderr = "no such container"): Error {
  const root = new CellExecFailed(["podman", "exec", "c1"], 125, stderr);
  const mid = Object.assign(new Error("check run failed", { cause: root }), { step: "stored-check run" });
  return new TypeError("gate could not run", { cause: mid });
}

describe("serializeError", () => {
  test("a 3-deep chain with typed fields round-trips through the schema as JSON", () => {
    const serialized = serializeError(threeDeep());
    const back = serializedErrorSchema.parse(JSON.parse(JSON.stringify(serialized)));

    expect(back).toEqual(serialized);
    expect(back).toMatchObject({
      name: "TypeError",
      message: "gate could not run",
      cause: {
        name: "Error",
        fields: { step: "stored-check run" },
        cause: { name: "CellExecFailed", fields: { argv: ["podman", "exec", "c1"], exitCode: 125, stderr: "no such container" } },
      },
    });
    expect(back.truncated).toBeUndefined();
    expect(back.cause?.cause?.cause).toBeUndefined();
  });

  test("a chain over the size bound is cut to fit and says so", () => {
    const serialized = serializeError(threeDeep("x".repeat(50_000)), 2_000);

    expect(JSON.stringify(serialized).length).toBeLessThanOrEqual(2_000);
    expect(serialized.truncated).toBe("size");
    expect(serializedErrorSchema.safeParse(serialized).success).toBe(true);
  });

  test("a cyclic cause, an over-deep chain and a thrown non-Error are bounded and never throw", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(serializeError(a)).toMatchObject({ name: "Error", cause: { message: "b", truncated: "cycle" } });

    let deep: Error = new Error("bottom");
    for (let i = 0; i < 20; i++) deep = new Error(`layer ${i}`, { cause: deep });
    expect(describeErrorChain(deep)).toContain("[chain cut: depth]");

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(serializeError(circular)).toMatchObject({ name: "NonError", fields: { type: "object" } });
    expect(describeErrorChain(circular)).toBe('non-Error thrown: {"self":"[circular]"}');
  });

  test("a non-Error object's message, name, stack and cause keys are kept as data, at any depth", () => {
    const pgLike = { code: "E_X", message: "the real reason", name: "PgLikeError", stack: "s", cause: { message: "inner" } };
    expect(describeErrorChain(pgLike)).toBe(`non-Error thrown: ${JSON.stringify(pgLike)}`);

    const plainCause = new Error("outer", { cause: { message: "inner plain cause", code: 7 } });
    expect(describeErrorChain(plainCause)).toBe('Error: outer <- caused by non-Error thrown: {"message":"inner plain cause","code":7}');

    const provider = Object.assign(new Error("Bad Request"), {
      data: { error: { message: "max_tokens too large", type: "invalid_request_error" } },
      detail: { message: "nested msg", stack: "s" },
    });
    expect(serializeError(provider).fields).toEqual({
      data: { error: { message: "max_tokens too large", type: "invalid_request_error" } },
      detail: { message: "nested msg", stack: "s" },
    });
  });

  test("oversized string fields are cut while walked, so neither entry point throws", () => {
    const shared = "s".repeat(9_000_000);
    const wide = Object.assign(new Error("wide"), Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`f${i}`, shared])));
    const newlines = Object.assign(new Error("newlines"), { f: "\n".repeat(270_000_000) });
    for (const err of [wide, newlines]) {
      expect(JSON.stringify(serializeError(err)).length).toBeLessThanOrEqual(64_000);
      expect(describeErrorChain(err)).toMatch(/^Error: (wide|newlines)$/);
    }
    expect(serializeError(wide).truncated).toBe("size");
    expect(serializeError(newlines).fields?.["f"]).toMatch(/\[truncated by Ashara: 16000 of 270000000 characters kept\]$/);
  });

  test("an AggregateError's non-enumerable errors are kept as child errors", () => {
    const agg = new AggregateError(
      [Object.assign(new Error("connect ECONNREFUSED ::1:1"), { code: "ECONNREFUSED" }), new Error("connect ECONNREFUSED 127.0.0.1:1")],
      "",
    );
    const serialized = serializeError(agg);
    expect(serialized.errors?.map((e) => e.message)).toEqual(["connect ECONNREFUSED ::1:1", "connect ECONNREFUSED 127.0.0.1:1"]);
    expect(serialized.errors?.[0]?.fields).toEqual({ code: "ECONNREFUSED" });
    expect(serializedErrorSchema.safeParse(serialized).success).toBe(true);
    expect(describeErrorChain(agg)).toBe(
      "AggregateError:  [2 errors: Error: connect ECONNREFUSED ::1:1; Error: connect ECONNREFUSED 127.0.0.1:1]",
    );

    const many = new AggregateError(Array.from({ length: 40 }, (_, i) => new Error(`e${i}`)), "many");
    expect(serializeError(many)).toMatchObject({ errorsNotKept: 24 });
    expect(serializeError(many).errors).toHaveLength(16);
  });

  test("binary data is described by its size, never enumerated", () => {
    const err = Object.assign(new Error("payload"), { body: Buffer.alloc(30_000_000), view: new Uint8Array(8) });
    const started = performance.now();
    const serialized = serializeError(err);
    expect(performance.now() - started).toBeLessThan(100);
    expect(serialized.fields).toEqual({ body: "[binary 30000000 bytes]", view: "[binary 8 bytes]" });
  });

  test("Errors that reach each other through fields, a throwing getter and a hostile proxy never throw", () => {
    const a: Error & { other?: Error } = new Error("a");
    const b: Error & { other?: Error } = new Error("b");
    a.other = b;
    b.other = a;
    expect(serializeError(a)).toMatchObject({ fields: { other: { name: "Error", message: "b", fields: { other: "[circular]" } } } });
    expect(describeErrorChain(a)).toBe("Error: a");

    const outer: Error & { inner?: Error } = new Error("outer");
    outer.inner = new Error("inner", { cause: outer });
    expect(serializeError(outer)).toMatchObject({ fields: { inner: { message: "inner", cause: "[circular]" } } });

    const getter = new Error("getter");
    Object.defineProperty(getter, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter threw");
      },
    });
    expect(serializeError(getter)).toMatchObject({ message: "getter", fields: { bad: "[unreadable: getter threw]" } });

    const hostile = new Proxy(new Error("p"), {
      ownKeys() {
        throw new Error("ownKeys trap");
      },
      get() {
        throw new Error("get trap");
      },
    });
    expect(() => describeErrorChain(hostile)).not.toThrow();
  });

  test("a single layer with many fields stays within the bound", () => {
    const wide = Object.assign(new Error("wide"), Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, `v${i}`])));
    const serialized = serializeError(wide);
    expect(JSON.stringify(serialized).length).toBeLessThanOrEqual(64_000);
    expect(serialized.fields?.["[more keys]"]).toBe(`${20_000 - 64} not kept`);

    const tight = serializeError(Object.assign(new Error("m".repeat(10_000)), { f: "x".repeat(10_000) }), 300);
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(300);
    expect(tight.truncated).toBe("size");
  });
});

describe("the one-line rendering", () => {
  test("a project's block reason carries every layer of the chain", () => {
    const cause = projectBlockCause(threeDeep());

    expect(cause.errorClass).toBe("TypeError");
    expect(cause.reason).toBe(
      "TypeError: gate could not run <- caused by Error: check run failed <- caused by CellExecFailed: exec exited 125",
    );
  });
});
