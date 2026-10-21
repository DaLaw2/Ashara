/**
 * Anti-Corruption Layer: Organization's stored roster.
 *
 * Whether a project has a roster, whether a role is one of its latest revision, and that revision's
 * rows, read from Organization's roster entry alone (never its index): the first plan admits a project
 * and checks each task's owner by them inside its own statements, and the planners read the rows.
 */

export { hasRoster, latestRosterRoles, roleOfLatestRoster } from "@ashara/organization/roster";
