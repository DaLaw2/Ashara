/**
 * Negative probes for boundary-rules.toml (the context map), run against the real checker.
 *
 * The map below is the expected side: for every package it states the packages it may import, the
 * packages that admit only some importers, and the files a restricted edge is confined to. The test
 * copies packages/, the rules and the checker into a scratch tree, plants one violating import per
 * forbidden package pair, per restrict rule, per entries rule, for the named-only rule, for the stand-in rule
 * (directly and through a helper) and for the bounds-table rule (a package's name and another
 * file), one manifest-name literal in production source for the
 * [stack-literals] denylist, a write and a raw SQL read of another context's table for the [tables]
 * owner map, an import of another context's table object for db's subpath-importers (by its
 * subpath, by a relative path, from scripts/, and re-exported by db's root entry), an import of a
 * test-only subpath from a file that is no test, an import of a Quality class Delivery does not list
 * (by name and through a namespace), an import of the client_messages table object by an Engagement
 * file outside the one module that holds it (by name and through a namespace), Evaluation's reads of
 * a repository class, of a context's table object and of a context's table in raw SQL (no builder may
 * import Evaluation: its empty importers are probed with every other package's), plus one permitted import
 * per allowed edge, runs scripts/check-boundaries.ts there and asserts it reports exactly the
 * violations the map predicts. So a rule that stops firing fails, and so does an edge widened or
 * narrowed in the rules file without changing the map here.
 *
 * MODULES does the same inside each package that declares internal modules: one type-only relative
 * import per ordered pair of its modules, a file that belongs to no module, a module glob that
 * matches nothing, and, in a scratch copy of the rules, a module-allow cycle the parser must refuse.
 * A scratch copy admits a context to another's tables, which the [tables] owner map refuses, and a
 * last one drops the module-names rule, under which the planted import of the held table object is
 * no longer refused: that rule, and nothing else, is what refuses it.
 *
 * The relational query API is probed by the type checker instead: a context holding the shared
 * Database handle that writes `db.query.<table>` or `tx.query.<table>` must fail to compile, since
 * such a read imports no table object for the checker to refuse.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as dbRoot from "@ashara/db";
import { DB_OWNER, SHARED_OWNER, declaredTables, parseTableOwnershipRules } from "./table-ownership.js";

interface PackageMap {
  /** Packages this one may import; "*" for the composition root. */
  readonly allow: readonly string[] | "*";
  /** The only packages that may import this one, when the map confines it. */
  readonly importers?: readonly string[];
  /** importedPkg -> the package-relative globs that alone may import it. */
  readonly restrict?: Readonly<Record<string, readonly string[]>>;
  /** importedPkg -> the only entry points of it ("." or an exported subpath) this package may import. */
  readonly entries?: Readonly<Record<string, readonly string[]>>;
}

const ACL = ["src/acl/*.ts"];
const ACL_AND_DISPATCH = ["src/acl/*.ts", "src/dispatch/*.ts"];

const MAP: Readonly<Record<string, PackageMap>> = {
  shared: { allow: [] },
  db: { allow: ["shared"] },
  "model-access": { allow: ["shared", "db"], importers: ["finance", "server", "integration"] },
  finance: { allow: ["shared", "db", "model-access"] },
  security: { allow: ["shared", "db"], importers: ["server", "integration"] },
  "execution-infra": { allow: ["shared", "db"] },
  knowledge: { allow: ["shared", "db"] },
  workplace: { allow: ["shared", "db", "finance", "execution-infra"] },
  engagement: {
    allow: ["shared", "db", "finance", "delivery", "quality"],
    entries: { quality: ["published-reads", "published-verdicts", "stored-checks"] },
    restrict: {
      quality: [
        "src/guarantee-report.ts",
        "src/repositories/block-report.ts",
        "src/repositories/delivered-report.ts",
        "src/repositories/early-warning.ts",
        "src/repositories/guarantee-report.ts",
        "src/repositories/terminal-report.ts",
        "src/repositories/told-report.ts",
        "src/vision-language/guarantee.ts",
      ],
      delivery: [
        "src/answers.ts",
        "src/block-report.ts",
        "src/block-report.test.ts",
        "src/client-change.ts",
        "src/client-receipt.ts",
        "src/client-receipt.test.ts",
        "src/inbound-policy.ts",
        "src/inbound-policy.test.ts",
        "src/intake.ts",
        "src/plan-report.ts",
        "src/plan-report.test.ts",
        "src/predicates.ts",
        "src/project-lifecycle.ts",
        "src/repositories/block-report.ts",
        "src/repositories/burn-warning.ts",
        "src/repositories/client-answer.ts",
        "src/repositories/client-change.ts",
        "src/repositories/client-message.ts",
        "src/repositories/client-receipt.ts",
        "src/repositories/delivered-report.ts",
        "src/repositories/early-warning.ts",
        "src/repositories/plan-report.ts",
        "src/repositories/stack-choice.ts",
        "src/repositories/terminal-report.ts",
        "src/repositories/told-report.ts",
        "src/stack-choice.ts",
      ],
    },
  },
  organization: {
    allow: ["shared", "db", "finance", "engagement", "workplace"],
    restrict: { engagement: ACL, workplace: ACL },
  },
  quality: {
    allow: ["shared", "db", "finance", "execution-infra", "workplace", "delivery", "engagement"],
    restrict: { delivery: ACL, engagement: ACL },
  },
  delivery: {
    allow: ["shared", "db", "engagement", "organization", "workplace", "quality", "knowledge", "execution-infra", "finance"],
    restrict: {
      engagement: ACL,
      organization: ACL,
      workplace: ACL_AND_DISPATCH,
      quality: ACL_AND_DISPATCH,
      knowledge: ACL_AND_DISPATCH,
      "execution-infra": ACL_AND_DISPATCH,
      finance: ACL_AND_DISPATCH,
    },
  },
  server: {
    allow: "*",
    restrict: { security: ["src/app.ts", "src/compose.ts", "src/secrets.ts", "src/secrets.test.ts", "src/web-client.ts"] },
  },
  integration: {
    allow: ["shared", "db", "model-access", "finance", "security", "execution-infra", "knowledge", "workplace", "engagement", "organization", "quality", "delivery", "server"],
    importers: [],
  },
  evaluation: {
    allow: ["shared", "db", "finance", "workplace", "engagement", "quality", "delivery"],
    importers: [],
    entries: { delivery: ["predicates", "reads"], engagement: ["."], quality: ["."] },
  },
};

