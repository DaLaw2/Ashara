import type {
  KnownLLMSite,
  LLMGateway,
  ProviderRequest,
  ProviderRequestGate,
  ResolvedModel,
  SentProviderRequest,
  StructuredProvider,
  TurnRequest,
  TurnResult,
} from "@ashara/model-access";
import type { Logger, ProjectId, WorkItemId } from "@ashara/shared";
import type { CapabilityLevel } from "@ashara/model-access";
import type { CostMeasurement } from "./cost.js";
import { LlmCallCostMissing, LlmCallNotAdmitted, LlmCallNotRecorded, PreCallRefusal } from "./errors.js";

/** Required on every model call: the project the spend belongs to, and the work item when one is served. */
interface LlmCallContext {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId | null;
  /** Who the call serves: always a routing site. */
  readonly callSite: KnownLLMSite;
}

/** One provider request about to be sent, charged to `context`, admitted in the log trace `traceId`. */
export interface PendingLlmCall extends ProviderRequest {
  readonly context: LlmCallContext;
  readonly traceId: string;
}

/** One provider request as the gateway saw it, charged to `context`. */
export interface LlmProviderCall extends SentProviderRequest {
  readonly context: LlmCallContext;
}

/**
 * Finance's cost recorder port. `admit` is the pre-call check: it runs before
 * every provider request and throws a `PreCallRefusal` to refuse it (an
 * unpriced model, a worst-case cost over a spend cap). `record` runs once after
 * every admitted request, success or failure, with the same `callId`, and
 * returns the request's cost: the one place a call's cost is computed.
 */
export interface LlmCallRecorder {
  admit(call: PendingLlmCall): Promise<void>;
  record(call: LlmProviderCall): Promise<CostMeasurement>;
}

/** An agent turn with its cost, as Finance measured and recorded it. */
export interface CostedTurnResult extends TurnResult {
  readonly cost: CostMeasurement;
}

/** One single-step call per agent turn, admitted and recorded by Finance. */
interface CostedTurnLlm {
  generateTurn(request: TurnRequest): Promise<CostedTurnResult>;
}

/** A structured provider scoped to one call context: every provider request it makes is admitted and recorded against it. */
export interface ContextualLlm {
  forCall(context: LlmCallContext): StructuredProvider;
}

/** The turn port of the same guard: one admitted and recorded single-step call per agent turn. */
export interface ContextualTurnLlm {
  forCall(context: LlmCallContext): CostedTurnLlm;
}

/**
 * Finance in front of Model Access: every model call goes through here, so
 * every provider request is checked before it is sent (price, spend caps) and
 * recorded after it, charged to the call's project. The recorder measures each
 * request's cost once; a turn returns that same measurement. Its admission and its record are each
 * logged in a scope naming the call (`callSite`, `callId`), so an llm_calls row leads to its records.
 */
export class GuardedModelAccess implements ContextualLlm, ContextualTurnLlm {
  constructor(
    private readonly gateway: Pick<LLMGateway, "gated" | "resolveModel" | "resolveModelWithWindowAbove">,
    private readonly recorder: LlmCallRecorder,
    private readonly logger: Logger,
  ) {}

  /** The model a capability resolves to at a site. Resolution sends no request, so nothing is admitted or recorded. */
  resolveModel(capability: CapabilityLevel, site: KnownLLMSite): ResolvedModel {
    return this.gateway.resolveModel(capability, site);
  }

  /** A model for `capability` at `site` whose context window is larger than `windowTokens`; null when none is. Sends no request. */
  resolveModelWithWindowAbove(capability: CapabilityLevel, site: KnownLLMSite, windowTokens: number): ResolvedModel | null {
    return this.gateway.resolveModelWithWindowAbove(capability, site, windowTokens);
  }

  forCall(context: LlmCallContext): StructuredProvider & CostedTurnLlm {
    const structured = this.gateway.gated(context.callSite, this.gateFor(context, () => undefined));
    return {
      generateStructured: structured.generateStructured,
      generateTurn: async (request) => {
        const costs: CostMeasurement[] = [];
        const result = await this.gateway
          .gated(context.callSite, this.gateFor(context, (cost) => costs.push(cost)))
          .generateTurn(request);
        const [cost] = costs;
        if (costs.length !== 1 || cost === undefined) {
          throw new LlmCallCostMissing({ ...context, provider: result.provider, model: result.model, recorded: costs.length });
        }
        return { ...result, cost };
      },
    };
  }

  /**
   * The gate for one call context. A refusal throws as itself; a check that
   * broke throws `LlmCallNotAdmitted`, and a record that failed throws
   * `LlmCallNotRecorded`, each naming the project the call was charged to.
   */
  private gateFor(context: LlmCallContext, onRecorded: (cost: CostMeasurement) => void): ProviderRequestGate {
    const where = (request: ProviderRequest) => ({
      projectId: context.projectId,
      callSite: context.callSite,
      provider: request.provider,
      model: request.model.id,
      operation: request.operation,
    });
    const fields = (request: ProviderRequest) => ({
      projectId: context.projectId,
      taskId: context.taskId,
      provider: request.provider,
      model: request.model.id,
      operation: request.operation,
    });
    const inCall = <T>(request: ProviderRequest, work: () => Promise<T>): Promise<T> =>
      this.logger.scope({ callSite: context.callSite, callId: request.callId }, work);
    return {
      admit: (request) =>
        inCall(request, async () => {
          try {
            await this.recorder.admit({ ...request, context, traceId: this.logger.trace() });
          } catch (error) {
            if (error instanceof PreCallRefusal) throw error;
            throw new LlmCallNotAdmitted(where(request), { cause: error });
          }
          this.logger.info("finance.call-admitted", `model call ${request.callId} admitted at ${context.callSite}`, fields(request));
        }),
      settle: (request) =>
        inCall(request, async () => {
          let cost: CostMeasurement;
          try {
            cost = await this.recorder.record({ ...request, context });
          } catch (writeError) {
            throw new LlmCallNotRecorded(
              {
                ...where(request),
                callOutcome: request.outcome.kind === "ok" ? "ok" : `error (${request.outcome.errorKind})`,
                providerError: request.providerError,
              },
              { cause: writeError },
            );
          }
          this.logger.info("finance.call-recorded", `model call ${request.callId} recorded`, {
            ...fields(request),
            outcome: request.outcome.kind === "ok" ? "ok" : `error (${request.outcome.errorKind})`,
            costMeasured: cost.measured,
          });
          onRecorded(cost);
        }),
    };
  }
}
