import { z } from "zod";
import { AssumptionKeySchema, ClassifiedObservationSchema, ExclusionKeySchema, GuaranteeKeySchema, InterfaceKeySchema } from "./guarantee.js";

// The vocabulary of a correction: the typed operations a client's change makes to the contract of the
// vision version in force, each with the direction it moves what Ashara promised, and the record of
// one revision: who wrote it, who approved it, which way it moved the promise and why.

/** Which way an operation, or a whole revision, moves what Ashara promises the client. */
const DirectionSchema = z.enum(["widens", "narrows", "neutral"]);

export type Direction = z.infer<typeof DirectionSchema>;

/**
 * Why a revision was written: the client changed their mind, the client corrected Ashara's misreading
 * of their tender, or Ashara decided it for the work (a stack choice).
 */
export type RevisionCause = "client-change" | "misread" | "ashara-decision";

const text = z.string().trim().min(1);

/** A guarantee's terms as a correction states them whole: what it promises, where it is observed and what refutes it. */
const guaranteeTerms = {
  statement: text,
  interface: z.array(InterfaceKeySchema).min(1),
  observation: ClassifiedObservationSchema,
  refutedBy: z.array(text).min(1),
};

/** The direction the reading gives an operation; Engagement checks it (checkedDirection) before it is recorded. */
const direction = { direction: DirectionSchema };

/** A guarantee restated whole, by its key. */
const AmendGuaranteeOpSchema = z.strictObject({ op: z.literal("amend-guarantee"), id: GuaranteeKeySchema, ...guaranteeTerms, ...direction });

/** An assumption restated, by its key. */
const AmendAssumptionOpSchema = z.strictObject({ op: z.literal("amend-assumption"), id: AssumptionKeySchema, statement: text, ...direction });

/**
 * An amendment of a record the contract already holds, as a client's answer makes one: an assumption
 * or a guarantee restated, never one added or withdrawn.
 */
export const AmendOpSchema = z.discriminatedUnion("op", [AmendAssumptionOpSchema, AmendGuaranteeOpSchema]);

export type AmendOp = z.infer<typeof AmendOpSchema>;

/**
 * One operation of a correction as a model reads it from the client's message: a record of the
 * contract added, amended (its terms restated whole) or withdrawn, by its key.
 */
export const ContractOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add-guarantee"), ...guaranteeTerms, ...direction }),
  AmendGuaranteeOpSchema,
  z.strictObject({ op: z.literal("withdraw-guarantee"), id: GuaranteeKeySchema, ...direction }),
  AmendAssumptionOpSchema,
  z.strictObject({ op: z.literal("add-exclusion"), text, ...direction }),
  z.strictObject({ op: z.literal("withdraw-exclusion"), id: ExclusionKeySchema, ...direction }),
  z.strictObject({ op: z.literal("add-interface"), text, ...direction }),
  z.strictObject({ op: z.literal("amend-interface"), id: InterfaceKeySchema, text, ...direction }),
  z.strictObject({ op: z.literal("withdraw-interface"), id: InterfaceKeySchema, ...direction }),
]);

export type ContractOp = z.infer<typeof ContractOpSchema>;

const OpTargetSchema = z.enum(["interface", "guarantee", "assumption", "exclusion"]);
const OpActionSchema = z.enum(["add", "amend", "withdraw"]);

export type OpTarget = z.infer<typeof OpTargetSchema>;
export type OpAction = z.infer<typeof OpActionSchema>;

const SHAPE: Readonly<Record<ContractOp["op"], { readonly target: OpTarget; readonly action: OpAction }>> = {
  "add-guarantee": { target: "guarantee", action: "add" },
  "amend-guarantee": { target: "guarantee", action: "amend" },
  "withdraw-guarantee": { target: "guarantee", action: "withdraw" },
  "amend-assumption": { target: "assumption", action: "amend" },
  "add-exclusion": { target: "exclusion", action: "add" },
  "withdraw-exclusion": { target: "exclusion", action: "withdraw" },
  "add-interface": { target: "interface", action: "add" },
  "amend-interface": { target: "interface", action: "amend" },
  "withdraw-interface": { target: "interface", action: "withdraw" },
};

/** What an operation acts on and how. */
export function opShape(op: ContractOp): { readonly target: OpTarget; readonly action: OpAction } {
  return SHAPE[op.op];
}

/** The key an operation names; null for an add, whose key is given when it is applied. */
export function opKey(op: ContractOp): string | null {
  return "id" in op ? op.id : null;
}

/**
 * One operation of a revision as vision_revisions.ops records it. `read` is the operation as the
 * model read it from the client's message, kept whole so a confirmation applies it as sent; null on an
 * operation Engagement wrote from a record of its own (an answer, a stack choice), whose `statement`
 * says what the record now holds. `labelled` is the direction the reading gave it; `direction` the one
 * Engagement checked and records.
 */
export interface RevisionOp {
  readonly target: OpTarget;
  readonly action: OpAction;
  /** The record's key: the one the op names, or the one an add was given; null on an add not yet applied. */
  readonly key: string | null;
  readonly direction: Direction;
  readonly labelled: Direction | null;
  readonly read: ContractOp | null;
  readonly statement: string | null;
}

/** vision_revisions.ops as stored: a non-empty list of revision operations. */
export const StoredRevisionOpsSchema = z
  .array(
    z.strictObject({
      target: OpTargetSchema,
      action: OpActionSchema,
      key: z.string().min(1).nullable(),
      direction: DirectionSchema,
      labelled: DirectionSchema.nullable(),
      read: ContractOpSchema.nullable(),
      statement: z.string().min(1).nullable(),
    }),
  )
  .min(1);

/** A revision's direction from its operations': it narrows when any narrows, else widens when any widens. */
export function revisionDirection(ops: readonly { readonly direction: Direction }[]): Direction {
  if (ops.some((op) => op.direction === "narrows")) return "narrows";
  if (ops.some((op) => op.direction === "widens")) return "widens";
  return "neutral";
}

/**
 * Who wrote a revision and who approved it. A client's revision names the message it was read from;
 * Ashara's names none, and is approved only once the client confirms it.
 */
type RevisionAuthorship =
  | { readonly author: "client"; readonly sourceMessageId: string }
  | { readonly author: "ashara"; readonly sourceMessageId: null };

/** One revision of a project's contract, as vision_revisions records it. */
export type RevisionRecord = RevisionAuthorship & {
  readonly approver: "client" | null;
  readonly direction: Direction;
  readonly cause: RevisionCause;
  readonly ops: readonly [RevisionOp, ...RevisionOp[]];
  /** What the Liaison told the client before applying it, and asked them to confirm; null when it applied as sent. */
  readonly pushback: Pushback | null;
};

/** Why the Liaison holds a correction for the client's confirmation: each reason is mechanical. */
export type PushbackReason =
  | { readonly kind: "merged-guarantee"; readonly guarantees: readonly [string, ...string[]] }
  | { readonly kind: "over-budget"; readonly highRequests: number; readonly budgetLeftRequests: number };

export interface Pushback {
  readonly reasons: readonly [PushbackReason, ...PushbackReason[]];
}
