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
 * Where a check sees a guarantee hold or break: in what the deliverable outputs through its interface,
 * in how it reports errors, in its exit status, or only outside what its interface shows ("stored-data":
 * in the stored data itself, or only under an injected fault). OBSERVATION_RULE is how a drafter tells them apart.
 */
const ObservationSchema = z.enum(["output", "errors", "exit-status", "stored-data"]);

export type Observation = z.infer<typeof ObservationSchema>;

/**
 * An observation kind as a drafter classifies it: "undecided" is a value it may give when it cannot
 * tell whether the interface shows the guarantee. It is kept and stored as given, never read as a
 * class the drafter did not choose: an undecided guarantee is marked undecided (markOf).
 */
export const ClassifiedObservationSchema = z.enum([...ObservationSchema.options, "undecided"]);

export type ClassifiedObservation = z.infer<typeof ClassifiedObservationSchema>;

/**
 * How every drafter of a guarantee is told to classify its observation, the same for a tender's
 * reading and a client's change. It asks what someone using only the product's interface could see,
 * in whatever terms the product's kind has, so it holds for any product without naming one.
 */
export const OBSERVATION_RULE: readonly string[] = [
  `  "observation" is where a check sees the guarantee hold or break. Decide it by asking whether someone`,
  `  who uses the product only through its interface entries could see it: using them in any order and`,
  `  any number of times, setting the environment and configuration the product is given, stopping the`,
  `  product and starting it again, then reading what comes back through the interface. If they could,`,
  `  the observation is the kind of thing they read:`,
  `  - "output": what the product outputs or returns through an interface entry, including what reading`,
  `    back through the interface shows after earlier uses, after a change to its environment, or after`,
  `    it was stopped and started again;`,
  `  - "errors": how it reports an error;`,
  `  - "exit-status": the status it ends with.`,
  `  - "stored-data" only when nothing read through the interface shows it: it is seen only by opening`,
  `    what the product stores directly, or only by injecting a fault, such as stopping the product in`,
  `    the middle of a write. A promise that something is kept, persists or survives a restart is not`,
  `    "stored-data" when reading it back through the interface shows it.`,
  `  - "undecided" only when you cannot tell whether the interface shows it; the client is then asked`,
  `    where they would see it, and Ashara does not count it as one it can verify until they say.`,
];

/** An interface entry's key: "I" and its number. */
export const InterfaceKeySchema = z.string().regex(INTERFACE_ID);

/** An exclusion's key: "X" and its number. */
export const ExclusionKeySchema = z.string().regex(EXCLUSION_ID);

/**
 * Why Ashara cannot verify a guarantee with the checks it can run: a positive reason, never the
 * absence of a classification. "outside-interface": it is seen only outside what the product's
 * interface shows, and no check Ashara runs today reads stored data directly or injects a fault.
 */
const NotVerifiableReasonSchema = z.enum(["outside-interface"]);

export type NotVerifiableReason = z.infer<typeof NotVerifiableReasonSchema>;

/**
 * Whether Ashara judges a guarantee with the checks it can run, as the contract recorded it when the
 * guarantee was proposed and the client was told: "not-by-ashara", always with its reason, is reported
 * as not verified, never as passed, and lies outside what acceptance requires judged; "undecided" is a
 * guarantee whose drafter could not tell where it is seen: it is neither counted verifiable nor taken
 * out of what acceptance requires, and the client is asked where they would see it. Quality decides
 * which classified observation Ashara can verify (verificationOf).
 */
export type GuaranteeMark =
  | { readonly verification: "by-ashara" }
  | { readonly verification: "not-by-ashara"; readonly unverifiableBecause: NotVerifiableReason }
  | { readonly verification: "undecided" };

const VerificationSchema = z.enum(["by-ashara", "not-by-ashara", "undecided"]);

/** Quality marks a guarantee not verifiable for an observation no stated reason covers: nothing is told without a reason. */
class UnverifiableWithoutReason extends Error {
  constructor(readonly observation: Observation) {
    super(`Quality marks a guarantee observed at '${observation}' not verifiable by Ashara, and no reason is stated for that observation; it is not recorded`);
    this.name = "UnverifiableWithoutReason";
  }
}

