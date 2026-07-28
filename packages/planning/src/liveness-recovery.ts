import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { createPendingWorkItem, extractSubstitutedBy } from "./domain/index.js";
import type { ReplanLLM, AbandonedItemContext } from "./replan-from-vision.js";

export interface LivenessRecoveryDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly failedApproachRepo: FailedApproachSource;
  readonly replanLlm: ReplanLLM;
  readonly visionText: string;
  readonly runScope: string;
}

export interface FailedApproachSource {
  failedApproachesScoped(
    epicId: string | null,
    queryText: string,
    limit: number,
  ): Promise<readonly { title: string; failureReason: string; learned: string }[]>;
}

function findEpicId(item: WorkItem, allItems: readonly WorkItem[]): string | null {
  let current: WorkItem | undefined = item;
  while (current?.parentId) {
    const parent = allItems.find((i) => i.id === current!.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? null;
}


function readString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}

export async function recoverFromAbandoned(deps: LivenessRecoveryDeps): Promise<number> {
  const allItems = await deps.workItemRepo.listAll();

  const abandonedBlockers = allItems.filter(
    (item) =>
      item.status === "Abandoned" && extractSubstitutedBy(item.blockedReason) === undefined,
  );

  const nonTerminalStatuses = new Set(["Pending", "InProgress", "Failed", "Blocked"]);
  const hasDependents = (abandonedId: string): boolean =>
    allItems.some(
      (item) => nonTerminalStatuses.has(item.status) && item.parentId === abandonedId,
    );

  const deps_ = await deps.workItemRepo.listAllDependencies();
  const hasDepEdge = (abandonedId: string): boolean =>
    deps_.some(
      (edge) =>
        edge.toId === abandonedId &&
        allItems.some((i) => i.id === edge.fromId && nonTerminalStatuses.has(i.status)),
    );

  const recoverableAbandoned = abandonedBlockers.filter(
    (item) => hasDependents(item.id) || hasDepEdge(item.id),
  );

  if (recoverableAbandoned.length === 0) return 0;

  const epicId = findEpicId(recoverableAbandoned[0], allItems);

  const abandonedContexts: AbandonedItemContext[] = await Promise.all(
    recoverableAbandoned.map(async (item) => {
      const approaches = await deps.failedApproachRepo.failedApproachesScoped(
        epicId,
        item.title,
        5,
      );
      return {
        id: item.id,
        title: item.title,
        goal: readString(item.taskSpec, "goal"),
        deliverables: Array.isArray(item.taskSpec?.deliverables)
          ? (item.taskSpec.deliverables as string[]).filter((d): d is string => typeof d === "string")
          : undefined,
        attempts: readNumber(item.blockedReason, "attempts"),
        failureDetail: readString(item.blockedReason, "reason"),
        priorLessons: approaches.map(
          (a) => `[${a.title}] ${a.failureReason} — learned: ${a.learned}`,
        ),
      };
    }),
  );

  const completedItems = allItems
    .filter((i) => i.status === "Completed")
    .map((i) => ({ id: i.id, title: i.title }));

  const blockedItems = allItems
    .filter((i) => i.status === "Blocked")
    .map((i) => ({ id: i.id, title: i.title }));

  const globalApproaches = await deps.failedApproachRepo.failedApproachesScoped(epicId, "", 10);
  const globalLessons = globalApproaches.map((a) => `${a.failureReason} — ${a.learned}`);

  const result = await deps.replanLlm.replanFromVision({
    visionText: deps.visionText,
    completedItems,
    abandonedItems: abandonedContexts,
    blockedItems,
    globalLessons,
  });

  const abandonedById = new Map(recoverableAbandoned.map((i) => [i.id as string, i]));
  let created = 0;

  const validProposals = result.proposals.filter(
    (p) => abandonedById.has(p.replacesId) && p.differentiator.length > 20,
  );

  for (const proposal of validProposals) {
    const abandoned = abandonedById.get(proposal.replacesId);
    if (!abandoned) continue;

    await deps.workItemRepo.withTransaction(async (txRepo) => {
      const substitute = createPendingWorkItem(
        "Task",
        proposal.title,
        deps.runScope,
        abandoned.parentId,
        proposal.description,
        {
          goal: proposal.goal,
          approach: proposal.approach,
          differentiator: proposal.differentiator,
          deliverables: proposal.deliverables,
          substitutesFor: abandoned.id,
        },
      );
      const saved = await txRepo.create(substitute);

      const incomingDeps = await txRepo.listAllDependencies();
      const depsOnAbandoned = incomingDeps.filter((e) => e.toId === abandoned.id);
      for (const edge of depsOnAbandoned) {
        await txRepo.addDependency(edge.fromId, saved.id);
      }

      const priorAbandoned = allItems.filter(
        (i) =>
          i.status === "Abandoned" &&
          extractSubstitutedBy(i.blockedReason) === abandoned.id,
      );
      for (const prior of priorAbandoned) {
        prior.blockedReason = { ...prior.blockedReason, substitutedBy: saved.id };
        await txRepo.save(prior, "Abandoned");
      }

      abandoned.blockedReason = { ...abandoned.blockedReason, substitutedBy: saved.id };
      await txRepo.save(abandoned, "Abandoned");

      created += 1;
    });
  }

  return created;
}
