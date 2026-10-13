import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { decryptSecret, encryptSecret } from "./cipher.js";
import { SecretDecryptionFailed, SecretKeyMismatch, SecretRecordCorrupt } from "./errors.js";
import { MasterKey } from "./master-key.js";

const key = new MasterKey(randomBytes(32));
const NAME = "provider/example/api_key";
const VALUE = "throwaway-value-é中";

function flipFirstByte(b: Buffer): Buffer {
  const copy = Buffer.from(b);
  copy[0] = (copy[0] ?? 0) ^ 0x01;
  return copy;
}

describe("AES-256-GCM secret cipher", () => {
  test("round-trips a value and never stores it in the clear", () => {
    const sealed = encryptSecret(key, NAME, VALUE);
    expect(sealed.keyId).toBe(key.id);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(sealed.ciphertext.includes(Buffer.from(VALUE, "utf-8"))).toBe(false);
    expect(decryptSecret(key, NAME, sealed)).toBe(VALUE);
  });

  test("uses a fresh IV per encryption", () => {
    expect(encryptSecret(key, NAME, VALUE).iv.equals(encryptSecret(key, NAME, VALUE).iv)).toBe(false);
  });

  test("a ciphertext copied to another name fails authentication (name is the AAD)", () => {
    const sealed = encryptSecret(key, NAME, VALUE);
    expect(() => decryptSecret(key, "provider/other/api_key", sealed)).toThrow(SecretDecryptionFailed);
  });

  test.each(["ciphertext", "authTag", "iv"] as const)("a tampered %s fails authentication", (field) => {
    const sealed = encryptSecret(key, NAME, VALUE);
    const tampered = { ...sealed, [field]: flipFirstByte(sealed[field]) };
    expect(() => decryptSecret(key, NAME, tampered)).toThrow(SecretDecryptionFailed);
  });

  test("a different key fails with a typed error naming the secret and both key ids", () => {
    const other = new MasterKey(randomBytes(32));
    const sealed = encryptSecret(key, NAME, VALUE);
    let caught: unknown;
    try {
      decryptSecret(other, NAME, sealed);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretKeyMismatch);
    expect(caught).toMatchObject({ secretName: NAME, storedKeyId: key.id, loadedKeyId: other.id });
  });

  test("a different key under a forged key id still fails rather than returning garbage", () => {
    const other = new MasterKey(randomBytes(32));
    const sealed = { ...encryptSecret(key, NAME, VALUE), keyId: other.id };
    expect(() => decryptSecret(other, NAME, sealed)).toThrow(SecretDecryptionFailed);
  });

  test("a structurally invalid record is rejected before decryption", () => {
    const sealed = encryptSecret(key, NAME, VALUE);
    expect(() => decryptSecret(key, NAME, { ...sealed, authTag: sealed.authTag.subarray(0, 8) })).toThrow(
      SecretRecordCorrupt,
    );
  });
});