interface ModuleSpec {
  /** The other modules of the package this one may import. */
  readonly allow: readonly string[];
  /** An existing file of the module, package-relative, at whose head its probes are planted. */
  readonly host: string;
  /** The file of the module a probe into it imports: one of its module-entry files when it states them. */
  readonly target: string;
}

const ENTRY = "entry";

// The subpaths of db's schema, spelled apart from any import statement so that the checker's scan of
// scripts/ reads this file's probe text as no import.
const SCHEMA = "@ashara/db/schema";

/** Per package, its internal modules; `entry` may import every module and none may import it. */
const MODULES: Readonly<Record<string, Readonly<Record<string, ModuleSpec>>>> = {
  quality: {
    verification: { allow: ["verdict", "checks", "environment", "suite-review", "acl"], host: "src/verification/suites-verdict.ts", target: "src/gates/finalize.ts" },
    verdict: { allow: ["checks", "environment", "acl"], host: "src/dispatch-result.ts", target: "src/fault-class.ts" },
    checks: { allow: ["acl", "reviewer-record"], host: "src/task-checks.ts", target: "src/public-interface.ts" },
    "suite-review": { allow: ["checks", "acl"], host: "src/suite-review.ts", target: "src/repositories/suite-review.ts" },
    environment: { allow: [], host: "src/environment-check.ts", target: "src/environment-definition.ts" },
    acceptance: { allow: ["verification", "reviewer-record", "guarantee-verdict", "acl"], host: "src/repositories/acceptance.ts", target: "src/repositories/acceptance.ts" },
    "guarantee-verdict": { allow: ["acl"], host: "src/guarantee-verdict.ts", target: "src/guarantee-verdict.ts" },
    "reviewer-record": { allow: [], host: "src/repositories/reviewer-outcome.ts", target: "src/repositories/reviewer-outcome.ts" },
    acl: { allow: [], host: "src/acl/engagement-acl.ts", target: "src/acl/delivery-acl.ts" },
    published: { allow: ["guarantee-verdict", "acl"], host: "src/published-reads.ts", target: "src/published-verdicts.ts" },
    [ENTRY]: { allow: [], host: "src/index.ts", target: "src/index.ts" },
  },
  "execution-infra": {
    cells: { allow: ["checkout", "errors"], host: "src/podman.ts", target: "src/cells.ts" },
    checkout: { allow: ["errors"], host: "src/host-git.ts", target: "src/host-git.ts" },
    environment: { allow: ["cells", "checkout", "errors"], host: "src/environment.ts", target: "src/current-environment.ts" },
    errors: { allow: [], host: "src/errors.ts", target: "src/errors.ts" },
    [ENTRY]: { allow: [], host: "src/index.ts", target: "src/index.ts" },
  },
  engagement: {
    vision: { allow: [], host: "src/vision.ts", target: "src/vision-language/index.ts" },
    intake: { allow: ["vision", "client-messages", "predicates"], host: "src/intake.ts", target: "src/repositories/tender-intake.ts" },
    "client-messages": { allow: ["predicates"], host: "src/repositories/client-message.ts", target: "src/repositories/client-message.ts" },
    inbound: { allow: ["vision", "client-messages", "reports", "predicates", "ports"], host: "src/client-stop.ts", target: "src/answers.ts" },
    reports: { allow: ["vision", "client-messages", "predicates"], host: "src/burn-warning.ts", target: "src/block-report.ts" },
    predicates: { allow: [], host: "src/predicates.ts", target: "src/predicates.ts" },
    ports: { allow: [], host: "src/ports.ts", target: "src/ports.ts" },
    [ENTRY]: { allow: [], host: "src/model-schemas.ts", target: "src/index.ts" },
  },
};

interface ModuleProbeLine {
  readonly name: string;
  readonly line: string;
  /** The checker's reason for the line; null when it must draw no report. */
  readonly reason: string | null;
}

/** Lines planted after the pair probes in a module's host. */
const MODULE_EXTRAS: Readonly<Record<string, Readonly<Record<string, readonly ModuleProbeLine[]>>>> = {
  quality: {
    // The class lives in the verdict module so that the verdict module needs no edge into verification.
    verdict: [
      {
        name: "quality: the verdict module takes VerificationInfrastructureFault from no verification file",
        line: 'import { VerificationInfrastructureFault } from "./gates/finalize.js";',
        reason: "module verdict may not import module verification (module-allow.verdict: [checks, environment, acl])",
      },
    ],
  },
  "execution-infra": {
    // A cell snapshots a repository from the host; it never holds a worktree or the checkout lock.
    cells: [
      {
        name: "execution-infra: cells import no checkout file but host-git.ts",
        line: 'import type * as probe from "./worktree.js";',
        reason: "module cells may import only [src/host-git.ts] of module checkout (module-allow.cells)",
      },
    ],
    environment: [
      {
        name: "execution-infra: environment reads checkout only through its module-entry",
        line: 'import type * as probe from "./tree-read.js";',
        reason: "module checkout admits imports only of module-entry.checkout: [src/host-git.ts, src/target-repo.ts, src/worktree.ts]",
      },
    ],
  },
  engagement: {
    // The module that holds the client_messages table object hands it to no other file.
    "client-messages": [
      {
        name: "engagement: the client channel re-exports no table object it holds",
        line: `export { clientMessages } from "${SCHEMA}/engagement";`,
        reason: `module-names.client-messages: re-exports "clientMessages", which hands it to every importer of the file`,
      },
    ],
  },
};

/** The other probes' own files are in no module, so the probed run's rules give them one. */
const PROBE_MODULE = 'module.probe = ["src/__boundary_probe__/**"]';
const UNASSIGNED_FILE = "src/__module_probe__.ts";
const EMPTY_MODULE = { name: "probe-empty", glob: "src/__no_such_module_file__.ts" };
const CYCLE_RULE = { pkg: "engagement", line: 'module-allow.vision = ["reports"]', reason: "a cycle between modules: vision -> reports -> vision" };
const MODULE_NAMES_RULE = 'module-names.client-messages = ["db/schema/engagement:clientMessages"]';
const OWNER_SUBPATH_RULE = 'subpath-importers.schema/delivery = ["delivery", "server", "integration"]';
const WIDENED_SUBPATH_RULE = 'subpath-importers.schema/delivery = ["delivery", "quality", "server", "integration"]';
const WIDENED_SUBPATH_REASON = 'admits "quality" to work_items, which "delivery" owns';

