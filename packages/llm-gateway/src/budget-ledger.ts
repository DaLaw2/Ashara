// ---------------------------------------------------------------------------
// In-memory, single-process budget gate (replaces the file-based CostTracker).
//
// The server is single-process (ADR-022) and the gateway runs in-process, so
// there is exactly one writer and one reader of spend state: no concurrent
// writers to clobber, no shard files, no archive-at-launch protocol. State
// resets to $0 on server restart, which aligns with the per-run semantic the
// old archive-at-launch step used to simulate manually. The durable,
// cross-restart record of spend is `task_cost_history` in Postgres
// (CostRepository), read by the orchestrator's BudgetTracker — this ledger is
// only the real-time per-call gate.
// ---------------------------------------------------------------------------

export class BudgetLedger {
  private spent = 0;
  private readonly perProvider = new Map<string, number>();

  record(cost: number, provider: string): void {
    this.spent += cost;
    this.perProvider.set(provider, (this.perProvider.get(provider) ?? 0) + cost);
  }

  totalSpent(): number {
    return this.spent;
  }

  providerSpent(provider: string): number {
    return this.perProvider.get(provider) ?? 0;
  }

  isOverBudget(limit: number): boolean {
    return this.spent >= limit;
  }

  isProviderOverBudget(provider: string, limit: number): boolean {
    return this.providerSpent(provider) >= limit;
  }

  /** Snapshot of every provider's spend, for `LLMGateway.getCostSummary()`. */
  providerBreakdown(): Record<string, number> {
    return Object.fromEntries(this.perProvider);
  }
}
