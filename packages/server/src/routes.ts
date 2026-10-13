import { Hono } from "hono";
import { z } from "zod";
import type { WorkItemStatus, StoredBlockedReason } from "@ashara/shared";
import { parseWorkItemStatus, parseProjectId, InvalidStatusTransition } from "@ashara/shared";
import {
  WorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ProjectRepository,
  ConfigRepository,
} from "@ashara/db";
import type { CreatedProject, VisionInput } from "@ashara/db";
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
import { providerApiKeySecretName } from "@ashara/security";
import {
  listClientMessages,
  notJson,
  postClientMessage,
  readJsonBody,
  submitTender,
} from "./client-channel.js";
import type { ChannelCaller, ClientChannelDeps } from "./client-channel.js";
import { rowToWorkItem } from "./work-item-adapter.js";

// ---------------------------------------------------------------------------
// App state injected via Hono variables
// ---------------------------------------------------------------------------

export interface AppDeps extends ClientChannelDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly eventStore: EventStoreRepository;
  readonly devSessionRepo: DevSessionRepository;
  readonly visionRepo: VisionRepository;
  readonly projectRepo: ProjectRepository;
  /** A tender: the project row, owned by `clientId`, and its vision v1 in one transaction (K3). */
  readonly createProject: (clientId: string, name: string, vision: VisionInput) => Promise<CreatedProject>;
  readonly configRepo: ConfigRepository;
  /** Presence only: no route ever reads or returns a secret value. */
  readonly secretStore: { has(name: string): Promise<boolean> };
  readonly runner: Pick<ContinuousRunner, "wake">;
}

type AppEnv = { Variables: { deps: AppDeps } };

const StatusReasonSchema = z.record(z.string(), z.unknown()).optional();

// ---------------------------------------------------------------------------
// Request-body schemas for the remaining mutating routes (SEAM-6 / Move 7):
// every route that reads `body.*` validates the shape before touching it.
// ---------------------------------------------------------------------------

// `clientId` is required: every project belongs to a client (migration 018), and
// the operator creating one on a client's behalf names which.
const CreateVisionSchema = z.object({
  clientId: z.uuid(),
  projectName: z.string().min(1),
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

    const item = rowToWorkItem(row);

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
          // Tag the source so a reader can tell this caller-supplied payload
          // apart from FailureRouter's structured shapes instead of duck-typing
          // on field names that happen to collide (e.g. a caller-supplied
          // "reason" string).
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
    const { createProject, clientRepo } = c.get("deps");

    const json = await readJsonBody(() => c.req.json());
    if (!json.ok) return c.json(notJson("create vision", json).body, 400);
    const parsed = CreateVisionSchema.safeParse(json.value);
    if (!parsed.success) {
      return c.json({ error: "invalid vision", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const visionText = body.vision_text ?? body.visionText;
    if (!visionText) {
      return c.json({ error: "vision_text/visionText is required" }, 400);
    }
    if ((await clientRepo.get(body.clientId)) === null) {
      return c.json({ error: `client not found: ${body.clientId}` }, 404);
    }

    // A tender creates its project and vision v1 together (K3); the caller keys
    // every later request for this project by the returned projectId.
    const created = await createProject(body.clientId, body.projectName, {
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

    return c.json({ projectId: created.project.id, vision: created.vision }, 201);
  });

  app.get("/projects/:projectId/vision", async (c) => {
    const { visionRepo } = c.get("deps");
    const parsed = z.string().uuid().safeParse(c.req.param("projectId"));
    if (!parsed.success) {
      return c.json({ error: "projectId must be a UUID", issues: parsed.error.issues }, 400);
    }
    const current = await visionRepo.getCurrent(parseProjectId(parsed.data));
    if (!current) return c.json({ error: `no vision for project ${parsed.data}` }, 404);
    return c.json(current);
  });

  // -----------------------------------------------------------------------
  // Client channel (K1). Inbound only: no route writes an outbound message;
  // the Liaison writes those server-side. Every inbound insert NOTIFYs the loop.
  // -----------------------------------------------------------------------

  // The bearer token is the operator's: it reaches every project, and a tender
  // names the client it is for (404 for an unknown client).
  const operator: ChannelCaller = { kind: "operator" };

  app.post("/tenders", async (c) => {
    const result = await submitTender(c.get("deps"), operator, await readJsonBody(() => c.req.json()));
    return c.json(result.body, result.status);
  });

  app.post("/projects/:projectId/messages", async (c) => {
    const json = await readJsonBody(() => c.req.json());
    const result = await postClientMessage(c.get("deps"), operator, c.req.param("projectId"), json);
    return c.json(result.body, result.status);
  });

  app.get("/projects/:projectId/messages", async (c) => {
    const result = await listClientMessages(c.get("deps"), operator, c.req.param("projectId"), c.req.query());
    return c.json(result.body, result.status);
  });

  // -----------------------------------------------------------------------
  // Config
  // -----------------------------------------------------------------------

  app.get("/config/models", async (c) => {
    const { configRepo } = c.get("deps");
    const models = await configRepo.listModelConfigs();
    return c.json(models);
  });

  // Reports whether a key is stored, never the key (ADR-075 C2).
  app.get("/config/providers", async (c) => {
    const { configRepo, secretStore } = c.get("deps");
    const rows = await configRepo.listProviderConfigs();

    const configs = await Promise.all(
      rows.map(async (row) => ({
        name: row.name,
        providerType: row.providerType,
        baseUrl: row.baseUrl ?? null,
        hasKey: await secretStore.has(providerApiKeySecretName(row.name)),
      })),
    );
    return c.json(configs);
  });

  return app;
}
