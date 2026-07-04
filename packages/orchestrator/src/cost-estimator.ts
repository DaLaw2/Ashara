import type { CostRepository, CapabilityCostEstimate } from "@ashara/db";

interface ProviderBalance {
  providerName: string;
  balanceUsd: number | null;
}

export class CostEstimator {
  private modelPricing: Record<string, { inputPer1m: number; outputPer1m: number }> = {};
  private history: Record<string, CapabilityCostEstimate> = {};
  private loaded = false;

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(costRepo: CostRepository): Promise<void> {
    this.loaded = true;

    try {
      this.modelPricing = await costRepo.loadModelPricing();
    } catch (e) {
      console.warn("Failed to load model pricing, using cold-start estimates:", e);
    }

    try {
      const dbHistory = await costRepo.loadCostHistory();
      for (const [cap, estimate] of Object.entries(dbHistory)) {
        if (estimate.sampleCount > 0) {
          this.history[cap] = estimate;
        }
      }
    } catch (e) {
      console.warn("Failed to load cost history, using cold-start defaults:", e);
    }

    console.log(
      `Cost estimator initialized: ${Object.keys(this.modelPricing).length} pricing capabilities, ` +
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

  static async checkProviderBalances(costRepo: CostRepository): Promise<ProviderBalance[]> {
    let providers: Array<{ name: string; providerType: string; baseUrl: string | null }>;
    try {
      providers = await costRepo.checkProviderBalances();
    } catch (e) {
      console.warn("Failed to query provider configs for balance check:", e);
      return [];
    }

    const balances: ProviderBalance[] = [];
    for (const { name, providerType, baseUrl } of providers) {
      const balance = await CostEstimator.checkSingleProviderBalance(name, providerType, baseUrl);
      balances.push({ providerName: name, balanceUsd: balance });
    }
    return balances;
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

  private static async checkSingleProviderBalance(
    name: string,
    providerType: string,
    baseUrl: string | null,
  ): Promise<number | null> {
    const apiKeyEnv = `${name.toUpperCase()}_API_KEY`;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) return null;

    if (providerType === "deepseek") {
      const url = baseUrl ?? "https://api.deepseek.com";
      try {
        const resp = await fetch(`${url}/user/balance`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          console.warn(`Provider balance check failed for ${name}: ${resp.status}`);
          return null;
        }
        const body = await resp.json() as Record<string, unknown>;
        const infos = body.balance_infos as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(infos)) return null;
        for (const entry of infos) {
          const currency = entry.currency as string;
          if (currency === "USD" || currency === "CNY") {
            const bal = parseFloat(entry.total_balance as string);
            if (!isNaN(bal)) return bal;
          }
        }
      } catch (e) {
        console.warn(`Provider balance check request failed for ${name}:`, e);
      }
    }

    return null;
  }
}
