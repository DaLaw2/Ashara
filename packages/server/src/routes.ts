import { Hono } from "hono";
import { z } from "zod";
import type { WorkItemId, WorkItemStatus, ProjectKnowledge, StoredBlockedReason } from "@ashara/shared";
import {
  createDomainEvent,
  parseWorkItemStatus,
  parseWorkItemLevel,
  parseStoredTaskSpec,
  parseStoredBlockedReason,
  parseStoredSuccessCriteria,
  parseRunScope,
  ProjectKnowledgeSchema,
  InvalidStatusTransition,
} from "@ashara/shared";
import {
  WorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ConfigRepository,
} from "@ashara/db";
import {
  startWorkItem,
  completeWorkItem,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  takeEvents,
} from "@ashara/planning";
import type { ContinuousRunner } from "@ashara/orchestrator";
import { BulkReferenceError } from "@ashara/planning";
import type { BulkPlanItem, BulkPlanEdge, BulkPlanResult } from "@ashara/planning";

// ---------------------------------------------------------------------------
// App state injected via Hono variables
// ---------------------------------------------------------------------------

export interface AppDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: EventStoreRepository;
  readonly devSessionRepo: DevSessionRepository;
  readonly visionRepo: VisionRepository;
  readonly configRepo: ConfigRepository;
  readonly runner: ContinuousRunner;
  /**
   * Creates a whole bulk plan hierarchy AND its derived ProjectContract in one
   * transaction (mig9-t5). The composition root wires the transactional facade
   * (createBulkPlanWithContract); the handler stays thin.
   */
  readonly createBulkPlan: (
    items: readonly BulkPlanItem[],
    edges: readonly BulkPlanEdge[],
    knowledge: ProjectKnowledge,
  ) => Promise<BulkPlanResult>;
}

type AppEnv = { Variables: { deps: AppDeps } };

// ---------------------------------------------------------------------------
// Bulk work-item creation (ADR-029) — the CLI posts an entire plan hierarchy
// (items + dependency edges) in ONE transactional call instead of sequential,
// non-atomic HTTP requests. `parentId`/edge endpoints reference a `tempId`
// local to the batch; the server assigns real IDs and resolves references
// while creating items in order (parents must precede children).
// ---------------------------------------------------------------------------

const BulkItemSchema = z.object({
  tempId: z.string().min(1),
  level: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  parentId: z.string().min(1).optional(),
  taskSpec: z.record(z.string(), z.unknown()).optional(),
  northStar: z.string().optional(),
});

const BulkEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

// `knowledge` is REQUIRED and has no default (ADR-052). It is the project's
// knowledge graph as the decomposition that produced these items derived it, and
// it is the only statement anywhere in this request of what the project is built
// in. A `.default({nodes:[],edges:[]})` here would reinstate exactly the
// identity-element fail-open this change removes, one layer further out — an old
// client posting without it must be rejected, not silently planned stackless.
const BulkCreateSchema = z.object({
  items: z.array(BulkItemSchema).min(1),
  edges: z.array(BulkEdgeSchema).default([]),
  knowledge: ProjectKnowledgeSchema,
});

const StatusReasonSchema = z.record(z.string(), z.unknown()).optional();

// ---------------------------------------------------------------------------
// Request-body schemas for the remaining mutating routes (SEAM-6 / Move 7):
// every route that reads `body.*` validates the shape before touching it.
// ---------------------------------------------------------------------------

const CreateVisionSchema = z.object({
  vision_text: z.string().min(1).optional(),
  visionText: z.string().min(1).optional(),
  summary: z.string().min(1),
  inferences: z.record(z.string(), z.unknown()).optional(),
  scope_boundaries: z.array(z.unknown()).optional(),
  scopeBoundaries: z.array(z.unknown()).optional(),
  confirmed_directions: z.array(z.unknown()).optional(),
  confirmedDirections: z.array(z.unknown()).optional(),
  user_answers: z.array(z.unknown()).optional(),
  userAnswers: z.array(z.unknown()).optional(),
  open_questions: z.array(z.unknown()).optional(),
  openQuestions: z.array(z.unknown()).optional(),
  change_reason: z.string().optional(),
  changeReason: z.string().optional(),
});

const ModelConfigInputSchema = z.object({
  modelId: z.string().min(1),
  providerName: z.string().min(1),
  apiModelId: z.string().optional(),
  capability: z.enum(["Frontier", "Strong", "Medium", "Light"]),
  formatGroup: z.enum(["native-fc", "code-fence", "text-patch"]).optional(),
  inputCostPer1m: z.number().nonnegative(),
  outputCostPer1m: z.number().nonnegative(),
  maxContextTokens: z.number().int().positive(),
  supportsCaching: z.boolean().default(false),
});

