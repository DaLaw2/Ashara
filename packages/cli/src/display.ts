// ---------------------------------------------------------------------------
// Live status display — polls the Rust server and renders work item state
// ---------------------------------------------------------------------------

import type { AsharaClient, SessionInfo, WorkItem } from "./client.js";

export const POLL_INTERVAL_MS = 5_000;

// Idle-since-last-progress bound, not wall-clock-since-start (Run 8 G6/R8-F5:
// a healthy 15-40min build was scored FAILED at 600s because the old timeout
// measured elapsed time since monitor start, which never resets even while
// items complete every cycle). Default floor is 15 minutes of true idle.
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function loadIdleTimeoutMs(): number {
    const raw = process.env["ASHARA_MONITOR_IDLE_TIMEOUT_MS"];
    if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Fingerprint of observable work-item progress: any status transition on any item, or any change in the item set, changes this string. */
function progressSignature(items: WorkItem[]): string {
    return items
        .map((i) => `${i.id}:${i.status}`)
        .sort()
        .join(",");
}

export async function monitorProgress(client: AsharaClient): Promise<boolean> {
    const idleTimeoutMs = loadIdleTimeoutMs();
    const startTime = Date.now();
    let lastProgressTime = startTime;
    let lastSignature: string | null = null;

    for (;;) {
        const idleMs = Date.now() - lastProgressTime;
        if (idleMs > idleTimeoutMs) {
            console.error(
                `[monitor] timeout: no work-item state change observed for ${(idleMs / 1000).toFixed(0)}s ` +
                    `(bound ${(idleTimeoutMs / 1000).toFixed(0)}s, set via ASHARA_MONITOR_IDLE_TIMEOUT_MS), exiting`,
            );
            return false;
        }

        let items: WorkItem[];
        let sessions: SessionInfo[];
        try {
            items = await client.listWorkItems();
            sessions = await client.listSessions();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[ashara] Error polling server: ${message}`);
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        const signature = progressSignature(items);
        if (lastSignature === null || signature !== lastSignature) {
            lastSignature = signature;
            lastProgressTime = Date.now();
        }

        displayStatus(items, sessions, startTime);

        if (items.length === 0) {
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        const allDone = items.every(
            (i) => i.status === "Completed" || i.status === "Blocked" || i.status === "Failed",
        );

        if (allDone) {
            const anyFailed = items.some((i) => i.status === "Blocked" || i.status === "Failed");
            if (anyFailed) {
                console.log("\n[ashara] Some tasks blocked or failed. See above for details.");
                return false;
            }
            console.log("\n[ashara] All tasks completed successfully!");
            return true;
        }

        await sleep(POLL_INTERVAL_MS);
    }
}

function displayStatus(items: WorkItem[], sessions: SessionInfo[], startTime: number): void {
    console.clear();
    console.log("Ashara -- Execution Status\n");

    if (items.length === 0) {
        console.log("  (no work items yet)");
    }

    // Group by level for structured display
    const epics = items.filter((i) => i.level === "Epic");
    const tasks = items.filter((i) => i.level === "Task");

    for (const epic of epics) {
        console.log(`  ${statusIcon(epic.status)} [Epic] ${epic.title} -- ${epic.status}`);

        const childTasks = tasks.filter((t) => t.parentId === epic.id);
        for (const task of childTasks) {
            console.log(`    ${statusIcon(task.status)} [Task] ${task.title} -- ${task.status}`);
        }
    }

    // Orphan items (no parent or parent not in the list)
    const knownIds = new Set(items.map((i) => i.id));
    const orphans = items.filter(
        (i) => i.level !== "Epic" && (i.parentId === null || !knownIds.has(i.parentId)),
    );
    for (const item of orphans) {
        console.log(`  ${statusIcon(item.status)} [${item.level}] ${item.title} -- ${item.status}`);
    }

    // Sessions
    if (sessions.length > 0) {
        console.log("\nActive sessions:");
        for (const session of sessions) {
            console.log(`  [${session.phase}] ${session.brief.goal}`);
        }
    }

    // Summary counters
    const completed = items.filter((i) => i.status === "Completed").length;
    const inProgress = items.filter((i) => i.status === "InProgress").length;
    const blocked = items.filter((i) => i.status === "Blocked").length;
    const failed = items.filter((i) => i.status === "Failed").length;
    const pending = items.filter((i) => i.status === "Pending").length;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(
        `\nProgress: ${completed}/${items.length} done | ${inProgress} active | ${blocked} blocked | ${failed} failed | ${pending} pending`,
    );
    console.log(`Elapsed: ${elapsed}s`);
}

function statusIcon(status: string): string {
    switch (status) {
        case "Completed":
            return "[done]";
        case "InProgress":
            return "[ >> ]";
        case "Blocked":
            return "[blkd]";
        case "Failed":
            return "[FAIL]";
        case "Abandoned":
            return "[abnd]";
        case "Pending":
            return "[    ]";
        default:
            return "[    ]";
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
