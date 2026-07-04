const ENV_ALLOWLIST = new Set([
    // System essentials
    "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "TMPDIR", "TZ",
    // Node.js
    "NODE_ENV", "NODE_PATH", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
    // Bun
    "BUN_INSTALL",
    // Rust
    "CARGO_HOME", "RUSTUP_HOME", "RUST_BACKTRACE", "RUST_LOG",
    // Go
    "GOPATH", "GOROOT", "GOBIN",
    // Python
    "PYTHONPATH", "VIRTUAL_ENV",
    // Build
    "CC", "CXX", "CFLAGS", "LDFLAGS", "PKG_CONFIG_PATH",
    // Git
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

const SECRET_PATTERNS: readonly RegExp[] = [
    /api[_-]?key/i, /api[_-]?token/i, /api[_-]?secret/i,
    /secret/i, /password/i, /credential/i,
    /^(ANTHROPIC|OPENAI|DEEPSEEK|MISTRAL|XAI|GOOGLE|ASHARA)_/,
    /^DATABASE_URL$/i, /^POSTGRES/i, /^PG/i,
    /^AWS_/, /^AZURE_/, /^GCP_/, /^GITHUB_TOKEN$/,
    /private[_-]?key/i, /access[_-]?token/i,
];

function matchesSecretPattern(key: string): boolean {
    return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

function isNpmMetadata(key: string): boolean {
    return key.startsWith("npm_config_") || key.startsWith("npm_package_");
}

function buildSanitizedEnv(extraAllowed?: string[]): Record<string, string> {
    const extraSet = new Set(extraAllowed ?? []);
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (matchesSecretPattern(key)) continue;

        if (ENV_ALLOWLIST.has(key) || isNpmMetadata(key) || extraSet.has(key)) {
            result[key] = value;
        }
    }

    return result;
}

export { ENV_ALLOWLIST, SECRET_PATTERNS, buildSanitizedEnv };
