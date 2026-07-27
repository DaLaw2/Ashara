import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadDiagnosticsEnabledEnv } from "@ashara/shared";

export interface DiagnosticResult {
    readonly hasErrors: boolean;
    readonly diagnostics: string;
}

const TS_TIMEOUT_MS = 5_000;
const RUST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LINES = 20;

export class DiagnosticChecker {
    constructor(private readonly workingDir: string) {}

    async check(filePath: string): Promise<DiagnosticResult | null> {
        if (!loadDiagnosticsEnabledEnv()) {
            return null;
        }

        const ext = filePath.split(".").pop()?.toLowerCase();

        if (ext === "ts" || ext === "tsx") {
            return this.checkTypeScript(filePath);
        }
        if (ext === "rs") {
            return this.checkRust();
        }
        return null;
    }

    private async checkTypeScript(filePath: string): Promise<DiagnosticResult | null> {
        const tsconfigPath = await this.findAncestorFile("tsconfig.json", filePath);
        if (tsconfigPath === null) {
            return null;
        }

        const projectDir = dirname(tsconfigPath);
        const output = await this.runCommand("bunx", ["tsc", "--noEmit", "-p", tsconfigPath], projectDir, TS_TIMEOUT_MS);
        if (output === null) {
            return null;
        }

        const resolvedFile = resolve(this.workingDir, filePath);
        const lines = output.split("\n").filter((line) => {
            return line.includes(resolvedFile) || line.includes(filePath);
        });

        const errorLines = lines.filter((line) => /\berror\b\s*TS\d+/i.test(line));

        if (errorLines.length === 0) {
            return { hasErrors: false, diagnostics: "" };
        }

        return {
            hasErrors: true,
            diagnostics: errorLines.slice(0, MAX_ERROR_LINES).join("\n"),
        };
    }

    private async checkRust(): Promise<DiagnosticResult | null> {
        const cargoTomlPath = await this.findAncestorFile("Cargo.toml", ".");
        if (cargoTomlPath === null) {
            return null;
        }

        const projectDir = dirname(cargoTomlPath);
        const output = await this.runCommand("cargo", ["check", "--message-format=short"], projectDir, RUST_TIMEOUT_MS);
        if (output === null) {
            return null;
        }

        const lines = output.split("\n");
        const errorLines = lines.filter((line) => /\berror/i.test(line));

        if (errorLines.length === 0) {
            return { hasErrors: false, diagnostics: "" };
        }

        return {
            hasErrors: true,
            diagnostics: errorLines.slice(0, MAX_ERROR_LINES).join("\n"),
        };
    }

    private async findAncestorFile(filename: string, fromPath: string): Promise<string | null> {
        let dir = resolve(this.workingDir, fromPath);

        const stat = await access(dir).then(
            () => true,
            () => false,
        );
        if (stat) {
            try {
                const { statSync } = await import("node:fs");
                if (!statSync(dir).isDirectory()) {
                    dir = dirname(dir);
                }
            } catch {
                dir = dirname(dir);
            }
        } else {
            dir = dirname(dir);
        }

        const root = resolve("/");
        while (dir !== root) {
            const candidate = resolve(dir, filename);
            const exists = await access(candidate).then(
                () => true,
                () => false,
            );
            if (exists) {
                return candidate;
            }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    private runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
        return new Promise((res) => {
            let output = "";
            let killed = false;

            const child = spawn(cmd, args, {
                cwd,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
            });

            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString("utf-8");
            });

            child.stderr.on("data", (chunk: Buffer) => {
                output += chunk.toString("utf-8");
            });

            const timer = setTimeout(() => {
                killed = true;
                child.kill("SIGKILL");
            }, timeoutMs);

            child.on("error", () => {
                clearTimeout(timer);
                res(null);
            });

            child.on("close", () => {
                clearTimeout(timer);
                if (killed) {
                    res(null);
                    return;
                }
                res(output);
            });
        });
    }
}
