import { z } from "zod";

export type WorkItemLevel = "Epic" | "Task";

/**
 * Every status a work item can hold; the type is derived from it so the list cannot fall behind.
 * @testseam db lifecycle-lists.test.ts compares it with the CHECK constraint; the lifecycle model of story s-independent-verify-m1 L2 is its consumer
 */
export const WORK_ITEM_STATUSES = ["Pending", "InProgress", "Completed", "Blocked", "Failed", "Abandoned"] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * Every status a project can hold: the `projects_status_known` CHECK constraint
 * (migrations/028_project_client_stop.sql) admits exactly these.
 * @testseam db lifecycle-lists.test.ts compares it with the CHECK constraint; the lifecycle model of story s-independent-verify-m1 L2 is its consumer
 */
export const PROJECT_STATUSES = ["active", "blocked", "stopped"] as const;

/**
 * Every typed end a Workplace attempt can record on its dev_sessions row: the Outcome kind, with a
 * finished attempt's status. The `attempt_terminal` CHECK (migrations/046_dev_session_attempt_evidence.sql)
 * admits exactly these; db's lifecycle-lists.test.ts compares the two.
 */
export const ATTEMPT_TERMINALS = [
  "finished:done",
  "finished:blocked",
  "disputed",
  "model_stopped_without_finish",
  "turn_cap",
  "wall_clock",
  "transport_exhausted",
  "refused",
  "environment_failure",
  "cancelled",
] as const;

export type AttemptTerminal = (typeof ATTEMPT_TERMINALS)[number];

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
