import { parseWorkItemId } from "@ashara/shared";
import type { WorkItemRepository } from "./acl/planning-acl.js";
import { createPendingWorkItem, PlanningService } from "./acl/planning-acl.js";
import type { AttributionResult } from "./acl/development-acl.js";

export interface BugFixTaskSpec {
  readonly goal: string;
  readonly origin: "bug-fix";
  readonly culpritTaskId: string;
  readonly culpritTitle: string;
  readonly failureDiagnostic: string;
  readonly implicatedFiles: string[];
  readonly suggestedFix: string;
}

const SUGGESTED_FIX: Record<string, string> = {
  tsc: "Fix type errors in the listed files",
  smoke: "Fix the boot crash pointed to by the stack trace",
  reachability: "Re-mount the route files in the entry point",
};

function buildSuggestedFix(gateType: string): string {
  return SUGGESTED_FIX[gateType] ?? "Fix the failure in the listed files";
}

function buildTitle(gateType: string, culprit: AttributionResult): string {
  return `Bug-fix: ${gateType} failure from '${culprit.culpritTitle}' (${culprit.implicatedFiles.length} file(s))`;
}

export async function createBugFixTask(
  workItemRepo: WorkItemRepository,
  culprit: AttributionResult,
  gateOutput: string,
  gateType: string,
  runScope: string,
): Promise<void> {
  const allItems = await workItemRepo.listAll();
  const existing = allItems.find((item) => {
    if (item.status !== "Pending" && item.status !== "InProgress") return false;
    const spec = item.taskSpec;
    return spec?.origin === "bug-fix" && spec?.culpritTaskId === culprit.culpritTaskId;
  });
  if (existing) {
    console.log(
      `[bug-fix] skipping: existing bug-fix task ${existing.id} for culprit ${culprit.culpritTaskId}`,
    );
    return;
  }

  const culpritItem = await workItemRepo.findById(parseWorkItemId(culprit.culpritTaskId));
  const parentId = culpritItem?.parentId;

  const title = buildTitle(gateType, culprit);
  const diagnostic = gateOutput.length > 2000 ? gateOutput.slice(0, 2000) : gateOutput;

  const taskSpec: BugFixTaskSpec = {
    goal: `Fix: ${gateType} failure attributed to '${culprit.culpritTitle}'`,
    origin: "bug-fix",
    culpritTaskId: culprit.culpritTaskId,
    culpritTitle: culprit.culpritTitle,
    failureDiagnostic: diagnostic,
    implicatedFiles: culprit.implicatedFiles,
    suggestedFix: buildSuggestedFix(gateType),
  };

  const item = createPendingWorkItem("Task", title, runScope, parentId, diagnostic, { ...taskSpec });
  await PlanningService.createWorkItem(workItemRepo, item);
  console.log(
    `[bug-fix] created task ${item.id}: ${title}`,
  );
}
