/**
 * ProjectFrame derivation (ADR-046) — the ladder that answers "what is this
 * project?" from the most grounded source available, and REFUSES rather than
 * defaulting when no source can answer.
 *
 * The rungs are ordered by trust and, as a consequence, by cost: once a scaffold
 * exists, rung 1 answers from the tree and the LLM rung never runs again, so
 * derivation is once per project rather than once per task.
 */

import { readdir } from "node:fs/promises";
import type { ProjectContract, ProjectFrame, ProjectFrameAttempt, ProjectId, WorkItemId } from "@ashara/shared";
import { ProjectFrameSchema, ProjectFrameUnresolvable, nodeLabels } from "@ashara/shared";

// MARKER_LABELS deleted: a hardcoded {filename → language} table gave 9 known
// stacks a shortcut while every unseen stack (Zig, Elixir, COBOL) fell through
// to the LLM rung. The system should treat every stack the same — rung 1 now
// reports which manifest files exist without mapping them to language names.
// The consuming LLM already understands that "Cargo.toml" means Rust.

/** Knowledge-graph node kinds that describe the target stack (ADR-038 graph). */
const CONTRACT_STACK_KINDS = ["language", "runtime", "framework", "database", "build_tool"] as const;

/** Port: the vision text of the project this task belongs to. */
export interface ProjectIntentSource {
  loadIntent(taskId: string): Promise<string | null>;
}

/**
 * Port: last-resort stack derivation from prose.
 */
export interface StackDeriver {
  /** `scope` names the project and task the derivation call is charged to. */
  deriveStack(intent: string, scope: StackDerivationScope): Promise<readonly string[]>;
}

export interface StackDerivationScope {
  readonly projectId: ProjectId;
  readonly taskId: WorkItemId;
}

export interface ResolveProjectFrameArgs {
  readonly taskId: WorkItemId;
  readonly projectId: ProjectId;
  readonly contract: ProjectContract | null;
  readonly targetProjectPath: string | null;
  readonly intentSource: ProjectIntentSource | undefined;
  readonly stackDeriver: StackDeriver | undefined;
}

/**
 * Resolves the frame for one task, most-grounded source first, terminating in a
 * THROW rather than a default:
 *  1. observed-manifest — top-level marker files in the target tree. Ground truth.
 *  2. contract-knowledge — the ProjectContract's knowledge graph.
 *  3. vision-derivation — one deriver call over the owner's own words.
 *  4. {@link ProjectFrameUnresolvable}, carrying every rung and its decline reason.
 *
 * Intent resolution is separate from stack resolution and runs first: an
 * unresolvable intent is also a ProjectFrameUnresolvable, never a placeholder —
 * a made-up intent is exactly the substituted prior this ladder exists to prevent.
 */
export async function resolveProjectFrame(args: ResolveProjectFrameArgs): Promise<ProjectFrame> {
  const attempted: ProjectFrameAttempt[] = [];
  const projectId = args.contract?.projectId;

  const intent = await loadIntent(args.taskId, args.intentSource, attempted);
  if (intent === null) {
    throw new ProjectFrameUnresolvable({ taskId: args.taskId, projectId, attempted });
  }

  const observed = await observedManifestLabels(args.targetProjectPath, attempted);
  if (observed.length > 0) return buildFrame(intent, observed, "observed-manifest");

  const declared = contractKnowledgeLabels(args.contract, attempted);
  if (declared.length > 0) return buildFrame(intent, declared, "contract-knowledge");

  const derived = await derivedStackLabels(intent, args.stackDeriver, { projectId: args.projectId, taskId: args.taskId }, attempted);
  if (derived.length > 0) return buildFrame(intent, derived, "vision-derivation");

  throw new ProjectFrameUnresolvable({ taskId: args.taskId, projectId, attempted });
}

function buildFrame(
  intent: string,
  stack: readonly string[],
  source: ProjectFrame["source"],
): ProjectFrame {
  return ProjectFrameSchema.parse({ intent, stack, source });
}

