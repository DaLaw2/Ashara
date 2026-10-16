/**
 * Every error here names what failed, where, and how to fix it — and none of
 * them ever carries key material or a secret value (only names, paths and key ids).
 */
export class SecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecurityError";
  }
}

type SecretKeyFileProblem =
  | "path-empty"
  | "missing"
  | "not-a-file"
  | "unreadable"
  | "permissions-too-broad"
  | "malformed";

/** The master key file could not be loaded. The store refuses to run without it. */
export class SecretKeyFileInvalid extends SecurityError {
  readonly path: string;
  readonly problem: SecretKeyFileProblem;
  readonly detail: string;
  readonly howToFix: string;

  constructor(path: string, problem: SecretKeyFileProblem, detail: string, howToFix: string) {
    super(`Secret key file "${path}" is unusable (${problem}): ${detail}. ${howToFix}`);
    this.name = "SecretKeyFileInvalid";
    this.path = path;
    this.problem = problem;
    this.detail = detail;
    this.howToFix = howToFix;
  }
}

/** Key generation refuses to replace a key: the old key may still encrypt stored secrets. */
export class SecretKeyFileExists extends SecurityError {
  readonly path: string;

  constructor(path: string) {
    super(
      `Secret key file "${path}" already exists; refusing to overwrite it. Secrets encrypted ` +
        `under that key would become undecryptable. Move it aside deliberately if replacing it ` +
        `is really intended, or point ASHARA_SECRET_KEY_FILE at a different path.`,
    );
    this.name = "SecretKeyFileExists";
    this.path = path;
  }
}

/** A new key file could not be created or written. Carries the path and errno code only. */
export class SecretKeyFileCreateFailed extends SecurityError {
  readonly path: string;
  readonly step: "create" | "write";
  readonly code: string | undefined;

  constructor(path: string, step: "create" | "write", code: string | undefined, options?: ErrorOptions) {
    super(
      `Could not ${step} secret key file "${path}" (${code ?? "unknown error"}). Check that its parent ` +
        `directory is writable by this user.` +
        (step === "write" ? " A partially written file is left in place; inspect and remove it before retrying." : ""),
      options,
    );
    this.name = "SecretKeyFileCreateFailed";
    this.path = path;
    this.step = step;
    this.code = code;
  }
}

/** Key material of the wrong length reached the MasterKey constructor. Carries lengths only. */
export class InvalidMasterKeyLength extends SecurityError {
  readonly expectedBytes: number;
  readonly actualBytes: number;

  constructor(expectedBytes: number, actualBytes: number) {
    super(
      `A master key must be ${expectedBytes} bytes, got ${actualBytes}. Load the key with ` +
        `loadMasterKey() from a file written by \`npx tsx scripts/secret-key-init.ts\`.`,
    );
    this.name = "InvalidMasterKeyLength";
    this.expectedBytes = expectedBytes;
    this.actualBytes = actualBytes;
  }
}

export class InvalidSecretName extends SecurityError {
  readonly secretName: string;
  readonly issues: readonly string[];

  constructor(secretName: string, issues: readonly string[]) {
    super(
      `Invalid secret name "${secretName}": ${issues.join("; ")}. A name is lowercase ` +
        `segments of [a-z0-9_-] separated by "/", e.g. "provider/deepseek/api_key".`,
    );
    this.name = "InvalidSecretName";
    this.secretName = secretName;
    this.issues = issues;
  }
}

export class EmptySecretValue extends SecurityError {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`Refusing to store an empty value for secret "${secretName}".`);
    this.name = "EmptySecretValue";
    this.secretName = secretName;
  }
}

export class SecretNotFound extends SecurityError {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`Secret "${secretName}" is not in the secret store.`);
    this.name = "SecretNotFound";
    this.secretName = secretName;
  }
}

/** The stored row was encrypted under a different master key than the one loaded. */
export class SecretKeyMismatch extends SecurityError {
  readonly secretName: string;
  readonly storedKeyId: string;
  readonly loadedKeyId: string;

  constructor(secretName: string, storedKeyId: string, loadedKeyId: string) {
    super(
      `Secret "${secretName}" was encrypted under key "${storedKeyId}", but the loaded key is ` +
        `"${loadedKeyId}". Point ASHARA_SECRET_KEY_FILE at the key file whose id is ` +
        `"${storedKeyId}", or re-store the secret under the current key.`,
    );
    this.name = "SecretKeyMismatch";
    this.secretName = secretName;
    this.storedKeyId = storedKeyId;
    this.loadedKeyId = loadedKeyId;
  }
}

/**
 * GCM authentication failed under the right key id: the ciphertext or tag was
 * altered, or the row was copied from another secret name (the name is the AAD).
 */
export class SecretDecryptionFailed extends SecurityError {
  readonly secretName: string;
  readonly keyId: string;

  constructor(secretName: string, keyId: string, options?: ErrorOptions) {
    super(
      `Secret "${secretName}" failed authentication under key "${keyId}": the stored ` +
        `ciphertext or auth tag was altered, or the row was copied from another secret name. ` +
        `The value cannot be trusted; re-store the secret.`,
      options,
    );
    this.name = "SecretDecryptionFailed";
    this.secretName = secretName;
    this.keyId = keyId;
  }
}

/** A stored row is structurally invalid (wrong IV or tag length, empty ciphertext). */
export class SecretRecordCorrupt extends SecurityError {
  readonly secretName: string;
  readonly issues: readonly string[];

  constructor(secretName: string, issues: readonly string[]) {
    super(`Stored record for secret "${secretName}" is corrupt: ${issues.join("; ")}. Re-store the secret.`);
    this.name = "SecretRecordCorrupt";
    this.secretName = secretName;
    this.issues = issues;
  }
}
