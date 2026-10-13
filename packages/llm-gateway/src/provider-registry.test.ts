import { describe, expect, test } from "vitest";
import { NoProviderAvailableError, ProviderMissingBaseUrl, RoutingProfileUnresolved } from "./errors.js";
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

describe("ProviderRegistry fails closed instead of substituting a model", () => {
  const config = (routingProfiles?: GatewayConfig["routingProfiles"]): GatewayConfig => ({
    providers: [
      { name: "mistral", apiKey: "k", baseUrl: "https://api.mistral.ai/v1", models: [MODEL], enabled: true },
    ],
    defaultProvider: "mistral",
    routingProfiles,
  });

  test("no model at or above the requested capability throws; no lower tier is substituted", () => {
    expect(() => new ProviderRegistry(config()).resolve("Frontier")).toThrow(NoProviderAvailableError);
  });

  test("a curated profile with no entry for the capability throws rather than using capability logic", () => {
    const registry = new ProviderRegistry(config({ mistral: { "agent-runner": { Frontier: "mistral-large" } } }));
    expect(() => registry.resolve("Strong", [], "agent-runner")).toThrow(RoutingProfileUnresolved);
  });

  test("a curated profile mapping to a model no provider offers throws", () => {
    const registry = new ProviderRegistry(config({ mistral: { "agent-runner": "absent-model" } }));
    expect(() => registry.resolve("Strong", [], "agent-runner")).toThrow(/absent-model/);
  });

  test("an explicitly empty profile delegates to capability logic", () => {
    const registry = new ProviderRegistry(config({ mistral: {} }));
    expect(registry.resolve("Strong", [], "agent-runner").modelConfig.id).toBe("mistral-large");
  });

  test("a curated profile whose mapped model is on the excluded provider falls back to capability logic", () => {
    const registry = new ProviderRegistry({
      providers: [
        { name: "mistral", apiKey: "k", baseUrl: "https://api.mistral.ai/v1", models: [MODEL], enabled: true },
        { name: "other", apiKey: "k", baseUrl: "https://example.invalid/v1", models: [{ ...MODEL, id: "other-large" }], enabled: true },
      ],
      defaultProvider: "mistral",
      routingProfiles: { "mistral+other": { "agent-runner": "mistral-large" } },
    });
    expect(registry.resolveFallback("Strong", "mistral", "agent-runner")?.modelConfig.id).toBe("other-large");
  });
});
