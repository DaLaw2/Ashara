import { LLMGateway } from "./gateway.js";
import { BudgetLedger } from "./budget-ledger.js";
import { NoLLMProvidersConfigured, RoutingProfileIncomplete } from "./errors.js";
import { resolveModelsConfigPath } from "./pricing.js";
import { computeProviderCombo } from "./routing-profiles.js";
import { KNOWN_LLM_SITES } from "./types.js";
import type { GatewayConfig, LLMCallRecord } from "./types.js";

const TEST_STUB_ENV_VAR = "ASHARA_TEST_STUB_LLM";
const TEST_STUB_ENV_VALUE = "1";

const HOW_TO_FIX =
  "Configure at least one provider (ANTHROPIC_API_KEY, OPENAI_API_KEY, " +
  "DEEPSEEK_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, GOOGLE_API_KEY, or " +
  "LOCAL_LLM_URL), or set ASHARA_TEST_STUB_LLM=1 to explicitly permit " +
  "stub-mode for tests/local dev.";

const ROUTING_PROFILE_HOW_TO_FIX =
  "Map the missing site(s) in this combo's [routing.profiles] table, or empty " +
  "the table entirely to route every site by capability level. An all-or-nothing " +
  "rule is deliberate: a non-empty profile is a curated allocation, so a site " +
  "missing from it escapes to capability routing and lands on whatever model that " +
  "picks — which is often the very provider the profile was written to reserve.";

/**
 * Refuse-to-start guard for routing-profile completeness.
 *
 * Exempt: a combo with NO profile (an unanticipated provider combination must
 * stay deployable — every site falls through to capability routing, which is
 * the pre-routing-profiles behavior), and a combo with an EXPLICITLY EMPTY
 * profile (the author's way of saying "capability routing for every site").
 *
 * Enforced: a non-empty profile maps every {@link KNOWN_LLM_SITES} entry.
 */
function assertRoutingProfileComplete(config: GatewayConfig): void {
  const combo = computeProviderCombo(
    config.providers.filter((p) => p.enabled).map((p) => p.name),
  );

  const profile = config.routingProfiles?.[combo];
  if (!profile) return;

  const mappedSites = Object.keys(profile);
  if (mappedSites.length === 0) return;

  const missingSites = KNOWN_LLM_SITES.filter((site) => profile[site] === undefined);
  if (missingSites.length === 0) return;

  throw new RoutingProfileIncomplete({
    combo,
    missingSites,
    mappedSites,
    configPath: resolveModelsConfigPath(),
    howToFix: ROUTING_PROFILE_HOW_TO_FIX,
  });
}

/**
 * Discriminated result of {@link buildGateway}: either a real, provider-backed
 * gateway or an explicit stub-mode permission. There is no third "silently
 * proceed with nothing configured" case — that path throws instead (ADR-030).
 */
export type GatewayBuildResult =
  | { readonly kind: "real"; readonly gateway: LLMGateway }
  | { readonly kind: "stub" };

export interface BuildGatewayOptions {
  /**
   * Already-resolved gateway config. Acquisition (TOML/env for the server,
   * API-then-TOML fallback chain for the CLI) stays caller-side — this
   * factory only enforces the refuse-to-start invariant on the result.
   */
  readonly config: GatewayConfig;
  /**
   * Human-readable list of config sources the caller checked while acquiring
   * `config` (e.g. `["TOML/env"]` or `["API https://...", "TOML/env fallback"]`).
   * Surfaced verbatim in the thrown error for Discipline-C diagnosability.
   */
  readonly checkedSources: readonly string[];
  /**
   * Test-only override for the `ASHARA_TEST_STUB_LLM` env var. Defaults to
   * reading `process.env.ASHARA_TEST_STUB_LLM`. This is the single place
   * the flag is checked — no other call site may inline stub construction.
   */
  readonly testStubEnvOverride?: string | undefined;
  /**
   * The process-wide in-memory budget gate to wire into the constructed
   * gateway. Defaults to a fresh `BudgetLedger` when omitted — callers that
   * want one ledger shared across the gateway (e.g. the server composition
   * root) must pass their own instance.
   */
  readonly ledger?: BudgetLedger;
  readonly logSink?: (record: LLMCallRecord) => void;
}

/**
 * Single composition-root factory for constructing an `LLMGateway`.
 *
 * Refuse-to-start invariants:
 * - ADR-030: zero configured providers and no explicit test flag is never a
 *   silent success — it throws {@link NoLLMProvidersConfigured}. Stub-mode is
 *   reachable only when `ASHARA_TEST_STUB_LLM=1` is explicitly set, never as a
 *   fallback default.
 * - A non-empty routing profile for this deployment's enabled-provider combo
 *   must map every known LLM site — it throws {@link RoutingProfileIncomplete}
 *   otherwise. See {@link assertRoutingProfileComplete}.
 */
export function buildGateway(options: BuildGatewayOptions): GatewayBuildResult {
  const { config, checkedSources } = options;

  if (config.providers.length > 0) {
    assertRoutingProfileComplete(config);
    return { kind: "real", gateway: new LLMGateway(config, options.ledger, options.logSink) };
  }

  const stubFlag = options.testStubEnvOverride ?? process.env[TEST_STUB_ENV_VAR];
  if (stubFlag === TEST_STUB_ENV_VALUE) {
    return { kind: "stub" };
  }

  throw new NoLLMProvidersConfigured(checkedSources, HOW_TO_FIX);
}
