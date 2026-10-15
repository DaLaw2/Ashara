import { z } from "zod";
import type { ContextualLlm, LadderAttemptEvent } from "@ashara/llm-gateway";
import { RosterUnreadable, WorkKindOwnerUnresolved, ownerOf, parseStoredRoster } from "@ashara/organization";
import {
  StoredAssumptionDisclosureSchema,
  StoredAssumptionKindSchema,
  StoredScopeLineSchema,
  assumptionStanding,
  describeErrorChain,
  projectBlockCause,
} from "@ashara/shared";
import type { ProjectBlockCause, ProjectId, ProjectKnowledge, ScopeSide, WorkItemLevel, WorkKind } from "@ashara/shared";
import type { BulkPlanEdge, BulkPlanItem } from "./bulk-plan.js";
import { DecompositionEngine } from "./decomposition.js";
import type {
  DecompositionInput,
  DecompositionResult,
  DroppedDependency,
  TaskSpec,
  VisionItem,
  WorkItemSpec,
} from "./decomposition-types.js";
import { createGatewayDecompositionLLM } from "./gateway-adapters.js";

// Delivery's first plan of a project (story s-liaison-intake-m1, ADR-075): the
// project's current vision, which Engagement owns and Delivery only reads, is
// decomposed into an Epic -> Task plan written in one transaction. Delivery never
// writes to the client; the Liaison reports the outcome from what is recorded here.

/** Failed planning attempts after which Delivery stops and blocks the project. */
const MAX_PLAN_ATTEMPTS = 3;

/** A project with a current vision and no work items, as the store reads it. */
interface ProjectAwaitingPlan {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly visionVersion: number;
  readonly visionText: string;
  readonly summary: string;
  /** vision_documents.scope_boundaries as stored; parsed here. */
  readonly scopeBoundaries: unknown;
  /** vision_documents.inferences as stored, the client's answers in its Stated assumptions; parsed here. */
  readonly inferences: unknown;
  readonly planAttempts: number;
  readonly planLastError: string | null;
  /** The rows of the project's latest roster revision as stored; parsed by Organization. */
  readonly rosterRows: unknown;
}

/** The parts of a stored vision decomposition plans toward, as the store reads them. */
interface StoredVisionReading {
  readonly projectId: ProjectId;
  readonly visionVersion: number;
  readonly summary: string;
  readonly scopeBoundaries: unknown;
  readonly inferences: unknown;
}

/** Who owns a planned task: its kind of work and the roster role holding the capability that kind needs. */
interface TaskOwnership {
  readonly tempId: string;
  readonly workKind: WorkKind;
  readonly ownerRoleId: string;
}

export interface FirstPlanWrite {
  readonly projectId: ProjectId;
  readonly items: readonly BulkPlanItem[];
  readonly edges: readonly BulkPlanEdge[];
  readonly knowledge: ProjectKnowledge;
  /** One entry per Task item; an Epic has no owner. */
  readonly owners: readonly TaskOwnership[];
  /** Ordering hints the decomposition dropped, recorded with the plan so its report states them. */
  readonly droppedDependencies: readonly DroppedDependency[];
}

type FirstPlanCommit =
  | { readonly kind: "written"; readonly created: number }
  | { readonly kind: "already-planned" };

/** Delivery's persistence port for the first plan. Each method is one transaction. */
export interface FirstPlanStore {
  projectsAwaitingPlan(): Promise<readonly ProjectAwaitingPlan[]>;
  /**
   * Writes the whole plan and stamps the project planned, or nothing when the
   * project gained work items or a planning outcome since it was read.
   */
  writeFirstPlan(write: FirstPlanWrite): Promise<FirstPlanCommit>;
  /** Counts a failed attempt with its error; returns the count after it. */
  recordFailedAttempt(projectId: ProjectId, error: string): Promise<number>;
  /** Blocks the project and stamps planning stopped. */
  stopPlanning(projectId: ProjectId): Promise<void>;
  /**
   * Blocks the project and records why (migration 025), for a project whose own
   * record is inconsistent; a project already blocked keeps its first cause.
   */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type FirstPlanOutcome =
  | { readonly kind: "planned"; readonly projectId: ProjectId; readonly epics: number; readonly tasks: number }
  | { readonly kind: "already-planned"; readonly projectId: ProjectId }
  | { readonly kind: "failed"; readonly projectId: ProjectId; readonly attempt: number; readonly error: string }
  | { readonly kind: "stopped"; readonly projectId: ProjectId; readonly attempts: number }
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of Delivery's planning each cycle. */
export interface FirstPlanning {
  runPending(): Promise<readonly FirstPlanOutcome[]>;
}

/**
 * A project reached its attempt cap with no error on record. Migration 020's
 * CHECK makes this unrepresentable; meeting it means the store lied.
 */
class PlanFailureUnrecorded extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly attempts: number,
  ) {
    super(`project ${projectId} has ${attempts} failed planning attempts but no recorded error`);
    this.name = "PlanFailureUnrecorded";
  }
}

