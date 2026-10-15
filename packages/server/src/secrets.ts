import {
  API_TOKEN_SECRET_NAME,
  SecurityError,
  loadMasterKey,
  providerApiKeySecretName,
  resolveKeyFilePath,
} from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import type { ProviderCredential } from "@ashara/model-access";

/** The subset of SecretStore the server reads through; SecretStore satisfies it. */
export interface SecretReader {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string>;
}

/** The server refuses to boot. The message alone says what, where and how to fix. */
export class ServerStartupRefused extends Error {
  readonly what: string;
  readonly where: string;
  readonly howToFix: string;

  constructor(what: string, where: string, howToFix: string, options?: ErrorOptions) {
    super(`${what}\n  looked in: ${where}\n  how to fix: ${howToFix}`, options);
    this.name = "ServerStartupRefused";
    this.what = what;
    this.where = where;
    this.howToFix = howToFix;
  }
}

/** Fail closed: without the master key no credential can be read, so nothing starts. */
export function loadServerMasterKey(env: NodeJS.ProcessEnv): MasterKey {
  let keyFilePath = "$ASHARA_SECRET_KEY_FILE";
  try {
    keyFilePath = resolveKeyFilePath(env);
    return loadMasterKey(keyFilePath);
  } catch (err: unknown) {
    if (err instanceof SecurityError) {
      throw new ServerStartupRefused(
        `The secret store's master key could not be loaded, so no credential can be read: ${err.message}`,
        `${keyFilePath} (set ASHARA_SECRET_KEY_FILE to override)`,
        "Create the key with `npx tsx scripts/secret-key-init.ts`, or point ASHARA_SECRET_KEY_FILE " +
          "at the existing key file (mode 0600).",
        { cause: err },
      );
    }
    throw err;
  }
}

export async function loadApiToken(secrets: SecretReader): Promise<string> {
  if (!(await secrets.has(API_TOKEN_SECRET_NAME))) {
    throw new ServerStartupRefused(
      "The API token is not in the secret store; the server cannot authenticate any request.",
      `secret store, name "${API_TOKEN_SECRET_NAME}"`,
      `\`read -rs T && printf '%s' "$T" | npx tsx scripts/secret.ts put ${API_TOKEN_SECRET_NAME}\` ` +
        "(or `npx tsx scripts/secret.ts import-legacy` to move a pre-store token out of system_settings).",
    );
  }
  return secrets.get(API_TOKEN_SECRET_NAME);
}

/** One provider_configs row as the credential resolver reads it. */
interface ProviderRow {
  readonly name: string;
  readonly providerType: string;
  readonly baseUrl: string | null;
}

/**
 * A provider with no stored key gets no apiKey, logged at warn naming the secret; buildGatewayConfig
 * then leaves it out unless it is a local one with a base URL. Storing the key is how the owner
 * enables a provider (policy), so absence is not an error here.
 */
export async function resolveProviderCredentials(
  secrets: SecretReader,
  providers: readonly ProviderRow[],
): Promise<ProviderCredential[]> {
  const credentials: ProviderCredential[] = [];
  for (const provider of providers) {
    const secretName = providerApiKeySecretName(provider.name);
    const apiKey = (await secrets.has(secretName)) ? await secrets.get(secretName) : undefined;
    if (apiKey === undefined) {
      console.warn(`[Secrets] provider "${provider.name}" has no stored key at ${secretName}; it is enabled only if it needs none`);
    }
    credentials.push({ name: provider.name, providerType: provider.providerType, apiKey, baseUrl: provider.baseUrl });
  }
  return credentials;
}
