import { z } from "zod";
import type { ContextualLlm, LadderAttemptEvent, ModelCallFailure } from "@ashara/finance";
import { modelCallFailureOf, withStructuredLadder } from "@ashara/finance";
import { containEach, describeErrorChain } from "@ashara/shared";
import type { ProjectId, StepContainment, StepFaulted } from "@ashara/shared";
import { modelCallBlockCategory, projectBlockCause, recordedFailureOf } from "@ashara/delivery/project-halt";
import type { ProjectBlockCause } from "@ashara/delivery/project-halt";
import {
  CorrectionResponseSchema,
  affectedKeys,
  causeOf,
  checkedDirection,
  correctionPrompt,
  correctionReport,
  costBandOf,
  pushbackOf,
  readingProblems,
  revisionOpsOf,
} from "./correction.js";
import type { ChangeImpact, CheckedOp, CorrectionNote, CorrectionReading, PendingProposal } from "./correction.js";
import { ownSpendRefusal } from "./client-spend-refusal.js";
import { StoredRevisionOpsSchema, revisionDirection } from "./vision-language/contract-op.js";
import type { Direction, Pushback, RevisionOp, RevisionRecord } from "./vision-language/contract-op.js";
import { Vision, VisionUnreadable } from "./vision.js";
import type { StoredVision, VisionAppend } from "./vision.js";

// The client's change of direction, read the cycle it arrives. Each change message is read once into
// typed operations on the contract in force; it confirms any pending proposal it names, and its own
// operations are applied as vision vN+1 with a revision record (author, approver, direction, cause),
// or, when the Liaison pushes back, recorded as a proposal awaiting the client's confirmation. Either
// way one impact note goes out in reply to it, in the same transaction. No outcome refuses a change.
// A halted project's changes are read too: a halt pauses the work, never the reading of what the client
// said, so the contract is corrected at once and the work it touches waits for the halt's own end;
// except under a halt the reading cannot get past (projectReadsClientInput), which the change waits out.

/** Failed attempts to read one change after which the Liaison stops and blocks the project. */
export const MAX_CHANGE_ATTEMPTS = 3;

/** An inbound change not yet consumed, as the change store reads it. */
export interface OpenChange {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly body: string;
  readonly intakeAttempts: number;
  readonly intakeLastError: string | null;
  /** Whose failure the last counted attempt was, as stored; read by recordedFailureOf. */
  readonly intakeLastFailure: string | null;
  /** The project's current vision, as stored; null when it has none. */
  readonly vision: StoredVision | null;
  /** Every contract and assumption key any version of the project held. */
  readonly usedKeys: readonly string[];
  /** The project's revisions awaiting the client's confirmation, oldest first. */
  readonly proposals: readonly StoredProposal[];
  /** Whether Delivery has the project halted: the change is read and applied, and the work it touches waits for the halt to end. */
  readonly paused: boolean;
}

/** A proposed revision as stored: its operations, unread, and the message they were read from. */
export interface StoredProposal {
  readonly id: string;
  readonly ops: unknown;
  /** The change message it was read from, with its words; null on one Ashara proposed. */
  readonly source: { readonly messageId: string; readonly body: string } | null;
}

/** A proposal the change confirms, applied as the version after the one before it. */
interface ConfirmationWrite {
  readonly proposalId: string;
  readonly vision: VisionAppend;
  readonly ops: readonly RevisionOp[];
  readonly direction: Direction;
}

/** The change's own revision: applied as the next version, or proposed against the version in force. */
type RevisionWrite =
  | { readonly status: "applied"; readonly vision: VisionAppend; readonly record: RevisionRecord }
  | { readonly status: "proposed"; readonly basedOnVersion: number; readonly record: RevisionRecord };

export interface CorrectionWrite {
  readonly changeId: string;
  readonly projectId: ProjectId;
  /** The version the change was read against: a write finding another current writes nothing. */
  readonly basedOnVersion: number;
  readonly confirmations: readonly ConfirmationWrite[];
  readonly revision: RevisionWrite | null;
  /** The impact note, posted in reply to the change. */
  readonly note: string;
  /** Whether the project was halted when the note was composed: the note says so, so a write finding otherwise writes nothing. */
  readonly paused: boolean;
}

