export type { Evidence, EvidenceClass, FaultSet, UnjudgedReason, Verdict } from "./guarantee-verdict.js";
export { CheckEvidenceSchema, verdictOf } from "./guarantee-verdict.js";
export { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL } from "./vision-assumption.js";
export type { VisionSource } from "./vision-source.js";
export { VisionSourceSchema, checkDecides, taskMayCite, visionSourceCitation, visionSourceLine } from "./vision-source.js";
export type { InterfaceEntry, VisionGuarantee } from "./guarantee.js";
export { basisOf } from "./guarantee.js";
