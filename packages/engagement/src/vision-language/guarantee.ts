import { z } from "zod";
import { verificationOf } from "@ashara/quality/published-verdicts";

// The vocabulary of the contract a vision version records: the product's interface, the guarantees a
// delivery is judged against, and the exclusions that keep silence from reading as a promise. Each
// record carries a stable key that is never reused, so a task, a report or a correction names it exactly.

const INTERFACE_ID = /^I[1-9]\d*$/;
const GUARANTEE_ID = /^G[1-9]\d*$/;
const EXCLUSION_ID = /^X[1-9]\d*$/;
const ASSUMPTION_ID = /^A[1-9]\d*$/;

/** An assumption's key: "A" and its number. */
export const AssumptionKeySchema = z.string().regex(ASSUMPTION_ID);

/** A guarantee's key: "G" and its number. */
export const GuaranteeKeySchema = z.string().regex(GUARANTEE_ID);

/**
 * Where a contract record comes from: a sentence of the client's tender, quoted verbatim, or an
 * assumption of the same vision version, by its key.
 */
const TenderSourceSchema = z.strictObject({ kind: z.literal("tender"), quote: z.string().trim().min(1) });
const AssumptionSourceSchema = z.strictObject({ kind: z.literal("assumption"), id: AssumptionKeySchema });

/** The sources a reading of the tender may give: the tender itself or an assumption, never a later message. */
const ContractSourceSchema = z.discriminatedUnion("kind", [TenderSourceSchema, AssumptionSourceSchema]);

/**
 * Where a stored contract record comes from: the tender, an assumption, or a client's change message
 * by its id, whose words put the record into a later version.
 */
const StoredSourceSchema = z.discriminatedUnion("kind", [
  TenderSourceSchema,
  AssumptionSourceSchema,
  z.strictObject({ kind: z.literal("correction"), messageId: z.string().min(1) }),
]);

export type StoredSource = z.infer<typeof StoredSourceSchema>;

/**
 * Where the client could see a guarantee hold or break: in what the deliverable outputs, in how it
 * reports errors, in its exit status, or in the data the client stores with it.
 */
const ObservationSchema = z.enum(["output", "errors", "exit-status", "stored-data"]);

export type Observation = z.infer<typeof ObservationSchema>;

/**
 * An observation kind as a drafter classifies it: "undecided" is a value it may give, and it is
 * recorded as stored-data, the stricter class, so doubt never buys a verdict an easier class would.
 */
export const ClassifiedObservationSchema = z
  .enum(["output", "errors", "exit-status", "stored-data", "undecided"])
  .transform((kind): Observation => (kind === "undecided" ? "stored-data" : kind));

/** An interface entry's key: "I" and its number. */
export const InterfaceKeySchema = z.string().regex(INTERFACE_ID);

/** An exclusion's key: "X" and its number. */
export const ExclusionKeySchema = z.string().regex(EXCLUSION_ID);

/**
 * Whether Ashara judges a guarantee with the checks it can run, as the contract recorded it when the
 * guarantee was proposed and the client was told: "not-by-ashara" is reported as not verified, never
 * as passed, and lies outside what acceptance requires judged. Quality decides it (verificationOf).
 */
const VerificationSchema = z.enum(["by-ashara", "not-by-ashara"]);

export { verificationOf };

/** What the client is told of a guarantee Ashara cannot verify with the checks it can run, when it is proposed and before work on it starts. */
export const NOT_VERIFIABLE_BY_ASHARA =
  "not verifiable by Ashara: no check Ashara can run today shows it holding, so Ashara's reports list it as not verified, never as passed, and the project is accepted without it";

/** One guarantee: its key, what it promises, where it is observed, what would refute it and where it comes from. */
const guaranteeShape = <O extends z.ZodType<Observation, unknown>, S extends z.ZodType<StoredSource>>(observation: O, source: S) =>
  z.strictObject({
    id: GuaranteeKeySchema,
    statement: z.string().trim().min(1),
    observable: z.strictObject({
      interface: z.array(InterfaceKeySchema).min(1),
      observation,
    }),
    refutedBy: z.array(z.string().trim().min(1)).min(1),
    source,
  });

/**
 * The contract records, each record sourced by `source`: one entry of the product's public interface
 * in the terms the product's kind has, the guarantees, and what the tender leaves out, recorded so its
 * absence from the guarantees is never read as a promise.
 */
const contractShape = <G extends z.ZodType, S extends z.ZodType<StoredSource>>(guarantee: G, source: S) =>
  z.strictObject({
    interface: z.array(z.strictObject({ id: InterfaceKeySchema, text: z.string().trim().min(1), source })).min(1),
    guarantees: z.array(guarantee).min(1),
    exclusions: z.array(z.strictObject({ id: ExclusionKeySchema, text: z.string().trim().min(1), source })),
  });

/**
 * The contract records of a guarantees-form version, as stored: never an empty interface or guarantee
 * list. A guarantee stored before the contract recorded whether Ashara can verify it carries no mark.
 */
export const StoredContractSchema = contractShape(
  guaranteeShape(ObservationSchema, StoredSourceSchema).extend({ verification: VerificationSchema.optional() }),
  StoredSourceSchema,
);

