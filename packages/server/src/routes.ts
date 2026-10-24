import { Hono } from "hono";
import { z } from "zod";
import { VisionRepository } from "@ashara/engagement";
import { WORK_FAILED } from "@ashara/quality";
import type { WorkItemId } from "@ashara/shared";
import type { StoredBlockedReason } from "@ashara/delivery";
import { InvalidId, parseProjectId, parseWorkItemId } from "@ashara/shared";
import { InvalidStatusTransition, WORK_ITEM_STATUSES } from "@ashara/delivery";
import { EventStoreRepository } from "@ashara/db";
import { DevSessionRepository } from "@ashara/workplace";
import { WorkItemRowRepository, adaptWorkItemRepo, rowToWorkItem, workItemSaveRow } from "@ashara/delivery";
import type { ProjectHaltRepository } from "@ashara/delivery";
import {
  startUnlessHeld,
  TaskHeldForCorrection,
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
  readonly projectRepo: ProjectHaltRepository;
}

type AppEnv = { Variables: { deps: AppDeps } };

const StatusPatchSchema = z.strictObject({
  status: z.enum(WORK_ITEM_STATUSES),
  reason: z.record(z.string(), z.unknown()).optional(),
});

type WorkItem = ReturnType<typeof rowToWorkItem>;
type StatusTarget = z.infer<typeof StatusPatchSchema>["status"];

/** Why a status patch is refused: the HTTP status and the body it answers with. */
interface StatusRefusal {
  readonly status: 400 | 409;
  readonly error: string;
}

export function createRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    return next();
  });

  app.get("/health", (c) => c.text("ok"));

  workItemRoutes(app);
  auditRoutes(app);
  visionRoutes(app);
  clientChannelRoutes(app);

  return app;
}

function workItemRoutes(app: Hono<AppEnv>): void {
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
      const refusal = await transitionByHand({ workItemRepo, item, newStatus, reason });
      if (refusal !== null) return c.json({ error: refusal.error }, refusal.status);

      await workItemRepo.save(workItemSaveRow(item), previousStatus);
    } catch (e) {
      if (e instanceof InvalidStatusTransition) {
        return c.json({ error: e.message }, 400);
      }
      // A task a client's correction holds is replaced by the correction's plan revision: nobody starts it by hand.
      if (e instanceof TaskHeldForCorrection) {
        return c.json({ error: e.message, heldBy: { visionVersion: e.hold.visionVersion, requestedBy: e.hold.requestedBy, affected: e.hold.affected } }, 409);
      }
      throw e;
    }

    await publishAuditEvents(eventStore, item);

    return c.body(null, 200);
  });
}

/** Applies an operator's status patch to `item`, or says why no operator may take that transition. */
async function transitionByHand(patch: {
  readonly workItemRepo: WorkItemRowRepository;
  readonly item: WorkItem;
  readonly newStatus: StatusTarget;
  readonly reason: Record<string, unknown>;
}): Promise<StatusRefusal | null> {
  const { item, newStatus, reason } = patch;
  switch (newStatus) {
    case "InProgress":
      await startUnlessHeld(adaptWorkItemRepo(patch.workItemRepo), item);
      return null;
    case "Completed":
      // Nothing outside Quality marks work passed: a task is Completed only by the
      // loop, once its delivery is verified and recorded, never by an operator's say-so.
      return { status: 409, error: `cannot complete ${item.id} by hand: a task is completed only by the loop, once Quality has verified its delivery` };
    case "Blocked":
      // No work item waits on a person: a task is Blocked only
      // by the loop, with an exit the loop takes by itself, so nobody parks one by hand.
      return { status: 409, error: `cannot block ${item.id} by hand: a task is blocked only by the loop, with an exit the loop takes by itself` };
    case "Failed": {
      const failReason: StoredBlockedReason = { ...reason, source: "api" };
      // A task failed by hand carries no verdict of Quality's on whether another attempt can
      // succeed: it is routed as retryable work, within the replan bound.
      failWorkItem(item, failReason, WORK_FAILED);
      return null;
    }
    case "Pending":
      // Failed -> Pending is the FailureRouter's "replan" decision taken by hand. A Blocked task
      // is not unblocked by hand: its exit is the loop's, each
      // cycle (orchestrator parked-exits.ts).
      if (item.status === "Blocked") {
        return { status: 409, error: `cannot unblock ${item.id} by hand: the loop takes a Blocked task's exit by itself each cycle` };
      }
      replanWorkItem(item, null);
      return null;
    case "Abandoned": {
      const callerReason =
        Object.keys(reason).length > 0 ? reason : { note: "abandoned via API" };
      // Tag the source so a reader can tell this caller-supplied payload
      // apart from FailureRouter's structured shapes instead of duck-typing
      // on field names that happen to collide (e.g. a caller-supplied
      // "reason" string).
      const abandonReason: StoredBlockedReason = { ...callerReason, source: "api" };
      abandonWorkItem(item, abandonReason);
      return null;
    }
    default: {
      // Compile-time exhaustiveness: if WorkItemStatus ever grows a new
      // member without a case here, this assignment fails to typecheck.
      const _exhaustive: never = newStatus;
      return { status: 400, error: `unsupported status transition target: ${String(_exhaustive)}` };
    }
  }
}

/** The transition's events, published after it is committed. */
async function publishAuditEvents(eventStore: EventStoreRepository, item: WorkItem): Promise<void> {
  const events = takeEvents(item);
  for (const event of events) {
    try {
      await eventStore.publish(event);
    } catch (e) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the status transition is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads
      console.warn(
        `[PATCH /work-items/:id/status] failed to publish audit event for ${item.id} (status transition already committed):`,
        e,
      );
    }
  }
}

/** The domain events and the agents' live sessions, read by the operator. */
function auditRoutes(app: Hono<AppEnv>): void {
  app.get("/events", async (c) => {
    const { eventStore } = c.get("deps");
    const events = await eventStore.listRecent(50);
    return c.json(events);
  });

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
}

function visionRoutes(app: Hono<AppEnv>): void {
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
}

/**
 * The client channel. Inbound only: no route writes an outbound message; the Liaison writes those
 * server-side. Every inbound insert NOTIFYs the loop.
 */
function clientChannelRoutes(app: Hono<AppEnv>): void {
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
}
