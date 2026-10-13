import type { ZodType } from "zod";
import type { CapabilityLevel, ProjectId, WorkItemId } from "@ashara/shared";

/**
 * Per-capability model table for a single site (routing-profiles story). Used
 * when one site's requests legitimately vary in REQUESTED capability across
 * calls — e.g. agent-runner tags every request `site: "agent-runner"` but the
 * per-task capability ranges over Light/Strong/Frontier (taskSpec.capability)
 * — so a single fixed model
 * for the site would silently downgrade a Frontier-classified task. `default`
 * covers any requested capability without its own entry; a request for a
 * capability with neither its own entry nor `default` throws
 * `RoutingProfileUnresolved` (see `ProviderRegistry.resolveFromProfile`). Only
 * the SITE dimension is boot-enforced; the capability dimension fails per call.
 */
type RoutingProfileCapabilityTable = Partial<Record<CapabilityLevel, string>> & {
  default?: string;
};

/**
 * A site's routing-profile value: either a single model id applied
 * regardless of requested capability (the common case — most sites request
 * one fixed capability, see `KNOWN_LLM_SITES` doc), or a
 * `RoutingProfileCapabilityTable` for a site whose requested capability
 * varies per call.
 */
export type RoutingProfileEntry = string | RoutingProfileCapabilityTable;

/**
 * Static per-site model playbooks (routing-profiles story). Outer key is the
 * "combo" — the deployment's enabled provider names, sorted and joined by
 * "+" (see `computeProviderCombo` in routing-profiles.ts). Inner map is
 * site -> `RoutingProfileEntry` to route that site to under this combo.
 *
 * A site is deliberately looked up by the SAME string the reliability ladder
 * already tags its requests/errors with (`LadderRequest.site`,
 * `KnownLLMSite` below) rather than a second, differently-spelled key.
 *
 * A combo with NO table here falls through to capability-level logic for
 * every site — that is how an unanticipated provider combination stays
 * deployable. A combo WITH a non-empty table is a curated allocation and must
 * map every `KNOWN_LLM_SITES` entry: `buildGateway` refuses to start on a
 * partial table, because a site missing from a curated allocation escapes to
 * capability routing and lands on whatever model that logic happens to pick.
 * An explicitly EMPTY table means "capability routing for every site" and is
 * exempt.
 */
export type RoutingProfiles = Record<string, Partial<Record<KnownLLMSite, RoutingProfileEntry>>>;

export interface GatewayConfig {
  providers: ProviderConfig[];
  defaultProvider: string;
  budget?: BudgetConfig;
  /** Static per-site routing playbooks, keyed by enabled-provider combo. */
  routingProfiles?: RoutingProfiles;
}

/**
 * The exhaustive registry of call-site identifiers used for static per-site
 * routing (`GatewayConfig.routingProfiles`). Enforced in both directions:
 *
 * - Forward: `StructuredRequest.site` / `StructuredLadderOptions.site` are
 *   typed `KnownLLMSite`, so tagging a new call site is a compile error until
 *   it is registered here.
 * - Reverse: `buildGateway` refuses to start when a non-empty routing profile
 *   fails to map one of these, and the models.toml schema rejects a profile
 *   key that is not one of these.
 *
 * Adding an entry here is therefore a deliberate two-step act: register the
 * site, then route it in every non-empty profile.
 *
 * "escalation" is not a call site of its own — the reliability ladder stamps
 * it on any attempt run at an ESCALATED capability tier (regardless of which
 * site the base attempt used), so routing profiles can send every escalated
 * retry to one deliberately-chosen reliable model.
 */
export const KNOWN_LLM_SITES = [
  "agent-runner",
  "decomposition",
  "stack-derivation",
  "liaison-intake",
  "escalation",
] as const;

export type KnownLLMSite = (typeof KNOWN_LLM_SITES)[number];

export interface ProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  models: ModelConfig[];
  enabled: boolean;
}

/**
 * USD per million tokens. A `null` cache rate means the model bills no such
 * class: cache tokens of that class, when reported, cannot be priced.
 */
export interface TokenRates {
  readonly inputCostPer1M: number;
  readonly outputCostPer1M: number;
  readonly cacheReadCostPer1M: number | null;
  readonly cacheWriteCostPer1M: number | null;
}

