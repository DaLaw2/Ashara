/**
 * Cache-aware brief assembly + quality gate.
 *
 * Assembles a complete brief for agent dispatch, ordered most-stable-first
 * so that the fixed prefix (system prompt, tools, project profile) hits
 * the Anthropic prompt cache while only the dynamic suffix changes per task.
 */

import type { RetrievalResult } from "@ashara/memory";

import type { TaskSpec } from "./types.js";
import { pruneContext, DEFAULT_MIN_RELEVANCE } from "./pruner.js";
import type { PrunedChunk } from "./pruner.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BriefConfig {
    readonly contextWindowTokens: number;
    readonly targetUtilization: number; // 0.6-0.8, default 0.7
    readonly maxRetries: number; // default 2
}

export interface ProjectProfile {
    readonly name: string;
    readonly techStack: string[];
    readonly buildCommand: string;
    readonly testCommand: string;
    readonly lintCommand: string;
    readonly conventions: string[];
    readonly moduleBoundaries: string;
}

export interface Brief {
    // Fixed prefix (cacheable)
    readonly systemPrompt: string;
    readonly toolDefinitions: string[];
    readonly projectProfile: ProjectProfile;

    // Dynamic suffix (varies per task)
    readonly contextMap: string;
    readonly repoMap: string;
    readonly codeContext: string;
    readonly knowledgeContext: string;
    readonly taskSpec: string;

    // Metadata
    readonly totalTokens: number;
    readonly prefixTokens: number;
    readonly suffixTokens: number;
    readonly utilization: number;
}

export interface QualityCheckResult {
    readonly passed: boolean;
    readonly detail: string;
}

