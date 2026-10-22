import { z } from "zod";
import { parseProjectId } from "@ashara/shared";
import type { ProjectId } from "@ashara/shared";
import { FirstContractSchema, StoredContractSchema, collapseWhitespace, markOf, visionGuaranteeOf } from "./vision-language/guarantee.js";
import type { ContractDraft, StoredContract, StoredGuarantee, VisionExclusion } from "./vision-language/guarantee.js";
import type { ContractOp } from "./vision-language/contract-op.js";
import { basisOf } from "./vision-language/index.js";
import type { InterfaceEntry, VisionGuarantee } from "./vision-language/index.js";
import { AssumptionKindSchema } from "./vision-language/vision-assumption.js";
import type { AssumptionDisclosure, AssumptionKind, AssumptionStanding, ScopeSide } from "./vision-language/vision-assumption.js";

// The Vision: a project's vision, versioned and
// append-only. Engagement alone writes it: intake writes v1, a client's answer, a client's correction
// and the team's stack choice each append the next version. Every other context reads a version only through
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
  readonly contractForm: unknown;
  readonly interface: unknown;
  readonly guarantees: unknown;
  readonly exclusions: unknown;
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
 * How the client learned of an Inferred assumption: asked about it in an intake question,
 * or told of it in a report that work proceeds on it unless they object.
 */
const AssumptionDisclosureSchema = z.enum(["asked", "reported"]);

/** What the client's answer did to the assumption it made Stated. */
const ClientAnswerVerdictSchema = z.enum(["confirms", "changes"]);

/** The client's answer a Stated assumption carries, the answer's message id its provenance. */
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
 * "unclassified" (not evidence that no client could observe it, so a check decides it)
 * and, Inferred, its standing reads "unrecorded". A Stated record carries the client's answer that
 * stated it. Fields this schema does not name (a rationale, the answered question's id) are kept
 * as stored.
 */
const AssumptionRecordSchema = z
  .looseObject({
    key: z.string().min(1).optional(),
    statement: z.string().min(1),
    status: z.enum(["Inferred", "Stated"]),
    kind: AssumptionKindSchema.optional(),
    disclosed: AssumptionDisclosureSchema.optional(),
    clientAnswer: ClientAnswerRecordSchema.optional(),
    // The keys of the guarantees it underpins; absent on a record written before guarantees were.
    underpins: z.array(z.string().min(1)).optional(),
  })
  .refine((record) => record.status !== "Stated" || record.clientAnswer !== undefined, {
    message: "a Stated assumption carries the client answer that stated it",
  });

type AssumptionRecord = z.infer<typeof AssumptionRecordSchema>;

/**
 * Which records a version's contract is written in: the scope lines of a version written before
 * guarantees were, or the interface, guarantees and exclusions.
 */
const ContractFormSchema = z.enum(["scope-lines", "guarantees"]);

type ContractForm = z.infer<typeof ContractFormSchema>;

/** The contract columns of a scope-lines version: each holds nothing. */
const NoContractSchema = z.strictObject({ interface: z.tuple([]), guarantees: z.tuple([]), exclusions: z.tuple([]) });

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
  /** Its key in the vision, or A<n> by its place when the record holds none. */
  readonly id: string;
  /** Whether the record holds its key; false for a record keyed by its place. */
  readonly keyed: boolean;
  readonly statement: string;
  /** "Inferred" or "Stated"; null on the deleted CLI path's map, which recorded none. */
  readonly status: "Inferred" | "Stated" | null;
  readonly kind: AssumptionKind | "unclassified";
  readonly disclosed: AssumptionDisclosure | null;
  /** What the client has seen of it: Stated by them, asked, reported, or not on record. */
  readonly standing: AssumptionStanding;
  /** The client's answer that stated it; null on an Inferred assumption. */
  readonly clientAnswer: ClientAnswer | null;
  /** The keys of the guarantees it underpins. */
  readonly underpins: readonly string[];
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
  /** "scope-lines" on a version written before guarantees were: its guarantees are read from its scope and assumptions. */
  readonly contractForm: ContractForm;
  /** The product's public interface; empty on a scope-lines version, which recorded none. */
  readonly interface: readonly InterfaceEntry[];
  /**
   * What a delivery is judged against. On a scope-lines version, every line not out of scope and
   * every assumption not internal design, each with a legacy source, no interface, no refuting
   * observation and its observation unclassified: not checkable as written.
   */
  readonly guarantees: readonly VisionGuarantee[];
  /** What the tender leaves out; on a scope-lines version, its out-of-scope lines. */
  readonly exclusions: readonly VisionExclusion[];
}

