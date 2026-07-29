import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ToolDefinition, ToolExecutor, ToolResult } from "./types.js";
import { validatePath } from "./path-validation.js";
import type { CommandPolicy } from "./command-policy.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB

export const runCommandTool: ToolDefinition = {
    name: "run_command",
    description:
        "Execute a shell command and return its stdout/stderr. " +
        "Use this for build, test, lint, install, and other shell operations only. " +
        "Do NOT use this for reading files (use read_file), searching code (use search_codebase), " +
        "or listing directories (use list_directory). Commands time out after 60 seconds by default.",
    inputSchema: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The shell command to execute.",
            },
            timeout_ms: {
                type: "integer",
                description: "Optional timeout in milliseconds. Defaults to 60000 (60 seconds).",
                default: 60000,
            },
            working_dir: {
                type: "string",
                description: "Working directory for the command. Defaults to the project root.",
            },
        },
        required: ["command"],
    },
    prompt: (ctx) => {
        const lines = ["Use run_command for build, test, lint, and other shell operations."];
        if (ctx?.buildCommand) lines.push(`Build: ${ctx.buildCommand}`);
        if (ctx?.testCommand) lines.push(`Test: ${ctx.testCommand}`);
        if (ctx?.lintCommand) lines.push(`Lint: ${ctx.lintCommand}`);
        return lines.join("\n");
    },
} as const;

export class RunCommandExecutor implements ToolExecutor {
    constructor(
        private readonly workingDir: string,
        private readonly maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
        private readonly policy?: CommandPolicy,
        private readonly env?: Record<string, string>,
    ) {}

    // open-by-design: implements ToolExecutor — LLM-authored tool arguments
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
        const command = input["command"];
        if (typeof command !== "string" || command.length === 0) {
            return { success: false, output: "", error: "Missing or invalid 'command' parameter." };
        }

        if (this.policy) {
            const validation = this.policy.validate(command);
            if (!validation.allowed) {
                return {
                    success: false,
                    output: "",
                    error: `Command blocked by policy: ${validation.reason} [rule: ${validation.rule}]`,
                };
            }
        }

        const rawTimeout = typeof input["timeout_ms"] === "number" ? input["timeout_ms"] : DEFAULT_TIMEOUT_MS;
        const timeoutMs = Math.min(Math.max(rawTimeout, 1_000), MAX_TIMEOUT_MS);

        let cwd = this.workingDir;
        if (typeof input["working_dir"] === "string" && input["working_dir"].length > 0) {
            const validated = validatePath(input["working_dir"], this.workingDir);
            if (validated === null) {
                return {
                    success: false,
                    output: "",
                    error: `Path validation failed: '${input["working_dir"]}' is outside the working directory.`,
                };
            }
            cwd = validated;
        }

        return new Promise<ToolResult>((res) => {
            let stdoutBuf = "";
            let stderrBuf = "";
            let killed = false;
            let killTimer: ReturnType<typeof setTimeout> | undefined;

            const child = spawn("sh", ["-c", command], {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                env: this.env ?? { ...process.env },
                detached: true,
            });

            child.stdout.on("data", (chunk: Buffer) => {
                if (stdoutBuf.length < this.maxOutputBytes) {
                    stdoutBuf += chunk.toString("utf-8");
                }
            });

            child.stderr.on("data", (chunk: Buffer) => {
                if (stderrBuf.length < this.maxOutputBytes) {
                    stderrBuf += chunk.toString("utf-8");
                }
            });

            const killGroup = (signal: NodeJS.Signals): void => {
                const pid = child.pid;
                if (pid !== undefined) {
                    try {
                        process.kill(-pid, signal);
                    } catch (e: unknown) {
                        if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) {
                            console.warn(`[runCommand] Failed to signal process group ${pid}: ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                }
            };

            const timer = setTimeout(() => {
                killed = true;
                killGroup("SIGTERM");
                killTimer = setTimeout(() => {
                    killGroup("SIGKILL");
                }, KILL_GRACE_MS);
            }, timeoutMs);

            child.on("error", (err) => {
                clearTimeout(timer);
                if (killTimer !== undefined) clearTimeout(killTimer);
                res({
                    success: false,
                    output: "",
                    error: `Failed to spawn command: ${err.message}`,
                });
            });

            child.on("close", (code) => {
                clearTimeout(timer);
                if (killTimer !== undefined) clearTimeout(killTimer);

                if (killed) {
                    res({
                        success: false,
                        output: truncate(stdoutBuf, this.maxOutputBytes),
                        error: `Command timed out after ${timeoutMs}ms.`,
                    });
                    return;
                }

                const exitCode = code ?? 1;
                const outputParts: string[] = [`Exit code: ${exitCode}`];
                if (stdoutBuf.length > 0) {
                    outputParts.push(`\nSTDOUT:\n${truncate(stdoutBuf, this.maxOutputBytes)}`);
                }
                if (stderrBuf.length > 0) {
                    outputParts.push(`\nSTDERR:\n${truncate(stderrBuf, this.maxOutputBytes)}`);
                }

                res({
                    success: exitCode === 0,
                    output: outputParts.join(""),
                    error: exitCode !== 0 ? `Command exited with code ${exitCode}.` : undefined,
                });
            });
        });
    }
}

function truncate(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
        return text;
    }
    // Truncate by slicing bytes, not characters, to respect the limit
    const buf = Buffer.from(text, "utf-8").subarray(0, maxBytes);
    return buf.toString("utf-8") + "\n... [output truncated]";
}
