// The kinds of work a task can be (migration 031, work_items.work_kind). Organization
// decides who owns each kind; Delivery, Execution and the Workplace read the kind of a
// task, so the vocabulary is published here.

export const WORK_KINDS = ["environment", "implementation", "check"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

/** A stored work_kind that names no kind of work. */
class WorkKindUnknown extends Error {
  constructor(readonly value: string) {
    super(`work kind ${JSON.stringify(value)} is not one of ${WORK_KINDS.join(", ")}`);
    this.name = "WorkKindUnknown";
  }
}

function isWorkKind(value: string): value is WorkKind {
  return WORK_KINDS.some((kind) => kind === value);
}

export function parseWorkKind(value: string): WorkKind {
  if (!isWorkKind(value)) throw new WorkKindUnknown(value);
  return value;
}