function standingOf(record: AssumptionRecord): AssumptionStanding {
  if (record.status === "Stated") return "stated";
  return record.disclosed ?? "unrecorded";
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
    // eslint-disable-next-line no-restricted-syntax -- policy default: a record written before guarantees were underpins none on record, and a guarantees-form version refuses a client-visible one that underpins none unless an exclusion cites it
    underpins: record.underpins ?? [],
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
    standing: "unrecorded",
    clientAnswer: null,
    underpins: [],
  };
}

/**
 * The guarantees and exclusions of a scope-lines version: each line keyed by its place (as a plan
 * cites it), an out-of-scope line an exclusion and every other line a guarantee, then every
 * assumption not internal design a guarantee under its own key. None names an interface entry or a
 * refuting observation, and none is classified, so none can be judged better than unjudged.
 */
function legacyContractOf(
  scope: ReadonlyArray<{ readonly text: string; readonly side: ScopeSide }>,
  assumptions: readonly VisionAssumption[],
): { readonly guarantees: readonly VisionGuarantee[]; readonly exclusions: readonly VisionExclusion[] } {
  const guarantees: VisionGuarantee[] = [];
  const exclusions: VisionExclusion[] = [];
  scope.forEach((line, i) => {
    const id = `S${i + 1}`;
    const source = { kind: "legacy", from: "scope" } as const;
    if (line.side === "out") exclusions.push({ id, text: line.text, source });
    else guarantees.push(legacyGuarantee(id, line.text, source, assumptions));
  });
  for (const assumption of assumptions) {
    if (assumption.kind === "internal-design") continue;
    guarantees.push(legacyGuarantee(assumption.id, assumption.statement, { kind: "legacy", from: "assumption", id: assumption.id }, assumptions));
  }
  return { guarantees, exclusions };
}

function legacyGuarantee(
  id: string,
  statement: string,
  source: Extract<VisionGuarantee["source"], { readonly kind: "legacy" }>,
  assumptions: readonly VisionAssumption[],
): VisionGuarantee {
  return { id, statement, interface: [], observation: "unclassified", refutedBy: [], verification: "unmarked", source, basis: basisOf({ id, source }, assumptions) };
}

/** A version's contract breaks one of the rules the Vision keeps; the caller names the version. */
class ContractBroken extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = "ContractBroken";
  }
}

function assertUniqueIds(field: string, records: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ContractBroken(field, `two ${records} share the key ${id}`);
    seen.add(id);
  }
}

/**
 * The rules a version's contract keeps, each a refusal: every quote is the client's own words, every
 * key named resolves in the same version, a guarantees-form version holds no scope lines, and every
 * assumption a client could observe underpins a guarantee or is excluded. A scope-lines version has no
 * guarantee keys, so an assumption naming one names a key that does not resolve.
 */
