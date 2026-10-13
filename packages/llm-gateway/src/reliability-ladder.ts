import type { ZodType } from "zod";
import type { CapabilityLevel } from "@ashara/shared";
import { GatewayError, SchemaValidationError } from "./errors.js";
import { CAPABILITY_RANK } from "./pricing.js";
import type { KnownLLMSite } from "./types.js";

/**
 * Routing-profiles site tag stamped on every ladder attempt run at an
 * escalated capability tier (see `KnownLLMSite` in types.ts). Kept as one
 * constant so `withStructuredLadder` cannot drift on the spelling.
 */
const ESCALATION_SITE: KnownLLMSite = "escalation";

// ---------------------------------------------------------------------------
// Structured-output reliability ladder (Phase 4 t1, ADR-030 §"Structured-output
// reliability" / ADR-032 §3).
//
// One shared control-flow combinator behind EVERY structured/verdict LLM call:
//   N validated attempts against the current model → escalate ONE capability
//   tier → N more validated attempts → typed terminal failure.
//
// History it must respect (ADR-025): free-text judge parsing and text-fallback
// structured parsing were chosen deliberately because generateObject failed
// ~30% on the cheaper models. So the ladder is NOT "just retry" — it is
// MODEL-PARAMETERISED: persistent validation failure escalates to a stronger
// model (capability tier step-up) exactly once, then BLOCKS with a typed,
// self-diagnosing error (Discipline A: never silently accept; Discipline C:
// the error carries site, per-model attempt counts, last raw excerpt, and the
// validation errors).
//
// The ladder never invokes an LLM directly: the caller injects the per-attempt
// executor (`call` + `validate`, or a whole `attempt` for the structured wrap).
// This keeps it a pure combinator — unit-testable with a fake caller, and
// injectable into verify-core's subprocess-pure judge runner like CommandRunner
// is (llm-gateway never imports development/planning; consumers depend on it).
// ---------------------------------------------------------------------------

const RAW_EXCERPT_LENGTH = 400;

const CAPABILITY_ORDER: readonly CapabilityLevel[] = ["Light", "Medium", "Strong", "Frontier"];

/**
 * The next capability tier up, or null when already at the top. Escalation is a
 * SINGLE step (ADR-030: escalate at most one tier per site invocation — no
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
  readonly maxTokens?: number;
}

export interface LadderAttemptEvent {
  readonly site: string;
  /** 1-based across the whole ladder (all tiers). */
  readonly attempt: number;
  readonly capability: CapabilityLevel;
  readonly model: string;
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
  readonly model: string;
  readonly attempts: number;
  readonly errors: readonly string[];
}

/**
 * Terminal typed failure: every validated attempt failed on every tier. Carries
 * enough context to diagnose the failure from the message alone (Discipline C).
 */
class StructuredOutputExhausted extends GatewayError {
  readonly site: string;
  readonly perModel: readonly LadderModelAttempts[];
  readonly lastRawExcerpt: string;
  readonly validationErrors: readonly string[];

  constructor(
    site: string,
    perModel: readonly LadderModelAttempts[],
    lastRawExcerpt: string,
    validationErrors: readonly string[],
  ) {
    const models = perModel
      .map((m) => `${m.capability}/${m.model} x${m.attempts}`)
      .join(", ");
    super(
      `Structured output exhausted at "${site}" after [${models}]: ` +
        `${validationErrors.join("; ") || "no valid result"} ` +
        `(last raw: ${JSON.stringify(lastRawExcerpt)})`,
    );
    this.name = "StructuredOutputExhausted";
    this.site = site;
    this.perModel = perModel;
    this.lastRawExcerpt = lastRawExcerpt;
    this.validationErrors = validationErrors;
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
    };

interface LadderCoreDeps<T> {
  /** Validated attempts PER capability tier (>= 1). */
  readonly attempts: number;
  /**
   * Explicit escalation target. `undefined` = default one-step-up
   * (nextCapability); `null` = escalation disabled (single tier only).
   */
  readonly escalateCapability?: CapabilityLevel | null;
  readonly attempt: (capability: CapabilityLevel, attemptNo: number) => Promise<LadderAttemptOutcome<T>>;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

function resolveTiers<T>(request: LadderRequest, deps: LadderCoreDeps<T>): CapabilityLevel[] {
  const tiers: CapabilityLevel[] = [request.capability];
  const escalate =
    deps.escalateCapability === undefined
      ? nextCapability(request.capability)
      : deps.escalateCapability;
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

  const tiers = resolveTiers(request, deps);
  const perModel: LadderModelAttempts[] = [];
  let attemptNo = 0;
  let lastRawExcerpt = "";
  let lastErrors: readonly string[] = [];

  for (const capability of tiers) {
    let tierModel = "unknown";
    let tierErrors: readonly string[] = [];

    for (let i = 0; i < deps.attempts; i++) {
      attemptNo++;
      const outcome = await deps.attempt(capability, attemptNo);

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

  throw new StructuredOutputExhausted(request.site, perModel, lastRawExcerpt, lastErrors);
}

// ---------------------------------------------------------------------------
// withStructuredLadder — wrap generateStructured (planning sites) in the ladder
// ---------------------------------------------------------------------------

/**
 * A post-parse SEMANTIC validation of structured output (mig-run10). The Zod
 * schema proves the SHAPE; this proves a cross-field INVARIANT the schema cannot
 * express — e.g. every `dependsOn` ref names a sibling that was actually emitted.
 * Returning `ok:false` makes the ladder treat the attempt as failed and (with a
 * `reask`) feed the errors back into the retry prompt, so a single malformed LLM
 * emission is CORRECTED on retry instead of exploding the caller (the Run-10
 * phantom-ref failure). It is not a throw so it crosses the llm-gateway boundary
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
  readonly maxTokens?: number;
  /** Routing site override for this call (rarely set directly — see `StructuredLadderOptions.site`, which sets it for every call this wrapper makes). */
  readonly site?: KnownLLMSite;
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
  readonly model?: string;
  readonly provider?: string;
}

export interface StructuredProvider {
  generateStructured<T>(request: StructuredProviderRequest<T>): Promise<StructuredProviderResult<T>>;
}

export interface StructuredLadderOptions {
  /**
   * Validated attempts PER capability tier. Default 1 — the underlying
   * generateStructured already runs its own same-model text-fallback retries;
   * the ladder's added value here is the ESCALATION tier (ADR-030 G5 enum
   * drift), not redundant same-model repetition.
   */
  readonly attempts?: number;
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
   * wrong so it can correct it — the Run-10 self-heal for a malformed emission.
   */
  readonly reask?: (ctx: { readonly errors: readonly string[] }) => string;
}

/**
 * Wrap a structured provider so every `generateStructured` call runs through
 * the ladder: attempts on the requested model, escalate one
 * capability tier on persistent schema failure, then throw
 * `StructuredOutputExhausted`. Replaces per-site ad-hoc enum-drift tolerance
 * (G5) with the shared retry+escalate contract. The wrapped provider's own
 * validation surfaces as `SchemaValidationError`, which the ladder treats as a
 * failed attempt; any other (transport) error propagates unchanged.
 */
export function withStructuredLadder(
  provider: StructuredProvider,
  options: StructuredLadderOptions,
): StructuredProvider {
  const attempts = options.attempts ?? 1;
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
                model: response.model ?? "structured",
                provider: response.provider ?? "structured",
              };
            } catch (err) {
              if (err instanceof SchemaValidationError) {
                lastErrors = err.errors;
                return {
                  ok: false,
                  errors: err.errors,
                  rawExcerpt: excerpt(err.errors.join("; ")),
                };
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
