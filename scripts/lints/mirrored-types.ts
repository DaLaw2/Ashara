/**
 * Every concept production source declares as a type has one declaration, and every other site
 * imports it. Read from the one program over the tree (module-program.ts), by the checker's type
 * identity, never by the text a declaration is written in:
 * - one name: two module-level type declarations (interface or type alias) of packages' production
 *   src/ that share a name;
 * - one type: two module-level type declarations of production source, a package's src/ or
 *   scripts/, in one file or in two, under one name or different names, whose declared types the
 *   checker finds assignable each to the other over one set of at least MIN_MEMBERS property names.
 *   A copy drifts from its original as silently under another name as under the same one, and an
 *   alias that names another declaration whole is one;
 * - a joined type (joined-types.ts): a type of production source the checker finds one with what a
 *   function of another module returns, written over that function's type. The violation names the
 *   type that module exports assignable each way to the joined one, or says it exports none.
 *
 * A pair that is two distinct concepts is named in MIRRORED_ALLOWED with its reason; an entry with
 * no reason, or that names no such declarations, fails, so the list cannot outlive the declarations
 * it excuses. The list excuses a shared name and a shared type, never a joined type: the module that
 * declares the function can always name what it returns, so no reason makes the join the right home.
 */

import path from "node:path";
import ts from "typescript";
import type { ModuleProgram } from "../module-program.js";
import { MIRRORED_TYPES, lineOf, returnTypeViolations, sameType, type ProductionModule } from "./joined-types.js";
import { contextProgram, type LintContext, type Violation } from "./lint.js";

const MIN_MEMBERS = 3;

interface AllowedPair {
  /** The declared names: one for a shared name, each for a shared type. */
  readonly names: readonly string[];
  /** Root-relative, `/`-separated: every file that declares one of `names`. */
  readonly files: readonly string[];
  readonly reason: string;
}

const SIMULATOR_ROW = "the simulator's own zod row of what it reads back from the database to judge a run: it states what the run must show, so it is never imported from the code it judges";
const DERIVED_ALIAS = "a local alias derived from the production type by a type operator (its parameters, an indexed access), so it is that type and cannot drift from it; the production module exports no name for it";

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
    names: ["NewSuiteReviewFindings", "SuiteReviewFindingsEntry"],
    files: ["packages/delivery/src/types.ts", "packages/quality/src/repositories/suite-review.ts"],
    reason: "Delivery's port states what its suite-review step records; Quality's repository is what fills it, and neither context may import the other's module outside its ACL",
  },
  {
    names: ["RunBudgetFinding", "VerificationSplitBreak"],
    files: ["scripts/simulator-run-budget.ts", "scripts/verification-split.ts"],
    reason: "each check's own finding: they hold a file, a line and a reason today, and a field one check comes to need must not reach the other",
  },
];

/** One module-level type declaration of production source. */
interface TypeDeclaration {
  readonly name: string;
  /** Root-relative, `/`-separated. */
  readonly file: string;
  readonly line: number;
  /** A package's src/ rather than scripts/: the one-name rule reads only these. */
  readonly inPackage: boolean;
  /** The declared type, and its property names sorted; null when it is no object type of at least MIN_MEMBERS properties. */
  readonly shape: { readonly type: ts.Type; readonly key: string } | null;
}

function isProduction(relative: string): boolean {
  return !relative.endsWith(".test.ts") && !relative.endsWith(".d.ts");
}

function productionModules(context: LintContext, built: ModuleProgram): ProductionModule[] {
  const modules: ProductionModule[] = [];
  for (const pkg of context.packages) {
    for (const filePath of pkg.contents.keys()) {
      const relative = pkg.relativeTo(filePath);
      if (relative.startsWith("src/") && isProduction(relative)) modules.push({ absolute: filePath, file: `packages/${pkg.name}/${relative}`, inPackage: true });
    }
  }
  const scriptsDir = path.join(context.root, "scripts") + path.sep;
  for (const absolute of built.files) {
    const file = path.relative(context.root, absolute).split(path.sep).join("/");
    if (absolute.startsWith(scriptsDir) && isProduction(file)) modules.push({ absolute, file, inPackage: false });
  }
  return modules;
}