function assertContractHolds(
  visionText: string,
  scopeLines: number,
  contract: StoredContract | null,
  assumptions: readonly VisionAssumption[],
): void {
  const guaranteeIds = new Set(contract === null ? [] : contract.guarantees.map((g) => g.id));
  for (const assumption of assumptions) {
    const unknown = assumption.underpins.filter((id) => !guaranteeIds.has(id));
    if (unknown.length > 0) {
      throw new ContractBroken("inferences", `assumption ${assumption.id} underpins ${unknown.join(", ")}, which the version does not hold`);
    }
  }
  if (contract === null) return;
  if (scopeLines > 0) throw new ContractBroken("scopeBoundaries", "a guarantees-form version holds scope lines");
  assertUniqueIds("interface", "interface entries", contract.interface.map((entry) => entry.id));
  assertUniqueIds("guarantees", "guarantees", contract.guarantees.map((g) => g.id));
  assertUniqueIds("exclusions", "exclusions", contract.exclusions.map((x) => x.id));
  const tender = collapseWhitespace(visionText);
  const assumptionIds = new Set(assumptions.map((a) => a.id));
  const interfaceIds = new Set(contract.interface.map((entry) => entry.id));
  const sourced = [
    ...contract.interface.map((entry) => ["interface", entry.id, entry.source] as const),
    ...contract.guarantees.map((g) => ["guarantees", g.id, g.source] as const),
    ...contract.exclusions.map((x) => ["exclusions", x.id, x.source] as const),
  ];
  for (const [field, id, source] of sourced) {
    if (source.kind === "tender" && !tender.includes(collapseWhitespace(source.quote))) {
      throw new ContractBroken(field, `${id} quotes "${source.quote}", which the tender does not contain`);
    }
    if (source.kind === "assumption" && !assumptionIds.has(source.id)) {
      throw new ContractBroken(field, `${id} cites assumption ${source.id}, which the version does not hold`);
    }
  }
  for (const guarantee of contract.guarantees) {
    const unknown = guarantee.observable.interface.filter((id) => !interfaceIds.has(id));
    if (unknown.length > 0) {
      throw new ContractBroken("guarantees", `${guarantee.id} is observed at ${unknown.join(", ")}, which the interface does not hold`);
    }
  }
  const excluded = new Set(contract.exclusions.flatMap((x) => (x.source.kind === "assumption" ? [x.source.id] : [])));
  for (const assumption of assumptions) {
    // An unclassified kind is not evidence that no client could observe it, so it is held as client-visible.
    if (assumption.kind !== "internal-design" && assumption.underpins.length === 0 && !excluded.has(assumption.id)) {
      throw new ContractBroken("inferences", `client-visible assumption ${assumption.id} underpins no guarantee and no exclusion cites it`);
    }
  }
}

/**
 * A vision version appended after `basedOnVersion`: every field but these is the base version's. Its
 * contract is the base version's unless a correction revised it.
 */
export interface VisionAppend {
  readonly basedOnVersion: number;
  readonly inferences: readonly AssumptionRecord[];
  readonly openQuestions: readonly unknown[];
  readonly contract: { readonly kind: "unchanged" } | { readonly kind: "revised"; readonly records: StoredContract };
  readonly changeReason: string;
}

/**
 * Behaviour a plan adds that no item of the contract states, as the vision records it: what the
 * product does, the guarantees whose work rests on it, and why the team adopted it.
 */
export interface PlannedBehaviour {
  readonly statement: string;
  /** The keys of the guarantees its lines cite; each must be one the version holds. */
  readonly underpins: readonly [string, ...string[]];
  readonly rationale: string;
}

/** One operation of a correction applied, with the key it acted on, and whether it restored the tender's own words. */
export interface AppliedOp {
  readonly op: ContractOp;
  readonly key: string;
  readonly cause: "client-change" | "misread";
}

/** One operation of a correction the contract cannot take as read, with the rule it would break. */
export interface UnappliedOp {
  readonly op: ContractOp;
  readonly reason: string;
}

/** A correction applied to a version: the next version, the Vision it reads as, and what each operation did. */
export interface Corrected {
  readonly append: VisionAppend;
  readonly next: Vision;
  readonly applied: readonly AppliedOp[];
  readonly unapplied: readonly UnappliedOp[];
}

/** The change message a correction was read from, and every key the project's versions ever used. */
interface CorrectionSource {
  readonly messageId: string;
  readonly body: string;
  /** Keys are never reused: an added record takes the next number after every key any version held. */
  readonly usedKeys: ReadonlySet<string>;
  readonly changeReason: string;
}

