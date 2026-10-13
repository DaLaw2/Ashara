import type { DomainEvent } from "@ashara/shared";

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}
