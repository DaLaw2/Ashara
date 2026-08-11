import { z, type ZodType } from "zod";

export interface NorthStarLLM {
  generateStructured<T>(prompt: string, schema: ZodType<T>): Promise<T>;
}

export interface NorthStarCheckInput {
  readonly completedWork: string;
  readonly storyNorthStar: string;
  readonly epicNorthStar: string;
  readonly storyCriteria: string[];
  readonly visionSummary?: string;
  readonly scopeBoundaries?: string[];
}

export type AlignmentResult =
  | { aligned: true; evidence: string }
  | { aligned: false; driftDescription: string };

export const AlignmentResponseSchema = z.discriminatedUnion("aligned", [
  z.object({ aligned: z.literal(true), evidence: z.string().min(1) }),
  z.object({ aligned: z.literal(false), driftDescription: z.string().min(1) }),
]);

export class NorthStarChecker {
  private readonly llm: NorthStarLLM;

  constructor(llm: NorthStarLLM) {
    this.llm = llm;
  }

  async check(input: NorthStarCheckInput): Promise<AlignmentResult> {
    const prompt = this.buildPrompt(input);
    const parsed = await this.llm.generateStructured(prompt, AlignmentResponseSchema);

    if (parsed.aligned) {
      return { aligned: true, evidence: parsed.evidence };
    }
    return { aligned: false, driftDescription: parsed.driftDescription };
  }

  private buildPrompt(input: NorthStarCheckInput): string {
    const parts: string[] = [
      "# North Star Alignment Check",
      "",
      "## Completed Work",
      input.completedWork,
      "",
      "## Story North Star",
      input.storyNorthStar,
      "",
      "## Epic North Star",
      input.epicNorthStar,
      "",
      "## Success Criteria",
      ...input.storyCriteria.map((c, i) => `${i + 1}. ${c}`),
    ];

    if (input.visionSummary) {
      parts.push("", "## Vision", input.visionSummary);
    }
    if (input.scopeBoundaries && input.scopeBoundaries.length > 0) {
      parts.push("", "## Scope Boundaries", ...input.scopeBoundaries.map((b) => `- ${b}`));
    }

    parts.push(
      "",
      "## Task",
      "Evaluate whether the completed work advances the story and epic north stars.",
      "If aligned, provide evidence. If drifting, describe the drift.",
      "",
      "## Response Format",
      'Respond with JSON: { "aligned": true, "evidence": "..." }',
      'or: { "aligned": false, "driftDescription": "..." }',
    );

    return parts.join("\n");
  }
}

export class StubNorthStarLLM implements NorthStarLLM {
  readonly calls: string[] = [];

  async generateStructured<T>(prompt: string, schema: ZodType<T>): Promise<T> {
    this.calls.push(prompt);

    const northStarMatch = prompt.match(/## Story North Star\n(.+)/);
    const northStarText = northStarMatch ? northStarMatch[1]! : "";

    const completedMatch = prompt.match(/## Completed Work\n(.+)/);
    const completedText = completedMatch ? completedMatch[1]! : "";

    const northStarWords = this.extractWords(northStarText);
    const completedWords = this.extractWords(completedText);

    const overlap = northStarWords.filter((w) => completedWords.includes(w));

    if (overlap.length > 0) {
      return schema.parse({
        aligned: true,
        evidence: `Completed work matches north star keywords: ${overlap.join(", ")}`,
      });
    }

    return schema.parse({
      aligned: false,
      driftDescription: "Completed work does not align with the north star direction",
    });
  }

  private extractWords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
  }
}
