import { z } from "zod";
import { AssumptionKindSchema, parseProjectId } from "@ashara/shared";
import type { AssumptionDisclosure, AssumptionKind, AssumptionStanding, ProjectId, ScopeLine, ScopeSide } from "@ashara/shared";

// The Vision (ADR-075 Engagement, engagement review D3): a project's vision, versioned and
// append-only. Engagement alone writes it: intake writes v1, a client's answer and the team's stack
// choice each append the next version. Every other context reads a version only through
// readVisionVersion, the published reader, never the stored jsonb.

/** A vision version as vision_documents stores it, its jsonb unread. */
export interface StoredVision {
  readonly projectId: string;
  readonly version: number;
  readonly visionText: string;
  readonly summary: string;
  readonly scopeBoundaries: unknown;
  readonly inferences: unknown;
  readonly openQuestions: unknown;
}

/** A stored vision version that does not read as a vision: the project's own record, which no retry changes. */
export class VisionUnreadable extends Error {
  constructor(
    readonly projectId: string,
    readonly visionVersion: number,
    readonly field: string,
    readonly issues: string,
  ) {
    super(`project ${projectId} vision v${visionVersion}: ${field} is not in a readable shape: ${issues}`);
    this.name = "VisionUnreadable";
  }
}

/**
 * How the client learned of an Inferred assumption (d89 C): asked about it in an intake question,
 * or told of it in a report that work proceeds on it unless they object.
 */
const AssumptionDisclosureSchema = z.enum(["asked", "reported"]);

/** What the client's answer did to the assumption it made Stated (d95 a). */
const ClientAnswerVerdictSchema = z.enum(["confirms", "changes"]);

/** The client's answer a Stated assumption carries (migration 038), the answer's message id its provenance. */
const ClientAnswerRecordSchema = z.looseObject({
  messageId: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  // Absent on a record written before the verdict was recorded.
  verdict: ClientAnswerVerdictSchema.optional(),
});

/**
 * One assumption as vision_documents.inferences stores it. A record written before keys, kinds or
 * disclosures were recorded holds none of them: it is keyed by its place, its kind reads
 * "unclassified" (not evidence that it is client-visible) and, Inferred, it reads "not shown". A
 * Stated record carries the client's answer that stated it. Fields this schema does not name (a
 * rationale, the answered question's id) are kept as stored.
 */
const AssumptionRecordSchema = z
  .looseObject({
    key: z.string().min(1).optional(),
    statement: z.string().min(1),
    status: z.enum(["Inferred", "Stated"]),
    kind: AssumptionKindSchema.optional(),
    disclosed: AssumptionDisclosureSchema.optional(),
    clientAnswer: ClientAnswerRecordSchema.optional(),
  })
  .refine((record) => record.status !== "Stated" || record.clientAnswer !== undefined, {
    message: "a Stated assumption carries the client answer that stated it",
  });

type AssumptionRecord = z.infer<typeof AssumptionRecordSchema>;

/**
 * vision_documents.inferences: the keyed records intake, the answers and the stack choice write, or
 * the map of direction category to inference the deleted CLI path wrote, still read.
 */
const StoredInferencesSchema = z.union([z.array(AssumptionRecordSchema), z.record(z.string(), z.string())]);

/** A scope line as stored: an object with its side, or a bare string written before sides were recorded. */
const StoredScopeLineSchema = z.union([
  z.strictObject({ text: z.string().min(1), side: z.enum(["in", "out"]) }),
  z
    .string()
    .min(1)
    .transform((text): { readonly text: string; readonly side: ScopeSide } => ({ text, side: "unclassified" })),
]);

/** An open question as intake writes it, with the key of the assumption adopted until it is answered. */
const OpenQuestionRecordSchema = z.looseObject({
  messageId: z.string().min(1),
  text: z.string().min(1),
  assumptionKey: z.string().min(1),
});

/** vision_documents.open_questions: intake's records, or the bare strings the deleted CLI path wrote. */
const StoredOpenQuestionsSchema = z.array(z.union([OpenQuestionRecordSchema, z.string().min(1)]));

type StoredOpenQuestion = z.infer<typeof StoredOpenQuestionsSchema>[number];

/** The client's answer a Stated assumption carries. */
interface ClientAnswer {
  readonly messageId: string;
  readonly question: string;
  readonly answer: string;
  /** null on a record written before the verdict was recorded. */
  readonly verdict: z.infer<typeof ClientAnswerVerdictSchema> | null;
}

/** One assumption of a vision version, as every reader of the vision sees it. */
export interface VisionAssumption {
  /** Its key in the vision (A1, A2, ...), or A<n> by its place when the record holds none. */
  readonly id: string;
  /** Whether the record holds its key; false for a record keyed by its place. */
  readonly keyed: boolean;
  readonly statement: string;
  /** "Inferred" or "Stated"; null on the deleted CLI path's map, which recorded none. */
  readonly status: "Inferred" | "Stated" | null;
  readonly kind: AssumptionKind | "unclassified";
  readonly disclosed: AssumptionDisclosure | null;
  /** What the client has seen of it: Stated by them, asked, reported, or never shown. */
  readonly standing: AssumptionStanding;
  /** The client's answer that stated it; null on an Inferred assumption. */
  readonly clientAnswer: ClientAnswer | null;
}

