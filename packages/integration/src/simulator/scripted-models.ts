import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { schemaRefusalsFor } from "@ashara/model-access";
import type { LanguageModelFactory, ProviderType } from "@ashara/model-access";
import type { ObservedReview } from "./client-reports.js";
import type { ObservedIntake } from "./intake-readings.js";
import { AgentStandIn } from "./stand-ins/agent.js";
import { ClassifierStandIn } from "./stand-ins/classifier.js";
import type { StandInContext } from "./stand-ins/context.js";
import { IntakeStandIn } from "./stand-ins/intake.js";
import { LiaisonStandIn } from "./stand-ins/liaison.js";
import type { ClientAsk } from "./stand-ins/liaison.js";
import { PlannerStandIn } from "./stand-ins/planner.js";
import {
  StandInRefusedSchema,
  StandInUnanswerable,
  promptText,
  schemaKeys,
  structuredAnswer,
} from "./stand-ins/responses.js";
import { roster } from "./stand-ins/roster.js";
import { SuiteReviewStandIn } from "./stand-ins/suite-review.js";

/**
 * The stand-in for every model call site, routed to the role whose call it is: an agent turn by its
 * tools, a structured call by its schema's keys. A pure function of the tape, the universe, the call
 * and the database.
 */
export class StandIns {
  private readonly intake: IntakeStandIn;
  private readonly planner: PlannerStandIn;
  private readonly classifier: ClassifierStandIn;
  private readonly suiteReview: SuiteReviewStandIn;
  private readonly liaison: LiaisonStandIn;
  private readonly agent: AgentStandIn;

  constructor(private readonly context: StandInContext) {
    this.intake = new IntakeStandIn(context);
    this.planner = new PlannerStandIn(context);
    this.classifier = new ClassifierStandIn(context);
    this.suiteReview = new SuiteReviewStandIn(context);
    this.liaison = new LiaisonStandIn(context);
    this.agent = new AgentStandIn(context);
  }

  /**
   * Every suite review answered so far, as the stand-ins saw it, outside production's records: the
   * oracle that holds a verified item to two families' clean reviews reads these, never the claim
   * production recorded.
   */
  observedReviews(): readonly ObservedReview[] {
    return this.suiteReview.observed();
  }

  /**
   * Every tender reading asked or answered so far, as the stand-ins saw it, outside production's
   * records: the oracle that holds a reading that asked nothing to a second reading reads these.
   */
  observedIntakes(): readonly ObservedIntake[] {
    return this.intake.observed();
  }

  /** The correction the client is about to post: the Liaison's reading of it asks this of the contract. */
  askCorrection(kind: ClientAsk, during: string | null): void {
    this.liaison.askCorrection(kind, during);
  }

  readonly factory: LanguageModelFactory = (provider, model) =>
    this.model(`${provider.name}/${model.id}`, provider.providerType);

  private model(modelId: string, providerType: ProviderType): LanguageModelV4 {
    return {
      specificationVersion: "v4",
      provider: "ashara-simulator",
      modelId,
      supportedUrls: {},
      doGenerate: async (options) => {
        this.refuseUnacceptableSchemas(modelId, providerType, options);
        return await this.respond(options, modelId);
      },
      doStream: async () => {
        throw new StandInUnanswerable("stream", "no Ashara call site streams");
      },
    };
  }

  /**
   * The provider's own refusal of a schema it does not accept, as a real one makes it: the whole
   * request, before any answer. Every schema a request carries is judged by its provider type's
   * restrictions, and a refusal is reported to the run, so a soak fails on a schema a provider would
   * refuse even when nothing else in the run notices.
   */
  private refuseUnacceptableSchemas(
    modelId: string,
    providerType: ProviderType,
    options: LanguageModelV4CallOptions,
  ): void {
    const sent: Array<readonly [string, "structured-output" | "tool-input", unknown]> = [];
    if (options.responseFormat?.type === "json" && options.responseFormat.schema !== undefined)
      sent.push(["structured output", "structured-output", options.responseFormat.schema]);
    /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a request with no
       tools sends no tool schema */
    for (const tool of options.tools ?? [])
      if (tool.type === "function") sent.push([`tool "${tool.name}" input`, "tool-input", tool.inputSchema]);
    for (const [what, use, schema] of sent) {
      const refusals = schemaRefusalsFor(providerType, use, schema);
      if (refusals.length === 0) continue;
      const detail = refusals.map((refusal) => `${refusal.path}: ${refusal.rule}: ${refusal.detail}`).join("; ");
      this.context.onSchemaRefused({ model: modelId, providerType, what, detail });
      throw new StandInRefusedSchema(modelId, providerType, what, detail);
    }
  }

  private async respond(options: LanguageModelV4CallOptions, modelId: string): Promise<LanguageModelV4GenerateResult> {
    this.context.onRequest();
    if (options.tools !== undefined && options.tools.length > 0) return this.agent.turn(options);
    const format = options.responseFormat;
    if (format?.type !== "json")
      throw new StandInUnanswerable("structured", "a call with no tools asked for no JSON schema");
    const keys = schemaKeys(format.schema);
    const structured = (site: string, answer: () => unknown): Promise<LanguageModelV4GenerateResult> =>
      structuredAnswer(this.context, options, site, answer);
    if (keys.includes("guarantees")) return this.intake.reading(options, modelId);
    if (keys.length === 1 && keys[0] === "questions") return this.intake.secondReading(options, modelId);
    if (keys.includes("roles")) return structured("roster", () => roster(this.context));
    if (keys.includes("tasks")) return structured("decomposition.tasks", () => this.planner.plan(promptText(options)));
    if (keys.includes("problems")) return this.suiteReview.respond(options, modelId);
    if (keys.includes("reading")) return structured("liaison-answer", () => this.liaison.answer(promptText(options)));
    if (keys.includes("correction"))
      return structured("liaison-change", () => this.liaison.correction(promptText(options)));
    if (keys.includes("environmentChange")) return this.classifier.judge(options);
    throw new StandInUnanswerable("structured", `no stand-in answers a schema with keys [${keys.join(", ")}]`);
  }
}
