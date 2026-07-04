import { Hono } from "hono";
import { z } from "zod";

import type { WorkItemId, WorkItemStatus } from "@ashara/shared";
import {
  createDomainEvent,
  parseWorkItemStatus,
  parseWorkItemLevel,
} from "@ashara/shared";
import {
  WorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ConfigRepository,
  CostRepository,
} from "@ashara/db";
import {
  createPendingWorkItem,
  startWorkItem,
  completeWorkItem,
  failWorkItem,
  blockWorkItem,
  unblockWorkItem,
  replanWorkItem,
  abandonWorkItem,
  takeEvents,
  InvalidStatusTransition,
} from "@ashara/planning-domain";
import type { ContinuousRunner } from "@ashara/orchestrator";
import { BulkReferenceError } from "@ashara/planning";
import type { BulkPlanItem, BulkPlanEdge, BulkPlanResult } from "@ashara/planning";
import { CodebaseIndexer, Bm25Index } from "@ashara/memory-indexer";

// ---------------------------------------------------------------------------
// App state injected via Hono variables
// ---------------------------------------------------------------------------

export interface AppDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: EventStoreRepository;
  readonly devSessionRepo: DevSessionRepository;
  readonly visionRepo: VisionRepository;
  readonly configRepo: ConfigRepository;
  readonly costRepo: CostRepository;
  readonly runner: ContinuousRunner;
  readonly indexer: CodebaseIndexer;
  /**
   * Creates a whole bulk plan hierarchy AND its derived ProjectContract in one
   * transaction (mig9-t5). The composition root wires the transactional facade
   * (createBulkPlanWithContract); the handler stays thin.
   */
  readonly createBulkPlan: (
    items: readonly BulkPlanItem[],
    edges: readonly BulkPlanEdge[],
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

const BulkCreateSchema = z.object({
  items: z.array(BulkItemSchema).min(1),
  edges: z.array(BulkEdgeSchema).default([]),
});

const StatusReasonSchema = z.record(z.string(), z.unknown()).optional();

// ---------------------------------------------------------------------------
// Request-body schemas for the remaining mutating routes (SEAM-6 / Move 7):
// every route that reads `body.*` validates the shape before touching it.
// ---------------------------------------------------------------------------

const CreateWorkItemSchema = z.object({
  level: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  parent_id: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  task_spec: z.record(z.string(), z.unknown()).optional(),
  taskSpec: z.record(z.string(), z.unknown()).optional(),
  north_star: z.string().optional(),
  northStar: z.string().optional(),
});

const AddDependencySchema = z.object({
  from_id: z.string().min(1).optional(),
  fromId: z.string().min(1).optional(),
  to_id: z.string().min(1).optional(),
  toId: z.string().min(1).optional(),
});

const GraphIndexSchema = z.object({
  path: z.string().min(1),
  extensions: z.array(z.string()).optional(),
});

const GraphTraverseSchema = z.object({
  symbols: z.array(z.string()).optional(),
  symbol_names: z.array(z.string()).optional(),
  depth: z.number().int().optional(),
  hops: z.number().int().optional(),
});

const GraphKeywordSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().optional(),
  top_k: z.number().int().positive().optional(),
});

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

