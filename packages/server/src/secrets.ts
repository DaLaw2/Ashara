import {
  API_TOKEN_SECRET_NAME,
  SecurityError,
  loadMasterKey,
  providerApiKeySecretName,
  resolveKeyFilePath,
} from "@ashara/security";
import type { MasterKey } from "@ashara/security";
import type { ProviderCredential } from "@ashara/llm-gateway";

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

/** A provider with no stored key gets no apiKey; buildGatewayConfig then leaves it out. */
export async function resolveProviderCredentials(
  secrets: SecretReader,
  providers: readonly { readonly name: string; readonly baseUrl: string | null }[],
): Promise<ProviderCredential[]> {
  const credentials: ProviderCredential[] = [];
  for (const provider of providers) {
    const secretName = providerApiKeySecretName(provider.name);
    const apiKey = (await secrets.has(secretName)) ? await secrets.get(secretName) : undefined;
    credentials.push({ name: provider.name, apiKey, baseUrl: provider.baseUrl });
  }
  return credentials;
}

// Story s-isolated-worker-m1 removes this env injection (the agent loop moves to Z0).
const PROVIDER_KEY_ENV_MAP: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * The host agent-runner subprocess reads provider keys from its own env via
 * loadProviderKeys() (packages/agent-runner/src/runner.ts → loadGatewayCatalogFromFile
 * → buildConfigFromCatalog); this builds those variables from the secret store.
 */
export async function buildProviderKeyEnv(
  secrets: SecretReader,
  providers: readonly { readonly name: string; readonly baseUrl: string | null }[],
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const credential of await resolveProviderCredentials(secrets, providers)) {
    const envName = PROVIDER_KEY_ENV_MAP[credential.name];
    if (envName !== undefined && credential.apiKey) {
      env[envName] = credential.apiKey;
    }
    if (credential.name === "local" && credential.baseUrl) {
      env["LOCAL_LLM_URL"] = credential.baseUrl;
    }
  }
  return env;
}
