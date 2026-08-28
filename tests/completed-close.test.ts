import { describe, expect, it, vi } from "vitest";

import { AuthoritativeCompletedCloseClient } from "@/lib/completed-close/client";
import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import { PriceClient } from "@/lib/price/client";
import type {
  ExactCurrentCompanyOhlcResult,
  OhlcBar,
} from "@/lib/price/types";
import {
  COMPLETED_CLOSE_COMPANY,
  completedCloseBar,
  completedCloseResolverEvidenceFixture,
  exactCurrentCompanyOhlcFixture,
} from "@/tests/fixtures/completed-close";

const EVALUATED_AT = "2026-08-28T07:00:00.000Z";
const now = () => new Date(EVALUATED_AT);

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function twseMonth(rows: string[][]) {
  return {
    stat: "OK",
    date: "20260801",
    title: "115年08月 2330 台積電 各日成交資訊",
    fields: [
      "日期",
      "成交股數",
      "成交金額",
      "開盤價",
      "最高價",
      "最低價",
      "收盤價",
      "漲跌價差",
      "成交筆數",
      "註記",
    ],
    total: rows.length,
    data: rows,
  };
}

const ROW_2026_08_27 = [
  "115/08/27",
  "10,000,000",
  "24,100,000,000",
  "2,400.00",
  "2,420.00",
  "2,390.00",
  "2,410.00",
  "+10.00",
  "20,000",
  "",
];

const ROW_2026_08_28 = [
  "115/08/28",
  "10,000,000",
  "24,200,000,000",
  "2,410.00",
  "2,430.00",
  "2,400.00",
  "2,420.00",
  "+10.00",
  "20,000",
  "",
];

function noMasterDependency() {
  return {
    listCompanies: vi.fn(async () => {
      throw new Error("exact current-company OHLC 不得重查 company master");
    }),
  };
}

function resolver(
  evidence: CompletedSessionResolverEvidence =
    completedCloseResolverEvidenceFixture(),
) {
  return {
    resolve: vi.fn(async () => evidence),
  };
}