function relativeSpecifier(fromFile: string, toFile: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\.ts$/, ".js");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function moduleProbes(pkg: string): PlannedProbe[] {
  const modules = MODULES[pkg];
  const probes: PlannedProbe[] = [];
  for (const [from, spec] of Object.entries(modules)) {
    const file = `packages/${pkg}/${spec.host}`;
    const planned: ModuleProbeLine[] = [];
    for (const [to, target] of Object.entries(modules)) {
      if (to === from) continue;
      const reason =
        from === ENTRY ? null
        : to === ENTRY ? `module ${from} may not import the entry module`
        : spec.allow.includes(to) ? null
        : `module ${from} may not import module ${to} (module-allow.${from}: [${spec.allow.join(", ")}])`;
      planned.push({
        name: `${pkg}: module ${from} -> ${to} is ${reason === null ? "permitted" : "refused"}`,
        line: `import type * as probe from "${relativeSpecifier(spec.host, target.target)}";`,
        reason,
      });
    }
    planned.push(...(MODULE_EXTRAS[pkg]?.[from] ?? []));
    const block = planned.map((probe) => `${probe.line}\n`).join("");
    planned.forEach((probe, i) => {
      const specifier = /"([^"]+)";$/.exec(probe.line)?.[1];
      if (specifier === undefined) throw new ProbeTreeError("module probe", `no specifier in ${probe.line}`);
      probes.push({
        name: probe.name,
        file,
        // The whole block goes in with the first line's probe; the others add nothing to the file.
        content: i === 0 ? block : "",
        line: i + 1,
        violation: probe.reason === null ? null : `${file}:${i + 1}  ${pkg} -> "${specifier}"  (${probe.reason})`,
        prepend: true,
      });
    });
  }
  const unassigned = `packages/${pkg}/${UNASSIGNED_FILE}`;
  probes.push({
    name: `${pkg}: a file in no module is refused`,
    file: unassigned,
    content: "export {};\n",
    violation: `${unassigned}:0  ${pkg} -> "module"  (belongs to no module of [${pkg}]; add it to one module's glob)`,
  });
  probes.push({
    name: `${pkg}: a module glob that matches no file is refused`,
    file: `packages/${pkg}/${EMPTY_MODULE.glob}`,
    content: null,
    violation: `boundary-rules.toml:0  ${pkg} -> "module.${EMPTY_MODULE.name}"  ("${EMPTY_MODULE.glob}" matches no file; a module rule that holds nothing passes everything)`,
  });
  return probes;
}

/** The rules with `lines` added at the head of each named package's section. */
function withSectionLines(toml: string, lines: Readonly<Record<string, readonly string[]>>): string {
  let out = toml;
  for (const [pkg, added] of Object.entries(lines)) {
    const header = `\n[${pkg}]\n`;
    if (!out.includes(header)) throw new ProbeTreeError("rules copy", `no [${pkg}] section`);
    out = out.replace(header, `${header}${added.map((line) => `${line}\n`).join("")}`);
  }
  return out;
}

/** Each section of the rules that declares modules, with the module names it declares. */
function declaredModules(toml: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const header = /^\[([a-z][a-z0-9-]*)\]$/.exec(line);
    if (header !== null) section = header[1];
    const declared = /^module\.([a-z][a-z0-9-]*)\s*=/.exec(line);
    if (declared !== null) found[section] = [...(found[section] ?? []), declared[1]];
  }
  return found;
}

const NAMED_ONLY_PROBE = {
  file: "packages/integration/src/simulator/__boundary_probe__.ts",
  content: 'import { NotAListedName } from "@ashara/shared";\n',
  violation: 'packages/integration/src/simulator/__boundary_probe__.ts:1  integration -> "@ashara/shared"  (named-only file: "NotAListedName" is not in names.shared)',
};

const STACK_LITERAL_PROBE = {
  file: "packages/delivery/src/__boundary_probe__/stack-literal.ts",
  content: 'export const MANIFEST = "Cargo.toml";\n',
  violation:
    'packages/delivery/src/__boundary_probe__/stack-literal.ts:1  delivery -> "Cargo.toml"  (stack literal in production source: "Cargo.toml"; take it from the contract, or exempt it in [stack-literals] with a reason)',
};

// A context writing another context's table through drizzle and through raw SQL, and reading one in
// raw SQL that no [tables] exemption admits, each on its own line of one file. The table object the
// drizzle write names is itself an import db's subpath-importers refuse; a drizzle read of it is
// therefore no probe of the [tables] scan.
const TABLE_PROBE_FILE = "packages/delivery/src/__boundary_probe__/table-ownership.ts";
const TABLE_PROBE_CONTENT = [
  'import { sql } from "drizzle-orm";',
  `import { clientMessages } from "${SCHEMA}/engagement";`,
  "export const write = (tx: { insert(table: unknown): unknown }) => tx.insert(clientMessages);",
  "export const rawWrite = sql`UPDATE acceptance_sweeps SET details = 'x'`;",
  "export const rawRead = sql`SELECT count(*) FROM llm_calls`;",
  "export const rawLock = sql`SELECT id FROM dev_sessions WHERE id = ${1} FOR UPDATE`;",
  "",
].join("\n");
const SUBPATH_REFUSAL = (pkg: string): string => `only [${pkg}, server, integration] may import "${SCHEMA}/${pkg}" (subpath-importers.schema/${pkg})`;
// Engagement renders Quality's guarantee verdicts and never reads or writes guarantee_verdicts itself.
const VERDICT_PROBE_FILE = "packages/engagement/src/__boundary_probe__/guarantee-verdicts.ts";
const VERDICT_PROBE_CONTENT = [
  'import { sql } from "drizzle-orm";',
  `import { guaranteeVerdicts } from "${SCHEMA}/quality";`,
  "export const write = (tx: { insert(table: unknown): unknown }) => tx.insert(guaranteeVerdicts);",
  "export const rawRead = sql`SELECT verdict FROM guarantee_verdicts`;",
  "",
].join("\n");
// Engagement files outside the client channel's module, each taking the client_messages table object
// it holds: by name in an inbound repository, and through a namespace in a report's; and one taking
// another of Engagement's tables from the same entry, which the rule leaves alone.
const HELD_TABLE_FILE = "packages/engagement/src/repositories/client-stop.ts";
const HELD_NAMESPACE_FILE = "packages/engagement/src/repositories/told-report.ts";
const HELD_TABLE_REFUSAL = 'only module client-messages may import "clientMessages" of "@ashara/db/schema/engagement"; go through its entries';
const HELD_TABLE_PROBES: PlannedProbe[] = [
  {
    name: "an Engagement file outside the client channel importing the client_messages table object is refused",
    file: HELD_TABLE_FILE,
    content: `import { clientMessages } from "${SCHEMA}/engagement";\n`,
    violation: `${HELD_TABLE_FILE}:1  engagement -> "${SCHEMA}/engagement"  (module-names.client-messages: ${HELD_TABLE_REFUSAL})`,
    prepend: true,
  },
  {
    name: "an Engagement file outside the client channel reaching the client_messages table object through a namespace is refused",
    file: HELD_NAMESPACE_FILE,
    content: `import * as engagementTables from "${SCHEMA}/engagement";\n`,
    violation:
      `${HELD_NAMESPACE_FILE}:1  engagement -> "${SCHEMA}/engagement"  ` +
      '(module-names.client-messages: a namespace or default import names no symbol, so "clientMessages" could be reached through it; import the names in braces)',
    prepend: true,
  },
  {
    name: "an Engagement file imports its other table objects from the same entry",
    file: "packages/engagement/src/repositories/burn-warning.ts",
    content: `import { toldReports } from "${SCHEMA}/engagement";\n`,
    violation: null,
    prepend: true,
  },
];

