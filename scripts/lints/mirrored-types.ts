/**
 * Every concept production source declares as a type has one declaration, and every other site
 * imports it. Two top-level type declarations in different files of packages' src/ that share a
 * name are a violation, and so are two with different names whose members are the same, in one
 * file or in two: at least MIN_MEMBERS of them, each by name, optionality and type, with every
 * named type read as one and `readonly` left out. A copy kept under another name drifts from its
 * original as silently as one kept under the same name. So is an alias `type X = ReturnType<typeof f>`
 * of a function `f` the file imports: the module that exports `f` owns the type of what it returns,
 * and names it for its callers. A pair that is two distinct concepts, or an alias that is no copy,
 * is named in MIRRORED_ALLOWED with its reason; an entry that names no such declaration fails, so
 * the list cannot outlive the declarations it excuses.
 */

import ts from "typescript";
import { importEdges } from "../import-targets.js";
import type { LintContext, Violation } from "./lint.js";

const MIRRORED_TYPES = "mirrored-types";
const MIN_MEMBERS = 3;

interface AllowedPair {
  /** The declared names: one for a shared name or a return-type alias, each for a shared member set. */
  readonly names: readonly string[];
  /** Root-relative, `/`-separated: every file that declares one of `names`. */
  readonly files: readonly string[];
  readonly reason: string;
}

const SIMULATOR_ROW = "the simulator's own zod row of what it reads back from the database to judge a run: it states what the run must show, so it is never imported from the code it judges";
const DERIVED_ALIAS = "a local alias derived from the production type by a type operator (its parameters, its return, an indexed access), so it is that type and cannot drift from it; the production module exports no name for it";
const SERVICE_DEPS = "each service's own dependency set: they name the same ports today, and a port one of them comes to need must not reach the others";

