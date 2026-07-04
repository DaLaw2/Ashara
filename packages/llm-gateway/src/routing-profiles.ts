import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";

import type { RoutingProfiles } from "./types.js";

// ---------------------------------------------------------------------------
// Routing profiles (routing-profiles story): static per-site model playbooks
// keyed by the deployment's enabled-provider combo, e.g.
//
//   [routing.profiles."anthropic+deepseek"]
//   "agent-runner" = { Frontier = "deepseek-v4-pro", default = "deepseek-v4-flash" }
//   "decomposition" = "claude-opus-4-8"
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
// fails validation loudly via the existing invalid-shape fallback below,
// rather than being silently stripped.
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

const RoutingProfilesSchema: z.ZodType<RoutingProfiles> = z.record(
  z.string(),
  z.record(z.string(), RoutingProfileEntrySchema),
);

interface TomlRoutingRoot {
  routing?: { profiles?: unknown };
}

/**
 * Parses `[routing.profiles."<combo>"]` tables from a models.toml file. Never
 * throws: a missing file, unparseable TOML, or a `[routing.profiles]` shape
 * that fails validation all degrade to "no profiles" (empty map) with a
 * warning — mirrors `loadModelsWithFallback`'s graceful-degradation
 * convention for this same file. Routing profiles are optional per-site
 * overlays; their absence must never block gateway construction.
 */
export function loadRoutingProfilesFromToml(configPath: string): RoutingProfiles {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parse(raw) as TomlRoutingRoot;
    if (!parsed.routing?.profiles) return {};

    const result = RoutingProfilesSchema.safeParse(parsed.routing.profiles);
    if (!result.success) {
      console.warn(
        `[RoutingProfiles] invalid [routing.profiles] shape in ${configPath}, ignoring: ${result.error.message}`,
      );
      return {};
    }
    return result.data;
  } catch (err) {
    console.warn(
      `[RoutingProfiles] failed to load routing profiles from ${configPath}, proceeding with none:`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
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
