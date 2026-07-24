// Re-export from Published Language (ADR-044).
// Planning's domain code still imports from this file; the interface
// definition now lives in @ashara/shared so db can implement it
// without importing planning.
export type { ContractRepository } from "@ashara/shared";