const UpdateSettingsSchema = z.object({
  settings: z.record(z.string(), z.string()),
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

  app.post("/work-items", async (c) => {
    const { workItemRepo, eventStore } = c.get("deps");

    const parsed = CreateWorkItemSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid work item", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    const level = parseWorkItemLevel(body.level);
    const title = body.title;
    const description = body.description;
    const parentId = body.parent_id ?? body.parentId;
    const taskSpec = body.task_spec ?? body.taskSpec;
    const northStar = body.north_star ?? body.northStar;

    const existing = await workItemRepo.findDuplicate(
      level,
      title,
      parentId ?? null,
    );
    if (existing) {
      return c.json(existing, 200);
    }

    const item = createPendingWorkItem(
      level,
      title,
      parentId as WorkItemId | undefined,
      description,
      taskSpec,
      northStar,
    );

    const created = await workItemRepo.create({
      id: item.id,
      level: item.level,
      status: item.status,
      parentId: item.parentId ?? null,
      title: item.title,
      description: item.description ?? null,
      taskSpec: item.taskSpec ?? null,
      northStar: item.northStar ?? null,
    });

    const event = createDomainEvent("work_item.created", "server", {
      work_item_id: created.id,
      level: created.level,
    });
    try {
      await eventStore.publish(event, "Internal");
    } catch (e) {
      console.warn("failed to publish work_item.created event:", e);
    }

    return c.json(created, 201);
  });

  app.post("/work-items/bulk", async (c) => {
    const { eventStore, createBulkPlan } = c.get("deps");

    const parsed = BulkCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid bulk request", issues: parsed.error.issues }, 400);
    }
    const { items, edges } = parsed.data;

    // The whole hierarchy AND its derived ProjectContract commit or roll back as
    // one unit (mig9-t5). Reference resolution and the contract write happen inside
    // the transaction, so an unresolved parent/edge OR a contract failure fails
    // closed: nothing is left persisted.
    let result: BulkPlanResult;
    try {
      result = await createBulkPlan(items, edges);
    } catch (e) {
      if (e instanceof BulkReferenceError) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }

    // Audit events published only after the transaction commits (best-effort,
    // consistent with the single-item create path above).
    for (const [, id] of Object.entries(result.tempIdToId)) {
      const event = createDomainEvent("work_item.created", "server", { work_item_id: id });
      try {
        await eventStore.publish(event, "Internal");
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

  app.get("/work-items/:id", async (c) => {
    const { workItemRepo } = c.get("deps");
    const id = c.req.param("id");
    const item = await workItemRepo.findById(id);
    if (!item) return c.json({ error: "work item not found" }, 404);
    return c.json(item);
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
      taskSpec: (row.taskSpec as Record<string, unknown>) ?? undefined,
      northStar: row.northStar ?? undefined,
      successCriteria: (row.successCriteria as unknown[]) ?? undefined,
      blockedReason: (row.blockedReason as Record<string, unknown>) ?? undefined,
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
        case "Blocked":
          blockWorkItem(item, reason);
          break;
        case "Failed":
          failWorkItem(item, reason);
          break;
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
          const abandonReason = { ...callerReason, source: "api" };
          abandonWorkItem(item, abandonReason);
          break;
        }
        case "Archived":
          return c.json(
            { error: "cannot transition to Archived via this endpoint" },
            400,
          );
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
        await eventStore.publish(event, "Internal");
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
  // Dependencies
  // -----------------------------------------------------------------------

  app.post("/dependencies", async (c) => {
    const { workItemRepo } = c.get("deps");

    const parsed = AddDependencySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid dependency", issues: parsed.error.issues }, 400);
    }
    const fromId = parsed.data.from_id ?? parsed.data.fromId;
    const toId = parsed.data.to_id ?? parsed.data.toId;
    if (!fromId || !toId) {
      return c.json({ error: "from_id/fromId and to_id/toId are required" }, 400);
    }

    await workItemRepo.addDependency(fromId, toId);
    return c.body(null, 201);
  });

  // -----------------------------------------------------------------------
  // Orchestration
  // -----------------------------------------------------------------------

  app.post("/cycle", async (c) => {
    const { runner } = c.get("deps");
    runner.wake();
    return c.json({ message: "cycle triggered via continuous runner" });
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
  // Graph (backed by CodebaseIndexer + BM25)
  // -----------------------------------------------------------------------

  let bm25Cache: Bm25Index | null = null;

  app.post("/graph/index", async (c) => {
    const { indexer } = c.get("deps");

    const parsed = GraphIndexSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid graph index request", issues: parsed.error.issues }, 400);
    }
    const path = parsed.data.path;
    const extensions = parsed.data.extensions ?? ["ts", "tsx", "js", "jsx", "rs"];

    indexer.indexDirectory(path, extensions);
    bm25Cache = Bm25Index.fromGraph(indexer.graph);

    return c.json({
      indexed: indexer.graph.nodeCount(),
      edges: indexer.graph.edgeCount(),
    });
  });

  app.post("/graph/traverse", async (c) => {
    const { indexer } = c.get("deps");

    const parsed = GraphTraverseSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid graph traverse request", issues: parsed.error.issues }, 400);
    }
    const symbols = parsed.data.symbols ?? parsed.data.symbol_names ?? [];
    const depth = parsed.data.depth ?? parsed.data.hops ?? 2;

    const graph = indexer.graph;
    if (graph.nodeCount() === 0) return c.json({ results: [] });

    const visited = new Set<string>();
    let frontier: string[] = [];
    const results: Array<{
      symbolName: string;
      symbolKind: string;
      filePath: string;
      startLine: number;
      endLine: number;
      signature?: string;
      distance: number;
    }> = [];

    for (const name of symbols) {
      for (const key of graph.findSymbolsByName(name)) {
        if (!visited.has(key)) {
          visited.add(key);
          frontier.push(key);
          const sym = graph.getSymbol(key);
          if (sym) {
            results.push({
              symbolName: sym.name,
              symbolKind: sym.kind,
              filePath: sym.filePath,
              startLine: sym.lineRange[0],
              endLine: sym.lineRange[1],
              signature: sym.signature,
              distance: 0,
            });
          }
        }
      }
    }

    for (let d = 1; d <= depth; d++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const nKey of graph.neighbors(key, "outgoing")) {
          if (!visited.has(nKey)) {
            visited.add(nKey);
            next.push(nKey);
            const sym = graph.getSymbol(nKey);
            if (sym) {
              results.push({
                symbolName: sym.name,
                symbolKind: sym.kind,
                filePath: sym.filePath,
                startLine: sym.lineRange[0],
                endLine: sym.lineRange[1],
                signature: sym.signature,
                distance: d,
              });
            }
          }
        }
      }
      frontier = next;
    }

    return c.json({ results });
  });

  app.post("/graph/keyword-search", async (c) => {
    const { indexer } = c.get("deps");

    const parsed = GraphKeywordSearchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid keyword search request", issues: parsed.error.issues }, 400);
    }
    const query = parsed.data.query;
    const limit = parsed.data.limit ?? parsed.data.top_k ?? 20;

    const graph = indexer.graph;
    if (graph.nodeCount() === 0) return c.json({ results: [] });

    if (!bm25Cache) {
      bm25Cache = Bm25Index.fromGraph(graph);
    }

    const searchResults = bm25Cache.search(query, limit);
    const results = searchResults.map((sr) => {
      const sym = graph.getSymbolById(sr.id);
      return {
        symbolName: sr.id.name,
        symbolKind: sr.id.kind,
        filePath: sr.id.filePath,
        startLine: sym?.lineRange[0] ?? 0,
        endLine: sym?.lineRange[1] ?? 0,
        score: sr.score,
      };
    });

    return c.json({ results });
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

  app.get("/config/providers", async (c) => {
    const { configRepo } = c.get("deps");
    const rows = await configRepo.listProviderConfigs();

    const configs = rows.map((row) => {
      const envKey = `${row.name.toUpperCase()}_API_KEY`;
      const apiKey = process.env[envKey] ?? null;
      const envBaseUrl = `${row.name.toUpperCase()}_BASE_URL`;
      const baseUrl = row.baseUrl ?? process.env[envBaseUrl] ?? null;
      return {
        name: row.name,
        providerType: row.providerType,
        apiKey,
        baseUrl,
      };
    });
    return c.json(configs);
  });

  app.get("/config/settings", async (c) => {
    const { configRepo } = c.get("deps");
    const rows = await configRepo.getSettings();
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return c.json(settings);
  });

  app.put("/config/settings", async (c) => {
    const { configRepo } = c.get("deps");

    const parsed = UpdateSettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "invalid settings", issues: parsed.error.issues }, 400);
    }

    for (const [key, value] of Object.entries(parsed.data.settings)) {
      await configRepo.updateSetting(key, value);
    }
    return c.body(null, 200);
  });

  // -----------------------------------------------------------------------
  // Costs
  // -----------------------------------------------------------------------

  app.get("/costs/by-tier", async (c) => {
    const { costRepo } = c.get("deps");
    const result = await costRepo.loadCostPerVerifiedTask();
    return c.json(result);
  });

  return app;
}
