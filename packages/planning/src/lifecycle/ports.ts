import type { DomainEvent } from "@ashara/shared";

export interface EventPublisher {
  publish(
    event: DomainEvent,
    priority: "External" | "Internal",
  ): Promise<void>;
}

export interface EventSink {
  emit(event: { readonly event: string; readonly [key: string]: unknown }): void;
}