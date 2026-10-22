import { z } from "zod";

// The vocabulary of the vision's assumptions every context words them in.
// Reading the stored records is Engagement's alone: its published reader is readVisionVersion.

/**
 * What an assumption is about, as the vision records it: behaviour the client could observe
 * (an output, an error, an exit status, the data the client stores), or a choice of how the team
 * builds it whose breach no client could observe. Only a client-visible one may be cited by a task,
 * and every one is, and is decided by a stored check.
 */
export const AssumptionKindSchema = z.enum(["client-visible", "internal-design"]);

export type AssumptionKind = z.infer<typeof AssumptionKindSchema>;

/**
 * An assumption's kind as a model classifies it: "undecided" is a value the model may
 * give, and it is recorded as client-visible, so doubt always lands on the side that gets a check.
 * Every model-facing schema that classifies an assumption uses this one.
 */
export const ClassifiedAssumptionKindSchema = z
  .enum(["client-visible", "internal-design", "undecided"])
  .transform((kind): AssumptionKind => (kind === "undecided" ? "client-visible" : kind));

/** What the client reads before a question's assumption; the statement itself never carries it. */
export const ASSUMPTION_LABEL = "Until you answer, we proceed on this assumption:";

/**
 * The classification rule every prompt that asks a model for an assumption's kind states, worded
 * once: a breach the client could observe makes it client-visible, doubt is "undecided"
 * and gets a check, and internal design is left only for what no client could observe. It names
 * kinds of observation, never a technology, a file type or a keyword.
 */
export const ASSUMPTION_KIND_RULE: readonly string[] = [
  `  - "client-visible": the client could observe it being broken: in what the deliverable outputs, in`,
  `    how it reports errors, in its exit status, or in the data the client stores with it (what is kept,`,
  `    lost, changed or still readable after a failure). Which inputs it accepts or refuses, and what`,
  `    still holds after a crash or a damaged input, are client-visible. The client's acceptance tests`,
  `    check it.`,
  `  - "internal-design": how the team builds it, and only when no client could observe a breach of it`,
  `    in any of those ways, such as the name of an internal file. It guides the work and is never`,
  `    checked. An assumption that itself states what the client sees, or what happens to their data,`,
  `    is not internal design even when another assumption states something close to it: each one a`,
  `    client could see broken gets its own check.`,
  `  - "undecided": you cannot tell whether a client could observe a breach. It is recorded as`,
  `    client-visible and checked.`,
  `  Ask, for each one: if the deliverable broke this, could the client see it in output, errors,`,
  `  exit status or their stored data? Yes or unsure means it is not internal design.`,
];

/**
 * How the client learned of an Inferred assumption: asked about it in an intake question,
 * or told of it in a report that work proceeds on it unless they object.
 */
const AssumptionDisclosureSchema = z.enum(["asked", "reported"]);

export type AssumptionDisclosure = z.infer<typeof AssumptionDisclosureSchema>;

/**
 * Where an assumption stands with the client: Stated by them, or Inferred and asked about, or
 * Inferred and reported to them; "unrecorded" for an Inferred record that says neither. Every writer
 * records how the client learned of an Inferred assumption, so a record without it was written
 * before disclosures were: whether the client saw it is not on record, which is not evidence that
 * they never did.
 */
export type AssumptionStanding = "stated" | "asked" | "reported" | "unrecorded";

/**
 * The one wording of an assumption's standing and kind in Ashara's own prompts (a planner's vision
 * items, a check author's and a reviewer's, an agent's brief): what the record says, nothing beyond.
 */
export const ASSUMPTION_STANDING_LABEL: Readonly<Record<AssumptionStanding, string>> = {
  stated: "Stated by the client",
  asked: "Inferred; asked of the client, not yet answered",
  reported: "Inferred; reported to the client",
  unrecorded: "Inferred; whether the client was shown it is not on record",
};

export const ASSUMPTION_KIND_LABEL: Readonly<Record<AssumptionKind | "unclassified", string>> = {
  "client-visible": "client-visible behaviour",
  "internal-design": "internal design",
  unclassified: "not classified",
};

/**
 * Which side of the vision's scope a scope line is on: what the client asked for, or what
 * the tender explicitly leaves out. A line written before sides were recorded reads as
 * "unclassified": not evidence that it is out of scope.
 */
export const ScopeSideSchema = z.enum(["in", "out", "unclassified"]);

export type ScopeSide = z.infer<typeof ScopeSideSchema>;
