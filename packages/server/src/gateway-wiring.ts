// ---------------------------------------------------------------------------
// LLM gateway composition-root wiring (ADR-030).
//
// Single call site turning an acquired GatewayConfig into either a real,
// provider-backed gateway or an explicit permission to run stub planning
// LLMs (ASHARA_TEST_STUB_LLM=1). There is no third "silently proceed with
// nothing configured" path: buildGateway throws NoLLMProvidersConfigured
// instead, and this function lets that propagate -- callers (main()) must
// treat it as a refuse-to-start condition, never catch-and-continue.
//
// Model catalog seeding was removed: the authoritative catalog now lives
// in the database, seeded by migration 002_seed_models.sql. Runtime
// seeding from TOML is no longer needed.
// ---------------------------------------------------------------------------

import { buildGateway, LLMGateway } from "@ashara/llm-gateway";
import type { BudgetLedger, GatewayConfig, LLMCallRecord } from "@ashara/llm-gateway";

export interface GatewayWiringResult {
  readonly llmGateway: LLMGateway | null;
  readonly mode: "real" | "stub";
}

/**
 * Resolve the server's LLM gateway from an already-acquired {@link GatewayConfig}.
 *
 * - Providers configured -> `{ mode: "real", llmGateway }`.
 * - Zero providers + `ASHARA_TEST_STUB_LLM=1` -> `{ mode: "stub", llmGateway: null }`.
 * - Zero providers, no test flag -> throws `NoLLMProvidersConfigured`
 *   (re-exported from `@ashara/llm-gateway`). The caller must let this
 *   propagate to a refuse-to-start exit.
 */
export async function wireLlmGateway(
  gwConfig: GatewayConfig,
  ledger: BudgetLedger,
  logSink?: (record: LLMCallRecord) => void,
): Promise<GatewayWiringResult> {
  const result = buildGateway({ config: gwConfig, checkedSources: ["provider_configs.api_key (database)"], ledger, logSink });

  if (result.kind === "stub") {
    return { llmGateway: null, mode: "stub" };
  }

  return { llmGateway: result.gateway, mode: "real" };
}
