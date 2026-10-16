import { z } from "zod";
import { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL, ScopeSideSchema } from "./vision-assumption.js";
import type { ScopeSide } from "./vision-assumption.js";

/**
 * One item of the vision a plan derives from, as a task cites it (ADR-074 addendum 2 d71 d, d89): a
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

/**
 * Whether an assumption of this kind is one a check decides (d89 E, ADR-083): every kind but
 * internal design. An unclassified record is not evidence that no client could observe a breach, so
 * doubt lands on the side that gets a check.
 */
export function assumptionChecked(kind: AssumptionSourceKind): boolean {
  return kind !== "internal-design";
}

function citability(kind: AssumptionSourceKind): string {
  return assumptionChecked(kind) ? "" : ", not citable";
}