async function loadIntent(
  taskId: string,
  source: ProjectIntentSource | undefined,
  attempted: ProjectFrameAttempt[],
): Promise<string | null> {
  if (!source) {
    attempted.push({ source: "project-intent", reason: "no intent source is wired into the Development BC" });
    return null;
  }
  try {
    const intent = await source.loadIntent(taskId);
    if (intent === null || intent.trim().length === 0) {
      attempted.push({ source: "project-intent", reason: `no vision text is recorded for task ${taskId}` });
      return null;
    }
    return intent.trim();
  } catch (e) {
    attempted.push({ source: "project-intent", reason: `intent lookup threw: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
}

// Well-known build/manifest filenames — any file whose name or extension
// indicates it is a project descriptor, not source code or documentation.
// This is a RECOGNITION heuristic, not a LABEL table: it identifies which
// top-level files are worth reporting as stack indicators without mapping
// them to language names. The consuming LLM understands "Cargo.toml" and
// "build.zig" without a translation table.
const MANIFEST_EXTENSIONS = new Set(["toml", "json", "yaml", "yml", "xml", "sbt", "gradle", "lock"]);
const MANIFEST_BASENAMES = new Set([
  "Makefile", "Justfile", "Gemfile", "Rakefile", "CMakeLists.txt",
  "go.mod", "go.sum", "Cargo.lock", "flake.nix", "shell.nix",
  "BUILD", "WORKSPACE", "Tiltfile", "Procfile",
]);

async function observedManifestLabels(
  targetProjectPath: string | null,
  attempted: ProjectFrameAttempt[],
): Promise<readonly string[]> {
  if (!targetProjectPath) {
    attempted.push({ source: "observed-manifest", reason: "the task has no target project path to scan" });
    return [];
  }
  let entries: readonly string[];
  try {
    entries = await readdir(targetProjectPath);
  } catch (e) {
    attempted.push({
      source: "observed-manifest",
      reason: `${targetProjectPath} could not be listed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return [];
  }

  const manifests: string[] = [];
  for (const name of [...entries].sort()) {
    if (name.startsWith(".")) continue;
    if (MANIFEST_BASENAMES.has(name)) {
      manifests.push(name);
      continue;
    }
    const dot = name.lastIndexOf(".");
    if (dot > 0 && MANIFEST_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
      manifests.push(name);
    }
  }

  if (manifests.length === 0) {
    attempted.push({
      source: "observed-manifest",
      reason: `no manifest or build file found at the top level of ${targetProjectPath}`,
    });
  }
  return manifests;
}

function contractKnowledgeLabels(
  contract: ProjectContract | null,
  attempted: ProjectFrameAttempt[],
): readonly string[] {
  if (!contract) {
    attempted.push({ source: "contract-knowledge", reason: "the project has no ProjectContract" });
    return [];
  }
  const labels = dedupe(
    CONTRACT_STACK_KINDS.flatMap((kind) => nodeLabels(contract.knowledge, kind)).map((label) => label.trim()),
  );
  if (labels.length === 0) {
    attempted.push({
      source: "contract-knowledge",
      reason: `contract v${contract.version} carries no ${CONTRACT_STACK_KINDS.join("/")} node`,
    });
  }
  return labels;
}

async function derivedStackLabels(
  intent: string,
  deriver: StackDeriver | undefined,
  scope: StackDerivationScope,
  attempted: ProjectFrameAttempt[],
): Promise<readonly string[]> {
  if (!deriver) {
    attempted.push({ source: "vision-derivation", reason: "no stack deriver is wired into the Development BC" });
    return [];
  }
  try {
    const labels = dedupe((await deriver.deriveStack(intent, scope)).map((label) => label.trim()));
    if (labels.length === 0) {
      attempted.push({ source: "vision-derivation", reason: "the deriver returned no stack labels for this intent" });
    }
    return labels;
  } catch (e) {
    attempted.push({ source: "vision-derivation", reason: `derivation threw: ${e instanceof Error ? e.message : String(e)}` });
    return [];
  }
}

function dedupe(labels: readonly string[]): string[] {
  return [...new Set(labels.filter((label) => label.length > 0))];
}
