import { eq } from "drizzle-orm";
import type { RunState } from "@ashara/shared";
import { parseRunState, serializeRunState } from "@ashara/shared";
import type { Database } from "../connection.js";
import { systemSettings } from "../schema.js";

const RUN_STATE_KEY = "orchestrator.run_state";

/**
 * The one durable home of the per-run cap counters (budget spend, acceptance
 * attempts). Stored as a single system_settings row so the whole record is
 * written atomically — a half-updated run record is a wrong cap.
 */
export class RunStateRepository {
  constructor(private readonly db: Database) {}

  /**
   * `null` means no run has ever been recorded. A row that exists but does not
   * parse THROWS (see parseRunState) — degrading it to `null` would read as "no
   * run in progress" and reset a live budget to zero.
   */
  async load(): Promise<RunState | null> {
    const rows = await this.db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, RUN_STATE_KEY));

    const row = rows[0];
    if (!row) return null;
    return parseRunState(row.value);
  }

  async save(state: RunState): Promise<void> {
    const value = serializeRunState(state);
    await this.db
      .insert(systemSettings)
      .values({ key: RUN_STATE_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }
}
