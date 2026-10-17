/**
 * The judged verdict scripts/hidden-suite.ts writes and scripts/run-report.ts reads back: one shape, so the reader
 * parses exactly what the writer produces. Overall is checked against the guarantees and the run's problems, so a
 * file edited to read pass over a failed guarantee or an incomplete run does not parse.
 */

import { z } from "zod";

export const guaranteeIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "a guarantee id is letters, digits, '.', '_' or '-'");

export const guaranteeVerdictSchema = z.enum(["pass", "fail", "unjudged"]);

export const evidenceSchema = z.object({ case: z.string(), observed: z.string() });

export const overallSchema = z.enum(["pass", "fail", "incomplete"]);
export type Overall = z.infer<typeof overallSchema>;

const judgedGuaranteeSchema = z
  .object({
    id: guaranteeIdSchema,
    verdict: guaranteeVerdictSchema,
    cases: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    /** Set when the verdict is unjudged. */
    reason: z.string().min(1).optional(),
    /** The cases the suite reported, when it reported any. */
    evidence: z.array(evidenceSchema).readonly().optional(),
  })
  .readonly()
  .refine((entry) => entry.verdict !== "unjudged" || entry.reason !== undefined, "an unjudged guarantee carries its reason");
export type JudgedGuarantee = z.infer<typeof judgedGuaranteeSchema>;

const runRecordSchema = z.object({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  statusLost: z.boolean(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** What overall must be for these guarantees and problems: the rule hidden-suite judges by. */
export function overallOf(guarantees: readonly JudgedGuarantee[], problems: readonly string[]): Overall {
  if (problems.length > 0) return "incomplete";
  if (guarantees.some((entry) => entry.verdict === "fail")) return "fail";
  return guarantees.length > 0 && guarantees.every((entry) => entry.verdict === "pass") ? "pass" : "incomplete";
}

export const judgedVerdictSchema = z
  .object({
    tender: z.string().min(1),
    suiteDigest: z.string().min(1),
    product: z.object({ dir: z.string().min(1), digest: z.string().min(1) }),
    image: z.string().min(1),
    suiteArgs: z.array(z.string()).readonly(),
    timeoutSeconds: z.number().int().positive(),
    startedAt: z.string().min(1),
    endedAt: z.string().min(1),
    overall: overallSchema,
    guarantees: z
      .array(judgedGuaranteeSchema)
      .readonly()
      .refine((entries) => entries.length > 0, "the verdict judges no guarantee")
      .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "guarantee ids must be unique"),
    problems: z.array(z.string()).readonly(),
    runs: z.record(z.string(), runRecordSchema),
  })
  .refine((record) => record.overall === overallOf(record.guarantees, record.problems), {
    message: "overall does not follow from the guarantees and the problems",
    path: ["overall"],
  });
export type JudgedVerdict = z.infer<typeof judgedVerdictSchema>;
