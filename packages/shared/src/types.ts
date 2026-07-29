// ---------------------------------------------------------------------------
// Domain Events
// ---------------------------------------------------------------------------

export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly timestamp: Date;
  readonly sourceContext: string;
  readonly correlationId?: string;
  // open-by-design: event payload is BC-specific and genuinely caller-defined
  readonly payload: Record<string, unknown>;
}

export function createDomainEvent(
  eventType: string,
  sourceContext: string,
  // open-by-design: event payload is BC-specific and genuinely caller-defined
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date(),
    sourceContext,
    payload,
  };
}

