import type { SecretRepository } from "@ashara/db";
import { decryptSecret, encryptSecret } from "./cipher.js";
import { EmptySecretValue, SecretNotFound } from "./errors.js";
import type { MasterKey } from "./master-key.js";
import { parseSecretName } from "./secret-name.js";

/**
 * Secret values in, ciphertext to Postgres; the master key never leaves the process.
 * The store is the only gate to the `secrets` table: construct it over a repository
 * bound to a transaction to make its writes part of that transaction.
 */
export class SecretStore {
  constructor(
    private readonly repository: SecretRepository,
    private readonly key: MasterKey,
  ) {}

  async put(name: string, value: string): Promise<void> {
    const validName = parseSecretName(name);
    if (value.length === 0) {
      throw new EmptySecretValue(validName);
    }
    await this.repository.upsert({ name: validName, ...encryptSecret(this.key, validName, value) });
  }

  async get(name: string): Promise<string> {
    const validName = parseSecretName(name);
    const row = await this.repository.find(validName);
    if (row === null) {
      throw new SecretNotFound(validName);
    }
    return decryptSecret(this.key, validName, row);
  }

  async has(name: string): Promise<boolean> {
    return this.repository.exists(parseSecretName(name));
  }

  /** Whether a secret of that name existed and is now gone. */
  async delete(name: string): Promise<boolean> {
    return this.repository.delete(parseSecretName(name));
  }

  async listNames(): Promise<string[]> {
    return this.repository.listNames();
  }
}
