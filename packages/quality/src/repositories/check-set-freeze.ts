import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { checkSetFreezes, workItems } from "@ashara/db";
import type { Database } from "@ashara/db";
import { reviewTask } from "../acl/delivery-acl.js";

// Quality's freeze of a plan revision's check set: written when
// the first task depending on the revision's review task is dispatched, with the check set the
// review read as it then stood. After it, a review of that set reopens nothing.

/** The review tasks a dispatched task depends on. */
const review = alias(workItems, "review");

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
              'checksFor', checker.task_spec->'checksFor',
              'cited', checker.task_spec->'sources',
              'revision', latest.revision,
              'checks', (
                SELECT jsonb_agg(jsonb_build_object('name', stored.name, 'decides', stored.decides) ORDER BY stored.name)
                FROM task_checks stored
                WHERE stored.task_id = latest.task_id AND stored.revision = latest.revision
              )
            ) ORDER BY checker.created_at, checker.id)
          FROM dependencies under_review
          JOIN work_items checker ON checker.id = under_review.to_id
          LEFT JOIN LATERAL (
            SELECT stored.task_id, max(stored.revision) AS revision
            FROM task_checks stored
            WHERE stored.task_id::text = checker.task_spec->>'checksFor'
            GROUP BY stored.task_id
          ) latest ON true
          WHERE under_review.from_id = review.id AND checker.work_kind = 'check'
        ), '[]'::jsonb)
      FROM dependencies held
      JOIN work_items review ON review.id = held.to_id
      WHERE held.from_id = ${taskId}::uuid AND ${reviewTask(review)}
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
