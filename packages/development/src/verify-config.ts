import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface VerifyCheck {
  readonly name: string;
  readonly command: string;
}

export interface VerifyConfig {
  readonly checks: readonly VerifyCheck[];
}

export async function readVerifyConfig(projectDir: string): Promise<VerifyConfig> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, "verify.toml"), "utf-8");
  } catch {
    return { checks: [] };
  }

  const checks: VerifyCheck[] = [];
  let inChecksSection = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      inChecksSection = trimmed === "[checks]";
      continue;
    }

    if (!inChecksSection) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"(.+)"$/);
    if (match) {
      checks.push({ name: match[1], command: match[2] });
    }
  }

  return { checks };
}
