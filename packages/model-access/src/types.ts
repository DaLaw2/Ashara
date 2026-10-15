import type { ZodType } from "zod";
import type { CapabilityLevel } from "@ashara/shared";

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
  /** Searched first in capability routing; null only with zero providers, which `buildGateway` refuses. */
  defaultProvider: string | null;
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
  "suite-review",
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

/**
 * Rates that replace the model's base rates for a whole call whose reported
 * input tokens (both cache classes included) are at least `minInputTokens`.
 * The threshold is stored at the lowest reading of the provider's wording, so a
 * count inside an ambiguous boundary is billed the higher tier.
 */
interface PriceTier {
  readonly minInputTokens: number;
  readonly rates: TokenRates;
}

export interface ModelConfig extends TokenRates {
  id: string;
  apiModelId: string;
  provider: string;
  capabilityLevel: CapabilityLevel;
  maxContextTokens: number;
  readonly priceWindows: readonly PriceWindow[];
  /** Prompt-length tiers; empty when the model bills one rate at every prompt length. */
  readonly priceTiers: readonly PriceTier[];
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

export interface StructuredRequest<T> {
  capability: CapabilityLevel;
  prompt: string;
  schema: ZodType<T>;
  systemPrompt?: string;
  /** The output bound sent with the request; the gate prices the call's worst case from it. */
  maxTokens: number;
  /** Call-site tag for static per-site routing. Optional — a site-less request always uses capability logic. */
  site?: KnownLLMSite;
}

export interface StructuredResponse<T> {
  data: T;
  usage: TokenUsage;
  provider: string;
  model: string;
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
 * One provider request about to be sent, as the gate sees it. The gate
 * estimates its worst-case cost from `requestBytes` and `maxOutputTokens`.
 */
export interface ProviderRequest {
  /** Unique per provider request; the settled request carries the same id. */
  readonly callId: string;
  readonly provider: string;
  readonly model: ModelConfig;
  readonly operation: LlmCallOperation;
  /** UTF-8 bytes of everything sent as input: prompt, system text, messages, schema and tool schemas. */
  readonly requestBytes: number;
  /** The output bound sent with the request. */
  readonly maxOutputTokens: number;
}

/** One provider request as the gateway saw it; `usage` is `null` when the request produced no usage report. */
export interface SentProviderRequest extends ProviderRequest {
  /** The instant the request was sent, the one instant per request: the gate prices it at the rates in force here. */
  readonly requestedAt: Date;
  readonly usage: ExtractedUsage | null;
  readonly finishReason: LlmFinishReason;
  readonly outcome: LlmCallOutcome;
  /** The request's own error when it failed; `undefined` when it returned a response. */
  readonly providerError: unknown;
}

/**
 * What every provider request passes through. Finance's guarded port supplies
 * it, and the gateway has no entry point without one. `admit` runs before the
 * request: whatever it throws refuses the request, which is then never sent and
 * never retried on a fallback model, and the throw reaches the caller as itself.
 * `settle` runs once after every admitted request, success or failure: whatever
 * it throws fails the call, unretried, as itself.
 */
export interface ProviderRequestGate {
  admit(request: ProviderRequest): Promise<void>;
  settle(request: SentProviderRequest): Promise<void>;
}

