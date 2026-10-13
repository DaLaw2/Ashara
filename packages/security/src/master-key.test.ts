import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SecretKeyFileInvalid } from "./errors.js";
import { generateKeyFileContent, loadMasterKey, resolveKeyFilePath } from "./master-key.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashara-secret-key-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeKeyFile(content: string, mode: number): string {
  const file = path.join(dir, "secret.key");
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function problemOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err: unknown) {
    return err instanceof SecretKeyFileInvalid ? err.problem : `untyped: ${String(err)}`;
  }
  return undefined;
}

describe("master key file", () => {
  test("loads a generated key file and never renders the key material", () => {
    const { content, keyId } = generateKeyFileContent();
    const key = loadMasterKey(writeKeyFile(content, 0o600));
    expect(key.id).toBe(keyId);
    expect(key.bytes()).toHaveLength(32);
    const material = content.trim();
    expect(inspect(key)).not.toContain(material);
    expect(JSON.stringify(key)).not.toContain(material);
  });

  test("rejects a missing file", () => {
    expect(problemOf(() => loadMasterKey(path.join(dir, "absent.key")))).toBe("missing");
  });

  test("rejects wrong length without echoing the content", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    const file = writeKeyFile(`${short}\n`, 0o600);
    expect(problemOf(() => loadMasterKey(file))).toBe("malformed");
    expect(() => loadMasterKey(file)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(short) }));
  });

  test("rejects permissions broader than 0600", () => {
    const file = writeKeyFile(generateKeyFileContent().content, 0o644);
    expect(problemOf(() => loadMasterKey(file))).toBe("permissions-too-broad");
  });

  test("resolves the path from the environment, with a policy default and an empty value refused", () => {
    expect(resolveKeyFilePath({ ASHARA_SECRET_KEY_FILE: "/etc/ashara/k" })).toBe("/etc/ashara/k");
    expect(resolveKeyFilePath({})).toBe(path.join(os.homedir(), ".config", "ashara", "secret.key"));
    expect(problemOf(() => resolveKeyFilePath({ ASHARA_SECRET_KEY_FILE: "" }))).toBe("path-empty");
  });
});
