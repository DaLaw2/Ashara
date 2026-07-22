import type { WorkItem, WorkItemRepository } from "./domain/index.js";
import { PlanningService } from "./domain/index.js";
import type { NorthStarCheckInput, AlignmentResult } from "./northstar.js";
import type { NorthStarChecker } from "./northstar.js";

export interface NorthStarCheckDeps {
  readonly workItemRepo: WorkItemRepository;
  readonly northstarChecker: NorthStarChecker;
}

export async function checkNorthStarAlignment(
  deps: NorthStarCheckDeps,
  batch: ReadonlyArray<WorkItem>,
  completedTaskIds: ReadonlyArray<string>,
): Promise<boolean> {
  if (completedTaskIds.length === 0) return false;

  const completedSummaries = batch
    .filter((t) => completedTaskIds.includes(t.id))
    .map((t) => {
      const desc = t.description ?? "";
      return desc ? `${t.title}: ${desc}` : t.title;
    });

  const firstCompleted = batch.find((t) => completedTaskIds.includes(t.id));
  if (!firstCompleted?.parentId) return false;

  const parent = await PlanningService.findWorkItem(deps.workItemRepo, firstCompleted.parentId);
  if (!parent) return false;

  let story: WorkItem;
  let epic: WorkItem | null = null;

  if (parent.level === "Story") {
    story = parent;
    if (parent.parentId) {
      epic = await PlanningService.findWorkItem(deps.workItemRepo, parent.parentId);
    }
  } else if (parent.level === "Feature" && parent.parentId) {
    const parentStory = await PlanningService.findWorkItem(deps.workItemRepo, parent.parentId);
    if (!parentStory) return false;
    story = parentStory;
    if (parentStory.parentId) {
      epic = await PlanningService.findWorkItem(deps.workItemRepo, parentStory.parentId);
    }
  } else {
    return false;
  }

  const storyNorthStar = story.northStar;
  if (!storyNorthStar) return false;

  const epicNorthStar = epic?.northStar ?? "";

  const storyCriteria = Array.isArray(story.successCriteria)
    ? (story.successCriteria as string[])
    : [];

  const input: NorthStarCheckInput = {
    completedWork: completedSummaries.join(". "),
    storyNorthStar,
    epicNorthStar,
    storyCriteria,
  };

  const result: AlignmentResult = await deps.northstarChecker.check(input);

  if (result.aligned) {
    console.log(`NorthStar aligned: ${result.evidence}`);
    return false;
  }

  console.warn(`NorthStar drift: ${result.driftDescription}`);
  return true;
}