/** The contract and assumptions a correction's operations act on, one operation at a time. */
interface Working {
  readonly contract: StoredContract;
  readonly records: readonly AssumptionRecord[];
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

/** The words a guarantee withdrawn under the only one the contract holds would leave. */
const LAST_GUARANTEE = "it would leave the contract with no guarantee, and only a stop ends a project's whole scope";

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
    /** null on a scope-lines version. */
    private readonly contract: StoredContract | null,
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
    const contractForm = field(ContractFormSchema, stored.contractForm, "contractForm");
    const columns = { interface: stored.interface, guarantees: stored.guarantees, exclusions: stored.exclusions };
    let contract: StoredContract | null = null;
    if (contractForm === "guarantees") contract = field(StoredContractSchema, columns, "contract");
    else field(NoContractSchema, columns, "contract");
    const records = Array.isArray(inferences) ? inferences : null;
    if (records === null && contract !== null) {
      throw new VisionUnreadable(stored.projectId, stored.version, "inferences", "a guarantees-form version holds the unkeyed direction map");
    }
    const assumptions = records === null ? Object.entries(inferences).map(legacyAssumptionOf) : records.map(assumptionOf);
    try {
      assertUniqueIds("inferences", "assumptions", assumptions.map((a) => a.id));
      assertContractHolds(stored.visionText, scope.length, contract, assumptions);
    } catch (err) {
      if (!(err instanceof ContractBroken)) throw err;
      throw new VisionUnreadable(stored.projectId, stored.version, err.field, err.detail);
    }
    const read =
      contract === null
        ? { interface: [], ...legacyContractOf(scope, assumptions) }
        : {
            interface: contract.interface,
            guarantees: contract.guarantees.map((g) => visionGuaranteeOf(g, assumptions)),
            exclusions: contract.exclusions,
          };
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
      contractForm,
      ...read,
    };
    return new Vision(current, records, questions, contract);
  }

  /** Holds the next version's assumptions to this version's contract; throws VisionChangeRefused. */
  private composed(records: readonly AssumptionRecord[]): readonly AssumptionRecord[] {
    try {
      const assumptions = records.map(assumptionOf);
      assertUniqueIds("inferences", "assumptions", assumptions.map((a) => a.id));
      assertContractHolds(this.current.visionText, this.current.scope.length, this.contract, assumptions);
    } catch (err) {
      if (!(err instanceof ContractBroken)) throw err;
      throw new VisionChangeRefused(this.current.projectId, this.current.version, err.message);
    }
    return records;
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
    /** The keys of the guarantees it underpins; each must be one this version holds. */
    readonly underpins: readonly string[];
    readonly changeReason: (key: string) => string;
  }): VisionAppend & { readonly key: string } {
    const records = this.keyedRecords();
    const [key] = this.freeKeys(1);
    const appended: AssumptionRecord = {
      key,
      statement: assumption.statement,
      rationale: assumption.rationale,
      status: "Inferred",
      kind: assumption.kind,
      disclosed: assumption.disclosed,
      underpins: [...assumption.underpins],
    };
    return {
      key,
      basedOnVersion: this.current.version,
      inferences: this.composed([...records, appended]),
      openQuestions: this.questions,
      contract: { kind: "unchanged" },
      changeReason: assumption.changeReason(key),
    };
  }

  /**
   * The next `count` free assumption keys, in the order an append gives them: A<n> after every key,
   * and every place, already in the vision.
   */
  freeKeys(count: number): readonly [string, ...string[]] {
    const highest = this.highestKey();
    const rest = Array.from({ length: Math.max(0, count - 1) }, (_, i) => `A${highest + 2 + i}`);
    return [`A${highest + 1}`, ...rest];
  }

  private highestKey(): number {
    const records = this.keyedRecords();
    let highest = records.length;
    for (const record of records) {
      const match = record.key === undefined ? null : ASSUMPTION_KEY.exec(record.key);
      if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
    }
    return highest;
  }

  /**
   * The next version with every behaviour a plan adds beyond what the contract states appended, in
   * order, as Inferred client-visible assumptions under the next free keys, each underpinning the
   * guarantees its lines cite. The client is told of them in the plan's report, before any task
   * resting on one is dispatched.
   */
  appendPlanned(
    planned: readonly [PlannedBehaviour, ...PlannedBehaviour[]],
    changeReason: (keys: readonly string[]) => string,
  ): VisionAppend & { readonly keys: readonly string[] } {
    const records = this.keyedRecords();
    const highest = this.highestKey();
    const appended = planned.map(
      (behaviour, i): AssumptionRecord & { readonly key: string } => ({
        key: `A${highest + 1 + i}`,
        statement: behaviour.statement,
        rationale: behaviour.rationale,
        status: "Inferred",
        kind: "client-visible",
        disclosed: "reported",
        underpins: [...behaviour.underpins],
      }),
    );
    const keys = appended.map((record) => record.key);
    return {
      keys,
      basedOnVersion: this.current.version,
      inferences: this.composed([...records, ...appended]),
      openQuestions: this.questions,
      contract: { kind: "unchanged" },
      changeReason: changeReason(keys),
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
        // The delivered report says from it whether the client confirmed or changed the assumption.
        verdict: answer.verdict,
      },
    };
    return {
      basedOnVersion: this.current.version,
      // A guarantee resting on it reads client-stated from the next version on: its basis is computed there, never rewritten.
      inferences: this.composed(records.map((other, i) => (i === index ? stated : other))),
      openQuestions: this.questions.filter((question) => typeof question === "string" || question.messageId !== answer.questionMessageId),
      contract: { kind: "unchanged" },
      changeReason: answer.changeReason,
    };
  }

  /**
   * The next version with a client's correction applied, one operation at a time in the order read:
   * each is held to every rule a version keeps, and one that would break a rule is left out with the
   * rule it breaks, never the rest with it. A version written before guarantees were holds no keyed
   * contract records, so no operation applies to it.
   */
  correct(ops: readonly ContractOp[], source: CorrectionSource): Corrected {
    const applied: AppliedOp[] = [];
    const unapplied: UnappliedOp[] = [];
    if (this.contract === null || this.records === null) {
      const reason = "this project's contract was recorded before guarantees were, so it holds no keyed records to change";
      return { append: this.revisedAppend({ contract: this.contract, records: this.records }, source), next: this, applied, unapplied: ops.map((op) => ({ op, reason })) };
    }
    const used = new Set(source.usedKeys);
    for (const id of [
      ...this.contract.interface.map((e) => e.id),
      ...this.contract.guarantees.map((g) => g.id),
      ...this.contract.exclusions.map((x) => x.id),
      ...this.current.assumptions.map((a) => a.id),
    ]) {
      used.add(id);
    }
    let working: Working = { contract: this.contract, records: this.records };
    for (const op of ops) {
      try {
        const step = this.applyOne(op, working, source, used);
        const contract = StoredContractSchema.safeParse(step.working.contract);
        if (!contract.success) throw new ContractBroken("contract", z.prettifyError(contract.error));
        const assumptions = step.working.records.map(assumptionOf);
        assertUniqueIds("inferences", "assumptions", assumptions.map((a) => a.id));
        assertContractHolds(this.current.visionText, 0, contract.data, assumptions);
        working = { contract: contract.data, records: step.working.records };
        applied.push({ op, key: step.key, cause: step.cause });
      } catch (err) {
        if (!(err instanceof ContractBroken)) throw err;
        unapplied.push({ op, reason: err.detail });
      }
    }
    const append = this.revisedAppend(working, source);
    const next = Vision.read({
      projectId: this.current.projectId,
      version: this.current.version + 1,
      visionText: this.current.visionText,
      summary: this.current.summary,
      scopeBoundaries: [],
      inferences: working.records,
      openQuestions: this.questions,
      contractForm: "guarantees",
      interface: working.contract.interface,
      guarantees: working.contract.guarantees,
      exclusions: working.contract.exclusions,
    });
    return { append, next, applied, unapplied };
  }

  private revisedAppend(
    working: { readonly contract: StoredContract | null; readonly records: readonly AssumptionRecord[] | null },
    source: CorrectionSource,
  ): VisionAppend {
    return {
      basedOnVersion: this.current.version,
      // eslint-disable-next-line no-restricted-syntax -- policy default: a legacy version's unkeyed map takes no correction, and its append is never written (no operation applied)
      inferences: working.records ?? [],
      openQuestions: this.questions,
      contract: working.contract === null ? { kind: "unchanged" } : { kind: "revised", records: working.contract },
      changeReason: source.changeReason,
    };
  }

  /** One operation on the working records; throws ContractBroken when it names a record they do not hold. */
  private applyOne(
    op: ContractOp,
    working: Working,
    source: CorrectionSource,
    used: Set<string>,
  ): { readonly working: Working; readonly key: string; readonly cause: "client-change" | "misread" } {
    const { contract, records } = working;
    const correction = { kind: "correction", messageId: source.messageId } as const;
    const nextKey = (prefix: string): string => {
      const pattern = new RegExp(`^${prefix}(\\d+)$`);
      let highest = 0;
      for (const key of used) {
        const match = pattern.exec(key);
        if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
      }
      const key = `${prefix}${highest + 1}`;
      used.add(key);
      return key;
    };
    const missing = (field: string, what: string, id: string) => new ContractBroken(field, `it holds no ${what} keyed ${id}`);
    const done = (next: Partial<Working>, key: string, cause: "client-change" | "misread" = "client-change") => ({
      working: { contract: next.contract ?? contract, records: next.records ?? records },
      key,
      cause,
    });
    switch (op.op) {
      case "add-guarantee": {
        const id = nextKey("G");
        const guarantee = observed(op, { id, statement: op.statement, refutedBy: op.refutedBy, source: correction });
        return done({ contract: { ...contract, guarantees: [...contract.guarantees, guarantee] } }, id);
      }
      case "amend-guarantee": {
        const old = contract.guarantees.find((g) => g.id === op.id);
        if (old === undefined) throw missing("guarantees", "guarantee", op.id);
        // A guarantee Ashara read into the tender, put back in the tender's own words, was Ashara's misreading.
        const basis = visionGuaranteeOf(old, records.map(assumptionOf)).basis;
        const restores = basis !== "client-stated" && collapseWhitespace(this.current.visionText).includes(collapseWhitespace(op.statement));
        const amended = observed(op, {
          id: op.id,
          statement: op.statement,
          refutedBy: op.refutedBy,
          source: restores ? ({ kind: "tender", quote: op.statement } as const) : correction,
        });
        return done({ contract: { ...contract, guarantees: contract.guarantees.map((g) => (g.id === op.id ? amended : g)) } }, op.id, restores ? "misread" : "client-change");
      }
      case "withdraw-guarantee": {
        const old = contract.guarantees.find((g) => g.id === op.id);
        if (old === undefined) throw missing("guarantees", "guarantee", op.id);
        if (contract.guarantees.length === 1) throw new ContractBroken("guarantees", LAST_GUARANTEE);
        const unpinned = records.map((record) =>
          record.underpins?.includes(op.id) === true ? { ...record, underpins: record.underpins.filter((id) => id !== op.id) } : record,
        );
        // An assumption a client could observe that now underpins nothing is recorded as left out, so
        // the withdrawn promise is never read as one still kept.
        const excluded = new Set(contract.exclusions.flatMap((x) => (x.source.kind === "assumption" ? [x.source.id] : [])));
        const orphans = unpinned.map(assumptionOf).filter((a) => a.kind !== "internal-design" && a.underpins.length === 0 && !excluded.has(a.id));
        const exclusions = [
          ...contract.exclusions,
          ...orphans.map((a) => ({ id: nextKey("X"), text: old.statement, source: { kind: "assumption", id: a.id } as const })),
        ];
        return done({ contract: { ...contract, guarantees: contract.guarantees.filter((g) => g.id !== op.id), exclusions }, records: unpinned }, op.id);
      }
      case "amend-assumption": {
        const index = records.map(assumptionOf).findIndex((a) => a.id === op.id);
        const record = records[index];
        if (record === undefined) throw missing("inferences", "assumption", op.id);
        const stated: AssumptionRecord = {
          ...record,
          statement: op.statement,
          status: "Stated",
          clientAnswer: { messageId: source.messageId, question: "Change request", answer: source.body, verdict: "changes" },
        };
        return done({ records: records.map((other, i) => (i === index ? stated : other)) }, op.id);
      }
      case "add-exclusion": {
        const id = nextKey("X");
        return done({ contract: { ...contract, exclusions: [...contract.exclusions, { id, text: op.text, source: correction }] } }, id);
      }
      case "withdraw-exclusion": {
        if (!contract.exclusions.some((x) => x.id === op.id)) throw missing("exclusions", "exclusion", op.id);
        return done({ contract: { ...contract, exclusions: contract.exclusions.filter((x) => x.id !== op.id) } }, op.id);
      }
      case "add-interface": {
        const id = nextKey("I");
        return done({ contract: { ...contract, interface: [...contract.interface, { id, text: op.text, source: correction }] } }, id);
      }
      case "amend-interface": {
        if (!contract.interface.some((e) => e.id === op.id)) throw missing("interface", "interface entry", op.id);
        const entries = contract.interface.map((e) => (e.id === op.id ? { id: op.id, text: op.text, source: correction } : e));
        return done({ contract: { ...contract, interface: entries } }, op.id);
      }
      case "withdraw-interface": {
        if (!contract.interface.some((e) => e.id === op.id)) throw missing("interface", "interface entry", op.id);
        return done({ contract: { ...contract, interface: contract.interface.filter((e) => e.id !== op.id) } }, op.id);
      }
    }
  }
}

