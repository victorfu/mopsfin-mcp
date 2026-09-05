import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMarket,
  MasterCompany,
} from "@/lib/company-master/types";
import type {
  CorporateActionEvent,
  CorporateActionHistory,
} from "@/lib/corporate-actions/types";
import { buildPriceIndexCompatibleSeries } from "@/lib/corporate-actions/adjustment-engine";
import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { OhlcBar, StockOhlcResult } from "@/lib/price/types";
import {
  BenchmarkClient,
  normalizeTpexBenchmarkMonth,
  normalizeTwseBenchmarkMonth,
} from "@/lib/reaction/benchmark-client";
import { ReactionClient } from "@/lib/reaction/client";
import {
  decodeReactionCursor,
  encodeReactionCursor,
} from "@/lib/reaction/cursor";
import type { BenchmarkHistory } from "@/lib/reaction/types";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";

const twseFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/reaction-twse-index.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;
const tpexFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/reaction-tpex-index.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function company(
  code: string,
  name = `公司${code}`,
  market: CompanyMarket = "listed",
  listingDate = "2000-01-01",
): MasterCompany {
  return {
    code,
    name: `${name}股份有限公司`,
    shortName: name,
    market,
    exchange: market === "listed" ? "TWSE" : "TPEx",
    industryCode: "24",
    listingDate,
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

function master(companies: MasterCompany[], snapshotId = "reaction-fixture") {
  return {
    listCompanies: vi.fn(async (_query: {
      market: "all" | "listed" | "otc";
      includeFinancial: boolean;
      includeKy: boolean;
    }): Promise<CompanyMasterResult> => ({
      query: { market: "all", includeFinancial: true, includeKy: true },
      generatedAt: "2026-07-01T00:00:00.000Z",
      snapshotId,
      coverageVerification: {
        status: "heuristic",
        method: "required_sources_schema_single_report_date_minimum_count",
        officialDeclaredRowCountAvailable: false,
      },
      coverageComplete: true,
      sources: [],
      counts: {
        raw: companies.length,
        excludedTdr: 0,
        eligible: companies.length,
        excludedFinancial: 0,
        excludedKy: 0,
        listed: companies.filter((item) => item.market === "listed").length,
        otc: companies.filter((item) => item.market === "otc").length,
        returned: companies.length,
      },
      profileCoverage: {
        incorporationDate: { reported: 0, missing: companies.length, invalid: 0 },
        paidInCapitalTwd: { reported: 0, missing: companies.length, invalid: 0 },
        issuedCommonShares: { reported: 0, missing: companies.length, invalid: 0 },
        parValueText: { reported: 0, missing: companies.length, invalid: 0 },
        financialReportTypeCode: {
          reported: 0,
          missing: companies.length,
          invalid: 0,
        },
      },
      companies,
      warnings: [],
    })),
  };
}

function weekdayDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const final = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= final) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

const allSessions = weekdayDates("2025-01-01", "2026-06-30");

function fakeBenchmark() {
  return {
    getHistory: vi.fn(
      async (market: CompanyMarket, months: string[]): Promise<BenchmarkHistory> => ({
        market,
        benchmarkCode: market === "listed" ? "TAIEX" : "TPEX_PRICE_INDEX",
        benchmarkName: market === "listed" ? "發行量加權股價指數" : "櫃買指數",
        priceBasis: "price_index",
        bars: allSessions
          .filter((date) => months.includes(date.slice(0, 7)))
          .map((date) => ({
            date,
            close:
              (market === "listed" ? 1_000 : 2_000) + allSessions.indexOf(date),
          })),
        sources: [],
      }),
    ),
  };
}

function fakeCompletedSessions(options: {
  expectedByMarket?: Partial<Record<CompanyMarket, string>>;
  status?: "resolved" | "unresolved";
} = {}) {
  return {
    resolve: vi.fn(
      async ({ market, evaluatedAt }: {
        market: CompanyMarket;
        evaluatedAt?: Date | string;
      }): Promise<CompletedSessionResolverEvidence> => {
        const evidence = completedSessionEvidenceFixture({
          market,
          status: options.status ?? "resolved",
          expectedAsOf: options.expectedByMarket?.[market] ?? "2026-06-30",
        });
        evidence.evaluatedAt =
          evaluatedAt instanceof Date
            ? evaluatedAt.toISOString()
            : new Date(evaluatedAt as string).toISOString();
        return evidence;
      },
    ),
  };
}

interface FakePriceOptions {
  omitDates?: Set<string>;
  markerDate?: string;
  historicalMarket?: CompanyMarket;
  observedNames?: string[];
  noDataCodes?: Set<string>;
  splitFromDate?: string;
  splitFactor?: number;
  failures?: Map<string, unknown>;
}

function fakePrice(
  companies: MasterCompany[],
  options: FakePriceOptions = {},
) {
  const byCode = new Map(companies.map((item) => [item.code, item]));
  return {
    getStockOhlc: vi.fn(async (query): Promise<StockOhlcResult> => {
      if (options.failures?.has(query.companyCode)) {
        throw options.failures.get(query.companyCode);
      }
      if (options.noDataCodes?.has(query.companyCode)) {
        throw new MopsfinError("NO_DATA", "fixture no data");
      }
      const current = byCode.get(query.companyCode) as MasterCompany;
      const bars = allSessions
        .filter(
          (date) =>
            date >= query.startDate &&
            date <= query.endDate &&
            !options.omitDates?.has(date),
        )
        .map((date): OhlcBar => {
          const index = allSessions.indexOf(date);
          const close =
            (100 + index) *
            (options.splitFromDate && date >= options.splitFromDate
              ? (options.splitFactor ?? 1)
              : 1);
          return {
            date,
            open: close - 1,
            high: close + 1,
            low: close - 2,
            close,
            volumeShares: 1_000 + index * 10,
            turnoverTwd: (1_000 + index * 10) * close,
            tradeCount: 100,
            change: 1,
            changeMarker: date === options.markerDate ? "X" : null,
            market: options.historicalMarket ?? current.market,
            status: "traded",
            qualityStatus: "complete",
            missingFields: [],
          };
        });
      return {
        query,
        companyCode: query.companyCode,
        observedNames: options.observedNames ?? [current.shortName],
        currency: "TWD",
        timezone: "Asia/Taipei",
        interval: "1d",
        priceBasis: "raw_unadjusted",
        dataQualityComplete: true,
        bars,
        coverage: {
          requestedStart: query.startDate,
          requestedEnd: query.endDate,
          coveredThrough: query.endDate,
          coverageComplete: true,
          nextCursor: null,
        },
        sources: [],
        warnings: [],
      };
    }),
  };
}

function fakeCorporateActions(options: {
  events?: CorporateActionEvent[];
  coverageComplete?: boolean;
  fingerprint?: string;
} = {}) {
  return {
    getHistory: vi.fn(
      async (
        market: CompanyMarket,
        startDate: string,
        endDate: string,
        query?: { companyCodes?: string[] },
      ): Promise<CorporateActionHistory> => {
        const coverageComplete = options.coverageComplete ?? true;
        const selectedCodes = query?.companyCodes
          ? new Set(query.companyCodes)
          : null;
        return {
          market,
          requestedStart: startDate,
          requestedEnd: endDate,
          filteredCompanyCodes: query?.companyCodes
            ? [...query.companyCodes].sort()
            : null,
          events: (options.events ?? []).filter(
            (event) =>
              event.market === market &&
              event.effectiveDate >= startDate &&
              event.effectiveDate <= endDate &&
              (!selectedCodes || selectedCodes.has(event.companyCode)),
          ),
          sources: [],
          requestCount: 3,
          coverage: {
            status: coverageComplete ? "complete" : "partial",
            coverageComplete,
            requestedStart: startDate,
            requestedEnd: endDate,
            gaps: coverageComplete
              ? []
              : [
                  {
                    market,
                    family: "ex_right_dividend",
                    requestedStart: startDate,
                    uncoveredThrough: endDate,
                    supportedFrom: endDate,
                    reason: "before_official_history_start",
                  },
                ],
          },
          fingerprint: options.fingerprint ?? "c".repeat(64),
          fingerprintBasis:
            "full_market_range_contracts_and_summaries_plus_selected_scope_and_twse_combined_detail_without_retrieved_at",
          warnings: [],
        };
      },
    ),
  };
}

function action(
  overrides: Partial<CorporateActionEvent> = {},
): CorporateActionEvent {
  return {
    companyCode: "2330",
    name: "台積電",
    market: "listed",
    effectiveDate: "2026-06-16",
    kind: "stock_rights",
    priorCloseTwd: 485,
    referencePriceTwd: 242.5,
    cashDividendPerShareTwd: 0,
    priceIndexAdjustmentFactor: 0.5,
    shareCountChanged: true,
    adjustmentStatus: "available",
    adjustmentReason: "official_reference_price_divided_by_prior_close",
    sourceFamily: "ex_right_dividend",
    sourceUrl: "https://example.test/corporate-action",
    rawType: "權",
    ...overrides,
  };
}

const now = () => new Date("2026-07-01T01:00:00.000Z");

describe("official price-index benchmark adapters", () => {
  it("normalizes official TWSE and TPEx price-index fixtures", () => {
    const twse = normalizeTwseBenchmarkMonth(
      { payload: twseFixture, retrievedAt: "2025-02-01T00:00:00.000Z" },
      "2025-01",
      "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?date=20250101",
    );
    const tpex = normalizeTpexBenchmarkMonth(
      { payload: tpexFixture, retrievedAt: "2025-02-01T00:00:00.000Z" },
      "2025-01",
      "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=2025%2F01%2F01",
    );

    expect(twse.bars).toEqual([
      { date: "2025-01-02", close: 22_832.06 },
      { date: "2025-01-03", close: 22_783.42 },
      { date: "2025-01-06", close: 22_948.37 },
    ]);
    expect(twse.source).toMatchObject({
      benchmarkCode: "TAIEX",
      benchmarkName: "發行量加權股價指數",
      rowCount: 3,
    });
    expect(tpex.bars.at(-1)).toEqual({ date: "2025-01-06", close: 254.12 });
    expect(tpex.source).toMatchObject({
      benchmarkCode: "TPEX_PRICE_INDEX",
      benchmarkName: "櫃買指數",
      rowCount: 3,
    });
  });

  it("uses the verified monthly URLs and slash-form TPEx date", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) =>
      response(String(input).includes("twse.com.tw") ? twseFixture : tpexFixture),
    );
    const client = new BenchmarkClient(fetchMock as typeof fetch, now, {
      retryDelayMs: 0,
    });

    await client.getHistory("listed", ["2025-01"]);
    await client.getHistory("otc", ["2025-01"]);

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[0].pathname).toBe("/indicesReport/MI_5MINS_HIST");
    expect(urls[0].searchParams.get("date")).toBe("20250101");
    expect(urls[1].pathname).toBe("/www/zh-tw/afterTrading/tradingIndex");
    expect(urls[1].searchParams.get("date")).toBe("2025/01/01");
  });

  it("rejects truncated TPEx rows and silent response-month drift", () => {
    const truncated = structuredClone(tpexFixture);
    const truncatedTable = (truncated.tables as Array<Record<string, unknown>>)[0];
    truncatedTable.totalCount = 4;
    expect(() =>
      normalizeTpexBenchmarkMonth(
        { payload: truncated, retrievedAt: "2025-02-01T00:00:00.000Z" },
        "2025-01",
        "fixture",
      ),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }));

    const drifted = structuredClone(tpexFixture);
    drifted.date = "20260801";
    expect(() =>
      normalizeTpexBenchmarkMonth(
        { payload: drifted, retrievedAt: "2025-02-01T00:00:00.000Z" },
        "2025-01",
        "fixture",
      ),
    ).toThrow(expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }));
  });

  it("treats a not-yet-populated TWSE month as empty so latest can use the prior session", () => {
    const result = normalizeTwseBenchmarkMonth(
      {
        payload: { stat: "很抱歉，沒有符合條件的資料!" },
        retrievedAt: "2025-02-01T00:00:00.000Z",
      },
      "2025-02",
      "fixture",
    );

    expect(result.bars).toEqual([]);
    expect(result.source).toMatchObject({ dataMonth: "2025-02", rowCount: 0 });
  });

  it("rejects an empty middle benchmark month as incomplete coverage", async () => {
    const february = structuredClone(twseFixture);
    february.date = "20250201";
    february.data = [
      ["114/02/03", "23,000.00", "23,100.00", "22,900.00", "23,050.00"],
    ];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const date = new URL(String(input)).searchParams.get("date");
      return response(
        date === "20250101"
          ? { stat: "很抱歉，沒有符合條件的資料!" }
          : february,
      );
    });
    const client = new BenchmarkClient(fetchMock as typeof fetch, now, {
      retryDelayMs: 0,
    });

    await expect(
      client.getHistory("listed", ["2025-01", "2025-02"]),
    ).rejects.toMatchObject({ code: "INCOMPLETE_COVERAGE" });
  });
});

