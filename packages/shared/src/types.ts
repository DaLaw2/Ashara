// ---------------------------------------------------------------------------
// Domain Events
// ---------------------------------------------------------------------------

/**
 * The ten bounded contexts, the only sources of a domain event written now. A row written
 * before a context was named (source_context 'planning') stays readable: no reader parses
 * source_context into this union.
 */
type BoundedContext =
  | "engagement"
  | "delivery"
  | "organization"
  | "quality"
  | "workplace"
  | "execution-infra"
  | "finance"
  | "security"
  | "knowledge"
  | "model-access";

export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly timestamp: Date;
  readonly sourceContext: BoundedContext;
  readonly correlationId?: string;
  // open-by-design: event payload is BC-specific and genuinely caller-defined
  readonly payload: Record<string, unknown>;
}

export function createDomainEvent(
  eventType: string,
  sourceContext: BoundedContext,
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

