import {
  EnvironmentBuildRepository,
  ProjectRepository,
  WorkItemRepository,
  latestRosterRevision,
  listDueBlockReports,
  postProjectBlockReport,
  postTaskBlockedReport,
} from "@ashara/db";
import type { createDb } from "@ashara/db";
import { currentEnvironmentBuilt } from "@ashara/development";
import type { BlockReportStore } from "@ashara/engagement";
import type { ParkedExitChecks } from "@ashara/orchestrator";

type Db = ReturnType<typeof createDb>;

/** Engagement's block-report store over project_blocks, work_items and client_messages (migration 040). */
export function createBlockReportStore(db: Db): BlockReportStore {
  const projects = new ProjectRepository(db);
  return {
    dueReports: () => listDueBlockReports(db),
    postProjectReport: (episodeId, on, body) => postProjectBlockReport(db, episodeId, on, body),
    postTaskReport: (taskId, body) => postTaskBlockedReport(db, taskId, body),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}

/** The automatic exits' reads: Organization's roster revisions and the project's environment builds. */
export function createParkedExitChecks(db: Db): ParkedExitChecks {
  const projects = new ProjectRepository(db);
  const workItems = new WorkItemRepository(db);
  const builds = new EnvironmentBuildRepository(db);
  return {
    latestRosterRevision: (projectId) => latestRosterRevision(db, projectId),
    async environmentBuilt(projectId) {
      const project = await projects.get(projectId);
      if (project === null || project.workspacePath === null) return false;
      return currentEnvironmentBuilt(
        projectId,
        project.workspacePath,
        { forVersion: (id, version) => workItems.environmentStatementFor(id, version) },
        { hasSucceeded: async (id, version) => (await builds.findSucceeded(id, version)) !== null },
      );
    },
  };
}
