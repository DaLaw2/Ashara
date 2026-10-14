import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { InvalidThinkingPolicy } from "./errors.js";
import { loadThinkingPolicyFromToml, outputBudget, thinkingModeFor, thinkingProviderOptions } from "./thinking.js";
import { KNOWN_LLM_SITES } from "./types.js";

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
    expect(thinkingModeFor(policy, "not-a-site")).toBe("off");
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

  test("the repo's config/models.toml turns thinking on at every routing site (ADR-074 item 83 a)", () => {
    const policy = loadThinkingPolicyFromToml(join(import.meta.dirname, "..", "..", "..", "config", "models.toml"));
    for (const site of KNOWN_LLM_SITES) expect([site, thinkingModeFor(policy, site)]).toEqual([site, "on"]);
    expect(thinkingModeFor(policy, undefined)).toBe("off");
    expect(thinkingProviderOptions("deepseek", thinkingModeFor(policy, "agent-runner"))).toEqual({
      deepseek: { thinking: { type: "enabled" } },
    });
  });
});

describe("outputBudget", () => {
  test("thinking on adds the reasoning allowance on top of the answer's bound, within DeepSeek's ceiling", () => {
    const on = outputBudget("deepseek", "on", 4096, 0);
    expect(on.reasoningAllowance).toBeGreaterThan(0);
    expect(on.maxOutputTokens).toBe(4096 + on.reasoningAllowance);
    expect(outputBudget("deepseek", "on", 393_216, 0)).toEqual({ maxOutputTokens: 393_216, reasoningAllowance: 0 });
    expect(outputBudget("deepseek", "on", 4096, 2_000_000)).toEqual({ maxOutputTokens: 393_216, reasoningAllowance: 393_216 - 4096 });
  });

  // W11c D4: the suite review's prompt (20,084 input tokens) was cut off at 36,864 output tokens twice.
  test("the allowance grows with the prompt past the bound the W11c suite review was cut off at", () => {
    const small = outputBudget("deepseek", "on", 4096, 4_000);
    const review = outputBudget("deepseek", "on", 4096, 80_000);
    expect(small.maxOutputTokens).toBe(outputBudget("deepseek", "on", 4096, 0).maxOutputTokens);
    expect(review.reasoningAllowance).toBe(80_000);
    expect(review.maxOutputTokens).toBeGreaterThan(36_864);
  });

  test("thinking off, or a provider type that takes no thinking switch, keeps the caller's bound", () => {
    expect(outputBudget("deepseek", "off", 4096, 80_000)).toEqual({ maxOutputTokens: 4096, reasoningAllowance: 0 });
    expect(outputBudget("anthropic", "on", 4096, 80_000)).toEqual({ maxOutputTokens: 4096, reasoningAllowance: 0 });
  });
});
