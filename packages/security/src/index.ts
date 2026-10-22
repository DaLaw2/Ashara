export { SecretStore } from "./secret-store.js";
export { bearerAuth } from "./bearer-auth.js";
export { createClientSessionRoutes } from "./client-session.js";
/** @testseam the integration web-client.test.ts reads and sends the session cookie by name; the client login sets it */
export { CLIENT_SESSION_COOKIE } from "./client-session.js";
export type { ClientLoginDeps, ClientSessionEnv } from "./client-session.js";
export { SecretRepository } from "./secret-repository.js";
export { MasterKey } from "./master-key.js";
export { createKeyFile, loadMasterKey, resolveKeyFilePath } from "./master-key.js";
export {
  API_TOKEN_SECRET_NAME,
  MIN_CLIENT_ACCESS_CODE_LENGTH,
  clientAccessCodeSecretName,
  isClientAccessCodeSecretName,
  providerApiKeySecretName,
} from "./secret-name.js";
export { SecretNotFound, SecurityError } from "./errors.js";
/** @testseam the integration secret-store.test.ts asserts the refusal class; SecretStore.put throws it */
export { EmptySecretValue } from "./errors.js";
/** @testseam the integration secret-store.test.ts asserts the refusal class; SecretStore.put throws it */
export { InvalidSecretName } from "./errors.js";
/** @testseam the integration secret-store.test.ts asserts the refusal class; SecretStore.get throws it */
export { SecretKeyMismatch } from "./errors.js";
