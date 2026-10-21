/**
 * Anti-Corruption Layer: Engagement's report-subject vocabulary.
 *
 * The subjects a report to the client is on (client_messages.reports_on), which Delivery's planning
 * reports name, read from Engagement's vocabulary entry alone (never its index). That entry imports
 * nothing, so it loads without a cycle.
 */

export { REPORT_SUBJECT } from "@ashara/engagement/report-subjects";
