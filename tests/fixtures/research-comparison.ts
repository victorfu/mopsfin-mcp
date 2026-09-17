import { vi } from "vitest";
import { ComparisonClient } from "@/lib/comparison/client";
import type { CompanyMetricsBatchResult } from "@/lib/mopsfin/batch";
import { researchMarketFixture, researchNow } from "./research-market";

export function comparisonFixture() {
  const market = researchMarketFixture();
  const metrics = [
    { code: "Revenue", name: "營業收入", unit: "仟元", family: "data" as const, category: "一般" },
    { code: "EPS", name: "每股盈餘", unit: "元", family: "data" as const, category: "一般" },
    { code: "GrossMargin", name: "毛利率", unit: "%", family: "data" as const, category: "一般" },
  ];
  market.catalogData.metrics = metrics;
  market.catalogData.financialInstitutions = [{ code: "2881", name: "富邦金", sector: "holding" }];
  const data: CompanyMetricsBatchResult = {
    query: { companyCodes: ["2330", "6488", "2881"], metricCodes: metrics.map((metric) => metric.code), basis: "quarterly", history: "recent_12", startPeriod: "2023Q3", endPeriod: "2026Q2" },
    retrievedAt: "2026-08-28T07:00:00Z", snapshotId: "fixture", metricDefinitions: metrics.map(({ code, name, unit, category }) => ({ code, name, unit, category })), failures: [],
    companies: ["2330", "6488", "2881"].map((code) => ({ companyCode: code, companyName: code, displayName: code, evaluationStatus: "complete", metrics: metrics.map((metric) => {
      const periods = code === "6488" ? ["2026Q1"] : ["2026Q1", "2026Q2"];
      return { metricCode: metric.code, metricName: metric.name, unit: metric.unit, availability: "available", periods, points: periods.map((period) => ({ period, value: metric.code === "EPS" ? 2.5 : 100, valueStatus: "reported" })), coverage: { seriesReturned: true, nonNullPoints: periods.length, missingPoints: 0, invalidPoints: 0, firstReportedPeriod: periods[0], latestReportedPeriod: periods.at(-1)!, missingPeriods: [] }, failure: null };
    }) })),
    coverage: { selectionComplete: true, requestedCompanyCodes: ["2330", "6488", "2881"], returnedCompanyCodes: ["2330", "6488", "2881"], missingCompanyCodes: [], noValidDataCompanyCodes: [], unavailableCompanyCodes: [], sourceComplete: true, failureIsolationComplete: true, identityFailedCompanyCodes: [], metrics: [] },
    workBudget: { comparisonPlanUnits: 3, comparisonExecutedUnits: 3, isolationRetryUnits: 0, comparisonUnitLimit: 24, identityLookupUpperBound: 3, unitDefinition: "one_metric_by_up_to_ten_companies_request" },
    sources: [{ sourceName: "Mopsfin", sourceUrl: "https://mopsfin.twse.com.tw/", retrievedAt: "2026-08-28T07:00:00Z", upstreamRoute: "/compare/data", freshnessNote: "fixture" }], warnings: [],
  };
  const batch = { getCompanyMetricsBatch: vi.fn(async () => data) };
  return { ...market, data, batch, client: new ComparisonClient(market.dependencies, market.catalog, batch, researchNow) };
}