/**
 * The stored vision could not be read as a planning input: the project's own record, which no
 * further planning attempt can change, so the project is blocked with it and no attempt is counted.
 */
export class VisionUnreadable extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly visionVersion: number,
    readonly field: string,
    readonly issues: string,
  ) {
    super(`project ${projectId} vision v${visionVersion}: ${field} is not in a readable shape: ${issues}`);
    this.name = "VisionUnreadable";
  }
}

// Intake writes each scope line with its side; a vision written before sides were recorded holds
// bare strings, read as unclassified.
const ScopeBoundariesSchema = z.array(StoredScopeLineSchema);

// The answer a Stated assumption carries (migration 038): the Liaison writes it when
// the client answers the question that named the assumption.
const ClientAnswerSchema = z.object({ question: z.string().min(1), answer: z.string().min(1) });

// Intake (migration 019 onward) writes assumptions as Inferred records, and the
// Liaison makes one Stated, with the client's answer, when the client answers; rows
// the deleted CLI path (POST /vision) wrote hold a map of direction category to
// inference and are still in the database. Both are read; a Stated record without
// its answer, or anything else, stops the attempt rather than planning without them.
// Each record's key, kind and disclosure are read as stored (ADR-074 addendum 2 d89): a record
// written before them has no kind, so no line may cite it, and its id is its place in the list; a
// disclosure that is neither "asked" nor "reported" makes the vision unreadable.
const RecordFieldsSchema = z.object({
  key: z.string().min(1).optional(),
  kind: StoredAssumptionKindSchema,
  disclosed: StoredAssumptionDisclosureSchema,
});
const InferencesSchema = z.union([
  z.array(
    z.union([
      RecordFieldsSchema.extend({ statement: z.string().min(1), status: z.literal("Stated"), clientAnswer: ClientAnswerSchema }),
      RecordFieldsSchema.extend({ statement: z.string().min(1), status: z.string().min(1).refine((s) => s !== "Stated") }),
    ]),
  ),
  z.record(z.string(), z.string()),
]);

function parseField<T>(schema: z.ZodType<T>, value: unknown, project: StoredVisionReading, field: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new VisionUnreadable(project.projectId, project.visionVersion, field, z.prettifyError(parsed.error));
  }
  return parsed.data;
}

const SCOPE_SIDE_LEAD: Readonly<Record<ScopeSide, string>> = { in: "In scope: ", out: "Out of scope: ", unclassified: "" };

/**
 * The north star decomposition plans toward: the vision's summary, its scope, and
 * the assumptions work proceeds on. The decomposition prompt itself stays in
 * DecompositionEngine; this is only its input.
 */
