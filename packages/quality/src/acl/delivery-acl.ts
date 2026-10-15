/**
 * Anti-Corruption Layer: Delivery's work-item language (ADR-075).
 *
 * Quality decides the work Delivery hands it and reads the task specification Delivery wrote:
 * what a check task checks, the vision items it traces to, where a task came from. It reads them
 * here, from Delivery's published-language entry alone, never Delivery's services, which call Quality.
 */

export type { StoredTaskSpec } from "@ashara/delivery/work-item";
export { parseWorkItemJsonb } from "@ashara/delivery/work-item";
