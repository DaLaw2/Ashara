/** @testseam guarantee-verdict.test.ts types its table with them; no production caller reads them yet */
export type { Evidence, Verdict } from "./guarantee-verdict.js";
/** @testseam guarantee-verdict.test.ts judges every evidence combination through them; no production caller reads them yet */
export { EvidenceSchema, GuaranteeBasisSchema, VerdictSchema, verdictOf } from "./guarantee-verdict.js";
export { ASSUMPTION_KIND_LABEL, ASSUMPTION_STANDING_LABEL } from "./vision-assumption.js";
export type { VisionSource } from "./vision-source.js";
export { VisionSourceSchema, checkDecides, taskMayCite, visionSourceCitation, visionSourceLine } from "./vision-source.js";
export type { InterfaceEntry, VisionGuarantee } from "./guarantee.js";
export { basisOf } from "./guarantee.js";
