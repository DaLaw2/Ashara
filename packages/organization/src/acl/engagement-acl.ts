import { VisionUnreadable, readVisionVersion } from "@ashara/engagement";
import { parseStoredVision } from "@ashara/engagement/vision";

// Organization reads the client's vision only as Engagement's published VisionVersion,
// through this file.

export { VisionUnreadable };

/** The vision as roster derivation reads it: the tender verbatim and each assumption in a line. */
export interface RosterVision {
  readonly version: number;
  readonly visionText: string;
  readonly assumptions: readonly string[];
}

/**
 * The stored vision, as the roster repository selected it, read for roster derivation; throws
 * VisionUnreadable, the project's own record, and a selection that is no stored vision version.
 */
export function rosterVisionOf(projectId: string, stored: unknown): RosterVision {
  const vision = readVisionVersion(parseStoredVision(projectId, stored));
  return {
    version: vision.version,
    visionText: vision.visionText,
    assumptions: vision.assumptions.map((a) => (a.status === null ? a.statement : `${a.statement} (${a.status})`)),
  };
}
