import { desc, eq, sql } from "drizzle-orm";
import { visionDocuments } from "@ashara/db";
import type { DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { visionWritable } from "../vision.js";
import type { ContractDraft } from "../vision-language/guarantee.js";
import type { VisionAppend } from "../vision.js";

type VisionRow = typeof visionDocuments.$inferSelect;

/**
 * A vision version to write as a project's next; its jsonb is held to the reader's schemas and the
 * contract's rules first. With `contract` it is written in the guarantees form, without it in the
 * scope-lines form.
 */
type NewVision = {
  readonly visionText: string;
  readonly summary: string;
  readonly inferences?: readonly unknown[];
  readonly openQuestions?: readonly unknown[];
  readonly changeReason?: string;
} & (
  | { readonly scopeBoundaries?: readonly unknown[]; readonly contract?: never }
  | { readonly contract: ContractDraft; readonly scopeBoundaries?: never }
);

/** The INSERT of a vision version returned no row. */
class VisionNotWritten extends Error {
  constructor(readonly projectId: ProjectId) {
    super(`the vision version insert for project ${projectId} returned no row`);
    this.name = "VisionNotWritten";
  }
}

/** Engagement's vision versions (vision_documents): append-only, one version per row. */
export class VisionRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * Appends the project's next vision version (its first is 1). The version is
   * computed in the INSERT itself; two racing writers that compute the same
   * number fail on UNIQUE (project_id, version) rather than sharing it.
   */
  async create(projectId: ProjectId, doc: NewVision): Promise<VisionRow> {
    // eslint-disable-next-line no-restricted-syntax -- policy default: a caller that omits these lists writes a vision that has none; the write states what it was given
    const fields = { scopeBoundaries: doc.scopeBoundaries ?? [], inferences: doc.inferences ?? [], openQuestions: doc.openQuestions ?? [] };
    const contract =
      doc.contract === undefined
        ? { form: "scope-lines", interface: [], guarantees: [], exclusions: [] }
        : { form: "guarantees", ...doc.contract };
    const columns = visionWritable(projectId, { visionText: doc.visionText, ...fields, contract });
    const [row] = await this.db
      .insert(visionDocuments)
      .values({
        projectId,
        visionText: doc.visionText,
        summary: doc.summary,
        ...fields,
        ...columns,
        changeReason: doc.changeReason ?? null,
        version: sql`(SELECT COALESCE(MAX(version), 0) + 1 FROM vision_documents WHERE project_id = ${projectId})`,
      })
      .returning();
    if (row === undefined) throw new VisionNotWritten(projectId);
    return row;
  }

  /** The project's highest vision version, or null when the project has none. */
  async getCurrent(projectId: ProjectId): Promise<VisionRow | null> {
    const [row] = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.projectId, projectId))
      .orderBy(desc(visionDocuments.version))
      .limit(1);
    return row ?? null;
  }

  /**
   * Appends the version after `change.basedOnVersion`, a copy of it with the change's assumptions,
   * open questions and reason. "moved", with nothing written, when the project's current version is
   * not the one the change was composed against.
   */
  async append(
    projectId: ProjectId,
    change: VisionAppend,
  ): Promise<{ readonly kind: "appended" } | { readonly kind: "moved"; readonly current: number | null }> {
    const current = await this.getCurrent(projectId);
    if (current === null || current.version !== change.basedOnVersion) return { kind: "moved", current: current?.version ?? null };
    const fields = { scopeBoundaries: current.scopeBoundaries, inferences: change.inferences, openQuestions: change.openQuestions };
    const columns = visionWritable(projectId, {
      visionText: current.visionText,
      ...fields,
      contract: { form: current.contractForm, interface: current.interface, guarantees: current.guarantees, exclusions: current.exclusions },
    });
    await this.db.insert(visionDocuments).values({
      projectId,
      version: current.version + 1,
      visionText: current.visionText,
      summary: current.summary,
      ...fields,
      ...columns,
      confirmedDirections: current.confirmedDirections,
      changeReason: change.changeReason,
    });
    return { kind: "appended" };
  }
}
