import { z } from "zod";

/**
 * Model Access's published tier vocabulary: the capability a model is catalogued at and a call asks
 * for. A capability level read from outside the process (a model's answer or a stored row) is parsed
 * with the schema.
 */
export const CapabilityLevelSchema = z.enum(["Frontier", "Strong", "Medium", "Light"]);

export type CapabilityLevel = z.infer<typeof CapabilityLevelSchema>;

/** A catalogued capability that names no level. */
class InvalidCapabilityLevel extends Error {
  constructor(readonly raw: unknown) {
    super(`Invalid CapabilityLevel ${JSON.stringify(raw)}. Valid: ${CapabilityLevelSchema.options.join(", ")}`);
    this.name = "InvalidCapabilityLevel";
  }
}

export function parseCapabilityLevel(raw: unknown): CapabilityLevel {
  const parsed = CapabilityLevelSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidCapabilityLevel(raw);
  return parsed.data;
}
