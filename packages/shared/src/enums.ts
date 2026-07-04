export type WorkItemLevel = "Epic" | "Story" | "Feature" | "Task";

export type WorkItemStatus = "Pending" | "InProgress" | "Completed" | "Blocked" | "Failed" | "Archived" | "Abandoned";

export type CapabilityLevel = "Frontier" | "Strong" | "Medium" | "Light";

// ---------------------------------------------------------------------------
// Boundary validation — parse external strings into domain types at system edges
// ---------------------------------------------------------------------------

const CAPABILITY_LEVELS: readonly CapabilityLevel[] = ["Frontier", "Strong", "Medium", "Light"] as const;
const WORK_ITEM_LEVELS: readonly WorkItemLevel[] = ["Epic", "Story", "Feature", "Task"] as const;
const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
    "Pending",
    "InProgress",
    "Completed",
    "Blocked",
    "Failed",
    "Archived",
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
