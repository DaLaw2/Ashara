import type { ZodType } from "zod";
import type { CapabilityLevel } from "./capability-level.js";
import { GatewayError, NoProviderAvailableError, SchemaValidationError } from "./errors.js";
import { CAPABILITY_RANK } from "./capability-rank.js";
import type { KnownLLMSite, SecondOpinion } from "./types.js";

/**
 * Routing-profiles site tag stamped on every ladder attempt run at an
 * escalated capability tier (see `KnownLLMSite` in types.ts). Kept as one
 * constant so `withStructuredLadder` cannot drift on the spelling.
 */
const ESCALATION_SITE: KnownLLMSite = "escalation";

// ---------------------------------------------------------------------------
// Structured-output reliability ladder.
//
// One shared control-flow combinator behind EVERY structured/verdict LLM call:
//   N validated attempts against the current model → escalate ONE capability
//   tier → N more validated attempts → typed terminal failure. A deployment
//   with no model at the escalation tier ends at the same terminal failure once
//   the base tier is spent: the escalation is recorded as unavailable, never
//   substituted, and never thrown past the caller's exhaustion handling.
//
// Free-text judge parsing and text-fallback structured parsing are deliberate:
// generateObject fails often on the cheaper models. So the ladder is NOT "just retry" — it is
// MODEL-PARAMETERISED: persistent validation failure escalates to a stronger
// model (capability tier step-up) exactly once, then BLOCKS with a typed,
// self-diagnosing error (Discipline A: never silently accept; Discipline C:
// the error carries site, per-model attempt counts, last raw excerpt, and the
// validation errors).
//
// The ladder never invokes an LLM directly: the caller injects the per-attempt
// executor (`call` + `validate`, or a whole `attempt` for the structured wrap).
// This keeps it a pure combinator — unit-testable with a fake caller
// (model-access never imports development/planning; consumers depend on it).
// ---------------------------------------------------------------------------

const RAW_EXCERPT_LENGTH = 400;

const CAPABILITY_ORDER: readonly CapabilityLevel[] = ["Light", "Medium", "Strong", "Frontier"];

/**
 * The next capability tier up, or null when already at the top. Escalation is a
 * SINGLE step (escalate at most one tier per site invocation — no
 * unbounded climb burning budget).
 */
function nextCapability(capability: CapabilityLevel): CapabilityLevel | null {
  const i = CAPABILITY_ORDER.indexOf(capability);
  if (i < 0 || i >= CAPABILITY_ORDER.length - 1) return null;
  return CAPABILITY_ORDER[i + 1];
}

function excerpt(raw: string): string {
  return raw.length <= RAW_EXCERPT_LENGTH ? raw : raw.slice(0, RAW_EXCERPT_LENGTH);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LadderRequest {
  /** Stable identifier for the call site — surfaces in logs and errors. */
  readonly site: KnownLLMSite;
  readonly capability: CapabilityLevel;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly maxTokens: number;
}

export interface LadderAttemptEvent {
  readonly site: string;
  /** 1-based across the whole ladder (all tiers). */
  readonly attempt: number;
  readonly capability: CapabilityLevel;
  /** Null for an invalid attempt whose failure named no model. */
  readonly model: string | null;
  readonly outcome: "valid" | "invalid";
  readonly errors?: readonly string[];
  readonly rawExcerpt?: string;
}

interface LadderResult<T> {
  readonly value: T;
  readonly capability: CapabilityLevel;
  readonly model: string;
  readonly provider: string;
  /** Total attempts across all tiers until a valid result. */
  readonly attempts: number;
  /** Distinct capability tiers actually exercised. */
  readonly tiersUsed: number;
}

interface LadderModelAttempts {
  readonly capability: CapabilityLevel;
  /** Null when no attempt at this tier reported the model it reached. */
  readonly model: string | null;
  readonly attempts: number;
  readonly errors: readonly string[];
}

/** The escalation tier the deployment has no model for, and the routing refusal that said so. */
interface UnavailableEscalation {
  readonly capability: CapabilityLevel;
  readonly reason: string;
}

/**
 * Terminal typed failure: every validated attempt failed on every tier the
 * deployment can serve. Carries enough context to diagnose the failure from the
 * message alone (Discipline C), including an escalation tier that had no model.
 */
export class StructuredOutputExhausted extends GatewayError {
  readonly site: string;
  readonly perModel: readonly LadderModelAttempts[];
  readonly lastRawExcerpt: string;
  readonly validationErrors: readonly string[];
  /** Set when the escalation tier was never attempted because no model is graded at or above it. */
  readonly unavailableEscalation: UnavailableEscalation | null;

  constructor(
    site: string,
    perModel: readonly LadderModelAttempts[],
    lastRawExcerpt: string,
    validationErrors: readonly string[],
    unavailableEscalation: UnavailableEscalation | null,
  ) {
    const models = perModel
      .map((m) => `${m.capability}/${m.model ?? "no model reported"} x${m.attempts}`)
      .join(", ");
    const escalation = unavailableEscalation
      ? `; escalation to ${unavailableEscalation.capability} unavailable: ${unavailableEscalation.reason}`
      : "";
    super(
      `Structured output exhausted at "${site}" after [${models}]${escalation}: ` +
        `${validationErrors.join("; ") || "no valid result"} ` +
        `(last raw: ${JSON.stringify(lastRawExcerpt)})`,
    );
    this.name = "StructuredOutputExhausted";
    this.site = site;
    this.perModel = perModel;
    this.lastRawExcerpt = lastRawExcerpt;
    this.validationErrors = validationErrors;
    this.unavailableEscalation = unavailableEscalation;
  }

  /** Total attempts across every tier. */
  get totalAttempts(): number {
    return this.perModel.reduce((n, m) => n + m.attempts, 0);
  }

  /** Distinct capability tiers exercised. */
  get modelCount(): number {
    return this.perModel.length;
  }
}

// ---------------------------------------------------------------------------
// Generic core
// ---------------------------------------------------------------------------

type LadderAttemptOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly model: string; readonly provider: string }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
      readonly rawExcerpt?: string;
      readonly model?: string;
    }
  | {
      /** No model serves this tier; only an escalation tier may report it. */
      readonly ok: false;
      readonly tierUnavailable: string;
    };

