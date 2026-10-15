import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { InvalidMasterKeyLength, SecretKeyFileCreateFailed, SecretKeyFileExists, SecretKeyFileInvalid } from "./errors.js";

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

  /** A fresh copy each call: no holder can mutate or zero the live key. The caller owns, and should zero, the copy. */
  bytes(): Buffer {
    return Buffer.from(this.#bytes);
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

/**
 * Creates a new key file: 32 random bytes, base64, one line, mode 0600, parent
 * directories 0700. Opening with "wx" makes the existence check and the creation
 * one atomic step, so an existing key (which may still encrypt stored secrets) is
 * never replaced and the file is never readable by anyone else, even briefly.
 */
export function createKeyFile(keyFilePath: string): { keyId: string } {
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(keyFilePath), { recursive: true, mode: 0o700 });
    fd = fs.openSync(keyFilePath, "wx", 0o600);
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === "EEXIST") {
      throw new SecretKeyFileExists(keyFilePath);
    }
    throw new SecretKeyFileCreateFailed(keyFilePath, "create", code, { cause: err });
  }
  const bytes = randomBytes(KEY_BYTES);
  try {
    // The umask can only narrow the mode; set it explicitly anyway so the result is exact.
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${bytes.toString("base64")}\n`);
    fs.fsyncSync(fd);
    return { keyId: keyIdOf(bytes) };
  } catch (err: unknown) {
    throw new SecretKeyFileCreateFailed(keyFilePath, "write", errnoCode(err), { cause: err });
  } finally {
    bytes.fill(0);
    fs.closeSync(fd);
  }
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