const TABLE_PROBES = [
  {
    name: "engagement importing Quality's guarantee_verdicts table object is refused",
    file: VERDICT_PROBE_FILE,
    content: VERDICT_PROBE_CONTENT,
    violation: `${VERDICT_PROBE_FILE}:2  engagement -> "${SCHEMA}/quality"  (${SUBPATH_REFUSAL("quality")})`,
  },
  {
    // Planted by the probe above, on its third line: this entry adds nothing to the file.
    name: "engagement writes no guarantee verdict: Quality owns guarantee_verdicts",
    file: VERDICT_PROBE_FILE,
    content: null,
    violation: `${VERDICT_PROBE_FILE}:3  engagement -> "guarantee_verdicts"  (writes a table "quality" owns: tx.insert(guaranteeVerdicts); go through quality's exported write entry)`,
  },
  {
    // Planted by the probe above, on its fourth line: this entry adds nothing to the file.
    name: "engagement reads no guarantee verdict but through Quality's published verdicts",
    file: VERDICT_PROBE_FILE,
    content: null,
    violation:
      `${VERDICT_PROBE_FILE}:4  engagement -> "guarantee_verdicts"  (raw SQL reads a table "quality" owns: SELECT verdict FROM guarantee_verdicts; ` +
      "read it through quality's typed read, or admit it in [tables] as an allowed edge with its reason)",
  },
  {
    // Planted by the probe below, on its second line: this entry adds nothing to the file.
    name: "a context importing another context's table object for a drizzle write is refused",
    file: TABLE_PROBE_FILE,
    content: null,
    violation: `${TABLE_PROBE_FILE}:2  delivery -> "${SCHEMA}/engagement"  (${SUBPATH_REFUSAL("engagement")})`,
  },
  {
    name: "a write to another context's table through drizzle is refused",
    file: TABLE_PROBE_FILE,
    content: TABLE_PROBE_CONTENT,
    violation: `${TABLE_PROBE_FILE}:3  delivery -> "client_messages"  (writes a table "engagement" owns: tx.insert(clientMessages); go through engagement's exported write entry)`,
  },
  {
    // Planted by the probe above, on its fourth line: this entry adds nothing to the file.
    name: "a write to another context's table in raw SQL is refused",
    file: TABLE_PROBE_FILE,
    content: null,
    violation: `${TABLE_PROBE_FILE}:4  delivery -> "acceptance_sweeps"  (writes a table "quality" owns: UPDATE acceptance_sweeps SET details = 'x'; go through quality's exported write entry)`,
  },
  {
    name: "a raw SQL read of another context's table no allowed edge admits is refused",
    file: TABLE_PROBE_FILE,
    content: null,
    violation:
      `${TABLE_PROBE_FILE}:5  delivery -> "llm_calls"  (raw SQL reads a table "finance" owns: SELECT count(*) FROM llm_calls; ` +
      "read it through finance's typed read, or admit it in [tables] as an allowed edge with its reason)",
  },
  {
    // Planted by the write probe, on its sixth line: this entry adds nothing to the file.
    name: "a raw FOR UPDATE lock on another context's table is refused",
    file: TABLE_PROBE_FILE,
    content: null,
    violation:
      `${TABLE_PROBE_FILE}:6  delivery -> "dev_sessions"  (raw SQL reads a table "workplace" owns: SELECT id FROM dev_sessions WHERE id = ? FOR UPDATE; ` +
      "read it through workplace's typed read, or admit it in [tables] as an allowed edge with its reason)",
  },
];

// Another context's table object imported by its subpath, by a relative path into db and from
// scripts/, the owner's own import of it, db's root entry re-exporting it, and a subpath rule that
// names no exported subpath.
const DB_ROOT_ENTRY = "packages/db/src/index.ts";
const DELIVERY_SCHEMA = "packages/db/src/schema/delivery.ts";
const RULES_TEXT = fs.readFileSync(path.join(import.meta.dirname, "..", "boundary-rules.toml"), "utf-8");
const TABLE_OWNERS = parseTableOwnershipRules(RULES_TEXT, "boundary-rules.toml").owners;
const DELIVERY_TABLES = declaredTables(fs.readFileSync(path.join(import.meta.dirname, "..", DELIVERY_SCHEMA), "utf-8"), DELIVERY_SCHEMA)
  .map((table) => `${table.name} ("${TABLE_OWNERS.get(table.name)}")`)
  .join(", ");
