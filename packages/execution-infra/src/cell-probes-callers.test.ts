import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@ashara/shared";

/*
 * Discipline D for the cell exit probes: every export of cell-probes.ts has a production caller,
 * a source file outside the probes' own file, its tests and the package barrel. An operator script
 * counts only when knip.json names it an entry point, so `just` can reach it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROBES_FILE = join("packages", "execution-infra", "src", "cell-probes.ts");
const BARREL_FILE = join("packages", "execution-infra", "src", "index.ts");
const EXPORT = /^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;

const knipSchema = z.object({ workspaces: z.object({ ".": z.object({ entry: z.array(z.string()).nonempty() }) }) });

async function sourceFiles(): Promise<string[]> {
  const packages = await readdir(join(REPO_ROOT, "packages"), { withFileTypes: true });
  const files: string[] = [];
  for (const pkg of packages.filter((entry) => entry.isDirectory())) {
    const src = join("packages", pkg.name, "src");
    const entries = await readdir(join(REPO_ROOT, src), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative(REPO_ROOT, join(entry.parentPath, entry.name)));
    }
  }
  const knip = parseJson(knipSchema, await readFile(join(REPO_ROOT, "knip.json"), "utf8"), "knip.json");
  files.push(...knip.workspaces["."].entry.map((entry) => entry.split("/").join(sep)));
  return files.filter((file) => !file.endsWith(".test.ts") && file !== PROBES_FILE && file !== BARREL_FILE);
}

describe("cell exit probes", () => {
  it("every export of cell-probes.ts has a production caller outside its own file, its tests and the barrel", async () => {
    const exported = [...(await readFile(join(REPO_ROOT, PROBES_FILE), "utf8")).matchAll(EXPORT)].map((match) => match[1]);
    expect(exported.length, "cell-probes.ts exports nothing the guard can enumerate").toBeGreaterThan(0);
    const contents = await Promise.all((await sourceFiles()).map(async (file) => readFile(join(REPO_ROOT, file), "utf8")));
    const uncalled = exported.filter((name) => !contents.some((text) => new RegExp(`\\b${name}\\b`).test(text)));
    expect(uncalled, "exports with no production caller: wire each where its verdict gates work, or delete it").toEqual([]);
  });
});
