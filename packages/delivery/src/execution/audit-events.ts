import type { EventStoreRepository } from "@ashara/db";
import type { DomainEvent, Logger } from "@ashara/shared";

export async function publishBestEffort(
  deps: { readonly eventStore: Pick<EventStoreRepository, "publish">; readonly logger: Logger },
  workItemId: string,
  events: DomainEvent[],
  site: string,
): Promise<void> {
  for (const event of events) {
    try {
      await deps.eventStore.publish(event);
    } catch (publishError) {
      // eslint-disable-next-line ashara/catch-continue -- best effort: the status transition is committed before its events are published; domain_events is an operator audit log (GET /events is the bearer route) that no verdict, counter, charge or client text reads: each reads state written in the transition's own transaction, work_item_transitions for starts and reopens
      deps.logger.warn(
        "delivery.event-publish-failed",
        `failed to publish audit event for ${workItemId} (status transition already committed)`,
        { taskId: workItemId, site, eventType: event.eventType },
        publishError,
      );
    }
  }
}
