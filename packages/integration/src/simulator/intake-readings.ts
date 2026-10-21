import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.js";

/*
 * I3's intake clause: a reading of a
 * tender that asks the client nothing is a claim that the tender leaves nothing open worth asking, and
 * is held to a second reading by another model, as a clean suite review is. Judged on what the
 * stand-ins were asked and answered, outside production, against intake_readings and
 * the questions posted: never on production's own account of whether it asked.
 */

/**
 * One tender reading as the stand-ins saw it: a first reading answered whole, a second reading asked
 * (before any answer, whatever came of it), or a second reading answered whole. `projectId` is the
 * project the call's pending llm_calls row names; null when none did.
 */
export interface ObservedIntake {
  readonly projectId: string | null;
  readonly kind: "reading" | "second-asked" | "second-answered";
  readonly provider: string;
  readonly model: string;
  /** The questions the answer asked; 0 for a second reading asked. */
  readonly questions: number;
}

const readingRow = z.object({
  firstProvider: z.string(),
  firstModel: z.string(),
  firstQuestions: z.number(),
  confirmation: z.string(),
  secondStrength: z.string().nullable(),
  secondQuestions: z.number().nullable(),
});

/** What one project's records hold of its tender's reading. */
export interface IntakeRecords {
  /** Vision v1 is written: intake recorded its reading. */
  readonly visionWritten: boolean;
  /** Its intake_readings row, or null when none is. */
  readonly reading: z.infer<typeof readingRow> | null;
  /** The questions posted to the client. */
  readonly questionsPosted: number;
}

export async function readIntakeRecords(db: Database, projectId: string): Promise<IntakeRecords> {
  const reading = z.array(readingRow).parse(
    (
      await db.execute(sql`
        SELECT first_provider AS "firstProvider", first_model AS "firstModel", first_questions AS "firstQuestions",
               confirmation, second_strength AS "secondStrength", second_questions AS "secondQuestions"
        FROM intake_readings WHERE project_id = ${projectId}`)
    ).rows,
  );
  const [counts] = z.array(z.object({ visions: z.coerce.number(), questions: z.coerce.number() })).parse(
    (
      await db.execute(sql`
        SELECT (SELECT count(*) FROM vision_documents WHERE project_id = ${projectId}) AS visions,
               (SELECT count(*) FROM client_messages WHERE project_id = ${projectId} AND direction = 'outbound'
                 AND kind = 'question') AS questions`)
    ).rows,
  );
  if (counts === undefined) throw new IntakeCountsMissing(projectId);
  const [row] = reading;
  return {
    visionWritten: counts.visions > 0,
    reading: row === undefined ? null : row,
    questionsPosted: counts.questions,
  };
}

/** The count query returned no row, which it always returns: the clause would judge against nothing. */
class IntakeCountsMissing extends Error {
  constructor(readonly projectId: string) {
    super(`intake records of project ${projectId}: the vision and question counts returned no row`);
    this.name = "IntakeCountsMissing";
  }
}

/** How independent a second reading's model is of the first's, from the two models alone. */
function strengthOf(first: ObservedIntake, second: ObservedIntake): string {
  if (first.provider !== second.provider) return "other-family";
  return first.model === second.model ? "same-model" : "same-family-other-model";
}

/**
 * The clause on one project, once its vision is written: the last reading of its tender the stand-ins
 * answered whole is the one intake recorded (an earlier one was lost to a crash or a failed read). When
 * it asked nothing, a second reading of it was asked; the record names the second reading that
 * answered, at the strength its model has against the first, and the questions it asked are the ones
 * posted, or the record says none answered. A reading that asked questions is recorded as needing no
 * confirmation.
 */
export function lazyIntakes(
  projectId: string,
  records: IntakeRecords,
  observed: readonly ObservedIntake[],
): Array<{ readonly key: string; readonly statement: string }> {
  const found: Array<{ readonly key: string; readonly statement: string }> = [];
  if (observed.some((each) => each.projectId === null)) {
    found.push({
      key: "intake-unattributed",
      statement: "a tender reading the stand-ins were asked for names no project's pending intake call",
    });
  }
  if (!records.visionWritten) return found;
  const ours = observed.map((each, at) => ({ each, at })).filter(({ each }) => each.projectId === projectId);
  const last = ours.filter(({ each }) => each.kind === "reading").at(-1);
  if (last === undefined) return found;
  const first = last.each;
  const after = ours.filter(({ at }) => at > last.at).map(({ each }) => each);
  const { reading } = records;
  if (first.questions > 0) {
    if (reading !== null && reading.confirmation !== "not-needed") {
      found.push({
        key: "intake-reading-record",
        statement:
          `the tender's reading asked ${first.questions} question(s), yet intake_readings records it ` +
          `${reading.confirmation}`,
      });
    }
    return found;
  }
  if (!after.some((each) => each.kind === "second-asked")) {
    found.push({
      key: "lazy-intake",
      statement:
        `the tender's reading by ${first.provider}/${first.model} asked the client nothing, and no second ` +
        `reading of it was asked`,
    });
    return found;
  }
  if (reading === null) {
    found.push({
      key: "intake-reading-record",
      statement:
        "the tender's reading asked the client nothing and was put to a second reading, but intake_readings " +
        "records no reading",
    });
    return found;
  }
  const answered = after.filter((each) => each.kind === "second-answered").at(-1);
  if (answered === undefined) {
    if (reading.confirmation !== "unconfirmed") {
      found.push({
        key: "intake-reading-record",
        statement:
          `no second reading of the tender answered whole, yet intake_readings records it ` + `${reading.confirmation}`,
      });
    }
    return found;
  }
  const strength = strengthOf(first, answered);
  const confirmation = answered.questions > 0 ? "questions-raised" : "confirmed";
  if (reading.confirmation !== confirmation || reading.secondStrength !== strength) {
    found.push({
      key: "intake-reading-record",
      statement:
        `the second reading by ${answered.provider}/${answered.model} (${strength}) asked ` +
        `${answered.questions} question(s), ` +
        `yet intake_readings records ${reading.confirmation} at ${reading.secondStrength ?? "no strength"}`,
    });
  }
  if (records.questionsPosted !== answered.questions) {
    found.push({
      key: "intake-questions",
      statement:
        `the second reading asked ${answered.questions} question(s), but ${records.questionsPosted} were ` +
        `posted to the client`,
    });
  }
  return found;
}
