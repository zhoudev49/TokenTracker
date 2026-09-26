import test from "node:test";
import assert from "node:assert/strict";
import { calculateEventCost, calculateUsageCost, getModelPricing } from "../src/pricing";

test("calculates input, output, cache read, and cache creation independently", () => {
  const result = calculateEventCost({
    model: "custom-model",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
  }, {
    "custom-model": {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 3,
      cacheCreationPerMillion: 4,
    },
  });

  assert.equal(result.priced, true);
  assert.equal(result.costUsd, 10);
});

test("does not guess the cost of an unknown model", () => {
  const result = calculateUsageCost([{
    model: "free-provider/model",
    totalTokens: 100,
    inputTokens: 50,
    outputTokens: 50,
  }]);

  assert.equal(result.complete, false);
  assert.equal(result.estimatedCostUsd, 0);
  assert.equal(result.unpricedTokens, 100);
  assert.deepEqual(result.unpricedModels, ["free-provider/model"]);
});

test("prefers the longest matching model prefix", () => {
  const pricing = getModelPricing("provider-model-special-v2", {
    "provider-model": {
      inputPerMillion: 1,
      outputPerMillion: 1,
      cacheReadPerMillion: 1,
      cacheCreationPerMillion: 1,
    },
    "provider-model-special": {
      inputPerMillion: 9,
      outputPerMillion: 9,
      cacheReadPerMillion: 9,
      cacheCreationPerMillion: 9,
    },
  });

  assert.equal(pricing!.inputPerMillion, 9);
});
