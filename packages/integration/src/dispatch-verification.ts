import { DispatchService } from "@ashara/delivery";
import {
  BaselineRevalidation,
  CellTeardown,
  CheckHarvest,
  CheckPorts,
  DeliveredOnMain,
  DispatchCells,
  FoundationGate,
  OwnershipGate,
  PostMergeChecks,
  SubstrateGate,
  SuiteReviewRun,
} from "@ashara/quality";
import type { SuiteReviewing } from "@ashara/quality";

type DispatchServiceDeps = ConstructorParameters<typeof DispatchService>[0];

/** A dispatcher's deps with the suite review in place of the verification jobs it is composed with. */
type ComposedDeps = Omit<DispatchServiceDeps, "verifiers"> & { readonly suiteReview: SuiteReviewing };

/**
 * A DispatchService with Quality's verification jobs built as the composition root builds them,
 * each from the dispatcher's own cells, policy, environment, checks, event sink and logger.
 * @testseam only test files compose a dispatcher apart from the server; production composes it in compose.ts
 */
export function composedDispatchService(deps: ComposedDeps): DispatchService {
  const { suiteReview, ...dispatch } = deps;
  const verified = { ...(deps.eventSink === undefined ? {} : { eventSink: deps.eventSink }), logger: deps.logger };
  const teardown = new CellTeardown(verified);
  const dispatchCells = new DispatchCells({
    config: deps.config,
    cells: deps.cells,
    attemptPolicy: deps.attemptPolicy,
    images: deps.environment.images,
    teardown,
  });
  return new DispatchService({
    ...dispatch,
    verifiers: {
      suiteReview: new SuiteReviewRun({ suiteReview, ...verified }),
      teardown,
      revalidation: new BaselineRevalidation({ dispatchCells, attemptPolicy: deps.attemptPolicy, ...verified }),
      delivered: new DeliveredOnMain({ dispatchCells, checks: deps.checks, ...verified }),
      foundationGate: new FoundationGate({ dispatchCells, attemptPolicy: deps.attemptPolicy, ...verified }),
      checkPorts: new CheckPorts({ dispatchCells, ...verified }),
      harvest: new CheckHarvest({ dispatchCells, checks: deps.checks, ...verified }),
      ownershipGate: new OwnershipGate({ checks: deps.checks, ...verified }),
      substrateGate: new SubstrateGate({ dispatchCells, attemptPolicy: deps.attemptPolicy, statements: deps.environment.statements, ...verified }),
      postMerge: new PostMergeChecks({ dispatchCells, attemptPolicy: deps.attemptPolicy, environment: deps.environment, checks: deps.checks, ...verified }),
    },
  });
}
