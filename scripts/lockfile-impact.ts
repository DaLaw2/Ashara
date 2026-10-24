/**
 * Which workspaces a dependency change reaches: the lockfile entries that differ between two
 * revisions of package-lock.json, attributed to every workspace whose resolved dependency closure
 * holds one of them in either revision. A closure follows each entry's dependencies by node's lookup
 * (the entry's own node_modules, then each enclosing one up to the root) and each workspace link to
 * the workspace it points at, so a workspace that depends on another resolves that one's
 * dependencies too.
 *
 * Fail-closed: a change this cannot attribute to a workspace (an entry the root project resolves, an
 * entry no workspace resolves, a root entry or lockfile field outside the packages map, a file that
 * differs with no entry differing, a lockfile absent in either revision) comes back as the whole
 * suite, and a lockfile that is not of the npm shape throws.
 */

import { z } from "zod";
import { parseJson } from "@ashara/shared";

class LockfileImpactError extends Error {
  constructor(
    readonly subject: string,
    readonly reason: string,
  ) {
    super(`lockfile-impact: ${subject}: ${reason}`);
    this.name = "LockfileImpactError";
  }
}

const DependencyMap = z.record(z.string(), z.string());

const LockEntry = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  link: z.boolean().optional(),
  optional: z.boolean().optional(),
  dependencies: DependencyMap.optional(),
  devDependencies: DependencyMap.optional(),
  optionalDependencies: DependencyMap.optional(),
  peerDependencies: DependencyMap.optional(),
});

const LockfileSchema = z.looseObject({ packages: z.record(z.string(), LockEntry) });

export type Lockfile = z.output<typeof LockfileSchema>;

export function parseLockfile(text: string, source: string): Lockfile {
  return parseJson(LockfileSchema, text, source);
}

/**
 * What a dependency change reaches: the whole suite with the reason it cannot be bounded, or the
 * workspaces (repo-relative directories) that resolve a changed entry and the package names of the
 * changed hoisted entries, which a module anywhere may import by name.
 */
export type DependencyImpact =
  | { readonly kind: "whole-suite"; readonly reason: string }
  | { readonly kind: "workspaces"; readonly workspaces: readonly string[]; readonly packageNames: readonly string[]; readonly reason: string };

const ROOT = "";
const NODE_MODULES_SEGMENT = /(^|\/)node_modules\//;
const HOISTED_KEY = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/;

function enclosingLocation(location: string): string | undefined {
  if (location === ROOT) return undefined;
  const nested = location.lastIndexOf("/node_modules/");
  return nested === -1 ? ROOT : location.slice(0, nested);
}

function resolveFrom(lock: Lockfile, from: string, name: string): string | undefined {
  for (let dir: string | undefined = from; dir !== undefined; dir = enclosingLocation(dir)) {
    const candidate = dir === ROOT ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (candidate in lock.packages) return candidate;
  }
  return undefined;
}

/** Every lockfile location `start` resolves, itself included. */
function closure(lock: Lockfile, start: string): Set<string> {
  const seen = new Set<string>();
  const pending = [start];
  for (let location = pending.pop(); location !== undefined; location = pending.pop()) {
    if (seen.has(location)) continue;
    seen.add(location);
    const entry = lock.packages[location];
    if (entry === undefined) continue;
    if (entry.link === true) {
      if (entry.resolved === undefined) throw new LockfileImpactError(location, "a link entry with no resolved target");
      pending.push(entry.resolved);
      continue;
    }
    const required = { ...entry.dependencies, ...entry.devDependencies };
    const elective = { ...entry.optionalDependencies, ...entry.peerDependencies };
    for (const name of Object.keys(required)) {
      const target = resolveFrom(lock, location, name);
      // An optional or peer dependency the install leaves out has no entry; a required one always has.
      if (target === undefined) throw new LockfileImpactError(location, `its dependency ${name} resolves to no lockfile entry`);
      pending.push(target);
    }
    for (const name of Object.keys(elective)) {
      const target = resolveFrom(lock, location, name);
      if (target !== undefined) pending.push(target);
    }
  }
  return seen;
}