/** A question asked of the client and not yet answered; the deleted CLI path's bare strings carry no ids. */
interface OpenQuestion {
  readonly messageId: string | null;
  readonly text: string;
  readonly assumptionKey: string | null;
}

/** Engagement's published language: one version of a project's vision, read whole. */
export interface VisionVersion {
  readonly projectId: ProjectId;
  readonly version: number;
  /** The client's tender, verbatim. */
  readonly visionText: string;
  readonly summary: string;
  readonly scope: ReadonlyArray<{ readonly text: string; readonly side: ScopeSide }>;
  readonly assumptions: readonly VisionAssumption[];
  readonly openQuestions: readonly OpenQuestion[];
}

function standingOf(record: AssumptionRecord): AssumptionStanding {
  if (record.status === "Stated") return "stated";
  return record.disclosed ?? "not-shown";
}

function assumptionOf(record: AssumptionRecord, index: number): VisionAssumption {
  return {
    id: record.key ?? `A${index + 1}`,
    keyed: record.key !== undefined,
    statement: record.statement,
    status: record.status,
    kind: record.kind ?? "unclassified",
    disclosed: record.disclosed ?? null,
    standing: standingOf(record),
    clientAnswer:
      record.clientAnswer === undefined
        ? null
        : {
            messageId: record.clientAnswer.messageId,
            question: record.clientAnswer.question,
            answer: record.clientAnswer.answer,
            verdict: record.clientAnswer.verdict ?? null,
          },
  };
}

function legacyAssumptionOf([category, inference]: [string, string], index: number): VisionAssumption {
  return {
    id: `A${index + 1}`,
    keyed: false,
    statement: `${category}: ${inference}`,
    status: null,
    kind: "unclassified",
    disclosed: null,
    standing: "not-shown",
    clientAnswer: null,
  };
}

/** A vision version appended after `basedOnVersion`: every field but these is the base version's. */
export interface VisionAppend {
  readonly basedOnVersion: number;
  readonly inferences: readonly AssumptionRecord[];
  readonly openQuestions: readonly unknown[];
  readonly changeReason: string;
}

/** The vision cannot take the change asked of it without rewriting what the client was told. */
export class VisionChangeRefused extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly visionVersion: number,
    readonly detail: string,
  ) {
    super(`project ${projectId} vision v${visionVersion} cannot take the change: ${detail}`);
    this.name = "VisionChangeRefused";
  }
}

const ASSUMPTION_KEY = /^A(\d+)$/;

/**
 * The Vision aggregate: one stored version read whole, and the only way a next version is composed.
 * The stored records are kept as written, so a change rewrites only the record it is about.
 */
export class Vision {
  private constructor(
    readonly current: VisionVersion,
    /** null when the inferences are the deleted CLI path's map, which no keyed change can extend. */
    private readonly records: readonly AssumptionRecord[] | null,
    private readonly questions: readonly StoredOpenQuestion[],
  ) {}

