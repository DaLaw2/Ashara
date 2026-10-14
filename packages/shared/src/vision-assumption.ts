import { z } from "zod";

// Published Language of the vision's assumptions (vision_documents.inferences), as Engagement
// writes them and Delivery, Quality and Workplace read them (ADR-074 addendum 2 d89).

/**
 * What an assumption is about (d89 E): behaviour the client sees and relies on (an output, an
 * error, what survives a crash), or a choice of how the team builds it (a file name, a lock
 * mechanism). Only a client-visible one may be the source of an acceptance line.
 */
export const AssumptionKindSchema = z.enum(["client-visible", "internal-design"]);

export type AssumptionKind = z.infer<typeof AssumptionKindSchema>;

/**
 * An assumption's kind as a stored record holds it. A record written before kinds were recorded
 * holds none and reads as "unclassified": not evidence that it is client-visible, so no acceptance
 * line may cite it.
 */
export const StoredAssumptionKindSchema = AssumptionKindSchema.optional().transform(
  (kind): AssumptionKind | "unclassified" => kind ?? "unclassified",
);

/**
 * How the client learned of an Inferred assumption (d89 C): asked about it in an intake question,
 * or told of it in a report that work proceeds on it unless they object.
 */
const AssumptionDisclosureSchema = z.enum(["asked", "reported"]);

export type AssumptionDisclosure = z.infer<typeof AssumptionDisclosureSchema>;

/**
 * An assumption's disclosure as a stored record holds it: absent on a record that says neither
 * (written before disclosures were recorded), and otherwise one of the two. Any other value fails
 * the record's parse, so a malformed disclosure is never read as "never shown".
 */
export const StoredAssumptionDisclosureSchema = AssumptionDisclosureSchema.optional();

/**
 * Where an assumption stands with the client: Stated by them, or Inferred and asked about, or
 * Inferred and reported to them; "not-shown" for an Inferred record that says neither, which the
 * client has no record of seeing.
 */
export type AssumptionStanding = "stated" | "asked" | "reported" | "not-shown";

export function assumptionStanding(record: { readonly status: string; readonly disclosed?: AssumptionDisclosure }): AssumptionStanding {
  if (record.status === "Stated") return "stated";
  return record.disclosed ?? "not-shown";
}

/**
 * The one wording of an assumption's standing and kind in Ashara's own prompts (a planner's vision
 * items, a check author's and a reviewer's, an agent's brief): what the record says, nothing beyond.
 */
export const ASSUMPTION_STANDING_LABEL: Readonly<Record<AssumptionStanding, string>> = {
  stated: "Stated by the client",
  asked: "Inferred; asked of the client, not yet answered",
  reported: "Inferred; reported to the client",
  "not-shown": "Inferred; never shown to the client",
};

export const ASSUMPTION_KIND_LABEL: Readonly<Record<AssumptionKind | "unclassified", string>> = {
  "client-visible": "client-visible behaviour",
  "internal-design": "internal design",
  unclassified: "not classified",
};

/**
 * Which side of the vision's scope a scope line is on (W11c D3): what the client asked for, or what
 * the tender explicitly leaves out. A line written before sides were recorded reads as
 * "unclassified": not evidence that it is out of scope.
 */
export const ScopeSideSchema = z.enum(["in", "out", "unclassified"]);

export type ScopeSide = z.infer<typeof ScopeSideSchema>;

/** A scope line as intake writes it into vision_documents.scope_boundaries. */
export interface ScopeLine {
  readonly text: string;
  readonly side: Exclude<ScopeSide, "unclassified">;
}

/** A stored scope line: an object with its side, or a bare string written before sides were recorded. */
export const StoredScopeLineSchema = z.union([
  z.strictObject({ text: z.string().min(1), side: z.enum(["in", "out"]) }),
  z
    .string()
    .min(1)
    .transform((text): { readonly text: string; readonly side: ScopeSide } => ({ text, side: "unclassified" })),
]);

/**
 * Where the product scaffold writes down the product's public interface, which every check author
 * and the suite review read (W5 trial 2026-10-14, W1). Ashara's own convention, the same for every
 * product; what the interface is, is the product's.
 */
export const PUBLIC_INTERFACE_FILE = "PUBLIC_INTERFACE.md";
