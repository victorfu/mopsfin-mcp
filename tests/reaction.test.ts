import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMarket,
  MasterCompany,
} from "@/lib/company-master/types";
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

interface FakePriceOptions {
  omitDates?: Set<string>;
  markerDate?: string;
  historicalMarket?: CompanyMarket;
  observedNames?: string[];
  noDataCodes?: Set<string>;
}

function fakePrice(
  companies: MasterCompany[],
  options: FakePriceOptions = {},
) {
  const byCode = new Map(companies.map((item) => [item.code, item]));
  return {
    getStockOhlc: vi.fn(async (query): Promise<StockOhlcResult> => {
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
          const close = 100 + index;
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
  it("computes exact N-session raw, benchmark, excess, liquidity, and path signals", async () => {
    const companies = [company("2330", "台積電")];
    const benchmark = fakeBenchmark();
    const price = fakePrice(companies);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      { benchmarkClient: benchmark },
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
      status: "provisional_raw",
      corporateActionEvidence: "none_observed",
      marketTransitionDetected: false,
      reasons: ["raw_prices_not_adjusted"],
    });
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
      { benchmarkClient: fakeBenchmark() },
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
      { benchmarkClient: fakeBenchmark() },
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
        "official_change_marker_within_horizon",
        "market_transition_or_historical_market_mismatch_within_horizon",
        "multiple_observed_names",
      ],
    });
    expect(item.comparability).toMatchObject({
      status: "not_comparable",
      corporateActionAdjustment: "not_applied",
      corporateActionEvidence: "official_marker_present",
      marketTransitionDetected: true,
      observedMarkets: ["otc"],
      officialChangeMarkers: [{ date: markerDate, marker: "X" }],
    });
    expect(item.comparability.reasons).toEqual([
      "raw_prices_not_adjusted",
      "official_change_marker_present",
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
      { benchmarkClient: fakeBenchmark() },
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
      excessReturnReasons: ["official_change_marker_within_horizon"],
    });
  });

  it("returns explicit no-data statuses for one company without masking the page", async () => {
    const companies = [company("2330", "台積電"), company("1101", "台泥")];
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      fakePrice(companies, { noDataCodes: new Set(["1101"]) }),
      { benchmarkClient: fakeBenchmark() },
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
      reasons: ["raw_prices_not_adjusted", "no_stock_data"],
    });
    expect(result.coverage.dataQualityComplete).toBe(false);
  });

  it("paginates companies under the 48 source-work-unit cap with a scoped cursor", async () => {
    const companies = Array.from({ length: 20 }, (_, index) =>
      company(String(1001 + index)),
    );
    const benchmark = fakeBenchmark();
    const price = fakePrice(companies);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      { benchmarkClient: benchmark },
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
      { benchmarkClient: fakeBenchmark() },
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

  it("requires an explicit as_of to be an exact benchmark session", async () => {
    const companies = [company("2330", "台積電")];
    const price = fakePrice(companies);
    const client = new ReactionClient(
      vi.fn() as typeof fetch,
      now,
      master(companies),
      price,
      { benchmarkClient: fakeBenchmark() },
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
