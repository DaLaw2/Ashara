import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { InvalidMasterKeyLength, SecretKeyFileInvalid } from "./errors.js";

const KEY_BYTES = 32;
const KEY_FILE_ENV = "ASHARA_SECRET_KEY_FILE";

// 32 bytes encode to exactly 43 base64 characters plus one "=" pad.
const KeyFileContentSchema = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=\r?\n?$/);

/**
 * The AES-256 master key. The bytes sit in a private field and the instance
 * renders as its key id under `util.inspect` and JSON, so logging a
 * `MasterKey` never prints key material.
 */
export class MasterKey {
  readonly id: string;
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    if (bytes.length !== KEY_BYTES) {
      throw new InvalidMasterKeyLength(KEY_BYTES, bytes.length);
    }
    this.#bytes = Buffer.from(bytes);
    this.id = keyIdOf(this.#bytes);
  }

  bytes(): Buffer {
    return this.#bytes;
  }

  toJSON(): { id: string } {
    return { id: this.id };
  }

  [inspect.custom](): string {
    return `MasterKey(${this.id})`;
  }
}

/** Short public fingerprint of a key; reveals nothing usable about the key itself. */
function keyIdOf(bytes: Buffer): string {
  const digest = createHash("sha256").update("ashara-secret-key-id\0").update(bytes).digest("hex");
  return `k-${digest.slice(0, 16)}`;
}

/**
 * Policy default (Discipline A): an unset variable delegates the location to the
 * per-user config directory. A variable set to the empty string is a mistake,
 * not a delegation, and fails closed.
 */
export function resolveKeyFilePath(env: NodeJS.ProcessEnv): string {
  const configured = env[KEY_FILE_ENV];
  if (configured === undefined) {
    return path.join(os.homedir(), ".config", "ashara", "secret.key");
  }
  if (configured.trim() === "") {
    throw new SecretKeyFileInvalid(
      `$${KEY_FILE_ENV}`,
      "path-empty",
      `${KEY_FILE_ENV} is set but empty`,
      "Unset it to use ~/.config/ashara/secret.key, or set it to the key file path.",
    );
  }
  return path.resolve(configured);
}

/** New key file content: 32 random bytes, base64, one line. */
export function generateKeyFileContent(): { content: string; keyId: string } {
  const bytes = randomBytes(KEY_BYTES);
  return { content: `${bytes.toString("base64")}\n`, keyId: keyIdOf(bytes) };
}

const INIT_HINT = "Create one with `npx tsx scripts/secret-key-init.ts`.";

/**
 * The file is opened once and every check runs against that descriptor, so the
 * file that was checked is the file that is read: a path swapped between a
 * stat and a read cannot slip a different file past the permission check.
 * O_NONBLOCK keeps a FIFO at the path from hanging the open; it has no effect
 * on a regular file.
 */
export function loadMasterKey(keyFilePath: string): MasterKey {
  let fd: number;
  try {
    fd = fs.openSync(keyFilePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === "ENOENT") {
      throw new SecretKeyFileInvalid(keyFilePath, "missing", "no such file", INIT_HINT);
    }
    throw new SecretKeyFileInvalid(
      keyFilePath,
      "unreadable",
      `open failed (${code ?? "unknown error"})`,
      "Check that the path and its parent directories are accessible to this user.",
    );
  }
  try {
    return readKeyFromDescriptor(fd, keyFilePath);
  } finally {
    fs.closeSync(fd);
  }
}

function readKeyFromDescriptor(fd: number, keyFilePath: string): MasterKey {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    throw new SecretKeyFileInvalid(keyFilePath, "not-a-file", "path is not a regular file", INIT_HINT);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SecretKeyFileInvalid(
      keyFilePath,
      "permissions-too-broad",
      `mode is 0${mode.toString(8)}; group and other bits must be clear`,
      `Run \`chmod 600 ${keyFilePath}\`.`,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(fd, "utf-8");
  } catch (err: unknown) {
    throw new SecretKeyFileInvalid(
      keyFilePath,
      "unreadable",
      `read failed (${errnoCode(err) ?? "unknown error"})`,
      "Check that the file is owned by and readable for this user.",
    );
  }

  // The content is never echoed: a malformed key file may still hold key material.
  if (!KeyFileContentSchema.safeParse(raw).success) {
    throw new SecretKeyFileInvalid(
      keyFilePath,
      "malformed",
      `expected ${KEY_BYTES} bytes as base64 on one line (${raw.length} characters found)`,
      INIT_HINT,
    );
  }
  return new MasterKey(Buffer.from(raw.trim(), "base64"));
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}
