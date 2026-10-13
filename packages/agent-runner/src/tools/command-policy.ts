import { resolve, normalize } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const CommandPolicyConfigSchema = z.object({
    maxCommandLength: z.number().int().positive().default(4096),
    allowedCommands: z.record(z.string(), z.array(z.string())).default({}),
    blockedBinaries: z.array(z.string()).default([]),
    allowPipes: z.boolean().default(true),
    allowCompoundCommands: z.boolean().default(true),
});

export type CommandPolicyConfig = z.infer<typeof CommandPolicyConfigSchema>;

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type CommandValidationResult =
    | { allowed: true }
    | { allowed: false; reason: string; rule: string };

// ---------------------------------------------------------------------------
// Default config factory
// ---------------------------------------------------------------------------

// OPEN domain: which binaries an unattended agent may invoke. Data cannot and
// must not supply membership — this is a trust-boundary decision (Discipline B),
// expanded only by explicit human review. The categories are ecosystem-spanning
// (build tools, VCS, POSIX utilities, test runners), not stack-specific.
const DEFAULT_ALLOWED_COMMANDS: Record<string, readonly string[]> = {
    build: [
        "npm", "npx", "node", "tsx", "cargo", "make", "just", "cmake",
        "go", "python", "python3", "rustc", "bun", "bunx", "pnpm", "yarn",
    ],
    vcs: ["git"],
    utilities: [
        "cat", "head", "tail", "wc", "sort", "grep", "sed", "awk", "find",
        "ls", "echo", "mkdir", "cp", "mv", "touch", "diff", "stat", "file",
        "which", "pwd", "date", "tee", "xargs", "cut", "tr", "uniq",
        "printf", "dirname", "basename", "realpath", "true", "false", "test",
        "env", "sleep", "exit",
    ],
    test: ["jest", "vitest", "pytest", "mocha"],
};

// OPEN domain: binaries an agent must NEVER invoke, regardless of context.
// These are OS-level destructive, network, escalation, or container-escape
// operations. Data cannot supply membership — adding an entry is a security
// decision, not a detection problem (Discipline B: Trust Boundary Enforcement).
const DEFAULT_BLOCKED_BINARIES: readonly string[] = [
    // Process
    "kill", "pkill", "killall", "fuser", "skill",
    // Network
    "curl", "wget", "nc", "ncat", "socat", "ssh", "scp", "sftp", "rsync", "telnet", "ftp",
    // Secrets
    "printenv",
    // Destructive
    "rm", "rmdir", "shred", "dd",
    // System
    "shutdown", "reboot", "mount", "useradd", "passwd", "chown", "chmod", "iptables", "crontab",
    // Escalation
    "sudo", "su", "doas",
    // Container escape
    "docker", "podman", "nsenter", "unshare", "chroot",
];

// OPEN domain: git subcommands safe for an unattended agent. The domain is the
// full git subcommand set; membership is curated because some subcommands
// (filter-branch, gc --aggressive, push --force) can cause irreversible damage.
const SAFE_GIT_SUBCOMMANDS = new Set([
    "status", "diff", "log", "show", "add", "commit", "branch", "checkout",
    "switch", "merge", "rebase", "stash", "tag", "fetch", "pull", "push",
    "reset", "restore", "rev-parse", "describe", "shortlog", "blame",
    "ls-files", "ls-tree", "cat-file", "config", "init", "clone",
    "cherry-pick", "am", "apply", "format-patch", "remote", "worktree",
]);

export function defaultCommandPolicyConfig(): CommandPolicyConfig {
    const allowed: Record<string, string[]> = {};
    for (const [family, cmds] of Object.entries(DEFAULT_ALLOWED_COMMANDS)) {
        allowed[family] = [...cmds];
    }
    return {
        maxCommandLength: 4096,
        allowedCommands: allowed,
        blockedBinaries: [...DEFAULT_BLOCKED_BINARIES],
        allowPipes: true,
        allowCompoundCommands: true,
    };
}

