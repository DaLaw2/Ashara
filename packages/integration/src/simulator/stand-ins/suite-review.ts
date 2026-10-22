import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { MISREAD_REJECTION_MARKER } from "../product.js";
import type { ObservedReview } from "../client-reports.js";
import type { CheckSpec } from "../product.js";
import type { CheckRow, StandInContext, TaskRow } from "./context.js";
import { citedItemSchema, latestChecks, ownSpecOf, specsOf, taskInProgress } from "./context.js";
import { BLIND_SPOTS_ASKED } from "./recognised-wording.js";
import { StandInUnanswerable, promptText, providerOf, structuredAnswer } from "./responses.js";

/** One review task's round as its persona reads it: a round is the check revisions read; each call of it counts. */
interface ReviewRound {
  readonly checks: string;
  readonly round: number;
  calls: number;
  first: unknown[] | null;
}

/**
 * What one suite review call read: its review task and the check revisions under review, each `<task id>@<revision>`.
 */
type ReviewRead = Omit<ObservedReview, "provider" | "blindSpots" | "problems">;

function requiresAny(spec: CheckSpec | null, behaviours: readonly string[]): boolean {
  return spec !== null && spec.requires.some((behaviour) => behaviours.includes(behaviour));
}

/** Quality's suite review, honest or as the seed's reviewer persona, as the stand-in answers it. */
export class SuiteReviewStandIn {
  /** Persona findings worded so far: each new one is worded anew. */
  private personaWords = 0;
  /**
   * Each review task's current round: the check revisions it reads, how many calls read them, the first call's answer.
   */
  private readonly reviewRounds = new Map<string, ReviewRound>();
  /** The first rejection a resurrecting reviewer made in each project, raised again word for word ever after. */
  private readonly resurrected = new Map<string, unknown>();
  /**
   * Every suite review the stand-ins answered with a whole answer, in order (client-reports.ts
   * unconfirmedAtPassedSweeps).
   */
  private readonly answeredReviews: ObservedReview[] = [];

  constructor(private readonly context: StandInContext) {}

  /**
   * Every suite review answered so far, as the stand-ins saw it, outside production's records: the
   * oracle that holds a verified item to two families' clean reviews reads these, never the claim
   * production recorded.
   */
  observed(): readonly ObservedReview[] {
    return this.answeredReviews;
  }

  respond(options: LanguageModelV4CallOptions, modelId: string): Promise<LanguageModelV4GenerateResult> {
    // Kept per call, never on the instance: two lanes' reviews interleave between answer and delivery.
    let read: ReviewRead | null = null;
    return structuredAnswer(
      this.context,
      options,
      "suite-review",
      async () => {
        const reviewed = await this.review();
        read = reviewed.read;
        return reviewed.answer;
      },
      (answer) => {
        if (read !== null) {
          this.answeredReviews.push({
            ...read,
            provider: providerOf(modelId),
            blindSpots: promptText(options).includes(BLIND_SPOTS_ASKED),
            problems: answer.problems,
          });
        }
      },
    );
  }

  /**
   * The suite review finds each contradictory or out-of-vision check with the profile's probability.
   * A contradiction names the two checks, each with its command quoted as what it requires: the
   * contradictory check and a check of another check task that requires what it forbids. A wrong
   * check contradicts no other check: only a run of it on correct work witnesses it (a dispute).
   * A doubting review names a cited item of a sound suite as undecided, which only another model
   * family's agreement could act on.
   */
  private async review(): Promise<{ readonly answer: { readonly problems: unknown[] }; readonly read: ReviewRead }> {
    // A review is a task of its own (origin review): the checks it reads are its project's.
    const task = await taskInProgress(this.context);
    const rows = await latestChecks(this.context, task.projectId);
    const underReview = await this.checkTasksUnderReview(task.id);
    const read: ReviewRead = {
      reviewTaskId: task.id,
      checks: [
        ...new Set(
          rows.filter((row) => underReview.includes(row.checkTaskId)).map((row) => `${row.taskId}@${row.revision}`),
        ),
      ].sort(),
    };
    const honest = await this.honestReview(rows);
    if (this.context.personas.of("suite-review") === "honest") return { answer: { problems: honest }, read };
    return { answer: { problems: await this.reviewAsPersona(task, rows, honest) }, read };
  }