const UNEXPORTED_SUBPATH_RULE = 'subpath-importers.schema/nowhere = ["server"]';
// The test builders of a test-only subpath, imported by production source (by its @ashara/ name, and
// by a relative path inside its package) and by a test, the test harness and another test-only entry,
// which may; and a Quality class Delivery's classes.quality does not list, by name and through a
// namespace, and a type-only import of one.
const TEST_ONLY = (specifier: string): string => `only a test file (*.test.ts), the test harness or another test-only entry may import "${specifier}" (test-only-subpaths)`;
const UNLISTED_CLASS = (name: string): string => `classes.quality: "${name}" is a class of "quality" it does not list; receive it as a port the composition root builds`;
const TEST_SUPPORT_PROBES: PlannedProbe[] = [
  {
    name: "production source imports no inert loop builder",
    file: "packages/server/src/__boundary_probe__/test-only-delivery.ts",
    content: 'import { inertCoreLoopDeps } from "@ashara/delivery/testing";\n',
    violation: `packages/server/src/__boundary_probe__/test-only-delivery.ts:1  server -> "@ashara/delivery/testing"  (${TEST_ONLY("@ashara/delivery/testing")})`,
  },
  {
    name: "production source imports no shared test double",
    file: "packages/delivery/src/__boundary_probe__/test-only-shared.ts",
    content: 'import { notExercised } from "@ashara/shared/testing";\n',
    violation: `packages/delivery/src/__boundary_probe__/test-only-shared.ts:1  delivery -> "@ashara/shared/testing"  (${TEST_ONLY("@ashara/shared/testing")})`,
  },
  {
    name: "the test harness imports the test builders",
    file: "packages/integration/src/__boundary_probe__/test-only-harness.ts",
    content: 'import { inertCoreLoopDeps } from "@ashara/delivery/testing";\nimport { notExercised } from "@ashara/shared/testing";\n',
    violation: null,
  },
  {
    name: "production source imports no SuiteReviewer test builder",
    file: "packages/server/src/__boundary_probe__/test-only-quality.ts",
    content: 'import { suiteReviewerFor } from "@ashara/quality/testing";\n',
    violation: `packages/server/src/__boundary_probe__/test-only-quality.ts:1  server -> "@ashara/quality/testing"  (${TEST_ONLY("@ashara/quality/testing")})`,
  },
  {
    name: "production source of the package reaches no test builder by a relative path",
    file: "packages/delivery/src/__boundary_probe__/test-only-relative.ts",
    content: 'import { inertCoreLoopDeps } from "../testing.js";\n',
    violation: `packages/delivery/src/__boundary_probe__/test-only-relative.ts:1  delivery -> "../testing.js"  (${TEST_ONLY("@ashara/delivery/testing")})`,
  },
  {
    name: "a test imports the test builders",
    file: "packages/integration/src/__boundary_probe__/test-only.test.ts",
    content: 'import { inertCoreLoopDeps } from "@ashara/delivery/testing";\nimport { suiteReviewerFor } from "@ashara/quality/testing";\n',
    violation: null,
  },
  {
    name: "Delivery constructs none of Quality's verification jobs",
    file: "packages/delivery/src/dispatch/__boundary_probe_class__.ts",
    content: 'import { DispatchCells } from "@ashara/quality";\n',
    violation: `packages/delivery/src/dispatch/__boundary_probe_class__.ts:1  delivery -> "@ashara/quality"  (${UNLISTED_CLASS("DispatchCells")})`,
  },
  {
    name: "Delivery reaches no Quality class through a namespace import",
    file: "packages/delivery/src/dispatch/__boundary_probe_namespace__.ts",
    content: 'import * as quality from "@ashara/quality";\n',
    violation:
      'packages/delivery/src/dispatch/__boundary_probe_namespace__.ts:1  delivery -> "@ashara/quality"  ' +
      "(classes.quality: a namespace or default import names no symbol, so a class could be reached through it; import the names in braces)",
  },
  {
    name: "Delivery may name a Quality class as a type",
    file: "packages/delivery/src/dispatch/__boundary_probe_type__.ts",
    content: 'import type { DispatchCells } from "@ashara/quality";\nimport { type SubstrateGate } from "@ashara/quality";\n',
    violation: null,
  },
];

// Evaluation reads every context through that context's published reads: a repository class (db's
// or a context's), a context's table object and a raw SQL read of a context's table are each refused.
const EVALUATION_PROBE_FILE = "packages/evaluation/src/__boundary_probe__/unpublished-read.ts";
const UNLISTED_EVALUATION_CLASS = (pkg: string, name: string): string =>
  `classes.${pkg}: "${name}" is a class of "${pkg}" it does not list; receive it as a port the composition root builds`;
const EVALUATION_PROBES: PlannedProbe[] = [
  {
    name: "Evaluation imports no repository class of db",
    file: EVALUATION_PROBE_FILE,
    content: [
      'import { sql } from "drizzle-orm";',
      'import { ProjectRepository } from "@ashara/db";',
      'import { DevSessionRepository } from "@ashara/workplace";',
      `import { devSessions } from "${SCHEMA}/workplace";`,
      "export const rawRead = sql`SELECT id FROM dev_sessions`;",
      "",
    ].join("\n"),
    violation: `${EVALUATION_PROBE_FILE}:2  evaluation -> "@ashara/db"  (${UNLISTED_EVALUATION_CLASS("db", "ProjectRepository")})`,
  },
  {
    // Planted by the probe above, on its third line: this entry adds nothing to the file.
    name: "Evaluation imports no repository class of a context",
    file: EVALUATION_PROBE_FILE,
    content: null,
    violation: `${EVALUATION_PROBE_FILE}:3  evaluation -> "@ashara/workplace"  (${UNLISTED_EVALUATION_CLASS("workplace", "DevSessionRepository")})`,
  },
  {
    // Planted by the probe above, on its fourth line: this entry adds nothing to the file.
    name: "Evaluation imports no context's table object",
    file: EVALUATION_PROBE_FILE,
    content: null,
    violation: `${EVALUATION_PROBE_FILE}:4  evaluation -> "${SCHEMA}/workplace"  (${SUBPATH_REFUSAL("workplace")})`,
  },
  {
    // Planted by the probe above, on its fifth line: this entry adds nothing to the file.
    name: "Evaluation reads no context's table in raw SQL",
    file: EVALUATION_PROBE_FILE,
    content: null,
    violation:
      `${EVALUATION_PROBE_FILE}:5  evaluation -> "dev_sessions"  (raw SQL reads a table "workplace" owns: SELECT id FROM dev_sessions; ` +
      "read it through workplace's typed read, or admit it in [tables] as an allowed edge with its reason)",
  },
];

