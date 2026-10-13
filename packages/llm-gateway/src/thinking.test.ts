import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { InvalidThinkingPolicy } from "./errors.js";
import { loadThinkingPolicyFromToml, thinkingModeFor } from "./thinking.js";

function writeToml(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "ashara-thinking-")), "models.toml");
  writeFileSync(path, body, "utf-8");
  return path;
}

describe("loadThinkingPolicyFromToml", () => {
  test("reads the default and per-site modes; an unnamed site or no site uses the default", () => {
    const policy = loadThinkingPolicyFromToml(
      writeToml(`[thinking]\ndefault = "off"\n[thinking.sites]\n"escalation" = "on"\n`),
    );
    expect(thinkingModeFor(policy, "escalation")).toBe("on");
    expect(thinkingModeFor(policy, "decomposition")).toBe("off");
    expect(thinkingModeFor(policy, "environment-spec")).toBe("off");
    expect(thinkingModeFor(policy, undefined)).toBe("off");
  });

  test("a present table with an unknown site or mode is refused, never read as off", () => {
    for (const body of [
      `[thinking]\ndefault = "off"\n[thinking.sites]\n"judge" = "on"\n`,
      `[thinking]\ndefault = "maybe"\n`,
      `[thinking]\n[thinking.sites]\n"escalation" = "on"\n`,
    ]) {
      expect(() => loadThinkingPolicyFromToml(writeToml(body))).toThrow(InvalidThinkingPolicy);
    }
  });

  test("no [thinking] table, or no file, is thinking off everywhere (ADR-074 D13)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadThinkingPolicyFromToml(writeToml(`[routing.profiles."deepseek"]\n`))).toEqual({ default: "off", sites: {} });
    expect(loadThinkingPolicyFromToml(join(tmpdir(), "ashara-absent-thinking.toml"))).toEqual({ default: "off", sites: {} });
    warn.mockRestore();
  });

  test("the repo's config/models.toml parses", () => {
    expect(loadThinkingPolicyFromToml(join(import.meta.dirname, "..", "..", "..", "config", "models.toml")).default).toBe("off");
  });
});