function shapeOf(checker: ts.TypeChecker, declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): TypeDeclaration["shape"] {
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return null;
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (type.isUnion() || (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0 || checker.isArrayLikeType(type)) return null;
  const names = checker.getPropertiesOfType(type).map((property) => property.name);
  if (names.length < MIN_MEMBERS) return null;
  return { type, key: names.sort().join("\n") };
}

function typeDeclarations(built: ModuleProgram, modules: readonly ProductionModule[]): TypeDeclaration[] {
  return modules.flatMap((module) => {
    const source = built.sourceFile(module.absolute);
    if (source === undefined) return [];
    return source.statements
      .filter((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      .map((declaration) => ({ name: declaration.name.text, file: module.file, line: lineOf(declaration), inPackage: module.inPackage, shape: shapeOf(built.checker, declaration) }));
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, i) => item === right[i]);
}

/** Groups of two or more declarations that share a name. */
function byName(declarations: readonly TypeDeclaration[]): TypeDeclaration[][] {
  const groups = new Map<string, TypeDeclaration[]>();
  for (const declaration of declarations) {
    const known = groups.get(declaration.name);
    if (known === undefined) groups.set(declaration.name, [declaration]);
    else known.push(declaration);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Groups of two or more declarations whose declared types are one: one property set, each assignable
 * to the other, under one name or several. A group of one name all in packages is the one-name rule's
 * already, so it is left to that rule.
 */
function byType(checker: ts.TypeChecker, declarations: readonly TypeDeclaration[]): TypeDeclaration[][] {
  const byKey = new Map<string, TypeDeclaration[]>();
  for (const declaration of declarations) {
    if (declaration.shape === null) continue;
    const known = byKey.get(declaration.shape.key);
    if (known === undefined) byKey.set(declaration.shape.key, [declaration]);
    else known.push(declaration);
  }
  const groups: TypeDeclaration[][] = [];
  for (const candidates of byKey.values()) {
    const left = [...candidates];
    while (left.length > 0) {
      const [first, ...rest] = left;
      const group = [first, ...rest.filter((other) => first.shape !== null && other.shape !== null && sameType(checker, first.shape.type, other.shape.type))];
      left.splice(0, left.length, ...rest.filter((other) => !group.includes(other)));
      const oneNameInPackages = new Set(group.map((d) => d.name)).size === 1 && group.every((d) => d.inPackage);
      if (group.length > 1 && !oneNameInPackages) groups.push(group);
    }
  }
  return groups;
}

function where(group: readonly TypeDeclaration[]): string {
  return group.map((d) => `${d.name} at ${d.file}:${d.line}`).join(", ");
}

/**
 * The mirrored types of the tree, `allowed` excusing a shared name or type it names with a reason.
 * @testseam mirrored-types.test.ts holds an allowlist entry to the rule without the repository's list
 */
export function mirroredTypes(context: LintContext, allowed: readonly AllowedPair[]): Violation[] {
  const built = contextProgram(context);
  const modules = productionModules(context, built);
  const declarations = typeDeclarations(built, modules);
  const violations: Violation[] = [];
  if (!declarations.some((d) => d.inPackage)) {
    violations.push({ file: "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: "no production type declaration to scan; a scan of nothing would pass" });
  }
  const used = new Set<AllowedPair>();
  const report = (group: readonly TypeDeclaration[], what: string): void => {
    const names = group.map((d) => d.name);
    const files = group.map((d) => d.file);
    const pair = allowed.find((entry) => entry.reason.trim() !== "" && sameSet(entry.names, names) && sameSet(entry.files, files));
    if (pair !== undefined) {
      used.add(pair);
      return;
    }
    const [first] = group;
    if (first === undefined) return;
    const [, pkg] = first.file.split("/");
    violations.push({
      file: first.file,
      line: first.line,
      fromPkg: first.inPackage && pkg !== undefined ? pkg : "scripts",
      specifier: MIRRORED_TYPES,
      reason: `${what}: ${where(group)}; keep one declaration and import it, or name it in MIRRORED_ALLOWED with why it is a distinct concept`,
    });
  };
  for (const group of byName(declarations.filter((d) => d.inPackage))) report(group, "one name declared more than once");
  for (const group of byType(built.checker, declarations)) report(group, new Set(group.map((d) => d.name)).size > 1 ? "one type declared under more than one name" : "one type declared more than once");
  violations.push(...returnTypeViolations(built, modules));
  for (const pair of allowed) {
    if (pair.reason.trim() === "") {
      violations.push({ file: pair.files[0] ?? "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: `the allowed entry ${pair.names.join(", ")} gives no reason; state why the declarations are distinct concepts` });
    } else if (!used.has(pair)) {
      violations.push({ file: pair.files[0] ?? "packages", line: 0, fromPkg: "*", specifier: MIRRORED_TYPES, reason: `the allowed entry ${pair.names.join(", ")} no longer matches its declarations; remove or correct its entry` });
    }
  }
  return violations;
}

export function run(context: LintContext): Violation[] {
  return mirroredTypes(context, MIRRORED_ALLOWED);
}
