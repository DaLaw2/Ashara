import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CapabilityLevel, AgentRunnerEnv, AgentBrief } from "@ashara/shared";
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
import type { ToolPromptContext } from "./tools/types.js";
import { OutputCollector } from "./output.js";
import type { AgentOutput } from "./output.js";
import type { FormatAdapter } from "./format-adapter.js";
import { NativeFCAdapter, CodeFenceAdapter } from "./format-adapter.js";
import { createProfileAdapter } from "./acl/development-acl.js";
import type { ProjectProfilePort } from "./acl/development-acl.js";
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

export interface RunnerGateway {
    resolveModel(capability: CapabilityLevel, site: string): ResolvedModel;
    resolveEffectiveCapability?(capability: CapabilityLevel): CapabilityLevel;
    resolveFormatGroup?(capability: CapabilityLevel): string | undefined;
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
        private readonly profiles: ProjectProfilePort = createProfileAdapter(),
    ) {}

    async run(): Promise<AgentOutput> {
        // 1. Read and validate brief
        const briefRaw = await readFile(this.config.briefPath, "utf-8");
        const baseBrief = validateBrief(JSON.parse(briefRaw));

        // 2. Enrich brief with project context
        let brief: AgentBrief;
        try {
            brief = await enrichBrief(baseBrief, this.config.workingDir, this.profiles);
            console.log(`[agent-runner] brief enriched with project context from ${this.config.workingDir}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[agent-runner] brief enrichment failed, using base brief: ${msg}`);
            brief = baseBrief;
        }

        // 3. Build project profile for tool prompt context. The LANGUAGE comes from
        // the brief's frame, never from detection: detection yields marker FILENAMES,
        // so a Rust project used to be told its language was "Cargo.toml" (ADR-046).
        // Detection still supplies the commands, which are observed facts about the
        // tree rather than claims about what the project is.
        const frameStack: string[] = [...brief.projectFrame.stack];
        let toolPromptCtx: ToolPromptContext | undefined;
        try {
            const profile = await this.profiles.buildAutoProfile(this.config.workingDir);
            toolPromptCtx = {
                language: frameStack[0],
                buildCommand: profile.buildCommand,
                testCommand: profile.testCommand,
                lintCommand: profile.lintCommand,
            };
        } catch {
            toolPromptCtx = undefined;
        }

        // 4. Create tool registry with working directory, threading per-task
        // binary overrides from the brief (e.g. allowedBinaries: ["docker"])
        const registry = createDefaultRegistry(this.config.workingDir, {
            allowedBinaries: brief.allowedBinaries,
        });

        // 5. Resolve model and format group, build system prompt
        const resolvedCapability = resolveEffectiveCapability(this.gateway, this.config.capability);
        const resolved = this.gateway.resolveModel(resolvedCapability, "agent-runner");
        const formatGroup = resolveFormatGroup(this.gateway, this.config.capability);
        const toolPrompts = registry.collectPrompts(toolPromptCtx);
        const staticSystemPrompt = buildStaticSystemPrompt(formatGroup, toolPrompts);
        const dynamicSystemPrompt = buildDynamicSystemPrompt(brief);

        const allowed = capabilityToolSet(resolvedCapability);

        console.log(
            `[agent-runner] resolved model: ${resolved.modelId} (${resolved.provider}), ` +
            `capability=${resolvedCapability}, tools=${[...allowed].join(", ")}`,
        );

        // 6. Create and run conversation — goal is the task instruction (always non-empty)
        const isWeakModel =
            resolvedCapability === "Light" || resolvedCapability === "Medium";

        const adapter = selectAdapter(formatGroup, resolvedCapability);

        const conversationLogPath = join(this.config.workingDir, ASHARA_CONTROL_DIR, "conversation.jsonl");

        const conversation = new AgentConversation(resolved.model, registry, {
            staticSystemPrompt: isWeakModel ? buildWeakModelSystemPrompt(brief) : staticSystemPrompt,
            dynamicSystemPrompt: isWeakModel ? "" : dynamicSystemPrompt,
            capability: this.config.capability,
            adapter,
            maxTurns: this.config.maxTurns,
            workingDir: this.config.workingDir,
            conversationLogPath,
            allowedTools: allowed,
        }, resolved.modelConfig);

        const result = await conversation.run(brief.goal);

        // 6. Collect output
        const collector = new OutputCollector(this.config.workingDir);
        const output = await collector.collect(result);

        // 7. Run inline verification — task_spec absence is a named case, not
        // a silent [] (Discipline A: the identity element must be unavailable).
        let verifyResult: InlineVerifyResult | null = null;
        if (brief.task_spec) {
            try {
                verifyResult = await runInlineVerify(
                    this.config.workingDir,
                    brief.task_spec.checks,
                    [], // agent-runner has no contract context; contracts live on the host side
                );
                console.log(`[agent-runner] inline verify: verdict=${verifyResult.verdict}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[agent-runner] inline verify failed: ${msg}`);
            }
        } else {
            console.log(`[agent-runner] inline verify skipped: no task_spec in brief`);
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

function resolveEffectiveCapability(gateway: RunnerGateway, requested: CapabilityLevel): CapabilityLevel {
    if (gateway.resolveEffectiveCapability) {
        const actual = gateway.resolveEffectiveCapability(requested);
        if (actual !== requested) {
            console.log(`[agent-runner] capability downgraded: ${requested} → ${actual}`);
        }
        return actual;
    }
    return requested;
}

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
// Adapter selection
// ---------------------------------------------------------------------------

function resolveFormatGroup(gateway: RunnerGateway, capability: CapabilityLevel): string | undefined {
    if (gateway.resolveFormatGroup) {
        return gateway.resolveFormatGroup(capability);
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

export function buildWeakModelSystemPrompt(brief: AgentBrief): string {
    const lines = [
        `You are a coding agent. Use write_file to create files. Use read_file to read files.`,
        `Do not explain. Do not describe. Just call tools.`,
        ``,
        formatProjectFrame(brief),
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

    if (brief.artifactContext) {
        lines.push(``, `# Current Project State`, brief.artifactContext);
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

    // Fail-closed: the catalog file is the sole source for the agent's model
    // config. Its absence or malformedness is a typed error (InvalidGatewayCatalog),
    // never a silent fallback to an empty config. The server writes this file at
    // spawn time; the old HTTP path (ASHARA_SERVER_URL) is gone.
    const gatewayConfig = await loadGatewayCatalogFromFile(env.catalogPath);
    const checkedSources = [`catalog file ${env.catalogPath}`];
    console.log(`[agent-runner] config loaded from catalog file (${env.catalogPath})`);

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
