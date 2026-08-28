import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import type {
  CorporateActionCoverage,
  CorporateActionEvent,
  CorporateActionHistory,
} from "@/lib/corporate-actions/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import {
  StockPriceSeriesClient,
  type PriceSeriesCorporateActionLike,
  type PriceSeriesRawPriceLike,
} from "@/lib/price-series/client";
import type {
  OhlcBar,
  PriceSource,
  StockOhlcQuery,
  StockOhlcResult,
} from "@/lib/price/types";

interface PriceSeriesFixture {
  bars: OhlcBar[];
  cashDividendEvent: CorporateActionEvent;
  stockEvent: CorporateActionEvent;
}

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const sample = fixture<PriceSeriesFixture>("price-series.json");
const now = () => new Date("2026-08-28T02:00:00.000Z");

function company(): MasterCompany {
  return {
    code: "2330",
    name: "台灣積體電路製造股份有限公司",
    shortName: "台積電",
    market: "listed",
    exchange: "TWSE",
    industryCode: "24",
    listingDate: "1994-09-05",
    incorporationDate: null,
    paidInCapitalTwd: null,
    issuedCommonShares: null,
    parValueText: null,
    financialReportTypeCode: null,
    profileValueStatus: {
      incorporationDate: "missing",
      paidInCapitalTwd: "missing",
      issuedCommonShares: "missing",
      parValueText: "missing",
      financialReportTypeCode: "missing",
    },
    domicileCode: "TW",
    isKy: false,
    isFinancial: false,
  };
}

function master(): CompanyMasterResult {
  return {
    query: { market: "all", includeFinancial: true, includeKy: true },
    generatedAt: "2026-08-28T01:00:00.000Z",
    snapshotId: "listed:2026-08-27",
    coverageVerification: {
      status: "heuristic",
      method: "required_sources_schema_single_report_date_minimum_count",
      officialDeclaredRowCountAvailable: false,
    },
    coverageComplete: true,
    sources: [],
    counts: {
      raw: 1,
      excludedTdr: 0,
      eligible: 1,
      excludedFinancial: 0,
      excludedKy: 0,
      listed: 1,
      otc: 0,
      returned: 1,
    },
    profileCoverage: {
      incorporationDate: { reported: 0, missing: 1, invalid: 0 },
      paidInCapitalTwd: { reported: 0, missing: 1, invalid: 0 },
      issuedCommonShares: { reported: 0, missing: 1, invalid: 0 },
      parValueText: { reported: 0, missing: 1, invalid: 0 },
      financialReportTypeCode: { reported: 0, missing: 1, invalid: 0 },
    },
    companies: [company()],
    warnings: [],
  };
}

function priceSource(dataMonth = "2026-08"): PriceSource {
  return {
    market: "listed",
    sourceName: "TWSE STOCK_DAY",
    sourceUrl: `https://www.twse.com.tw/example/${dataMonth}`,
    retrievedAt: "2026-08-28T01:30:00.000Z",
    snapshotIdentity: "verified",
    dataMonth,
    normalization: {
      volumeShares: {
        sourceUnit: "share",
        outputUnit: "share",
        multiplier: 1,
      },
      turnoverTwd: {
        sourceUnit: "TWD",
        outputUnit: "TWD",
        multiplier: 1,
      },
      tradeCount: {
        sourceUnit: "trade",
        outputUnit: "trade",
        multiplier: 1,
      },
    },
  };
}

function pricePage(options: {
  query: StockOhlcQuery;
  bars: OhlcBar[];
  coveredThrough?: string;
  complete?: boolean;
  nextCursor?: string | null;
}): StockOhlcResult {
  const complete = options.complete ?? true;
  return {
    query: options.query,
    companyCode: "2330",
    observedNames: ["台積電"],
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    dataQualityComplete: true,
    bars: options.bars,
    coverage: {
      requestedStart: options.query.startDate,
      requestedEnd: options.query.endDate,
      coveredThrough:
        options.coveredThrough ?? options.query.endDate,
      coverageComplete: complete,
      nextCursor: complete ? null : (options.nextCursor ?? "next"),
    },
    sources: [priceSource()],
    warnings: [],
  };
}

