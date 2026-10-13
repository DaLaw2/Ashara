import { z } from "zod";
import type { CapabilityLevel } from "./enums.js";
import { parseCapabilityLevel } from "./enums.js";

// ---------------------------------------------------------------------------
// Provider keys — LLM API credentials
// ---------------------------------------------------------------------------

export interface ProviderKeys {
    readonly anthropicApiKey?: string;
    readonly openaiApiKey?: string;
    readonly deepseekApiKey?: string;
    readonly mistralApiKey?: string;
    readonly xaiApiKey?: string;
    readonly googleApiKey?: string;
    readonly localLlmUrl?: string;
}

export function loadProviderKeys(): ProviderKeys {
    return {
        anthropicApiKey: nonEmpty(process.env["ANTHROPIC_API_KEY"]),
        openaiApiKey: nonEmpty(process.env["OPENAI_API_KEY"]),
        deepseekApiKey: nonEmpty(process.env["DEEPSEEK_API_KEY"]),
        mistralApiKey: nonEmpty(process.env["MISTRAL_API_KEY"]),
        xaiApiKey: nonEmpty(process.env["XAI_API_KEY"]),
        googleApiKey: nonEmpty(process.env["GOOGLE_API_KEY"]),
        localLlmUrl: nonEmpty(process.env["LOCAL_LLM_URL"]),
    };
}

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

// ---------------------------------------------------------------------------
// Server connection — used by CLI and other clients
// ---------------------------------------------------------------------------

export interface ServerEnv {
    readonly serverUrl: string;
    readonly apiToken?: string;
    readonly httpTimeoutMs: number;
}

export function loadServerEnv(): ServerEnv {
    return {
        serverUrl: process.env["ASHARA_SERVER_URL"] ?? "http://localhost:3000",
        apiToken: nonEmpty(process.env["ASHARA_API_TOKEN"]),
        httpTimeoutMs: parseIntOr(process.env["ASHARA_HTTP_TIMEOUT_MS"], 30_000),
    };
}

// ---------------------------------------------------------------------------
// Execution context — env-var handoff from server spawn to agent-runner
// subprocess (SEAM-2). Validated at both ends: fail-closed, no path defaults.
// ---------------------------------------------------------------------------

const ExecutionContextSchema = z.object({
    ASHARA_BRIEF_PATH: z.string().min(1),
    ASHARA_OUTPUT_PATH: z.string().min(1),
    ASHARA_WORKING_DIR: z.string().min(1),
    ASHARA_CATALOG_PATH: z.string().min(1),
    AGENT_CAPABILITY: z.string().min(1).default("Strong"),
});

type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

/** @testseam env.test.ts checks the schema without mutating process.env */
export function parseExecutionContext(env: Record<string, string | undefined>): ExecutionContext {
    return ExecutionContextSchema.parse(env);
}

// ---------------------------------------------------------------------------
// Agent runner — env vars consumed by the agent subprocess
// ---------------------------------------------------------------------------

export interface AgentRunnerEnv {
    readonly workingDir: string;
    readonly briefPath: string;
    readonly outputPath: string;
    readonly catalogPath: string;
    readonly capability: CapabilityLevel;

    readonly modelsConfigPath?: string;
}

export function loadAgentRunnerEnv(): AgentRunnerEnv {
    const ctx = parseExecutionContext(process.env);
    return {
        workingDir: ctx.ASHARA_WORKING_DIR,
        briefPath: ctx.ASHARA_BRIEF_PATH,
        outputPath: ctx.ASHARA_OUTPUT_PATH,
        catalogPath: ctx.ASHARA_CATALOG_PATH,
        capability: parseCapabilityLevel(ctx.AGENT_CAPABILITY),

        modelsConfigPath: loadModelsConfigPathEnvOverride(),
    };
}

/**
 * Optional operator override for the models.toml config path
 * (`ASHARA_MODELS_CONFIG`). Read directly rather than through
 * `loadAgentRunnerEnv()`: pricing/routing-profile resolution runs in the
 * server and CLI processes too, not just inside the agent-runner subprocess,
 * where the required `ExecutionContextSchema` fields are never set.
 */
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

function parseIntOr(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatOr(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
