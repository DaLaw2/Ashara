import { LLMGateway } from "./gateway.js";
import type { LanguageModelFactory } from "./provider-registry.js";
import { NoLLMProvidersConfigured, RoutingProfileIncomplete, RoutingProfileModelMissing } from "./errors.js";
import { resolveModelsConfigPath } from "./pricing.js";
import { computeProviderCombo } from "./routing-profiles.js";
import { KNOWN_LLM_SITES } from "./types.js";
import type { CallRecording, GatewayConfig } from "./types.js";

const HOW_TO_FIX =
  "Store an API key for at least one provider listed in provider_configs: " +
  "`read -rs V && printf '%s' \"$V\" | npx tsx scripts/secret.ts put provider/<name>/api_key`.";

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
 * Refuse-to-start guard: every model the deployment's own routing profile
 * names is offered by an enabled provider. Otherwise each request routed to it
 * would throw RoutingProfileUnresolved, after the gateway had started.
 */
function assertRoutingProfileModelsPresent(config: GatewayConfig): void {
  const enabled = config.providers.filter((p) => p.enabled);
  const combo = computeProviderCombo(enabled.map((p) => p.name));
  const profile = config.routingProfiles?.[combo];
  if (!profile) return;

  const offered = new Set(enabled.flatMap((p) => p.models.map((m) => m.id)));
  const missing: string[] = [];
  for (const [site, entry] of Object.entries(profile)) {
    const modelIds = typeof entry === "string" ? [entry] : Object.values(entry);
    for (const modelId of modelIds) {
      if (modelId !== undefined && !offered.has(modelId)) missing.push(`"${site}" -> "${modelId}"`);
    }
  }
  if (missing.length === 0) return;

  throw new RoutingProfileModelMissing({
    combo,
    missing,
    providers: enabled.map((p) => p.name),
    configPath: resolveModelsConfigPath(),
  });
}

export interface BuildGatewayOptions {
  /**
   * Already-resolved gateway config. Acquisition (the DB catalog and the
   * secret store, in the server) stays caller-side — this factory only
   * enforces the refuse-to-start invariant on the result.
   */
  readonly config: GatewayConfig;
  /**
   * Human-readable list of config sources the caller checked while acquiring
   * `config` (e.g. `["TOML/env"]` or `["API https://...", "TOML/env fallback"]`).
   * Surfaced verbatim in the thrown error for Discipline-C diagnosability.
   */
  readonly checkedSources: readonly string[];
  /**
   * Whether every structured call writes a ledger row. Required: a process
   * that does not record says why, at its own construction site.
   */
  readonly recording: CallRecording;
  /**
   * Read once per provider request, before it is sent; that instant prices the
   * call in the recorder's row and in the cost the gateway returns. Required: the rate
   * of a time-windowed model depends on it.
   */
  readonly clock: () => Date;
  /** What each resolved route's requests are sent to: the AI SDK adapters in production. */
  readonly models: LanguageModelFactory;
}

/**
 * Single composition-root factory for constructing an `LLMGateway`.
 *
 * Refuse-to-start invariants:
 * - ADR-030: zero configured providers is never a silent success — it throws
 *   {@link NoLLMProvidersConfigured}.
 * - A non-empty routing profile for this deployment's enabled-provider combo
 *   must map every known LLM site — it throws {@link RoutingProfileIncomplete}
 *   otherwise. See {@link assertRoutingProfileComplete}.
 * - Every model that profile names must be offered by an enabled provider —
 *   it throws {@link RoutingProfileModelMissing} otherwise.
 */
export function buildGateway(options: BuildGatewayOptions): LLMGateway {
  const { config, checkedSources } = options;

  if (config.providers.length === 0) {
    throw new NoLLMProvidersConfigured(checkedSources, HOW_TO_FIX);
  }

  assertRoutingProfileComplete(config);
  assertRoutingProfileModelsPresent(config);
  return new LLMGateway(config, options.recording, options.clock, options.models);
}
