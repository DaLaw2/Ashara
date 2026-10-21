import type {
  BaselineRevalidation,
  CellTeardown,
  CheckHarvest,
  CheckPorts,
  DeliveredOnMain,
  FoundationGate,
  OwnershipGate,
  PostMergeChecks,
  SubstrateGate,
  SuiteReviewRun,
} from "@ashara/quality";

/**
 * Quality's verification of a dispatch, one port per job the dispatcher calls at its stage. The
 * composition root builds each job; the dispatcher decides nothing a verdict says.
 */
export interface DispatchVerification {
  /** A review task's dispatch: no agent, no cell. Required: no implementation is released without it. */
  readonly suiteReview: Pick<SuiteReviewRun, "reviewSuites">;
  readonly teardown: Pick<CellTeardown, "teardownCell">;
  readonly revalidation: Pick<BaselineRevalidation, "revalidateOnBaseline">;
  readonly delivered: Pick<DeliveredOnMain, "sweepDelivered" | "deliveredOnMain" | "checkedTaskOnMain">;
  readonly foundationGate: Pick<FoundationGate, "foundationBuildGate">;
  readonly checkPorts: Pick<CheckPorts, "environmentScope" | "checkDefinitionPort" | "taskCheckRunPort">;
  readonly harvest: Pick<CheckHarvest, "keepChecks">;
  readonly ownershipGate: Pick<OwnershipGate, "ownershipGate">;
  readonly substrateGate: Pick<SubstrateGate, "substrateGate">;
  readonly postMerge: Pick<PostMergeChecks, "postMergeEnvironmentTest" | "postMergeScaffold" | "postMergeStoredChecks">;
}
