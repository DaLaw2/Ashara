import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tool as aiTool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { RegisteredTool, ToolDefinition, ToolExecutor, ToolPromptContext, ToolResult, ToolSchema } from "./types.js";
import { readFileTool, ReadFileExecutor } from "./read-file.js";
import { writeFileTool, WriteFileExecutor } from "./write-file.js";
import { editFileTool, EditFileExecutor } from "./edit-file.js";
import { runCommandTool, RunCommandExecutor } from "./run-command.js";
import { searchCodebaseTool, SearchCodebaseExecutor } from "./search-codebase.js";
import { listDirectoryTool, ListDirectoryExecutor } from "./list-directory.js";
import { CommandPolicy, defaultCommandPolicyConfig } from "./command-policy.js";
import type { CommandPolicyConfig } from "./command-policy.js";
import { buildSanitizedEnv } from "./sanitized-env.js";

export class ToolRegistry {
    private readonly tools: Map<string, RegisteredTool> = new Map();

    register(tool: RegisteredTool): void {
        this.tools.set(tool.definition.name, tool);
    }

    get(name: string): RegisteredTool | undefined {
        return this.tools.get(name);
    }

    getDefinition(name: string): ToolDefinition | undefined {
        return this.tools.get(name)?.definition;
    }

    getAllDefinitions(): ToolDefinition[] {
        return [...this.tools.values()].map((t) => t.definition);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    names(): string[] {
        return [...this.tools.keys()];
    }

    getCoreDefinitions(): ToolDefinition[] {
        return [...this.tools.values()].filter((t) => !t.definition.shouldDefer).map((t) => t.definition);
    }

    getDeferredNames(): string[] {
        return [...this.tools.values()].filter((t) => t.definition.shouldDefer).map((t) => t.definition.name);
    }

    collectPrompts(ctx?: ToolPromptContext): string[] {
        const prompts: string[] = [];
        for (const tool of this.tools.values()) {
            if (tool.definition.prompt) {
                prompts.push(tool.definition.prompt(ctx));
            }
        }
        return prompts.sort();
    }

    asAiSdkTools(config?: AiSdkToolsConfig): ToolSet {
        const maxChars = config?.maxResultSizeChars ?? 50_000;
        const overflowDir = config?.overflowDir;
        const result: ToolSet = {};

        for (const registered of this.tools.values()) {
            if (!registered.executor) continue;
            if (config?.allowedTools && !config.allowedTools.has(registered.definition.name)) continue;

            const { definition, executor } = registered;
            const perToolMax = registered.maxResultSizeChars ?? maxChars;

            result[definition.name] = aiTool({
                description: definition.description,
                inputSchema: jsonSchema(toMutableJsonSchema(definition.inputSchema)),
                execute: buildExecuteFn(executor, perToolMax, overflowDir, definition.name),
            });
        }

        return result;
    }
}

function toMutableJsonSchema(schema: ToolSchema): Record<string, unknown> {
    const properties: Record<string, Record<string, unknown>> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
        const mutable: Record<string, unknown> = {
            type: prop.type,
            description: prop.description,
        };
        if (prop.items) mutable.items = { type: prop.items.type };
        if (prop.enum) mutable.enum = [...prop.enum];
        properties[key] = mutable;
    }
    return {
        type: "object",
        properties,
        required: [...schema.required],
    };
}

export interface AiSdkToolsConfig {
    readonly maxResultSizeChars?: number;
    readonly overflowDir?: string;
    readonly allowedTools?: ReadonlySet<string>;
}

let overflowCounter = 0;

function buildExecuteFn(
    executor: ToolExecutor,
    maxChars: number,
    overflowDir: string | undefined,
    toolName: string,
): (input: Record<string, unknown>) => Promise<string> {
    return async (input: Record<string, unknown>): Promise<string> => {
        let result: ToolResult;
        try {
            result = await executor.execute(input);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return JSON.stringify({ type: "error", message });
        }

        if (!result.success) {
            return JSON.stringify({
                type: "error",
                message: result.error ?? "Tool execution failed",
            });
        }

        let output = result.output;
        if (output.length > maxChars) {
            if (overflowDir) {
                overflowCounter += 1;
                const overflowPath = join(overflowDir, `overflow-${toolName}-${overflowCounter}.txt`);
                await writeFile(overflowPath, output, "utf-8");
                output =
                    output.slice(0, maxChars) +
                    `\n\n[truncated — full output written to ${overflowPath}]`;
            } else {
                output =
                    output.slice(0, maxChars) +
                    `\n\n[truncated — ${output.length - maxChars} characters omitted]`;
            }
        }

        return output;
    };
}

