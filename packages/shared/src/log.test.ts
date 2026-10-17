import { describe, expect, test, vi } from "vitest";
import { wrapError } from "./error-envelope.js";
import { Secret, createLogger, jsonLineSink, logRecordSchema, recordingLogger } from "./log.js";
import type { LogRecord, Logger } from "./log.js";

const AT = Date.UTC(2026, 9, 17, 9, 0, 0, 0);

function lineLogger(minLevel: "debug" | "info" = "debug"): { logger: Logger; lines: string[]; records: () => LogRecord[] } {
  const lines: string[] = [];
  const logger = createLogger({ sink: jsonLineSink((line) => lines.push(line)), clock: { now: () => AT }, minLevel });
  return { logger, lines, records: () => lines.map((line) => logRecordSchema.parse(JSON.parse(line))) };
}

class StoreUnreachable extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super(`store at ${host}:${port} unreachable`);
    this.name = "StoreUnreachable";
  }
}

class LedgerReadFailed extends Error {
  constructor(
    readonly ledger: string,
    options: ErrorOptions,
  ) {
    super(`ledger ${ledger} could not be read`, options);
    this.name = "LedgerReadFailed";
  }
}

class AdmissionRefused extends Error {
  constructor(
    readonly projectId: string,
    options: ErrorOptions,
  ) {
    super(`admission refused for ${projectId}`, options);
    this.name = "AdmissionRefused";
  }
}