  private async honestReview(rows: readonly CheckRow[]): Promise<unknown[]> {
    const problems: unknown[] = [];
    for (const row of rows) {
      const own = ownSpecOf(row);
      if (
        own?.kind !== "contradictory" ||
        !this.context.tape.chance("model.suite-review.catch", this.context.rates.reviewCatch)
      )
        continue;
      const partner = rows.find(
        (other) => other.checkTaskId !== row.checkTaskId && requiresAny(ownSpecOf(other), own.forbids),
      );
      if (partner === undefined) continue;
      problems.push({
        checkTasks: [row.checkTaskId, partner.checkTaskId],
        kind: "contradiction",
        conflict: {
          first: { checkTask: row.checkTaskId, check: row.name, requires: row.command },
          second: { checkTask: partner.checkTaskId, check: partner.name, requires: partner.command },
        },
        problem: `Check ${row.name} forbids [${own.forbids.join(", ")}], which check ${partner.name} requires.`,
        evidence: `${row.command}; ${partner.command}`,
      });
    }
    for (const row of rows) {
      for (const spec of specsOf(row.files)) {
        if (spec.kind !== "out_of_vision") continue;
        if (!this.context.tape.chance("model.suite-review.catch", this.context.rates.reviewCatch)) continue;
        const cited = await this.citedBy(row.checkTaskId);
        problems.push({
          checkTasks: [row.checkTaskId],
          kind: "outside-vision",
          check: row.name,
          judgedItems: cited.map((item) => item.id),
          missingClause: `does ${spec.requires.join(" and ")}`,
          problem:
            `Check ${row.name} asks for behaviour no vision item names: it requires ` +
            `[${spec.requires.join(", ")}] and forbids [${spec.forbids.join(", ")}].`,
          evidence: row.command,
        });
      }
    }
    // A misread: a correct check rejected as outside the vision, quoting as missing the very text its cited item
    // states. Z0 must find that text in the cited item and discard the rejection, so a correct check is never reopened
    // on it.
    const correct = rows.find((row) => specsOf(row.files).some((spec) => spec.kind === "correct"));
    if (
      correct !== undefined &&
      this.context.tape.chance("model.suite-review.misread", this.context.rates.reviewMisread)
    ) {
      const [item] = await this.citedBy(correct.checkTaskId);
      if (item !== undefined) {
        this.context.onModelCall({ site: "suite-review", action: "misread" });
        problems.push({
          checkTasks: [correct.checkTaskId],
          kind: "outside-vision",
          check: correct.name,
          judgedItems: [item.id],
          missingClause: item.text,
          problem: `Check ${correct.name} asks for behaviour no cited item names (${MISREAD_REJECTION_MARKER}).`,
          evidence: correct.command,
        });
      }
    }
    const sound = rows.find((row) => ownSpecOf(row)?.kind === "correct");
    if (
      sound !== undefined &&
      this.context.tape.chance("model.suite-review.undecided", this.context.rates.reviewMisread)
    ) {
      const [item] = await this.citedBy(sound.checkTaskId);
      if (item !== undefined) {
        this.context.onModelCall({ site: "suite-review", action: "undecided" });
        problems.push({
          checkTasks: [sound.checkTaskId],
          kind: "undecided-item",
          item: item.id,
          problem: `No check of the suite is read as deciding ${item.id}.`,
          evidence: sound.command,
        });
      }
    }
    return problems;
  }

  /**
   * The review as the seed's reviewer persona answers it (personas.ts). Its findings name only the
   * correct checks of the check tasks under review, read from the universe's own check kinds, so
   * what it raises is plausible and wrong; how production weighs it is production's.
   */
  private async reviewAsPersona(
    task: TaskRow,
    rows: readonly CheckRow[],
    honest: readonly unknown[],
  ): Promise<unknown[]> {
    const { personas, onModelCall } = this.context;
    const persona = personas.of("suite-review");
    const underReview = await this.checkTasksUnderReview(task.id);
    const read = rows.filter((row) => underReview.includes(row.checkTaskId));
    const round = this.reviewRound(task.id, read);
    // The same model asked again with the same prompt answers as it did: the copy is the persona, whatever fired.
    if (persona === "correlated-second" && round.calls > 1 && round.first !== null) {
      onModelCall({ site: "suite-review", action: "persona correlated-second: the first review's answer again" });
      return round.first;
    }
    if (!personas.fires("suite-review")) return this.answered(round, [...honest]);
    onModelCall({ site: "suite-review", action: `persona ${persona} (round ${round.round}, review ${round.calls})` });
    const targets = [
      ...new Set(read.filter((row) => ownSpecOf(row)?.kind === "correct").map((row) => row.checkTaskId)),
    ];
    const target = (n: number): CheckRow | undefined => {
      const id = targets[n % Math.max(1, targets.length)];
      return read.find((row) => row.checkTaskId === id && ownSpecOf(row)?.kind === "correct");
    };
    switch (persona) {
      case "never-satisfied": {
        const row = target(0);
        if (row === undefined) return this.answered(round, [...honest]);
        const cited = await this.citedBy(row.checkTaskId);
        const item = cited[(round.round + round.calls) % Math.max(1, cited.length)];
        const undecided =
          item === undefined
            ? []
            : [
                {
                  checkTasks: [row.checkTaskId],
                  kind: "undecided-item",
                  item: item.id,
                  problem: `No check is read as deciding ${item.id} (reading ${this.nextWording()}).`,
                  evidence: row.command,
                },
              ];
        return this.answered(round, [...honest, await this.rejection(row), ...undecided]);
      }
      case "rotating": {
        const row = target(round.round - 1);
        return this.answered(round, row === undefined ? [...honest] : [...honest, await this.rejection(row)]);
      }
      case "resurrecting": {
        const earlier = this.resurrected.get(task.projectId);
        if (earlier !== undefined) return this.answered(round, [...honest, earlier]);
        const row = target(0);
        if (row === undefined) return this.answered(round, [...honest]);
        const first = await this.rejection(row);
        this.resurrected.set(task.projectId, first);
        return this.answered(round, [...honest, first]);
      }
      case "flip-flop": {
        if (round.round % 2 === 0) return this.answered(round, []);
        const row = target(0);
        return this.answered(
          round,
          row === undefined ? [...honest] : [...honest, await this.rejection(row, `its round ${round.round}`)],
        );
      }
      case "self-refuting": {
        const row = target(0);
        if (row === undefined) return this.answered(round, [...honest]);
        const side = { checkTask: row.checkTaskId, check: row.name, requires: row.command };
        return this.answered(round, [
          ...honest,
          {
            checkTasks: [row.checkTaskId],
            kind: "contradiction",
            conflict: { first: side, second: side },
            problem: `Check ${row.name} both requires and forbids what it runs.`,
            evidence: row.command,
          },
        ]);
      }
      case "correlated-second": {
        const row = target(0);
        return this.answered(round, row === undefined ? [...honest] : [...honest, await this.rejection(row)]);
      }
      case "lazy-pass":
        return this.answered(round, []);
      case "honest":
        return this.answered(round, [...honest]);
    }
  }

