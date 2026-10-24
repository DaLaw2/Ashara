import { and, desc, eq, sql } from "drizzle-orm";
import { visionDocuments, visionRevisions } from "@ashara/db/schema/engagement";
import type { DbHandle } from "@ashara/db";
import type { ProjectId } from "@ashara/shared";
import { Vision, readVisionVersion, visionWritable } from "../vision.js";
import type { Direction, RevisionOp, RevisionRecord } from "../vision-language/contract-op.js";
import type { ContractDraft, VisionGuarantee } from "../vision-language/guarantee.js";
import type { PlannedAssumption } from "../vision-language/vision-assumption.js";
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

/** A proposed revision to apply was not found pending for the project. */
class ProposalNotPending extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly proposalId: string,
  ) {
    super(`revision ${proposalId} of project ${projectId} is not a proposal awaiting confirmation; nothing was written`);
    this.name = "ProposalNotPending";
  }
}

/** The columns every revision row records of its record. */
function revisionColumns(projectId: ProjectId, basedOnVersion: number, record: RevisionRecord) {
  return {
    projectId,
    basedOnVersion,
    author: record.author,
    approver: record.approver,
    direction: record.direction,
    cause: record.cause,
    sourceMessageId: record.sourceMessageId,
    ops: record.ops,
    pushback: record.pushback,
  };
}

/**
 * Engagement's vision versions (vision_documents): append-only, one version per row. Every version
 * after the first is written with its revision record (vision_revisions) in the same transaction.
 */
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
    const columns = visionWritable(projectId, { visionText: doc.visionText, ...fields, contract }, "first");
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
   * open questions, contract and reason, and records `revision` as the revision that wrote it, applied.
   * "moved", with nothing written, when the project's current version is not the one the change was
   * composed against. Call it inside a transaction: the version and its record are one write.
   */
  async append(
    projectId: ProjectId,
    change: VisionAppend,
    revision: RevisionRecord,
  ): Promise<{ readonly kind: "appended"; readonly version: number } | { readonly kind: "moved"; readonly current: number | null }> {
    const version = await this.appendVersion(projectId, change);
    if (version.kind === "moved") return version;
    await this.db.insert(visionRevisions).values({ ...revisionColumns(projectId, change.basedOnVersion, revision), version: version.version, status: "applied" });
    return version;
  }

  /** Records a revision awaiting the client's confirmation against the version in force; no version is written. */
  async propose(projectId: ProjectId, basedOnVersion: number, revision: RevisionRecord): Promise<void> {
    await this.db.insert(visionRevisions).values({ ...revisionColumns(projectId, basedOnVersion, revision), version: null, status: "proposed" });
  }

  /**
   * Applies a pending proposal the client confirmed in `confirmedBy`: appends its version and records
   * it applied, approved by the client, with the operations as applied. Throws ProposalNotPending when
   * the proposal is not pending; "moved" as append.
   */
  async applyProposal(
    projectId: ProjectId,
    proposalId: string,
    confirmedBy: string,
    change: VisionAppend,
    applied: { readonly ops: readonly [RevisionOp, ...RevisionOp[]]; readonly direction: Direction },
  ): Promise<{ readonly kind: "appended"; readonly version: number } | { readonly kind: "moved"; readonly current: number | null }> {
    const version = await this.appendVersion(projectId, change);
    if (version.kind === "moved") return version;
    const updated = await this.db
      .update(visionRevisions)
      .set({ status: "applied", version: version.version, approver: "client", confirmedByMessageId: confirmedBy, ops: applied.ops, direction: applied.direction })
      .where(and(eq(visionRevisions.id, proposalId), eq(visionRevisions.projectId, projectId), eq(visionRevisions.status, "proposed")))
      .returning({ id: visionRevisions.id });
    if (updated.length === 0) throw new ProposalNotPending(projectId, proposalId);
    return version;
  }

  private async appendVersion(
    projectId: ProjectId,
    change: VisionAppend,
  ): Promise<{ readonly kind: "appended"; readonly version: number } | { readonly kind: "moved"; readonly current: number | null }> {
    const current = await this.getCurrent(projectId);
    if (current === null || current.version !== change.basedOnVersion) return { kind: "moved", current: current?.version ?? null };
    const fields = { scopeBoundaries: current.scopeBoundaries, inferences: change.inferences, openQuestions: change.openQuestions };
    const contract =
      change.contract.kind === "revised"
        ? { form: "guarantees", ...change.contract.records }
        : { form: current.contractForm, interface: current.interface, guarantees: current.guarantees, exclusions: current.exclusions };
    const columns = visionWritable(projectId, { visionText: current.visionText, ...fields, contract }, "next");
    const version = current.version + 1;
    await this.db.insert(visionDocuments).values({
      projectId,
      version,
      visionText: current.visionText,
      summary: current.summary,
      ...fields,
      ...columns,
      confirmedDirections: current.confirmedDirections,
      changeReason: change.changeReason,
    });
    return { kind: "appended", version };
  }
}

