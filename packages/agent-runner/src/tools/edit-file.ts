import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.js";
import { validatePath } from "./path-validation.js";
import { DiagnosticChecker } from "../diagnostics.js";

export const editFileTool: ToolDefinition = {
    name: "edit_file",
    description:
        "Make a targeted edit to an existing file by replacing a specific text span. " +
        "You MUST read the file first with read_file — you need the exact current text. " +
        "Provide enough surrounding context in old_text to uniquely match one location in the file. " +
        "Use this instead of write_file when changing part of an existing file.",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative path to the file to edit (within the working directory).",
            },
            old_text: {
                type: "string",
                description: "The exact text to find and replace.",
            },
            new_text: {
                type: "string",
                description: "The replacement text.",
            },
        },
        required: ["path", "old_text", "new_text"],
    },
    prompt: () => "Use edit_file to modify existing files (not write_file for small changes).",
} as const;

export class EditFileExecutor implements ToolExecutor {
    constructor(private readonly workingDir: string) {}

    // open-by-design: implements ToolExecutor — LLM-authored tool arguments
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const rawPath = input["path"];
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            return { success: false, output: "", error: "Missing or invalid 'path' parameter." };
        }

        const oldText = input["old_text"];
        if (typeof oldText !== "string") {
            return { success: false, output: "", error: "Missing or invalid 'old_text' parameter." };
        }

        const newText = input["new_text"];
        if (typeof newText !== "string") {
            return { success: false, output: "", error: "Missing or invalid 'new_text' parameter." };
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

            // Count occurrences
            let count = 0;
            let searchFrom = 0;
            while (true) {
                const idx = content.indexOf(oldText, searchFrom);
                if (idx === -1) break;
                count++;
                searchFrom = idx + oldText.length;
            }

            if (count === 0) {
                return {
                    success: false,
                    output: "",
                    error: `old_text not found in ${rawPath}. Use read_file to see the current file contents and copy the exact text.`,
                };
            }

            if (count > 1) {
                return {
                    success: false,
                    output: "",
                    error: `old_text is ambiguous — found ${count} matches in ${rawPath}. Include more surrounding context in old_text to match exactly one location.`,
                };
            }

            const updated = content.replace(oldText, newText);
            await writeFile(resolved, updated, "utf-8");

            const oldLines = oldText.split("\n").length;
            const newLines = newText.split("\n").length;
            let output = `Edited ${rawPath}: replaced ${oldLines} line(s) with ${newLines} line(s).`;

            const checker = new DiagnosticChecker(this.workingDir);
            const diagnostics = await checker.check(rawPath);
            if (diagnostics?.hasErrors) {
                output += `\n\n<diagnostics>\n${diagnostics.diagnostics}\n</diagnostics>`;
            }

            return { success: true, output };
        } catch (err: unknown) {
            // eslint-disable-next-line no-restricted-syntax -- lossy-extraction-ok: migration backlog
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: "", error: `Failed to edit file: ${msg}` };
        }
    }
}
