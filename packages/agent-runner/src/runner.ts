import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CapabilityLevel, AgentRunnerEnv, AgentBrief } from "@ashara/shared";
import { loadAgentRunnerEnv, parseCapabilityLevel, parseAgentBrief } from "@ashara/shared";
import {
    LLMGateway,
    loadGatewayConfig,
    loadGatewayConfigFromApi,
    buildGateway,
    NoLLMProvidersConfigured,
} from "@ashara/llm-gateway";
import type { ToolDefinition as GatewayToolDefinition } from "@ashara/llm-gateway";

import { AgentConversation } from "./conversation.js";
import type { Gateway } from "./conversation.js";
import { createDefaultRegistry } from "./tools/index.js";
import type { ToolPromptContext } from "./tools/types.js";
import { OutputCollector } from "./output.js";
import type { AgentOutput } from "./output.js";
import type { FormatAdapter } from "./format-adapter.js";
import { NativeFCAdapter, CodeFenceAdapter } from "./format-adapter.js";
import { buildAutoProfile } from "@ashara/development";

import { enrichBrief } from "./brief-builder.js";
import { runInlineVerify } from "./inline-verify.js";
import type { InlineVerifyResult } from "./inline-verify.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunnerConfig {
    readonly workingDir: string;
    readonly briefPath: string;
    readonly outputPath: string;
    readonly maxTurns: number;
    readonly capability: CapabilityLevel;
}

export type { AgentBrief } from "@ashara/shared";

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

export function loadRunnerConfigFromEnv(overrides?: Partial<RunnerConfig>): RunnerConfig {
    const env = loadAgentRunnerEnv();
    return {
        workingDir: overrides?.workingDir ?? env.workingDir,
        briefPath: overrides?.briefPath ?? env.briefPath,
        outputPath: overrides?.outputPath ?? env.outputPath,
        maxTurns: overrides?.maxTurns ?? 25,
        capability: overrides?.capability ?? env.capability,
    };
}

export class AgentRunner {
    constructor(
        private readonly gateway: Gateway,
        private readonly config: RunnerConfig,
    ) {}

    async run(): Promise<AgentOutput> {
        // 1. Read and validate brief
        const briefRaw = await readFile(this.config.briefPath, "utf-8");
        const baseBrief = validateBrief(JSON.parse(briefRaw));

        // 2. Enrich brief with project context
        let brief: AgentBrief;
        try {
            brief = await enrichBrief(baseBrief, this.config.workingDir);
            console.log(`[agent-runner] brief enriched with project context from ${this.config.workingDir}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[agent-runner] brief enrichment failed, using base brief: ${msg}`);
            brief = baseBrief;
        }

        // 3. Build project profile for tool prompt context
        let toolPromptCtx: ToolPromptContext | undefined;
        try {
            const profile = await buildAutoProfile(this.config.workingDir);
            toolPromptCtx = {
                language: profile.techStack[0],
                buildCommand: profile.buildCommand,
                testCommand: profile.testCommand,
                lintCommand: profile.lintCommand,
            };
        } catch {
            toolPromptCtx = undefined;
        }

        // 4. Create tool registry with working directory
        const registry = createDefaultRegistry(this.config.workingDir);

        // 5. Resolve format group and build system prompt
        const formatGroup = resolveFormatGroup(this.gateway, this.config.capability);
        const toolPrompts = registry.collectPrompts(toolPromptCtx);
        const staticSystemPrompt = buildStaticSystemPrompt(formatGroup, toolPrompts);
        const dynamicSystemPrompt = buildDynamicSystemPrompt(brief);

        // 4. Build gateway-compatible tool definitions, filtered by resolved model capability
        const resolvedCapability = resolveEffectiveCapability(this.gateway, this.config.capability);
        const allowed = capabilityToolSet(resolvedCapability);

        const coreTools = registry
            .getCoreDefinitions()
            .filter((def) => allowed.has(def.name));
        const deferredNames = registry
            .getDeferredNames()
            .filter((name) => allowed.has(name));

        const gatewayTools: GatewayToolDefinition[] = [
            ...coreTools.map((def) => ({
                name: def.name,
                description: def.description,
                parameters: {
                    type: def.inputSchema.type,
                    properties: def.inputSchema.properties as Record<string, unknown>,
                    required: [...def.inputSchema.required],
                },
            })),
            ...deferredNames.map((name) => {
                const def = registry.getDefinition(name);
                if (!def) return null;
                return {
                    name: def.name,
                    description: `${def.description} [Schema not loaded — call tool_search("${name}") first]`,
                    parameters: {
                        type: "object" as const,
                        properties: {} as Record<string, unknown>,
                        required: [] as string[],
                    },
                };
            }).filter((t) => t !== null),
        ];

        console.log(
            `[agent-runner] tool filtering: capability=${resolvedCapability}, ` +
            `core=${coreTools.map((t) => t.name).join(", ")}, ` +
            `deferred=${deferredNames.join(", ") || "(none)"}`,
        );

        // 5. Create and run conversation — goal is the task instruction (always non-empty)
        const isWeakModel =
            resolvedCapability === "Light" || resolvedCapability === "Medium";

        const adapter = selectAdapter(formatGroup, resolvedCapability);

        const conversationLogPath = join(this.config.workingDir, ".ashara", "conversation.jsonl");

        const conversation = new AgentConversation(this.gateway, registry, {
            staticSystemPrompt: isWeakModel ? buildWeakModelSystemPrompt(brief) : staticSystemPrompt,
            dynamicSystemPrompt: isWeakModel ? "" : dynamicSystemPrompt,
            tools: gatewayTools,
            capability: this.config.capability,
            adapter,
            maxTurns: this.config.maxTurns,
            workingDir: this.config.workingDir,
            conversationLogPath,
        });

        const result = await conversation.run(brief.goal);

        // 6. Collect output
        const collector = new OutputCollector(this.config.workingDir);
        const output = await collector.collect(result);

        // 7. Run inline verification
        let verifyResult: InlineVerifyResult | null = null;
        try {
            const rawBrief = JSON.parse(briefRaw) as Record<string, unknown>;
            const taskSpec = rawBrief["task_spec"] as Record<string, unknown> | undefined;
            verifyResult = await runInlineVerify(
                this.config.workingDir,
                taskSpec ? {
                    checks: Array.isArray(taskSpec["checks"])
                        ? (taskSpec["checks"] as string[])
                        : brief.constraints,
                } : {
                    checks: brief.constraints,
                },
            );
            console.log(`[agent-runner] inline verify: passed=${verifyResult.passed}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[agent-runner] inline verify failed: ${msg}`);
        }

        // 8. Write output to file (include verify results)
        const outputPath = resolve(this.config.outputPath);
        await collector.writeOutput(output, outputPath);

        if (verifyResult) {
            const outputJson = JSON.parse(await readFile(outputPath, "utf-8"));
            outputJson.verify = verifyResult;
            const { writeFile: writeFileAsync } = await import("node:fs/promises");
            await writeFileAsync(outputPath, JSON.stringify(outputJson, null, 2) + "\n", "utf-8");
        }

        return output;
    }
}

