import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { InvalidThinkingPolicy, ModelsConfigUnreadable } from "./errors.js";
import { KNOWN_LLM_SITES, THINKING_MODES } from "./types.js";
import type { KnownLLMSite, ProviderType, ThinkingMode, ThinkingPolicy } from "./types.js";

/** Thinking off at every site: the decided default (ADR-074 D13). */
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
 * no `[thinking]` table is thinking off everywhere (ADR-074 D13); a missing or
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
 * default for `deepseek-flash` and every V4 id unless `thinking.type` is
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
 * answer alone can be spent entirely on reasoning. In the W5 trial
 * (2026-10-14) 7 of 12 deepseek-flash calls stopped at `length` with output
 * tokens equal to reasoning tokens and 0 characters of text, at bounds of
 * 2,048 and 4,096. DeepSeek's own default bound in thinking mode is 64K
 * (api-docs.deepseek.com/api/create-chat-completion, read 2026-10-14); half of
 * it for reasoning, on top of the answer, is a policy choice. A request still
 * cut off reports its allowance in its `StructuredOutputTruncated`.
 */
const MIN_REASONING_ALLOWANCE_TOKENS = 32_768;

/**
 * Reasoning tokens allowed per byte of a one-shot request's prompt, above the
 * minimum, for every site that runs with thinking on (decomposition among
 * them). The scaling was introduced (a7bd9bbb) on the theory
 * that the suite review's cut tracked its prompt: in W11c (2026-10-14,
 * llm_calls) both suite-review calls, at 20,084 and 20,192 input tokens, spent
 * all 36,864 output tokens reasoning and were cut off. smoke2 (2026-10-15,
 * docs/investigations/smoke2-python-wc-2026-10-15.md D2) disproved that for
 * the suite review: its prompt was small enough that the allowance was the
 * 32,768 minimum, and the call again spent all 36,864 output tokens on
 * reasoning with no answer. So the suite review now runs with thinking off
 * (config/models.toml, ADR-074 d95 b) and gets no allowance; how much
 * reasoning any site needs as its prompt grows is unmeasured. One token per
 * byte is about four per prompt token. The worst-case price follows, because
 * Finance prices the bound this returns.
 */
const REASONING_TOKENS_PER_PROMPT_BYTE = 1;

/** DeepSeek's documented `max_tokens` ceiling: "between 1 and 384K (393216)" (same page, read 2026-10-14). */
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
 * The bound never exceeds DeepSeek's documented ceiling.
 */
export function outputBudget(providerType: ProviderType, mode: ThinkingMode, answerTokens: number, promptBytes: number): OutputBudget {
  if (providerType !== "deepseek" || mode !== "on") return { maxOutputTokens: answerTokens, reasoningAllowance: 0 };
  const allowance = Math.max(MIN_REASONING_ALLOWANCE_TOKENS, Math.ceil(promptBytes * REASONING_TOKENS_PER_PROMPT_BYTE));
  const maxOutputTokens = Math.min(answerTokens + allowance, DEEPSEEK_MAX_OUTPUT_TOKENS);
  return { maxOutputTokens, reasoningAllowance: maxOutputTokens - answerTokens };
}