// ---------------------------------------------------------------------------
// tool_search — meta-tool for deferred schema loading
// ---------------------------------------------------------------------------

export const toolSearchTool: ToolDefinition = {
    name: "tool_search",
    description:
        "Load the full schema for deferred tools. " +
        "Call this when you need to use a tool whose schema was not loaded initially. " +
        "Pass the tool name to get its full parameter schema.",
    inputSchema: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "Name of the tool to load the schema for.",
            },
        },
        required: ["name"],
    },
};

export class ToolSearchExecutor implements ToolExecutor {
    constructor(private readonly registry: ToolRegistry) {}

    // open-by-design: implements ToolExecutor — LLM-authored tool arguments
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const name = input["name"];
        if (typeof name !== "string" || name.length === 0) {
            return { success: false, output: "", error: "Missing or invalid 'name' parameter." };
        }
        const def = this.registry.getDefinition(name);
        if (!def) {
            return {
                success: false,
                output: "",
                error: `Tool '${name}' not found. Available tools: ${this.registry.names().join(", ")}`,
            };
        }
        return {
            success: true,
            output: JSON.stringify(
                {
                    name: def.name,
                    description: def.description,
                    parameters: def.inputSchema,
                },
                null,
                2,
            ),
        };
    }
}

const ALL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
    readFileTool,
    writeFileTool,
    editFileTool,
    runCommandTool,
    searchCodebaseTool,
    listDirectoryTool,
];

const TOOL_RESULT_BUDGETS: Record<string, number> = {
    read_file: 20_000,
    search_codebase: 10_000,
    run_command: 15_000,
    list_directory: 10_000,
};

export interface RegistryConfig {
    readonly commandPolicy?: CommandPolicyConfig;
    readonly extraEnvAllowed?: string[];
}

export function createDefaultRegistry(workingDir?: string, config?: RegistryConfig): ToolRegistry {
    const registry = new ToolRegistry();

    if (workingDir === undefined) {
        for (const def of ALL_TOOL_DEFINITIONS) {
            registry.register({ definition: def });
        }
        registry.register({ definition: toolSearchTool });
        return registry;
    }

    const policyConfig = config?.commandPolicy ?? defaultCommandPolicyConfig();
    const policy = new CommandPolicy(policyConfig, workingDir);
    const env = buildSanitizedEnv(config?.extraEnvAllowed);

    registry.register({
        definition: readFileTool,
        executor: new ReadFileExecutor(workingDir),
        maxResultSizeChars: TOOL_RESULT_BUDGETS.read_file,
    });
    registry.register({ definition: writeFileTool, executor: new WriteFileExecutor(workingDir) });
    registry.register({ definition: editFileTool, executor: new EditFileExecutor(workingDir) });
    registry.register({
        definition: runCommandTool,
        executor: new RunCommandExecutor(workingDir, undefined, policy, env),
        maxResultSizeChars: TOOL_RESULT_BUDGETS.run_command,
    });
    registry.register({
        definition: searchCodebaseTool,
        executor: new SearchCodebaseExecutor(workingDir),
        maxResultSizeChars: TOOL_RESULT_BUDGETS.search_codebase,
    });
    registry.register({
        definition: listDirectoryTool,
        executor: new ListDirectoryExecutor(workingDir),
        maxResultSizeChars: TOOL_RESULT_BUDGETS.list_directory,
    });

    const toolSearchExec = new ToolSearchExecutor(registry);
    registry.register({ definition: toolSearchTool, executor: toolSearchExec });

    return registry;
}

export { buildSanitizedEnv } from "./sanitized-env.js";
export type { CommandPolicyConfig } from "./command-policy.js";
export type { RegisteredTool, ToolDefinition, ToolPromptContext, ToolResult } from "./types.js";
