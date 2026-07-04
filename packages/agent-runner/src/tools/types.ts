// Tool definition and registry types for the agent-runner subsystem.
// Schemas are JSON Schema-compatible and convertible to Anthropic / OpenAI tool-use format.

export interface SchemaProperty {
    readonly type: "string" | "number" | "boolean" | "array" | "integer";
    readonly description: string;
    readonly items?: { readonly type: string };
    readonly enum?: readonly string[];
    readonly default?: unknown;
}

export interface ToolSchema {
    readonly type: "object";
    readonly properties: Record<string, SchemaProperty>;
    readonly required: readonly string[];
}

export interface ToolPromptContext {
    readonly language?: string;
    readonly buildCommand?: string;
    readonly testCommand?: string;
    readonly lintCommand?: string;
}

export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ToolSchema;
    readonly shouldDefer?: boolean;
    readonly prompt?: (ctx?: ToolPromptContext) => string;
}

export interface ToolResult {
    readonly success: boolean;
    readonly output: string;
    readonly error?: string;
    readonly overflowPath?: string;
}

export interface ToolExecutor {
    execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface RegisteredTool {
    readonly definition: ToolDefinition;
    readonly executor?: ToolExecutor;
    readonly maxResultSizeChars?: number;
}

// --- Provider format converters ---

export interface AnthropicTool {
    readonly name: string;
    readonly description: string;
    readonly input_schema: {
        readonly type: "object";
        readonly properties: Record<string, SchemaProperty>;
        readonly required: readonly string[];
    };
}

export interface OpenAITool {
    readonly type: "function";
    readonly function: {
        readonly name: string;
        readonly description: string;
        readonly parameters: {
            readonly type: "object";
            readonly properties: Record<string, SchemaProperty>;
            readonly required: readonly string[];
        };
    };
}

export function toAnthropicTool(def: ToolDefinition): AnthropicTool {
    return {
        name: def.name,
        description: def.description,
        input_schema: {
            type: def.inputSchema.type,
            properties: def.inputSchema.properties,
            required: def.inputSchema.required,
        },
    };
}

export function toOpenAITool(def: ToolDefinition): OpenAITool {
    return {
        type: "function",
        function: {
            name: def.name,
            description: def.description,
            parameters: {
                type: def.inputSchema.type,
                properties: def.inputSchema.properties,
                required: def.inputSchema.required,
            },
        },
    };
}

export type ToolProvider = "anthropic" | "openai";

export function toProviderTools(defs: readonly ToolDefinition[], provider: ToolProvider): readonly object[] {
    switch (provider) {
        case "anthropic":
            return defs.map(toAnthropicTool);
        case "openai":
            return defs.map(toOpenAITool);
    }
}