// ---------------------------------------------------------------------------
// Tool filtering by capability
// ---------------------------------------------------------------------------

function resolveEffectiveCapability(gateway: Gateway, requested: CapabilityLevel): CapabilityLevel {
    if ("registry" in gateway && typeof (gateway as any).registry?.resolve === "function") {
        try {
            const resolved = (gateway as any).registry.resolve(requested);
            const actual = parseCapabilityLevel(String(resolved.modelConfig.capabilityLevel));
            if (actual !== requested) {
                console.log(`[agent-runner] capability downgraded: ${requested} → ${actual} (model: ${resolved.modelConfig.id})`);
            }
            return actual;
        } catch {
            return requested;
        }
    }
    return requested;
}

const CORE_TOOLS = ["write_file", "read_file", "list_directory", "tool_search"];
const STANDARD_TOOLS = [...CORE_TOOLS, "run_command"];
const FULL_TOOLS = [...STANDARD_TOOLS, "edit_file", "search_codebase"];

function capabilityToolSet(capability: CapabilityLevel): Set<string> {
    switch (capability) {
        case "Frontier":
        case "Strong":
            return new Set(FULL_TOOLS);
        case "Medium":
            return new Set(STANDARD_TOOLS);
        case "Light":
            return new Set(CORE_TOOLS);
        default: {
            const _exhaustive: never = capability;
            throw new Error(`Unknown capability level: ${String(_exhaustive)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

function resolveFormatGroup(gateway: Gateway, capability: CapabilityLevel): string | undefined {
    if ("registry" in gateway && typeof (gateway as any).registry?.resolve === "function") {
        try {
            const resolved = (gateway as any).registry.resolve(capability);
            return resolved.modelConfig.formatGroup;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function selectAdapter(formatGroup?: string, capability?: CapabilityLevel): FormatAdapter {
    switch (formatGroup) {
        case "native-fc":
            return new NativeFCAdapter();
        case "code-fence":
            return new CodeFenceAdapter();
        default:
            if (capability === "Frontier" || capability === "Strong") {
                return new NativeFCAdapter();
            }
            return new CodeFenceAdapter();
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates the raw brief.json read from disk into an AgentBrief, via the shared
 * schema both sides of the seam parse (ADR-013 / ADR-033 §5). Fail-closed: a
 * malformed brief throws a typed InvalidAgentBriefError and the task is blocked,
 * never run against a defaulted brief.
 */
export function validateBrief(raw: unknown): AgentBrief {
    return parseAgentBrief(raw, "agent-runner:brief.json");
}

export function buildWeakModelSystemPrompt(brief: AgentBrief): string {
    const lines = [
        `You are a coding agent. Use write_file to create files. Use read_file to read files.`,
        `Do not explain. Do not describe. Just call tools.`,
        ``,
        `# Task`,
        brief.goal,
    ];

    if (brief.priorAttemptFailure) {
        lines.push(``, `# Prior Attempt Failure`, brief.priorAttemptFailure);
    }

    if (brief.knowledgeContext && brief.knowledgeContext.trim().length > 0) {
        lines.push(``, `# Prior Knowledge & Lessons`, brief.knowledgeContext);
    }

    if (brief.contractSlice) {
        lines.push(``, brief.contractSlice);
    }

    if (brief.deliverables.length > 0) {
        lines.push(``, `# Files to create`);
        for (const d of brief.deliverables) {
            lines.push(`- ${d}`);
        }
    }

    for (const section of formatSupplementarySections(brief)) {
        lines.push(``, section);
    }

    return lines.join("\n");
}

export function buildStaticSystemPrompt(formatGroup?: string, toolPrompts?: string[]): string {
    const sections: string[] = [];

    sections.push(
        `You are a coding agent. Your ONLY job is to use tools to write code.`,
        `IMPORTANT: You MUST use tools. Every response should contain a tool call. ` +
            `Never describe what you would do — do it by calling tools. ` +
            `If you need to create a file, call write_file. If you need to read a file, call read_file. ` +
            `Do not respond with text unless you have already completed all deliverables.`,
    );

    if (toolPrompts && toolPrompts.length > 0) {
        sections.push(
            [
                `# Using your tools`,
                `Prefer dedicated tools over shell commands when one fits:`,
                ...toolPrompts.map((p) => `- ${p}`),
                ``,
                `If you need information about the project, use tools to get it — do not guess.`,
            ].join("\n"),
        );
    }

    if (formatGroup === "code-fence") {
        sections.push(
            [
                `# Output Format`,
                "You do NOT have tool-calling capability. Instead, output code in fenced blocks with the file path:",
                "```language:path/to/file",
                "code here",
                "```",
                "For example:",
                "```python:app.py",
                `print("hello")`,
                "```",
                "Every code block must include the file path after the language tag, separated by a colon.",
            ].join("\n"),
        );
    }

    sections.push(buildDoingTasksSection());

    sections.push(
        [
            `# Boundaries`,
            `You MUST:`,
            `- Use write_file and edit_file to create and modify code — these are tracked as your deliverables.`,
            `- Run build commands to verify compilation.`,
            `- Run test commands to verify correctness.`,
            ``,
            `You MUST NOT:`,
            `- Start long-running servers or daemons. You MAY run short-lived programs (CLI tools, test binaries, build commands) to verify your work.`,
            `- Use run_command to create files (echo, cp, cat >) — use write_file instead, which tracks your changes.`,
            `- Spend more than 2 turns on any single approach that is not working — try a different approach.`,
        ].join("\n"),
    );

    sections.push(
        [
            `# Output`,
            `Be concise. No conversational openers. No narration of your thought process.`,
            `After completing the task, state what you changed in 1-2 sentences.`,
        ].join("\n"),
    );

    sections.push(
        [
            `# Errors`,
            `If a tool fails, read the error and try a different approach.`,
            `Do not retry the identical failing action. Diagnose first.`,
        ].join("\n"),
    );

    return sections.join("\n\n");
}

function buildDoingTasksSection(): string {
    return [
        `# Doing tasks`,
        `If the working directory already contains files, READ the project manifest and the entry point FIRST.`,
        `Prefer dependencies already declared. If the task requires new ones, use the project's package manager to add them.`,
        `Follow the patterns you observe in existing code.`,
        `Do NOT create alternative entry points or install conflicting libraries.`,
        `The project entry point is EDIT-ONLY: modify it with targeted edits; never delete-and-recreate it or replace it wholesale.`,
        `Preserve the entry point's existing imports and structure unless the task explicitly says to remove them.`,
        `Keep working until the task is fully complete. Do not stop after partial progress.`,
        `Read existing code before making changes. Understand the current state first.`,
        `Make the smallest correct change. Do not refactor, add features, or improve beyond scope.`,
        `Match the existing code style. Do not invent new patterns.`,
        `After making changes, verify them with the project's build and test commands.`,
    ].join("\n");
}

export function buildDynamicSystemPrompt(brief: AgentBrief): string {
    const sections: string[] = [];

    sections.push(`# Task\n## Goal\n${brief.goal}`);

    if (brief.priorAttemptFailure) {
        sections.push(`## Prior Attempt Failure\n${brief.priorAttemptFailure}`);
    }

    if (brief.knowledgeContext && brief.knowledgeContext.trim().length > 0) {
        sections.push(`## Prior Knowledge & Lessons\n${brief.knowledgeContext}`);
    }

    if (brief.contractSlice) {
        sections.push(brief.contractSlice);
    }

    if (brief.context) {
        sections.push(`## Context\n${brief.context}`);
    }

    if (brief.deliverables.length > 0) {
        sections.push(
            `## Deliverables (Required)\nYou are DONE when all deliverables exist and pass checks:\n${brief.deliverables.map((d) => `- [ ] ${d}`).join("\n")}`,
        );
    }

    if (brief.constraints.length > 0) {
        sections.push(
            `## Constraints (Must Follow)\n${brief.constraints.map((c) => `- ${c}`).join("\n")}`,
        );
    }

    sections.push(...formatSupplementarySections(brief));

    return sections.join("\n\n");
}

/**
 * Supplementary prompt sections (ADR-033 §5): retrieved code and the project
 * context map. knowledgeContext is promoted to the binding tier (rendered
 * alongside priorAttemptFailure, before task instructions) so prior lessons
 * carry the same weight as failure context. Code context and the project
 * context map remain here — useful reference, but not directives. Each section
 * is emitted only when its field is present and non-empty.
 */
function formatSupplementarySections(brief: AgentBrief): string[] {
    const sections: string[] = [];

    if (brief.codeContext && brief.codeContext.trim().length > 0) {
        sections.push(`## Retrieved Code Context\n${brief.codeContext}`);
    }
    if (brief.contextMap && brief.contextMap.trim().length > 0) {
        sections.push(`## Project Context Map\n${brief.contextMap}`);
    }
    return sections;
}

// ---------------------------------------------------------------------------
// CLI entry point — invoked when run as `bun run runner.ts`
// ---------------------------------------------------------------------------

if (import.meta.main) {
    const config = loadRunnerConfigFromEnv();
    const env = loadAgentRunnerEnv();

    let gatewayConfig;
    const checkedSources: string[] = [];
    if (env.serverUrl && env.apiToken) {
        try {
            gatewayConfig = await loadGatewayConfigFromApi(env.serverUrl, env.apiToken);
            checkedSources.push(`API ${env.serverUrl}`);
            console.log(`[agent-runner] config loaded from API (${env.serverUrl})`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[agent-runner] API config load failed, falling back to TOML: ${msg}`);
            checkedSources.push(`API ${env.serverUrl} (failed: ${msg})`);
            gatewayConfig = loadGatewayConfig();
            checkedSources.push("TOML/env fallback");
        }
    } else {
        gatewayConfig = loadGatewayConfig();
        checkedSources.push("TOML/env");
    }

    // Single composition-root factory for the gateway (ADR-030) -- no inline
    // refuse-to-start guard duplicated here. Agent-runner has no stub
    // execution path (it always needs a real model to write code), so a
    // "stub" result is also fatal here, matching the prior behavior where
    // zero providers refused to start regardless of ASHARA_TEST_STUB_LLM.
    let gateway: LLMGateway;
    try {
        const built = buildGateway({ config: gatewayConfig, checkedSources });
        if (built.kind === "stub") {
            console.error(
                "[agent-runner] fatal: ASHARA_TEST_STUB_LLM=1 is set, but agent-runner has no stub execution path -- refusing to start.",
            );
            process.exit(1);
        }
        gateway = built.gateway;
    } catch (e) {
        if (e instanceof NoLLMProvidersConfigured) {
            console.error("[agent-runner] fatal: no LLM providers configured (ADR-030) -- refusing to start.");
            console.error(`  checked sources: ${e.checkedSources.join(", ") || "none"}`);
            console.error(`  how to fix: ${e.howToFix}`);
            process.exit(1);
        }
        throw e;
    }

    console.log(`[agent-runner] starting`);
    console.log(`[agent-runner]   brief:     ${config.briefPath}`);
    console.log(`[agent-runner]   output:    ${config.outputPath}`);
    console.log(`[agent-runner]   workdir:   ${config.workingDir}`);
    console.log(`[agent-runner]   providers: ${gatewayConfig.providers.length} (${gatewayConfig.providers.map((p) => p.name).join(", ")})`);

    const runner = new AgentRunner(gateway, config);
    runner
        .run()
        .then((output) => {
            console.log(`[agent-runner] finished with status: ${output.status}`);
            process.exit(output.status === "done" ? 0 : 1);
        })
        .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[agent-runner] fatal error: ${msg}`);
            process.exit(1);
        });
}
