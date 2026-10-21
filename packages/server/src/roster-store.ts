import { projects } from "@ashara/db";
import type { createDb } from "@ashara/db";
import { projectUnplanned } from "@ashara/delivery/predicates";
import { noOpenStop, projectAtWork } from "@ashara/engagement/predicates";
import type { RosterStore } from "@ashara/organization";
import { listProjectsAwaitingRoster, recordFirstRoster } from "@ashara/organization/roster";

/** Organization's roster store over projects, vision_documents, work_items and roster_roles. */
export function createRosterStore(db: ReturnType<typeof createDb>): RosterStore {
  return {
    async projectsAwaitingRoster() {
      const rows = await listProjectsAwaitingRoster(db, [projectAtWork(), noOpenStop(projects.id), projectUnplanned(projects.id)]);
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
  };
}