/** What recording a change did; "moved" wrote nothing: the vision it was read against is no longer current. */
type CorrectionRecording = { readonly kind: "recorded" } | { readonly kind: "already-consumed" } | { readonly kind: "moved"; readonly detail: string };

/** Engagement's persistence port for client changes. Each write method is one transaction. */
export interface ClientChangeStore {
  openChanges(): Promise<readonly OpenChange[]>;
  /** The change as openChanges lists it, read now; null when no longer listed. */
  openChange(changeId: string): Promise<OpenChange | null>;
  /** The tasks of the project's current plan citing any of `ids`, and its work ledger. */
  impact(projectId: ProjectId, ids: readonly string[]): Promise<ChangeImpact>;
  /**
   * Consumes the change and, with it, applies each confirmation and the change's own revision and
   * posts the note in reply to it; a change already consumed gets nothing new.
   */
  recordCorrection(write: CorrectionWrite): Promise<CorrectionRecording>;
  /** Counts a failed attempt with its error and whose failure it was; returns the count after it. */
  recordFailedAttempt(changeId: string, error: string, failure: Exclude<ModelCallFailure, "ashara">): Promise<number>;
  /** Blocks the project and records why; a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

/** What the change's own operations did: applied as a version, held for confirmation, or nothing to apply. */
type RevisionOutcome =
  | { readonly status: "applied"; readonly visionVersion: number; readonly direction: Direction }
  | { readonly status: "proposed"; readonly direction: Direction; readonly pushback: Pushback }
  | { readonly status: "unchanged" };

/** What reading one change did. There is no refusal: a change applies, is held for confirmation, or is read again. */
export type ClientChangeOutcome =
  | {
      readonly kind: "recorded";
      readonly changeId: string;
      readonly projectId: ProjectId;
      /** The pending proposals it confirmed, each now applied. */
      readonly confirmed: readonly string[];
      readonly revision: RevisionOutcome;
    }
  | { readonly kind: "already-consumed"; readonly changeId: string; readonly projectId: ProjectId }
  /** Listed at the cycle's start, but consumed or its project stopped before it was read: nothing was done. */
  | { readonly kind: "not-open"; readonly changeId: string; readonly projectId: ProjectId }
  /** The project's vision moved before the write: nothing was written, no attempt counted, and it is read again next cycle. */
  | { readonly kind: "moved"; readonly changeId: string; readonly projectId: ProjectId; readonly detail: string }
  | { readonly kind: "failed"; readonly changeId: string; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  /**
   * The paused project's own spend cap or work budget refused the reading's model call: no attempt is
   * counted, and the change is read once the limit is raised; the other projects' changes go on.
   */
  | { readonly kind: "waits-for-limit"; readonly changeId: string; readonly projectId: ProjectId; readonly reason: string }
  /** The project's record cannot take the change and the project is halted already: nothing is written, and it blocks once the halt ends. */
  | { readonly kind: "waits-for-halt"; readonly changeId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause }
  | StepFaulted
  | { readonly kind: "project-blocked"; readonly changeId: string; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of the Liaison each cycle, with the answers. */
export interface LiaisonClientChanges {
  runPending(): Promise<readonly ClientChangeOutcome[]>;
}

/** The project's record cannot take this change: the change is left unconsumed and the project blocked. */
class ChangeVisionUnusable extends Error {
  constructor(
    readonly changeId: string,
    readonly projectId: ProjectId,
    readonly detail: string,
  ) {
    super(`change ${changeId} of project ${projectId} cannot be read against the vision: ${detail}`);
    this.name = "ChangeVisionUnusable";
  }
}

/** Reading the change failed on every attempt: what the client asked is not known, so the project is blocked, the change kept. */
class ChangeReadingExhausted extends Error {
  constructor(
    readonly changeId: string,
    readonly attempts: number,
    readonly lastError: string,
    readonly failure: ModelCallFailure,
  ) {
    super(`change ${changeId} could not be read after ${attempts} attempts; last error: ${lastError}`);
    this.name = "ChangeReadingExhausted";
  }
}

/** A change at its attempt cap with no error on record: a store CHECK makes this unrepresentable. */
class ChangeFailureUnrecorded extends Error {
  constructor(
    readonly changeId: string,
    readonly attempts: number,
  ) {
    super(`change ${changeId} has ${attempts} failed reading attempts but no recorded error`);
    this.name = "ChangeFailureUnrecorded";
  }
}

function changeReask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous response was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send corrected JSON only. No markdown, no explanatory prose.`
  );
}

/** A pending proposal read whole: its operations as recorded, and the message they were read from. */
interface ReadProposal extends PendingProposal {
  readonly recorded: readonly RevisionOp[];
  readonly source: StoredProposal["source"];
}

interface ChangeContext {
  readonly change: OpenChange;
  readonly vision: Vision;
  readonly proposals: readonly ReadProposal[];
}

interface ClientChangesDeps {
  readonly llm: ContextualLlm;
  readonly store: ClientChangeStore;
  /** Each change's own fault is contained to it (containEach). */
  readonly containment: StepContainment;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * The Liaison's reading of the client's changes. Each unconsumed change is read by one structured call
 * at the intake site; what it does is recorded whole or not at all. A failed attempt leaves the change
 * unconsumed with the failure counted; at the cap the project is blocked and the change kept, and
 * whatever ends the halt sets its count back to none (restartClientReadings), so it is read afresh then.
 */
export class ClientChanges implements LiaisonClientChanges {
  constructor(private readonly deps: ClientChangesDeps) {}

  /**
   * A change its project's record cannot take blocks that project, and the other changes are still
   * read. Any other failure that is not the read's own is that change's, contained to it (containEach);
   * a spend-cap refusal throws through to the core loop, except a paused project's own (waitForLimit).
   */
  async runPending(): Promise<readonly ClientChangeOutcome[]> {
    const changes = await this.deps.store.openChanges();
    return containEach(this.deps.containment, "client-change", changes, (listed) => ({ id: listed.id, projectId: listed.projectId }), async (listed) => {
      try {
        const change = await this.deps.store.openChange(listed.id);
        if (change === null) return { kind: "not-open", changeId: listed.id, projectId: listed.projectId } satisfies ClientChangeOutcome;
        return await this.read(change);
      } catch (err) {
        const blocks = err instanceof ChangeVisionUnusable || err instanceof ChangeReadingExhausted || err instanceof ChangeFailureUnrecorded;
        if (!blocks) throw err;
        const cause = projectBlockCause(err);
        return err instanceof ChangeReadingExhausted ? this.block(listed, { ...cause, category: modelCallBlockCategory(err.failure) }, "unread") : this.block(listed, cause, "record");
      }
    });
  }

  private async block(change: OpenChange, cause: ProjectBlockCause, why: "unread" | "record"): Promise<ClientChangeOutcome> {
    const { store } = this.deps;
    // A record no change can be read against stays so until the operator acts: under a halt, blocking would
    // find the project halted already, every cycle, with nothing changed. Its halt is opened once the project
    // is at work again, blamed as it is.
    if (why === "record" && change.paused) {
      this.deps.containment.logger.debug("engagement.change-waits-for-halt", `change ${change.id} waits for its project's halt to end: ${cause.errorClass}: ${cause.reason}`, {
        projectId: change.projectId,
        changeId: change.id,
      });
      return { kind: "waits-for-halt", changeId: change.id, projectId: change.projectId, cause };
    }
    const result = await store.blockProject(change.projectId, cause);
    console.warn(`[liaison-change] change ${change.id} (project ${change.projectId}): ${cause.errorClass}; project ${result}: ${cause.reason}`);
    return { kind: "project-blocked", changeId: change.id, projectId: change.projectId, cause };
  }

  private async read(change: OpenChange): Promise<ClientChangeOutcome> {
    const base = { changeId: change.id, projectId: change.projectId };
    if (change.intakeAttempts >= MAX_CHANGE_ATTEMPTS) {
      if (change.intakeLastError === null) throw new ChangeFailureUnrecorded(change.id, change.intakeAttempts);
      throw new ChangeReadingExhausted(change.id, change.intakeAttempts, change.intakeLastError, recordedFailureOf(change.intakeLastFailure));
    }
    const context = contextOf(change);
    let reading: CorrectionReading;
    try {
      reading = await this.callModel(context);
    } catch (err) {
      const refused = change.paused ? ownSpendRefusal(err, change.projectId) : null;
      if (refused !== null) return this.waitForLimit(change, refused.message);
      const failure = modelCallFailureOf(err);
      if (failure === "ashara") throw err;
      return this.fail(change, err, failure);
    }
    const composed = await this.compose(context, reading);
    const recorded = await this.deps.store.recordCorrection(composed.write);
    if (recorded.kind === "already-consumed") return { kind: "already-consumed", ...base };
    if (recorded.kind === "moved") {
      console.warn(`[liaison-change] change ${change.id} (project ${change.projectId}): nothing written, read again next cycle: ${recorded.detail}`);
      return { kind: "moved", ...base, detail: recorded.detail };
    }
    return { kind: "recorded", ...base, confirmed: composed.confirmed, revision: composed.revision };
  }

  /**
   * A paused project's reading refused by its own spend limit waits for the limit, charged nothing. It
   * does not throw to the core loop: the loop's halt for the refusal would find the project halted
   * already, and the step it ended would leave every later project's change unread for as long as the
   * limit stands.
   */
  private waitForLimit(change: OpenChange, reason: string): ClientChangeOutcome {
    this.deps.containment.logger.info("engagement.change-waits-for-limit", `change ${change.id} waits for its paused project's spend limit: ${reason}`, {
      projectId: change.projectId,
      changeId: change.id,
    });
    return { kind: "waits-for-limit", changeId: change.id, projectId: change.projectId, reason };
  }

  private async callModel(context: ChangeContext): Promise<CorrectionReading> {
    const provider = withStructuredLadder(
      // A change is read at the Liaison's intake site, at the strength its answers are: it is the Liaison taking in client input.
      this.deps.llm.forCall({ projectId: context.change.projectId, taskId: null, callSite: "liaison-intake" }),
      { site: "liaison-intake", attempts: 2, onAttempt: this.deps.onAttempt, reask: changeReask },
    );
    const response = await provider.generateStructured({
      capability: "Strong",
      prompt: correctionPrompt(context.vision.current, context.change.body, context.proposals),
      schema: CorrectionResponseSchema,
      maxTokens: 2048,
      validate: (value) => {
        const errors = readingProblems(value.correction, context.vision.current, context.proposals);
        return errors.length === 0 ? { ok: true } : { ok: false, errors };
      },
    });
    return response.data.correction;
  }

  private async fail(change: OpenChange, err: unknown, failure: Exclude<ModelCallFailure, "ashara">): Promise<ClientChangeOutcome> {
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(change.id, error, failure);
    console.warn(`[liaison-change] change ${change.id} (project ${change.projectId}): attempt ${attempt}/${MAX_CHANGE_ATTEMPTS} failed: ${error}`);
    if (attempt >= MAX_CHANGE_ATTEMPTS) throw new ChangeReadingExhausted(change.id, attempt, error, failure);
    return { kind: "failed", changeId: change.id, projectId: change.projectId, attempt, error };
  }

  /** The confirmations the change makes, then its own operations: applied, or proposed when the Liaison pushes back. */
  private async compose(
    context: ChangeContext,
    reading: CorrectionReading,
  ): Promise<{ readonly write: CorrectionWrite; readonly confirmed: readonly string[]; readonly revision: RevisionOutcome }> {
    const { change } = context;
    let vision = context.vision;
    const confirmations: ConfirmationWrite[] = [];
    const confirmedNotes: Array<CorrectionNote["confirmed"][number]> = [];
    for (const label of new Set(reading.confirms)) {
      const proposal = context.proposals.find((p) => p.label === label);
      if (proposal === undefined) continue;
      // An Ashara proposal names no message of its own: the client's confirmation is its source.
      const source = proposal.source ?? { messageId: change.id, body: change.body };
      const read = proposal.recorded.flatMap(({ read: op, direction }) => (op === null ? [] : [{ op, direction }]));
      const corrected = vision.correct(
        read.map((c) => c.op),
        { messageId: source.messageId, body: source.body, usedKeys: new Set([...change.usedKeys, ...usedBy(confirmations)]), changeReason: `client change ${change.id} confirmed proposal ${proposal.id}` },
      );
      if (corrected.applied.length === 0) continue;
      const applied = revisionOpsOf(read, corrected.applied);
      confirmations.push({ proposalId: proposal.id, vision: corrected.append, ops: applied, direction: revisionDirection(applied) });
      confirmedNotes.push({ label, version: corrected.next.current.version, unapplied: corrected.unapplied });
      vision = corrected.next;
    }

    const checked: CheckedOp[] = reading.ops.map((op) => ({ op, direction: checkedDirection(op, vision.current) }));
    const before = vision.current;
    const usedKeys = new Set([...change.usedKeys, ...usedBy(confirmations)]);
    const corrected = vision.correct(reading.ops, { messageId: change.id, body: change.body, usedKeys, changeReason: `client change ${change.id}` });
    let revision: RevisionWrite | null = null;
    let outcome: RevisionOutcome = { status: "unchanged" };
    let noted: CorrectionNote["outcome"] = { status: "unchanged", unapplied: corrected.unapplied };
    let impact: ChangeImpact | null = null;
    let band: CorrectionNote["band"] = null;
    // The keys the hold will park work on once the operations apply, so the note names every one held.
    const affected = affectedKeys(revisionOpsOf(checked, corrected.applied), before, corrected.next.current);
    if (checked.length > 0) {
      impact = await this.deps.store.impact(change.projectId, affected);
      band = costBandOf(reading.ops, impact);
      const pushback = pushbackOf(checked, impact, band);
      const authorship = { author: "client", sourceMessageId: change.id } as const;
      if (pushback !== null) {
        const [first, ...rest] = revisionOpsOf(checked, null);
        if (first !== undefined) {
          const direction = revisionDirection(checked);
          const record: RevisionRecord = { ...authorship, approver: null, direction, cause: "client-change", ops: [first, ...rest], pushback };
          revision = { status: "proposed", basedOnVersion: before.version, record };
          outcome = { status: "proposed", direction, pushback };
          noted = { status: "proposed", direction, pushback, unapplied: corrected.unapplied };
        }
      } else {
        const [first, ...rest] = revisionOpsOf(checked, corrected.applied);
        if (first !== undefined) {
          const ops: [RevisionOp, ...RevisionOp[]] = [first, ...rest];
          const direction = revisionDirection(ops);
          const record: RevisionRecord = { ...authorship, approver: "client", direction, cause: causeOf(corrected.applied), ops, pushback: null };
          revision = { status: "applied", vision: corrected.append, record };
          outcome = { status: "applied", visionVersion: corrected.next.current.version, direction };
          noted = { status: "applied", version: corrected.next.current.version, direction, applied: corrected.applied, unapplied: corrected.unapplied };
        }
      }
    }
    const note = correctionReport({ vision: before, confirmed: confirmedNotes, ops: checked, affected, outcome: noted, impact, band, paused: change.paused });
    return {
      write: { changeId: change.id, projectId: change.projectId, basedOnVersion: context.vision.current.version, confirmations, revision, note, paused: change.paused },
      confirmed: confirmations.map((c) => c.proposalId),
      revision: outcome,
    };
  }
}

