import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { NoProviderAvailableError, ProviderMissingBaseUrl, RoutingProfileUnresolved } from "./errors.js";
import { ProviderRegistry, sdkLanguageModels } from "./provider-registry.js";
import type { GatewayConfig, ModelConfig } from "./types.js";

function registryOf(config: GatewayConfig): ProviderRegistry {
  return new ProviderRegistry(config, sdkLanguageModels);
}

const MODEL: ModelConfig = {
  id: "mistral-large",
  apiModelId: "mistral-large-latest",
  provider: "mistral",
  capabilityLevel: "Strong",
  inputCostPer1M: 2,
  outputCostPer1M: 6,
  maxContextTokens: 128_000,
  cacheReadCostPer1M: null,
  cacheWriteCostPer1M: null,
  priceWindows: [], priceTiers: [],
};

describe("ProviderRegistry base_url guard", () => {
  test("openai-compatible provider with no base_url is refused, naming the provider", () => {
    const config: GatewayConfig = {
      providers: [
        {
          name: "mistral",
          providerType: "openai-compatible",
          apiKey: "test-key",
          // baseUrl deliberately absent
          models: [MODEL],
          enabled: true,
        },
      ],
      defaultProvider: "mistral",
    };

    const registry = registryOf(config);

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
          providerType: "local",
          models: [localModel],
          enabled: true,
        },
      ],
      defaultProvider: "local",
    };

    const registry = registryOf(config);

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
          providerType: "openai-compatible",
          apiKey: "test-key",
          baseUrl: "https://api.mistral.ai/v1",
          models: [MODEL],
          enabled: true,
        },
      ],
      defaultProvider: "mistral",
    };

    const registry = registryOf(config);
    const resolved = registry.resolve("Strong");
    expect(resolved.providerName).toBe("mistral");
    expect(resolved.modelConfig.id).toBe("mistral-large");
  });

  test("a resolved route's model is the one the supplied factory made for that provider and model", () => {
    const config: GatewayConfig = {
      providers: [{ name: "mistral", providerType: "openai-compatible", apiKey: "k", baseUrl: "https://x.invalid/v1", models: [MODEL], enabled: true }],
      defaultProvider: "mistral",
    };
    const made: string[] = [];
    const scripted = new MockLanguageModelV4();
    const registry = new ProviderRegistry(config, (provider, model) => {
      made.push(`${provider.name}/${model.id}`);
      return scripted;
    });

    expect(registry.resolve("Strong").provider).toBe(scripted);
    expect(made).toEqual(["mistral/mistral-large"]);
  });

  test("a deepseek-type row of any name resolves through the official provider, not the openai-compatible path", () => {
    const deepseekModel: ModelConfig = { ...MODEL, id: "deepseek-v4-flash", apiModelId: "deepseek-chat", provider: "my-ds" };
    const registry = registryOf({
      providers: [
        {
          name: "my-ds",
          providerType: "deepseek",
          apiKey: "k",
          baseUrl: "https://api.deepseek.com/v1",
          models: [deepseekModel],
          enabled: true,
        },
      ],
      defaultProvider: "my-ds",
    });
    const resolved = registry.resolve("Strong");
    if (typeof resolved.provider === "string") throw new Error("expected a model instance, got a gateway id");
    expect(resolved.providerName).toBe("my-ds");
    expect(resolved.provider.provider).toBe("deepseek.chat");
    expect(resolved.provider.modelId).toBe("deepseek-chat");
  });

  test("a row named like an SDK provider but typed openai-compatible does not get that SDK's adapter", () => {
    const registry = registryOf({
      providers: [
        {
          name: "deepseek",
          providerType: "openai-compatible",
          apiKey: "k",
          baseUrl: "https://api.deepseek.com/v1",
          models: [{ ...MODEL, provider: "deepseek" }],
          enabled: true,
        },
      ],
      defaultProvider: "deepseek",
    });
    const { provider } = registry.resolve("Strong");
    if (typeof provider === "string") throw new Error("expected a model instance, got a gateway id");
    expect(provider.provider).not.toBe("deepseek.chat");
  });
});

describe("ProviderRegistry fails closed instead of substituting a model", () => {
  const config = (routingProfiles?: GatewayConfig["routingProfiles"]): GatewayConfig => ({
    providers: [
      { name: "mistral", providerType: "openai-compatible", apiKey: "k", baseUrl: "https://api.mistral.ai/v1", models: [MODEL], enabled: true },
    ],
    defaultProvider: "mistral",
    routingProfiles,
  });

  test("no model at or above the requested capability throws; no lower tier is substituted", () => {
    expect(() => registryOf(config()).resolve("Frontier")).toThrow(NoProviderAvailableError);
  });

  test("capability logic picks the cheapest model at or above the request, not the lowest level", () => {
    const registry = registryOf({
      providers: [{
        name: "deepseek", providerType: "deepseek", apiKey: "k", baseUrl: "https://stub.invalid/v1", enabled: true,
        models: [
          { ...MODEL, id: "dear-medium", provider: "deepseek", capabilityLevel: "Medium", inputCostPer1M: 1.32, outputCostPer1M: 3.96 },
          { ...MODEL, id: "cheap-strong", provider: "deepseek", capabilityLevel: "Strong", inputCostPer1M: 0.3, outputCostPer1M: 1.2 },
        ],
      }],
      defaultProvider: "deepseek",
    });
    expect(registry.resolve("Light").modelConfig.id).toBe("cheap-strong");
    expect(registry.resolve("Medium").modelConfig.id).toBe("cheap-strong");
    expect(() => registry.resolve("Frontier")).toThrow(/no lower model is substituted/);
  });

  test("a curated profile with no entry for the capability throws rather than using capability logic", () => {
    const registry = registryOf(config({ mistral: { "agent-runner": { Frontier: "mistral-large" } } }));
    expect(() => registry.resolve("Strong", [], "agent-runner")).toThrow(RoutingProfileUnresolved);
  });

  test("a curated profile mapping to a model no provider offers throws", () => {
    const registry = registryOf(config({ mistral: { "agent-runner": "absent-model" } }));
    expect(() => registry.resolve("Strong", [], "agent-runner")).toThrow(/absent-model/);
  });

  test("an explicitly empty profile delegates to capability logic", () => {
    const registry = registryOf(config({ mistral: {} }));
    expect(registry.resolve("Strong", [], "agent-runner").modelConfig.id).toBe("mistral-large");
  });

  test("a curated profile whose mapped model is on the excluded provider falls back to capability logic", () => {
    const registry = registryOf({
      providers: [
        { name: "mistral", providerType: "openai-compatible", apiKey: "k", baseUrl: "https://api.mistral.ai/v1", models: [MODEL], enabled: true },
        { name: "other", providerType: "openai-compatible", apiKey: "k", baseUrl: "https://example.invalid/v1", models: [{ ...MODEL, id: "other-large" }], enabled: true },
      ],
      defaultProvider: "mistral",
      routingProfiles: { "mistral+other": { "agent-runner": "mistral-large" } },
    });
    expect(registry.resolveFallback("Strong", "mistral", "agent-runner")?.modelConfig.id).toBe("other-large");
  });
});
