import { describe, expect, test } from "vitest";

import { buildGateway } from "./build-gateway.js";
import { RoutingProfileIncomplete } from "./errors.js";
import { KNOWN_LLM_SITES } from "./types.js";
import type { GatewayConfig, ModelConfig, RoutingProfiles } from "./types.js";

const MODEL: ModelConfig = {
  id: "deepseek-v4-flash",
  apiModelId: "deepseek-chat",
  provider: "deepseek",
  capabilityLevel: "Strong",
  inputCostPer1M: 1,
  outputCostPer1M: 2,
  maxContextTokens: 100_000,
  supportsCaching: false,
};

function makeConfig(routingProfiles: RoutingProfiles): GatewayConfig {
  return {
    providers: [{ name: "deepseek", apiKey: "test-key", models: [MODEL], enabled: true }],
    defaultProvider: "deepseek",
    routingProfiles,
  };
}

function completeProfile(): Record<string, string> {
  return Object.fromEntries(KNOWN_LLM_SITES.map((site) => [site, MODEL.id]));
}

function build(routingProfiles: RoutingProfiles): ReturnType<typeof buildGateway> {
  return buildGateway({ config: makeConfig(routingProfiles), checkedSources: ["test"] });
}

describe("buildGateway routing-profile completeness", () => {
  test("refuses to start when a non-empty profile omits a site, naming the missing site", () => {
    const partial = completeProfile();
    delete partial["stack-derivation"];

    expect(() => build({ deepseek: partial })).toThrow(RoutingProfileIncomplete);

    try {
      build({ deepseek: partial });
      expect.unreachable("expected RoutingProfileIncomplete");
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingProfileIncomplete);
      const typed = err as RoutingProfileIncomplete;
      expect(typed.combo).toBe("deepseek");
      expect(typed.missingSites).toEqual(["stack-derivation"]);
      expect(typed.mappedSites).toContain("agent-runner");
      expect(typed.message).toContain("stack-derivation");
      expect(typed.message).toContain(typed.configPath);
    }
  });

  test("boots when the profile maps every known site", () => {
    expect(build({ deepseek: completeProfile() }).kind).toBe("real");
  });

  test("boots when the profile is explicitly empty (capability routing for every site)", () => {
    expect(build({ deepseek: {} }).kind).toBe("real");
  });

  test("boots when no profile exists for the enabled-provider combo", () => {
    expect(build({ "anthropic+openai": completeProfile() }).kind).toBe("real");
  });
});
