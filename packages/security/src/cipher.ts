import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { SecretDecryptionFailed, SecretKeyMismatch, SecretRecordCorrupt } from "./errors.js";
import type { MasterKey } from "./master-key.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface EncryptedSecret {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

// Rows come back out of Postgres: re-validate their shape before handing them to GCM.
const bufferOfLength = (length: number) =>
  z.instanceof(Buffer).refine((b) => b.length === length, `must be ${length} bytes`);
const EncryptedSecretSchema = z.object({
  keyId: z.string().min(1),
  iv: bufferOfLength(IV_BYTES),
  ciphertext: z.instanceof(Buffer).refine((b) => b.length > 0, "must not be empty"),
  authTag: bufferOfLength(TAG_BYTES),
});

/** createCipheriv/createDecipheriv copy the key into their own context, so the copy is zeroed at once. */
function withKeyBytes<T>(key: MasterKey, use: (bytes: Buffer) => T): T {
  const bytes = key.bytes();
  try {
    return use(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** The secret name is the AAD, so a ciphertext moved to another name fails authentication. */
export function encryptSecret(key: MasterKey, name: string, value: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = withKeyBytes(key, (bytes) => createCipheriv(ALGORITHM, bytes, iv, { authTagLength: TAG_BYTES }));
  cipher.setAAD(Buffer.from(name, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return { keyId: key.id, iv, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptSecret(key: MasterKey, name: string, stored: EncryptedSecret): string {
  const parsed = EncryptedSecretSchema.safeParse(stored);
  if (!parsed.success) {
    throw new SecretRecordCorrupt(
      name,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const record = parsed.data;
  if (record.keyId !== key.id) {
    throw new SecretKeyMismatch(name, record.keyId, key.id);
  }
  const decipher = withKeyBytes(key, (bytes) =>
    createDecipheriv(ALGORITHM, bytes, record.iv, { authTagLength: TAG_BYTES }),
  );
  decipher.setAAD(Buffer.from(name, "utf-8"));
  decipher.setAuthTag(record.authTag);
  try {
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf-8");
  } catch (err: unknown) {
    throw new SecretDecryptionFailed(name, record.keyId, { cause: err });
  }
}
