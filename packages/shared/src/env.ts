// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface BudgetEnv {
    readonly total: number;
    /** Per-provider lifetime spend cap in USD, keyed by lowercase provider name. */
    readonly perProvider: Record<string, number>;
}

const BUDGET_PROVIDER_PREFIX = "ASHARA_BUDGET_PROVIDER_";

/**
 * Parses `ASHARA_BUDGET_PROVIDER_<NAME>=<usd>` env vars into a per-provider
 * cap map. `<NAME>` is matched case-insensitively and lowercased to match
 * `ProviderConfig.name` (e.g. `ASHARA_BUDGET_PROVIDER_ANTHROPIC=15` ->
 * `{ anthropic: 15 }`). Entries with a non-finite value are skipped rather
 * than defaulted, since a silently-wrong cap is worse than no cap.
 */
function parseProviderBudgets(env: NodeJS.ProcessEnv): Record<string, number> {
    const caps: Record<string, number> = {};
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(BUDGET_PROVIDER_PREFIX)) continue;
        const providerName = key.slice(BUDGET_PROVIDER_PREFIX.length).toLowerCase();
        if (!providerName || value === undefined) continue;
        const parsed = parseFloat(value);
        if (Number.isFinite(parsed)) {
            caps[providerName] = parsed;
        }
    }
    return caps;
}

export function loadBudgetEnv(): BudgetEnv {
    const rawTotal = process.env["ASHARA_BUDGET_TOTAL"];
    if (rawTotal !== undefined) {
        const parsed = parseFloat(rawTotal);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            console.warn(
                `ASHARA_BUDGET_TOTAL="${rawTotal}" is not a valid positive number — falling back to default`,
            );
        }
    }
    return {
        total: parseFloatOr(process.env["ASHARA_BUDGET_TOTAL"], 50),
        perProvider: parseProviderBudgets(process.env),
    };
}

/** Optional operator override for the models.toml config path (`ASHARA_MODELS_CONFIG`). */
export function loadModelsConfigPathEnvOverride(): string | undefined {
    return nonEmpty(process.env["ASHARA_MODELS_CONFIG"]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string | undefined {
    if (!value || value.trim() === "") return undefined;
    return value;
}

function parseFloatOr(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
