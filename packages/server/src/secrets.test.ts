import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildGatewayConfig } from "@ashara/llm-gateway";
import type { ModelConfig } from "@ashara/llm-gateway";
import { generateKeyFileContent } from "@ashara/security";
import {
  ServerStartupRefused,
  buildProviderKeyEnv,
  loadApiToken,
  loadServerMasterKey,
  resolveProviderCredentials,
} from "./secrets.js";
import type { SecretReader } from "./secrets.js";

function memoryReader(entries: Record<string, string>): SecretReader {
  return {
    has: async (name) => name in entries,
    get: async (name) => {
      const value = entries[name];
      if (value === undefined) throw new Error(`test reader: ${name} absent`);
      return value;
    },
  };
}

function refusalOf(fn: () => unknown): ServerStartupRefused {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ServerStartupRefused) return err;
    throw err;
  }
  throw new Error("expected ServerStartupRefused");
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-server-key-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("server startup secrets", () => {
  test("refuses to start without the key file, naming the path and the fix", () => {
    const keyFile = path.join(dir, "absent.key");
    const refusal = refusalOf(() => loadServerMasterKey({ ASHARA_SECRET_KEY_FILE: keyFile }));
    expect(refusal.message).toContain(keyFile);
    expect(refusal.message).toContain("master key");
    expect(refusal.message).toContain("npx tsx scripts/secret-key-init.ts");
  });

  test("loads the key from a temp key file", () => {
    const keyFile = path.join(dir, "secret.key");
    const { content, keyId } = generateKeyFileContent();
    fs.writeFileSync(keyFile, content, { mode: 0o600 });
    expect(loadServerMasterKey({ ASHARA_SECRET_KEY_FILE: keyFile }).id).toBe(keyId);
  });

  test("refuses to start without server/api_token, naming the secret and the put command", async () => {
    const err: unknown = await loadApiToken(memoryReader({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerStartupRefused);
    expect(err).toMatchObject({
      message: expect.stringContaining('"server/api_token"'),
      howToFix: expect.stringContaining("npx tsx scripts/secret.ts put server/api_token"),
    });
  });

  test("reads the token from the store", async () => {
    expect(await loadApiToken(memoryReader({ "server/api_token": "t-1" }))).toBe("t-1");
  });

  test("a provider key resolved from the store reaches the gateway config; a keyless one is left out", async () => {
    const model: ModelConfig = {
      id: "m",
      apiModelId: "m",
      provider: "deepseek",
      capabilityLevel: "Strong",
      inputCostPer1M: 1,
      outputCostPer1M: 1,
      maxContextTokens: 1000,
      cacheReadCostPer1M: null,
      cacheWriteCostPer1M: null,
      priceWindows: [],
    };
    const reader = memoryReader({ "provider/deepseek/api_key": "store-value" });
    const providers = [
      { name: "deepseek", baseUrl: "https://api.deepseek.com/v1" },
      { name: "openai", baseUrl: null },
    ];
    const credentials = await resolveProviderCredentials(reader, providers);
    const config = buildGatewayConfig(
      { m: model, o: { ...model, id: "o", provider: "openai" } },
      {},
      credentials,
    );
    expect(config.providers.map((p) => [p.name, p.apiKey])).toEqual([["deepseek", "store-value"]]);
    expect(await buildProviderKeyEnv(reader, providers)).toEqual({ DEEPSEEK_API_KEY: "store-value" });
  });
});
