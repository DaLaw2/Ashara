import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { InvalidRoutingProfiles, ModelsConfigUnreadable } from "./errors.js";
import { KNOWN_LLM_SITES } from "./types.js";
import type { RoutingProfileEntry, RoutingProfiles } from "./types.js";

// ---------------------------------------------------------------------------
// Routing profiles: static per-site model playbooks
// keyed by the deployment's enabled-provider combo, e.g.
//
//   [routing.profiles."anthropic+deepseek"]
//   "agent-runner" = { Frontier = "claude-opus-5-5", default = "deepseek-flash" }
//   "decomposition" = "deepseek-flash"
//
// Deliberately a TEMPLATE table, not a learned/scored mechanism (DA-09 stays
// on its own data-gated track) — different enabled-provider combinations
// produce different, hand-authored per-site strategies.
//
// A site value is either a bare model-id string (applied regardless of the
// requested capability — the common case) or a per-capability table for a
// site whose requests legitimately vary in capability across calls (e.g.
// agent-runner — see `RoutingProfileCapabilityTable` in types.ts). `.strict()`
// on the table shape means an unrecognized key (a typo'd capability name)
// fails validation loudly rather than being silently stripped.
//
// Site KEYS are constrained to `KNOWN_LLM_SITES`, catching the reverse of the
// boot completeness check: a key nothing routes through any more (a deleted
// call site) or a key nothing ever routed through (a typo). Partial and empty
// tables still validate — completeness is `buildGateway`'s call, because only
// it knows which combo the deployment actually runs.
// ---------------------------------------------------------------------------

const RoutingProfileEntrySchema = z.union([
  z.string(),
  z
    .object({
      Frontier: z.string().optional(),
      Strong: z.string().optional(),
      Medium: z.string().optional(),
      Light: z.string().optional(),
      default: z.string().optional(),
    })
    .strict(),
]);

const RoutingProfilesSchema = z.record(
  z.string(),
  z.record(z.string(), RoutingProfileEntrySchema),
);

const TomlRoutingRootSchema = z.object({
  routing: z.object({ profiles: z.unknown().optional() }).optional(),
});

const KNOWN_SITES: ReadonlySet<string> = new Set(KNOWN_LLM_SITES);

/**
 * Site keys are checked here rather than by the schema's key type: this
 * package's zod resolves to v3 typings, whose `z.record(z.enum(...))` has no
 * partial form, and the exhaustive form would reject the legitimately EMPTY
 * profile (`[routing.profiles."deepseek"]`). Reported as `"<combo>.<site>"`
 * so the operator can find the line without re-reading the whole table.
 */
function collectUnknownSiteKeys(
  profiles: Record<string, Record<string, RoutingProfileEntry>>,
): string[] {
  const unknown: string[] = [];
  for (const [combo, profile] of Object.entries(profiles)) {
    for (const site of Object.keys(profile)) {
      if (!KNOWN_SITES.has(site)) unknown.push(`${combo}."${site}"`);
    }
  }
  return unknown;
}

const INVALID_PROFILES_HOW_TO_FIX =
  `Site keys must be one of: ${KNOWN_LLM_SITES.map((s) => `"${s}"`).join(", ")}. ` +
  "Delete the offending key, or register the site in KNOWN_LLM_SITES " +
  "(packages/model-access/src/types.ts) if it is a real call site.";

/**
 * Parses `[routing.profiles."<combo>"]` tables from a models.toml file.
 *
 * Throws {@link ModelsConfigUnreadable} when the file is missing or is not
 * TOML: that is a broken deployment, not one that chose no profiles. A file
 * that parses but carries no `[routing.profiles]` block is "no profiles", an
 * optional overlay the deployment chose not to write (policy default).
 *
 * THROWS {@link InvalidRoutingProfiles} when the block IS present but fails
 * validation. That is an authoring error, and degrading it to `{}` would be
 * fail-open twice over: every site would silently drop to capability routing,
 * and the boot completeness check could not catch it either — an empty map
 * yields no profile for the combo, which that check must exempt.
 */
export function loadRoutingProfilesFromToml(configPath: string): RoutingProfiles {
  let profiles: unknown;
  try {
    const parsed = TomlRoutingRootSchema.parse(parse(readFileSync(configPath, "utf-8")));
    profiles = parsed.routing?.profiles;
  } catch (err) {
    throw new ModelsConfigUnreadable(configPath, "[routing.profiles]", err);
  }

  if (!profiles) return {};

  const result = RoutingProfilesSchema.safeParse(profiles);
  if (!result.success) {
    throw new InvalidRoutingProfiles(
      configPath,
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      INVALID_PROFILES_HOW_TO_FIX,
    );
  }

  const unknownSiteKeys = collectUnknownSiteKeys(result.data);
  if (unknownSiteKeys.length > 0) {
    throw new InvalidRoutingProfiles(
      configPath,
      unknownSiteKeys.map((key) => `${key} is not a known LLM site`),
      INVALID_PROFILES_HOW_TO_FIX,
    );
  }

  return result.data;
}

/**
 * The routing-profile combo key for a set of provider names: de-duplicated,
 * sorted, joined by "+" (e.g. `["deepseek", "anthropic"]` -> "anthropic+deepseek").
 * Always computed from the deployment's full ENABLED provider set, never from
 * a per-call exclusion list (fallback/degrade only changes which providers a
 * profile-mapped model is searched for among, not which playbook applies).
 */
export function computeProviderCombo(providerNames: readonly string[]): string {
  return [...new Set(providerNames)].sort().join("+");
}
