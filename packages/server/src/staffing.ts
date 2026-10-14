import type { AgentStaffing, TaskDescriptor } from "@ashara/development";
import type { ResolvedModel } from "@ashara/llm-gateway";
import { RoleNotInRoster, RosterUnreadable, parseStoredRoster, roleInRoster } from "@ashara/organization";
import type { ProjectId, WorkItemId } from "@ashara/shared";

type Staffing = Awaited<ReturnType<AgentStaffing["staff"]>>;

/** The work item's stored owner: absent when the row is gone, null when it has no owner. */
type StoredOwner = { readonly kind: "absent" } | { readonly kind: "found"; readonly ownerRoleId: string | null };

interface StaffingDeps {
  readonly ownerOf: (taskId: WorkItemId) => Promise<StoredOwner>;
  /** The roster_roles rows of the project's latest revision, unparsed. */
  readonly latestRosterRows: (projectId: ProjectId) => Promise<unknown>;
  /** The project's latest roster revision; null when it has none. */
  readonly latestRosterRevision: (projectId: ProjectId) => Promise<number | null>;
  /** The attempt's model; throws when none can be resolved, which fails the dispatch. */
  readonly resolveModel: (task: TaskDescriptor) => ResolvedModel;
}

/**
 * Staffs each attempt with the work item's owner role, read from Organization's latest stored
 * roster (s-team-roster-m1): an item without an owner, or whose owner the roster does not hold
 * (or whose roster cannot be read), is owner-unresolved and blocks. No default role exists.
 */
export function createAgentStaffing(deps: StaffingDeps): AgentStaffing {
  return {
    async staff(task): Promise<Staffing> {
      // Read before the rows, so the revision recorded is never newer than the roster judged.
      const rosterRevision = await deps.latestRosterRevision(task.projectId);
      const owner = await deps.ownerOf(task.id);
      if (owner.kind === "absent") {
        return { kind: "owner-unresolved", ownerRoleId: null, rosterRevision, reason: "the work item row is gone" };
      }
      const { ownerRoleId } = owner;
      if (ownerRoleId === null) {
        return { kind: "owner-unresolved", ownerRoleId, rosterRevision, reason: "the work item has no owner role" };
      }
      const rows = await deps.latestRosterRows(task.projectId);
      try {
        const role = roleInRoster(parseStoredRoster(task.projectId, rows), ownerRoleId);
        return { kind: "staffed", staff: { role: { id: role.id, name: role.name }, model: deps.resolveModel(task) } };
      } catch (err) {
        if (!(err instanceof RosterUnreadable || err instanceof RoleNotInRoster)) throw err;
        return { kind: "owner-unresolved", ownerRoleId, rosterRevision, reason: err.message };
      }
    },
  };
}
