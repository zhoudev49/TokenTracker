// 参考单价（USD / 百万 token）。前缀匹配，最长前缀优先，
// 因此 "gpt-5" 会同时覆盖 gpt-5.5 / gpt-5.6-luna 等具体变体。
// cacheCreation 一律取 input 同价：OpenAI 侧不额外收缓存写入费。
import type { PricingTable, TokenPricing } from "./types";

const DEFAULT_PRICING: PricingTable = {
  "claude-3-5-sonnet-20241022": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },
  "claude-3-5-haiku": {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheCreationPerMillion: 1,
  },
  // Codex 侧模型（OpenAI GPT-5 系列）
  "gpt-5": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.125,
    cacheCreationPerMillion: 1.25,
  },
  "gpt-5-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.025,
    cacheCreationPerMillion: 0.25,
  },
  "gpt-5-nano": {
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
    cacheReadPerMillion: 0.005,
    cacheCreationPerMillion: 0.05,
  },
  default: null,
};

const PRICE_KEYS = [
  "inputPerMillion",
  "outputPerMillion",
  "cacheReadPerMillion",
  "cacheCreationPerMillion",
] as const;

type PriceKey = (typeof PRICE_KEYS)[number];

function normalizePrice(value: unknown): number | null {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function normalizePricing(pricing: unknown): TokenPricing | null {
  if (!pricing || typeof pricing !== "object") {
    return null;
  }
  const source = pricing as Record<string, unknown>;
  const fallbackKeys: Record<PriceKey, string> = {
    inputPerMillion: "input",
    outputPerMillion: "output",
    cacheReadPerMillion: "cacheRead",
    cacheCreationPerMillion: "cacheCreation",
  };
  const normalized: TokenPricing = {
    inputPerMillion: 0,
    outputPerMillion: 0,
    cacheReadPerMillion: 0,
    cacheCreationPerMillion: 0,
  };
  for (const key of PRICE_KEYS) {
    const value = normalizePrice(source[key] ?? source[fallbackKeys[key]]);
    if (value === null) {
      return null;
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizePricingTable(value: unknown): PricingTable {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result: PricingTable = {};

  for (const [model, pricing] of Object.entries(source)) {
    if (pricing === null && model === "default") {
      result.default = null;
      continue;
    }
    const normalized = normalizePricing(pricing);
    if (normalized) {
      result[model] = normalized;
    }
  }

  return result;
}

function mergePricing(customPricing: unknown = null): PricingTable {
  return {
    ...DEFAULT_PRICING,
    ...normalizePricingTable(customPricing),
  };
}

// 前缀边界既接受 '-'（claude-3-5-haiku-20241022）也接受 '.'（gpt-5.6-luna），
// 后者是 Codex 侧模型的点号版本号写法。只在边界处截断，
// 避免 "gpt-5" 误配到 "gpt-50" 这类不同系列。
function matchesPrefix(name: string, prefix: string): boolean {
  if (name === prefix) return true;
  if (!name.startsWith(prefix)) return false;
  const boundary = name.charAt(prefix.length);
  return boundary === "-" || boundary === ".";
}

function getModelPricing(model: string | null | undefined, customPricing: unknown = null): TokenPricing | null {
  const table = mergePricing(customPricing);
  const name = model || "unknown";
  let matchedPricing: TokenPricing | null = null;
  let matchedPrefixLength = -1;

  for (const [prefix, pricing] of Object.entries(table)) {
    if (prefix === "default") {
      continue;
    }
    if (matchesPrefix(name, prefix)) {
      if (prefix.length > matchedPrefixLength) {
        matchedPricing = pricing;
        matchedPrefixLength = prefix.length;
      }
    }
  }

  return matchedPricing || table.default || null;
}

interface CostEvent {
  model?: string | null;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  totalTokens?: unknown;
}

function calculateEventCost(event: CostEvent, customPricing: unknown = null): { costUsd: number | null; priced: boolean } {
  const pricing = getModelPricing(event.model, customPricing);
  if (!pricing) {
    return { costUsd: null, priced: false };
  }

  const costUsd =
    ((Number(event.inputTokens) || 0) / 1_000_000) * pricing.inputPerMillion +
    ((Number(event.outputTokens) || 0) / 1_000_000) * pricing.outputPerMillion +
    ((Number(event.cacheReadTokens) || 0) / 1_000_000) * pricing.cacheReadPerMillion +
    ((Number(event.cacheCreationTokens) || 0) / 1_000_000) * pricing.cacheCreationPerMillion;

  return { costUsd, priced: true };
}

function calculateUsageCost(events: CostEvent[], customPricing: unknown = null): {
  estimatedCostUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  unpricedModels: string[];
  complete: boolean;
} {
  let estimatedCostUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const unpricedModels = new Set<string>();

  for (const event of events) {
    const totalTokens = Number(event.totalTokens) || 0;
    const result = calculateEventCost(event, customPricing);
    if (result.priced) {
      estimatedCostUsd += result.costUsd ?? 0;
      pricedTokens += totalTokens;
    } else {
      unpricedTokens += totalTokens;
      unpricedModels.add(event.model || "unknown");
    }
  }

  return {
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    pricedTokens,
    unpricedTokens,
    unpricedModels: Array.from(unpricedModels).sort(),
    complete: unpricedTokens === 0,
  };
}

function parseCustomPricing(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const pricing: unknown = JSON.parse(String(value));
    return pricing && typeof pricing === "object" ? (pricing as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export = {
  DEFAULT_PRICING,
  calculateEventCost,
  calculateUsageCost,
  getModelPricing,
  normalizePricing,
  parseCustomPricing,
};
