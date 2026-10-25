import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { run as classImports } from "./class-imports.js";
import type { LintContext, PackageScan } from "./lint.js";
import { run as moduleNames } from "./module-names.js";
import { parseRules } from "./rules.js";

let scratch: string | null = null;

afterEach(() => {
  if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A scratch directory the test's tree is written under, removed after the test. */
function scratchRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-reads-"));
  scratch = root;
  return root;
}

/** A tree under `root` of the packages `files` names (each package-relative path to its text), on disk and read under `toml`'s rules. */
function tree(root: string, toml: string, files: Readonly<Record<string, Readonly<Record<string, string>>>>): LintContext {
  for (const [name, texts] of Object.entries(files)) {
    for (const [file, text] of Object.entries(texts)) {
      const target = path.join(root, "packages", name, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }
  const rules = parseRules(toml, "boundary-rules.toml");
  const packages = Object.entries(files).map(([name, texts]): PackageScan => {
    const rule = rules.get(name);
    if (rule === undefined) throw new Error(`the rules hold no section for ${name}`);
    const pkgRoot = path.join(root, "packages", name);
    return { name, rule, root: pkgRoot, contents: new Map(Object.entries(texts).map(([file, text]) => [path.join(pkgRoot, file), text])), relativeTo: (filePath) => path.relative(pkgRoot, filePath).split(path.sep).join("/") };
  });
  return { root, packagesDir: path.join(root, "packages"), rulesRelative: "boundary-rules.toml", toml, rules, packageDirs: Object.keys(files), packages };
}

describe("class-imports reads a package's classes from the checker", () => {
  const toml = '[quality]\nallow = []\n\n[delivery]\nallow = ["quality"]\nclasses.quality = ["Listed"]\n';
  const quality = {
    "src/jobs.ts": "class Hidden {}\nexport { Hidden };\nexport class Listed {}\nclass Inner {}\nexport { Inner as Renamed };\nexport const notAClass = 1;\n",
    "src/index.ts": 'export * from "./jobs.js";\nexport { Hidden as Aliased } from "./jobs.js";\n',
  };

  test("a class exported by an export list, under another name or re-exported under an alias, is a class the importer must list", () => {
    const use = 'import { Hidden, Listed, Renamed, Aliased, notAClass } from "@ashara/quality";\nexport const all = [Hidden, Listed, Renamed, Aliased, notAClass];\n';
    const found = classImports(tree(scratchRoot(), toml, { quality, delivery: { "src/use.ts": use } })).map((v) => `${v.file}:${String(v.line)} ${v.reason}`);
    expect(found).toEqual(["Hidden", "Renamed", "Aliased"].map((name) => `packages/delivery/src/use.ts:1 classes.quality: "${name}" is a class of "quality" it does not list; receive it as a port the composition root builds`));
  });

  test("a program run loads in a process of its own, so it reaches no class of the file, while a computed dynamic import still may", () => {
    const use = 'import { spawnSync } from "node:child_process";\nexport const run = spawnSync(process.execPath, ["./x.js"]);\nexport const load = (name: string): Promise<unknown> => import(name);\n';
    const found = classImports(tree(scratchRoot(), toml, { quality, delivery: { "src/use.ts": use } })).filter((v) => v.file.endsWith("use.ts")).map((v) => `${v.file}:${String(v.line)} ${v.specifier}`);
    expect(found).toEqual(["packages/delivery/src/use.ts:3 <computed specifier>"]);
  });

  test("a listed name the package exports as no class is reported", () => {
    const rules = '[quality]\nallow = []\n\n[delivery]\nallow = ["quality"]\nclasses.quality = ["notAClass"]\n';
    expect(classImports(tree(scratchRoot(), rules, { quality, delivery: { "src/use.ts": "export const none = 1;\n" } })).map((v) => v.reason)).toEqual(['"notAClass" is no class "quality" exports; remove it']);
  });
});

describe("module-names reads what an entry exports from the checker", () => {
  test("a held symbol the entry exports only through a re-export is found, and one it does not export is reported", () => {
    const root = scratchRoot();
    fs.mkdirSync(path.join(root, "packages", "db"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "db", "package.json"), JSON.stringify({ name: "@ashara/db", exports: { ".": "./src/index.ts" } }));
    const toml = '[db]\nallow = []\n\n[engagement]\nallow = ["db"]\nmodule.client-messages = ["src/messages.ts"]\nmodule-names.client-messages = ["db:clientMessages", "db:missing"]\n';
    const context = tree(root, toml, {
      db: { "src/index.ts": 'export * from "./tables.js";\n', "src/tables.ts": "const clientMessages = 1;\nexport { clientMessages };\n" },
      engagement: { "src/messages.ts": 'import { clientMessages } from "@ashara/db";\nexport const m = clientMessages;\n' },
    });
    expect(moduleNames(context).filter((v) => v.reason.includes("exports no")).map((v) => v.reason)).toEqual(['"@ashara/db" exports no "missing"; a rule that holds nothing passes everything']);
  });
});
