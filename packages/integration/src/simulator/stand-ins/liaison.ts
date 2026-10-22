import { sql } from "drizzle-orm";
import { z } from "zod";
import type { CorrectionKind } from "../correction-draws.js";
import type { StandInContext } from "./context.js";
import { citedItemSchema, namesBehaviour } from "./context.js";
import {
  ASSUMPTIONS_HEADING,
  INTERFACE_HEADING,
  OTHER_ASSUMPTIONS_HEADING,
  listsGuarantee,
  promptEntries,
} from "./recognised-wording.js";

/**
 * What a change message the client posts asks, as the scripted Liaison reads it: a drawn correction,
 * or the client's answer to a declined contract, confirming it as written or restating its guarantees.
 */
export type ClientAsk = CorrectionKind | "confirm-as-written" | "restate-unverifiable";

/** A guarantee as vision_documents.guarantees stores it: what the scripted correction restates. */
const storedGuaranteeSchema = z.object({
  id: z.string(),
  statement: z.string(),
  observable: z.object({ interface: z.array(z.string()), observation: z.string() }),
  refutedBy: z.array(z.string()),
});

/** The Liaison's reading of a client's answer and of a client's correction, as the stand-in answers them. */
export class LiaisonStandIn {
  /**
   * What the client's correction asks, set by the run as it posts it, and the task it was posted while InProgress, if
   * any.
   */
  private asked: { readonly kind: ClientAsk; readonly during: string | null } = {
    kind: "rewrite-guarantee",
    during: null,
  };

  constructor(private readonly context: StandInContext) {}

  /** The correction the client is about to post: the Liaison's reading of it asks this of the contract. */
  askCorrection(kind: ClientAsk, during: string | null): void {
    this.asked = { kind, during };
  }

  /**
   * The client's answer read as changing its question's assumption and contradicting the first other
   * assumption the prompt lists, which it restates, so every answer that has another assumption beside
   * its own is a multi-record reconciliation.
   */
  answer(prompt: string): unknown {
    const [other] = promptEntries(prompt, OTHER_ASSUMPTIONS_HEADING);
    const amends =
      other === undefined
        ? []
        : [
            {
              op: "amend-assumption",
              id: other.id,
              statement: `${other.text} The client's answer restates it.`,
              direction: "neutral",
            },
          ];
    return { reading: { verdict: "changes", statement: "Messages are in French.", kind: "undecided", amends } };
  }

