import { Hono } from "hono";
import { z } from "zod";
import type { ProjectId, WorkItemStatus, StoredBlockedReason } from "@ashara/shared";
import { parseWorkItemStatus, parseProjectId, InvalidStatusTransition } from "@ashara/shared";
import {
  WorkItemRepository,
  EventStoreRepository,
  DevSessionRepository,
  VisionRepository,
  ProjectRepository,
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
import {
  listClientMessages,
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
  /**
   * Deletes a task's branch in its project's workspace, so its next attempt starts fresh from
   * main; nothing to do when the project has no workspace or the task no branch.
   */
  readonly discardTaskBranch: (projectId: ProjectId, taskId: string) => Promise<void>;
}

type AppEnv = { Variables: { deps: AppDeps } };

const StatusReasonSchema = z.record(z.string(), z.unknown()).optional();

/** An operator's unblock: who, and what they changed. Other fields of `reason` are ignored. */
const UnblockReasonSchema = z.object({ by: z.string().trim().min(1), note: z.string().trim().min(1) });

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
    const { workItemRepo, eventStore, discardTaskBranch } = c.get("deps");
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
          } else if (item.blockedReason?.source === "merge_unrecorded") {
            return c.json(
              {
                error:
                  `cannot unblock ${item.id}: its work is merged on main as ${item.blockedReason.mergeCommit} and only the ` +
                  "merge record is missing, so Pending would re-dispatch merged work. The loop writes the record each " +
                  "cycle and then completes it; fix what fails that write (the stored reason names it)",
              },
              409,
            );
          } else {
            // An operator's unblock is on the record: who, and what they changed (third run N11).
            const unblock = UnblockReasonSchema.safeParse(body.reason);
            if (!unblock.success) {
              if (previousStatus !== "Blocked") throw new InvalidStatusTransition(item.id, previousStatus, "Pending");
              return c.json(
                {
                  error:
                    `cannot unblock ${item.id}: an unblock needs reason.by (who unblocks) and reason.note (what was ` +
                    "changed so the block does not recur); both are recorded and the note is told to the next attempt",
                  issues: unblock.error.issues,
                },
                400,
              );
            }
            // An item refused for environment edits restarts from main, never on the branch that
            // holds them (discardTaskBranch). The branch goes first: a failure leaves it Blocked.
            if (item.blockedReason?.source === "environment_change_needed") {
              try {
                await discardTaskBranch(item.projectId, item.id);
              } catch (e) {
                return c.json(
                  {
                    error:
                      `cannot unblock ${item.id}: its branch, which holds environment edits, could not be deleted ` +
                      `(${e instanceof Error ? e.message : String(e)}); it stays Blocked`,
                  },
                  409,
                );
              }
            }
            unblockWorkItem(item, { kind: "operator", by: unblock.data.by, note: unblock.data.note });
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