const SUBPATH_PROBES: PlannedProbe[] = [
  {
    name: "a context importing another context's table object by its subpath is refused",
    file: "packages/quality/src/__boundary_probe__/foreign-table.ts",
    content: `import { workItems } from "${SCHEMA}/delivery";\n`,
    violation: `packages/quality/src/__boundary_probe__/foreign-table.ts:1  quality -> "${SCHEMA}/delivery"  (${SUBPATH_REFUSAL("delivery")})`,
  },
  {
    name: "a context imports its own table objects by its subpath",
    file: "packages/delivery/src/__boundary_probe__/own-table.ts",
    content: `import { workItems } from "${SCHEMA}/delivery";\n`,
    violation: null,
  },
  {
    name: "a context reaching db's table objects by a relative path is refused",
    file: "packages/quality/src/__boundary_probe__/relative-table.ts",
    content: 'import { workItems } from "../../../db/src/schema/delivery.js";\n',
    violation:
      'packages/quality/src/__boundary_probe__/relative-table.ts:1  quality -> "../../../db/src/schema/delivery.js"  ' +
      '(a relative path into package "db", whose subpaths admit only the importers its subpath-importers list; import it by its @ashara/ name)',
  },
  {
    name: "a script importing a context's table object is refused",
    file: "scripts/__boundary_probe__.ts",
    content: `import { workItems } from "${SCHEMA}/delivery";\n`,
    violation: `scripts/__boundary_probe__.ts:1  scripts -> "${SCHEMA}/delivery"  (scripts/ imports no subpath of package "db", whose subpath-importers admit only packages)`,
  },
  {
    name: "db's root entry re-exporting a context's table object is refused",
    file: DB_ROOT_ENTRY,
    content: 'export { workItems } from "./schema/delivery.js";\n',
    violation: `${DB_ROOT_ENTRY}:0  db -> "${DELIVERY_SCHEMA}"  (the root entry re-exports from a file declaring tables a package owns: ${DELIVERY_TABLES}; each is reached only through its subpath)`,
    prepend: true,
  },
  {
    name: "a subpath rule that names no exported subpath is refused",
    file: "packages/db/package.json",
    content: null,
    violation: `boundary-rules.toml:0  db -> "subpath-importers.schema/nowhere"  (packages/db/package.json exports no "./schema/nowhere"; a rule that holds nothing passes everything)`,
  },
];

// A stand-in model importing a product rule (a name names.delivery lists, so only the stand-in list
// refuses it), directly, through a simulator helper that re-exports one, and by a relative path into
// the package that owns it.
const STAND_IN = "packages/integration/src/simulator/scripted-models.ts";
const STAND_IN_HELPER = "packages/integration/src/simulator/__boundary_probe_helper__.ts";
const STAND_IN_PROBES = [
  {
    name: "a stand-in model imports no product rule",
    file: STAND_IN,
    content: 'import { parseStoredTaskSpec } from "@ashara/delivery";\nimport { probedRule } from "./__boundary_probe_helper__.js";\n',
    violation: `${STAND_IN}:1  integration -> "@ashara/delivery"  (stand-in model file: "parseStoredTaskSpec" is not in stand-in-names.delivery)`,
    prepend: true,
  },
  {
    name: "a named-only file reaches no other package by a relative path",
    file: "packages/integration/src/simulator/__boundary_probe_escape__.ts",
    content: 'import { parseStoredTaskSpec } from "../../../delivery/src/index.js";\n',
    violation:
      'packages/integration/src/simulator/__boundary_probe_escape__.ts:1  integration -> "../../../delivery/src/index.js"  ' +
      "(named-only file: the relative import leaves the package; import another package by its @ashara/ name)",
  },
  {
    name: "a stand-in model is handed no product rule by a helper",
    file: STAND_IN_HELPER,
    content: 'export { parseStoredBlockedReason as probedRule } from "@ashara/delivery";\n',
    violation:
      `${STAND_IN_HELPER}:1  integration -> "@ashara/delivery"  ` +
      "(reached by a value import from stand-in src/simulator/scripted-models.ts: \"parseStoredBlockedReason\" is not in stand-in-names.delivery)",
  },
];

// The oracle's bounds table importing a production bound, by name (a name names.workplace lists, so
// only the bounds-table rule refuses it) and through another simulator file.
const BOUNDS_TABLE = "packages/integration/src/simulator/work-bounds.ts";
const BOUNDS_TABLE_PROBES = [
  {
    name: "the oracle's bounds table imports no production bound",
    file: BOUNDS_TABLE,
    content: 'import { CHECK_MISSING_EXIT } from "@ashara/workplace";\nimport { PROFILES } from "./profile.js";\n',
    violation: `${BOUNDS_TABLE}:1  integration -> "@ashara/workplace"  (bounds-table file: it imports nothing from another package; each bound cites its decision instead)`,
    prepend: true,
  },
  {
    // Planted by the probe above, on its second line: this entry adds nothing to the file.
    name: "the oracle's bounds table imports no other file",
    file: BOUNDS_TABLE,
    content: "",
    violation: `${BOUNDS_TABLE}:2  integration -> "./profile.js"  (bounds-table file: it imports no other file, which could hand it a production constant)`,
    prepend: true,
  },
];

const REPO = path.resolve(import.meta.dirname, "..");
const PROBE_DIR = "src/__boundary_probe__";

class ProbeTreeError extends Error {
  constructor(readonly operation: string, readonly detail: string) {
    super(`boundary probes: ${operation}: ${detail}`);
    this.name = "ProbeTreeError";
  }
}

interface PlannedProbe {
  readonly name: string;
  readonly file: string;
  /** null: a probe of the rules alone, which plants no file. */
  readonly content: string | null;
  /** The checker's report line for it; null for a permitted import, which must report nothing. */
  readonly violation: string | null;
  /** Planted at the head of an existing file, which the clean run passed, so it is reported at :1. */
  readonly prepend?: boolean;
  /** The line it is planted on, when one file holds several probes; a permitted one draws no report there. */
  readonly line?: number;
}

function reportLine(file: string, fromPkg: string, toPkg: string, reason: string): string {
  return `${file}:1  ${fromPkg} -> "@ashara/${toPkg}"  (${reason})`;
}

