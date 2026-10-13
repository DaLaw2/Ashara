import type { CostRepository, CapabilityCostEstimate } from "@ashara/db";

// The port load() actually depends on — two queries, no private db handle.
// Satisfied by a real CostRepository (class instances match interfaces even
// when the class has private members) and by plain test stubs alike.
export interface CostDataSource {
  loadModelPricing: CostRepository["loadModelPricing"];
  loadCostHistory: CostRepository["loadCostHistory"];
}

export class CostEstimator {
  private modelPricing: Record<string, { inputPer1m: number; outputPer1m: number }> = {};
  private history: Record<string, CapabilityCostEstimate> = {};
  private pricingLoaded = false;
  private historyLoaded = false;
  private loadAttempts = 0;

  // Both data sources must succeed before this returns true.
  // Pricing-loaded-but-history-failed is not "loaded": the caller
  // (BudgetTracker.ensureLoaded) uses this to gate a retry, and this
  // flag answers an evidence question ("did we get the data?"), not a
  // policy question.  Evidence defaults fail closed.
  isLoaded(): boolean {
    return this.pricingLoaded && this.historyLoaded;
  }

  async load(costRepo: CostDataSource): Promise<void> {
    this.loadAttempts += 1;
    const attempt = this.loadAttempts;

    if (!this.pricingLoaded) {
      try {
        this.modelPricing = await costRepo.loadModelPricing();
        this.pricingLoaded = true;
      } catch (e) {
        console.warn(
          `Failed to load model pricing (attempt ${attempt}), ` +
          "using cold-start estimates:", e,
        );
      }
    }

    if (!this.historyLoaded) {
      try {
        const dbHistory = await costRepo.loadCostHistory();
        for (const [cap, estimate] of Object.entries(dbHistory)) {
          if (estimate.sampleCount > 0) {
            this.history[cap] = estimate;
          }
        }
        this.historyLoaded = true;
      } catch (e) {
        console.warn(
          `Failed to load cost history (attempt ${attempt}), ` +
          "using cold-start defaults:", e,
        );
      }
    }

    console.log(
      `Cost estimator load (attempt ${attempt}): ` +
      `pricing=${this.pricingLoaded ? "ok" : "failed"}, ` +
      `history=${this.historyLoaded ? "ok" : "failed"}, ` +
      `${Object.keys(this.modelPricing).length} pricing capabilities, ` +
      `${Object.keys(this.history).length} history capabilities`,
    );
  }

  estimateTaskCost(capability: string): number {
    const hist = this.history[capability];
    if (hist && hist.sampleCount > 0) {
      return hist.avgCostUsd;
    }
    return this.coldStartEstimate(capability);
  }

  updateHistory(capability: string, inputTokens: number, outputTokens: number, cost: number): void {
    const entry = this.history[capability] ?? {
      avgInputTokens: 0,
      avgOutputTokens: 0,
      avgCostUsd: 0,
      sampleCount: 0,
    };

    const n = entry.sampleCount;
    const newN = n + 1;
    this.history[capability] = {
      avgInputTokens: (entry.avgInputTokens * n + inputTokens) / newN,
      avgOutputTokens: (entry.avgOutputTokens * n + outputTokens) / newN,
      avgCostUsd: (entry.avgCostUsd * n + cost) / newN,
      sampleCount: newN,
    };
  }

  private coldStartEstimate(capability: string): number {
    const pricing = this.modelPricing[capability];
    if (pricing) {
      const [estInput, estOutput] = (() => {
        switch (capability) {
          case "Frontier": return [15_000, 8_000];
          case "Strong": return [10_000, 5_000];
          case "Medium": return [5_000, 3_000];
          case "Light": return [2_000, 1_000];
          default: return [10_000, 5_000];
        }
      })();
      return (estInput * pricing.inputPer1m + estOutput * pricing.outputPer1m) / 1_000_000;
    }

    switch (capability) {
      case "Frontier": return 0.30;
      case "Strong": return 0.10;
      case "Medium": return 0.03;
      case "Light": return 0.01;
      default: return 0.10;
    }
  }
}
