import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { checkSetFreezes } from "@ashara/db";
import type { Database } from "@ashara/db";
import { checkTasksUnderReview, reviewTasksHeldBy } from "../acl/delivery-acl.js";
import { inLatestCheckRevision } from "../stored-checks.js";

// Quality's freeze of a plan revision's check set: written when
// the first task depending on the revision's review task is dispatched, with the check set the
// review read as it then stood. After it, a review of that set reopens nothing.

const FrozenReviewsSchema = z.array(z.strictObject({ reviewTaskId: z.guid() }));

export class CheckSetFreezeRepository {
  constructor(private readonly db: Database) {}

  /**
   * Freezes the check set of every review task `taskId` depends on that is not frozen yet, in one
   * statement: each of the review's check tasks, the task its checks decide, the latest revision of
   * those checks with what each decides, and the items the check task cites. Returns the review
   * tasks frozen by this call; none when the task depends on no review or each was frozen before.
   */
  async freezeFor(taskId: string): Promise<readonly string[]> {
    const result = await this.db.execute(sql`
      INSERT INTO check_set_freezes (review_task_id, project_id, frozen_by, check_set)
      SELECT review.id, review.project_id, ${taskId}::uuid,
        coalesce((
          SELECT jsonb_agg(jsonb_build_object(
              'checkTaskId', checker.id,
              'checksFor', checker.checks_for,
              'cited', checker.cited,
              'revision', latest.revision,
              'checks', (
                SELECT jsonb_agg(jsonb_build_object('name', stored.name, 'decides', stored.decides) ORDER BY stored.name)
                FROM task_checks stored
                WHERE stored.task_id = latest.task_id AND stored.revision = latest.revision
              )
            ) ORDER BY checker.created_at, checker.id)
          FROM ${checkTasksUnderReview(sql`review.id`)} checker
          LEFT JOIN LATERAL (
            SELECT stored.task_id, stored.revision
            FROM task_checks stored
            WHERE stored.task_id::text = checker.checks_for #>> '{}' AND ${inLatestCheckRevision(sql`stored.revision`, sql`stored.task_id`)}
            LIMIT 1
          ) latest ON true
        ), '[]'::jsonb)
      FROM ${reviewTasksHeldBy(sql`${taskId}::uuid`)} review
      ON CONFLICT (review_task_id) DO NOTHING
      RETURNING review_task_id AS "reviewTaskId"`);
    return FrozenReviewsSchema.parse(result.rows).map((row) => row.reviewTaskId);
  }

  /** Whether the review task's check set is frozen. */
  async frozen(reviewTaskId: string): Promise<boolean> {
    const rows = await this.db.select({ id: checkSetFreezes.reviewTaskId }).from(checkSetFreezes).where(eq(checkSetFreezes.reviewTaskId, reviewTaskId)).limit(1);
    return rows.length > 0;
  }
}
