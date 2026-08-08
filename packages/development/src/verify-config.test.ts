import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readVerifyConfig, VerifyConfigParseError, isVacuousCommand } from "./verify-config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "verify-config-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readVerifyConfig", () => {
  test("absent file returns empty checks without throwing", async () => {
    const config = await readVerifyConfig(dir);
    expect(config.checks).toEqual([]);
  });

  test("parses double-quoted values", async () => {
    await writeFile(
      join(dir, "verify.toml"),
      '[checks]\nbuild = "npm run build"\ntest = "npm test"\n',
    );
    const config = await readVerifyConfig(dir);
    expect(config.checks).toEqual([
      { name: "build", command: "npm run build" },
      { name: "test", command: "npm test" },
    ]);
  });

  test("parses single-quoted values (the bug the regex dropped)", async () => {
    await writeFile(
      join(dir, "verify.toml"),
      "[checks]\nbuild = 'cargo build'\ntest = 'cargo test'\n",
    );
    const config = await readVerifyConfig(dir);
    expect(config.checks).toEqual([
      { name: "build", command: "cargo build" },
      { name: "test", command: "cargo test" },
    ]);
  });

  test("malformed TOML throws VerifyConfigParseError", async () => {
    await writeFile(join(dir, "verify.toml"), "[checks\nbuild = broken\n");
    await expect(readVerifyConfig(dir)).rejects.toThrow(VerifyConfigParseError);
  });

  test("non-string check value throws with the key name", async () => {
    await writeFile(join(dir, "verify.toml"), "[checks]\nbuild = 42\n");
    await expect(readVerifyConfig(dir)).rejects.toThrow(
      /key "build".*expected a string command/,
    );
  });

  test("file with no [checks] section returns empty checks", async () => {
    await writeFile(join(dir, "verify.toml"), "[metadata]\nversion = 1\n");
    const config = await readVerifyConfig(dir);
    expect(config.checks).toEqual([]);
  });
});

describe("isVacuousCommand", () => {
  test.each([
    ["echo 'no build'", true],
    ["echo", true],
    ["printf 'hi'", true],
    ["true", true],
    [":", true],
    ["exit 0", true],
    ["", true],
    ["   ", true],
    ["make", false],
    ["gcc -o main main.c", false],
    ["npm test", false],
    ["echo 'building' && make", false],  // has &&, conservatively non-vacuous
    ["cargo test 2>&1 | grep ok", false],
  ])("%s → %s", (cmd, expected) => {
    expect(isVacuousCommand(cmd)).toBe(expected);
  });
});