function plannedProbes(packages: readonly string[]): PlannedProbe[] {
  const probes: PlannedProbe[] = [];
  for (const from of packages) {
    const rule = MAP[from];
    for (const to of packages) {
      if (to === from) continue;
      const importers = MAP[to].importers;
      const refusedByImporters = importers !== undefined && !importers.includes(from);
      const allowed = rule.allow === "*" || rule.allow.includes(to);
      const file = `packages/${from}/${PROBE_DIR}/edge-${to}.ts`;
      if (refusedByImporters) {
        probes.push({
          name: `${from} -> ${to} is refused (importers)`,
          file,
          content: `import "@ashara/${to}";\n`,
          violation: reportLine(file, from, to, `package "${to}" admits only importers [${importers.join(", ")}]`),
        });
      } else if (!allowed) {
        probes.push({
          name: `${from} -> ${to} is refused (allow)`,
          file,
          content: `import "@ashara/${to}";\n`,
          violation: reportLine(file, from, to, `package "${to}" not in allow list`),
        });
      } else {
        const globs = rule.restrict?.[to];
        const entries = rule.entries?.[to];
        // An import a package's entries admit, so that only the rule probed can refuse it.
        const entry = entries === undefined || entries.includes(".") ? to : `${to}/${entries[0]}`;
        if (globs !== undefined) {
          probes.push({
            name: `${from} -> ${to} is confined to ${globs.join(", ")}`,
            file,
            content: `import "@ashara/${entry}";\n`,
            violation: reportLine(file, from, entry, `only ${globs.join(", ")} may import package "${to}"`),
          });
          const inside = globs[0].includes("*")
            ? `packages/${from}/${globs[0].replace("*", `__boundary_probe_${to}`)}`
            : `packages/${from}/${globs[0]}`;
          probes.push({ name: `${from} -> ${to} is permitted in ${globs[0]}`, file: inside, content: `import "@ashara/${entry}";\n`, violation: null });
        } else {
          probes.push({ name: `${from} -> ${to} is permitted`, file, content: `import "@ashara/${entry}";\n`, violation: null });
        }
        if (entries !== undefined && !entries.includes(".")) {
          // Planted where the restrict rule admits the package, so only the entries rule refuses it.
          const host = globs === undefined ? `${PROBE_DIR}/entry-${to}.ts` : (globs[1] ?? globs[0]).replace("*", `__boundary_probe_entry_${to}`);
          const at = `packages/${from}/${host}`;
          probes.push({
            name: `${from} -> ${to} imports only the entries ${entries.join(", ")}`,
            file: at,
            content: `import "@ashara/${to}";
`,
            violation: reportLine(at, from, to, `only the entries ${entries.join(", ")} of package "${to}" may be imported`),
            prepend: true,
          });
        }
      }
    }
  }
  probes.push({ name: "integration simulator imports only listed names", ...NAMED_ONLY_PROBE });
  probes.push({ name: "a manifest name literal in production source is refused", ...STACK_LITERAL_PROBE });
  probes.push(...TABLE_PROBES);
  probes.push(...HELD_TABLE_PROBES);
  probes.push(...SUBPATH_PROBES);
  probes.push(...STAND_IN_PROBES);
  probes.push(...BOUNDS_TABLE_PROBES);
  probes.push(...TEST_SUPPORT_PROBES);
  probes.push(...EVALUATION_PROBES);
  for (const pkg of Object.keys(MODULES)) probes.push(...moduleProbes(pkg));
  return probes;
}

function copyTree(packages: readonly string[], into: string): void {
  fs.mkdirSync(path.join(into, "scripts"), { recursive: true });
  for (const file of ["boundary-rules.toml", "tsconfig.json", "scripts/check-boundaries.ts", "scripts/optional-deps.ts", "scripts/predicate-copies.ts", "scripts/price-defaults.ts", "scripts/simulator-run-budget.ts", "scripts/stack-literals.ts", "scripts/table-ownership.ts", "scripts/verification-split.ts"]) {
    fs.copyFileSync(path.join(REPO, file), path.join(into, file));
  }
  fs.cpSync(path.join(REPO, "scripts", "lints"), path.join(into, "scripts", "lints"), { recursive: true });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(into, "node_modules"), "dir");
  for (const pkg of packages) {
    // The optional-deps scan resolves @ashara/* by each package's exports.
    fs.mkdirSync(path.join(into, "packages", pkg), { recursive: true });
    fs.copyFileSync(path.join(REPO, "packages", pkg, "package.json"), path.join(into, "packages", pkg, "package.json"));
    for (const dir of ["src", "test"]) {
      const from = path.join(REPO, "packages", pkg, dir);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(into, "packages", pkg, dir), {
        recursive: true,
        filter: (source) => !source.includes(`${path.sep}node_modules`) && (fs.statSync(source).isDirectory() || source.endsWith(".ts")),
      });
    }
  }
}

function plant(root: string, probe: PlannedProbe): void {
  if (probe.content === null) return;
  const target = path.join(root, probe.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, probe.content);
    return;
  }
  // A restrict rule that lists files by name is probed inside one of them; the file passed the
  // clean run, so a permitted probe there must leave it reporting nothing, and a violating one
  // planted at its head is reported at :1.
  if (probe.violation !== null && probe.prepend !== true) {
    throw new ProbeTreeError("plant", `${probe.file} exists; a violating probe must be a file of its own, reported at :1`);
  }
  fs.writeFileSync(target, `${probe.content}${fs.readFileSync(target, "utf-8")}`);
}

function runChecker(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "scripts", "check-boundaries.ts")], {
    cwd: root,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.error !== undefined) throw new ProbeTreeError("run check-boundaries", result.error.message);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const VIOLATION_LINE = /^ {2}(\S+:\d+ {2}.+)$/;

