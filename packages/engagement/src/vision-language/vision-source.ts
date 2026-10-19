import { z } from "zod";
import { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL, ScopeSideSchema } from "./vision-assumption.js";
import type { ScopeSide } from "./vision-assumption.js";

/**
 * One item of the vision a plan derives from, as a task cites it: a guarantee, by its key, with where
 * it is observed and what would refute it, or an assumption, by its key, with its status, what the
 * client has seen of it and its kind. `id` is the item's id in the vision version the plan was
 * decomposed from. A scope line is how a plan decomposed before guarantees were recorded cites the
 * vision, read back as stored; one stored before sides were recorded reads as "unclassified".
 */
export const VisionSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("guarantee"),
    id: z.string().min(1),
    text: z.string().min(1),
    observation: z.enum(["output", "errors", "exit-status", "stored-data", "unclassified"]),
    interface: z.array(z.string().min(1)),
    refutedBy: z.array(z.string().min(1)),
  }),
  z.strictObject({
    type: z.literal("scope"),
    id: z.string().min(1),
    text: z.string().min(1),
    side: ScopeSideSchema.default("unclassified"),
  }),
  z.strictObject({
    type: z.literal("assumption"),
    id: z.string().min(1),
    text: z.string().min(1),
    status: z.string().min(1),
    // A stored "not-shown" means what "unrecorded" means, a record that says neither asked nor
    // reported, so it is read as that.
    standing: z.union([z.enum(["stated", "asked", "reported", "unrecorded"]), z.literal("not-shown").transform(() => "unrecorded" as const)]),
    kind: z.enum(["client-visible", "internal-design", "unclassified"]),
  }),
]);

export type VisionSource = z.infer<typeof VisionSourceSchema>;

const SIDE: Readonly<Record<ScopeSide, string>> = { in: "in scope", out: "out of scope", unclassified: "scope" };

/**
 * A vision item as a prompt read at once names it: its id, what it is, where it stands with the client
 * and its text. Only for text used when it is written (the planner's prompt): the standing is the
 * one the item recorded then, and an answer later changes it.
 */
export function visionSourceLine(item: VisionSource): string {
  if (item.type === "guarantee") return guaranteeLine(item);
  if (item.type === "scope") return `${item.id} (${SIDE[item.side]}): ${item.text}`;
  return `${item.id} (assumption; ${ASSUMPTION_STANDING_LABEL[item.standing]}; ${ASSUMPTION_KIND_LABEL[item.kind]}${citability(item.kind)}): ${item.text}`;
}

/**
 * A vision item as text stored now and read later names it (a task's description, the items a stored
 * plan cites): its id, what it is and its text, never its standing with the client, which an answer
 * changes after the plan is written. Where it stands when the work starts is the brief's own
 * assumptions section, read from the vision current at dispatch.
 */
export function visionSourceCitation(item: VisionSource): string {
  if (item.type === "guarantee") return guaranteeLine(item);
  if (item.type === "scope") return `${item.id} (${SIDE[item.side]}): ${item.text}`;
  return `${item.id} (assumption; ${ASSUMPTION_KIND_LABEL[item.kind]}${citability(item.kind)}): ${item.text}`;
}

/**
 * A guarantee as text names it: its id, where it is observed, its statement and what would refute it.
 * A guarantee read from a version written before guarantees were names no interface entry and no
 * refuting observation, and says so rather than reading as checkable.
 */
function guaranteeLine(item: Extract<VisionSource, { readonly type: "guarantee" }>): string {
  if (item.refutedBy.length === 0 || item.interface.length === 0 || item.observation === "unclassified") {
    return `${item.id} (guarantee; no interface entry or refuting observation recorded): ${item.text}`;
  }
  return (
    `${item.id} (guarantee; observed in its ${item.observation} at ${item.interface.join(", ")}): ${item.text} ` +
    `Refuted by: ${item.refutedBy.join("; ")}`
  );
}

type AssumptionSourceKind = Extract<VisionSource, { readonly type: "assumption" }>["kind"];

/** The fields of a vision item that say whether a check must decide it and whether a task may cite it. */
type CheckedFields =
  | { readonly type: "guarantee" }
  | { readonly type: "scope"; readonly side: ScopeSide }
  | { readonly type: "assumption"; readonly kind: AssumptionSourceKind };

/**
 * Whether a check must decide the item before the project is accepted: every guarantee, and no
 * assumption, which is decided through the guarantees it underpins. A scope line a plan stored
 * before guarantees were is decided unless recorded as out of scope: an unclassified side is not
 * evidence that the client did not ask for it. The one statement of this rule: the planner's coverage
 * rule and the delivered report both read it.
 */
export function checkDecides(item: CheckedFields): boolean {
  if (item.type === "guarantee") return true;
  return item.type === "scope" && item.side !== "out";
}

/**
 * Whether a deliverable or an acceptance line may cite the item: a guarantee, a scope line, and an
 * assumption not recorded as internal design, which a task cites so that a later correction of the
 * assumption finds the work resting on it. An internal-design assumption guides its implementer and
 * no line cites it; an unclassified kind is not evidence that no client could observe it.
 */
export function taskMayCite(item: CheckedFields): boolean {
  return item.type !== "assumption" || item.kind !== "internal-design";
}

function citability(kind: AssumptionSourceKind): string {
  return taskMayCite({ type: "assumption", kind }) ? "" : ", not citable";
}