describe("authoritative completed-close routing", () => {
  it("routes resolver expectedAsOf to exact single-stock OHLC and ignores bulk latest", async () => {
    const master = noMasterDependency();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (
        url.pathname.includes("STOCK_DAY_ALL") ||
        url.pathname.includes("MI_INDEX") ||
        url.pathname.includes("BWIBBU")
      ) {
        throw new Error("bulk latest sentinel must not participate");
      }
      expect(url.pathname).toBe("/rwd/zh/afterTrading/STOCK_DAY");
      expect(url.searchParams.get("date")).toBe("20260801");
      expect(url.searchParams.get("stockNo")).toBe("2330");
      return response(twseMonth([ROW_2026_08_27, ROW_2026_08_28]));
    });
    const exactPrice = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master,
      { maxAttempts: 1, retryDelayMs: 0 },
    );
    const completedResolver = resolver();
    const client = new AuthoritativeCompletedCloseClient(
      completedResolver,
      exactPrice,
      now,
    );

    const result = await client.getLatestCompletedClose({
      company: COMPLETED_CLOSE_COMPANY,
      evaluatedAt: "2026-08-28T15:00:00+08:00",
    });

    expect(completedResolver.resolve).toHaveBeenCalledTimes(1);
    expect(completedResolver.resolve).toHaveBeenCalledWith({
      market: "listed",
      evaluatedAt: EVALUATED_AT,
    });
    expect(master.listCompanies).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      expectedAsOf: "2026-08-28",
      selectedBarDate: "2026-08-28",
      close: 2_420,
      source: {
        companyCode: "2330",
        market: "listed",
        exchange: "TWSE",
        observedName: "台積電",
        dataMonth: "2026-08",
        selectedBarDate: "2026-08-28",
        snapshotIdentity: "verified",
      },
      workBudget: {
        scope: "authoritative_completed_close_routing",
        exactStockOhlcAttempts: {
          actual: 1,
          maximum: 2,
          cacheRefreshPerformed: false,
        },
      },
    });
    expect(result.bar).toMatchObject({
      date: "2026-08-28",
      market: "listed",
      status: "traded",
      close: 2_420,
    });
    expect(result.resolverEvidence).toBe(
      await completedResolver.resolve.mock.results[0]?.value,
    );
  });

  it("invalidates one current-month cache hit missing expectedAsOf and refetches the exact URL once", async () => {
    const master = noMasterDependency();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(twseMonth([ROW_2026_08_27])))
      .mockResolvedValueOnce(
        response(twseMonth([ROW_2026_08_27, ROW_2026_08_28])),
      );
    const exactPrice = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master,
      { maxAttempts: 1, retryDelayMs: 0 },
    );
    await exactPrice.getExactCurrentCompanyOhlc({
      company: COMPLETED_CLOSE_COMPANY,
      date: "2026-08-27",
    });
    const completedResolver = resolver();
    const client = new AuthoritativeCompletedCloseClient(
      completedResolver,
      exactPrice,
      now,
    );

    const result = await client.getLatestCompletedClose({
      company: COMPLETED_CLOSE_COMPANY,
      evaluatedAt: EVALUATED_AT,
    });

    expect(completedResolver.resolve).toHaveBeenCalledTimes(1);
    expect(master.listCompanies).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/STOCK_DAY?"),
      expect.stringContaining("/STOCK_DAY?"),
    ]);
    expect(result.close).toBe(2_420);
    expect(result.source.dataMonth).toBe("2026-08");
    expect(result.source.selectedBarDate).toBe("2026-08-28");
    expect(result.cacheRefresh).toEqual({
      attempted: true,
      initialCacheStatus: "hit",
    });
    expect(result.workBudget.exactStockOhlcAttempts).toEqual({
      actual: 2,
      maximum: 2,
      cacheRefreshPerformed: true,
    });
  });

  it("refreshes a previous-month cache hit missing the authoritative expected date", async () => {
    const septemberEvaluatedAt = "2026-09-01T07:00:00.000Z";
    const septemberNow = () => new Date(septemberEvaluatedAt);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(twseMonth([ROW_2026_08_27])))
      .mockResolvedValueOnce(
        response(twseMonth([ROW_2026_08_27, ROW_2026_08_28])),
      );
    const exactPrice = new PriceClient(
      fetchMock as typeof fetch,
      septemberNow,
      noMasterDependency(),
      { maxAttempts: 1, retryDelayMs: 0 },
    );
    await exactPrice.getExactCurrentCompanyOhlc({
      company: COMPLETED_CLOSE_COMPANY,
      date: "2026-08-27",
    });
    const client = new AuthoritativeCompletedCloseClient(
      resolver(
        completedCloseResolverEvidenceFixture({
          evaluatedAt: septemberEvaluatedAt,
          expectedAsOf: "2026-08-28",
        }),
      ),
      exactPrice,
      septemberNow,
    );

    const result = await client.getLatestCompletedClose({
      company: COMPLETED_CLOSE_COMPANY,
      evaluatedAt: septemberEvaluatedAt,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.close).toBe(2_420);
    expect(result.cacheRefresh).toEqual({
      attempted: true,
      initialCacheStatus: "hit",
    });
  });

  it("refreshes a pre-13:33 cache hit even when it already contains the expected-date bar", async () => {
    const afterGuard = "2026-08-28T05:34:00.000Z";
    let clock = new Date("2026-08-28T05:32:59.000Z");
    const dynamicNow = () => new Date(clock.getTime());
    const earlyRow = [...ROW_2026_08_28];
    earlyRow[6] = "2,415.00";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(twseMonth([earlyRow])))
      .mockResolvedValueOnce(response(twseMonth([ROW_2026_08_28])));
    const exactPrice = new PriceClient(
      fetchMock as typeof fetch,
      dynamicNow,
      noMasterDependency(),
      { maxAttempts: 1, retryDelayMs: 0 },
    );
    const early = await exactPrice.getExactCurrentCompanyOhlc({
      company: COMPLETED_CLOSE_COMPANY,
      date: "2026-08-28",
    });
    expect(early.bars[0]?.close).toBe(2_415);
    expect(early.source.retrievedAt).toBe("2026-08-28T05:32:59.000Z");

    clock = new Date(afterGuard);
    const result = await new AuthoritativeCompletedCloseClient(
      resolver(completedCloseResolverEvidenceFixture({
        evaluatedAt: afterGuard,
      })),
      exactPrice,
      dynamicNow,
    ).getLatestCompletedClose({
      company: COMPLETED_CLOSE_COMPANY,
      evaluatedAt: afterGuard,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.close).toBe(2_420);
    expect(result.source.retrievedAt).toBe(afterGuard);
    expect(result.cacheRefresh).toEqual({
      attempted: true,
      initialCacheStatus: "hit",
    });
  });

  it("fails closed after the one cache refresh when the expected bar is still absent", async () => {
    const fetchMock = vi.fn(async () =>
      response(twseMonth([ROW_2026_08_27])),
    );
    const exactPrice = new PriceClient(
      fetchMock as typeof fetch,
      now,
      noMasterDependency(),
      { maxAttempts: 1, retryDelayMs: 0 },
    );
    await exactPrice.getExactCurrentCompanyOhlc({
      company: COMPLETED_CLOSE_COMPANY,
      date: "2026-08-27",
    });
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      exactPrice,
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "NO_DATA",
      reason: "COMPLETED_CLOSE_EXACT_BAR_NOT_FOUND",
      retryable: true,
      action: "retry",
      details: {
        expectedAsOf: "2026-08-28",
        cacheRefreshAttempted: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an unverified official empty snapshot as retryable", async () => {
    const exactPrice = new PriceClient(
      vi.fn(async () =>
        response({ stat: "很抱歉，沒有符合條件的資料!" }),
      ) as typeof fetch,
      now,
      noMasterDependency(),
      { maxAttempts: 1, retryDelayMs: 0 },
    );
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      exactPrice,
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "EXACT_STOCK_OHLC_SNAPSHOT_UNVERIFIED",
      retryable: true,
      action: "retry",
    });
  });

  it("accepts the exact TPEx single-stock endpoint identity", async () => {
    const company = {
      code: "3105",
      shortName: "穩懋",
      market: "otc",
      exchange: "TPEx",
    } as const;
    const evidence = completedCloseResolverEvidenceFixture();
    evidence.markets = ["otc"];
    evidence.marketResolutions[0] = {
      ...evidence.marketResolutions[0],
      market: "otc",
      sources: evidence.marketResolutions[0].sources.map((source) => ({
        ...source,
        market: "otc" as const,
        exchange: "TPEx" as const,
      })),
    };
    const exact = exactCurrentCompanyOhlcFixture({
      observedName: company.shortName,
      bars: [completedCloseBar({ market: "otc" })],
    });
    exact.query.companyCode = company.code;
    exact.query.market = "otc";
    exact.companyCode = company.code;
    exact.market = "otc";
    exact.source.market = "otc";
    exact.source.sourceUrl =
      "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=3105&date=2026%2F08%2F01&response=json";
    const client = new AuthoritativeCompletedCloseClient(
      resolver(evidence),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({ company, evaluatedAt: EVALUATED_AT }),
    ).resolves.toMatchObject({
      company,
      close: 2_420,
      source: {
        companyCode: "3105",
        market: "otc",
        exchange: "TPEx",
      },
    });
  });

  it("fails closed on unresolved resolver evidence without touching OHLC", async () => {
    const completedResolver = resolver(
      completedCloseResolverEvidenceFixture({ status: "unresolved" }),
    );
    const exactOhlc = {
      getExactCurrentCompanyOhlc: vi.fn(),
    };
    const client = new AuthoritativeCompletedCloseClient(
      completedResolver,
      exactOhlc,
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_SESSION_UNRESOLVED",
      retryable: true,
      action: "retry",
    });
    expect(completedResolver.resolve).toHaveBeenCalledTimes(1);
    expect(exactOhlc.getExactCurrentCompanyOhlc).not.toHaveBeenCalled();
  });

  it("rejects an exact dependency whose selected bar date differs from resolver expectedAsOf", async () => {
    const exact = exactCurrentCompanyOhlcFixture({
      date: "2026-08-28",
      bars: [completedCloseBar({ date: "2026-08-27", close: 2_410 })],
    });
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_CLOSE_EXACT_BAR_AMBIGUOUS",
      retryable: false,
      details: {
        expectedAsOf: "2026-08-28",
        selectedBarDate: "2026-08-27",
      },
    });
  });

  it.each([
    {
      label: "no-trade bar",
      bar: completedCloseBar({
        open: null,
        high: null,
        low: null,
        close: null,
        status: "no_trade",
        qualityStatus: "official_no_trade",
        missingFields: ["open", "high", "low", "close"],
      }),
    },
    {
      label: "zero close",
      bar: completedCloseBar({ close: 0 }),
    },
  ])("fails closed on $label", async ({ bar }) => {
    const exact = exactCurrentCompanyOhlcFixture({ bars: [bar] });
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "NO_DATA",
      reason: "COMPLETED_CLOSE_VALUE_UNAVAILABLE",
      retryable: false,
      action: "none",
    });
  });

  it("rejects a wrong-market bar as a non-retryable identity mismatch", async () => {
    const exact = exactCurrentCompanyOhlcFixture({
      bars: [completedCloseBar({ market: "otc" })],
    });
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_CLOSE_BAR_MARKET_MISMATCH",
      retryable: false,
      action: "none",
    });
  });

  it.each([
    {
      label: "wrong upstream name",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        observedName: "聯發科",
      }),
    },
    {
      label: "wrong source month",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        source: { ...value.source, dataMonth: "2026-07" },
      }),
    },
    {
      label: "wrong official source company code",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        source: {
          ...value.source,
          sourceUrl: value.source.sourceUrl.replace(
            "stockNo=2330",
            "stockNo=2317",
          ),
        },
      }),
    },
    {
      label: "wrong official source request month",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        source: {
          ...value.source,
          sourceUrl: value.source.sourceUrl.replace(
            "date=20260801",
            "date=20260701",
          ),
        },
      }),
    },
    {
      label: "non-official source host",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        source: {
          ...value.source,
          sourceUrl: value.source.sourceUrl.replace(
            "www.twse.com.tw",
            "example.com",
          ),
        },
      }),
    },
    {
      label: "unverified source identity",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        source: {
          ...value.source,
          snapshotIdentity: "unverified_empty",
        },
      }) as unknown as ExactCurrentCompanyOhlcResult,
    },
    {
      label: "incomplete exact coverage",
      mutate: (value: ExactCurrentCompanyOhlcResult) => ({
        ...value,
        coverageComplete: false,
      }) as unknown as ExactCurrentCompanyOhlcResult,
    },
  ])("rejects $label", async ({ mutate }) => {
    const exact = mutate(exactCurrentCompanyOhlcFixture());
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_CLOSE_IDENTITY_MISMATCH",
    });
  });

  it("rejects duplicate exact-date bars", async () => {
    const bar: OhlcBar = completedCloseBar();
    const exact = exactCurrentCompanyOhlcFixture({
      bars: [bar, { ...bar }],
    });
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_CLOSE_EXACT_BAR_AMBIGUOUS",
      retryable: false,
    });
  });

  it("rejects an injected source retrieved before the expected session completion", async () => {
    const exact = exactCurrentCompanyOhlcFixture();
    exact.source.retrievedAt = "2026-08-28T05:32:59.000Z";
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_CLOSE_SOURCE_PRECEDES_SESSION_COMPLETION",
      retryable: true,
      action: "retry",
    });
  });

  it("rejects cache-refresh evidence that was not triggered by an initial hit", async () => {
    const exact = exactCurrentCompanyOhlcFixture({
      cacheRefreshAttempted: true,
    });
    exact.cacheRefresh.initialCacheStatus = "miss";
    const client = new AuthoritativeCompletedCloseClient(
      resolver(),
      { getExactCurrentCompanyOhlc: vi.fn(async () => exact) },
      now,
    );

    await expect(
      client.getLatestCompletedClose({
        company: COMPLETED_CLOSE_COMPANY,
        evaluatedAt: EVALUATED_AT,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_CLOSE_CACHE_REFRESH_MISMATCH",
      retryable: false,
    });
  });
});