/**
 * How the contract marks a guarantee drafted with `observation`: undecided as the drafter gave it, or
 * as Quality decides for its class, one Ashara cannot verify always with the reason why.
 */
export function markOf(observation: ClassifiedObservation): GuaranteeMark {
  if (observation === "undecided") return { verification: "undecided" };
  if (verificationOf(observation) === "by-ashara") return { verification: "by-ashara" };
  if (observation === "stored-data") return { verification: "not-by-ashara", unverifiableBecause: "outside-interface" };
  throw new UnverifiableWithoutReason(observation);
}

/** Why Ashara cannot verify a guarantee, in the client's words, by the reason. */
const NOT_VERIFIABLE_WORDS: Readonly<Record<NotVerifiableReason, string>> = {
  "outside-interface":
    "it is seen only outside what the product's interface shows, in the stored data itself or only under a fault such as a crash in the middle of a write, " +
    "and no check Ashara can run today reads stored data directly or injects such a fault",
};

/** Why Ashara cannot verify a guarantee marked so for `reason`, in the client's words. */
export function whyNotVerifiable(reason: NotVerifiableReason): string {
  return NOT_VERIFIABLE_WORDS[reason];
}

/** What the client is told of a guarantee Ashara cannot verify: that it is not, why, and what that means at acceptance. */
function notVerifiableByAshara(reason: NotVerifiableReason): string {
  return `not verifiable by Ashara: ${whyNotVerifiable(reason)}, so Ashara's reports list it as not verified, never as passed, and the project is accepted without it`;
}

/** What the client is told of a guarantee whose drafter could not tell where they would see it hold or break. */
export const OBSERVATION_UNDECIDED =
  "Ashara could not tell where you would see it hold or break, so it does not count it as one it can verify and it cannot be shown to hold; tell us where you would see it and Ashara can check it";

/** What the client is told of a guarantee marked `mark`: nothing for one Ashara can verify. */
export function markWords(mark: GuaranteeMark): string | null {
  switch (mark.verification) {
    case "by-ashara":
      return null;
    case "not-by-ashara":
      return notVerifiableByAshara(mark.unverifiableBecause);
    case "undecided":
      return OBSERVATION_UNDECIDED;
  }
}