/** The keys confirmations already applied gave out, so the change's own adds never reuse one. */
function usedBy(confirmations: readonly ConfirmationWrite[]): string[] {
  return confirmations.flatMap((c) => c.ops.flatMap((op) => (op.key === null ? [] : [op.key])));
}

/** The change's project vision, read whole, and its pending proposals labelled P<n> oldest first. */
function contextOf(change: OpenChange): ChangeContext {
  const unusable = (detail: string) => new ChangeVisionUnusable(change.id, change.projectId, detail);
  if (change.vision === null) throw unusable("the project has no vision");
  let vision: Vision;
  try {
    vision = Vision.read(change.vision);
  } catch (err) {
    if (!(err instanceof VisionUnreadable)) throw err;
    throw unusable(`vision v${change.vision.version} ${err.field} are not readable: ${err.issues}`);
  }
  const proposals = change.proposals.map((stored, i): ReadProposal => {
    const parsed = StoredRevisionOpsSchema.safeParse(stored.ops);
    if (!parsed.success) throw unusable(`proposed revision ${stored.id} holds operations that do not read: ${z.prettifyError(parsed.error)}`);
    return {
      id: stored.id,
      label: `P${i + 1}`,
      ops: parsed.data.flatMap((op) => (op.read === null ? [] : [op.read])),
      recorded: parsed.data,
      source: stored.source,
    };
  });
  return { change, vision, proposals };
}