export function createRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    return next();
  });

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  app.get("/health", (c) => c.text("ok"));

  // -----------------------------------------------------------------------
  // Work Items
  // -----------------------------------------------------------------------

  app.post("/work-items/bulk", async (c) => {
    const { eventStore, createBulkPlan } = c.get("deps");

    const parsed = BulkCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid bulk request", issues: parsed.error.issues }, 400);
    }
    const { items, edges, knowledge } = parsed.data;

    // The whole hierarchy AND its derived ProjectContract commit or roll back as
    // one unit (mig9-t5). Reference resolution and the contract write happen inside
    // the transaction, so an unresolved parent/edge OR a contract failure fails
    // closed: nothing is left persisted.
    let result: BulkPlanResult;
    try {
      result = await createBulkPlan(items, edges, knowledge);
    } catch (e) {
      if (e instanceof BulkReferenceError) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }

    // Audit events published only after the transaction commits (best-effort,
    // an audit write failure never undoes a committed plan).
    for (const [, id] of Object.entries(result.tempIdToId)) {
      const event = createDomainEvent("work_item.created", "server", { work_item_id: id });
      try {
        await eventStore.publish(event);
      } catch (e) {
        console.warn("failed to publish work_item.created event:", e);
      }
    }

    return c.json(result, 201);
  });

  app.get("/work-items", async (c) => {
    const { workItemRepo } = c.get("deps");
    const items = await workItemRepo.listAll();
    return c.json(items);
  });

  app.patch("/work-items/:id/status", async (c) => {
    const { workItemRepo, eventStore } = c.get("deps");
    const id = c.req.param("id");
    const body = await c.req.json();

    let newStatus: WorkItemStatus;
    try {
      newStatus = parseWorkItemStatus(body.status);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : `invalid status: ${String(body.status)}` },
        400,
      );
    }

    const reasonParsed = StatusReasonSchema.safeParse(body.reason);
    if (!reasonParsed.success) {
      return c.json({ error: "invalid reason", issues: reasonParsed.error.issues }, 400);
    }
    const reason = reasonParsed.data ?? {};

    const row = await workItemRepo.findById(id);
    if (!row) return c.json({ error: "work item not found" }, 404);

    const item = {
      id: row.id as WorkItemId,
      level: parseWorkItemLevel(row.level),
      status: parseWorkItemStatus(row.status),
      parentId: row.parentId as WorkItemId | undefined,
      title: row.title,
      description: row.description ?? undefined,
      taskSpec: parseStoredTaskSpec(row.taskSpec),
      northStar: row.northStar ?? undefined,
      successCriteria: parseStoredSuccessCriteria(row.successCriteria),
      blockedReason: parseStoredBlockedReason(row.blockedReason),
      runScope: parseRunScope(row.runScope),
      dispatchCount: row.dispatchCount,
      createdAt: row.createdAt ?? new Date(),
      updatedAt: row.updatedAt ?? new Date(),
      events: [] as import("@ashara/shared").DomainEvent[],
    };

    const previousStatus = item.status;

    try {
      switch (newStatus) {
        case "InProgress":
          startWorkItem(item);
          break;
        case "Completed":
          completeWorkItem(item);
          break;
        case "Blocked": {
          const blockReason: StoredBlockedReason = { ...reason, source: "api" };
          blockWorkItem(item, blockReason);
          break;
        }
        case "Failed": {
          const failReason: StoredBlockedReason = { ...reason, source: "api" };
          failWorkItem(item, failReason);
          break;
        }
        case "Pending":
          // Failed -> Pending and Blocked -> Pending are both legal per
          // canTransitionTo, but they are different domain events
          // (FailureRouter's "replan" decision vs. a plain unblock) --
          // route by the CURRENT status so the emitted event label matches
          // reality.
          if (previousStatus === "Failed") {
            replanWorkItem(item);
          } else {
            unblockWorkItem(item);
          }
          break;
        case "Abandoned": {
          const callerReason =
            Object.keys(reason).length > 0 ? reason : { note: "abandoned via API" };
          // Tag the source so run-summary.ts's classifyAbandon can tell this
          // caller-supplied payload apart from FailureRouter's structured
          // exhausted/substitute shapes instead of duck-typing on field names
          // that happen to collide (e.g. a caller-supplied "reason" string).
          const abandonReason: StoredBlockedReason = { ...callerReason, source: "api" };
          abandonWorkItem(item, abandonReason);
          break;
        }
        default: {
          // Compile-time exhaustiveness: if WorkItemStatus ever grows a new
          // member without a case here, this assignment fails to typecheck.
          const _exhaustive: never = newStatus;
          return c.json(
            { error: `unsupported status transition target: ${String(_exhaustive)}` },
            400,
          );
        }
      }

      await workItemRepo.save(
        {
          id: item.id,
          status: item.status,
          // `undefined` here means "the domain method cleared it" (see
          // unblockWorkItem/replanWorkItem) -- Drizzle's `.set()` drops
          // `undefined` keys instead of writing SQL NULL, so an
          // unnormalized `undefined` would silently leave the stale
          // blockedReason in place. Normalize to `null` so a clear
          // actually clears.
          blockedReason: item.blockedReason ?? null,
          updatedAt: item.updatedAt,
        },
        previousStatus,
      );
    } catch (e) {
      if (e instanceof InvalidStatusTransition) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }

    const events = takeEvents(item);
    for (const event of events) {
      try {
        await eventStore.publish(event);
      } catch (e) {
        console.warn(
          `[PATCH /work-items/:id/status] failed to publish audit event for ${item.id} (status transition already committed):`,
          e,
        );
      }
    }

    return c.body(null, 200);
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  app.get("/events", async (c) => {
    const { eventStore } = c.get("deps");
    const events = await eventStore.listRecent(50);
    return c.json(events);
  });

  // -----------------------------------------------------------------------
  // Sessions (backed by devSessionRepo)
  // -----------------------------------------------------------------------

  app.get("/sessions", async (c) => {
    const { devSessionRepo } = c.get("deps");
    const rows = await devSessionRepo.listActive();
    const sessions = rows.map((row) => ({
      sessionId: row.id,
      taskId: row.taskId,
      phase: row.phase,
      brief: row.brief ?? {},
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    return c.json(sessions);
  });

  // -----------------------------------------------------------------------
  // Vision
  // -----------------------------------------------------------------------

  app.post("/vision", async (c) => {
    const { visionRepo } = c.get("deps");

    const parsed = CreateVisionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid vision", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const visionText = body.vision_text ?? body.visionText;
    if (!visionText) {
      return c.json({ error: "vision_text/visionText is required" }, 400);
    }

    const created = await visionRepo.create({
      visionText,
      summary: body.summary,
      inferences: body.inferences ?? {},
      scopeBoundaries: body.scope_boundaries ?? body.scopeBoundaries ?? [],
      confirmedDirections:
        body.confirmed_directions ?? body.confirmedDirections ?? [],
      userAnswers: body.user_answers ?? body.userAnswers ?? [],
      openQuestions: body.open_questions ?? body.openQuestions ?? [],
      changeReason: body.change_reason ?? body.changeReason ?? null,
    });

    const { runner } = c.get("deps");
    runner.wake();

    return c.json(created, 201);
  });

  app.get("/vision", async (c) => {
    const { visionRepo } = c.get("deps");
    const latest = await visionRepo.getLatest();
    return c.json(latest);
  });

  // -----------------------------------------------------------------------
  // Config
  // -----------------------------------------------------------------------

  app.get("/config/models", async (c) => {
    const { configRepo } = c.get("deps");
    const models = await configRepo.listModelConfigs();
    return c.json(models);
  });

  app.get("/config/models/:modelId", async (c) => {
    const { configRepo } = c.get("deps");
    const modelId = c.req.param("modelId");
    const model = await configRepo.getModelConfig(modelId);
    if (!model) return c.json({ error: "model not found" }, 404);
    return c.json(model);
  });

  app.post("/config/models", async (c) => {
    const { configRepo } = c.get("deps");

    const parsed = ModelConfigInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid model config", issues: parsed.error.issues }, 400);
    }

    const model = await configRepo.upsertModelConfig(parsed.data);
    return c.json(model, 200);
  });

  app.delete("/config/models/:modelId", async (c) => {
    const { configRepo } = c.get("deps");
    const modelId = c.req.param("modelId");
    const deleted = await configRepo.deleteModelConfig(modelId);
    if (!deleted) return c.json({ error: "model not found" }, 404);
    return c.body(null, 204);
  });

  app.get("/config/providers", async (c) => {
    const { configRepo } = c.get("deps");
    const rows = await configRepo.listProviderConfigs();

    const configs = rows.map((row) => {
      const baseUrl = row.baseUrl ?? null;
      return {
        name: row.name,
        providerType: row.providerType,
        baseUrl,
        apiKey: row.apiKey ?? null,
      };
    });
    return c.json(configs);
  });

  return app;
}