interface LadderCoreDeps<T> {
  /** Validated attempts PER capability tier (>= 1). */
  readonly attempts: number;
  readonly attempt: (capability: CapabilityLevel, attemptNo: number) => Promise<LadderAttemptOutcome<T>>;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

function resolveTiers(request: LadderRequest): CapabilityLevel[] {
  const tiers: CapabilityLevel[] = [request.capability];
  const escalate = nextCapability(request.capability);
  if (escalate && CAPABILITY_RANK[escalate] > CAPABILITY_RANK[request.capability]) {
    tiers.push(escalate);
  }
  return tiers;
}

async function runLadderCore<T>(
  request: LadderRequest,
  deps: LadderCoreDeps<T>,
): Promise<LadderResult<T>> {
  if (deps.attempts < 1) {
    throw new GatewayError(
      `reliability-ladder: attempts must be >= 1 (site "${request.site}", got ${deps.attempts})`,
    );
  }

  const tiers = resolveTiers(request);
  const perModel: LadderModelAttempts[] = [];
  let attemptNo = 0;
  let lastRawExcerpt = "";
  let lastErrors: readonly string[] = [];

  for (const [tierIndex, capability] of tiers.entries()) {
    let tierModel: string | null = null;
    let tierErrors: readonly string[] = [];

    for (let i = 0; i < deps.attempts; i++) {
      attemptNo++;
      const outcome = await deps.attempt(capability, attemptNo);

      if ("tierUnavailable" in outcome) {
        if (tierIndex === 0) {
          throw new GatewayError(
            `reliability-ladder: the requested tier ${capability} at site "${request.site}" was reported ` +
              `unavailable; only an escalation tier may be (${outcome.tierUnavailable})`,
          );
        }
        throw new StructuredOutputExhausted(request.site, perModel, lastRawExcerpt, lastErrors, {
          capability,
          reason: outcome.tierUnavailable,
        });
      }

      if (outcome.ok) {
        deps.onAttempt?.({
          site: request.site,
          attempt: attemptNo,
          capability,
          model: outcome.model,
          outcome: "valid",
        });
        return {
          value: outcome.value,
          capability,
          model: outcome.model,
          provider: outcome.provider,
          attempts: attemptNo,
          tiersUsed: perModel.length + 1,
        };
      }

      tierModel = outcome.model ?? tierModel;
      tierErrors = outcome.errors;
      lastErrors = outcome.errors;
      if (outcome.rawExcerpt !== undefined) lastRawExcerpt = outcome.rawExcerpt;

      deps.onAttempt?.({
        site: request.site,
        attempt: attemptNo,
        capability,
        model: tierModel,
        outcome: "invalid",
        errors: outcome.errors,
        rawExcerpt: outcome.rawExcerpt,
      });
    }

    perModel.push({ capability, model: tierModel, attempts: deps.attempts, errors: tierErrors });
  }

  throw new StructuredOutputExhausted(request.site, perModel, lastRawExcerpt, lastErrors, null);
}

// ---------------------------------------------------------------------------
// withStructuredLadder — wrap generateStructured (planning sites) in the ladder
// ---------------------------------------------------------------------------

/**
 * A post-parse SEMANTIC validation of structured output. The Zod
 * schema proves the SHAPE; this proves a cross-field INVARIANT the schema cannot
 * express — e.g. every `dependsOn` ref names a sibling that was actually emitted.
 * Returning `ok:false` makes the ladder treat the attempt as failed and (with a
 * `reask`) feed the errors back into the retry prompt, so a single malformed LLM
 * emission is CORRECTED on retry instead of exploding the caller. It is not a throw so it crosses the model-access boundary
 * without the caller's error type leaking into this package.
 */
export type StructuredValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

interface StructuredProviderRequest<T> {
  readonly capability: CapabilityLevel;
  readonly prompt: string;
  readonly schema: ZodType<T>;
  readonly systemPrompt?: string;
  /** The output bound of every attempt; Finance prices the call's worst case from it. */
  readonly maxTokens: number;
  /** Routing site override for this call (rarely set directly — see `StructuredLadderOptions.site`, which sets it for every call this wrapper makes). */
  readonly site?: KnownLLMSite;
  /** A second opinion of one strength: every attempt, the escalated one included, goes only to a model of that strength (StructuredRequest.secondOpinion). */
  readonly secondOpinion?: SecondOpinion;
  /**
   * Optional semantic check run on the PARSED value inside each ladder attempt.
   * A `false` verdict is a retryable validation failure (feedback fed back via
   * `reask`), escalating a tier and finally raising `StructuredOutputExhausted`
   * exactly like a schema failure — never a hard throw into the caller.
   */
  readonly validate?: (value: T) => StructuredValidation;
}

interface StructuredProviderResult<T> {
  readonly data: T;
  readonly model: string;
  readonly provider: string;
}

export interface StructuredProvider {
  generateStructured<T>(request: StructuredProviderRequest<T>): Promise<StructuredProviderResult<T>>;
}

export interface StructuredLadderOptions {
  /**
   * Validated attempts PER capability tier, decided by each caller against
   * the retries it already has around the ladder: there is no default. One
   * attempt is one provider request: the gateway sends no retry of its own
   * (no text fallback after generateObject, no re-ask loop, SDK
   * `maxRetries: 0`), so these are the only same-model retries, each
   * reported through `onAttempt`. A truncated response
   * (`StructuredOutputTruncated`) is a failed attempt like any other.
   */
  readonly attempts: number;
  /**
   * Routing site every call this wrapper makes is tagged with. REQUIRED: a
   * ladder with no site routes by capability alone, which is a routing hole
   * by construction — the escalation tier would still be pinned by profile
   * while the base tier drifted to whatever capability logic picked.
   */
  readonly site: KnownLLMSite;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
  /**
   * Re-ask suffix appended to the prompt on attempts after the first, built from
   * the previous attempt's errors (schema or `validate`). Absent ⇒ retries re-send
   * the identical prompt (unchanged behavior). Present ⇒ the model is told WHAT was
   * wrong so it can correct a malformed emission.
   */
  readonly reask?: (ctx: { readonly errors: readonly string[] }) => string;
}

/**
 * Wrap a structured provider so every `generateStructured` call runs through
 * the ladder: attempts on the requested model, escalate one
 * capability tier on persistent schema failure, then throw
 * `StructuredOutputExhausted` (also when no model is graded at the escalation
 * tier, which `unavailableEscalation` records). Replaces per-site ad-hoc enum-drift tolerance
 * (G5) with the shared retry+escalate contract. The wrapped provider's own
 * validation surfaces as `SchemaValidationError`, which the ladder treats as a
 * failed attempt; any other (transport) error propagates unchanged.
 */
export function withStructuredLadder(
  provider: StructuredProvider,
  options: StructuredLadderOptions,
): StructuredProvider {
  const { attempts } = options;
  return {
    async generateStructured<T>(request: StructuredProviderRequest<T>): Promise<StructuredProviderResult<T>> {
      const { validate, ...providerRequest } = request;
      // Per-call site (rare) wins over this wrapper's own default.
      const baseSite = request.site ?? options.site;
      let lastErrors: readonly string[] = [];
      const result = await runLadderCore<T>(
        {
          site: baseSite,
          capability: request.capability,
          prompt: request.prompt,
          systemPrompt: request.systemPrompt,
          maxTokens: request.maxTokens,
        },
        {
          attempts,
          onAttempt: options.onAttempt,
          attempt: async (capability, attemptNo) => {
            const prompt =
              attemptNo > 1 && options.reask
                ? request.prompt + options.reask({ errors: lastErrors })
                : request.prompt;
            try {
              const response = await provider.generateStructured<T>({
                ...providerRequest,
                prompt,
                capability,
                site: capability === request.capability ? baseSite : ESCALATION_SITE,
              });
              if (validate) {
                const verdict = validate(response.data);
                if (!verdict.ok) {
                  lastErrors = verdict.errors;
                  return {
                    ok: false,
                    errors: verdict.errors,
                    rawExcerpt: excerpt(verdict.errors.join("; ")),
                    model: response.model,
                  };
                }
              }
              return {
                ok: true,
                value: response.data,
                model: response.model,
                provider: response.provider,
              };
            } catch (err) {
              if (err instanceof SchemaValidationError) {
                lastErrors = err.errors;
                return {
                  ok: false,
                  errors: err.errors,
                  rawExcerpt: excerpt(err.errors.join("; ")),
                  model: err.model ?? undefined,
                };
              }
              // The base tier is spent by now: a deployment with no model at the
              // escalation tier exhausts here, rather than throwing a routing
              // error past every caller's exhaustion handling. Routing refuses
              // before any request is sent, so nothing was spent on it.
              if (err instanceof NoProviderAvailableError && capability !== request.capability) {
                return { ok: false, tierUnavailable: err.message };
              }
              throw err;
            }
          },
        },
      );
      return { data: result.value, model: result.model, provider: result.provider };
    },
  };
}
