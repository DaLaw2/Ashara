import { describe, expect, test } from "vitest";
import { lockfileImpact, manifestImpact, parseLockfile, type Lockfile } from "./lockfile-impact.js";

// Two workspaces: a resolves hono (which nests its own copy of tiny), b resolves a through its link;
// the root project resolves only vitest.
function lockfile(extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Lockfile {
  const text = JSON.stringify({
    name: "probe",
    lockfileVersion: 3,
    ...top,
    packages: {
      "": { name: "probe", workspaces: ["packages/*"], devDependencies: { vitest: "4.0.0" } },
      "node_modules/vitest": { version: "4.0.0" },
      "node_modules/hono": { version: "4.0.0", dependencies: { tiny: "1.0.0" } },
      "node_modules/hono/node_modules/tiny": { version: "1.0.0" },
      "node_modules/tiny": { version: "2.0.0" },
      "node_modules/@p/a": { resolved: "packages/a", link: true },
      "node_modules/@p/b": { resolved: "packages/b", link: true },
      "packages/a": { name: "@p/a", dependencies: { hono: "4.0.0" } },
      "packages/b": { name: "@p/b", dependencies: { "@p/a": "*" } },
      ...extra,
    },
  });
  return parseLockfile(text, "probe lockfile");
}

describe("lockfileImpact", () => {
  test("a changed hoisted entry selects the workspaces that resolve it and names its package", () => {
    const impact = lockfileImpact(lockfile(), lockfile({ "node_modules/hono": { version: "4.1.0", dependencies: { tiny: "1.0.0" } } }));
    expect(impact).toMatchObject({ kind: "workspaces", workspaces: ["packages/a", "packages/b"], packageNames: ["hono"] });
  });

  test("a changed nested entry names the hoisted package it sits under, which a module importing that package loads", () => {
    const impact = lockfileImpact(lockfile(), lockfile({ "node_modules/hono/node_modules/tiny": { version: "1.0.1" } }));
    expect(impact).toMatchObject({ kind: "workspaces", workspaces: ["packages/a", "packages/b"], packageNames: ["hono"] });
  });

  test("an entry nested under a workspace's own node_modules names the outermost package it sits under", () => {
    const extra = { "packages/a": { name: "@p/a", dependencies: { hono: "4.0.0", left: "1.0.0" } }, "packages/a/node_modules/left": { version: "1.0.0", dependencies: { pad: "1.0.0" } } };
    const base = lockfile({ ...extra, "packages/a/node_modules/left/node_modules/pad": { version: "1.0.0" } });
    const head = lockfile({ ...extra, "packages/a/node_modules/left/node_modules/pad": { version: "1.0.1" } });
    expect(lockfileImpact(base, head)).toMatchObject({ kind: "workspaces", workspaces: ["packages/a", "packages/b"], packageNames: ["left"] });
  });

  test.each([
    ["a link entry with no resolved target", lockfile(), lockfile({ "node_modules/@p/a": { link: true } }), /node_modules\/@p\/a cannot be followed \(a link entry with no resolved target\)/],
    ["a required dependency with no lockfile entry", lockfile(), lockfile({ "packages/a": { name: "@p/a", dependencies: { hono: "4.0.0", ghost: "1.0.0" } } }), /packages\/a cannot be followed \(its dependency ghost resolves to no lockfile entry\)/],
    ["a field outside the packages map", lockfile(), lockfile({}, { lockfileVersion: 4 }), /a lockfile field outside its packages map changed/],
    ["an entry no workspace resolves", lockfile(), lockfile({ "node_modules/orphan": { version: "1.0.0" } }), /no workspace resolves node_modules\/orphan/],
    ["an entry the root project resolves", lockfile(), lockfile({ "node_modules/vitest": { version: "4.1.0" } }), /root project resolves node_modules\/vitest/],
    ["the root project's own entry", lockfile(), lockfile({ "": { name: "probe", workspaces: ["packages/*"], devDependencies: { vitest: "4.1.0" } } }), /root project's own entry changed/],
    ["no entry differing", lockfile(), lockfile(), /no locked entry does/],
  ])("%s cannot be attributed, so it is the whole suite", (_name, base, head, reason) => {
    const impact = lockfileImpact(base, head);
    expect(impact.kind).toBe("whole-suite");
    expect(impact.reason).toMatch(reason);
  });

  test("a lockfile absent in either revision is the whole suite", () => {
    expect(lockfileImpact(undefined, lockfile())).toMatchObject({ kind: "whole-suite", reason: expect.stringMatching(/absent at the base/) });
    expect(lockfileImpact(lockfile(), undefined)).toMatchObject({ kind: "whole-suite", reason: expect.stringMatching(/absent at the head/) });
  });

  test("a lockfile that is not of the npm shape throws", () => {
    expect(() => parseLockfile(JSON.stringify({ packages: { "node_modules/x": { version: 1 } } }), "probe")).toThrow();
  });
});

describe("manifestImpact", () => {
  test("a workspace manifest selects that workspace and every workspace that resolves it, and names its package", () => {
    expect(manifestImpact("packages/a", lockfile(), lockfile())).toMatchObject({ kind: "workspaces", workspaces: ["packages/a", "packages/b"], packageNames: ["@p/a"] });
  });

  test("a closure that cannot be followed is the whole suite", () => {
    const impact = manifestImpact("packages/a", lockfile(), lockfile({ "node_modules/@p/a": { link: true } }));
    expect(impact).toMatchObject({ kind: "whole-suite", reason: expect.stringMatching(/a link entry with no resolved target/) });
  });

  test("a manifest the lockfile records no workspace for is the whole suite", () => {
    expect(manifestImpact("packages/z", lockfile(), lockfile())).toMatchObject({ kind: "whole-suite", reason: expect.stringMatching(/no workspace at packages\/z/) });
  });
});
