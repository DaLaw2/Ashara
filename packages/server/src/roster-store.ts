import { ProjectRepository, listProjectsAwaitingRoster, recordFirstRoster } from "@ashara/db";
import type { createDb } from "@ashara/db";
import type { RosterStore } from "@ashara/organization";

/** Organization's roster store over projects, vision_documents and roster_roles. */
export function createRosterStore(db: ReturnType<typeof createDb>): RosterStore {
  const projects = new ProjectRepository(db);
  return {
    async projectsAwaitingRoster() {
      const rows = await listProjectsAwaitingRoster(db);
      return rows.map((row) => ({
        projectId: row.projectId,
        vision: row.vision,
      }));
    },
    recordRoster: (roster) =>
      recordFirstRoster(db, {
        projectId: roster.projectId,
        revision: roster.revision,
        visionVersion: roster.visionVersion,
        roles: roster.roles.map((role) => ({
          roleId: role.id,
          name: role.name,
          responsibility: role.responsibility,
          capabilities: role.capabilities,
        })),
      }),
    blockProject: (projectId, cause) => projects.block(projectId, cause),
  };
}
