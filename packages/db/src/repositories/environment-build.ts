import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parseProjectId, type ProjectId } from "@ashara/shared";
import type { DbHandle } from "../connection.js";
import { environmentBuilds } from "../schema.js";

interface EnvironmentBuildColumns {
  readonly projectId: ProjectId;
  readonly version: string;
  readonly commit: string;
  readonly imageRef: string;
  readonly network: string;
  readonly logDigest: string;
}

type NewSucceededEnvironmentBuild = EnvironmentBuildColumns & { readonly imageId: string };
type NewFailedEnvironmentBuild = EnvironmentBuildColumns & { readonly error: string };

type RecordBase = EnvironmentBuildColumns & { readonly id: string; readonly createdAt: Date };
type SucceededEnvironmentBuildRecord = RecordBase & { readonly status: "succeeded"; readonly imageId: string; readonly error: null };
type EnvironmentBuildRecord =
  | SucceededEnvironmentBuildRecord
  | (RecordBase & { readonly status: "failed"; readonly imageId: null; readonly error: string });

type EnvironmentBuildRow = typeof environmentBuilds.$inferSelect;

const SucceededOutcomeSchema = z.object({
  status: z.literal("succeeded"),
  imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  error: z.null(),
});
const OutcomeSchema = z.discriminatedUnion("status", [
  SucceededOutcomeSchema,
  z.object({ status: z.literal("failed"), imageId: z.null(), error: z.string().min(1) }),
]);

const ColumnsSchema = z.object({
  version: z.string().regex(/^[0-9a-f]{64}$/),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  imageRef: z.string().min(1),
  network: z.string().min(1),
  logDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

function baseOf(row: EnvironmentBuildRow): RecordBase {
  return { id: row.id, projectId: parseProjectId(row.projectId, "environment_builds.project_id"), createdAt: row.createdAt, ...ColumnsSchema.parse(row) };
}

function outcomeColumns(row: EnvironmentBuildRow): { status: string; imageId: string | null; error: string | null } {
  return { status: row.status, imageId: row.imageId, error: row.error };
}

function toRecord(row: EnvironmentBuildRow): EnvironmentBuildRecord {
  return { ...baseOf(row), ...OutcomeSchema.parse(outcomeColumns(row)) };
}

/**
 * Execution Infrastructure's environment builds (migration 032). Implements execution-infra's
 * EnvironmentBuildRecorder; the composition root supplies it.
 */
export class EnvironmentBuildRepository {
  constructor(private readonly db: DbHandle) {}

  async findSucceeded(projectId: ProjectId, version: string): Promise<SucceededEnvironmentBuildRecord | null> {
    const [row] = await this.db
      .select()
      .from(environmentBuilds)
      .where(
        and(
          eq(environmentBuilds.projectId, projectId),
          eq(environmentBuilds.version, version),
          eq(environmentBuilds.status, "succeeded"),
        ),
      );
    return row === undefined ? null : { ...baseOf(row), ...SucceededOutcomeSchema.parse(outcomeColumns(row)) };
  }

  /** The one succeeded build of (project, version): a rebuild of the same version replaces it. */
  async recordSucceeded(build: NewSucceededEnvironmentBuild): Promise<EnvironmentBuildRecord> {
    const columns = {
      commit: build.commit,
      imageRef: build.imageRef,
      imageId: build.imageId,
      network: build.network,
      logDigest: build.logDigest,
    };
    const [row] = await this.db
      .insert(environmentBuilds)
      .values({ projectId: build.projectId, version: build.version, status: "succeeded", error: null, ...columns })
      .onConflictDoUpdate({
        target: [environmentBuilds.projectId, environmentBuilds.version],
        targetWhere: sql`status = 'succeeded'`,
        set: { ...columns, createdAt: sql`now()` },
      })
      .returning();
    return toRecord(row);
  }

  async recordFailed(build: NewFailedEnvironmentBuild): Promise<EnvironmentBuildRecord> {
    const [row] = await this.db
      .insert(environmentBuilds)
      .values({
        projectId: build.projectId,
        version: build.version,
        commit: build.commit,
        imageRef: build.imageRef,
        imageId: null,
        status: "failed",
        network: build.network,
        logDigest: build.logDigest,
        error: build.error,
      })
      .returning();
    return toRecord(row);
  }
}
