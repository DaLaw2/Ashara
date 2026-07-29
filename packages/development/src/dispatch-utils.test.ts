import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readManifestContext, buildAutoProfile, buildProjectContext } from "./dispatch-utils.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dispatch-utils-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readManifestContext
// ---------------------------------------------------------------------------

describe("readManifestContext", () => {
  test("includes manifests outside the former hardcoded nine (composer.json)", async () => {
    await writeFile(
      join(dir, "composer.json"),
      JSON.stringify({
        name: "vendor/my-php-app",
        require: { php: "^8.2", "laravel/framework": "^11.0" },
      }),
    );
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).toContain("composer.json");
    expect(result).toContain("vendor/my-php-app");
  });

  test("includes build.zig for a Zig project", async () => {
    await writeFile(join(dir, "build.zig"), 'const std = @import("std");');
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).toContain("build.zig");
    expect(result).toContain("std");
  });

  test("includes mix.exs for an Elixir project", async () => {
    await writeFile(
      join(dir, "mix.exs"),
      'defmodule MyApp.MixProject do\n  use Mix.Project\nend\n',
    );
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).toContain("mix.exs");
    expect(result).toContain("Mix.Project");
  });

  test("still reads the traditional nine markers", async () => {
    await writeFile(
      join(dir, "Cargo.toml"),
      '[package]\nname = "my-crate"\nversion = "0.1.0"\n',
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "my-node-app" }),
    );
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).toContain("Cargo.toml");
    expect(result).toContain("my-crate");
    expect(result).toContain("package.json");
    expect(result).toContain("my-node-app");
  });

  test("skips dotfiles", async () => {
    await writeFile(join(dir, ".env"), "SECRET=abc");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "app" }));
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).not.toContain(".env");
    expect(result).toContain("package.json");
  });

  test("skips directories", async () => {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "go.mod"), "module example.com/app\ngo 1.22\n");
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).not.toContain("--- src ---");
    expect(result).toContain("go.mod");
  });

  test("skips binary content (null bytes)", async () => {
    await writeFile(join(dir, "binary.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(join(dir, "readme.txt"), "Hello world");
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    expect(result).not.toContain("binary.dat");
    expect(result).toContain("readme.txt");
  });

  test("returns undefined for empty directory", async () => {
    const result = await readManifestContext(dir);
    expect(result).toBeUndefined();
  });

  test("returns undefined for nonexistent directory", async () => {
    const result = await readManifestContext(join(dir, "nonexistent"));
    expect(result).toBeUndefined();
  });

  test("truncates file content at MANIFEST_HEAD_CHARS (500)", async () => {
    const longContent = "x".repeat(1000);
    await writeFile(join(dir, "big.json"), longContent);
    const result = await readManifestContext(dir);
    expect(result).toBeDefined();
    // The section should contain at most 500 chars of content
    const match = result!.match(/--- big\.json ---\n([\s\S]*?)\n--- end ---/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// buildAutoProfile
// ---------------------------------------------------------------------------

describe("buildAutoProfile", () => {
  test("lists root files as techStack without a hardcoded table", async () => {
    await writeFile(join(dir, "composer.json"), "{}");
    await writeFile(join(dir, "README.md"), "# Hello");
    const profile = await buildAutoProfile(dir);
    expect(profile.techStack).toContain("composer.json");
    expect(profile.techStack).toContain("README.md");
  });

  test("skips dotfiles and directories", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "go.mod"), "module example.com/app");
    const profile = await buildAutoProfile(dir);
    expect(profile.techStack).toContain("go.mod");
    expect(profile.techStack).not.toContain(".gitignore");
    expect(profile.techStack).not.toContain("src");
  });

  test("returns empty techStack for empty directory", async () => {
    const profile = await buildAutoProfile(dir);
    expect(profile.techStack).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildProjectContext
// ---------------------------------------------------------------------------

describe("buildProjectContext", () => {
  test("does not render a # Tech Stack section", async () => {
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "x"');
    await writeFile(join(dir, "package.json"), "{}");
    const result = await buildProjectContext(dir);
    expect(result).not.toContain("# Tech Stack");
  });

  test("still renders project structure listing", async () => {
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "x"');
    const result = await buildProjectContext(dir);
    expect(result).toContain("# Project Structure");
    expect(result).toContain("Cargo.toml");
  });
});
