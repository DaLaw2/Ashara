import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContextualLlm } from "@ashara/finance";
import { StructuredOutputExhausted, withStructuredLadder } from "@ashara/model-access";
import type { LadderAttemptEvent, StructuredValidation } from "@ashara/model-access";
import { projectBlockCause } from "@ashara/shared";
import type { ProjectBlockCause, ProjectId } from "@ashara/shared";
import { VisionUnreadable, rosterVisionOf } from "./acl/engagement-acl.js";
import type { RosterVision, StoredVision } from "./acl/engagement-acl.js";
import { CapabilityClassSchema, describeViolation, nonEmptyOrNull, validateRoster } from "./roster.js";
import type { Role, Roster } from "./roster.js";
import { assignmentViolations } from "./work-kind.js";

// Roster derivation per tender (story s-team-roster-m1, ADR-075 Organization): the
// roles a project needs, derived from vision v1 by one structured call on the
// `roster` site. validateRoster is the ladder's validate hook, so a violating
// roster is re-asked with its violations named; a ladder that runs out blocks the
// project with them. No default roster exists: a project without a derived one is
// never planned.

/** The first revision of a project's roster; later revisions append. */
const FIRST_REVISION = 1;

/** Vision v1 of a project with no roster, as the store reads it; read through Engagement's published reader. */
interface VisionAwaitingRoster {
  readonly projectId: ProjectId;
  readonly vision: StoredVision;
}

/** What derivation reads of the project: its vision v1, read. */
interface DerivationInput extends RosterVision {
  readonly projectId: ProjectId;
}

/** Organization's persistence port for the roster. */
export interface RosterStore {
  projectsAwaitingRoster(): Promise<readonly VisionAwaitingRoster[]>;
  /** Appends the roster's rows in one transaction, or nothing when the project already has a roster. */
  recordRoster(roster: Roster): Promise<"recorded" | "roster-exists">;
  /** Blocks the project and records why (migration 025); a project already blocked keeps its first cause. */
  blockProject(projectId: ProjectId, cause: ProjectBlockCause): Promise<"blocked" | "already-blocked">;
}

export type RosterOutcome =
  | { readonly kind: "recorded"; readonly projectId: ProjectId; readonly revision: number; readonly roles: readonly string[] }
  | { readonly kind: "roster-exists"; readonly projectId: ProjectId }
  | { readonly kind: "project-blocked"; readonly projectId: ProjectId; readonly cause: ProjectBlockCause };

/** What the core loop asks of Organization each cycle. */
export interface RosterDerivationStep {
  runPending(): Promise<readonly RosterOutcome[]>;
}

/** Every validated attempt at a roster failed; the last attempt's violations are named. */
class RosterDerivationExhausted extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly visionVersion: number,
    readonly violations: readonly string[],
    options: { readonly cause: StructuredOutputExhausted },
  ) {
    super(
      `project ${projectId} vision v${visionVersion}: no valid roster after ${options.cause.totalAttempts} attempts; ` +
        `the last attempt was rejected for: ${violations.join(" ") || "no recorded reason"}`,
      options,
    );
    this.name = "RosterDerivationExhausted";
  }
}

// Plain arrays with a minimum, not tuples: this schema goes to the provider as JSON
// Schema, and a role id is Ashara's to mint, not the model's.
const DerivationResponseSchema = z.strictObject({
  roles: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1),
        responsibility: z.string().min(1),
        capabilities: z.array(CapabilityClassSchema).min(1),
      }),
    )
    .min(1),
});

/** A schema-valid response that still has an empty array: the schema and this module disagree. */
class RosterResponseEmpty extends Error {
  constructor(
    readonly projectId: ProjectId,
    readonly field: string,
  ) {
    super(`project ${projectId}: the parsed roster response has an empty ${field} despite the schema's minimum`);
    this.name = "RosterResponseEmpty";
  }
}

type DerivationResponse = z.infer<typeof DerivationResponseSchema>;

function buildPrompt(vision: DerivationInput): string {
  return [
    `You staff a software contractor's team for one client project. Read the project's vision and`,
    `name the roles the team needs, each with what it is responsible for and the capability classes`,
    `it holds.`,
    ``,
    `Vision (the client's tender, verbatim):`,
    JSON.stringify(vision.visionText),
    ``,
    `Assumptions work proceeds on until the client says otherwise:`,
    ...(vision.assumptions.length > 0 ? vision.assumptions.map((a) => `- ${a}`) : [`- (none recorded)`]),
    ``,
    `Capability classes:`,
    `- "client-comms": talks to the client: questions, reports, change requests.`,
    `- "write-environment": defines the project's build and test environment.`,
    `- "write-source": writes the product's source code.`,
    `- "author-checks": writes the checks that judge whether the work is done.`,
    ``,
    `Rules every roster must satisfy:`,
    `- Exactly one role holds "client-comms", and it holds nothing else.`,
    `- Exactly one role holds "write-environment".`,
    `- Exactly one role holds "write-source".`,
    `- Exactly one role holds "author-checks", and that role holds neither "write-source" nor`,
    `  "write-environment": whoever writes the checks must not be judged by them.`,
    `- Every role holds at least one capability class; role names are unique.`,
    ``,
    `Name each role for its job on THIS project and state its responsibility in the vision's terms.`,
    `Do not choose a technology, language or framework the vision does not name.`,
    ``,
    `IMPORTANT: Respond with ONLY valid JSON, no markdown, no explanation, no code fences.`,
    `Use exactly this format: {"roles": [{"name": "...", "responsibility": "...", "capabilities": ["..."]}]}`,
  ].join("\n");
}

