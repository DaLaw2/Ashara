// Tool definition and registry types for the agent-runner subsystem.
// Schemas are JSON Schema-compatible and convertible to Anthropic / OpenAI tool-use format.

interface SchemaProperty {
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

export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ToolSchema;
    readonly prompt?: () => string;
}

export interface ToolResult {
    readonly success: boolean;
    readonly output: string;
    readonly error?: string;
    readonly overflowPath?: string;
}

export interface ToolExecutor {
    // open-by-design: LLM-authored tool arguments, shape varies per tool's JSON Schema
    execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface RegisteredTool {
    readonly definition: ToolDefinition;
    readonly executor?: ToolExecutor;
    readonly maxResultSizeChars?: number;
}

