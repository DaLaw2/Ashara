import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CapabilityLevel, AgentBrief } from "@ashara/shared";
import { ASHARA_CONTROL_DIR, loadAgentRunnerEnv, parseAgentBrief } from "@ashara/shared";
import {
    LLMGateway,
    loadGatewayCatalogFromFile,
    buildGateway,
    NoLLMProvidersConfigured,
    InvalidGatewayCatalog,
} from "@ashara/llm-gateway";
import type { ResolvedModel } from "@ashara/llm-gateway";
import { AgentConversation } from "./conversation.js";
import { createDefaultRegistry } from "./tools/index.js";
import { OutputCollector } from "./output.js";
import type { AgentOutput } from "./output.js";

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

export interface RunnerGateway {
    resolveModel(capability: CapabilityLevel, site: string): ResolvedModel;
}

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
        private readonly gateway: RunnerGateway,
        private readonly config: RunnerConfig,
    ) {}

    async run(): Promise<AgentOutput> {
        // 1. Read and validate brief
        const briefRaw = await readFile(this.config.briefPath, "utf-8");
        const brief = validateBrief(JSON.parse(briefRaw));

        // 2. Create tool registry with working directory, threading per-task
        // binary overrides from the brief (e.g. allowedBinaries: ["docker"])
        const registry = createDefaultRegistry(this.config.workingDir, {
            allowedBinaries: brief.allowedBinaries,
        });

        // 3. Resolve model, build system prompt
        const capability = this.config.capability;
        const resolved = this.gateway.resolveModel(capability, "agent-runner");
        const toolPrompts = registry.collectPrompts();
        const staticSystemPrompt = buildStaticSystemPrompt(toolPrompts);
        const dynamicSystemPrompt = buildDynamicSystemPrompt(brief);

        const allowed = capabilityToolSet(capability);

        console.log(
            `[agent-runner] resolved model: ${resolved.modelId} (${resolved.provider}), ` +
            `capability=${capability}, tools=${[...allowed].join(", ")}`,
        );

        // 4. Create and run conversation — goal is the task instruction (always non-empty)
        const conversationLogPath = join(this.config.workingDir, ASHARA_CONTROL_DIR, "conversation.jsonl");

        const conversation = new AgentConversation(resolved.model, registry, {
            staticSystemPrompt,
            dynamicSystemPrompt,
            maxTurns: this.config.maxTurns,
            workingDir: this.config.workingDir,
            conversationLogPath,
            allowedTools: allowed,
        }, resolved.modelConfig);

        const result = await conversation.run(brief.goal);

        // 5. Collect and write output
        const collector = new OutputCollector(this.config.workingDir);
        const output = await collector.collect(result);
        await collector.writeOutput(output, resolve(this.config.outputPath));

        return output;
    }
}

// ---------------------------------------------------------------------------
// Tool filtering by capability
// ---------------------------------------------------------------------------

const CORE_TOOLS = ["write_file", "read_file", "list_directory"];
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

/**
 * Renders the ProjectFrame (ADR-046) — the owner's stated target, ahead of the
 * task, because everything else is conditioned on it. The provenance line is
 * included deliberately: an `observed-manifest` source is ground truth about the
 * tree, while a `vision-derivation` source is an inference the agent MAY revise
 * once real files exist. Stack entries are labels, never commands — which command
 * to run is the agent's call, declared in verify.toml.
 */
function formatProjectFrame(brief: AgentBrief): string {
    const { intent, stack, source } = brief.projectFrame;
    const provenance =
        source === "observed-manifest"
            ? "observed in the project tree (ground truth — trust it over any assumption)"
            : source === "contract-knowledge"
              ? "declared in the project contract (the plan of record for this project)"
              : "derived from the vision text (an inference — revise it only against files you actually observe)";
    return [
        `# Project Frame`,
        `This is what the project IS. It is the owner's decision, not a suggestion, and it`,
        `overrides any default you would otherwise assume about language, runtime or layout.`,
        ``,
        `## Owner's intent (verbatim)`,
        intent,
        ``,
        `## Target stack`,
        ...stack.map((label) => `- ${label}`),
        ``,
        `Source: ${provenance}.`,
    ].join("\n");
}

export function buildStaticSystemPrompt(toolPrompts?: string[]): string {
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

    // FIRST, ahead of the task: every instruction below is conditioned on what the
    // project is, and an agent that reads the task first has already committed to a
    // stack by the time it gets here (ADR-046).
    sections.push(formatProjectFrame(brief));

    sections.push(`# Task\n## Goal\n${brief.goal}`);

    if (brief.priorAttemptFailure) {
        sections.push(`## Prior Attempt Failure\n${brief.priorAttemptFailure}`);
    }

    if (brief.knowledgeContext && brief.knowledgeContext.trim().length > 0) {
        sections.push(`## Prior Knowledge & Lessons\n${brief.knowledgeContext}`);
    }

    if (brief.artifactContext) {
        sections.push(`## Current Project State\n${brief.artifactContext}`);
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
 * Supplementary prompt section (ADR-033 §5): the project context map. It is
 * reference, not a directive, so it renders after the binding sections, and
 * only when present and non-empty.
 */
function formatSupplementarySections(brief: AgentBrief): string[] {
    const sections: string[] = [];

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

    // Fail-closed: the catalog file is the sole source for the agent's model
    // config. Its absence or malformedness is a typed error (InvalidGatewayCatalog),
    // never a silent fallback to an empty config. The server writes this file at
    // spawn time; the old HTTP path (ASHARA_SERVER_URL) is gone.
    const gatewayConfig = await loadGatewayCatalogFromFile(env.catalogPath);
    const checkedSources = [`catalog file ${env.catalogPath}`];
    console.log(`[agent-runner] config loaded from catalog file (${env.catalogPath})`);

    // Single composition-root factory for the gateway (ADR-030) -- no inline
    // refuse-to-start guard duplicated here.
    let gateway: LLMGateway;
    try {
        gateway = buildGateway({ config: gatewayConfig, checkedSources });
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
