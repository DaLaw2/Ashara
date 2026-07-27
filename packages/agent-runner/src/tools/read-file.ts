import { readFile } from "node:fs/promises";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.js";
import { validatePath } from "./path-validation.js";

export const readFileTool: ToolDefinition = {
    name: "read_file",
    description:
        "Read the contents of a file at the given path. " +
        "You MUST use this BEFORE editing any file — you need to see current content before making changes. " +
        "Also use this to understand existing code before writing new files that depend on it. " +
        "Use offset and limit for large files to read specific sections.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative path to the file to read (within the working directory).",
            },
            offset: {
                type: "integer",
                description: "Line number to start reading from (0-based).",
            },
            limit: {
                type: "integer",
                description: "Maximum number of lines to read.",
            },
        },
        required: ["path"],
    },
    prompt: () =>
        "Use read_file to read files (not run_command with cat). " +
        "You MUST read a file before editing it. Always.",
} as const;

export class ReadFileExecutor implements ToolExecutor {
    constructor(private readonly workingDir: string) {}

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const rawPath = input["path"];
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            return { success: false, output: "", error: "Missing or invalid 'path' parameter." };
        }

        const resolved = validatePath(rawPath, this.workingDir);
        if (resolved === null) {
            return {
                success: false,
                output: "",
                error: `Path validation failed: '${rawPath}' is outside the working directory.`,
            };
        }

        try {
            const content = await readFile(resolved, "utf-8");
            const offset = typeof input["offset"] === "number" ? input["offset"] : 0;
            const limit = typeof input["limit"] === "number" ? input["limit"] : undefined;

            if (offset > 0 || limit !== undefined) {
                const lines = content.split("\n");
                const sliced = limit !== undefined ? lines.slice(offset, offset + limit) : lines.slice(offset);
                return { success: true, output: sliced.join("\n") };
            }

            return { success: true, output: content };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                output: "",
                error: `Failed to read '${rawPath}': ${msg}`,
            };
        }
    }
}