  /**
   * The client's one correction, read as the kind the run asked for (askCorrection) against the
   * contract the prompt lists, of the project whose open change this is. Its target is the guarantee
   * cited by the task it was posted during while that task was InProgress, else by the last goal task
   * not yet started that no open task waits on, so the open work it does not touch stays open beside
   * the revision:
   * - rewrite-guarantee: the target restated whole with one more refuting observation (it widens, so
   *   the client is asked for no confirmation), its behaviour still named;
   * - add-guarantee: a guarantee naming every behaviour of the target's task, observed where the target is;
   * - withdraw-guarantee: the guarantee naming no behaviour, so no behaviour the client asked for is withdrawn;
   * - change-assumption: the first assumption restated;
   * - change-interface: the first interface entry restated;
   * - add-exclusion: one more thing left out, which no task cites and every guarantee is read as resting on.
   * - confirm-as-written: no change, and nothing confirmed, since no change awaits confirmation;
   * - restate-unverifiable: every guarantee restated whole, observed in what the product outputs.
   * A kind with nothing on record to act on (no target, no such guarantee, assumption or entry) adds the exclusion.
   */
  async correction(prompt: string): Promise<unknown> {
    const exclusion = {
      correction: { ops: [{ op: "add-exclusion", text: "Coloured output.", direction: "narrows" }], confirms: [] },
    };
    const read = (op: Record<string, unknown> | null): unknown =>
      op === null ? exclusion : { correction: { ops: [op], confirms: [] } };
    const { observer, projectIds, universe } = this.context;
    const { kind, during } = this.asked;
    for (const projectId of projectIds) {
      const open = await observer.execute(sql`
        SELECT 1 FROM client_messages WHERE project_id = ${projectId} AND direction = 'inbound' AND kind = 'change'
          AND consumed_at IS NULL`);
      if (open.rows.length === 0) continue;
      const vision = await observer.execute(sql`
        SELECT guarantees FROM vision_documents WHERE project_id = ${projectId} ORDER BY version DESC LIMIT 1`);
      const [latest] = z.array(z.object({ guarantees: z.array(storedGuaranteeSchema) })).parse(vision.rows);
      if (latest === undefined || !latest.guarantees.every((g) => listsGuarantee(prompt, g.id, g.statement))) continue;
      if (kind === "add-exclusion") return exclusion;
      if (kind === "confirm-as-written") return { correction: { ops: [], confirms: [] } };
      if (kind === "restate-unverifiable") {
        const ops = latest.guarantees.map((g) => ({
          op: "amend-guarantee",
          id: g.id,
          statement: g.statement,
          interface: g.observable.interface,
          observation: "output",
          refutedBy: g.refutedBy,
          direction: "neutral",
        }));
        return { correction: { ops, confirms: [] } };
      }
      if (kind === "withdraw-guarantee") {
        const unnamed = latest.guarantees.find((g) => !universe.behaviours.some((b) => namesBehaviour(g.statement, b)));
        return read(unnamed === undefined ? null : { op: "withdraw-guarantee", id: unnamed.id, direction: "narrows" });
      }
      if (kind === "change-assumption") {
        const [assumption] = promptEntries(prompt, ASSUMPTIONS_HEADING);
        return read(
          assumption === undefined
            ? null
            : {
                op: "amend-assumption",
                id: assumption.id,
                statement: `${assumption.text} The client's correction restates it.`,
                direction: "neutral",
              },
        );
      }
      if (kind === "change-interface") {
        const [entry] = promptEntries(prompt, INTERFACE_HEADING);
        return read(
          entry === undefined
            ? null
            : {
                op: "amend-interface",
                id: entry.id,
                text: `${entry.text} (as the client's correction states it)`,
                direction: "neutral",
              },
        );
      }
      const cited = await this.correctionCites(projectId, during);
      const target = latest.guarantees.find((g) => cited.includes(g.id));
      if (target === undefined) return exclusion;
      if (kind === "add-guarantee") {
        const named = universe.tasks.find((task) => task.behaviours.some((b) => namesBehaviour(target.statement, b)));
        if (named === undefined) return exclusion;
        const behaviours = named.behaviours.join(", ");
        return read({
          op: "add-guarantee",
          statement: `${behaviours} keeps working as the client's correction adds.`,
          interface: target.observable.interface,
          observation: target.observable.observation,
          refutedBy: [`${behaviours} stops working after the client's correction.`],
          direction: "widens",
        });
      }
      return read({
        op: "amend-guarantee",
        id: target.id,
        statement: `${target.statement} It holds as the client's correction restates it.`,
        interface: target.observable.interface,
        observation: target.observable.observation,
        refutedBy: [...target.refutedBy, `${target.statement} fails after the client's correction.`],
        direction: "widens",
      });
    }
    return exclusion;
  }

  /**
   * The vision keys a correction's target is read from: the task it was posted during, else the goal tasks not yet
   * started that no open task waits on, latest first.
   */
  private async correctionCites(projectId: string, during: string | null): Promise<string[]> {
    const { observer } = this.context;
    const rows =
      during === null
        ? await observer.execute(sql`
            SELECT w.task_spec->'sources' AS sources FROM work_items w
            WHERE w.project_id = ${projectId} AND w.level = 'Task' AND w.status = 'Pending'
              AND w.task_spec->>'origin' = 'decomposition'
              AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN work_items o ON o.id = d.from_id
                              WHERE d.to_id = w.id AND o.status IN ('Pending', 'Blocked', 'Failed'))
            ORDER BY w.created_at DESC, w.id DESC`)
        : await observer.execute(
            sql`SELECT w.task_spec->'sources' AS sources FROM work_items w WHERE w.id = ${during}`,
          );
    return z
      .array(z.object({ sources: z.array(citedItemSchema).nullable() }))
      .parse(rows.rows)
      .flatMap((row) => (row.sources === null ? [] : row.sources.map((source) => source.id)));
  }
}
