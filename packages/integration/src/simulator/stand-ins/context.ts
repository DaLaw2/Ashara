import { sql } from "drizzle-orm";
import { z } from "zod";
import { CheckSpecSchema } from "../product.js";
import type { Database } from "../database.js";
import type { CheckSpec, Universe } from "../product.js";
import type { Personas } from "../personas.js";
import type { AdversaryRates } from "../profile.js";
import type { Tape } from "../tape.js";
import { StandInUnanswerable } from "./responses.js";

/** A schema a stand-in refused, as the run reports it. */
interface RefusedSchema {
  readonly model: string;
  readonly providerType: string;
  readonly what: string;
  readonly detail: string;
}

/** One model call as the trace records it. */
interface ModelCallRecord {
  readonly site: string;
  readonly action: string;
}

/** What the stand-ins read and decide with. Every project of the run shares one universe. */
export interface StandInContext {
  readonly tape: Tape;
  readonly rates: AdversaryRates;
  readonly universe: Universe;
  /** The seed's sticky personas (personas.ts): who misbehaves, and when. */
  readonly personas: Personas;
  readonly observer: Database;
  /** The run's projects (one, or two on one deployment's caps): an agent turn's task is one of theirs. */
  readonly projectIds: readonly string[];
  /** Set by the run once the first merge of an implementation is recorded: a late client change may follow. */
  readonly onModelCall: (call: ModelCallRecord) => void;
  /**
   * Once per request the model port receives, before it is answered: W1 counts work here, outside production
   * (termination.ts).
   */
  readonly onRequest: () => void;
  /** A request carried a schema its provider type refuses: the run reports it as a violation. */
  readonly onSchemaRefused: (refused: RefusedSchema) => void;
  /** The task whose lane makes the call (Interleaver.currentTask), or null outside a batch's tasks. */
  readonly laneTask: () => string | null;
  /** Before each agent turn, with the InProgress task it works on: a client may write while the task runs. */
  readonly onAgentTurn: (task: { readonly id: string; readonly projectId: string }) => Promise<void>;
}

const taskRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  taskSpec: z.unknown(),
  workKind: z.string().nullable(),
  dispatchCount: z.number(),
  infrastructureFaults: z.number(),
});

/** The InProgress task an agent turn or a review works on, as the observer reads it. */
export type TaskRow = z.infer<typeof taskRowSchema>;

const checkRowSchema = z.object({
  checkTaskId: z.string(),
  taskId: z.string(),
  revision: z.number().int(),
  name: z.string(),
  command: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

/** One stored check of a task's latest check revision. */
export type CheckRow = z.infer<typeof checkRowSchema>;

export const citedItemSchema = z.object({ id: z.string(), text: z.string() });

/** The task of the lane making the call: two of a batch are InProgress at once. */
export async function taskInProgress(context: StandInContext): Promise<TaskRow> {
  const { observer, projectIds } = context;
  const taskId = context.laneTask();
  if (taskId === null)
    throw new StandInUnanswerable("agent-runner", "an agent turn was made outside every task of a batch");
  const result = await observer.execute(sql`
    SELECT id, project_id AS "projectId", title, task_spec AS "taskSpec", work_kind AS "workKind",
      dispatch_count AS "dispatchCount",
      infrastructure_faults AS "infrastructureFaults"
    FROM work_items WHERE id = ${taskId} AND level = 'Task' AND status = 'InProgress'`);
  const [row] = z.array(taskRowSchema).parse(result.rows);
  if (row === undefined || !projectIds.includes(row.projectId)) {
    throw new StandInUnanswerable(
      "agent-runner",
      `the lane's task ${taskId} is not an InProgress task of the run's projects`,
    );
  }
  return row;
}

export async function latestChecks(context: StandInContext, projectId: string): Promise<CheckRow[]> {
  const result = await context.observer.execute(sql`
    SELECT c.check_task_id AS "checkTaskId", c.task_id AS "taskId", c.revision, c.name, c.command, c.files
    FROM task_checks c
    WHERE c.project_id = ${projectId}
      AND c.revision = (SELECT max(revision) FROM task_checks l WHERE l.task_id = c.task_id)
    ORDER BY c.task_id, c.name`);
  return z.array(checkRowSchema).parse(result.rows);
}

/** Whether `text` names behaviour `b` as a word of its own, so b1 is never read in b10. */
export function namesBehaviour(text: string, b: string): boolean {
  return new RegExp(String.raw`(^|[^A-Za-z0-9_])${b}($|[^A-Za-z0-9_])`).test(text);
}

/** The spec of one stored check: the spec file its command runs, or null when it runs none. */
export function ownSpecOf(row: CheckRow): CheckSpec | null {
  const [spec] = specsOf(row.files.filter((file) => row.command.endsWith(` ${file.path}`)));
  return spec === undefined ? null : spec;
}

/** The check specs a stored check's files hold; a file that is not one is skipped. */
export function specsOf(files: ReadonlyArray<{ readonly path: string; readonly content: string }>): CheckSpec[] {
  const specs: CheckSpec[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".json")) continue;
    let raw: unknown;
    try {
      /* eslint-disable-next-line no-restricted-syntax -- a stand-in model may import no product package
         (boundary-rules.toml stand-ins), so it cannot reach parseJson; CheckSpecSchema validates the value below */
      raw = JSON.parse(file.content);
    } catch (err) {
      /* eslint-disable-next-line ashara/catch-continue -- best effort: a stand-in model skips a check file that is
         not JSON; the real checks judge the task's work */
      console.warn(
        `[simulator] check file ${file.path} is not JSON, skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const spec = CheckSpecSchema.safeParse(raw);
    if (spec.success) specs.push(spec.data);
  }
  return specs;
}
