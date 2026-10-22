import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { RECIPE_DEFECT_SYMPTOM } from "../product.js";
import type { StandInContext } from "./context.js";
import { promptText, structuredAnswer } from "./responses.js";

/** The planner's judgement of whether a revision needs an environment change, as the stand-in answers it. */
export class ClassifierStandIn {
  /** Classifications the flipping classifier has acted on: every other one is flipped. */
  private classifications = 0;

  constructor(private readonly context: StandInContext) {}

  judge(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    // An honest planner reads the evidence it is shown: the recipe defect names itself in the failures.
    const defect = promptText(options).includes(RECIPE_DEFECT_SYMPTOM);
    return structuredAnswer(this.context, options, "replan.environment", () => {
      const environmentChange = this.flips() ? !defect : defect;
      return {
        environmentChange,
        reason: environmentChange
          ? "The build cannot write its cache directory: the environment's recipe must change."
          : "The change is to product behaviour the environment already builds and tests.",
      };
    });
  }

  /** Whether the flipping classifier answers against its evidence: every other time its persona fires. */
  private flips(): boolean {
    const { personas, onModelCall } = this.context;
    if (personas.of("classifier") !== "flipping" || !personas.fires("classifier")) return false;
    this.classifications += 1;
    if (this.classifications % 2 === 0) return false;
    onModelCall({ site: "replan.environment", action: "persona flipping: answers against its evidence" });
    return true;
  }
}
