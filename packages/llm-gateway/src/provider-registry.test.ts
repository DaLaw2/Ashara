import { describe, expect, test } from "vitest";
import { ProviderMissingBaseUrl } from "./errors.js";
import { ProviderRegistry } from "./provider-registry.js";
import type { GatewayConfig, ModelConfig } from "./types.js";

const MODEL: ModelConfig = {
  id: "mistral-large",
  apiModelId: "mistral-large-latest",
  provider: "mistral",
  capabilityLevel: "Strong",
  inputCostPer1M: 2,
  outputCostPer1M: 6,
  maxContextTokens: 128_000,
  supportsCaching: false,
};

describe("ProviderRegistry base_url guard", () => {
  test("openai-compatible provider with no base_url is refused, naming the provider", () => {
    const config: GatewayConfig = {
      providers: [
        {
          name: "mistral",
          apiKey: "test-key",
          // baseUrl deliberately absent
          models: [MODEL],
          enabled: true,
        },
      ],
      defaultProvider: "mistral",
    };

    const registry = new ProviderRegistry(config);

    let thrown: unknown;
    try {
      registry.resolve("Strong");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProviderMissingBaseUrl);
    if (!(thrown instanceof ProviderMissingBaseUrl)) throw new Error("unreachable");
    expect(thrown.provider).toBe("mistral");
    expect(thrown.message).toContain("mistral");
    expect(thrown.message).toContain("base_url");
    expect(thrown.message).toContain("api.openai.com");
  });

  test("local provider with no base_url is refused", () => {
    const localModel: ModelConfig = {
      ...MODEL,
      id: "local-model",
      provider: "local",
    };
    const config: GatewayConfig = {
      providers: [
        {
          name: "local",
          models: [localModel],
          enabled: true,
        },
      ],
      defaultProvider: "local",
    };

    const registry = new ProviderRegistry(config);

    let thrown: unknown;
    try {
      registry.resolve("Strong");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProviderMissingBaseUrl);
    if (!(thrown instanceof ProviderMissingBaseUrl)) throw new Error("unreachable");
    expect(thrown.provider).toBe("local");
  });

  test("openai-compatible provider with a base_url resolves without error", () => {
    const config: GatewayConfig = {
      providers: [
        {
          name: "mistral",
          apiKey: "test-key",
          baseUrl: "https://api.mistral.ai/v1",
          models: [MODEL],
          enabled: true,
        },
      ],
      defaultProvider: "mistral",
    };

    const registry = new ProviderRegistry(config);
    const resolved = registry.resolve("Strong");
    expect(resolved.providerName).toBe("mistral");
    expect(resolved.modelConfig.id).toBe("mistral-large");
  });
});