/**
 * The guarantees of the project's current vision version, in its order, as every reader of the vision
 * reads them (a version written before guarantees reads its legacy ones); none when the project has
 * no vision. Throws VisionUnreadable when the version does not read.
 */
export async function guaranteesInForce(
  db: DbHandle,
  projectId: ProjectId,
): Promise<{ readonly kind: "none" } | { readonly kind: "version"; readonly version: number; readonly guarantees: readonly VisionGuarantee[] }> {
  const current = await new VisionRepository(db).getCurrent(projectId);
  if (current === null) return { kind: "none" };
  const vision = readVisionVersion(current);
  return { kind: "version", version: vision.version, guarantees: vision.guarantees };
}

/** The behaviour a plan adds could not be recorded on the contract as the plan cites it; nothing of the plan is written. */
class PlannedBehaviourUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly planRevision: number,
    readonly detail: string,
  ) {
    super(`plan revision ${planRevision} of project ${projectId}: the behaviour it adds cannot be recorded as assumptions of the contract: ${detail}`);
    this.name = "PlannedBehaviourUnrecorded";
  }
}

/**
 * Records the behaviour a plan adds beyond what the contract states as Inferred client-visible
 * assumptions of the next vision version, written by Ashara and applied unapproved, inside the
 * plan's own transaction (the caller holds the project row locked), so no task resting on one is
 * written without it. Each takes the key the plan's tasks already cite (plannedBehaviourKeys on the
 * version planned from); a version that moved since gives other keys, and the plan is not written.
 * The direction is neutral: an Inferred assumption changes no guarantee's terms, and the plan's
 * report tells the client of each before any task resting on it is dispatched.
 */
export async function recordPlannedBehaviour(
  tx: DbHandle,
  write: { readonly projectId: ProjectId; readonly planRevision: number; readonly planned: readonly [PlannedAssumption, ...PlannedAssumption[]] },
): Promise<void> {
  const { projectId, planRevision, planned } = write;
  const repository = new VisionRepository(tx);
  const current = await repository.getCurrent(projectId);
  if (current === null) throw new PlannedBehaviourUnrecorded(projectId, planRevision, "the project has no vision");
  const [first, ...rest] = planned;
  const rationale = `The team's plan (revision ${planRevision}) adds this behaviour, which no item of the contract states; the client has not confirmed it.`;
  const behaviour = (assumption: PlannedAssumption) => ({ statement: assumption.statement, underpins: assumption.underpins, rationale });
  const change = Vision.read(current).appendPlanned(
    [behaviour(first), ...rest.map(behaviour)],
    (keys) => `plan revision ${planRevision} adds behaviour no item of the contract states, recorded as Inferred assumption(s) ${keys.join(", ")}`,
  );
  const cited = planned.map((assumption) => assumption.key);
  if (change.keys.join(",") !== cited.join(",")) {
    throw new PlannedBehaviourUnrecorded(projectId, planRevision, `its tasks cite ${cited.join(", ")}, but vision v${current.version} gives ${change.keys.join(", ")}`);
  }
  const op = (assumption: PlannedAssumption): RevisionOp => ({
    target: "assumption",
    action: "add",
    key: assumption.key,
    direction: "neutral",
    labelled: null,
    read: null,
    statement: assumption.statement,
  });
  const revision: RevisionRecord = {
    author: "ashara",
    sourceMessageId: null,
    approver: null,
    direction: "neutral",
    cause: "ashara-decision",
    ops: [op(first), ...rest.map(op)],
    pushback: null,
  };
  const appended = await repository.append(projectId, change, revision);
  if (appended.kind === "moved") {
    const now = appended.current === null ? "none" : `v${appended.current}`;
    throw new PlannedBehaviourUnrecorded(projectId, planRevision, `planned on vision v${change.basedOnVersion}, current is ${now}`);
  }
}
