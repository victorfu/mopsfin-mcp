import { describe, expect, it } from "vitest";

import { mopsfinClient } from "@/lib/mopsfin/client";
import { taiwanStockScreenClient } from "@/lib/screening/client";
import {
  resolveScreenMetricRoles,
  SCREEN_METRIC_ROLES,
} from "@/lib/screening/metric-roles";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live screening semantic catalog contract", () => {
  it("resolves all roles and completes the 2330 deep financial dependency", async () => {
    const catalog = await mopsfinClient.getCatalog(true);
    const resolution = resolveScreenMetricRoles(catalog);

    expect(resolution.requiredFinancialMetricRoles).toEqual([
      ...SCREEN_METRIC_ROLES,
    ]);
    expect(resolution.resolvedFinancialMetrics).toHaveLength(7);
    expect(
      resolution.resolvedFinancialMetrics.every(
        (metric) => metric.family === "data",
      ),
    ).toBe(true);

    const result = await taiwanStockScreenClient.screenTaiwanStockCandidates({
      market: "listed",
      companyCodes: ["2330"],
      includeKy: true,
      candidateLimit: 1,
      preset: "balanced_non_financial_v2",
    });
    const metricDependency = result.dependencyStatus.find(
      (dependency) => dependency.dependency === "company_metrics_batch",
    );

    expect(result.screenDefinition.evidencePolicies.resolvedFinancialMetrics)
      .toHaveLength(7);
    expect(result.screenDefinition.evidencePolicies.financialMetricCodes).toEqual(
      resolution.resolvedFinancialMetrics.map((metric) => metric.metricCode),
    );
    expect(metricDependency).toBeDefined();
    expect(metricDependency?.status).not.toBe("failed");
    expect(result.funnel.deepSelected).toBe(1);
    expect(result.funnel.deepScored).toBe(1);
  }, 120_000);
});