/**
 * The terms and mark of a guarantee a correction states, as the contract records it: its observation
 * as the drafter gave it, an undecided one included, and the mark markOf gives it.
 */
function observed(
  op: Extract<ContractOp, { readonly op: "add-guarantee" | "amend-guarantee" }>,
  terms: Omit<StoredGuarantee, "observable" | "verification">,
): StoredGuarantee {
  return { ...terms, observable: { interface: op.interface, observation: op.observation }, ...markOf(op.observation) };
}

/** A vision version about to be written does not read back as one: nothing is written. */
export class VisionWriteRefused extends Error {
  constructor(
    readonly projectId: string,
    readonly field: string,
    readonly issues: string,
  ) {
    super(`project ${projectId}: the vision version to write has ${field} that would not read back: ${issues}; nothing was written`);
    this.name = "VisionWriteRefused";
  }
}

/** The contract columns of a version about to be written, as they are stored. */
interface WritableContract {
  readonly contractForm: ContractForm;
  readonly interface: StoredContract["interface"] | [];
  readonly guarantees: StoredContract["guarantees"] | [];
  readonly exclusions: StoredContract["exclusions"];
}

/**
 * Holds a version about to be written to the reader's own schemas and to the contract's rules, so
 * nothing is stored that the reader refuses; returns the contract columns to store, an undecided
 * observation kept as given with its guarantee marked undecided. `version` says whether it is
 * the project's first, whose guarantees are all proposed now and marked, or a later one, whose carried
 * guarantees keep the mark they were stored with or its absence. Throws VisionWriteRefused.
 */
