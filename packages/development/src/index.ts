export type { ProjectIntentSource, StackDeriver } from "./project-frame.js";

export { DevelopmentService } from "./execution-service.js";
export { assertValidTargetProjectPath } from "./workspace.js";
export type { KnowledgeSink, KnowledgeSource } from "./knowledge-writer.js";
export type {
  ContractSource,
  SessionStore,
  AgentInvoker,
  AgentSpawnOptions,
  ExecutionEventSink,
  TaskDescriptor,
} from "./execution-service.js";

export { ProvisioningError, TeardownError } from "./provisioner.js";
export type {
  EnvironmentSpec,
  ExecResult,
  ExecOptions,
  ProvisionedEnv,
  Provisioner,
} from "./provisioner.js";

export { deriveEnvironmentSpec } from "./env-spec-derivation.js";
