import { Hono } from "hono";
import { z } from "zod";
import { VisionRepository } from "@ashara/engagement";
import { WORK_FAILED } from "@ashara/quality";
import type { WorkItemId } from "@ashara/shared";
import type { StoredBlockedReason } from "@ashara/delivery";
import { InvalidId, parseProjectId, parseWorkItemId } from "@ashara/shared";
import { InvalidStatusTransition, WORK_ITEM_STATUSES } from "@ashara/delivery";
import { EventStoreRepository, ProjectRepository } from "@ashara/db";
import { DevSessionRepository } from "@ashara/workplace";
import { WorkItemRowRepository, rowToWorkItem, workItemSaveRow } from "@ashara/delivery";
import {
  startWorkItem,
  failWorkItem,
  replanWorkItem,
  abandonWorkItem,
  takeEvents,
} from "@ashara/delivery";
import {
  listClientMessages,
  notJson,
  postClientMessage,
  readJsonBody,
  submitTender,
} from "./client-channel.js";
import type { ChannelCaller, ClientChannelDeps } from "./client-channel.js";

// ---------------------------------------------------------------------------
// App state injected via Hono variables
// ---------------------------------------------------------------------------

export interface AppDeps extends ClientChannelDeps {
  readonly workItemRepo: WorkItemRowRepository;
  readonly eventStore: EventStoreRepository;
  readonly devSessionRepo: DevSessionRepository;
  readonly visionRepo: VisionRepository;
  readonly projectRepo: ProjectRepository;
}

type AppEnv = { Variables: { deps: AppDeps } };

const StatusPatchSchema = z.strictObject({
  status: z.enum(WORK_ITEM_STATUSES),
  reason: z.record(z.string(), z.unknown()).optional(),
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

  // A work item belongs to one project, and is listed only with it.
  app.get("/projects/:projectId/work-items", async (c) => {
    const { workItemRepo } = c.get("deps");
    const parsed = z.string().uuid().safeParse(c.req.param("projectId"));
    if (!parsed.success) {
      return c.json({ error: "projectId must be a UUID", issues: parsed.error.issues }, 400);
    }
    const items = await workItemRepo.listByProject(parseProjectId(parsed.data, "projectId route param"));
    return c.json(items);
  });

  app.patch("/work-items/:id/status", async (c) => {
    const { workItemRepo, eventStore } = c.get("deps");
    let id: WorkItemId;
    try {
      id = parseWorkItemId(c.req.param("id"), "id route param");
    } catch (e) {
      if (!(e instanceof InvalidId)) throw e;
      return c.json({ error: e.message }, 400);
    }
    const json = await readJsonBody(() => c.req.json());
    if (!json.ok) {
      const refused = notJson("PATCH /work-items/:id/status", json);
      return c.json(refused.body, refused.status);
    }
    const bodyParsed = StatusPatchSchema.safeParse(json.value);
    if (!bodyParsed.success) {
      return c.json({ error: "invalid status patch body", issues: bodyParsed.error.issues }, 400);
    }
    const newStatus = bodyParsed.data.status;
    // eslint-disable-next-line no-restricted-syntax -- policy default: an operator's Failed patch may omit its detail; the stored reason still records source api
    const reason = bodyParsed.data.reason ?? {};

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
          // Nothing outside Quality marks work passed (ADR-075 §5): a task is Completed only by the
          // loop, once its delivery is verified and recorded, never by an operator's say-so.
          return c.json(
            { error: `cannot complete ${item.id} by hand: a task is completed only by the loop, once Quality has verified its delivery` },
            409,
          );
        case "Blocked":
          // No work item waits on a person (story s-loop-never-stop-m1 W6): a task is Blocked only
          // by the loop, with an exit the loop takes by itself, so nobody parks one by hand.
          return c.json(
            { error: `cannot block ${item.id} by hand: a task is blocked only by the loop, with an exit the loop takes by itself` },
            409,
          );
        case "Failed": {
          const failReason: StoredBlockedReason = { ...reason, source: "api" };
          // A task failed by hand carries no verdict of Quality's on whether another attempt can
          // succeed: it is routed as retryable work, within the replan bound.
          failWorkItem(item, failReason, WORK_FAILED);
          break;
        }
        case "Pending":
          // Failed -> Pending is the FailureRouter's "replan" decision taken by hand. A Blocked task
          // is not unblocked by hand (story s-loop-never-stop-m1 W6): its exit is the loop's, each
          // cycle (orchestrator parked-exits.ts).
          if (previousStatus === "Blocked") {
            return c.json(
              { error: `cannot unblock ${item.id} by hand: the loop takes a Blocked task's exit by itself each cycle` },
              409,
            );
          }
          replanWorkItem(item, null);
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

      await workItemRepo.save(workItemSaveRow(item), previousStatus);
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
      brief: row.brief,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
    return c.json(sessions);
  });

  // -----------------------------------------------------------------------
  // Vision
  // -----------------------------------------------------------------------

  app.get("/projects/:projectId/vision", async (c) => {
    const { visionRepo } = c.get("deps");
    const parsed = z.string().uuid().safeParse(c.req.param("projectId"));
    if (!parsed.success) {
      return c.json({ error: "projectId must be a UUID", issues: parsed.error.issues }, 400);
    }
    const current = await visionRepo.getCurrent(parseProjectId(parsed.data, "projectId route param"));
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

  return app;
}
