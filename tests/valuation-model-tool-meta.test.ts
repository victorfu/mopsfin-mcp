import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import {
  valuationModelFreshnessDetails,
  valuationModelSourceDependenciesComplete,
} from "@/lib/mcp/tools/valuation-model";
import type {
  ValuationModelInputsResult,
  ValuationModelLineageStatus,
} from "@/lib/valuation-model/types";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";

function result(
  lineageStatus: ValuationModelLineageStatus,
): ValuationModelInputsResult {
  const retrievedAt = "2026-08-28T06:00:00.000Z";
  return {
    generatedAt: "2026-08-28T06:01:00.000Z",
    company: { market: "listed" },
    periods: { latestReportedPeriod: "2026Q2" },
    lineage: [
      {
        role: "latest_completed_official_close",
        status: lineageStatus,
      },
    ],
    sources: [
      {
        sourceId: "master",
        stage: "company_master",
        market: "listed",
        exchange: "TWSE",
        sourceName: "master",
        sourceUrl: "https://example.test/master",
        retrievedAt,
        reportDate: "2026-08-28",
        asOf: "2026-08-28",
        asOfGranularity: "date",
      },
      {
        sourceId: "statement",
        stage: "statement",
        sourceName: "statement",
        sourceUrl: "https://example.test/statement",
        retrievedAt,
        upstreamRoute: "/compare/data",
        statement: "income_statement",
        period: "2026Q2",
        asOf: "2026Q2",
        asOfGranularity: "quarter",
        reportName: "2330 台積電",
        rawUnit: "新台幣仟元",
        unitSource: "response_html",
        normalizedUnit: "TWD",
        amountMultiplier: 1000,
        consolidationScope: "consolidated",
      },
      {
        sourceId: "completed-close",
        stage: "latest_official_completed_close",
        companyCode: "2330",
        market: "listed",
        exchange: "TWSE",
        sourceName: "TWSE exact single-stock OHLC",
        sourceUrl: "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260801&stockNo=2330&response=json",
        retrievedAt,
        snapshotIdentity: "verified",
        dataMonth: "2026-08",
        selectedBarDate: "2026-08-28",
        observedName: "台積電",
        normalization: {
          volumeShares: { sourceUnit: "share", outputUnit: "share", multiplier: 1 },
          turnoverTwd: { sourceUnit: "TWD", outputUnit: "TWD", multiplier: 1 },
          tradeCount: { sourceUnit: "trade", outputUnit: "trade", multiplier: 1 },
        },
        asOf: "2026-08-28",
        asOfGranularity: "date",
      },
    ],
    workBudget: {
      statementCalls: { actual: 1 },
      authoritativeCompletedCloseCalls: { actual: 1 },
    },
  } as unknown as ValuationModelInputsResult;
}

function completedClose(): AuthoritativeCompletedCloseResult {
  const resolverEvidence = completedSessionEvidenceFixture({
    expectedAsOf: "2026-08-28",
  });
  return {
    query: {
      companyCode: "2330",
      market: "listed",
      evaluatedAt: resolverEvidence.evaluatedAt,
    },
    company: {
      code: "2330",
      shortName: "台積電",
      market: "listed",
      exchange: "TWSE",
    },
    expectedAsOf: "2026-08-28",
    selectedBarDate: "2026-08-28",
    close: 2_420,
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    bar: {
      date: "2026-08-28",
      open: 2_410,
      high: 2_430,
      low: 2_400,
      close: 2_420,
      volumeShares: 1_000,
      turnoverTwd: 2_420_000,
      tradeCount: 10,
      change: 10,
      changeMarker: null,
      market: "listed",
      status: "traded",
      qualityStatus: "complete",
      missingFields: [],
    },
    source: {
      companyCode: "2330",
      market: "listed",
      exchange: "TWSE",
      sourceName: "TWSE exact single-stock OHLC",
      sourceUrl: "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260801&stockNo=2330&response=json",
      retrievedAt: "2026-08-28T06:00:00.000Z",
      snapshotIdentity: "verified",
      dataMonth: "2026-08",
      normalization: {
        volumeShares: { sourceUnit: "share", outputUnit: "share", multiplier: 1 },
        turnoverTwd: { sourceUnit: "TWD", outputUnit: "TWD", multiplier: 1 },
        tradeCount: { sourceUnit: "trade", outputUnit: "trade", multiplier: 1 },
      },
      observedName: "台積電",
      selectedBarDate: "2026-08-28",
    },
    resolverEvidence,
    cacheRefresh: { attempted: false, initialCacheStatus: "miss" },
    workBudget: {
      scope: "authoritative_completed_close_routing",
      completedSessionResolver: resolverEvidence.workBudget,
      exactStockOhlcAttempts: {
        actual: 1,
        maximum: 2,
        cacheRefreshPerformed: false,
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("valuation-model dependency metadata", () => {
  it.each(["invalid", "ambiguous"] as const)(
    "marks %s close evidence source-partial and excludes it from freshness",
    async (status) => {
      const resolve = vi.spyOn(completedSessionResolver, "resolve");
      const data = result(status);

      expect(valuationModelSourceDependenciesComplete(data)).toBe(false);
      const details = await valuationModelFreshnessDetails(data);

      expect(resolve).not.toHaveBeenCalled();
      expect(
        details.some(
          (detail) => detail.policyId === "official.completed-session.v1",
        ),
      ).toBe(false);
    },
  );

  it("reuses the routing context resolver evidence without resolving again", async () => {
    const resolve = vi.spyOn(completedSessionResolver, "resolve");
    const data = result("resolved");
    const context = completedClose();

    expect(valuationModelSourceDependenciesComplete(data)).toBe(true);
    const details = await valuationModelFreshnessDetails(data, context);

    expect(resolve).not.toHaveBeenCalled();
    expect(details).toContainEqual(
      expect.objectContaining({
        policyId: "official.completed-session.v1",
        status: "within_expected_window",
        observedAsOf: "2026-08-28",
        expectedAsOf: "2026-08-28",
        resolverEvidence: context.resolverEvidence,
      }),
    );
  });
});