describe("ReactionClient getStockReactionSignals", () => {
  it("routes latest through per-market authoritative completed-session evidence", async () => {
    const companies = [
      company("2330", "台積電", "listed"),
      company("3105", "穩懋", "otc"),
    ];
    const completedSessions = fakeCompletedSessions({
      expectedByMarket: {
        listed: "2026-06-30",
        otc: "2026-06-29",
      },
    });
    const price = fakePrice(companies);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
        completedSessionResolver: completedSessions,
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330", "3105"],
      asOf: "latest",
      horizons: [5],
    });

    expect(result.asOf.resolvedByMarket).toEqual([
      { market: "listed", date: "2026-06-30" },
      { market: "otc", date: "2026-06-29" },
    ]);
    expect(result.asOf.completedSessionEvidence).toHaveLength(2);
    expect(
      result.asOf.completedSessionEvidence.map((item) => item.markets),
    ).toEqual([["listed"], ["otc"]]);
    expect(completedSessions.resolve).toHaveBeenCalledTimes(2);
    expect(completedSessions.resolve).toHaveBeenNthCalledWith(1, {
      market: "listed",
      evaluatedAt: "2026-07-01T01:00:00.000Z",
    });
    expect(completedSessions.resolve).toHaveBeenNthCalledWith(2, {
      market: "otc",
      evaluatedAt: "2026-07-01T01:00:00.000Z",
    });
    expect(price.getStockOhlc.mock.calls.map(([query]) => query.endDate)).toEqual([
      "2026-06-30",
      "2026-06-29",
    ]);
  });

  it("keeps latest pinned to the resolver date when the exact stock bar is missing", async () => {
    const companies = [company("2330", "台積電")];
    const completedSessions = fakeCompletedSessions();
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { omitDates: new Set(["2026-06-30"]) }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
        completedSessionResolver: completedSessions,
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "latest",
      horizons: [5],
    });

    expect(result.companies[0]).toMatchObject({
      resolvedAsOf: "2026-06-30",
      dataQualityComplete: false,
    });
    expect(result.companies[0].returns[0]).toMatchObject({
      endDate: "2026-06-30",
      status: "missing_stock_end_close",
      stockReturnPercent: null,
    });
  });

  it("fails closed when latest completed-session evidence is unresolved", async () => {
    const companies = [company("2330", "台積電")];
    const benchmark = fakeBenchmark();
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies),
      {
        benchmarkClient: benchmark,
        corporateActionClient: fakeCorporateActions(),
        completedSessionResolver: fakeCompletedSessions({
          status: "unresolved",
        }),
      },
    );

    await expect(
      client.getStockReactionSignals({
        companyCodes: ["2330"],
        asOf: "latest",
        horizons: [5],
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_SESSION_UNRESOLVED",
      retryable: true,
      action: "retry",
    });
    expect(benchmark.getHistory).not.toHaveBeenCalled();
  });

  it("computes exact N-session raw and price-index-compatible reaction signals", async () => {
    const companies = [company("2330", "台積電")];
    const benchmark = fakeBenchmark();
    const price = fakePrice(companies);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      {
        benchmarkClient: benchmark,
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [120, 5, 20, 60],
    });

    const item = result.companies[0];
    const endIndex = allSessions.indexOf("2026-06-30");
    const start120 = allSessions[endIndex - 120];
    const stockStart = 100 + allSessions.indexOf(start120);
    const stockEnd = 100 + endIndex;
    const benchmarkStart = 1_000 + allSessions.indexOf(start120);
    const benchmarkEnd = 1_000 + endIndex;
    expect(result.query.horizons).toEqual([5, 20, 60, 120]);
    expect(item.returns.at(-1)).toMatchObject({
      horizonSessions: 120,
      startDate: start120,
      endDate: "2026-06-30",
      status: "available",
    });
    expect(item.returns.at(-1)?.stockReturnPercent).toBeCloseTo(
      (stockEnd / stockStart - 1) * 100,
      7,
    );
    expect(
      item.returns.at(-1)?.priceIndexCompatibleStockReturnPercent,
    ).toBeCloseTo((stockEnd / stockStart - 1) * 100, 7);
    expect(item.returns.at(-1)?.corporateActionAdjustmentFactor).toBe(1);
    expect(item.returns.at(-1)?.benchmarkReturnPercent).toBeCloseTo(
      (benchmarkEnd / benchmarkStart - 1) * 100,
      7,
    );
    expect(item.returns.at(-1)?.excessReturnPercentagePoints).toBeCloseTo(
      (stockEnd / stockStart - benchmarkEnd / benchmarkStart) * 100,
      7,
    );
    const lastFiveVolumes = allSessions
      .slice(endIndex - 4, endIndex + 1)
      .map((date) => 1_000 + allSessions.indexOf(date) * 10);
    expect(item.liquidity.averageVolume5SessionsShares.value).toBe(
      lastFiveVolumes.reduce((sum, value) => sum + value, 0) / 5,
    );
    expect(item.liquidity.volume5To20Ratio.status).toBe("available");
    expect(item.liquidity.averageTurnover60SessionsTwd.observationCount).toBe(60);
    expect(item.pricePath).toMatchObject({
      horizonSessions: 120,
      expectedObservationCount: 121,
      observationCount: 121,
      maximumDrawdownPercent: 0,
      distanceBelowWindowHighPercent: 0,
      status: "available",
    });
    expect(item.comparability).toMatchObject({
      status: "price_index_compatible",
      corporateActionAdjustment: "not_required",
      corporateActionEvidence: "official_history_verified_no_event",
      marketTransitionDetected: false,
      reasons: [],
    });
    expect(result.returnBasis).toBe(
      "price_index_compatible_corporate_action_adjusted",
    );
    expect(result.coverage.corporateActionHistoryComplete).toBe(true);
    expect(result.workBudget.consumed).toBeLessThanOrEqual(48);
    expect(result.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("does not backfill a missing exact stock anchor", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const missing20Start = allSessions[endIndex - 20];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { omitDates: new Set([missing20Start]) }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5, 20],
    });

    expect(result.companies[0].returns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ horizonSessions: 5, status: "available" }),
        expect.objectContaining({
          horizonSessions: 20,
          startDate: missing20Start,
          stockReturnPercent: null,
          excessReturnPercentagePoints: null,
          status: "missing_stock_start_close",
        }),
      ]),
    );
    expect(result.companies[0].dataQualityComplete).toBe(false);
  });

  it("flags transition, official markers, and identity changes without hiding raw returns", async () => {
    const companies = [company("3416", "融程電", "listed")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const markerDate = allSessions[endIndex - 2];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, {
        markerDate,
        historicalMarket: "otc",
        observedNames: ["融程電", "舊公司"],
      }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["3416"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    const item = result.companies[0];
    expect(item.returns[0].stockReturnPercent).toBeTypeOf("number");
    expect(item.returns[0]).toMatchObject({
      excessReturnPercentagePoints: null,
      excessReturnStatus: "not_comparable",
      excessReturnReasons: [
        "unmatched_official_change_marker_within_horizon",
        "market_transition_or_historical_market_mismatch_within_horizon",
        "multiple_observed_names",
      ],
    });
    expect(item.comparability).toMatchObject({
      status: "not_comparable",
      corporateActionAdjustment: "not_required",
      corporateActionEvidence: "official_history_verified_no_event",
      marketTransitionDetected: true,
      observedMarkets: ["otc"],
      officialChangeMarkers: [{ date: markerDate, marker: "X" }],
    });
    expect(item.comparability.reasons).toEqual([
      "unmatched_official_change_marker_present",
      "market_transition_or_historical_market_mismatch",
      "multiple_observed_names",
    ]);
  });

  it("does not relabel raw price-path values as adjusted when only market and name identity fail", async () => {
    const companies = [company("3416", "融程電", "listed")];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, {
        historicalMarket: "otc",
        observedNames: ["融程電", "舊公司"],
      }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["3416"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    const item = result.companies[0];
    expect(item.returns[0]).toMatchObject({
      stockReturnPercent: expect.any(Number),
      priceIndexCompatibleStockReturnPercent: null,
      excessReturnStatus: "not_comparable",
      excessReturnReasons: [
        "market_transition_or_historical_market_mismatch_within_horizon",
        "multiple_observed_names",
      ],
    });
    expect(item.pricePath).toMatchObject({
      maximumDrawdownPercent: null,
      distanceBelowWindowHighPercent: null,
      priceBasis: "price_index_compatible_corporate_action_adjusted",
      status: "not_comparable_corporate_action",
    });
    expect(item.comparability.reasons).toEqual([
      "market_transition_or_historical_market_mismatch",
      "multiple_observed_names",
    ]);
  });

  it("applies comparability independently to each requested horizon", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const markerDate = allSessions[endIndex - 10];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { markerDate }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5, 20],
    });

    expect(result.companies[0].returns[0]).toMatchObject({
      horizonSessions: 5,
      excessReturnStatus: "available",
      excessReturnReasons: [],
    });
    expect(result.companies[0].returns[1]).toMatchObject({
      horizonSessions: 20,
      excessReturnPercentagePoints: null,
      excessReturnStatus: "not_comparable",
      excessReturnReasons: [
        "unmatched_official_change_marker_within_horizon",
      ],
    });
  });

  it("does not cross a return-anchor marker but retains it for the 20-session volume window", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const markerDate = allSessions[endIndex - 5];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { markerDate }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(result.companies[0].returns[0]).toMatchObject({
      startDate: markerDate,
      excessReturnStatus: "available",
      excessReturnReasons: [],
    });
    expect(result.companies[0].comparability).toMatchObject({
      status: "not_comparable",
      officialChangeMarkers: [{ date: markerDate, marker: "X" }],
      unmatchedOfficialChangeMarkers: [{ date: markerDate, marker: "X" }],
    });
    expect(
      result.companies[0].liquidity.averageVolume20SessionsShares.status,
    ).toBe("not_comparable_corporate_action");
  });

  it("removes a verified share-count price break without hiding the raw return", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const effectiveDate = allSessions[endIndex - 10];
    const priorDate = allSessions[endIndex - 11];
    const priorClose = 100 + allSessions.indexOf(priorDate);
    const corporateEvent = action({
      effectiveDate,
      priorCloseTwd: priorClose,
      referencePriceTwd: priorClose * 0.5,
      priceIndexAdjustmentFactor: 0.5,
    });
    const price = fakePrice(companies, {
      markerDate: effectiveDate,
      splitFromDate: effectiveDate,
      splitFactor: 0.5,
    });
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions({ events: [corporateEvent] }),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5, 20, 60],
    });
    const item = result.companies[0];
    const return20 = item.returns.find((signal) => signal.horizonSessions === 20);
    const start20 = allSessions[endIndex - 20];
    const raw = await price.getStockOhlc({
      companyCode: "2330",
      startDate: start20,
      endDate: "2026-06-30",
    });
    const adjusted = buildPriceIndexCompatibleSeries({
      companyCode: "2330",
      currentCompanyName: "台積電",
      currentMarket: "listed",
      observedNames: raw.observedNames,
      bars: raw.bars,
      events: [corporateEvent],
      coverage: {
        status: "complete",
        coverageComplete: true,
        requestedStart: start20,
        requestedEnd: "2026-06-30",
        gaps: [],
      },
      windowStartDate: start20,
      anchorDate: "2026-06-30",
    });
    const adjustedStart = adjusted.bars.find(
      (bar) => bar.date === start20,
    )?.adjusted?.close;
    const adjustedEnd = adjusted.bars.find(
      (bar) => bar.date === "2026-06-30",
    )?.adjusted?.close;

    expect(return20?.stockReturnPercent).toBeLessThan(-40);
    expect(return20).toMatchObject({
      corporateActionAdjustmentFactor: 0.5,
      excessReturnStatus: "available",
      excessReturnReasons: [],
    });
    expect(return20?.priceIndexCompatibleStockReturnPercent).toBeGreaterThan(0);
    expect(return20?.priceIndexCompatibleStockReturnPercent).toBeCloseTo(
      ((adjustedEnd as number) / (adjustedStart as number) - 1) * 100,
      7,
    );
    expect(return20?.corporateActionAdjustmentFactor).toBe(
      adjusted.factorAtWindowStart,
    );
    expect(item.comparability).toMatchObject({
      status: "price_index_compatible",
      corporateActionAdjustment: "applied",
      corporateActionEvidence: "official_history_verified_events",
      unmatchedOfficialChangeMarkers: [],
    });
    expect(item.pricePath.status).toBe("available");
    expect(item.liquidity.averageVolume5SessionsShares.status).toBe("available");
    expect(item.liquidity.averageVolume20SessionsShares.status).toBe(
      "not_comparable_corporate_action",
    );
    expect(item.liquidity.volume5To20Ratio.status).toBe(
      "not_comparable_corporate_action",
    );
    expect(item.liquidity.averageTurnover20SessionsTwd.status).toBe("available");
  });

  it("refuses an official factor that cannot bridge to the raw prior close", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const effectiveDate = allSessions[endIndex - 2];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { markerDate: effectiveDate }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions({
          events: [
            action({
              effectiveDate,
              priorCloseTwd: 9_999,
              referencePriceTwd: 4_999.5,
            }),
          ],
        }),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });
    const item = result.companies[0];

    expect(item.returns[0]).toMatchObject({
      stockReturnPercent: expect.any(Number),
      priceIndexCompatibleStockReturnPercent: null,
      corporateActionAdjustmentFactor: null,
      excessReturnPercentagePoints: null,
      excessReturnStatus: "not_comparable",
      excessReturnReasons: ["corporate_action_prior_close_mismatch"],
    });
    expect(item.comparability.reasons).toContain(
      "corporate_action_prior_close_mismatch",
    );
    expect(item.pricePath.status).toBe("not_comparable_corporate_action");
  });

  it("fails closed on multiple official action families on the same effective date", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const effectiveDate = allSessions[endIndex - 2];
    const priorDate = allSessions[endIndex - 3];
    const priorClose = 100 + allSessions.indexOf(priorDate);
    const events = [
      action({ effectiveDate, priorCloseTwd: priorClose }),
      action({
        effectiveDate,
        kind: "par_value_change",
        priorCloseTwd: priorClose,
        referencePriceTwd: priorClose / 10,
        priceIndexAdjustmentFactor: 0.1,
        cashDividendPerShareTwd: null,
        adjustmentReason: "official_reference_price_divided_by_prior_close",
        sourceFamily: "par_value_change",
        rawType: "變更股票面額",
      }),
    ];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { markerDate: effectiveDate }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions({ events }),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(result.companies[0].returns[0]).toMatchObject({
      stockReturnPercent: expect.any(Number),
      priceIndexCompatibleStockReturnPercent: null,
      excessReturnStatus: "not_comparable",
      excessReturnReasons: ["corporate_action_adjustment_unavailable"],
    });
  });

  it("marks selected unavailable corporate-action factors as incomplete history", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const effectiveDate = allSessions[endIndex - 2];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { markerDate: effectiveDate }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions({
          events: [
            action({
              effectiveDate,
              priorCloseTwd: null,
              referencePriceTwd: null,
              priceIndexAdjustmentFactor: null,
              adjustmentStatus: "unavailable",
              adjustmentReason: "twse_combined_event_detail_failed",
            }),
          ],
        }),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(result.coverage.corporateActionHistoryComplete).toBe(false);
    expect(result.coverage.dataQualityComplete).toBe(false);
    expect(result.companies[0].comparability).toMatchObject({
      status: "not_comparable",
      corporateActionCoverageComplete: true,
      reasons: ["corporate_action_adjustment_unavailable"],
      corporateActions: [
        expect.objectContaining({
          effectiveDate,
          adjustmentStatus: "unavailable",
          adjustmentReason: "twse_combined_event_detail_failed",
        }),
      ],
    });
  });

  it("does not let an unavailable event on the action-window anchor poison completeness", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const actionWindowStart = allSessions[endIndex - 19];
    const actions = fakeCorporateActions({
      events: [
        action({
          effectiveDate: actionWindowStart,
          priorCloseTwd: null,
          referencePriceTwd: null,
          priceIndexAdjustmentFactor: null,
          adjustmentStatus: "unavailable",
          adjustmentReason: "twse_combined_event_detail_failed",
        }),
      ],
    });
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: actions,
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(actions.getHistory).toHaveBeenCalledWith(
      "listed",
      actionWindowStart,
      "2026-06-30",
      { companyCodes: ["2330"] },
    );
    expect(result.coverage.corporateActionHistoryComplete).toBe(true);
    expect(result.coverage.dataQualityComplete).toBe(true);
    expect(result.companies[0].comparability).toMatchObject({
      status: "price_index_compatible",
      corporateActions: [],
    });
  });

  it("treats an unverified empty corporate-action range as unknown, not no-event", async () => {
    const companies = [company("2330", "台積電")];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions({ coverageComplete: false }),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(result.coverage.corporateActionHistoryComplete).toBe(false);
    expect(result.companies[0].returns[0]).toMatchObject({
      stockReturnPercent: expect.any(Number),
      priceIndexCompatibleStockReturnPercent: null,
      excessReturnStatus: "not_comparable",
      excessReturnReasons: ["corporate_action_coverage_incomplete"],
    });
    expect(result.companies[0].comparability).toMatchObject({
      status: "not_comparable",
      corporateActionEvidence: "official_history_incomplete",
    });
  });

  it("returns explicit no-data statuses for one company without masking the page", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { noDataCodes: new Set(["1101"]) }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330", "1101"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(result.companies.map((item) => item.stockDataStatus)).toEqual([
      "available",
      "no_data",
    ]);
    expect(result.companies[1].returns[0]).toMatchObject({
      stockReturnPercent: null,
      status: "no_stock_data",
    });
    expect(result.companies[1].comparability).toMatchObject({
      status: "unavailable",
      reasons: ["no_stock_data"],
    });
    expect(result.companies[1].stockDataFailure).toBeNull();
    expect(result.coverage.dataQualityComplete).toBe(false);
  });

  it("isolates one company OHLC MopsfinError and keeps healthy peers", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const timeout = new MopsfinError(
      "UPSTREAM_TIMEOUT",
      "fixture stock timeout",
      {
        reason: "UPSTREAM_REQUEST_TIMEOUT",
        retryable: true,
        retryAfterMs: 250,
        action: "retry",
      },
    );
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, {
        failures: new Map([["1101", timeout]]),
      }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330", "1101"],
      asOf: "2026-06-30",
      horizons: [5],
    });

    expect(result.companies).toHaveLength(2);
    expect(result.companies[0]).toMatchObject({
      companyCode: "2330",
      stockDataStatus: "available",
      stockDataFailure: null,
      dataQualityComplete: true,
    });
    const unavailable = result.companies[1];
    expect(unavailable).toMatchObject({
      companyCode: "1101",
      stockDataStatus: "unavailable",
      stockDataFailure: {
        code: "UPSTREAM_TIMEOUT",
        reason: "UPSTREAM_REQUEST_TIMEOUT",
        message: "fixture stock timeout",
        retryable: true,
        retryAfterMs: 250,
        action: "retry",
      },
      comparability: {
        status: "unavailable",
        reasons: ["stock_data_unavailable"],
      },
      dataQualityComplete: false,
    });
    expect(unavailable.returns).toEqual([
      expect.objectContaining({
        stockReturnPercent: null,
        priceIndexCompatibleStockReturnPercent: null,
        corporateActionAdjustmentFactor: null,
        excessReturnPercentagePoints: null,
        status: "stock_data_unavailable",
        excessReturnStatus: "stock_data_unavailable",
      }),
    ]);
    expect(Object.values(unavailable.liquidity)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: null,
          status: "stock_data_unavailable",
        }),
      ]),
    );
    expect(
      Object.values(unavailable.liquidity).every(
        (signal) =>
          signal.value === null && signal.status === "stock_data_unavailable",
      ),
    ).toBe(true);
    expect(unavailable.pricePath).toMatchObject({
      observationCount: 0,
      maximumDrawdownPercent: null,
      distanceBelowWindowHighPercent: null,
      status: "stock_data_unavailable",
    });
    expect(result.coverage.dataQualityComplete).toBe(false);
    expect(result.pagination.returnedCompanyCount).toBe(2);
  });

  it("still fails fast on a non-MopsfinError from a stock dependency", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, {
        failures: new Map([["1101", new Error("fixture programmer failure")]]),
      }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    await expect(
      client.getStockReactionSignals({
        companyCodes: ["2330", "1101"],
        asOf: "2026-06-30",
        horizons: [5],
      }),
    ).rejects.toThrow("fixture programmer failure");
  });

  it("checks the 20-session share-volume window even when only horizon 5 is requested", async () => {
    const companies = [company("2330", "台積電")];
    const endIndex = allSessions.indexOf("2026-06-30");
    const effectiveDate = allSessions[endIndex - 10];
    const priorDate = allSessions[endIndex - 11];
    const priorClose = 100 + allSessions.indexOf(priorDate);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, {
        markerDate: effectiveDate,
        splitFromDate: effectiveDate,
        splitFactor: 0.5,
      }),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions({
          events: [
            action({
              effectiveDate,
              priorCloseTwd: priorClose,
              referencePriceTwd: priorClose * 0.5,
              priceIndexAdjustmentFactor: 0.5,
            }),
          ],
        }),
      },
    );

    const result = await client.getStockReactionSignals({
      companyCodes: ["2330"],
      asOf: "2026-06-30",
      horizons: [5],
    });
    const item = result.companies[0];

    expect(item.returns[0]).toMatchObject({
      status: "available",
      excessReturnStatus: "available",
      corporateActionAdjustmentFactor: 1,
    });
    expect(item.pricePath.status).toBe("available");
    expect(item.comparability.corporateActions).toContainEqual(
      expect.objectContaining({ effectiveDate, shareCountChanged: true }),
    );
    expect(item.liquidity.averageVolume5SessionsShares.status).toBe("available");
    expect(item.liquidity.averageVolume20SessionsShares.status).toBe(
      "not_comparable_corporate_action",
    );
    expect(item.liquidity.volume5To20Ratio.status).toBe(
      "not_comparable_corporate_action",
    );
  });

  it("paginates companies under the 48 source-work-unit cap with a scoped cursor", async () => {
    const companies = Array.from({ length: 20 }, (_, index) =>
      company(String(1001 + index)),
    );
    const benchmark = fakeBenchmark();
    const price = fakePrice(companies);
    const actions = fakeCorporateActions();
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      {
        benchmarkClient: benchmark,
        corporateActionClient: actions,
      },
    );
    const query = {
      companyCodes: companies.map((item) => item.code),
      asOf: "2026-06-30" as const,
      horizons: [5] as const,
      pageSize: 10,
    };

    const first = await client.getStockReactionSignals({
      ...query,
      horizons: [...query.horizons],
    });
    expect(first.workBudget.consumed).toBeLessThanOrEqual(48);
    expect(first.pagination.hasMore).toBe(true);
    expect(first.pagination).toMatchObject({
      requestedPageSize: 10,
      returnedCompanyCount: 10,
    });
    expect(first.pagination.nextCursor).toBeTruthy();
    const second = await client.getStockReactionSignals({
      ...query,
      horizons: [...query.horizons],
      cursor: first.pagination.nextCursor as string,
    });
    expect(second.workBudget.consumed).toBeLessThanOrEqual(48);
    expect(second.pagination.snapshotId).toBe(first.pagination.snapshotId);
    expect(second.pagination.hasMore).toBe(false);
    expect([
      ...first.companies.map((item) => item.companyCode),
      ...second.companies.map((item) => item.companyCode),
    ]).toEqual(query.companyCodes);
    expect(actions.getHistory).toHaveBeenCalledTimes(2);
    for (const call of actions.getHistory.mock.calls) {
      expect(call[0]).toBe("listed");
      expect(call[3]).toEqual({ companyCodes: query.companyCodes });
    }

    await expect(
      client.getStockReactionSignals({
        ...query,
        horizons: [20],
        cursor: first.pagination.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "CURSOR_INVALID",
      category: "pagination",
      action: "restart_pagination",
    });
    await expect(
      client.getStockReactionSignals({
        ...query,
        pageSize: 9,
        horizons: [...query.horizons],
        cursor: first.pagination.nextCursor as string,
      }),
    ).rejects.toMatchObject({ reason: "CURSOR_INVALID" });

    const oversizedPayload = decodeReactionCursor(
      first.pagination.nextCursor as string,
    );
    const benchmarkCallsBefore = benchmark.getHistory.mock.calls.length;
    await expect(
      client.getStockReactionSignals({
        ...query,
        horizons: [...query.horizons],
        cursor: encodeReactionCursor({
          ...oversizedPayload,
          rangeStart: "1999-01-05",
        }),
      }),
    ).rejects.toMatchObject({ reason: "CURSOR_INVALID" });
    expect(benchmark.getHistory).toHaveBeenCalledTimes(benchmarkCallsBefore);
  });

  it("rejects a cursor after the pinned company snapshot changes", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const currentMaster = master(companies);
    const firstSnapshot = await currentMaster.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    currentMaster.listCompanies
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce({ ...firstSnapshot, snapshotId: "changed" });
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      currentMaster,
      fakePrice(companies),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );
    const query = {
      companyCodes: ["2330", "1101"],
      asOf: "2026-06-30" as const,
      horizons: [5] as const,
      pageSize: 1,
    };
    const first = await client.getStockReactionSignals({
      ...query,
      horizons: [...query.horizons],
    });

    await expect(
      client.getStockReactionSignals({
        ...query,
        horizons: [...query.horizons],
        cursor: first.pagination.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "SNAPSHOT_CHANGED",
      category: "pagination",
      action: "restart_pagination",
    });
  });

  it("rejects a cursor after the official corporate-action snapshot changes", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const actionOptions = { fingerprint: "a".repeat(64) };
    const actions = fakeCorporateActions(actionOptions);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: actions,
      },
    );
    const query = {
      companyCodes: ["2330", "1101"],
      asOf: "2026-06-30" as const,
      horizons: [5] as const,
      pageSize: 1,
    };
    const first = await client.getStockReactionSignals({
      ...query,
      horizons: [...query.horizons],
    });
    actionOptions.fingerprint = "b".repeat(64);

    await expect(
      client.getStockReactionSignals({
        ...query,
        horizons: [...query.horizons],
        cursor: first.pagination.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "SNAPSHOT_CHANGED",
      category: "pagination",
      action: "restart_pagination",
    });
  });

  it("rejects a latest cursor after completed-session evidence changes", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const completedOptions = {
      expectedByMarket: { listed: "2026-06-30" },
    };
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies),
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
        completedSessionResolver: fakeCompletedSessions(completedOptions),
      },
    );
    const query = {
      companyCodes: ["2330", "1101"],
      asOf: "latest" as const,
      horizons: [5] as const,
      pageSize: 1,
    };
    const first = await client.getStockReactionSignals({
      ...query,
      horizons: [...query.horizons],
    });
    completedOptions.expectedByMarket.listed = "2026-06-29";

    await expect(
      client.getStockReactionSignals({
        ...query,
        horizons: [...query.horizons],
        cursor: first.pagination.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "SNAPSHOT_CHANGED",
      category: "pagination",
      action: "restart_pagination",
    });
  });

  it("requires an explicit as_of to be an exact benchmark session", async () => {
    const companies = [company("2330", "台積電")];
    const price = fakePrice(companies);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      {
        benchmarkClient: fakeBenchmark(),
        corporateActionClient: fakeCorporateActions(),
      },
    );

    await expect(
      client.getStockReactionSignals({
        companyCodes: ["2330"],
        asOf: "2026-06-28",
        horizons: [5],
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
    expect(price.getStockOhlc).not.toHaveBeenCalled();
  });
});
