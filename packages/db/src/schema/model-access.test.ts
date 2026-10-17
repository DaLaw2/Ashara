import { describe, expect, test } from "vitest";
import { modelConfigs } from "./model-access.js";

// The catalog is the only source of a model's context window: a default would read a
// window nobody measured as a measured one, and the window guard would judge turns against it.
describe("model_configs.max_context_tokens", () => {
  test("is required and has no default", () => {
    expect(modelConfigs.maxContextTokens.notNull).toBe(true);
    expect(modelConfigs.maxContextTokens.hasDefault).toBe(false);
  });
});