/** One guarantee: its key, what it promises, where it is observed, what would refute it and where it comes from. */
const guaranteeShape = <S extends z.ZodType<StoredSource>>(source: S) =>
  z.strictObject({
    id: GuaranteeKeySchema,
    statement: z.string().trim().min(1),
    observable: z.strictObject({
      interface: z.array(InterfaceKeySchema).min(1),
      observation: ClassifiedObservationSchema,
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
 * What a stored guarantee records beyond its terms: the mark the client was told, absent on one stored
 * before the contract carried the mark, and the reason on one marked not verifiable.
 */
const storedMarks = { verification: VerificationSchema.optional(), unverifiableBecause: NotVerifiableReasonSchema.optional() };

const markedGuarantee = guaranteeShape(StoredSourceSchema).extend(storedMarks);
type MarkedGuarantee = z.infer<typeof markedGuarantee>;
type GuaranteeTerms = Omit<MarkedGuarantee, "verification" | "unverifiableBecause">;

/** A stored guarantee: its terms and the mark the client was told, or none on one stored before the contract carried the mark. */
export type StoredGuarantee = GuaranteeTerms & (GuaranteeMark | { readonly verification?: undefined });

/**
 * The mark a guarantee carries, as stored: null when it carries none. A mark that does not hold
 * together with its observation is an issue: an undecided observation is marked undecided and nothing
 * else is, and a reason goes with "not-by-ashara" alone. A "not-by-ashara" stored on a stored-data
 * guarantee before the reason was recorded reads the reason of the one rule that marked it so.
 */
function storedMarkOf(guarantee: MarkedGuarantee, ctx: z.RefinementCtx): GuaranteeMark | null {
  const { verification, unverifiableBecause, observable, id } = guarantee;
  const issue = (message: string): typeof z.NEVER => {
    ctx.addIssue({ code: "custom", message: `guarantee ${id}: ${message}`, input: guarantee });
    return z.NEVER;
  };
  if (unverifiableBecause !== undefined && verification !== "not-by-ashara") return issue("a reason it is not verifiable goes only with the mark not-by-ashara");
  if (observable.observation === "undecided" && verification !== "undecided") return issue(`an undecided observation is marked '${verification ?? "nothing"}'`);
  switch (verification) {
    case undefined:
      return null;
    case "by-ashara":
      return { verification };
    case "undecided":
      return observable.observation === "undecided" ? { verification } : issue(`a '${observable.observation}' observation is marked undecided`);
    case "not-by-ashara":
      if (unverifiableBecause !== undefined) return { verification, unverifiableBecause };
      return observable.observation === "stored-data" ? { verification, unverifiableBecause: "outside-interface" } : issue("it is marked not-by-ashara with no reason");
  }
}

/** A guarantee as stored: its terms, and its mark when it has one. */
function storedGuarantee(guarantee: MarkedGuarantee, mark: GuaranteeMark | null): StoredGuarantee {
  const { verification: _mark, unverifiableBecause: _reason, ...terms } = guarantee;
  return mark === null ? terms : { ...terms, ...mark };
}

/**
 * The contract records of a guarantees-form version, as stored: never an empty interface or guarantee
 * list. A guarantee stored before the contract recorded whether Ashara can verify it carries no mark,
 * and is carried over unmarked by a later version, never marked by being carried, since the client was
 * never told it is not verifiable. The writer of a guarantee a change adds or rewords marks it
 * (vision.ts, observed), so an undecided observation that reaches this unmarked is refused.
 */
export const StoredContractSchema = contractShape(
  markedGuarantee.transform((guarantee, ctx) => storedGuarantee(guarantee, storedMarkOf(guarantee, ctx))),
  StoredSourceSchema,
);

/**
 * The contract records of a project's first version: every guarantee in it is proposed now, so one
 * that carries no verification mark is marked as markOf decides for the observation it was drafted with.
 */
export const FirstContractSchema = contractShape(
  markedGuarantee.transform((guarantee, ctx) => {
    const unmarked = guarantee.verification === undefined && guarantee.unverifiableBecause === undefined;
    return storedGuarantee(guarantee, unmarked ? markOf(guarantee.observable.observation) : storedMarkOf(guarantee, ctx));
  }),
  StoredSourceSchema,
);

/** The contract records a reading of the tender drafts: sourced only from the tender and its assumptions, and never marked by it. */
export const ContractDraftSchema = contractShape(guaranteeShape(ContractSourceSchema), ContractSourceSchema);

export type ContractDraft = z.input<typeof ContractDraftSchema>;
export type StoredContract = z.infer<typeof StoredContractSchema>;
export type InterfaceEntry = StoredContract["interface"][number];

/**
 * Whether the client is told Ashara can verify a guarantee: the contract's mark, or on a guarantee
 * recorded before the contract carried one, what Quality decides for its observation, an unclassified
 * one never. The count only informs: an unmarked guarantee stays in coverage whatever it reads.
 */
export function verifiableByAshara(guarantee: Pick<VisionGuarantee, "verification" | "observation">): boolean {
  if (guarantee.verification !== "unmarked") return guarantee.verification === "by-ashara";
  return guarantee.observation !== "unclassified" && verificationOf(guarantee.observation) === "by-ashara";
}

/** How many of a contract's guarantees Ashara can verify, in the client's words. */
export function verifiableCountLine(verifiable: number, total: number): string {
  const of = total === 1 ? "the one guarantee" : `the ${total} guarantees`;
  return `Ashara can verify ${verifiable} of ${of} of this contract with the checks it can run today.`;
}

/**
 * A contract version Ashara declines: it holds guarantees, and every one is marked either not
 * verifiable by Ashara or undecided, so Ashara can verify none as written. Work never starts on it,
 * and confirming it as written changes nothing: only a version holding a guarantee Ashara can verify
 * ends the decline. A guarantee recorded before the contract carried the mark is not counted either
 * way, so a contract stored before the mark is never declined by it (unverifiableContractHeld in
 * predicates.ts reads the same rule in SQL).
 */
export function declinesUnverifiable(guarantees: readonly Pick<VisionGuarantee, "verification">[]): boolean {
  return guarantees.length > 0 && guarantees.every((g) => g.verification === "not-by-ashara" || g.verification === "undecided");
}

/**
 * Where the contract in force leaves the work, as every client message that says what happens to the
 * work reads it: "workable" when work may run on it, "held" when Ashara declines it
 * (declinesUnverifiable), so no work runs until the client restates it, and "unread" when the records
 * that say which do not read, so nothing is promised either way. Every composer of a message that
 * says what happens to the work takes it, and takes those words from WORK_WORDS (work-promise.ts).
 */
export type ContractStanding = "workable" | "held" | "unread";

/** The standing of a contract version holding `guarantees`: held exactly when Ashara declines it. */
export function contractStandingOf(guarantees: readonly Pick<VisionGuarantee, "verification">[]): Exclude<ContractStanding, "unread"> {
  return declinesUnverifiable(guarantees) ? "held" : "workable";
}

/**
 * What every message posted while a contract is declined tells the client: plainly that Ashara cannot
 * verify any guarantee as written, what that means at acceptance, that work does not start and that
 * confirming it as written does not start it, and how to restate the guarantees.
 */
export const NOTHING_VERIFIABLE =
  "Ashara cannot verify any guarantee of this contract as written: no check Ashara can run today would show any of them holding, " +
  "so the finished work could not be shown to hold and the project could not be accepted. " +
  "Please restate the guarantees so that at least one is seen through what the product shows when it is used: what it outputs, how it reports an error or the status it ends with. " +
  "No work starts on this contract until you do: confirming it as written does not start it.";

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

/** The terms of one guarantee of a vision version, as every reader of the vision sees them. */
interface VisionGuaranteeTerms {
  /** Its key in the vision; on a legacy version, the id of the scope line or assumption it is read from. */
  readonly id: string;
  readonly statement: string;
  /** The interface entries it is observed at; empty on a legacy guarantee, which names none. */
  readonly interface: readonly string[];
  /**
   * "unclassified" on a legacy guarantee, never classified, and on one whose drafter could not tell
   * where it is seen (marked undecided): no verdict reads either as checkable, and neither is stored-data.
   */
  readonly observation: Observation | "unclassified";
  /** What would show it broken; empty on a legacy guarantee, which is not checkable as written. */
  readonly refutedBy: readonly string[];
  readonly source: GuaranteeSource;
  readonly basis: GuaranteeBasis;
}

/**
 * One guarantee of a vision version, as every reader of the vision sees it, with the mark the contract
 * gives it; "unmarked" on a guarantee recorded before the contract carried the mark, or a legacy one:
 * it was never told as not verifiable, so it stays in coverage.
 */
export type VisionGuarantee = VisionGuaranteeTerms & (GuaranteeMark | { readonly verification: "unmarked" });

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
export function visionGuaranteeOf(guarantee: StoredGuarantee, assumptions: readonly AssumptionFooting[]): VisionGuarantee {
  const { observation } = guarantee.observable;
  const terms: VisionGuaranteeTerms = {
    id: guarantee.id,
    statement: guarantee.statement,
    interface: guarantee.observable.interface,
    observation: observation === "undecided" ? "unclassified" : observation,
    refutedBy: guarantee.refutedBy,
    source: guarantee.source,
    basis: basisOf(guarantee, assumptions),
  };
  switch (guarantee.verification) {
    case undefined:
      return { ...terms, verification: "unmarked" };
    case "not-by-ashara":
      return { ...terms, verification: guarantee.verification, unverifiableBecause: guarantee.unverifiableBecause };
    case "by-ashara":
    case "undecided":
      return { ...terms, verification: guarantee.verification };
  }
}

/** The text a quote is matched in: runs of whitespace collapsed, so a line break never fails a verbatim quote. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