function reask(ctx: { readonly errors: readonly string[] }): string {
  return (
    `\n\nYour previous roster was REJECTED for these reasons:\n` +
    ctx.errors.map((e) => `- ${e}`).join("\n") +
    `\nRe-send the whole corrected roster as JSON only. No markdown, no explanatory prose.`
  );
}

function toRoster(vision: DerivationInput, response: DerivationResponse, id: (index: number) => string): Roster {
  const roles = nonEmptyOrNull(
    response.roles.map((role, index): Role => {
      const capabilities = nonEmptyOrNull(role.capabilities);
      if (capabilities === null) throw new RosterResponseEmpty(vision.projectId, `capabilities of "${role.name}"`);
      return { id: id(index), name: role.name, responsibility: role.responsibility, capabilities };
    }),
  );
  if (roles === null) throw new RosterResponseEmpty(vision.projectId, "roles");
  return { projectId: vision.projectId, visionVersion: vision.version, revision: FIRST_REVISION, roles };
}

function violationsOf(roster: Roster): readonly string[] {
  return [...validateRoster(roster), ...assignmentViolations(roster)].map(describeViolation);
}

interface RosterDerivationDeps {
  readonly llm: ContextualLlm;
  readonly store: RosterStore;
  readonly onAttempt?: (event: LadderAttemptEvent) => void;
}

/**
 * Organization's roster step. Each project with vision v1 and no roster gets one
 * derived and recorded whole, or is blocked with the violations that kept it from
 * being valid. A store or provider failure throws through and fails the cycle.
 */
export class RosterDerivation implements RosterDerivationStep {
  constructor(private readonly deps: RosterDerivationDeps) {}

  async runPending(): Promise<readonly RosterOutcome[]> {
    const outcomes: RosterOutcome[] = [];
    for (const awaiting of await this.deps.store.projectsAwaitingRoster()) {
      try {
        outcomes.push(await this.derive({ projectId: awaiting.projectId, ...rosterVisionOf(awaiting.vision) }));
      } catch (err) {
        if (!(err instanceof RosterDerivationExhausted || err instanceof VisionUnreadable)) throw err;
        outcomes.push(await this.block(awaiting.projectId, projectBlockCause(err)));
      }
    }
    return outcomes;
  }

  private async block(projectId: ProjectId, cause: ProjectBlockCause): Promise<RosterOutcome> {
    const result = await this.deps.store.blockProject(projectId, cause);
    console.warn(`[roster] project ${projectId}: ${cause.errorClass}; project ${result}: ${cause.reason}`);
    return { kind: "project-blocked", projectId, cause };
  }

  private async derive(vision: DerivationInput): Promise<RosterOutcome> {
    const { projectId } = vision;
    const response = await this.ask(vision);
    const roster = toRoster(vision, response, () => randomUUID());
    const recorded = await this.deps.store.recordRoster(roster);
    if (recorded === "roster-exists") return { kind: "roster-exists", projectId };
    return { kind: "recorded", projectId, revision: roster.revision, roles: roster.roles.map((role) => role.name) };
  }

  private async ask(vision: DerivationInput): Promise<DerivationResponse> {
    const provider = withStructuredLadder(
      this.deps.llm.forCall({ projectId: vision.projectId, taskId: null, callSite: "roster" }),
      {
        site: "roster",
        // 3: nothing retries around this ladder; its exhaustion blocks the project.
        attempts: 3,
        onAttempt: this.deps.onAttempt,
        reask,
      },
    );
    // Ids are minted only for a valid roster; positional ones suffice to validate it.
    const validate = (value: DerivationResponse): StructuredValidation => {
      const errors = violationsOf(toRoster(vision, value, (index) => `role-${index + 1}`));
      return errors.length === 0 ? { ok: true } : { ok: false, errors };
    };
    try {
      const response = await provider.generateStructured({
        capability: "Strong",
        prompt: buildPrompt(vision),
        schema: DerivationResponseSchema,
        maxTokens: 2048,
        validate,
      });
      return response.data;
    } catch (err) {
      if (err instanceof StructuredOutputExhausted) {
        throw new RosterDerivationExhausted(vision.projectId, vision.version, err.validationErrors, { cause: err });
      }
      throw err;
    }
  }
}