const MIRRORED_ALLOWED: readonly AllowedPair[] = [
  { names: ["ProjectRow"], files: ["packages/db/src/repositories/project.ts", "packages/integration/src/simulator/invariants.ts"], reason: SIMULATOR_ROW },
  { names: ["BurnWarning"], files: ["packages/engagement/src/burn-warning.ts", "packages/integration/src/simulator/client-report-burn.ts"], reason: SIMULATOR_ROW },
  { names: ["StoredGuarantee"], files: ["packages/engagement/src/vision-language/guarantee.ts", "packages/integration/src/simulator/stand-ins/liaison.ts"], reason: SIMULATOR_ROW },
  {
    names: ["IntakeRecords"],
    files: ["packages/engagement/src/intake.ts", "packages/integration/src/simulator/intake-readings.ts"],
    reason: "Engagement's is what an intake asked and inferred; the simulator's is what it reads back of a tender's reading (its questions posted, its vision written)",
  },
  {
    names: ["TableSource"],
    files: ["packages/engagement/src/guarantee-report.ts", "packages/integration/src/simulator/client-report-core.ts"],
    reason: "Engagement's names the record a terminal message's table is read from; the simulator's is the sweep, vision version and commit it reads back for a report's table",
  },
  {
    names: ["CorrectionReading"],
    files: ["packages/engagement/src/correction.ts", "packages/integration/src/simulator/stand-ins/liaison.ts"],
    reason: "Engagement's is the model's reading of a correction; the stand-in's is its own answer, read or fallen back to an exclusion",
  },
  {
    names: ["Risk"],
    files: ["packages/engagement/src/early-warning.ts", "packages/integration/src/server/terminal-reports.ts"],
    reason: "Engagement's is why one guarantee is at risk; the test harness's names the risk register a halted terminal event carries, derived from Engagement's own type",
  },
  {
    names: ["TaskLanes"],
    files: ["packages/delivery/src/types.ts", "packages/integration/src/simulator/interleave.ts"],
    reason: `${DERIVED_ALIAS}; a simulator file imports from another package only the names its rules list`,
  },
  { names: ["TerminalEvent"], files: ["packages/engagement/src/terminal-report.ts", "packages/integration/src/server/terminal-reports.ts"], reason: DERIVED_ALIAS },
  { names: ["ProcessRequest"], files: ["packages/execution-infra/src/process-runner.ts", "packages/integration/src/simulator/fake-podman.ts"], reason: DERIVED_ALIAS },
  { names: ["ProcessResult"], files: ["packages/execution-infra/src/process-runner.ts", "packages/integration/src/simulator/fake-podman.ts"], reason: DERIVED_ALIAS },
  {
    names: ["Direction"],
    files: ["packages/engagement/src/vision-language/contract-op.ts", "packages/integration/src/simulator/tape.ts"],
    reason: "Engagement's is which way a contract revision moves a guarantee; the simulator's is a draw its tape takes",
  },
  {
    names: ["Coverage"],
    files: ["packages/integration/src/simulator/coverage.ts", "packages/quality/src/guarantee-verdict.ts"],
    reason: "Quality's is whether a sweep covers the contract in force; the simulator's is what a batch of runs reached",
  },
  {
    names: ["Outcome"],
    files: ["packages/integration/src/simulator/invariants.ts", "packages/quality/src/repositories/reviewer-outcome.ts", "packages/workplace/src/outcome.ts"],
    reason: "Workplace's is how an attempt ended, Quality's how a reviewer's verdict was borne out, the simulator's what a run ended in",
  },
  {
    names: ["WorkKind"],
    files: ["packages/integration/src/simulator/stand-ins/agent.ts", "packages/organization/src/work-kind.ts"],
    reason: "Organization's is the kind of work a role is assigned; the stand-in's is the scope of an attempt's scripted draws, which tells the scaffold apart",
  },
  {
    names: ["TaskSpec"],
    files: ["packages/delivery/src/decomposition-types.ts", "packages/workplace/src/task-spec.ts"],
    reason: "Delivery's is a planned task's specification with its origin and sources; Workplace's is the goal, end state, scope and deliverables a brief states",
  },
  {
    names: ["ReplanContext"],
    files: ["packages/delivery/src/domain/work-item.ts", "packages/workplace/src/replan-context.ts"],
    reason: "Delivery's is the replan context it writes on a blocked reason; Workplace's is its own zod read, at its boundary, of the part its brief shows, and Workplace may not import Delivery, which is downstream of it",
  },
  {
    names: ["RevisionCause"],
    files: ["packages/delivery/src/replan-port.ts", "packages/engagement/src/vision-language/contract-op.ts"],
    reason: "Delivery's is what asked for a plan revision; Engagement's is why a vision revision was written",
  },
  {
    names: ["JudgedGuarantee"],
    files: ["packages/evaluation/src/hidden-verdict.ts", "packages/quality/src/guarantee-verdict.ts"],
    reason: "Quality's is what its verdict reads of a guarantee; Evaluation's is the hidden suite's verdict on one",
  },
  {
    names: ["Spend"],
    files: ["packages/evaluation/src/run-report-format.ts", "packages/finance/src/llm-call-repository.ts"],
    reason: "Finance's is a scope's spend as its cap counts it; the run report's is measured spend over a set of calls",
  },
  {
    names: ["Cell"],
    files: ["packages/evaluation/src/trust-stats.ts", "packages/execution-infra/src/podman.ts"],
    reason: "Execution Infrastructure's is a container; the trust statistics' is one cell of a confusion table",
  },
  {
    names: ["Delivery"],
    files: ["packages/evaluation/src/trust-stats.ts", "packages/quality/src/dispatch-result.ts"],
    reason: "Quality's is what a completed task delivered; the trust statistics' counts how one arm's runs per stack ended",
  },
  {
    names: ["JsonValue"],
    files: ["packages/quality/src/dispatch-result.ts", "packages/shared/src/error-chain.ts"],
    reason: "the shared kernel's is plain JSON data; Quality's event fields also admit an undefined member, which JSON.stringify drops",
  },
  {
    names: ["DoneStep", "EndedRun"],
    files: ["packages/delivery/src/dispatch/end-without-done.ts", "packages/delivery/src/dispatch/run-execution.ts"],
    reason: "an attempt that finished done carries a FinishedOutcome, one that ended otherwise any Outcome; the member check reads every named type as one",
  },
  {
    names: ["QueriedSpec", "TaskSpec"],
    files: ["packages/knowledge/src/knowledge-writer.ts", "packages/workplace/src/task-spec.ts"],
    reason: "Knowledge states the fields of a task its query reads, as its own port; it may import no other context, and Workplace's brief spec is one caller's value that has them",
  },
  { names: ["FirstPlannerDeps", "ReplannerDeps"], files: ["packages/delivery/src/first-plan.ts", "packages/delivery/src/replan.ts"], reason: SERVICE_DEPS },
  {
    names: ["ClientAnswersDeps", "ClientChangesDeps", "RosterDerivationDeps", "TenderIntakeDeps"],
    files: ["packages/engagement/src/answers.ts", "packages/engagement/src/client-change.ts", "packages/engagement/src/intake.ts", "packages/organization/src/derivation.ts"],
    reason: SERVICE_DEPS,
  },
];

