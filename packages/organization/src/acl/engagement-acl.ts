import { VisionUnreadable, readVisionVersion } from "@ashara/engagement";
import type { StoredVision } from "@ashara/engagement";

// Organization reads the client's vision only as Engagement's published VisionVersion (ADR-075 §6,
// S7, S8), through this file.

export { VisionUnreadable };
export type { StoredVision };

/** The vision as roster derivation reads it: the tender verbatim and each assumption in a line. */
export interface RosterVision {
  readonly version: number;
  readonly visionText: string;
  readonly assumptions: readonly string[];
}

/** The stored vision read for roster derivation; throws VisionUnreadable, the project's own record. */
export function rosterVisionOf(stored: StoredVision): RosterVision {
  const vision = readVisionVersion(stored);
  return {
    version: vision.version,
    visionText: vision.visionText,
    assumptions: vision.assumptions.map((a) => (a.status === null ? a.statement : `${a.statement} (${a.status})`)),
  };
}
