import { z } from "zod";
import { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL, ScopeSideSchema } from "./vision-assumption.js";
import type { ScopeSide } from "./vision-assumption.js";

/**
 * One item of the vision a plan derives from, as a task cites it: a
 * scope line (S1..) with its side, or an assumption, by its key, with its status, what the client has
 * seen of it and its kind. `id` is the item's id in the vision version the plan was decomposed from.
 * A scope source stored before sides were recorded reads as "unclassified".
 */
export const VisionSourceSchema = z.discriminatedUnion("type", [
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
  if (item.type === "scope") return `${item.id} (${SIDE[item.side]}): ${item.text}`;
  return `${item.id} (assumption; ${ASSUMPTION_KIND_LABEL[item.kind]}${citability(item.kind)}): ${item.text}`;
}

type AssumptionSourceKind = Extract<VisionSource, { readonly type: "assumption" }>["kind"];

/** The fields of a vision item that decide whether a check must decide it. */
type CheckedFields = { readonly type: "scope"; readonly side: ScopeSide } | { readonly type: "assumption"; readonly kind: AssumptionSourceKind };

/**
 * Whether a check must decide the item before the project is accepted: every scope
 * line not recorded as out of scope, and every assumption not recorded as internal design. An
 * unclassified side or kind is not evidence that the client did not ask for it or could not observe
 * a breach of it, so doubt lands on the side that gets a check. The one statement of this rule: the
 * planner's coverage rule, the delivered report and the citable label all read it.
 */
export function checkDecides(item: CheckedFields): boolean {
  return item.type === "scope" ? item.side !== "out" : item.kind !== "internal-design";
}

function citability(kind: AssumptionSourceKind): string {
  return checkDecides({ type: "assumption", kind }) ? "" : ", not citable";
}
