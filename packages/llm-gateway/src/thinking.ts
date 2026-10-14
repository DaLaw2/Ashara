import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { describeErrorChain } from "@ashara/shared";
import { InvalidThinkingPolicy } from "./errors.js";
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
 * Reads the `[thinking]` table of a models.toml file. A missing or unparseable
 * file, or a file with no `[thinking]` table, is thinking off everywhere, the
 * same convention `loadRoutingProfilesFromToml` follows for this file; a table
 * that IS present and invalid throws {@link InvalidThinkingPolicy}.
 */
export function loadThinkingPolicyFromToml(configPath: string): ThinkingPolicy {
  let table: unknown;
  try {
    table = TomlThinkingRootSchema.parse(parse(readFileSync(configPath, "utf-8"))).thinking;
  } catch (err) {
    console.warn(
      `[ThinkingPolicy] failed to read ${configPath}, thinking is off at every site (ADR-074 D13):`,
      describeErrorChain(err),
    );
    return THINKING_OFF;
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