/** One top-level type declaration: its name, where it is, and its members when it is an object type. */
interface TypeDeclaration {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** Each member as `name?: type`, sorted, every named type read as `T`; null for a type that is not an object type. */
  readonly members: readonly string[] | null;
  /** For `type X = ReturnType<typeof f>` with `f` imported, the module `f` is imported from; null otherwise. */
  readonly returnOfImport: { readonly fn: string; readonly from: string } | null;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** `node` with every named type read as one, so a copy whose members name the copies of each other's types still matches. */
function anonymised<T extends ts.Node>(node: T): ts.Node {
  const transformer: ts.TransformerFactory<ts.Node> = (context) => {
    const visit = (child: ts.Node): ts.Node => {
      if (ts.isTypeReferenceNode(child)) {
        const args = child.typeArguments?.map((arg) => ts.visitNode(arg, visit, ts.isTypeNode));
        return context.factory.createTypeReferenceNode("T", args);
      }
      return ts.visitEachChild(child, visit, context);
    };
    return (root) => ts.visitNode(root, visit) ?? root;
  };
  const result = ts.transform<ts.Node>(node, [transformer]);
  const [transformed] = result.transformed;
  result.dispose();
  return transformed ?? node;
}

/** The type as printed with no comment, its named types read as one; `readonly` is left out, which a copy may drop. */
function printed(node: ts.Node, sf: ts.SourceFile): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, anonymised(node), sf)
    .replace(/\breadonly\s+/g, "")
    .replace(/\s+/g, " ");
}

function memberKey(member: ts.TypeElement, sf: ts.SourceFile): string {
  const name = member.name === undefined ? "" : member.name.getText(sf);
  const optional = member.questionToken === undefined ? "" : "?";
  if (ts.isPropertySignature(member)) return `${name}${optional}: ${member.type === undefined ? "any" : printed(member.type, sf)}`;
  if (ts.isMethodSignature(member)) {
    const params = member.parameters.map((param) => (param.type === undefined ? "any" : printed(param.type, sf))).join(", ");
    return `${name}${optional}(${params}): ${member.type === undefined ? "any" : printed(member.type, sf)}`;
  }
  return printed(member, sf);
}

function objectMembers(declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, sf: ts.SourceFile): string[] | null {
  if (ts.isInterfaceDeclaration(declaration)) {
    // eslint-disable-next-line no-restricted-syntax -- policy default: an interface with no heritage clause extends nothing
    const heritage = (declaration.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => `extends ${printed(type, sf)}`));
    return [...heritage, ...declaration.members.map((member) => memberKey(member, sf))].sort();
  }
  if (ts.isTypeLiteralNode(declaration.type)) return declaration.type.members.map((member) => memberKey(member, sf)).sort();
  return null;
}

/** Each name `file` binds by an import declaration of a literal specifier, with the module it is imported from. */
function importedNames(file: string, source: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const edge of importEdges(file, source)) {
    if (edge.form !== "import" && edge.form !== "import-equals") continue;
    if (edge.target.kind !== "static") continue;
    for (const local of edge.locals) names.set(local, edge.target.specifier);
  }
  return names;
}

/** The leftmost name of `typeof a.b.c`: the binding the query reads through. */
function rootName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : rootName(name.left);
}

