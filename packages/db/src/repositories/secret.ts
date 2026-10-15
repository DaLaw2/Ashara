import { asc, eq, sql } from "drizzle-orm";
import type { DbHandle } from "../connection.js";
import { secrets } from "../schema/index.js";

/** One encrypted secret as stored. Plaintext never reaches this layer. */
export interface EncryptedSecretRow {
  readonly name: string;
  readonly keyId: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export class SecretRepository {
  constructor(private readonly db: DbHandle) {}

  async upsert(row: EncryptedSecretRow): Promise<void> {
    await this.db
      .insert(secrets)
      .values(row)
      .onConflictDoUpdate({
        target: secrets.name,
        set: {
          keyId: row.keyId,
          iv: row.iv,
          ciphertext: row.ciphertext,
          authTag: row.authTag,
          updatedAt: sql`now()`,
        },
      });
  }

  async find(name: string): Promise<EncryptedSecretRow | null> {
    const rows = await this.db
      .select({
        name: secrets.name,
        keyId: secrets.keyId,
        iv: secrets.iv,
        ciphertext: secrets.ciphertext,
        authTag: secrets.authTag,
      })
      .from(secrets)
      .where(eq(secrets.name, name));
    return rows[0] ?? null;
  }

  async exists(name: string): Promise<boolean> {
    const rows = await this.db
      .select({ name: secrets.name })
      .from(secrets)
      .where(eq(secrets.name, name));
    return rows.length > 0;
  }

  /** Whether a row of that name existed and is now gone. */
  async delete(name: string): Promise<boolean> {
    const rows = await this.db.delete(secrets).where(eq(secrets.name, name)).returning({ name: secrets.name });
    return rows.length > 0;
  }

  async listNames(): Promise<string[]> {
    const rows = await this.db
      .select({ name: secrets.name })
      .from(secrets)
      .orderBy(asc(secrets.name));
    return rows.map((r) => r.name);
  }
}
