/**
 * Anti-Corruption Layer: Finance (ADR-075).
 *
 * Outside dispatch/, Delivery reads Finance only here: the guarded model port its planning calls go
 * through, and the refusals a call can meet before it is sent, a spend cap's among them.
 */

export type { ContextualLlm } from "@ashara/finance";
export { BudgetExceeded, PreCallRefusal } from "@ashara/finance";
