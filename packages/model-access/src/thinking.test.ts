import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { InvalidThinkingPolicy, ModelsConfigUnreadable } from "./errors.js";
import { loadThinkingPolicyFromToml, outputBudget, thinkingModeFor, thinkingProviderOptions } from "./thinking.js";
import { KNOWN_LLM_SITES } from "./types.js";

const REPO_MODELS_TOML = join(import.meta.dirname, "..", "..", "..", "config", "models.toml");

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

  test("no [thinking] table is thinking off everywhere; no file is refused, never read as off", () => {
    expect(loadThinkingPolicyFromToml(writeToml(`[routing.profiles."deepseek"]\n`))).toEqual({ default: "off", sites: {} });
    expect(() => loadThinkingPolicyFromToml(join(tmpdir(), "ashara-absent-thinking.toml"))).toThrow(ModelsConfigUnreadable);
  });

  test("the repo's config/models.toml turns thinking on at every routing site", () => {
    const policy = loadThinkingPolicyFromToml(REPO_MODELS_TOML);
    for (const site of KNOWN_LLM_SITES) {
      expect([site, thinkingModeFor(policy, site)]).toEqual([site, "on"]);
    }
    expect(thinkingModeFor(policy, undefined)).toBe("off");
    expect(thinkingProviderOptions("deepseek", thinkingModeFor(policy, "agent-runner"))).toEqual({
      deepseek: { thinking: { type: "enabled" } },
    });
  });
});

describe("outputBudget", () => {
  // The most deepseek-flash reasoned on one suite review: the allowance must leave headroom over it at any prompt size.
  const MOST_SUITE_REVIEW_REASONING = 51_729;
  const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;

  test.each([
    ["the smallest review: the answer floor and no prompt", 8_192, 0],
    ["the measured review's answer bound and request bytes", 16_200, 58_352],
    ["the largest answer bound", 32_768, 120_000],
  ])("the repo's suite-review runs deepseek with thinking on, with headroom over the most reasoning seen: %s", (_label, answerTokens, promptBytes) => {
    const mode = thinkingModeFor(loadThinkingPolicyFromToml(REPO_MODELS_TOML), "suite-review");
    expect(mode).toBe("on");
    expect(thinkingProviderOptions("deepseek", mode)).toEqual({ deepseek: { thinking: { type: "enabled" } } });
    const budget = outputBudget("deepseek", mode, answerTokens, promptBytes, "suite-review");
    expect(budget.reasoningAllowance).toBeGreaterThanOrEqual(Math.ceil(MOST_SUITE_REVIEW_REASONING * 1.25));
    expect(budget.maxOutputTokens).toBe(answerTokens + budget.reasoningAllowance);
    expect(budget.maxOutputTokens).toBeLessThanOrEqual(DEEPSEEK_MAX_OUTPUT_TOKENS);
  });

  test("only suite-review takes the larger minimum; every other site, and a site-less call, keep the general one", () => {
    const suiteReview = outputBudget("deepseek", "on", 4096, 0, "suite-review").reasoningAllowance;
    for (const site of [...KNOWN_LLM_SITES.filter((s) => s !== "suite-review"), "not-a-site", undefined]) {
      expect([site, outputBudget("deepseek", "on", 4096, 0, site).reasoningAllowance]).toEqual([site, 32_768]);
    }
    expect(suiteReview).toBe(65_536);
    expect(outputBudget("deepseek", "on", 4096, 80_000, "suite-review").reasoningAllowance).toBe(80_000);
  });

  test("thinking on adds the reasoning allowance on top of the answer's bound, within DeepSeek's ceiling", () => {
    const on = outputBudget("deepseek", "on", 4096, 0, "decomposition");
    expect(on.reasoningAllowance).toBeGreaterThan(0);
    expect(on.maxOutputTokens).toBe(4096 + on.reasoningAllowance);
    expect(outputBudget("deepseek", "on", 393_216, 0, "decomposition")).toEqual({ maxOutputTokens: 393_216, reasoningAllowance: 0 });
    expect(outputBudget("deepseek", "on", 4096, 2_000_000, "decomposition")).toEqual({ maxOutputTokens: 393_216, reasoningAllowance: 393_216 - 4096 });
  });

  test("the allowance grows with the prompt past the minimum", () => {
    const small = outputBudget("deepseek", "on", 4096, 4_000, "decomposition");
    const large = outputBudget("deepseek", "on", 4096, 80_000, "decomposition");
    expect(small.maxOutputTokens).toBe(outputBudget("deepseek", "on", 4096, 0, "decomposition").maxOutputTokens);
    expect(large.reasoningAllowance).toBe(80_000);
    expect(large.maxOutputTokens).toBeGreaterThan(small.maxOutputTokens);
  });

  test("thinking off, or a provider type that takes no thinking switch, keeps the caller's bound", () => {
    expect(outputBudget("deepseek", "off", 4096, 80_000, "suite-review")).toEqual({ maxOutputTokens: 4096, reasoningAllowance: 0 });
    expect(outputBudget("anthropic", "on", 4096, 80_000, "suite-review")).toEqual({ maxOutputTokens: 4096, reasoningAllowance: 0 });
  });
});
