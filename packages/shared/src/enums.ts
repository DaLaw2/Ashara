import { z } from "zod";

export type WorkItemLevel = "Epic" | "Task";

export type WorkItemStatus = "Pending" | "InProgress" | "Completed" | "Blocked" | "Failed" | "Abandoned";

export type CapabilityLevel = "Frontier" | "Strong" | "Medium" | "Light";

/** A capability level read from outside the process: a model's answer or a stored row. */
export const CapabilityLevelSchema = z.enum(["Frontier", "Strong", "Medium", "Light"]);

/**
 * The phases a dev_sessions row can hold. Only these three are ever written, and
 * the `dev_sessions.phase` CHECK constraint (migrations/001_initial.sql) refuses
 * anything else, so a phase the code cannot produce cannot reach the DB either.
 * `Preparing` is the only non-terminal phase; a session in it after a restart is
 * a crash orphan, not a live agent.
 */
export type SessionPhase = "Preparing" | "Completed" | "Failed";

export const TERMINAL_SESSION_PHASES: readonly SessionPhase[] = ["Completed", "Failed"] as const;

// ---------------------------------------------------------------------------
// Boundary validation — parse external strings into domain types at system edges
// ---------------------------------------------------------------------------

const CAPABILITY_LEVELS: readonly CapabilityLevel[] = ["Frontier", "Strong", "Medium", "Light"] as const;
const WORK_ITEM_LEVELS: readonly WorkItemLevel[] = ["Epic", "Task"] as const;
const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
    "Pending",
    "InProgress",
    "Completed",
    "Blocked",
    "Failed",
    "Abandoned",
] as const;

export function parseCapabilityLevel(raw: string): CapabilityLevel {
    if (!(CAPABILITY_LEVELS as readonly string[]).includes(raw)) {
        throw new Error(`Invalid CapabilityLevel "${raw}". Valid: ${CAPABILITY_LEVELS.join(", ")}`);
    }
    return raw as CapabilityLevel;
}

export function parseWorkItemLevel(raw: string): WorkItemLevel {
    if (!(WORK_ITEM_LEVELS as readonly string[]).includes(raw)) {
        throw new Error(`Invalid WorkItemLevel "${raw}". Valid: ${WORK_ITEM_LEVELS.join(", ")}`);
    }
    return raw as WorkItemLevel;
}

export function parseWorkItemStatus(raw: string): WorkItemStatus {
    if (!(WORK_ITEM_STATUSES as readonly string[]).includes(raw)) {
        throw new Error(`Invalid WorkItemStatus "${raw}". Valid: ${WORK_ITEM_STATUSES.join(", ")}`);
    }
    return raw as WorkItemStatus;
}
