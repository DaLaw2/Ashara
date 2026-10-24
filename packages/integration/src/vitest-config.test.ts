import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createVitest } from "vitest/node";
import { PODMAN_TEST_FILES } from "./podman-test-load.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const CONFIG = "vitest.config.mts";

interface Listing {
  readonly code: number | null;
  readonly output: string;
}

// A child vitest that inherits this run's VITEST* variables would take itself for a worker of it.
function listFiles(file: string): Promise<Listing> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("VITEST") && key !== "NODE_OPTIONS") env[key] = value;
  return new Promise((resolve) => {
    execFile(process.execPath, [VITEST, "list", "--filesOnly", file], { cwd: ROOT, env, timeout: 100_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
      resolve({ code, output: `${stdout}\n${stderr}` });
    });
  });
}

describe("the vitest config", () => {
  test("is the one ES module config at the root, with no CommonJS-loaded copy beside it", () => {
    expect(fs.existsSync(path.join(ROOT, CONFIG))).toBe(true);
    const others = fs.readdirSync(ROOT).filter((name) => /^vitest\.config\./.test(name) && name !== CONFIG);
    expect(others).toEqual([]);
  });

  test("resolves the include lists both projects run", async () => {
    const vitest = await createVitest("test", { root: ROOT, watch: false, run: true, reporters: [] });
    try {
      const includes = Object.fromEntries(vitest.projects.map((project) => [project.name, project.config.include]));
      expect(includes).toEqual({ default: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"], podman: [...PODMAN_TEST_FILES] });
    } finally {
      await vitest.close();
    }
  }, 60_000);

  test("loads without a config-loader warning", async () => {
    const listing = await listFiles("packages/integration/src/vitest-config.test.ts");
    expect(listing.code, listing.output).toBe(0);
    expect(listing.output).toContain("packages/integration/src/vitest-config.test.ts");
    expect(listing.output).not.toMatch(/configLoader|loaded as CommonJS|VITE_CONFIG_NATIVE_IGNORE_WARNING/);
  }, 120_000);
});
