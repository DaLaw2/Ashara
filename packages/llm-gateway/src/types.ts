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
  /** Static per-site routing playbooks, keyed by enabled-provider combo. */
  routingProfiles?: RoutingProfiles;
  /**
   * Thinking mode per call site (config/models.toml `[thinking]`). Absent is
   * thinking off at every site: the decided default (ADR-074 D13), not a guess.
   */
  thinking?: ThinkingPolicy;
}

/** Whether a reasoning model thinks before it answers (ADR-074 D13: per role tier, default off). */
export const THINKING_MODES = ["off", "on"] as const;

export type ThinkingMode = (typeof THINKING_MODES)[number];

/** The thinking mode of each call site; a site with no entry uses `default`. */
export interface ThinkingPolicy {
  readonly default: ThinkingMode;
  readonly sites: Readonly<Partial<Record<KnownLLMSite, ThinkingMode>>>;
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
  "liaison-intake",
  "roster",
  "escalation",
] as const;

export type KnownLLMSite = (typeof KNOWN_LLM_SITES)[number];

/**
 * Which SDK adapter serves a provider_configs row, read from its `provider_type`
 * column. The row's name is identity only: a `deepseek` row of any name uses
 * the DeepSeek adapter, and only a `local` row may lack an API key.
 */
export const PROVIDER_TYPES = ["anthropic", "openai", "deepseek", "openai-compatible", "local"] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderConfig {
  name: string;
  providerType: ProviderType;
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
  /**
   * Output tokens the provider reported as reasoning, a part of the output
   * count and of `maxTokens`; `null` when the provider reported no such count.
   */
  readonly reasoningTokens: number | null;
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

export interface StructuredRequest<T> {
  capability: CapabilityLevel;
  prompt: string;
  schema: ZodType<T>;
  systemPrompt?: string;
  /** The output bound sent with the request; Finance prices the call's worst case from it. */
  maxTokens: number;
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

/** Required on every recorded call: the project the spend belongs to, and the work item when one is served. */
export interface LlmCallContext {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId | null;
  /** Who the recorded call serves: always a routing site. */
  readonly callSite: KnownLLMSite;
}

export type LlmCallOperation = "generateObject" | "generateText:structured-fallback" | "generateText:turn";

/**
 * `truncated` is the error kind of a structured call that stopped at
 * `maxTokens` (finish reason `length`) without a valid result.
 */
export type LlmCallOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly errorKind: string };

/**
 * Why the provider stopped, as the AI SDK reports it; `no-response` when the
 * request threw before any response arrived. A value the SDK does not document
 * is kept as `unrecognized:<value>` rather than folded into a known one.
 */
export type LlmFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "no-response"
  | `unrecognized:${string}`;

/**
 * One provider request about to be sent, as the pre-call check sees it. Finance
 * estimates its worst-case cost from `requestBytes` and `maxOutputTokens`.
 */
export interface PendingLlmCall {
  /** Unique per provider request; the recorded call carries the same id. */
  readonly callId: string;
  readonly context: LlmCallContext;
  readonly provider: string;
  readonly model: ModelConfig;
  readonly operation: LlmCallOperation;
  /** UTF-8 bytes of everything sent as input: prompt, system text, messages, schema and tool schemas. */
  readonly requestBytes: number;
  /** The output bound sent with the request. */
  readonly maxOutputTokens: number;
}

/** One provider request as the gateway saw it; `usage` is `null` when the request produced no usage report. */
export interface LlmProviderCall extends PendingLlmCall {
  /**
   * The instant the request was sent. The one instant per call: the cost
   * ledger prices the call at the rates in force here, and so does the cost the
   * gateway returns, so a call that straddles a price-window edge is priced once.
   */
  readonly requestedAt: Date;
  readonly usage: ExtractedUsage | null;
  readonly finishReason: LlmFinishReason;
  readonly outcome: LlmCallOutcome;
}

/**
 * Supplied by the composition root. `assertPriced` is the pre-call check: it
 * runs before every provider request and throws a `PreCallRefusal` to refuse
 * it (Finance refuses an unpriced model, and a call whose worst-case cost would
 * cross a spend cap). `record` runs once after every admitted request, success
 * or failure, with the same `callId`; a throw from it fails the call.
 */
export interface LlmCallRecorder {
  assertPriced(call: PendingLlmCall): Promise<void> | void;
  record(call: LlmProviderCall): Promise<void>;
}

/**
 * Whether a gateway records its calls. `unrecorded` names why, so a process
 * that skips the ledger says so at its construction site instead of by omission.
 */
export type CallRecording =
  | { readonly kind: "recorded"; readonly recorder: LlmCallRecorder }
  | { readonly kind: "unrecorded"; readonly reason: string };