/** For an alias that is exactly `ReturnType<typeof f>` with `f` imported, `f` and its module. */
function returnOfImport(declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, imports: ReadonlyMap<string, string>, sf: ts.SourceFile): TypeDeclaration["returnOfImport"] {
  if (!ts.isTypeAliasDeclaration(declaration) || !ts.isTypeReferenceNode(declaration.type)) return null;
  const { typeName, typeArguments } = declaration.type;
  if (!ts.isIdentifier(typeName) || typeName.text !== "ReturnType" || typeArguments?.length !== 1) return null;
  const [argument] = typeArguments;
  if (argument === undefined || !ts.isTypeQueryNode(argument)) return null;
  const from = imports.get(rootName(argument.exprName));
  return from === undefined ? null : { fn: argument.exprName.getText(sf), from };
}

/** Every top-level interface and type alias of `source`. */
function typeDeclarations(file: string, source: string): TypeDeclaration[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = importedNames(file, source);
  return sf.statements
    .filter((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
    .map((declaration) => ({
      name: declaration.name.text,
      file,
      line: sf.getLineAndCharacterOfPosition(declaration.getStart(sf)).line + 1,
      members: objectMembers(declaration, sf),
      returnOfImport: returnOfImport(declaration, imports, sf),
    }));
}

/** Production source: a test or a declaration file is left out. */
function isProduction(relative: string): boolean {
  return relative.startsWith("src/") && !relative.endsWith(".test.ts") && !relative.endsWith(".d.ts");
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

/** Groups of two or more declarations, in one file or in several, by `key`; a declaration `key` maps to null is in none. */
function groupsBy(declarations: readonly TypeDeclaration[], key: (declaration: TypeDeclaration) => string | null): TypeDeclaration[][] {
  const groups = new Map<string, TypeDeclaration[]>();
  for (const declaration of declarations) {
    const k = key(declaration);
    if (k === null) continue;
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [declaration]);
    else group.push(declaration);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function where(group: readonly TypeDeclaration[]): string {
  return group.map((d) => `${d.name} at ${d.file}:${d.line}`).join(", ");
}

export function run(context: LintContext): Violation[] {
  const declarations: TypeDeclaration[] = [];
  for (const pkg of context.packages) {
    for (const [filePath, source] of pkg.contents) {
      const relative = pkg.relativeTo(filePath);
      if (isProduction(relative)) declarations.push(...typeDeclarations(`packages/${pkg.name}/${relative}`, source));
    }
  }
  const violations: Violation[] = [];
  if (declarations.length === 0) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: "no production type declaration to scan; a scan of nothing would pass" });
  }
  const used = new Set<AllowedPair>();
  const report = (group: readonly TypeDeclaration[], what: string): void => {
    const names = group.map((d) => d.name);
    const files = group.map((d) => d.file);
    const allowed = MIRRORED_ALLOWED.find((pair) => sameSet(pair.names, names) && sameSet(pair.files, files));
    if (allowed !== undefined) {
      used.add(allowed);
      return;
    }
    const [first] = group;
    if (first === undefined) return;
    const [, pkg] = first.file.split("/");
    violations.push({
      file: first.file,
      line: first.line,
      fromPkg: pkg ?? "*",
      specifier: MIRRORED_TYPES,
      reason: `${what}: ${where(group)}; keep one declaration and import it, or name it in MIRRORED_ALLOWED with why it is a distinct concept`,
    });
  };
  for (const group of groupsBy(declarations, (d) => d.name)) report(group, "one name declared more than once");
  const sharedMembers = groupsBy(declarations, (d) => (d.members !== null && d.members.length >= MIN_MEMBERS ? d.members.join("\n") : null));
  for (const group of sharedMembers) {
    if (new Set(group.map((d) => d.name)).size > 1) report(group, "one member set declared under more than one name");
  }
  for (const declaration of declarations) {
    const { returnOfImport: alias } = declaration;
    if (alias !== null) report([declaration], `an alias of what ${alias.fn}, imported from "${alias.from}", returns; import the type that module exports for it, or export one there`);
  }
  for (const pair of MIRRORED_ALLOWED) {
    if (!used.has(pair)) {
      violations.push({ file: pair.files[0] ?? "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: `the allowed entry ${pair.names.join(", ")} no longer matches its declarations; remove or correct its entry` });
    }
  }
  return violations;
}
