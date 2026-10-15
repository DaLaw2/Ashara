import type { CapabilityLevel } from "./capability-level.js";

export const CAPABILITY_RANK: Record<CapabilityLevel, number> = {
  Light: 0,
  Medium: 1,
  Strong: 2,
  Frontier: 3,
};
