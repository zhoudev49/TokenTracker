import test from "node:test";
import assert from "node:assert/strict";
import {
  addCostsToProjects,
  calculateCacheAnalytics,
  calculateProjectStats,
  rowsToCsv,
} from "../src/analytics";
import type { UsageEvent } from "../src/types";

const PRICING = {
  "model-a": {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.5,
    cacheCreationPerMillion: 1.25,
  },
};

function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventKey: "event-default",
    sourceFile: "proj-x/session.jsonl",
    messageId: "message-default",
    sessionId: "session-1",
    projectName: "proj-x",
    timestamp: "2026-08-06T00:00:00.000Z",
    model: "model-a",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 2_000_000,
    ...overrides,
  };
}

test("calculateProjectStats aggregates token categories and session counts", () => {
  const events = [
    makeEvent({ sessionId: "s1", projectName: "a", model: "model-a", totalTokens: 100, inputTokens: 60, outputTokens: 40 }),
    makeEvent({ sessionId: "s1", projectName: "a", model: "model-b", totalTokens: 50, inputTokens: 30, outputTokens: 20 }),
    makeEvent({ sessionId: "s2", projectName: "a", model: "model-a", totalTokens: 70, inputTokens: 40, outputTokens: 30 }),
    makeEvent({ sessionId: "s3", projectName: "b", model: "model-a", totalTokens: 200, inputTokens: 120, outputTokens: 80 }),
  ];
  const projects = calculateProjectStats(events);

  assert.equal(projects.length, 2);
  const projectA = projects.find((project) => project.projectName === "a");
  assert.equal(projectA!.sessionCount, 2);
  assert.equal(projectA!.totalTokens, 220);
  assert.equal(projectA!.inputTokens, 130);
  assert.equal(projectA!.outputTokens, 90);
  const models = projectA!.modelDistribution.map((entry) => entry.model);
  assert.deepEqual(models, ["model-a", "model-b"]);
  // sorted by totalTokens desc: project A (220) precedes project B (200)
  const projectB = projects.find((project) => project.projectName === "b");
  assert.equal(projects[0].projectName, "a");
  assert.equal(projectB!.sessionCount, 1);
});

test("addCostsToProjects sums priced and unpriced tokens per project", () => {
  const events = [
    makeEvent({ sessionId: "s1", projectName: "a", totalTokens: 2_000_000, inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    makeEvent({ sessionId: "s2", projectName: "b", model: "unknown", totalTokens: 500, inputTokens: 300, outputTokens: 200 }),
  ];
  const projects = addCostsToProjects(calculateProjectStats(events), events, PRICING);

  const projectA = projects.find((project) => project.projectName === "a");
  assert.equal(projectA!.estimatedCostUsd, 3); // input 1 + output 2
  assert.equal(projectA!.unpricedTokens, 0);
  assert.equal(projectA!.complete, true);

  const projectB = projects.find((project) => project.projectName === "b");
  assert.equal(projectB!.estimatedCostUsd, 0);
  assert.equal(projectB!.unpricedTokens, 500);
  assert.equal(projectB!.complete, false);
  assert.deepEqual(projectB!.unpricedModels, ["unknown"]);
});

test("calculateCacheAnalytics measures cache efficiency and estimated savings", () => {
  const events = [
    // 1M input + 1M cache read: cacheable = 2M, read rate = 50%
    makeEvent({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, totalTokens: 2_000_000 }),
  ];
  const result = calculateCacheAnalytics(events, PRICING);

  assert.equal(result.cacheReadTokens, 1_000_000);
  assert.equal(result.cacheableTokens, 2_000_000);
  assert.equal(result.cacheEfficiency, 0.5);
  assert.equal(result.cacheEfficiencyPercent, 50);
  // savings = (1M/1M) * (input 1 - cacheRead 0.5) = 0.5
  assert.equal(result.estimatedSavingsUsd, 0.5);
  assert.equal(result.breakdown.length, 1);
  assert.equal(result.breakdown[0].model, "model-a");
});

test("calculateCacheAnalytics handles unpriced models without throwing", () => {
  const events = [makeEvent({ model: "free-model", inputTokens: 1_000_000, cacheReadTokens: 1_000_000 })];
  const result = calculateCacheAnalytics(events, PRICING);
  assert.equal(result.estimatedSavingsUsd, 0);
  assert.equal(result.cacheEfficiencyPercent, 50);
});

test("rowsToCsv prepends BOM and neutralizes formula injection", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "note", label: "Note" },
  ];
  const rows = [
    { name: "=cmd|'/c calc'!A1", note: 'say "hi", ok' },
    { name: "normal", note: "plain" },
  ];
  const csv = rowsToCsv(rows, columns);

  assert.ok(csv.startsWith("\uFEFF"), "CSV should start with a UTF-8 BOM");
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "\uFEFFName,Note");
  assert.ok(lines[1].startsWith("'="), "leading = should be neutralized by a single quote");
  assert.ok(lines[1].includes('"say ""hi"", ok"'), "embedded quotes and commas should be quoted");
  assert.ok(lines[2].startsWith("normal,plain"));
});
