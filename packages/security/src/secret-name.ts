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

/** Where a provider's API key lives in the store (ADR-075 C2). */
export function providerApiKeySecretName(provider: string): string {
  return parseSecretName(`provider/${provider}/api_key`);
}
