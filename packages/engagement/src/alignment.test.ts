import { describe, expect, test } from "vitest";

import type { AlignmentConfig, DirectionCategory, DirectionInference } from "./alignment-types.js";
import { AlignmentEngine, StubAlignmentLLM } from "./alignment.js";

const DEFAULT_REQUIRED: DirectionCategory[] = ["platform", "architecture", "data_flow", "persistence"];
const DEFAULT_OPTIONAL: DirectionCategory[] = ["scale", "deployment", "integration", "security"];

function makeConfig(overrides: Partial<AlignmentConfig> = {}): AlignmentConfig {
  return {
    requiredCategories: DEFAULT_REQUIRED,
    optionalCategories: DEFAULT_OPTIONAL,
    minCompletenessScore: 0.6,
    ...overrides,
  };
}

describe("parseVision", () => {
  const llm = new StubAlignmentLLM();
  const engine = new AlignmentEngine(llm);

  test("always returns empty signals (all inference goes to LLM)", () => {
    const parsed = engine.parseVision("Build a web app for task management");
    expect(parsed.signals).toHaveLength(0);
    expect(parsed.raw).toBe("Build a web app for task management");
  });

  test("returns empty signals for unrecognized vision", () => {
    const parsed = engine.parseVision("Make something cool");
    expect(parsed.signals).toHaveLength(0);
    expect(parsed.raw).toBe("Make something cool");
  });
});

describe("generateQuestions", () => {
  const llm = new StubAlignmentLLM();
  const engine = new AlignmentEngine(llm);

  test("generates questions for missing required categories", () => {
    const inferences: DirectionInference[] = [
      { category: "platform", inference: "web application", confidence: "high", source: "inferred" },
    ];
    const config = makeConfig();
    const questions = engine.generateQuestions(inferences, config);
    const questionCategories = questions.map((q) => q.category);
    expect(questionCategories).toContain("architecture");
    expect(questionCategories).toContain("data_flow");
    expect(questionCategories).toContain("persistence");
    expect(questionCategories).not.toContain("platform");
  });

  test("no questions when all categories covered", () => {
    const inferences: DirectionInference[] = DEFAULT_REQUIRED.map((cat) => ({
      category: cat,
      inference: "test",
      confidence: "high" as const,
      source: "inferred" as const,
    }));
    const config = makeConfig({ optionalCategories: [] });
    const questions = engine.generateQuestions(inferences, config);
    expect(questions).toHaveLength(0);
  });
});

describe("checkCompleteness", () => {
  const llm = new StubAlignmentLLM();
  const engine = new AlignmentEngine(llm);

  test("complete when all required categories covered", () => {
    const inferences: DirectionInference[] = [
      ...DEFAULT_REQUIRED.map((cat) => ({
        category: cat,
        inference: "test",
        confidence: "high" as const,
        source: "inferred" as const,
      })),
      { category: "scale" as DirectionCategory, inference: "test", confidence: "high", source: "inferred" },
    ];
    const config = makeConfig();
    const check = engine.checkCompleteness(inferences, config);
    expect(check.complete).toBe(true);
  });

  test("incomplete when missing required category", () => {
    const inferences: DirectionInference[] = [
      { category: "platform", inference: "web", confidence: "high", source: "inferred" },
      { category: "architecture", inference: "mono", confidence: "high", source: "inferred" },
      { category: "data_flow", inference: "sync", confidence: "high", source: "inferred" },
    ];
    const config = makeConfig();
    const check = engine.checkCompleteness(inferences, config);
    expect(check.complete).toBe(false);
    expect(check.missingCategories).toContain("persistence");
  });
});