/**
 * Rates that replace the model's base rates for a call made on `isoWeekday`
 * (UTC, 1 = Monday) at a UTC minute of day in [utcStartMinute, utcEndMinute).
 */
interface PriceWindow {
  readonly isoWeekday: number;
  readonly utcStartMinute: number;
  readonly utcEndMinute: number;
  readonly rates: TokenRates;
}

export interface ModelConfig extends TokenRates {
  id: string;
  apiModelId: string;
  provider: string;
  capabilityLevel: CapabilityLevel;
  maxContextTokens: number;
  readonly priceWindows: readonly PriceWindow[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Returned by `extractUsage`. `reported` is what the provider stated, each
 * count `null` when it did not; only it may price a call (`measureCost`).
 * `usage` zero-fills the same counts for token tallies and logs.
 */
export interface ExtractedUsage {
  readonly usage: TokenUsage;
  readonly reported: ReportedTokens;
}

export interface ReportedTokens {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

/** A token class that enters a call's price. */
export type PricedTokenClass = keyof ReportedTokens;

/**
 * A call's cost in USD, or why it is unmeasured: the classes whose count the
 * provider did not report though the model bills them, and the classes with
 * reported tokens the model has no rate for. An unmeasured cost carries no
 * number, so no consumer can read it as 0.
 */
export type CostMeasurement =
  | {
      readonly measured: true;
      readonly inputCost: number;
      readonly outputCost: number;
      readonly cacheSavings: number;
      readonly totalCost: number;
    }
  | {
      readonly measured: false;
      readonly missingCounts: readonly PricedTokenClass[];
      readonly missingRates: readonly PricedTokenClass[];
    };

interface BudgetConfig {
  /** Total spend cap in USD, checked against the in-process BudgetLedger. */
  maxCostTotal: number;
  /**
   * Per-provider spend cap in USD, keyed by lowercase provider name (matches
   * `ProviderConfig.name`, e.g. "anthropic", "deepseek"). Optional — omit or
   * leave a provider out of the map to leave it uncapped.
   *
   * Checked against the in-process BudgetLedger, which resets to $0 on every
   * server restart (a restart is a new run) rather than persisting across
   * restarts.
   */
  maxCostPerProvider?: Record<string, number>;
}

export interface CostSummary {
  totalCost: number;
  costByProvider: Record<string, number>;
}

export interface StructuredRequest<T> {
  capability: CapabilityLevel;
  prompt: string;
  schema: ZodType<T>;
  systemPrompt?: string;
  maxTokens?: number;
  /** Call-site tag for static per-site routing. Optional — a site-less request always uses capability logic. */
  site?: KnownLLMSite;
}

export interface StructuredResponse<T> {
  data: T;
  usage: TokenUsage;
  cost: CostMeasurement;
  provider: string;
  model: string;
}

/**
 * Who a recorded call serves. `environment-spec` is a caller with no routing
 * site of its own: it routes by capability alone, so it is not a `KnownLLMSite`.
 */
type LlmCallSite = KnownLLMSite | "environment-spec";

/** Required on every recorded call: the project the spend belongs to, and the work item when one is served. */
export interface LlmCallContext {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId | null;
  readonly callSite: LlmCallSite;
}

export type LlmCallOperation = "generateObject" | "generateText:structured-fallback";

export type LlmCallOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly errorKind: string };

/** One provider request as the gateway saw it; `usage` is `null` when the request produced no usage report. */
export interface LlmProviderCall {
  readonly context: LlmCallContext;
  readonly provider: string;
  readonly model: ModelConfig;
  readonly operation: LlmCallOperation;
  readonly usage: ExtractedUsage | null;
  readonly outcome: LlmCallOutcome;
}

/**
 * Supplied by the composition root. `assertPriced` runs before every provider
 * request and throws to refuse it; `record` runs once after every provider
 * request, success or failure, and a throw from it fails the call.
 */
export interface LlmCallRecorder {
  assertPriced(provider: string, model: ModelConfig): void;
  record(call: LlmProviderCall): Promise<void>;
}

/**
 * Whether a gateway records its calls. `unrecorded` names why, so a process
 * that skips the ledger says so at its construction site instead of by omission.
 */
export type CallRecording =
  | { readonly kind: "recorded"; readonly recorder: LlmCallRecorder }
  | { readonly kind: "unrecorded"; readonly reason: string };
