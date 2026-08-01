import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadSkipDirs } from "@ashara/shared";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.js";
import { validatePath } from "./path-validation.js";

const DEFAULT_MAX_DEPTH = 3;

export const listDirectoryTool: ToolDefinition = {
    name: "list_directory",
    shouldDefer: true,
    description:
        "List files and directories at the given path. " +
        "Use this to explore project structure before making changes — know what exists first. " +
        "Returns entries with type indicators (file/directory). " +
        "Set recursive=true to see nested contents (max_depth defaults to 3).",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative path to the directory to list (within the working directory).",
            },
            recursive: {
                type: "boolean",
                description: "Whether to list contents recursively. Defaults to false.",
                default: false,
            },
            max_depth: {
                type: "integer",
                description: "Maximum directory depth when recursive is true. Defaults to 3.",
                default: 3,
            },
        },
        required: ["path"],
    },
    prompt: () => "Use list_directory to explore structure (not run_command with ls).",
} as const;

export class ListDirectoryExecutor implements ToolExecutor {
    constructor(private readonly workingDir: string) {}

    // open-by-design: implements ToolExecutor — LLM-authored tool arguments
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const rawPath = input["path"];
        if (typeof rawPath !== "string") {
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

        const recursive = input["recursive"] === true;
        const maxDepth = typeof input["max_depth"] === "number" ? input["max_depth"] : DEFAULT_MAX_DEPTH;

        try {
            const skip = await loadSkipDirs(resolved);
            const entries: string[] = [];
            await this.walk(resolved, resolved, recursive, maxDepth, 0, entries, skip);
            if (entries.length === 0) {
                return { success: true, output: "(empty directory)" };
            }
            return { success: true, output: entries.join("\n") };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: "", error: `Failed to list directory: ${msg}` };
        }
    }

    private async walk(
        baseDir: string,
        currentDir: string,
        recursive: boolean,
        maxDepth: number,
        currentDepth: number,
        results: string[],
        skip: ReadonlySet<string>,
    ): Promise<void> {
        const items = await readdir(currentDir);
        items.sort();

        for (const item of items) {
            if (skip.has(item)) continue;

            const fullPath = join(currentDir, item);
            const itemStat = await stat(fullPath);
            const rel = relative(baseDir, fullPath);

            if (itemStat.isDirectory()) {
                results.push(rel + "/");
                if (recursive && currentDepth < maxDepth) {
                    await this.walk(baseDir, fullPath, recursive, maxDepth, currentDepth + 1, results, skip);
                }
            } else {
                results.push(rel);
            }
        }
    }
}
