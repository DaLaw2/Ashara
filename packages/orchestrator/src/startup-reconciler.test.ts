import { describe, expect, test } from "vitest";
import type { FailureRouter, WorkItemRepository } from "./acl/planning-acl.js";
import type { StartupReconcilerDeps } from "./startup-reconciler.js";
import { reconcileOnStartup } from "./startup-reconciler.js";

interface FailStaleCall {
  readonly reason: unknown;
}

/** No work items to reconcile — these tests are about the session pass only. */
function emptyWorkItemRepo(): WorkItemRepository {
  const unused = (method: string) => (): never => {
    throw new Error(`WorkItemRepository.${method} is not exercised by this test`);
  };
  return {
    create: unused("create"),
    findById: unused("findById"),
    findByStatus: async () => [],
    save: unused("save"),
    incrementDispatchCount: unused("incrementDispatchCount"),
    listAll: unused("listAll"),
    addDependency: unused("addDependency"),
    getDependencies: unused("getDependencies"),
    findChildren: unused("findChildren"),
    listAllDependencies: unused("listAllDependencies"),
    withTransaction: unused("withTransaction"),
  };
}

function buildDeps(overrides: Partial<StartupReconcilerDeps> = {}): {
  deps: StartupReconcilerDeps;
  failStaleCalls: FailStaleCall[];
} {
  const failStaleCalls: FailStaleCall[] = [];

  const deps: StartupReconcilerDeps = {
    workItemRepo: emptyWorkItemRepo(),
    eventStore: { publish: async () => undefined },
    // Provably never invoked: findByStatus("Failed") returns [], so no item is
    // routed. FailureRouter has private members, so a structural double cannot
    // satisfy it; the throwing stub is what makes the "never invoked" claim
    // testable rather than assumed.
    failureRouter: {
      route: () => {
        throw new Error("FailureRouter.route is not exercised by this test");
      },
    } as unknown as FailureRouter,
    devSessionStore: {
      failStale: async (reason: unknown) => {
        failStaleCalls.push({ reason });
        return 6;
      },
    },
    // Required: an empty repo returns no dirs, so the sweep is a no-op.
    workdirBase: "/nonexistent-test-workdir",
    ...overrides,
  };

  return { deps, failStaleCalls };
}

// E2E Run 39 left 6 dev_sessions rows in "Preparing" for two abandoned tasks.
// Nothing in the process that created them survived to close them, so the only
// place the invariant can be restored is the next process start.
describe("reconcileOnStartup — dev_session crash orphans", () => {
  test("terminalizes every non-terminal session and reports the count", async () => {
    const { deps, failStaleCalls } = buildDeps();

    const summary = await reconcileOnStartup(deps);

    expect(failStaleCalls).toHaveLength(1);
    expect(summary.sessionsTerminalized).toBe(6);
  });

  test("the recorded reason says why the session was closed, not just that it was", async () => {
    const { deps, failStaleCalls } = buildDeps();

    await reconcileOnStartup(deps);

    expect(failStaleCalls[0]?.reason).toMatchObject({
      passed: false,
      resolvedBy: "startup-reconciler",
    });
  });

  // Fail-soft on its own error: the rows are already stranded, so retrying next
  // start beats refusing to boot.
  test("a store failure does not block startup reconciliation", async () => {
    const { deps } = buildDeps({
      devSessionStore: {
        failStale: async () => {
          throw new Error("db unreachable");
        },
      },
    });

    const summary = await reconcileOnStartup(deps);

    expect(summary.sessionsTerminalized).toBe(0);
  });
});
