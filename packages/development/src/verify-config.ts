import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";

export interface VerifyCheck {
  readonly name: string;
  readonly command: string;
}

export interface VerifyConfig {
  readonly checks: readonly VerifyCheck[];
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

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(raw);
  } catch (err: unknown) {
    const detail =
      err instanceof TomlError
        ? `TOML syntax error at line ${err.line}, column ${err.column}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new VerifyConfigParseError(filePath, undefined, detail);
  }

  const checksSection = parsed["checks"];
  if (checksSection === undefined) {
    return { checks: [] };
  }

  if (
    typeof checksSection !== "object" ||
    checksSection === null ||
    Array.isArray(checksSection)
  ) {
    throw new VerifyConfigParseError(
      filePath,
      undefined,
      "[checks] must be a TOML table, not an array or primitive",
    );
  }

  const checks: VerifyCheck[] = [];
  const table = checksSection as Record<string, unknown>;
  for (const [name, value] of Object.entries(table)) {
    if (typeof value !== "string") {
      throw new VerifyConfigParseError(
        filePath,
        name,
        `expected a string command, got ${typeof value}`,
      );
    }
    checks.push({ name, command: value });
  }

  return { checks };
}
