import { projects } from "@ashara/db";
import type { Database } from "@ashara/db";
import { noPlanningOutcome, projectUnplanned } from "@ashara/delivery/predicates";
import { noOpenStop, noUnverifiableContractHeld, projectAtWork } from "@ashara/engagement/predicates";
import type { RosterStore } from "@ashara/organization";
import { listProjectsAwaitingRoster, recordFirstRoster } from "@ashara/organization/roster";

/** Organization's roster store over projects, vision_documents, work_items and roster_roles. */
export function createRosterStore(db: Database): RosterStore {
  return {
    projectsAwaitingRoster: () =>
      listProjectsAwaitingRoster(db, [projectAtWork(), noOpenStop(projects.id), projectUnplanned(projects.id), noPlanningOutcome(projects.id), noUnverifiableContractHeld(projects.id)]),
    recordRoster: (roster) => recordFirstRoster(db, roster),
  };
}