// ---------------------------------------------------------------------------
// Injection pattern detection
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
    { pattern: /`[^`]*`/, rule: "backtick-substitution" },
    { pattern: /\$\(\(/, rule: "arithmetic-expansion" },
    { pattern: /\$\(/, rule: "command-substitution" },
    { pattern: /\$\{[^}]*[!@#%^:=+\-?/]/, rule: "parameter-expansion-operator" },
    { pattern: /\bIFS\s*=/, rule: "ifs-manipulation" },
    { pattern: /<\(/, rule: "process-substitution-in" },
    { pattern: />\(/, rule: "process-substitution-out" },
    { pattern: /\w+\s*\(\)\s*\{/, rule: "function-definition" },
];

const DANGEROUS_BUILTINS = new Set(["eval", "exec", "source", "."]);

// ---------------------------------------------------------------------------
// Server/daemon start pattern detection
// ---------------------------------------------------------------------------

const SERVER_SCRIPT_NAMES: ReadonlySet<string> = new Set([
    "start", "dev", "serve",
]);

const SERVER_FILE_PATTERN = /(?:^|[/\\])(?:server|app|main)\.\w+$/;

const SERVER_NPX_TOOLS: ReadonlySet<string> = new Set([
    "serve", "http-server", "live-server",
]);

// OPEN domain: add entries as new ecosystems are encountered. This is defense-in-depth
// against accidental long-running processes, not an exhaustive gate.
const SERVER_PYTHON_MODULES: ReadonlySet<string> = new Set([
    "flask", "uvicorn", "gunicorn", "http.server",
]);

// ---------------------------------------------------------------------------
// Command parsing helpers
// ---------------------------------------------------------------------------

function extractBinary(token: string): string {
    const trimmed = token.trim();
    if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
        const parts = trimmed.split("/");
        return parts[parts.length - 1];
    }
    if (trimmed.includes("/")) {
        const parts = trimmed.split("/");
        return parts[parts.length - 1];
    }
    return trimmed;
}

function splitOnDelimiter(
    command: string,
    delimiterLength: (ch: string, next: string) => number,
): string[] {
    const parts: string[] = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        const next = command[i + 1] ?? "";

        if (ch === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; current += ch; continue; }
        if (ch === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; current += ch; continue; }
        if (inSingleQuote || inDoubleQuote) { current += ch; continue; }

        const dLen = delimiterLength(ch, next);
        if (dLen > 0) {
            parts.push(current);
            current = "";
            i += dLen - 1;
            continue;
        }
        current += ch;
    }

    if (current.trim().length > 0) parts.push(current);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function splitCompound(command: string): string[] {
    return splitOnDelimiter(command, (ch, next) => {
        if (ch === ";" || ch === "\n") return 1;
        if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) return 2;
        return 0;
    });
}

function splitPipe(command: string): string[] {
    return splitOnDelimiter(command, (ch, next) =>
        ch === "|" && next !== "|" ? 1 : 0,
    );
}

function extractPathArgs(command: string): string[] {
    const tokens = command.split(/\s+/);
    const paths: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith("-")) continue;
        if (t.includes("..")) {
            paths.push(t);
        }
    }
    return paths;
}

// ---------------------------------------------------------------------------
// CommandPolicy
// ---------------------------------------------------------------------------

export class CommandPolicy {
    private readonly config: CommandPolicyConfig;
    private readonly allowedSet: Set<string>;
    private readonly blockedSet: Set<string>;
    private readonly workingDir: string | null;

    constructor(config: CommandPolicyConfig, workingDir?: string) {
        this.config = config;
        this.workingDir = workingDir ?? null;

        this.allowedSet = new Set<string>();
        for (const cmds of Object.values(config.allowedCommands)) {
            for (const cmd of cmds) {
                this.allowedSet.add(cmd);
            }
        }

        this.blockedSet = new Set(config.blockedBinaries);
    }

    validate(rawCommand: string): CommandValidationResult {
        if (rawCommand.length > this.config.maxCommandLength) {
            return {
                allowed: false,
                reason: `Command exceeds max length of ${this.config.maxCommandLength} characters (got ${rawCommand.length})`,
                rule: "max-length",
            };
        }

        const injectionCheck = this.checkInjection(rawCommand);
        if (injectionCheck) return injectionCheck;

        const bgCheck = this.checkBackgrounding(rawCommand);
        if (bgCheck) return bgCheck;

        const subcommands = splitCompound(rawCommand);

        if (subcommands.length > 1 && !this.config.allowCompoundCommands) {
            return {
                allowed: false,
                reason: "Compound commands (&&, ||, ;) are not allowed",
                rule: "compound-disabled",
            };
        }

        for (const sub of subcommands) {
            const pipeSegments = splitPipe(sub);

            if (pipeSegments.length > 1 && !this.config.allowPipes) {
                return {
                    allowed: false,
                    reason: "Pipe commands are not allowed",
                    rule: "pipe-disabled",
                };
            }

            for (const segment of pipeSegments) {
                const result = this.validateSingle(segment);
                if (!result.allowed) return result;
            }
        }

        return { allowed: true };
    }

    private checkBackgrounding(command: string): CommandValidationResult | null {
        let inSingleQuote = false;
        let inDoubleQuote = false;
        for (let i = 0; i < command.length; i++) {
            const ch = command[i];
            if (ch === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue; }
            if (ch === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue; }
            if (inSingleQuote || inDoubleQuote) continue;
            if (ch === "&" && command[i + 1] !== "&") {
                return {
                    allowed: false,
                    reason: "Background execution (&) is not allowed — process would outlive the run",
                    rule: "backgrounding",
                };
            }
        }
        return null;
    }

    private checkInjection(command: string): CommandValidationResult | null {
        for (const { pattern, rule } of INJECTION_PATTERNS) {
            if (pattern.test(command)) {
                return {
                    allowed: false,
                    reason: `Shell injection pattern detected: ${rule}`,
                    rule: `injection:${rule}`,
                };
            }
        }
        return null;
    }

    private validateSingle(command: string): CommandValidationResult {
        const stripped = command.replace(/^\s*(?:env\s+(?:\w+=\S+\s+)*)/, "");
        const tokens = stripped.trim().split(/\s+/);
        if (tokens.length === 0 || tokens[0].length === 0) {
            return { allowed: false, reason: "Empty command", rule: "empty-command" };
        }

        const rawBinary = tokens[0];
        const binary = extractBinary(rawBinary);

        if (DANGEROUS_BUILTINS.has(binary)) {
            return {
                allowed: false,
                reason: `Shell builtin '${binary}' is not allowed`,
                rule: `injection:${binary === "." ? "dot-source" : binary}`,
            };
        }

        if (this.blockedSet.has(binary)) {
            return {
                allowed: false,
                reason: `Binary '${binary}' is blocked`,
                rule: "blocked-binary",
            };
        }

        if (!this.allowedSet.has(binary)) {
            return {
                allowed: false,
                reason: `Unknown command '${binary}' — not in allowlist`,
                rule: "not-in-allowlist",
            };
        }

        if (binary === "git") {
            const gitResult = this.validateGitSubcommand(tokens);
            if (gitResult) return gitResult;
        }

        if (this.workingDir) {
            const pathResult = this.validatePaths(command);
            if (pathResult) return pathResult;
        }

        const serverCheck = this.checkServerStart(binary, tokens);
        if (serverCheck) return serverCheck;

        return { allowed: true };
    }

    private validateGitSubcommand(tokens: string[]): CommandValidationResult | null {
        if (tokens.length < 2) return null;
        const subcommand = tokens[1];
        if (subcommand.startsWith("-")) return null;
        if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
            return {
                allowed: false,
                reason: `Git subcommand '${subcommand}' is not in the safe set`,
                rule: "git-subcommand",
            };
        }
        return null;
    }

    private validatePaths(command: string): CommandValidationResult | null {
        if (!this.workingDir) return null;

        const paths = extractPathArgs(command);
        for (const p of paths) {
            const resolved = resolve(this.workingDir, normalize(p));
            const normalizedBase = resolve(this.workingDir);
            if (!resolved.startsWith(normalizedBase + "/") && resolved !== normalizedBase) {
                return {
                    allowed: false,
                    reason: `Path '${p}' escapes the working directory`,
                    rule: "path-escape",
                };
            }
        }
        return null;
    }

    private denyServerStart(description: string): CommandValidationResult {
        return {
            allowed: false,
            reason: `Long-running process detected: '${description}'. Starting servers or daemons is not allowed — use build/test commands only.`,
            rule: "server-start-pattern",
        };
    }

    private checkServerStart(binary: string, tokens: string[]): CommandValidationResult | null {
        if (binary === "npm" || binary === "yarn" || binary === "pnpm" || binary === "bun") {
            if (tokens.length >= 2 && SERVER_SCRIPT_NAMES.has(tokens[1])) {
                return this.denyServerStart(`${binary} ${tokens[1]}`);
            }
            if (tokens.length >= 3 && tokens[1] === "run" && SERVER_SCRIPT_NAMES.has(tokens[2])) {
                return this.denyServerStart(`${binary} run ${tokens[2]}`);
            }
        }

        if (binary === "node" || binary === "tsx" || binary === "bun") {
            if (tokens.includes("-e") || tokens.includes("--eval") || tokens.includes("-p") || tokens.includes("--print")) {
                return null;
            }
            for (let i = 1; i < tokens.length; i++) {
                if (tokens[i].startsWith("-")) continue;
                if (SERVER_FILE_PATTERN.test(tokens[i])) {
                    return this.denyServerStart(`${binary} ${tokens[i]}`);
                }
            }
        }

        if (binary === "npx" || binary === "bunx") {
            const toolToken = tokens.slice(1).find(t => !t.startsWith("-"));
            if (toolToken && SERVER_NPX_TOOLS.has(toolToken)) {
                return this.denyServerStart(`${binary} ${toolToken}`);
            }
        }

        if (binary === "python" || binary === "python3") {
            const hasManagePy = tokens.some(t => t === "manage.py" || t.endsWith("/manage.py"));
            if (hasManagePy && tokens.includes("runserver")) {
                return this.denyServerStart("manage.py runserver");
            }
            const mIndex = tokens.indexOf("-m");
            if (mIndex !== -1 && mIndex + 1 < tokens.length) {
                const mod = tokens[mIndex + 1];
                if (SERVER_PYTHON_MODULES.has(mod)) {
                    return this.denyServerStart(`python -m ${mod}`);
                }
            }
        }

        return null;
    }
}