function rawPrice(
  implementation?: PriceSeriesRawPriceLike["getStockOhlc"],
): PriceSeriesRawPriceLike & { getStockOhlc: ReturnType<typeof vi.fn> } {
  return {
    getStockOhlc: vi.fn(
      implementation ??
        (async (query: StockOhlcQuery) =>
          pricePage({ query, bars: structuredClone(sample.bars) })),
    ),
  };
}

function completeCoverage(
  overrides: Partial<CorporateActionCoverage> = {},
): CorporateActionCoverage {
  return {
    status: "complete",
    coverageComplete: true,
    requestedStart: "2026-08-24",
    requestedEnd: "2026-08-26",
    gaps: [],
    ...overrides,
  };
}

function history(
  events: CorporateActionEvent[],
  coverage: CorporateActionCoverage = completeCoverage(),
): CorporateActionHistory {
  return {
    market: "listed",
    requestedStart: "2026-08-24",
    requestedEnd: "2026-08-26",
    filteredCompanyCodes: ["2330"],
    events,
    sources: [],
    requestCount: 3,
    coverage,
    fingerprint: "a".repeat(64),
    fingerprintBasis:
      "full_market_range_contracts_and_summaries_plus_selected_scope_and_twse_combined_detail_without_retrieved_at",
    warnings: [],
  };
}

function actions(
  result: CorporateActionHistory | Error,
): PriceSeriesCorporateActionLike & { getHistory: ReturnType<typeof vi.fn> } {
  return {
    getHistory: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return structuredClone(result);
    }),
  };
}

function client(
  prices: PriceSeriesRawPriceLike,
  corporateActions: PriceSeriesCorporateActionLike,
) {
  return new StockPriceSeriesClient(
    now,
    { listCompanies: vi.fn().mockResolvedValue(master()) },
    prices,
    corporateActions,
  );
}

const adjustedQuery = {
  companyCode: "2330",
  startDate: "2026-08-24",
  endDate: "2026-08-26",
  priceBasis:
    "price_index_compatible_corporate_action_adjusted" as const,
  includeEventLedger: true,
};

