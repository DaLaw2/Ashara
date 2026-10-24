import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { TURN_MAX_OUTPUT_TOKENS } from "./context-window.js";
import { InvalidThinkingPolicy, ModelsConfigUnreadable } from "./errors.js";
import { KNOWN_LLM_SITES, THINKING_MODES } from "./types.js";
import type { KnownLLMSite, ProviderType, ThinkingMode, ThinkingPolicy } from "./types.js";

/** Thinking off at every site: the policy default. */
const THINKING_OFF: ThinkingPolicy = { default: "off", sites: {} };

const ThinkingModeSchema = z.enum(THINKING_MODES);

const ThinkingTableSchema = z
  .object({
    default: ThinkingModeSchema,
    sites: z.partialRecord(z.enum(KNOWN_LLM_SITES), ThinkingModeSchema).optional(),
  })
  .strict();

const TomlThinkingRootSchema = z.object({ thinking: z.unknown().optional() });

/**
 * Reads the `[thinking]` table of a models.toml file. A file that parses with
 * no `[thinking]` table is thinking off everywhere; a missing or
 * unparseable file throws {@link ModelsConfigUnreadable}, and a table that IS
 * present and invalid throws {@link InvalidThinkingPolicy}.
 */
export function loadThinkingPolicyFromToml(configPath: string): ThinkingPolicy {
  let table: unknown;
  try {
    table = TomlThinkingRootSchema.parse(parse(readFileSync(configPath, "utf-8"))).thinking;
  } catch (err) {
    throw new ModelsConfigUnreadable(configPath, "[thinking]", err);
  }
  if (table === undefined) return THINKING_OFF;

  const parsed = ThinkingTableSchema.safeParse(table);
  if (!parsed.success) {
    throw new InvalidThinkingPolicy(
      configPath,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  // eslint-disable-next-line no-restricted-syntax -- policy default: a policy file that overrides no site leaves every site on its default
  return { default: parsed.data.default, sites: parsed.data.sites ?? {} };
}

const KNOWN_SITES: ReadonlySet<string> = new Set(KNOWN_LLM_SITES);

function isKnownSite(site: string): site is KnownLLMSite {
  return KNOWN_SITES.has(site);
}

/** The mode for a call tagged `site`; a site the policy does not name, or no site, uses its default. */
export function thinkingModeFor(policy: ThinkingPolicy | undefined, site: string | undefined): ThinkingMode {
  const effective = policy ?? THINKING_OFF;
  if (site === undefined || !isKnownSite(site)) return effective.default;
  return effective.sites[site] ?? effective.default;
}

/**
 * The provider options that set `mode` for a provider type. Only the DeepSeek
 * adapter takes a thinking switch (`@ai-sdk/deepseek` 3.0.59: thinking is on by
 * default for `deepseek-flash` and every `deepseek-v4-*` id unless `thinking.type` is
 * `disabled`); every other type gets no option.
 */
export function thinkingProviderOptions(
  providerType: ProviderType,
  mode: ThinkingMode,
): { readonly deepseek: { readonly thinking: { readonly type: "enabled" | "disabled" } } } | undefined {
  if (providerType !== "deepseek") return undefined;
  return { deepseek: { thinking: { type: mode === "on" ? "enabled" : "disabled" } } };
}

/**
 * The least output added for reasoning to a request sent with thinking on. Why:
 * DeepSeek counts reasoning against `max_tokens`, so a bound sized for the
 * answer alone can be spent entirely on reasoning. DeepSeek's own
 * default bound in thinking mode is 64K
 * (api-docs.deepseek.com/api/create-chat-completion); half of it for
 * reasoning, on top of the answer, is a policy choice. A request still
 * cut off reports its allowance in its `StructuredOutputTruncated`.
 */
const MIN_REASONING_ALLOWANCE_TOKENS = 32_768;

/**
 * The sites whose one-shot request reasons past {@link MIN_REASONING_ALLOWANCE_TOKENS}
 * however small its prompt, and the least allowance each gets instead. A suite review
 * reads every check of a revision at once: deepseek-flash reasons up to about 52K tokens
 * on one review, and a review held to the general minimum spends its whole bound
 * reasoning and answers nothing. DeepSeek's whole 64K thinking-mode default, on top of
 * the answer, leaves about a quarter more than the most a review was seen to reason.
 */
const SITE_MIN_REASONING_ALLOWANCE_TOKENS: Partial<Record<KnownLLMSite, number>> = { "suite-review": 65_536 };

/**
 * Reasoning tokens allowed per byte of a one-shot request's prompt, above the
 * site's minimum, for every site that runs with thinking on. How much reasoning
 * any site needs as its prompt grows is unmeasured. One token per byte is about
 * four per prompt token. The worst-case price follows, because
 * Finance prices the bound this returns.
 */
const REASONING_TOKENS_PER_PROMPT_BYTE = 1;

function minReasoningAllowance(site: string | undefined): number {
  if (site === undefined || !isKnownSite(site)) return MIN_REASONING_ALLOWANCE_TOKENS;
  return SITE_MIN_REASONING_ALLOWANCE_TOKENS[site] ?? MIN_REASONING_ALLOWANCE_TOKENS;
}

/** DeepSeek's documented `max_tokens` ceiling: "between 1 and 384K (393216)" (same page). */
const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;

/** The output bound a request is sent with, and how much of it is the reasoning allowance. */
export interface OutputBudget {
  /** Sent as the request's `maxOutputTokens`; Finance prices the worst case from it. */
  readonly maxOutputTokens: number;
  /** The part of `maxOutputTokens` added for reasoning; 0 when thinking is not sent on. */
  readonly reasoningAllowance: number;
}

/**
 * The bound for a request whose answer needs `answerTokens`. Only a request
 * that actually carries thinking on gets the allowance: the provider types
 * {@link thinkingProviderOptions} sends no switch to keep the caller's bound.
 * `promptBytes` is the material the request reasons over; an agent turn passes
 * 0, since its prompt is mostly the history earlier turns already reasoned over.
 * `site` is the call's own site and sets the allowance's minimum: an escalated attempt passes the
 * site of the call it escalates, not "escalation", since it reasons over the same material.
 * The bound never exceeds DeepSeek's documented ceiling.
 */
export function outputBudget(
  providerType: ProviderType,
  mode: ThinkingMode,
  answerTokens: number,
  promptBytes: number,
  site: string | undefined,
): OutputBudget {
  if (providerType !== "deepseek" || mode !== "on") return { maxOutputTokens: answerTokens, reasoningAllowance: 0 };
  const allowance = Math.max(minReasoningAllowance(site), Math.ceil(promptBytes * REASONING_TOKENS_PER_PROMPT_BYTE));
  const maxOutputTokens = Math.min(answerTokens + allowance, DEEPSEEK_MAX_OUTPUT_TOKENS);
  return { maxOutputTokens, reasoningAllowance: maxOutputTokens - answerTokens };
}

/**
 * The output one agent turn reserves in its model's window: the turn's answer bound plus, when
 * thinking is sent on, the reasoning allowance. The gateway's preflight and the catalog's boot
 * check (config.ts) both read it, so a window boot admits is one a turn can fit input in.
 */
export function turnOutputBudget(providerType: ProviderType, mode: ThinkingMode): OutputBudget {
  return outputBudget(providerType, mode, TURN_MAX_OUTPUT_TOKENS, 0, undefined);
}

/** The largest output a turn on a provider type reserves, and the site whose mode sets it. */
export interface TurnOutputReserve {
  readonly tokens: number;
  /** "untagged" is a turn that names no known site, which runs on the policy's default. */
  readonly site: KnownLLMSite | "untagged";
}

/**
 * The largest {@link turnOutputBudget} a turn on a provider of `providerType` reserves under
 * `policy`, over every known site and an untagged turn: a model may serve a turn at any of them,
 * so the catalog's boot check compares each window with this.
 */
export function widestTurnOutputReserve(providerType: ProviderType, policy: ThinkingPolicy): TurnOutputReserve {
  let widest: TurnOutputReserve = { tokens: turnOutputBudget(providerType, policy.default).maxOutputTokens, site: "untagged" };
  for (const site of KNOWN_LLM_SITES) {
    const tokens = turnOutputBudget(providerType, thinkingModeFor(policy, site)).maxOutputTokens;
    if (tokens > widest.tokens) widest = { tokens, site };
  }
  return widest;
}