  /** `problems` as this call's answer, kept as its round's first when it is the first call of the round. */
  private answered(round: ReviewRound, problems: unknown[]): unknown[] {
    if (round.calls === 1) round.first = problems;
    return problems;
  }

  /** A fresh wording, never used before in the run. */
  private nextWording(): string {
    this.personaWords += 1;
    return `variant ${this.personaWords}`;
  }

  /**
   * A rejection of a correct check as outside the vision, its missing clause a paraphrase no cited
   * item states word for word (the blind spot Z0 names), worded anew unless `wording` fixes it.
   */
  private async rejection(row: CheckRow, wording?: string): Promise<unknown> {
    const spec = ownSpecOf(row);
    /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a check whose spec is
       unreadable requires nothing the clause can name; no oracle reads it */
    const requires = spec?.requires ?? [];
    const cited = await this.citedBy(row.checkTaskId);
    return {
      checkTasks: [row.checkTaskId],
      kind: "outside-vision",
      check: row.name,
      judgedItems: cited.map((item) => item.id),
      missingClause: `performs ${requires.join(" and ")} in ${wording ?? `its ${this.nextWording()}`}`,
      problem: `Check ${row.name} asks for a form of behaviour none of its cited items names.`,
      evidence: row.command,
    };
  }

  /** The review's round: a new one whenever the check revisions it reads change; this call counted in it. */
  private reviewRound(reviewTaskId: string, read: readonly CheckRow[]): ReviewRound {
    const checks = [...new Set(read.map((row) => `${row.taskId}@${row.revision}`))].sort().join(" ");
    const known = this.reviewRounds.get(reviewTaskId);
    if (known !== undefined && known.checks === checks) {
      known.calls += 1;
      return known;
    }
    const round: ReviewRound = { checks, round: known === undefined ? 1 : known.round + 1, calls: 1, first: null };
    this.reviewRounds.set(reviewTaskId, round);
    return round;
  }

  /** The finished check tasks a review task depends on: the suites it reads. */
  private async checkTasksUnderReview(reviewTaskId: string): Promise<string[]> {
    const result = await this.context.observer.execute(sql`
      SELECT w.id FROM dependencies d JOIN work_items w ON w.id = d.to_id
      WHERE d.from_id = ${reviewTaskId} AND w.work_kind = 'check' AND w.status = 'Completed'
      ORDER BY w.created_at, w.id`);
    return z
      .array(z.object({ id: z.string() }))
      .parse(result.rows)
      .map((row) => row.id);
  }

  /** The vision items a check task cites, as its task_spec stores them. */
  private async citedBy(checkTaskId: string): Promise<Array<z.infer<typeof citedItemSchema>>> {
    const result = await this.context.observer.execute(
      sql`SELECT task_spec->'sources' AS sources FROM work_items WHERE id = ${checkTaskId}`,
    );
    const [row] = z.array(z.object({ sources: z.array(citedItemSchema).nullable() })).parse(result.rows);
    if (row === undefined) throw new StandInUnanswerable("suite-review", `check task ${checkTaskId} is not on record`);
    /* eslint-disable-next-line no-restricted-syntax -- policy default: stand-in test plumbing, a check task with no
       sources cites none; no oracle reads it */
    return row.sources ?? [];
  }
}
