// ---------------------------------------------------------------------------
// LLM gateway composition-root wiring (ADR-030).
//
// Single call site turning an acquired GatewayConfig into either a real,
// provider-backed gateway or an explicit permission to run stub planning
// LLMs (ASHARA_TEST_STUB_LLM=1). There is no third "silently proceed with
// nothing configured" path: buildGateway throws NoLLMProvidersConfigured
// instead, and this function lets that propagate -- callers (main()) must
// treat it as a refuse-to-start condition, never catch-and-continue.
// ---------------------------------------------------------------------------

import { buildGateway, LLMGateway } from "@ashara/llm-gateway";
import type { BudgetLedger, GatewayConfig, LLMCallRecord } from "@ashara/llm-gateway";

export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly providerName: string;
  readonly apiModelId: string;
  readonly capability: string;
  readonly formatGroup: string | undefined;
  readonly strictMode: boolean | undefined;
  readonly inputCostPer1m: number;
  readonly outputCostPer1m: number;
  readonly maxContextTokens: number;
  readonly supportsCaching: boolean;
}

export interface GatewayWiringResult {
  readonly llmGateway: LLMGateway | null;
  readonly mode: "real" | "stub";
  /** Number of models seeded into the DB catalog. Always 0 in stub mode. */
  readonly seededModelCount: number;
}

/**
 * Resolve the server's LLM gateway from an already-acquired {@link GatewayConfig}.
 *
 * - Providers configured -> `{ mode: "real", llmGateway }`, and the model
 *   catalog is seeded via `seedModelCatalog` so agent-runner subprocesses can
 *   load it from the DB.
 * - Zero providers + `ASHARA_TEST_STUB_LLM=1` -> `{ mode: "stub", llmGateway: null }`.
 * - Zero providers, no test flag -> throws `NoLLMProvidersConfigured`
 *   (re-exported from `@ashara/llm-gateway`). The caller must let this
 *   propagate to a refuse-to-start exit.
 */
export async function wireLlmGateway(
  gwConfig: GatewayConfig,
  seedModelCatalog: (models: ModelCatalogEntry[]) => Promise<void>,
  ledger: BudgetLedger,
  logSink?: (record: LLMCallRecord) => void,
): Promise<GatewayWiringResult> {
  const result = buildGateway({ config: gwConfig, checkedSources: ["TOML/env"], ledger, logSink });

  if (result.kind === "stub") {
    return { llmGateway: null, mode: "stub", seededModelCount: 0 };
  }

  const models: ModelCatalogEntry[] = gwConfig.providers.flatMap((p) =>
    p.models.map((m) => ({
      modelId: m.id,
      providerName: p.name,
      apiModelId: m.apiModelId,
      capability: m.capabilityLevel,
      formatGroup: m.formatGroup,
      strictMode: m.strictMode,
      inputCostPer1m: m.inputCostPer1M,
      outputCostPer1m: m.outputCostPer1M,
      maxContextTokens: m.maxContextTokens,
      supportsCaching: m.supportsCaching,
    })),
  );
  await seedModelCatalog(models);

  return { llmGateway: result.gateway, mode: "real", seededModelCount: models.length };
}
