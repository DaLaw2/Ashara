import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlDate, TomlError } from "smol-toml";

export interface VerifyCheck {
  readonly name: string;
  readonly command: string;
}

export interface VerifyStartConfig {
  readonly command: string;
}

export interface VerifyConfig {
  readonly checks: readonly VerifyCheck[];
  readonly start?: VerifyStartConfig;
}

export class VerifyConfigParseError extends Error {
  readonly filePath: string;
  readonly key: string | undefined;
  readonly reason: string;

  constructor(filePath: string, key: string | undefined, reason: string) {
    const loc = key ? ` key "${key}"` : "";
    super(`Invalid verify.toml (${filePath})${loc}: ${reason}`);
    this.name = "VerifyConfigParseError";
    this.filePath = filePath;
    this.key = key;
    this.reason = reason;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

function parseToml(raw: string, filePath: string) {
  try {
    return parse(raw);
  } catch (err: unknown) {
    const detail =
      err instanceof TomlError
        ? `TOML syntax error at line ${err.line}, column ${err.column}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new VerifyConfigParseError(filePath, undefined, detail);
  }
}

export async function readVerifyConfig(projectDir: string): Promise<VerifyConfig> {
  const filePath = join(projectDir, "verify.toml");

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return { checks: [] };
    throw new VerifyConfigParseError(
      filePath,
      undefined,
      `cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = parseToml(raw, filePath);

  const checksSection = parsed["checks"];

  let checks: readonly VerifyCheck[] = [];
  if (checksSection !== undefined) {
    if (
      typeof checksSection !== "object" ||
      checksSection === null ||
      Array.isArray(checksSection) ||
      checksSection instanceof TomlDate
    ) {
      throw new VerifyConfigParseError(
        filePath,
        undefined,
        "[checks] must be a TOML table, not an array or primitive",
      );
    }

    const parsedChecks: VerifyCheck[] = [];
    for (const [name, value] of Object.entries(checksSection)) {
      if (typeof value !== "string") {
        throw new VerifyConfigParseError(
          filePath,
          name,
          `expected a string command, got ${typeof value}`,
        );
      }
      parsedChecks.push({ name, command: value });
    }
    checks = parsedChecks;
  }

  const startSection = parsed["start"];
  let start: VerifyStartConfig | undefined;
  if (startSection !== undefined) {
    if (
      typeof startSection !== "object" ||
      startSection === null ||
      Array.isArray(startSection) ||
      startSection instanceof TomlDate
    ) {
      throw new VerifyConfigParseError(
        filePath,
        undefined,
        "[start] must be a TOML table, not an array or primitive",
      );
    }
    const command = (startSection as Record<string, unknown>)["command"];
    if (typeof command !== "string") {
      throw new VerifyConfigParseError(
        filePath,
        "start.command",
        command === undefined
          ? "[start] section requires a \"command\" key"
          : `expected a string command, got ${typeof command}`,
      );
    }
    start = { command };
  }

  return { checks, ...(start !== undefined ? { start } : {}) };
}

/**
 * Detect commands that always exit 0 without testing anything — echo stubs,
 * `true`, `:`, bare `exit 0`. These bypass the "unverified" safety net
 * because they are syntactically valid checks that never fail.
 *
 * Conservatively non-vacuous when the command contains shell operators
 * (`&&`, `||`, `;`, `|`) — e.g. `echo 'building' && make` does real work.
 */
export function isVacuousCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  // Commands with shell operators are conservatively non-vacuous:
  // "echo hi && make" does real work after the echo.
  if (/&&|\|\||[;|]/.test(trimmed)) return false;
  if (/^\s*echo(\s|$)/.test(trimmed)) return true;
  if (/^\s*printf\s/.test(trimmed)) return true;
  if (/^\s*true\s*$/.test(trimmed)) return true;
  if (/^\s*:\s*$/.test(trimmed)) return true;
  if (/^\s*exit\s+0\s*$/.test(trimmed)) return true;
  return false;
}