  /** Reads one stored version; throws VisionUnreadable naming the field that does not read. */
  static read(stored: StoredVision): Vision {
    const field = <T>(schema: z.ZodType<T>, value: unknown, name: string): T => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new VisionUnreadable(stored.projectId, stored.version, name, z.prettifyError(parsed.error));
      return parsed.data;
    };
    const scope = field(z.array(StoredScopeLineSchema), stored.scopeBoundaries, "scopeBoundaries");
    const inferences = field(StoredInferencesSchema, stored.inferences, "inferences");
    const questions = field(StoredOpenQuestionsSchema, stored.openQuestions, "openQuestions");
    const records = Array.isArray(inferences) ? inferences : null;
    const assumptions = records === null ? Object.entries(inferences).map(legacyAssumptionOf) : records.map(assumptionOf);
    const ids = new Set<string>();
    for (const assumption of assumptions) {
      if (ids.has(assumption.id)) {
        throw new VisionUnreadable(stored.projectId, stored.version, "inferences", `two assumptions share the key ${assumption.id}`);
      }
      ids.add(assumption.id);
    }
    const current: VisionVersion = {
      projectId: parseProjectId(stored.projectId, "vision_documents.project_id"),
      version: stored.version,
      visionText: stored.visionText,
      summary: stored.summary,
      scope,
      assumptions,
      openQuestions: questions.map((question) =>
        typeof question === "string"
          ? { messageId: null, text: question, assumptionKey: null }
          : { messageId: question.messageId, text: question.text, assumptionKey: question.assumptionKey },
      ),
    };
    return new Vision(current, records, questions);
  }

  private keyedRecords(): readonly AssumptionRecord[] {
    if (this.records === null) {
      throw new VisionChangeRefused(this.current.projectId, this.current.version, "its assumptions are not keyed records");
    }
    return this.records;
  }

  /**
   * The next version with the Inferred assumption the team adopted appended under the next free key
   * (A<n> after every key, and every place, already in the vision).
   */
  appendInferred(assumption: {
    readonly statement: string;
    readonly rationale: string;
    readonly kind: AssumptionKind;
    readonly disclosed: AssumptionDisclosure;
    readonly changeReason: (key: string) => string;
  }): VisionAppend & { readonly key: string } {
    const records = this.keyedRecords();
    let highest = records.length;
    for (const record of records) {
      const match = record.key === undefined ? null : ASSUMPTION_KEY.exec(record.key);
      if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
    }
    const key = `A${highest + 1}`;
    const appended: AssumptionRecord = {
      key,
      statement: assumption.statement,
      rationale: assumption.rationale,
      status: "Inferred",
      kind: assumption.kind,
      disclosed: assumption.disclosed,
    };
    return {
      key,
      basedOnVersion: this.current.version,
      inferences: [...records, appended],
      openQuestions: this.questions,
      changeReason: assumption.changeReason(key),
    };
  }

  /**
   * The next version with the assumption `key` Stated by the client's answer to the open question
   * `answer.questionMessageId`, which closes; every other record is carried over as stored.
   */
  stateAssumption(
    key: string,
    answer: {
      readonly messageId: string;
      readonly questionMessageId: string;
      readonly question: string;
      readonly answer: string;
      readonly verdict: z.infer<typeof ClientAnswerVerdictSchema>;
      /** What work now proceeds on, and its kind when the answer changed the decision. */
      readonly statement: string;
      readonly kind: AssumptionKind | null;
      readonly rationale: string;
      readonly changeReason: string;
    },
  ): VisionAppend {
    const records = this.keyedRecords();
    const index = records.findIndex((record) => record.key === key);
    const record = records[index];
    if (record === undefined) {
      throw new VisionChangeRefused(this.current.projectId, this.current.version, `it holds no assumption keyed ${key}`);
    }
    const stated: AssumptionRecord = {
      ...record,
      statement: answer.statement,
      ...(answer.kind === null ? {} : { kind: answer.kind }),
      rationale: answer.rationale,
      status: "Stated",
      clientAnswer: {
        messageId: answer.messageId,
        questionMessageId: answer.questionMessageId,
        question: answer.question,
        answer: answer.answer,
        // The delivered report says from it whether the client confirmed or changed the assumption (d95 a).
        verdict: answer.verdict,
      },
    };
    return {
      basedOnVersion: this.current.version,
      inferences: records.map((other, i) => (i === index ? stated : other)),
      openQuestions: this.questions.filter((question) => typeof question === "string" || question.messageId !== answer.questionMessageId),
      changeReason: answer.changeReason,
    };
  }
}

/** A vision version about to be written does not read back as one: nothing is written. */
class VisionWriteRefused extends Error {
  constructor(
    readonly projectId: string,
    readonly field: string,
    readonly issues: string,
  ) {
    super(`project ${projectId}: the vision version to write has ${field} that would not read back: ${issues}; nothing was written`);
    this.name = "VisionWriteRefused";
  }
}

/** Holds a version about to be written to the reader's own schemas, so nothing is stored that the reader refuses. */
export function assertVisionWritable(
  projectId: string,
  fields: { readonly scopeBoundaries: unknown; readonly inferences: unknown; readonly openQuestions: unknown },
): void {
  const checks: ReadonlyArray<readonly [string, z.ZodType, unknown]> = [
    ["scopeBoundaries", z.array(StoredScopeLineSchema), fields.scopeBoundaries],
    ["inferences", z.array(AssumptionRecordSchema), fields.inferences],
    ["openQuestions", StoredOpenQuestionsSchema, fields.openQuestions],
  ];
  for (const [field, schema, value] of checks) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new VisionWriteRefused(projectId, field, z.prettifyError(parsed.error));
  }
}

/** Engagement's published reader: one stored version, read whole; throws VisionUnreadable. */
export function readVisionVersion(stored: StoredVision): VisionVersion {
  return Vision.read(stored).current;
}

/** Vision v1 as intake writes it. */
export interface FirstVision {
  readonly visionText: string;
  readonly summary: string;
  /** What the client asked for, then what the tender leaves out, each with its side (W11c D3). */
  readonly scopeBoundaries: readonly ScopeLine[];
  readonly inferences: readonly InferredAssumption[];
  readonly openQuestions: ReadonlyArray<{
    readonly messageId: string;
    readonly text: string;
    readonly whyItMatters: string;
    /** The key of the inference adopted until this question is answered. */
    readonly assumptionKey: string;
  }>;
}

/** An Inferred assumption as intake records it: what work proceeds on until the client says otherwise. */
export interface InferredAssumption {
  /** Stable within the vision: the open question adopting it, and a later change request, name it. */
  readonly key: string;
  readonly statement: string;
  readonly rationale: string;
  readonly status: "Inferred";
  readonly kind: AssumptionKind;
  /** How the client learned of it: the question that asked about it, or the assumptions report. */
  readonly disclosed: AssumptionDisclosure;
}
