import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.js";
import { validatePath } from "./path-validation.js";
import { DiagnosticChecker } from "../diagnostics.js";

export const writeFileTool: ToolDefinition = {
    name: "write_file",
    description:
        "Create a new file or completely overwrite an existing file with the provided content. " +
        "Use this tool when you need to create a new file from scratch. " +
        "For modifying existing files, prefer edit_file instead. " +
        "Parent directories are created automatically. " +
        "You MUST provide the complete file content — partial content will corrupt the file.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative path to the file to write (within the working directory).",
            },
            content: {
                type: "string",
                description: "The content to write to the file.",
            },
        },
        required: ["path", "content"],
    },
    prompt: () => "Use write_file to create new files.",
} as const;

export class WriteFileExecutor implements ToolExecutor {
    constructor(private readonly workingDir: string) {}

    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const rawPath = input["path"];
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            return { success: false, output: "", error: "Missing or invalid 'path' parameter." };
        }

        const content = input["content"];
        if (typeof content !== "string") {
            return { success: false, output: "", error: "Missing or invalid 'content' parameter." };
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
            await mkdir(dirname(resolved), { recursive: true });
            await writeFile(resolved, content, "utf-8");
            const bytes = Buffer.byteLength(content, "utf-8");
            let output = `Wrote ${bytes} bytes to ${rawPath}`;

            const checker = new DiagnosticChecker(this.workingDir);
            const diagnostics = await checker.check(rawPath);
            if (diagnostics?.hasErrors) {
                output += `\n\n<diagnostics>\n${diagnostics.diagnostics}\n</diagnostics>`;
            }

            return { success: true, output };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: "", error: `Failed to write file: ${msg}` };
        }
    }
}
