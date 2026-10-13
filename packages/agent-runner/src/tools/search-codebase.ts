import { spawn } from "node:child_process";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.js";

const DEFAULT_MAX_RESULTS = 50;

export const searchCodebaseTool: ToolDefinition = {
    name: "search_codebase",
    description:
        "Search for text patterns across project files using regex. " +
        "Use this to find files, function definitions, imports, references, or any text pattern. " +
        "Returns matching lines with file paths and line numbers so you know where to look. " +
        "Use file_glob (e.g. '*.ts') to narrow the search scope.",
    inputSchema: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "The search pattern (regex supported).",
            },
            file_glob: {
                type: "string",
                description: "Optional glob to restrict which files are searched (e.g. '*.ts').",
            },
            max_results: {
                type: "integer",
                description: "Maximum number of matching lines to return. Defaults to 50.",
                default: 50,
            },
        },
        required: ["pattern"],
    },
    prompt: () => "Use search_codebase to find code (not run_command with grep).",
} as const;

export class SearchCodebaseExecutor implements ToolExecutor {
    constructor(private readonly workingDir: string) {}

    // open-by-design: implements ToolExecutor — LLM-authored tool arguments
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const pattern = input["pattern"];
        if (typeof pattern !== "string" || pattern.length === 0) {
            return { success: false, output: "", error: "Missing or invalid 'pattern' parameter." };
        }

        const maxResults = typeof input["max_results"] === "number" ? input["max_results"] : DEFAULT_MAX_RESULTS;
        const fileGlob = typeof input["file_glob"] === "string" ? input["file_glob"] : undefined;

        const args = ["-rn"];
        if (fileGlob) {
            args.push(`--include=${fileGlob}`);
        }
        args.push("--", pattern, ".");

        return new Promise<ToolResult>((res) => {
            let output = "";

            const child = spawn("grep", args, {
                cwd: this.workingDir,
                stdio: ["ignore", "pipe", "pipe"],
            });

            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString("utf-8");
            });

            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString("utf-8");
            });

            child.on("error", (err) => {
                res({
                    success: false,
                    output: "",
                    error: `Failed to execute grep: ${err.message}`,
                });
            });

            child.on("close", (code) => {
                // grep returns 1 when no matches found — that is not an error
                if (code === 1 && output.length === 0) {
                    res({ success: true, output: "No matches found." });
                    return;
                }

                if (code !== null && code > 1) {
                    res({
                        success: false,
                        output: "",
                        error: `grep exited with code ${code}: ${stderr}`.trim(),
                    });
                    return;
                }

                // Limit results
                const lines = output.split("\n").filter((l) => l.length > 0);
                const limited = lines.slice(0, maxResults);
                res({
                    success: true,
                    output: limited.join("\n"),
                });
            });
        });
    }
}
