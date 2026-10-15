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
    standing: z.enum(["stated", "asked", "reported", "not-shown"]),
    kind: z.enum(["client-visible", "internal-design", "unclassified"]),
  }),
]);

export type VisionSource = z.infer<typeof VisionSourceSchema>;

const SIDE: Readonly<Record<ScopeSide, string>> = { in: "in scope", out: "out of scope", unclassified: "scope" };

/** A vision item as the plan's prompts and descriptions name it: its id, what it is, and its text. */
export function visionSourceLine(item: VisionSource): string {
  if (item.type === "scope") return `${item.id} (${SIDE[item.side]}): ${item.text}`;
  const citability = item.kind === "client-visible" ? "" : ", not citable";
  return `${item.id} (assumption; ${ASSUMPTION_STANDING_LABEL[item.standing]}; ${ASSUMPTION_KIND_LABEL[item.kind]}${citability}): ${item.text}`;
}
