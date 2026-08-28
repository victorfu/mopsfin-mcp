import { afterEach, describe, expect, it, vi } from "vitest";

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
        sourceId: "market",
        stage: "market_valuation",
        market: "listed",
        exchange: "TWSE",
        sourceName: "market",
        sourceUrl: "https://example.test/market",
        retrievedAt,
        dataDate: "2026-08-28",
        asOf: "2026-08-28",
        asOfGranularity: "date",
      },
    ],
    workBudget: {
      statementCalls: { actual: 1 },
      valuationDependencyCalls: { actual: 1 },
    },
  } as unknown as ValuationModelInputsResult;
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

  it("keeps a contract-valid official missing value as source-complete", async () => {
    const resolve = vi
      .spyOn(completedSessionResolver, "resolve")
      .mockResolvedValue(
        completedSessionEvidenceFixture({ expectedAsOf: "2026-08-28" }),
      );
    const data = result("missing");

    expect(valuationModelSourceDependenciesComplete(data)).toBe(true);
    const details = await valuationModelFreshnessDetails(data);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(details).toContainEqual(
      expect.objectContaining({
        policyId: "official.completed-session.v1",
        status: "within_expected_window",
      }),
    );
  });
});
