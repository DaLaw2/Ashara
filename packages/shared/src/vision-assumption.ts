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
 * Where an assumption stands with the client: Stated by them, or Inferred and asked about, or
 * Inferred and reported to them; "not-shown" for an Inferred record that says neither, which the
 * client has no record of seeing.
 */
type AssumptionStanding = "stated" | "asked" | "reported" | "not-shown";

export function assumptionStanding(record: { readonly status: string; readonly disclosed?: unknown }): AssumptionStanding {
  if (record.status === "Stated") return "stated";
  const disclosed = AssumptionDisclosureSchema.safeParse(record.disclosed);
  return disclosed.success ? disclosed.data : "not-shown";
}

/**
 * Where the product scaffold writes down the product's public interface, which every check author
 * and the suite review read (W5 trial 2026-10-14, W1). Ashara's own convention, the same for every
 * product; what the interface is, is the product's.
 */
export const PUBLIC_INTERFACE_FILE = "PUBLIC_INTERFACE.md";
