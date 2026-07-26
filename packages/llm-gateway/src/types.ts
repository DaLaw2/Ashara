import type { CapabilityLevel } from "@ashara/shared";
import { z, type ZodType } from "zod";

export interface ModelPreferences {
  preferredProvider?: string;
  preferredModels?: Partial<Record<CapabilityLevel, string>>;
}

/**
 * Per-capability model table for a single site (routing-profiles story). Used
 * when one site's requests legitimately vary in REQUESTED capability across
 * calls — e.g. agent-runner tags every request `site: "agent-runner"` but the
 * per-task capability ranges over Light/Strong/Frontier (see
 * `inferCapability` in planning/decomposition.ts) — so a single fixed model
 * for the site would silently downgrade a Frontier-classified task. `default`
 * covers any requested capability without its own entry; a capability with
 * neither its own entry nor `default` falls through to capability logic
 * (fail-soft + warn — see `ProviderRegistry.resolveFromProfile`). Only the
 * SITE dimension is boot-enforced; picking which capabilities a table covers
 * stays the author's call.
 */
export type RoutingProfileCapabilityTable = Partial<Record<CapabilityLevel, string>> & {
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
  preferences?: ModelPreferences;
  /** Static per-site routing playbooks, keyed by enabled-provider combo. */
  routingProfiles?: RoutingProfiles;
}

/**
 * The exhaustive registry of call-site identifiers used for static per-site
 * routing (`GatewayConfig.routingProfiles`). Enforced in both directions:
 *
 * - Forward: `CompletionRequest.site` / `StructuredRequest.site` /
 *   `StructuredLadderOptions.site` are typed `KnownLLMSite`, so tagging a new
 *   call site is a compile error until it is registered here.
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
  "brainstorm",
  "northstar",
  "acceptance",
  "replan",
  "stack-derivation",
  "alignment",
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

export type FormatGroup = "native-fc" | "code-fence" | "text-patch";

export interface ModelConfig {
  id: string;
  apiModelId: string;
  provider: string;
  capabilityLevel: CapabilityLevel;
  formatGroup?: FormatGroup;
  strictMode?: boolean;
  inputCostPer1M: number;
  outputCostPer1M: number;
  maxContextTokens: number;
  supportsCaching: boolean;
}

export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

export interface CompletionRequest {
  capability: CapabilityLevel;
  messages: Message[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  cachePrefixLength?: number;
  /** Call-site tag for static per-site routing. Optional — a site-less request always uses capability logic. */
  site?: KnownLLMSite;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "reasoning";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionResponse {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  cost: CostBreakdown;
  provider: string;
  model: string;
  finishReason: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamOptions {
  onToolCall?: (toolCall: ToolCall) => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheSavings: number;
  totalCost: number;
}

export interface BudgetConfig {
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

export interface LLMCallRecord {
  readonly site: string;
  readonly capability: string;
  readonly model: string;
  readonly provider: string;
  readonly promptExcerpt: string;
  readonly responseExcerpt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface StructuredRequest<T> {
  capability: CapabilityLevel;
  prompt: string;
  schema: ZodType<T, z.ZodTypeDef, any>;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Call-site tag for static per-site routing. Optional — a site-less request always uses capability logic. */
  site?: KnownLLMSite;
}

export interface StructuredResponse<T> {
  data: T;
  usage: TokenUsage;
  cost: CostBreakdown;
  provider: string;
  model: string;
}
