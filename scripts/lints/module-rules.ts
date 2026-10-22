/**
 * The `module.*`, `module-allow.*` and `module-entry.*` rules of a package section (rules.ts states
 * their shapes): one line parsed into the section, and the section's module rules checked once it is
 * whole, fail closed on a rule naming no declared module, naming the entry where it cannot, or a cycle.
 */

import { BoundaryRulesParseError } from "./rules-parse-error.js";

/** The module that may import every other module and that none may import: the package's barrel. */
export const ENTRY_MODULE = "entry";

export const MODULE_RULE_RE = /^(module|module-allow|module-entry)\.([a-z][a-z0-9-]*)\s*=\s*\[([^\]]*)\]$/;

interface ModuleRuleTargets {
  readonly modules: Map<string, string[]>;
  readonly moduleAllow: Map<string, string[]>;
  readonly moduleAllowFiles: Map<string, Map<string, string[]>>;
  readonly moduleEntry: Map<string, string[]>;
}

interface RuleLine {
  readonly rulesPath: string;
  readonly lineNumber: number;
  readonly line: string;
}

/** One module rule line, already split by MODULE_RULE_RE, recorded into its section's module maps. */
export function parseModuleRule(key: string, name: string, list: readonly string[], rule: ModuleRuleTargets, at: RuleLine): void {
  const refuse = (reason: string): never => {
    throw new BoundaryRulesParseError(at.rulesPath, at.lineNumber, at.line, reason);
  };
  const target = key === "module" ? rule.modules : key === "module-allow" ? rule.moduleAllow : rule.moduleEntry;
  if (list.length === 0) refuse(`${key} list is empty${key === "module-allow" ? " (omit it: a module with none imports no other module)" : ""}`);
  if (target.has(name)) refuse(`${key}.${name} is stated twice`);
  if (key !== "module-allow") {
    target.set(name, [...list]);
    return;
  }
  const whole = new Set<string>();
  const narrowed = new Map<string, string[]>();
  for (const item of list) {
    const colon = item.indexOf(":");
    if (colon === -1) {
      if (whole.has(item) || narrowed.has(item)) refuse(`lists "${item}" twice, or both whole and by its files`);
      whole.add(item);
      continue;
    }
    const [imported, glob] = [item.slice(0, colon), item.slice(colon + 1)];
    if (whole.has(imported) || glob === "") refuse(`"${item}" names no file, or "${imported}" is also listed whole`);
    const globs = narrowed.get(imported);
    if (globs === undefined) narrowed.set(imported, [glob]);
    else globs.push(glob);
  }
  target.set(name, [...new Set(list.map((item) => item.split(":")[0]))]);
  rule.moduleAllowFiles.set(name, narrowed);
}

/** A module rule naming no declared module, naming the entry where it cannot, or a module-allow cycle. */
export function checkModuleRules(
  rulesPath: string,
  pkg: string,
  modules: ReadonlyMap<string, readonly string[]>,
  moduleAllow: ReadonlyMap<string, readonly string[]>,
  moduleEntry: ReadonlyMap<string, readonly string[]>,
): void {
  const refuse = (key: string, reason: string): never => {
    throw new BoundaryRulesParseError(rulesPath, 0, `[${pkg}] ${key}`, reason);
  };
  for (const [name, targets] of moduleAllow) {
    if (!modules.has(name)) refuse(`module-allow.${name}`, `"${name}" is no module of the section`);
    if (name === ENTRY_MODULE) refuse(`module-allow.${name}`, `the ${ENTRY_MODULE} module may import every module; it takes no module-allow`);
    for (const target of targets) {
      if (!modules.has(target)) refuse(`module-allow.${name}`, `lists "${target}", which is no module of the section`);
      if (target === ENTRY_MODULE) refuse(`module-allow.${name}`, `lists the ${ENTRY_MODULE} module, which no module may import`);
      if (target === name) refuse(`module-allow.${name}`, "lists the module itself");
    }
  }
  for (const name of moduleEntry.keys()) {
    if (!modules.has(name)) refuse(`module-entry.${name}`, `"${name}" is no module of the section`);
    if (name === ENTRY_MODULE) refuse(`module-entry.${name}`, `no module may import the ${ENTRY_MODULE} module, so it has no entry files`);
  }
  // Depth-first search over module-allow: a back edge is a cycle, which fails closed here so it cannot return.
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, trail: readonly string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") refuse("module-allow", `a cycle between modules: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}`);
    state.set(name, "open");
    // eslint-disable-next-line no-restricted-syntax -- policy default: a module with no module-allow imports no other module (rules.ts header)
    for (const target of moduleAllow.get(name) ?? []) visit(target, [...trail, name]);
    state.set(name, "done");
  };
  for (const name of moduleAllow.keys()) visit(name, []);
}