function workspaceLocations(locks: readonly Lockfile[]): string[] {
  const found = new Set<string>();
  for (const lock of locks) {
    for (const key of Object.keys(lock.packages)) if (key !== ROOT && !NODE_MODULES_SEGMENT.test(key)) found.add(key);
  }
  return [...found].sort();
}

function reach(locks: readonly Lockfile[], start: string): Set<string> {
  const all = new Set<string>();
  for (const lock of locks) for (const location of closure(lock, start)) all.add(location);
  return all;
}

function workspaceName(locks: readonly Lockfile[], workspace: string): string[] {
  const names = new Set<string>();
  for (const lock of locks) {
    const name = lock.packages[workspace]?.name;
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

function differingKeys(base: Lockfile, head: Lockfile): string[] {
  const keys = new Set([...Object.keys(base.packages), ...Object.keys(head.packages)]);
  return [...keys].filter((key) => JSON.stringify(base.packages[key]) !== JSON.stringify(head.packages[key])).sort();
}

function outsidePackages(lock: Lockfile): string {
  const { packages: _packages, ...rest } = lock;
  return JSON.stringify(rest);
}

/**
 * The impact of a change to package-lock.json between `base` and `head`; `undefined` is a revision
 * without the file.
 */
export function lockfileImpact(base: Lockfile | undefined, head: Lockfile | undefined): DependencyImpact {
  if (base === undefined || head === undefined) {
    return { kind: "whole-suite", reason: `the lockfile is absent at the ${base === undefined ? "base" : "head"}, so no entry can be attributed` };
  }
  if (outsidePackages(base) !== outsidePackages(head)) return { kind: "whole-suite", reason: "a lockfile field outside its packages map changed" };
  const changed = differingKeys(base, head);
  if (changed.length === 0) return { kind: "whole-suite", reason: "the file differs and no locked entry does, so nothing bounds the change" };
  if (changed.includes(ROOT)) return { kind: "whole-suite", reason: "the root project's own entry changed" };
  const locks = [base, head];
  const rootReach = reach(locks, ROOT);
  const rootResolved = changed.filter((key) => rootReach.has(key));
  if (rootResolved.length > 0) {
    return { kind: "whole-suite", reason: `the root project resolves ${rootResolved.join(", ")}, and its dependencies are the toolchain every test runs under` };
  }
  const workspaces = new Set<string>();
  for (const workspace of workspaceLocations(locks)) {
    const resolved = reach(locks, workspace);
    if (changed.some((key) => resolved.has(key))) workspaces.add(workspace);
  }
  const unattributed = changed.filter((key) => ![...workspaces].some((workspace) => reach(locks, workspace).has(key)));
  if (unattributed.length > 0) return { kind: "whole-suite", reason: `no workspace resolves ${unattributed.join(", ")}` };
  const packageNames = new Set<string>();
  for (const key of changed) {
    const name = HOISTED_KEY.exec(key)?.[1];
    if (name !== undefined) packageNames.add(name);
  }
  return {
    kind: "workspaces",
    workspaces: [...workspaces].sort(),
    packageNames: [...packageNames].sort(),
    reason: `${changed.length} locked entr${changed.length === 1 ? "y" : "ies"} changed (${changed.join(", ")})`,
  };
}

/**
 * The impact of a change to the manifest of the workspace at `workspace` (a repo-relative directory):
 * that workspace and every workspace that resolves it, in either revision of the lockfile.
 */
export function manifestImpact(workspace: string, base: Lockfile | undefined, head: Lockfile | undefined): DependencyImpact {
  const locks = [base, head].filter((lock) => lock !== undefined);
  if (locks.length === 0) return { kind: "whole-suite", reason: "no revision has a lockfile to say which workspaces resolve it" };
  if (!workspaceLocations(locks).includes(workspace)) return { kind: "whole-suite", reason: `the lockfile records no workspace at ${workspace}` };
  const dependants = workspaceLocations(locks).filter((other) => reach(locks, other).has(workspace));
  return {
    kind: "workspaces",
    workspaces: dependants,
    packageNames: workspaceName(locks, workspace),
    reason: `the manifest of workspace ${workspace}, which ${dependants.length} workspace(s) resolve`,
  };
}