export interface QualityGateResult {
    readonly passed: boolean;
    readonly checks: {
        readonly relevance: QualityCheckResult;
        readonly economy: QualityCheckResult;
    };
    readonly failedChecks: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_UTILIZATION = 0.7;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CONTEXT_WINDOW = 128_000;

// ---------------------------------------------------------------------------
// Token estimation (matches packages/memory chunker convention)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Format functions
// ---------------------------------------------------------------------------

export function formatSystemPrompt(): string {
    return [
        "# Agent Role",
        "",
        "You are a software development agent executing a precisely defined task.",
        "Follow all instructions exactly. Do not add features beyond what is specified.",
        "",
        "# Constraints",
        "",
        "- Follow all project conventions listed in the Project Profile",
        "- Only modify files within the specified scope",
        "- Write code that passes all deterministic checks",
        "- Use English for all code, comments, and documentation",
        "- The project entry point (src/index.ts or equivalent) is EDIT-ONLY: modify it with targeted edits; never delete-and-recreate it or replace it wholesale",
        "- Preserve the entry point's existing imports and route mounts unless the task explicitly says to remove them",
        "",
        "# Output Format",
        "",
        "- Produce the deliverables specified in the task",
        "- Report STATUS (done|blocked), SUMMARY, and FILES_CHANGED",
    ].join("\n");
}

export function formatProjectProfile(profile: ProjectProfile): string {
    const lines = [
        `# Project: ${profile.name}`,
        "",
        `## Tech Stack`,
        ...profile.techStack.map((t) => `- ${t}`),
        "",
        `## Commands`,
        `- Build: \`${profile.buildCommand}\``,
        `- Test: \`${profile.testCommand}\``,
        `- Lint: \`${profile.lintCommand}\``,
        "",
        `## Conventions`,
        ...profile.conventions.map((c) => `- ${c}`),
    ];

    if (profile.moduleBoundaries) {
        lines.push("", "## Module Boundaries", profile.moduleBoundaries);
    }

    return lines.join("\n");
}

export function formatTaskSpec(spec: TaskSpec): string {
    return [
        "# Task",
        "",
        "## Goal",
        spec.goal,
        "",
        "## End State",
        spec.endState,
        "",
        "## Scope",
        spec.scope,
        "",
        "## Deliverables",
        ...spec.deliverables.map((d, i) => `${i + 1}. ${d}`),
        "",
        "## Verification Checks",
        ...spec.checks.map((c) => `- ${c}`),
    ].join("\n");
}

export function formatCodeContext(chunks: readonly PrunedChunk[]): string {
    if (chunks.length === 0) return "";

    // Group chunks by file path for readability
    const byFile = new Map<string, PrunedChunk[]>();
    for (const chunk of chunks) {
        const existing = byFile.get(chunk.filePath) ?? [];
        existing.push(chunk);
        byFile.set(chunk.filePath, existing);
    }

    const sections: string[] = [];
    for (const [filePath, fileChunks] of byFile) {
        const sorted = [...fileChunks].sort((a, b) => a.startLine - b.startLine);
        const header = `### ${filePath}`;
        const body = sorted
            .map((c) => `// Lines ${c.startLine}-${c.endLine}\n${c.content}`)
            .join("\n\n");
        sections.push(`${header}\n\n${body}`);
    }

    return ["# Code Context", "", ...sections].join("\n");
}

// ---------------------------------------------------------------------------
// Brief assembly
// ---------------------------------------------------------------------------

export function assembleBrief(
    taskSpec: TaskSpec,
    retrievalResults: readonly RetrievalResult[],
    projectProfile: ProjectProfile,
    config: Partial<BriefConfig> = {},
    contextMap: string = "",
    repoMap: string = "",
    toolDefinitions: string[] = [],
    knowledgeContext: string = "",
): Brief {
    const contextWindowTokens = config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW;
    const targetUtilization = config.targetUtilization ?? DEFAULT_TARGET_UTILIZATION;
    const maxContextTokens = Math.floor(contextWindowTokens * targetUtilization);

    // 1. Build fixed prefix
    const systemPrompt = formatSystemPrompt();
    const profileText = formatProjectProfile(projectProfile);
    const toolsText = toolDefinitions.join("\n\n");

    const prefixTokens =
        estimateTokens(systemPrompt) +
        estimateTokens(toolsText) +
        estimateTokens(profileText);

    // 2. Calculate remaining budget for dynamic suffix
    const dynamicBudget = Math.max(0, maxContextTokens - prefixTokens);

    // 3. Build dynamic suffix components (non-code items)
    const formattedTaskSpec = formatTaskSpec(taskSpec);
    const taskSpecTokens = estimateTokens(formattedTaskSpec);
    const contextMapTokens = estimateTokens(contextMap);
    const repoMapTokens = estimateTokens(repoMap);
    const knowledgeTokens = estimateTokens(knowledgeContext);

    // Task spec, context map, repo map, and knowledge are non-negotiable
    const fixedDynamicTokens = taskSpecTokens + contextMapTokens + repoMapTokens + knowledgeTokens;
    const codeContextBudget = Math.max(0, dynamicBudget - fixedDynamicTokens);

    // 4. Prune code context to fit remaining budget
    const pruningResult = pruneContext(retrievalResults, {
        maxTokens: codeContextBudget,
        minRelevanceScore: DEFAULT_MIN_RELEVANCE,
        preserveSyntax: true,
    });

    const codeContextText = formatCodeContext(pruningResult.chunks);
    const codeContextTokens = estimateTokens(codeContextText);

    // 5. Compute final token counts
    const suffixTokens = contextMapTokens + repoMapTokens + codeContextTokens + knowledgeTokens + taskSpecTokens;
    const totalTokens = prefixTokens + suffixTokens;
    const utilization = contextWindowTokens > 0 ? totalTokens / contextWindowTokens : 0;

    return {
        systemPrompt,
        toolDefinitions,
        projectProfile,
        contextMap,
        repoMap,
        codeContext: codeContextText,
        knowledgeContext,
        taskSpec: formattedTaskSpec,
        totalTokens,
        prefixTokens,
        suffixTokens,
        utilization,
    };
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

export function checkQualityGate(
    brief: Brief,
    retrievalResults: readonly RetrievalResult[],
): QualityGateResult {
    const failedChecks: string[] = [];

    // 1. Relevance: at least 50% of code chunks have relevance score above the floor
    const relevance = checkRelevance(retrievalResults);
    if (!relevance.passed) failedChecks.push("relevance");

    // 2. Economy: utilization between 0.4 and 0.9
    const economy = checkEconomy(brief);
    if (!economy.passed) failedChecks.push("economy");

    return {
        passed: failedChecks.length === 0,
        checks: { relevance, economy },
        failedChecks,
    };
}

function checkRelevance(retrievalResults: readonly RetrievalResult[]): QualityCheckResult {
    if (retrievalResults.length === 0) {
        return { passed: true, detail: "No retrieval results to check" };
    }

    const aboveThreshold = retrievalResults.filter((r) => r.score > DEFAULT_MIN_RELEVANCE).length;
    const ratio = aboveThreshold / retrievalResults.length;
    const passed = ratio >= 0.5;

    return {
        passed,
        detail: passed
            ? `${aboveThreshold}/${retrievalResults.length} chunks above relevance threshold (${(ratio * 100).toFixed(0)}%)`
            : `Only ${aboveThreshold}/${retrievalResults.length} chunks above relevance threshold (${(ratio * 100).toFixed(0)}%, need 50%)`,
    };
}

function checkEconomy(brief: Brief): QualityCheckResult {
    const { utilization } = brief;

    // Greenfield exception: when the target project has no files and there is
    // no prior knowledge, the brief consists only of system prompt + task spec.
    // That will never reach 40% utilization and that is expected for a first task.
    const isGreenfield = !brief.contextMap && !brief.codeContext && !brief.knowledgeContext;

    if (isGreenfield) {
        return {
            passed: true,
            detail: `Utilization ${(utilization * 100).toFixed(1)}% (greenfield project — economy check skipped)`,
        };
    }

    if (utilization < 0.4) {
        return {
            passed: false,
            detail: `Utilization too low: ${(utilization * 100).toFixed(1)}% (minimum 40%)`,
        };
    }

    if (utilization > 0.9) {
        return {
            passed: false,
            detail: `Utilization too high: ${(utilization * 100).toFixed(1)}% (maximum 90%)`,
        };
    }

    const warn = utilization < 0.6 || utilization > 0.8;
    return {
        passed: true,
        detail: warn
            ? `Utilization ${(utilization * 100).toFixed(1)}% (within bounds but outside ideal 60-80% range)`
            : `Utilization ${(utilization * 100).toFixed(1)}% (within ideal range)`,
    };
}

// ---------------------------------------------------------------------------
// Build with retry
// ---------------------------------------------------------------------------

export async function buildBriefWithRetry(
    taskSpec: TaskSpec,
    projectProfile: ProjectProfile,
    retrieveFn: (query: string, mentionedSymbols?: string[]) => Promise<RetrievalResult[]>,
    config: Partial<BriefConfig> = {},
    contextMap: string = "",
    repoMap: string = "",
    toolDefinitions: string[] = [],
    knowledgeContext: string = "",
): Promise<{ brief: Brief; qualityGate: QualityGateResult }> {
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

    let attempt = 0;
    let lastBrief: Brief | null = null;
    let lastGate: QualityGateResult | null = null;

    while (attempt <= maxRetries) {
        // Extract identifiers from goal for targeted retrieval
        const identifiers = extractIdentifiersFromGoal(taskSpec.goal);

        // Adjust retrieval parameters on retry
        const query = attempt === 0
            ? taskSpec.goal
            : `${taskSpec.goal} ${taskSpec.scope} ${taskSpec.deliverables.join(" ")}`;

        const results = await retrieveFn(query, identifiers);

        const brief = assembleBrief(
            taskSpec,
            results,
            projectProfile,
            config,
            contextMap,
            repoMap,
            toolDefinitions,
            knowledgeContext,
        );

        const qualityGate = checkQualityGate(brief, results);

        lastBrief = brief;
        lastGate = qualityGate;

        if (qualityGate.passed) {
            return { brief, qualityGate };
        }

        attempt++;
    }

    // SAFETY: lastBrief and lastGate are assigned on every loop iteration, and the loop runs at least once (attempt starts at 0, maxRetries >= 0).
    return { brief: lastBrief!, qualityGate: lastGate! };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plausible code identifiers from a goal string. */
function extractIdentifiersFromGoal(goal: string): string[] {
    const matches = goal.match(/[A-Z][a-zA-Z0-9]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+\.[a-z]+/g);
    if (!matches) return [];
    return [...new Set(matches)];
}
