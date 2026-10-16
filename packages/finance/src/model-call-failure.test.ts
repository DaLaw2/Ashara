import { describe, expect, test } from "vitest";
import { ProviderError, StructuredOutputExhausted } from "@ashara/model-access";
import { LlmCallNotAdmitted, ModelAnswerUnfit, PreCallRefusal } from "./errors.js";
import { modelCallFailureOf } from "./model-call-failure.js";

const exhausted = () => new StructuredOutputExhausted("test-site", [], "", ["never valid"], null);
const notAdmitted = () =>
  new LlmCallNotAdmitted({ projectId: "p", callSite: "test-site", provider: "stub", model: "m", operation: "generateStructured" }, { cause: new Error("ledger down") });

describe("modelCallFailureOf", () => {
  test("the model's only when its output never validated, the provider's only when it failed the request", () => {
    expect(modelCallFailureOf(exhausted())).toBe("model");
    expect(modelCallFailureOf(new ProviderError("stub", "503", "provider"))).toBe("provider");
    expect(modelCallFailureOf(new Error("wrapped", { cause: new ProviderError("stub", "503", "provider") }))).toBe("provider");
  });

  test("an answer that validated and is unfit to act on is the model's, through any caller's class for it", () => {
    class VerdictUnfit extends ModelAnswerUnfit {}
    expect(modelCallFailureOf(new VerdictUnfit("names a suite it never read"))).toBe("model");
    expect(modelCallFailureOf(new Error("wrapped", { cause: new VerdictUnfit("unfit") }))).toBe("model");
    expect(modelCallFailureOf(new ModelAnswerUnfit("unfit", { cause: new PreCallRefusal("unpriced") }))).toBe("ashara");
  });

  test("anything it cannot name is Ashara's, never the model's or the provider's", () => {
    expect(modelCallFailureOf(new TypeError("Cannot read properties of undefined"))).toBe("ashara");
    expect(modelCallFailureOf("a thrown string")).toBe("ashara");
    expect(modelCallFailureOf(undefined)).toBe("ashara");
  });

  test("Ashara's fault anywhere in the chain wins over the model's or the provider's", () => {
    expect(modelCallFailureOf(new ProviderError("stub", "413", "ashara"))).toBe("ashara");
    expect(modelCallFailureOf(new PreCallRefusal("unpriced"))).toBe("ashara");
    expect(modelCallFailureOf(notAdmitted())).toBe("ashara");
    expect(modelCallFailureOf(new ProviderError("stub", "after a fault", "provider", { cause: notAdmitted() }))).toBe("ashara");
    expect(modelCallFailureOf(new Error("outer", { cause: new ProviderError("stub", "400", "ashara", { cause: exhausted() }) }))).toBe("ashara");
  });
});