describe("boundary-rules.toml against the context map", () => {
  const packages = fs.readdirSync(path.join(REPO, "packages"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const probes = plannedProbes(packages.filter((pkg) => pkg in MAP));
  let scratch = "";
  let clean: { status: number | null; output: string } = { status: null, output: "" };
  let probed: { status: number | null; output: string } = { status: null, output: "" };
  let cyclic: { status: number | null; output: string } = { status: null, output: "" };
  let widened: { status: number | null; output: string } = { status: null, output: "" };
  let unheld: { status: number | null; output: string } = { status: null, output: "" };
  let reported = new Set<string>();

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-boundary-probes-"));
    copyTree(packages, scratch);
    clean = runChecker(scratch);
    const rulesFile = path.join(scratch, "boundary-rules.toml");
    const rules = fs.readFileSync(rulesFile, "utf-8");
    const probeModules = Object.fromEntries(Object.keys(MODULES).map((pkg) => [pkg, [PROBE_MODULE, `module.${EMPTY_MODULE.name} = ["${EMPTY_MODULE.glob}"]`]]));
    fs.writeFileSync(rulesFile, withSectionLines(rules, { ...probeModules, db: [UNEXPORTED_SUBPATH_RULE] }));
    for (const probe of probes) plant(scratch, probe);
    probed = runChecker(scratch);
    fs.writeFileSync(rulesFile, withSectionLines(rules, { [CYCLE_RULE.pkg]: [CYCLE_RULE.line] }));
    cyclic = runChecker(scratch);
    if (!rules.includes(OWNER_SUBPATH_RULE)) throw new ProbeTreeError("rules copy", `no line ${OWNER_SUBPATH_RULE}`);
    fs.writeFileSync(rulesFile, rules.replace(OWNER_SUBPATH_RULE, WIDENED_SUBPATH_RULE));
    widened = runChecker(scratch);
    if (!rules.includes(MODULE_NAMES_RULE)) throw new ProbeTreeError("rules copy", `no line ${MODULE_NAMES_RULE}`);
    fs.writeFileSync(rulesFile, rules.replace(MODULE_NAMES_RULE, ""));
    unheld = runChecker(scratch);
    reported = new Set(probed.output.split("\n").flatMap((line) => {
      const match = VIOLATION_LINE.exec(line);
      return match === null ? [] : [match[1]];
    }));
  }, 300_000);

  afterAll(() => {
    if (scratch !== "") fs.rmSync(scratch, { recursive: true, force: true });
  });

  test("the map names every package under packages/ and nothing else", () => {
    expect(Object.keys(MAP).sort()).toEqual(packages);
  });

  test("MODULES names every package that declares modules, and each module it declares", () => {
    const declared = declaredModules(fs.readFileSync(path.join(REPO, "boundary-rules.toml"), "utf-8"));
    const sorted = (map: Record<string, readonly string[]>): Record<string, string[]> =>
      Object.fromEntries(Object.entries(map).map(([pkg, names]) => [pkg, [...names].sort()]));
    expect(sorted(declared)).toEqual(sorted(Object.fromEntries(Object.entries(MODULES).map(([pkg, modules]) => [pkg, Object.keys(modules)]))));
  });

  test("a module-allow cycle fails the rules' parse", () => {
    expect(cyclic.status).toBe(1);
    expect(cyclic.output).toContain(CYCLE_RULE.reason);
  });

  test("a subpath rule admitting a context to another's tables fails against the [tables] owner map", () => {
    expect(widened.status).toBe(1);
    expect(widened.output).toContain(WIDENED_SUBPATH_REASON);
  });

  test("without the module-names rule, the planted imports of the held table object are not refused", () => {
    const heldReports = unheld.output.split("\n").filter((line) => line.includes("module-names.client-messages"));
    expect(heldReports).toEqual([]);
    for (const file of [HELD_TABLE_FILE, HELD_NAMESPACE_FILE]) expect(unheld.output).not.toContain(`${file}:1  `);
    expect(unheld.output).toContain("violations found");
  });

  test("db's root entry exports no table object a package owns", () => {
    const tables = Object.values(dbRoot).filter((value) => is(value, PgTable)).map((table) => getTableName(table));
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((name) => {
      const owner = TABLE_OWNERS.get(name);
      return owner !== DB_OWNER && owner !== SHARED_OWNER;
    })).toEqual([]);
  });

  test("the unprobed tree passes", () => {
    expect(clean.output).toContain("0 violations");
    expect(clean.status).toBe(0);
  });

  test("the probed tree fails", () => {
    expect(probed.status).toBe(1);
  });

  test.each(probes)("$name", (probe) => {
    if (probe.violation === null) {
      const at = probe.line === undefined ? `${probe.file}:` : `${probe.file}:${probe.line}  `;
      expect([...reported].filter((line) => line.startsWith(at))).toEqual([]);
    } else {
      expect(reported).toContain(probe.violation);
    }
  });

  test("the checker reports nothing the probes did not plant", () => {
    const expected = new Set(probes.flatMap((probe) => (probe.violation === null ? [] : [probe.violation])));
    expect([...reported].filter((line) => !expected.has(line))).toEqual([]);
    expect(probed.output).toContain(`${expected.size} violations found`);
  });
});

// Compiled in memory as a file of knowledge's sources, so @ashara/db resolves exactly as it does for
// that context. Only the lines of the two relational reads may draw a diagnostic: one anywhere else
// (an import that no longer resolves) is a probe that no longer probes.
const RELATIONAL_PROBE_PACKAGE = path.join(REPO, "packages", "knowledge");
const RELATIONAL_PROBE_FILE = path.join(RELATIONAL_PROBE_PACKAGE, "src", "__relational_query_probe__.ts");
const RELATIONAL_PROBE_TEXT = [
  'import type { Database } from "@ashara/db";',
  "declare const db: Database;",
  "export async function probe(): Promise<void> {",
  "  await db.query.workItems.findMany();",
  "  await db.transaction(async (tx) => {",
  "    await tx.query.workItems.findMany();",
  "  });",
  "}",
  "",
].join("\n");
const RELATIONAL_READ_LINES = [4, 6];

function relationalProbeDiagnostics(): { line: number; message: string }[] {
  const read = ts.readConfigFile(path.join(RELATIONAL_PROBE_PACKAGE, "tsconfig.json"), (file) => ts.sys.readFile(file));
  if (read.error !== undefined) throw new ProbeTreeError("read knowledge tsconfig", ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const options = { ...ts.parseJsonConfigFileContent(read.config, ts.sys, RELATIONAL_PROBE_PACKAGE).options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const isProbe = (file: string): boolean => path.resolve(file) === RELATIONAL_PROBE_FILE;
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (file, language, onError, create) =>
    isProbe(file) ? ts.createSourceFile(file, RELATIONAL_PROBE_TEXT, language) : getSourceFile(file, language, onError, create);
  host.fileExists = (file) => isProbe(file) || fileExists(file);
  host.readFile = (file) => (isProbe(file) ? RELATIONAL_PROBE_TEXT : readFile(file));
  const program = ts.createProgram([RELATIONAL_PROBE_FILE], options, host);
  const source = program.getSourceFile(RELATIONAL_PROBE_FILE);
  if (source === undefined) throw new ProbeTreeError("relational probe", `${RELATIONAL_PROBE_FILE} is not in the program`);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map((diagnostic) => ({
    line: diagnostic.start === undefined ? 0 : source.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

describe("the shared Database handle against drizzle's relational query API", () => {
  test("a context reading another context's table through db.query or tx.query fails to compile", () => {
    const diagnostics = relationalProbeDiagnostics();
    expect(diagnostics.map((diagnostic) => diagnostic.line)).toEqual(RELATIONAL_READ_LINES);
    for (const diagnostic of diagnostics) expect(diagnostic.message).toContain("workItems");
  }, 120_000);
});