export function visionWritable(
  projectId: string,
  fields: {
    readonly visionText: string;
    readonly scopeBoundaries: unknown;
    readonly inferences: unknown;
    readonly openQuestions: unknown;
    readonly contract: { readonly form: unknown; readonly interface: unknown; readonly guarantees: unknown; readonly exclusions: unknown };
  },
  version: "first" | "next",
): WritableContract {
  const field = <T>(schema: z.ZodType<T>, value: unknown, name: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new VisionWriteRefused(projectId, name, z.prettifyError(parsed.error));
    return parsed.data;
  };
  const scope = field(z.array(StoredScopeLineSchema), fields.scopeBoundaries, "scopeBoundaries");
  const records = field(z.array(AssumptionRecordSchema), fields.inferences, "inferences");
  field(StoredOpenQuestionsSchema, fields.openQuestions, "openQuestions");
  const form = field(ContractFormSchema, fields.contract.form, "contractForm");
  const columns = { interface: fields.contract.interface, guarantees: fields.contract.guarantees, exclusions: fields.contract.exclusions };
  let contract: StoredContract | null = null;
  if (form === "guarantees") contract = field(version === "first" ? FirstContractSchema : StoredContractSchema, columns, "contract");
  else field(NoContractSchema, columns, "contract");
  try {
    const assumptions = records.map(assumptionOf);
    assertUniqueIds("inferences", "assumptions", assumptions.map((a) => a.id));
    assertContractHolds(fields.visionText, scope.length, contract, assumptions);
  } catch (err) {
    if (!(err instanceof ContractBroken)) throw err;
    throw new VisionWriteRefused(projectId, err.field, err.detail);
  }
  return contract === null
    ? { contractForm: form, interface: [], guarantees: [], exclusions: [] }
    : { contractForm: form, interface: contract.interface, guarantees: contract.guarantees, exclusions: contract.exclusions };
}

/** Engagement's published reader: one stored version, read whole; throws VisionUnreadable. */
export function readVisionVersion(stored: StoredVision): VisionVersion {
  return Vision.read(stored).current;
}

/**
 * The keys behaviour a plan adds would take on the contract, in order, when recorded on the version
 * the plan is decomposed from (recordPlannedBehaviour checks the version it records on gives the same).
 * Throws VisionUnreadable, and VisionChangeRefused for a version whose assumptions are not keyed.
 */
export function plannedBehaviourKeys(stored: StoredVision, count: number): readonly string[] {
  return count === 0 ? [] : Vision.read(stored).freeKeys(count);
}

/** Vision v1 as intake writes it: the interface, the guarantees and the exclusions drafted from the tender, with its assumptions. */
export interface FirstVision {
  readonly contract: ContractDraft;
  readonly visionText: string;
  readonly summary: string;
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
  /** How the client learned of it: the question that asked about it, or the contract draft. */
  readonly disclosed: AssumptionDisclosure;
  /** The keys of the guarantees it underpins. */
  readonly underpins: readonly string[];
}