describe("StockPriceSeriesClient", () => {
  it("returns raw official bars without making an unnecessary corporate-action call", async () => {
    const prices = rawPrice();
    const corporateActions = actions(
      new Error("raw basis must not query corporate actions"),
    );
    const result = await client(prices, corporateActions).getStockPriceSeries({
      ...adjustedQuery,
      priceBasis: "raw_unadjusted",
    });

    expect(corporateActions.getHistory).not.toHaveBeenCalled();
    expect(result.adjustment).toMatchObject({
      status: "not_requested",
      adjustmentDirection: "not_applicable",
      isAdjustedClose: false,
      isTotalReturn: false,
      volumeAdjusted: false,
    });
    expect(result.bars.map((bar) => bar.close)).toEqual([100, 50, 55]);
    expect(result.bars.every((bar) => bar.adjusted === null)).toBe(true);
    expect(result.coverage.corporateActions.status).toBe("not_requested");
    expect(result.workBudget).toMatchObject({
      rawPricePageCount: 1,
      corporateActionHistoryCalls: 0,
      corporateActionOfficialRequestCount: 0,
    });
  });

  it("retains a cash-dividend price effect with official factor one", async () => {
    const corporateActions = actions(
      history([structuredClone(sample.cashDividendEvent)]),
    );
    const result = await client(rawPrice(), corporateActions)
      .getStockPriceSeries(adjustedQuery);

    expect(corporateActions.getHistory).toHaveBeenCalledOnce();
    expect(corporateActions.getHistory).toHaveBeenCalledWith(
      "listed",
      "2026-08-24",
      "2026-08-26",
      { companyCodes: ["2330"] },
    );
    expect(result.adjustment).toMatchObject({
      status: "complete",
      adjustmentDirection: "backward",
      anchorDate: "2026-08-26",
      factorAtWindowStart: 1,
      cashDividendTreatment: "retained",
      isAdjustedClose: false,
      isTotalReturn: false,
      volumeAdjusted: false,
    });
    expect(result.bars.map((bar) => bar.adjusted?.close)).toEqual([
      100,
      50,
      55,
    ]);
    expect(result.eventLedger).toHaveLength(1);
    expect(result.eventLedger[0]).toMatchObject({
      status: "applied",
      factor: 1,
      markerReconciliation: { status: "matched", marker: "X" },
    });
  });

  it("backward-adjusts all OHLC fields for a stock event while leaving volume raw", async () => {
    const result = await client(
      rawPrice(),
      actions(history([structuredClone(sample.stockEvent)])),
    ).getStockPriceSeries(adjustedQuery);

    expect(result.adjustment.status).toBe("complete");
    expect(result.bars[0]).toMatchObject({
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volumeShares: 1000,
      volumeBasis: "raw_shares",
      cumulativeFactor: 0.5,
      adjusted: { open: 49.5, high: 50.5, low: 49, close: 50 },
    });
    expect(result.bars[1]).toMatchObject({
      cumulativeFactor: 1,
      adjusted: { open: 49, high: 51, low: 48, close: 50 },
      volumeShares: 2000,
    });
    expect(result.coverage.adjustment).toEqual({
      status: "complete",
      completeBarCount: 3,
      unknownBarCount: 0,
    });
  });

  it("can suppress the event ledger without changing the adjustment calculation", async () => {
    const result = await client(
      rawPrice(),
      actions(history([structuredClone(sample.stockEvent)])),
    ).getStockPriceSeries({
      ...adjustedQuery,
      includeEventLedger: false,
    });

    expect(result.eventLedgerIncluded).toBe(false);
    expect(result.eventLedger).toEqual([]);
    expect(result.adjustment.status).toBe("complete");
    expect(result.bars[0].adjusted?.close).toBe(50);
  });

  it.each([
    {
      label: "missing factor",
      events: [
        {
          ...sample.stockEvent,
          priceIndexAdjustmentFactor: null,
          adjustmentStatus: "unavailable" as const,
          adjustmentReason: "missing_required_official_value" as const,
        },
      ],
      coverage: completeCoverage(),
      bars: sample.bars,
      reason: "corporate_action_factor_unavailable",
    },
    {
      label: "prior-close mismatch",
      events: [{ ...sample.stockEvent, priorCloseTwd: 99 }],
      coverage: completeCoverage(),
      bars: sample.bars,
      reason: "corporate_action_prior_close_mismatch",
    },
    {
      label: "ambiguous same-day events",
      events: [sample.stockEvent, sample.cashDividendEvent],
      coverage: completeCoverage(),
      bars: sample.bars,
      reason: "ambiguous_same_day_corporate_actions",
    },
    {
      label: "unmatched official marker",
      events: [],
      coverage: completeCoverage(),
      bars: sample.bars,
      reason: "unmatched_official_change_marker",
    },
    {
      label: "incomplete corporate-action coverage",
      events: [],
      coverage: completeCoverage({
        status: "partial",
        coverageComplete: false,
        gaps: [
          {
            market: "listed",
            family: "ex_right_dividend",
            requestedStart: "2026-08-24",
            uncoveredThrough: "2026-08-24",
            supportedFrom: "2026-08-25",
            reason: "before_official_history_start",
          },
        ],
      }),
      bars: sample.bars.map((bar) => ({ ...bar, changeMarker: null })),
      reason: "corporate_action_coverage_incomplete",
    },
  ] as const)(
    "keeps affected adjusted OHLC null instead of falling back to raw for $label",
    async ({ events, coverage, bars, reason }) => {
      const prices = rawPrice(async (query) =>
        pricePage({ query, bars: structuredClone([...bars]) }),
      );
      const result = await client(
        prices,
        actions(history(structuredClone([...events]), structuredClone(coverage))),
      ).getStockPriceSeries(adjustedQuery);

      expect(result.adjustment.status).toBe("unknown");
      expect(result.adjustment.unknownReasons).toContain(reason);
      expect(result.bars[0].close).toBe(100);
      expect(result.bars[0]).toMatchObject({
        adjusted: null,
        cumulativeFactor: null,
        adjustmentStatus: "unknown",
      });
      expect(result.bars[0].adjustmentUnknownReasons).toContain(reason);
    },
  );

  it("keeps raw bars and returns unknown when the corporate-action dependency fails", async () => {
    const result = await client(
      rawPrice(),
      actions(new MopsfinError("UPSTREAM_TIMEOUT", "timeout", {
        retryable: true,
      })),
    ).getStockPriceSeries(adjustedQuery);

    expect(result.coverage.corporateActions).toMatchObject({
      status: "unavailable",
      coverage: null,
      failure: { code: "UPSTREAM_TIMEOUT", retryable: true },
    });
    expect(result.adjustment.status).toBe("unknown");
    expect(result.bars.every((bar) => bar.adjusted === null)).toBe(true);
  });

  it("does not assert a market when current identity is absent and historical bars span markets", async () => {
    const noCurrentMaster = master();
    noCurrentMaster.companies = [];
    noCurrentMaster.counts = {
      ...noCurrentMaster.counts,
      raw: 0,
      eligible: 0,
      listed: 0,
      returned: 0,
    };
    const mixedBars = sample.bars.map((bar, index) => ({
      ...bar,
      market: index === 0 ? "otc" as const : "listed" as const,
      changeMarker: null,
    }));
    const prices = rawPrice(async (query) =>
      pricePage({ query, bars: mixedBars }),
    );
    const corporateActions = actions(history([]));
    const result = await new StockPriceSeriesClient(
      now,
      { listCompanies: vi.fn().mockResolvedValue(noCurrentMaster) },
      prices,
      corporateActions,
    ).getStockPriceSeries(adjustedQuery);

    expect(result.identity).toMatchObject({
      status: "unverified",
      resolvedMarket: null,
      observedMarkets: ["listed", "otc"],
    });
    expect(corporateActions.getHistory).not.toHaveBeenCalled();
    expect(result.coverage.corporateActions).toMatchObject({
      status: "unavailable",
      failure: { code: "INCOMPLETE_COVERAGE" },
    });
    expect(result.adjustment.unknownReasons).toEqual(
      expect.arrayContaining([
        "corporate_action_coverage_incomplete",
        "market_transition_or_historical_market_mismatch",
      ]),
    );
    expect(result.bars.every((bar) => bar.adjusted === null)).toBe(true);
  });

  it("collects exactly three cursor pages and verifies complete coverage", async () => {
    const prices = rawPrice(async (query) => {
      if (!query.cursor) {
        return pricePage({
          query,
          bars: [structuredClone(sample.bars[0])],
          coveredThrough: "2026-08-24",
          complete: false,
          nextCursor: "cursor-2",
        });
      }
      if (query.cursor === "cursor-2") {
        return pricePage({
          query,
          bars: [structuredClone(sample.bars[1])],
          coveredThrough: "2026-08-25",
          complete: false,
          nextCursor: "cursor-3",
        });
      }
      return pricePage({
        query,
        bars: [structuredClone(sample.bars[2])],
        coveredThrough: "2026-08-26",
        complete: true,
      });
    });
    const result = await client(prices, actions(history([])))
      .getStockPriceSeries({
        ...adjustedQuery,
        priceBasis: "raw_unadjusted",
      });

    expect(prices.getStockOhlc).toHaveBeenCalledTimes(3);
    expect(prices.getStockOhlc.mock.calls.map(([query]) => query.cursor)).toEqual([
      undefined,
      "cursor-2",
      "cursor-3",
    ]);
    expect(result.coverage.rawPrice).toMatchObject({
      coverageComplete: true,
      coveredThrough: "2026-08-26",
      pageCount: 3,
      barCount: 3,
    });
  });

  it("rejects a fourth required price page and ranges over 36 calendar months", async () => {
    let page = 0;
    const prices = rawPrice(async (query) => {
      page += 1;
      return pricePage({
        query,
        bars: [],
        coveredThrough: `2026-08-${23 + page}`,
        complete: false,
        nextCursor: `cursor-${page + 1}`,
      });
    });
    await expect(
      client(prices, actions(history([]))).getStockPriceSeries({
        ...adjustedQuery,
        priceBasis: "raw_unadjusted",
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_COVERAGE" });
    expect(prices.getStockOhlc).toHaveBeenCalledTimes(3);

    await expect(
      client(rawPrice(), actions(history([]))).getStockPriceSeries({
        ...adjustedQuery,
        startDate: "2023-08-01",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
