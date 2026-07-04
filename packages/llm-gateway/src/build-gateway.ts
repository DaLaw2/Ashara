import { LLMGateway } from "./gateway.js";
import { BudgetLedger } from "./budget-ledger.js";
import { NoLLMProvidersConfigured } from "./errors.js";
import type { GatewayConfig, LLMCallRecord } from "./types.js";

const TEST_STUB_ENV_VAR = "ASHARA_TEST_STUB_LLM";
const TEST_STUB_ENV_VALUE = "1";

const HOW_TO_FIX =
  "Configure at least one provider (ANTHROPIC_API_KEY, OPENAI_API_KEY, " +
  "DEEPSEEK_API_KEY, MISTRAL_API_KEY, XAI_API_KEY, GOOGLE_API_KEY, or " +
  "LOCAL_LLM_URL), or set ASHARA_TEST_STUB_LLM=1 to explicitly permit " +
  "stub-mode for tests/local dev.";

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
 * Refuse-to-start invariant (ADR-030): zero configured providers and no
 * explicit test flag is never a silent success — it throws
 * {@link NoLLMProvidersConfigured}. Stub-mode is reachable only when
 * `ASHARA_TEST_STUB_LLM=1` is explicitly set, never as a fallback default.
 */
export function buildGateway(options: BuildGatewayOptions): GatewayBuildResult {
  const { config, checkedSources } = options;

  if (config.providers.length > 0) {
    return { kind: "real", gateway: new LLMGateway(config, options.ledger, options.logSink) };
  }

  const stubFlag = options.testStubEnvOverride ?? process.env[TEST_STUB_ENV_VAR];
  if (stubFlag === TEST_STUB_ENV_VALUE) {
    return { kind: "stub" };
  }

  throw new NoLLMProvidersConfigured(checkedSources, HOW_TO_FIX);
}
