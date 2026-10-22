import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ObservedIntake } from "../intake-readings.js";
import type { StandInContext } from "./context.js";
import { providerOf, structuredAnswer } from "./responses.js";

/** The key of the guarantee the scripted intake drafts naming no behaviour: after every behaviour's. */
function messagesGuarantee(behaviours: number): string {
  return `G${behaviours + 1}`;
}

/** The Liaison's reading of a tender, first and second, as the stand-in answers it. */
export class IntakeStandIn {
  /** Every tender reading the stand-ins were asked for or answered whole, in order (intake-readings.ts lazyIntakes). */
  private readonly readings: ObservedIntake[] = [];

  constructor(private readonly context: StandInContext) {}

  /**
   * Every tender reading asked or answered so far, as the stand-ins saw it, outside production's
   * records: the oracle that holds a reading that asked nothing to a second reading reads these.
   */
  observed(): readonly ObservedIntake[] {
    return this.readings;
  }

  async reading(options: LanguageModelV4CallOptions, modelId: string): Promise<LanguageModelV4GenerateResult> {
    const projectId = await this.intakeProject();
    const model = modelId.slice(providerOf(modelId).length + 1);
    // Only the first project's tender is the unverifiable one: its client is the one that restates it.
    const unverifiable = this.context.universe.unverifiable && projectId === this.context.projectIds[0];
    return structuredAnswer(
      this.context,
      options,
      "liaison-intake",
      () => this.intake(unverifiable),
      (answer) => {
        this.readings.push({
          projectId,
          kind: "reading",
          provider: providerOf(modelId),
          model,
          questions: answer.questions.length,
        });
      },
    );
  }

  /** A second reading of a tender answers only the questions it would put to the client. */
  async secondReading(options: LanguageModelV4CallOptions, modelId: string): Promise<LanguageModelV4GenerateResult> {
    const projectId = await this.intakeProject();
    const model = modelId.slice(providerOf(modelId).length + 1);
    this.readings.push({ projectId, kind: "second-asked", provider: providerOf(modelId), model, questions: 0 });
    return structuredAnswer(
      this.context,
      options,
      "liaison-intake.second",
      () => ({ questions: this.intakeQuestions(false) }),
      (answer) => {
        this.readings.push({
          projectId,
          kind: "second-answered",
          provider: providerOf(modelId),
          model,
          questions: answer.questions.length,
        });
      },
    );
  }

  /**
   * A tender reading's answer, in the contract form: one guarantee per behaviour, keyed G<n> by the
   * behaviour's place and quoting it from the tender, and one more naming no behaviour; the one
   * question the tender leaves open, or none, when the lazy intake persona fires (sticky: it asks
   * nothing whatever the tender leaves open) or a reading misses the open decision
   * (`unaskedReading`, per reading). On an `unverifiable` tender every guarantee is observed in stored
   * data, so Ashara can verify none of them.
   */
  private intake(unverifiable: boolean): { readonly questions: readonly unknown[] } & Record<string, unknown> {
    const { universe, personas, tape, rates } = this.context;
    const persona = personas.of("intake") === "lazy" && personas.fires("intake");
    const lazy = persona || tape.chance("model.liaison-intake.unasked", rates.unaskedReading);
    if (lazy)
      this.context.onModelCall({
        site: "liaison-intake",
        action: persona ? "persona lazy: no question asked" : "unasked: no question asked",
      });
    const tender = (quote: string) => ({ kind: "tender", quote });
    const guarantee = (id: string, statement: string, quote: string) => ({
      id,
      statement,
      observable: { interface: ["I1"], observation: unverifiable ? "stored-data" : "output" },
      refutedBy: [`The product does not hold that ${statement.charAt(0).toLowerCase()}${statement.slice(1)}`],
      source: tender(quote),
    });
    return {
      summary: `A product with ${universe.behaviours.length} behaviours.`,
      interface: [{ id: "I1", text: "The product, run as the tender asks.", source: tender("Build a product") }],
      guarantees: [
        ...universe.behaviours.map((b, i) => guarantee(`G${i + 1}`, `The product does ${b}.`, b)),
        // It names no behaviour, so only the honest planner's line of its own (citingPerLine) cites it and only that
        // line's check decides it.
        guarantee(
          messagesGuarantee(universe.behaviours.length),
          "Every message reads the same on every run.",
          "Build a product",
        ),
      ],
      questions: lazy ? [] : this.intakeQuestions(true),
      assumptions: [
        {
          id: "A2",
          statement: "The product keeps no state between runs.",
          rationale: "The tender names no stored data.",
          kind: "internal-design",
          underpins: [],
        },
        // A design choice, so no check decides it and the asked assumption stays the last item a check set decides.
        {
          id: "A3",
          statement: "The product runs as one local program.",
          rationale: "The tender names no service to run.",
          kind: "internal-design",
          underpins: [],
        },
      ],
      exclusions: [{ id: "X1", text: "Any network service.", source: { kind: "assumption", id: "A3" } }],
    };
  }

  /**
   * The questions an honest reading of the tender asks: the one decision it leaves open that the
   * client would see, keyed A1 by a first reading (`keyed`) and by intake after a second reading's.
   */
  private intakeQuestions(keyed: boolean): readonly unknown[] {
    return [
      {
        text: "Which language should messages use?",
        whyItMatters: "It decides what every message shows.",
        // A model that cannot tell answers "undecided": the vision records it client-visible, so it is checked.
        assumption: {
          ...(keyed ? { id: "A1" } : {}),
          statement: "Messages are in English.",
          rationale: "The tender is written in English.",
          kind: "undecided",
          underpins: [messagesGuarantee(this.context.universe.behaviours.length)],
        },
      },
    ];
  }

  /**
   * The project whose tender a reading is asked of: the one the call's pending llm_calls row names,
   * written at its admission before the call is sent. Intake reads one tender at a
   * time, so the latest pending intake row is this call's; null when none is, which the oracle names.
   */
  private async intakeProject(): Promise<string | null> {
    const result = await this.context.observer.execute(sql`
      SELECT project_id AS "projectId" FROM llm_calls
      WHERE call_site = 'liaison-intake' AND state = 'pending'
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    const [row] = z.array(z.object({ projectId: z.string() })).parse(result.rows);
    return row === undefined ? null : row.projectId;
  }
}