export function northStarOf(project: StoredVisionReading): string {
  const scope = parseField(ScopeBoundariesSchema, project.scopeBoundaries, project, "scopeBoundaries");
  const inferences = parseField(InferencesSchema, project.inferences, project, "inferences");
  const records = Array.isArray(inferences) ? inferences : [];
  const answers = records.flatMap((a) => ("clientAnswer" in a ? [{ ...a.clientAnswer, decision: a.statement }] : []));
  const assumptions = Array.isArray(inferences)
    ? inferences.flatMap((a) => ("clientAnswer" in a ? [] : [`${a.statement} (${a.status})`]))
    : Object.entries(inferences).map(([category, inference]) => `${category}: ${inference}`);

  const sections = [project.summary];
  if (scope.length > 0) sections.push(`Scope:\n${scope.map((s) => `- ${SCOPE_SIDE_LEAD[s.side]}${s.text}`).join("\n")}`);
  if (answers.length > 0) {
    sections.push(
      `Client clarifications (Stated by the client; these override any assumption):\n` +
        answers.map((a) => `- ${a.question} -> ${a.answer} (decision: ${a.decision})`).join("\n"),
    );
  }
  if (assumptions.length > 0) {
    sections.push(`Assumptions work proceeds on until the client says otherwise:\n${assumptions.map((a) => `- ${a}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Every item of the stored vision a planned task can trace to (ADR-074 addendum 2 d71 d, d89): each
 * scope boundary (S1..), then each assumption work proceeds on, by its key in the vision (A1.., as
 * intake and the stack choice key them; a record without one by its place), a Stated one by the
 * decision the client's answer made, each with its status, standing with the client and kind. The
 * summary is not an item: it restates the whole tender, so a task tracing to it would trace to
 * nothing in particular.
 */
export function visionItemsOf(project: StoredVisionReading): VisionItem[] {
  const scope = parseField(ScopeBoundariesSchema, project.scopeBoundaries, project, "scopeBoundaries");
  const inferences = parseField(InferencesSchema, project.inferences, project, "inferences");
  const assumptions: VisionItem[] = Array.isArray(inferences)
    ? inferences.map((a, i) => ({
        type: "assumption",
        id: a.key ?? `A${i + 1}`,
        text: a.statement,
        status: a.status,
        standing: assumptionStanding(a),
        kind: a.kind,
      }))
    : Object.entries(inferences).map(([category, inference], i) => ({
        type: "assumption",
        id: `A${i + 1}`,
        text: `${category}: ${inference}`,
        status: "Inferred",
        standing: "not-shown",
        kind: "unclassified",
      }));
  const ids = new Set<string>();
  for (const item of assumptions) {
    if (ids.has(item.id)) {
      throw new VisionUnreadable(project.projectId, project.visionVersion, "inferences", `two assumptions share the key ${item.id}`);
    }
    ids.add(item.id);
  }
  return [...scope.map((line, i): VisionItem => ({ type: "scope", id: `S${i + 1}`, text: line.text, side: line.side })), ...assumptions];
}

function toLevel(level: WorkItemSpec["level"]): WorkItemLevel {
  switch (level) {
    case "epic":
      return "Epic";
    case "task":
      return "Task";
  }
}

/** The kinds of work a plan holds, each with the role that owns it. */
type PlanOwners = Readonly<Record<WorkKind, { readonly id: string }>>;

/**
 * The owner of each kind of work from the project's latest roster, resolved before any LLM call:
 * a plan nobody can own is not attempted. Throws RosterUnreadable or WorkKindOwnerUnresolved.
 */
export function planOwners(projectId: ProjectId, rosterRows: unknown): PlanOwners {
  const roster = parseStoredRoster(projectId, rosterRows);
  return {
    environment: ownerOf(roster, "environment"),
    implementation: ownerOf(roster, "implementation"),
    check: ownerOf(roster, "check"),
  };
}

/**
 * The kind of work a planned task is. Sprint 0 defines the project environment,
 * the environment role's work; every decomposed task is implementation, and its
 * check task is the check author's. The review of the plan's suites is the check
 * author's role too, as a hat (ADR-074 addendum 2 d71 c): a roster holds exactly one
 * role with author-checks, so no other role could take it, and the review is a separate
 * dispatch that reads the stored suites and authored none of them.
 */
function workKindOf(origin: TaskSpec["origin"]): WorkKind {
  switch (origin) {
    case "sprint0":
      return "environment";
    case "decomposition":
    case "product-scaffold":
      return "implementation";
    case "check":
    case "review":
      return "check";
  }
}

/** The decomposition as one bulk plan: the epic first, its tasks after, edges by temp id. */
export function toWrite(projectId: ProjectId, result: DecompositionResult, owners: PlanOwners): FirstPlanWrite {
  const items: BulkPlanItem[] = [
    {
      tempId: result.epic.id,
      level: toLevel(result.epic.level),
      title: result.epic.title,
      description: result.epic.description,
      northStar: result.epic.northStar,
    },
    ...result.tasks.map((task) => ({
      tempId: task.id,
      level: toLevel(task.level),
      title: task.title,
      description: task.description,
      parentId: task.parentId,
      taskSpec: task.taskSpec,
    })),
  ];
  const edges = result.dependencyEdges.map((edge) => ({ from: edge.from, to: edge.to }));
  const taskOwners = result.tasks.map((task): TaskOwnership => {
    const workKind = workKindOf(task.taskSpec.origin);
    return { tempId: task.id, workKind, ownerRoleId: owners[workKind].id };
  });
  return {
    projectId,
    items,
    edges,
    knowledge: result.knowledge,
    owners: taskOwners,
    droppedDependencies: result.droppedDependencies,
  };
}

/** The stored vision read as planning input, before any counted attempt. */
export interface PlanningVision {
  readonly northStar: string;
  readonly items: VisionItem[];
}

interface FirstPlannerDeps {
  readonly llm: ContextualLlm;
  readonly store: FirstPlanStore;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * Delivery's first planning step. Each project awaiting a plan is decomposed
 * through recorded `decomposition` calls; the plan is written whole or not at
 * all. A failed attempt writes nothing and is counted; at the cap the project is
 * blocked and planning stops, so the loop does not spin on it.
 */
export class FirstPlanner implements FirstPlanning {
  constructor(private readonly deps: FirstPlannerDeps) {}

  /**
   * A project whose own record is inconsistent is blocked, and the other
   * projects are still planned. Any other failure, a store failure included,
   * throws through and fails the cycle.
   */
  async runPending(): Promise<readonly FirstPlanOutcome[]> {
    const outcomes: FirstPlanOutcome[] = [];
    for (const project of await this.deps.store.projectsAwaitingPlan()) {
      try {
        outcomes.push(await this.plan(project));
      } catch (err) {
        // A roster that cannot be read or cannot assign an owner, and a vision that cannot be read,
        // are the project's own record; planning again would not change it.
        const projectRecord =
          err instanceof PlanFailureUnrecorded ||
          err instanceof RosterUnreadable ||
          err instanceof WorkKindOwnerUnresolved ||
          err instanceof VisionUnreadable;
        if (!projectRecord) throw err;
        outcomes.push(await this.block(project.projectId, projectBlockCause(err)));
      }
    }
    return outcomes;
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<FirstPlanOutcome> {
    const result = await this.deps.store.blockProject(projectId, cause);
    console.warn(`[first-plan] project ${projectId}: ${cause.errorClass}; project ${result}: ${cause.reason}`);
    return { kind: "project-blocked", projectId, cause };
  }

  private async plan(project: ProjectAwaitingPlan): Promise<FirstPlanOutcome> {
    const { projectId } = project;

    // A previous cycle reached the cap but did not stop planning.
    if (project.planAttempts >= MAX_PLAN_ATTEMPTS) {
      if (project.planLastError === null) throw new PlanFailureUnrecorded(projectId, project.planAttempts);
      await this.deps.store.stopPlanning(projectId);
      return { kind: "stopped", projectId, attempts: project.planAttempts };
    }

    const owners = planOwners(projectId, project.rosterRows);
    // Read before the counted attempt: VisionUnreadable throws through to runPending, which blocks.
    const vision: PlanningVision = { northStar: northStarOf(project), items: visionItemsOf(project) };

    let write: FirstPlanWrite;
    let commit: FirstPlanCommit;
    try {
      write = toWrite(projectId, await this.decompose(project, vision), owners);
      commit = await this.deps.store.writeFirstPlan(write);
    } catch (err) {
      return this.fail(project, err);
    }
    if (commit.kind === "already-planned") return { kind: "already-planned", projectId };
    for (const dropped of write.droppedDependencies) {
      console.warn(
        `[first-plan] project ${projectId}: ordering hint dropped: "${dropped.dependentTaskTitle}" named ` +
          `"${dropped.unresolvedRef}", which is no task of the plan; no edge was written for it`,
      );
    }
    const epics = write.items.filter((item) => item.level === "Epic").length;
    return { kind: "planned", projectId, epics, tasks: commit.created - epics };
  }

  private async decompose(project: ProjectAwaitingPlan, vision: PlanningVision): Promise<DecompositionResult> {
    const llm = createGatewayDecompositionLLM(
      this.deps.llm.forCall({ projectId: project.projectId, taskId: null, callSite: "decomposition" }),
      this.deps.onAttempt,
    );
    const input: DecompositionInput = {
      epicTitle: project.projectName,
      epicNorthStar: vision.northStar,
      epicDescription: project.visionText,
      conventions: [],
      environment: { kind: "new" },
      layout: { kind: "new" },
      visionItems: vision.items,
    };
    return new DecompositionEngine(llm).decompose(input);
  }

  private async fail(project: ProjectAwaitingPlan, err: unknown): Promise<FirstPlanOutcome> {
    const { projectId } = project;
    const error = describeErrorChain(err);
    const attempt = await this.deps.store.recordFailedAttempt(projectId, error);
    console.warn(
      `[first-plan] project ${projectId} (vision v${project.visionVersion}): attempt ${attempt}/${MAX_PLAN_ATTEMPTS} failed: ${error}`,
    );
    if (attempt < MAX_PLAN_ATTEMPTS) return { kind: "failed", projectId, attempt, error };

    await this.deps.store.stopPlanning(projectId);
    console.warn(`[first-plan] project ${projectId}: planning stopped after ${attempt} attempts; project blocked`);
    return { kind: "stopped", projectId, attempts: attempt };
  }
}