describe("createLogger", () => {
  test("every line is one JSON object, nothing before it, that the record schema parses", () => {
    const { logger, lines, records } = lineLogger();
    logger.debug("test.debug", "detail", { argv: ["git", "status"], exitCode: 0 });
    logger.info("test.info", "decided", { taskId: "t-1", nested: { ok: true, none: null } });
    logger.warn("test.warn", "absorbed", { tries: 2 }, new Error("flaky"));
    logger.error("test.error", "lost", {});
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.startsWith("{")).toBe(true);
      expect(line.endsWith("}\n")).toBe(true);
    }
    const parsed = records();
    expect(parsed.map((r) => [r.level, r.event])).toEqual([
      ["debug", "test.debug"],
      ["info", "test.info"],
      ["warn", "test.warn"],
      ["error", "test.error"],
    ]);
    expect(parsed[0]).toMatchObject({ ts: "2026-10-17T09:00:00.000Z", boot: logger.boot, fields: { argv: ["git", "status"], exitCode: 0 } });
    expect(new Set(parsed.map((r) => r.boot)).size).toBe(1);
    expect(new Set(parsed.map((r) => r.traceId)).size).toBe(1);
    expect(parsed[3]).not.toHaveProperty("error");
  });

  test("a record below the minimum level is not written", () => {
    const { logger, records } = lineLogger("info");
    logger.debug("test.debug", "dropped");
    logger.info("test.info", "kept");
    expect(records().map((r) => r.event)).toEqual(["test.info"]);
  });

  test("two loggers mint two boot ids", () => {
    expect(lineLogger().logger.boot).not.toBe(lineLogger().logger.boot);
  });

  test("a three-deep typed error chain is held whole and parses back with every class and typed field", () => {
    const { logger, records } = lineLogger();
    const root = new StoreUnreachable("db.internal", 5432);
    const middle = new LedgerReadFailed("llm_calls", { cause: root });
    logger.error("finance.admission-failed", "admission failed", { projectId: "p-1" }, new AdmissionRefused("p-1", { cause: middle }));
    const [record] = records();
    expect(record.error).toBeDefined();
    if (record.error === undefined || !("chain" in record.error)) throw new TypeError("expected a serialized chain");
    const chain = record.error.chain;
    expect([chain.name, chain.cause?.name, chain.cause?.cause?.name]).toEqual(["AdmissionRefused", "LedgerReadFailed", "StoreUnreachable"]);
    expect(chain.fields).toEqual({ projectId: "p-1" });
    expect(chain.cause?.fields).toEqual({ ledger: "llm_calls" });
    expect(chain.cause?.cause?.fields).toEqual({ host: "db.internal", port: 5432 });
    expect(chain.cause?.cause?.stack).toContain("StoreUnreachable");
  });

  test("an ErrorLayer is held as its layers, outermost first", () => {
    const { logger, records } = lineLogger();
    const layer = wrapError("git", "fetch", wrapError("network", "connect", "refused", { host: "origin" }), { repo: "target" });
    logger.warn("execution-infra.fetch-failed", "fetch failed", {}, layer);
    const [record] = records();
    if (record.error === undefined || !("layers" in record.error)) throw new TypeError("expected layers");
    expect(record.error.layers.map((l) => `${l.boundary}/${l.operation}`)).toEqual(["git/fetch", "network/connect"]);
    expect(record.error.layers[1].context).toEqual({ host: "origin" });
  });

  test("a sink that throws does not throw into the caller, and the failure reaches stderr with the event name", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const logger = createLogger({
        sink: {
          write: () => {
            throw new RangeError("disk full");
          },
        },
        clock: { now: () => AT },
        minLevel: "debug",
      });
      expect(() => logger.info("test.unwritable", "lost")).not.toThrow();
      expect(() => logger.error("test.unwritable-error", "lost", {}, new Error("x"))).not.toThrow();
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(String(stderr.mock.calls[0][0])).toContain('"test.unwritable"');
      expect(String(stderr.mock.calls[0][0])).toContain("RangeError: disk full");
    } finally {
      stderr.mockRestore();
    }
  });

  test("a Secret field prints [redacted], wherever it sits, and its value never reaches the line", () => {
    const { logger, lines, records } = lineLogger();
    const key = new Secret("sk-live-0123456789");
    logger.info("security.key-loaded", "key loaded", { key, nested: { list: [key] } });
    const thrown = Object.assign(new Error("provider refused"), { credentialValue: key, held: key });
    logger.error("model-access.refused", "refused", {}, thrown);
    expect(lines.join("")).not.toContain("sk-live-0123456789");
    const [info] = records();
    expect(info.fields).toEqual({ key: "[redacted]", nested: { list: ["[redacted]"] } });
    expect(String(key)).toBe("[redacted]");
    expect(JSON.stringify({ key })).toBe('{"key":"[redacted]"}');
    expect(key.reveal()).toBe("sk-live-0123456789");
  });

  test("a deny-listed field name is redacted whatever its value, in fields, nested objects and error fields", () => {
    const { logger, lines, records } = lineLogger();
    logger.info("server.request", "request", {
      apiToken: "tok-123",
      headers: { Authorization: "Bearer abc", accept: "json" },
      db_password: "pw",
      inputTokens: 40,
      secretName: "provider/openai/api_key",
    });
    logger.warn("server.login-failed", "login failed", {}, Object.assign(new Error("bad"), { accessCode: "code-xyz" }));
    const text = lines.join("");
    for (const value of ["tok-123", "Bearer abc", '"pw"', "code-xyz"]) expect(text).not.toContain(value);
    const [request, failed] = records();
    expect(request.fields).toEqual({
      apiToken: "[redacted]",
      headers: { Authorization: "[redacted]", accept: "json" },
      db_password: "[redacted]",
      inputTokens: 40,
      secretName: "provider/openai/api_key",
    });
    expect(failed.error).toMatchObject({ chain: { fields: { accessCode: "[redacted]" } } });
  });

  test("a value JSON cannot hold, a cycle and an oversized message are bounded, never thrown", () => {
    const { logger, records } = lineLogger();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    expect(() => logger.info("test.bounded", "x".repeat(40_000), { nan: Number.NaN, cyclic: { inner: [1] }, hostile: { ok: 1 } })).not.toThrow();
    expect(() => Reflect.apply(logger.info, logger, ["test.hostile", "m", { cyclic, hostile }])).not.toThrow();
    const [bounded, hostileRecord] = records();
    expect(bounded.msg.length).toBeLessThan(17_000);
    expect(bounded.msg).toContain("[truncated by Ashara");
    expect(bounded.fields).toMatchObject({ nan: "NaN" });
    expect(hostileRecord.fields).toMatchObject({ cyclic: { self: "[circular]" } });
    expect(String(JSON.stringify(hostileRecord.fields?.["hostile"]))).toContain("unserializable");
  });

  test("a scope adds its correlation to every record inside it; a new trace names its parent", async () => {
    const { logger, records } = lineLogger();
    logger.info("test.outside", "outside");
    await logger.scope({ projectId: "p-1", cycle: 3 }, async () => {
      await Promise.resolve();
      logger.info("test.cycle", "in cycle");
      logger.scope({ taskId: "t-1", attempt: 2, trace: "new" }, () => logger.warn("test.attempt", "in attempt"));
    });
    const [outside, cycle, attempt] = records();
    expect(outside).not.toHaveProperty("projectId");
    expect(cycle).toMatchObject({ projectId: "p-1", cycle: 3, traceId: outside.traceId });
    expect(attempt).toMatchObject({ projectId: "p-1", cycle: 3, taskId: "t-1", attempt: 2, parentTraceId: outside.traceId });
    expect(attempt.traceId).not.toBe(outside.traceId);
  });
});

describe("recordingLogger", () => {
  test("keeps every record, debug included, for a test to assert on event and fields", () => {
    const logger = recordingLogger();
    logger.debug("test.debug", "d", { n: 1 });
    expect(logger.records).toHaveLength(1);
    expect(logRecordSchema.parse(logger.records[0])).toMatchObject({ event: "test.debug", fields: { n: 1 } });
  });
});
