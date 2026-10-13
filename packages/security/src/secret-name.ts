import { z } from "zod";
import { InvalidSecretName } from "./errors.js";

const SecretNameSchema = z
  .string()
  .max(200, "longer than 200 characters")
  .regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/, "must be lowercase [a-z0-9_-] segments separated by '/'");

export function parseSecretName(name: string): string {
  const result = SecretNameSchema.safeParse(name);
  if (!result.success) {
    throw new InvalidSecretName(name, result.error.issues.map((i) => i.message));
  }
  return result.data;
}

/** The server's bearer token for its HTTP API (ADR-075 C4). */
export const API_TOKEN_SECRET_NAME = "server/api_token";

/** The code one client presents to the web client's login (ADR-076, migration 018). */
export function clientAccessCodeSecretName(clientId: string): string {
  return parseSecretName(`client/${clientId}/access_code`);
}

/**
 * Below this length the login's failure delay and throttle are no defence: the
 * code itself must carry the entropy. The operator tool refuses to store a
 * shorter code and the login refuses to run against one.
 */
export const MIN_CLIENT_ACCESS_CODE_LENGTH = 20;

/** Where a provider's API key lives in the store (ADR-075 C2). */
export function providerApiKeySecretName(provider: string): string {
  return parseSecretName(`provider/${provider}/api_key`);
}