/**
 * The contract records a version's writer hands over: an undecided observation is recorded as
 * stored-data, and a guarantee that carries no mark yet is marked as Quality decides for its
 * observation; one already marked keeps the mark the client was told.
 */
export const WritableContractSchema = contractShape(
  guaranteeShape(ClassifiedObservationSchema, StoredSourceSchema)
    .extend({ verification: VerificationSchema.optional() })
    .transform((guarantee) => ({ ...guarantee, verification: guarantee.verification ?? verificationOf(guarantee.observable.observation) })),
  StoredSourceSchema,
);

/** The contract records a reading of the tender drafts: sourced only from the tender and its assumptions, and never marked by it. */
export const ContractDraftSchema = contractShape(guaranteeShape(ClassifiedObservationSchema, ContractSourceSchema), ContractSourceSchema);

export type ContractDraft = z.input<typeof ContractDraftSchema>;
export type StoredContract = z.infer<typeof StoredContractSchema>;
export type InterfaceEntry = StoredContract["interface"][number];
type Guarantee = StoredContract["guarantees"][number];

/**
 * Where a guarantee comes from as every reader sees it: a contract source, or, on a version written
 * before guarantees were, the in-scope line or the assumption it is read from.
 */
export type GuaranteeSource =
  | StoredSource
  | { readonly kind: "legacy"; readonly from: "scope" }
  | { readonly kind: "legacy"; readonly from: "assumption"; readonly id: string };

/**
 * How well a guarantee's footing is known, computed from the vision version it is read in and never
 * stored: what the client wrote or Stated ("client-stated"), what rests on an assumption the client
 * has not confirmed ("assumed-unconfirmed"), or what Ashara read into the tender ("derived").
 */
export type GuaranteeBasis = "client-stated" | "assumed-unconfirmed" | "derived";

/** One guarantee of a vision version, as every reader of the vision sees it. */
export interface VisionGuarantee {
  /** Its key in the vision; on a legacy version, the id of the scope line or assumption it is read from. */
  readonly id: string;
  readonly statement: string;
  /** The interface entries it is observed at; empty on a legacy guarantee, which names none. */
  readonly interface: readonly string[];
  /** "unclassified" on a legacy guarantee: it was never classified, so no verdict reads it as checkable. */
  readonly observation: Observation | "unclassified";
  /** What would show it broken; empty on a legacy guarantee, which is not checkable as written. */
  readonly refutedBy: readonly string[];
  /**
   * Whether the contract marks it verifiable by Ashara; "unmarked" on a guarantee recorded before the
   * contract carried the mark, or a legacy one: it was never told as not verifiable, so it stays in coverage.
   */
  readonly verification: z.infer<typeof VerificationSchema> | "unmarked";
  readonly source: GuaranteeSource;
  readonly basis: GuaranteeBasis;
}

/** One exclusion of a vision version, as every reader sees it; on a legacy version, an out-of-scope line. */
export interface VisionExclusion {
  readonly id: string;
  readonly text: string;
  readonly source: StoredSource | { readonly kind: "legacy"; readonly from: "scope" };
}

/** The facts of an assumption basisOf reads: its key, its status and the guarantees it underpins. */
interface AssumptionFooting {
  readonly id: string;
  readonly status: "Inferred" | "Stated" | null;
  readonly underpins: readonly string[];
}

/**
 * A guarantee's basis in the version whose assumptions are given. Any assumption it is sourced from or
 * that underpins it and is not Stated makes it assumed-unconfirmed, whatever else it rests on; a
 * tender quote, a client's change message or a Stated assumption makes it client-stated; a legacy scope line is derived. An
 * assumption named but absent from the version is not evidence of confirmation, so it reads unconfirmed.
 */
export function basisOf(
  guarantee: { readonly id: string; readonly source: GuaranteeSource },
  assumptions: readonly AssumptionFooting[],
): GuaranteeBasis {
  const sourceId = guarantee.source.kind === "assumption" || (guarantee.source.kind === "legacy" && guarantee.source.from === "assumption")
    ? guarantee.source.id
    : null;
  const resting = assumptions.filter((a) => a.id === sourceId || a.underpins.includes(guarantee.id));
  const sourceMissing = sourceId !== null && !assumptions.some((a) => a.id === sourceId);
  if (sourceMissing || resting.some((a) => a.status !== "Stated")) return "assumed-unconfirmed";
  if (guarantee.source.kind === "tender" || guarantee.source.kind === "correction" || sourceId !== null) return "client-stated";
  return "derived";
}

/** A stored guarantee as every reader sees it, its basis computed in the version it is read in. */
export function visionGuaranteeOf(guarantee: Guarantee, assumptions: readonly AssumptionFooting[]): VisionGuarantee {
  return {
    id: guarantee.id,
    statement: guarantee.statement,
    interface: guarantee.observable.interface,
    observation: guarantee.observable.observation,
    refutedBy: guarantee.refutedBy,
    verification: guarantee.verification ?? "unmarked",
    source: guarantee.source,
    basis: basisOf(guarantee, assumptions),
  };
}

/** The text a quote is matched in: runs of whitespace collapsed, so a line break never fails a verbatim quote. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
