import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readHidden, readMapping } from "./run-report-inputs.js";

const COMMAND = "some-command";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "run-report-inputs-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("the read did not throw");
}

const MAPPING = ["version = 1", 'run = "r1"', `packet = "sha256:${"b".repeat(64)}"`, "", "[[map]]", 'intended = "I1"', 'to = ["item-1"]', "narrowed = false", ""].join("\n");

describe("readHidden and readMapping name the calling command first in every error", () => {
  test("an unreadable hidden verdict file", async () => {
    expect(await messageOf(readHidden(path.join(dir, "absent.json"), COMMAND))).toMatch(/^some-command: the hidden verdict file /);
  });

  test("an unreadable mapping file", async () => {
    expect(await messageOf(readMapping(path.join(dir, "absent.toml"), path.join(dir, "key.json"), COMMAND))).toMatch(/^some-command: the mapping file /);
  });

  test("a mapping file that is not a mapping", async () => {
    await writeFile(path.join(dir, "mapping.toml"), "not = [toml");

    expect(await messageOf(readMapping(path.join(dir, "mapping.toml"), path.join(dir, "key.json"), COMMAND))).toMatch(/^some-command: the mapping file .* is not a valid mapping file/);
  });

  test("an unreadable packet key", async () => {
    await writeFile(path.join(dir, "mapping.toml"), MAPPING);

    expect(await messageOf(readMapping(path.join(dir, "mapping.toml"), path.join(dir, "absent.json"), COMMAND))).toMatch(/^some-command: the packet key /);
  });
});
