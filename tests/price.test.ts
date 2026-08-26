import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CompanyMasterResult, MasterCompany } from "@/lib/company-master/types";
import {
  dailyMarketOhlcOutputSchema,
  stockOhlcOutputSchema,
} from "@/lib/mcp/schemas";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import { PriceClient } from "@/lib/price/client";

function response(payload: unknown, status = 200) {
  return new Response(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function company(
  code: string,
  shortName: string,
  market: "listed" | "otc",
  listingDate: string,
): MasterCompany {
  return {
    code,
    name: `${shortName}股份有限公司`,
    shortName,
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

function master(companies: MasterCompany[]) {
  return {
    listCompanies: vi.fn().mockResolvedValue({
      query: { market: "all", includeFinancial: true, includeKy: true },
      generatedAt: "2026-08-25T00:00:00.000Z",
      snapshotId: "test",
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
        financialReportTypeCode: { reported: 0, missing: companies.length, invalid: 0 },
      },
      companies,
      warnings: [],
    } satisfies CompanyMasterResult),
  };
}

function twseMonth(
  code: string,
  name: string,
  rows: string[][],
  titleMonth = "104年01月",
) {
  return {
    stat: "OK",
    title: `${titleMonth} ${code} ${name} 各日成交資訊`,
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

function tpexMonth(code: string, name: string, rows: string[][], date = "20150101") {
  return {
    date,
    code,
    name,
    stat: "ok",
    tables: [
      {
        totalCount: rows.length,
        fields: [
          "日 期",
          "成交張數",
          "成交仟元",
          "開盤",
          "最高",
          "最低",
          "收盤",
          "漲跌",
          "筆數",
        ],
        data: rows,
      },
    ],
  };
}

const now = () => new Date("2026-08-25T08:00:00.000Z");

describe("PriceClient getStockOhlc", () => {
  it("merges an OTC-to-listed transfer month without losing either market", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "www.twse.com.tw") {
        return response(
          twseMonth("3416", "融程電", [
            ["104/01/23", "387,756", "24,621,876", "64.30", "64.50", "62.10", "63.90", "X0.00", "274", ""],
            ["104/01/30", "77,772", "4,763,192", "61.40", "61.60", "61.00", "61.00", "-0.10", "51", ""],
          ]),
        );
      }
      return response(
        tpexMonth("3416", "融程電", [
          ["104/01/05", "102", "6,331", "61.90", "62.00", "61.60", "61.90", "0.20", "72"],
          ["104/01/22", "535", "34,096", "62.00", "65.00", "62.00", "63.80", "2.10", "388"],
        ]),
      );
    });
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("3416", "融程電", "listed", "2015-01-23")]),
      { retryDelayMs: 0 },
    );

    const result = await client.getStockOhlc({
      companyCode: "3416",
      startDate: "2015-01-01",
      endDate: "2015-01-31",
    });

    expect(result.bars.map((bar) => [bar.date, bar.market])).toEqual([
      ["2015-01-05", "otc"],
      ["2015-01-22", "otc"],
      ["2015-01-23", "listed"],
      ["2015-01-30", "listed"],
    ]);
    expect(result.coverage).toMatchObject({
      coveredThrough: "2015-01-31",
      coverageComplete: true,
      nextCursor: null,
    });
    expect(result.dataQualityComplete).toBe(true);
    expect(result.bars[0]).toMatchObject({
      volumeShares: 102_000,
      turnoverTwd: 6_331_000,
      tradeCount: 72,
      change: 0.2,
      changeMarker: null,
      qualityStatus: "complete",
      missingFields: [],
    });
    expect(result.bars[2]).toMatchObject({
      volumeShares: 387_756,
      turnoverTwd: 24_621_876,
      tradeCount: 274,
      change: 0,
      changeMarker: "X",
      qualityStatus: "complete",
    });
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          market: "otc",
          normalization: {
            volumeShares: {
              sourceUnit: "lot",
              outputUnit: "share",
              multiplier: 1000,
            },
            turnoverTwd: {
              sourceUnit: "TWD_thousand",
              outputUnit: "TWD",
              multiplier: 1000,
            },
            tradeCount: {
              sourceUnit: "trade",
              outputUnit: "trade",
              multiplier: 1,
            },
          },
        }),
      ]),
    );
    expect(
      stockOhlcOutputSchema.safeParse({ ok: true, meta: buildResultMeta(result), ...result }).success,
    ).toBe(true);
  });

  it("parses reordered TWSE headers instead of relying on fixed indexes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        stat: "OK",
        title: "115年01月 2330 台積電 各日成交資訊",
        fields: [
          "收盤價",
          "日期",
          "成交筆數",
          "最高價",
          "成交金額",
          "最低價",
          "註記",
          "成交股數",
          "漲跌價差",
          "開盤價",
        ],
        data: [
          [
            "1,585.00",
            "115/01/02",
            "100",
            "1,585.00",
            "1,000,000",
            "1,545.00",
            "",
            "1,000",
            "+35.00",
            "1,555.00",
          ],
        ],
      }),
    );
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    const result = await client.getStockOhlc({
      companyCode: "2330",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });

    expect(result.bars[0]).toMatchObject({
      date: "2026-01-02",
      open: 1555,
      high: 1585,
      low: 1545,
      close: 1585,
      volumeShares: 1000,
      turnoverTwd: 1_000_000,
      tradeCount: 100,
      change: 35,
      qualityStatus: "complete",
    });
  });

  it("rejects official monthly payloads whose declared row count is truncated", async () => {
    const listedPayload = twseMonth("2330", "台積電", [
      [
        "115/01/02",
        "1,000",
        "1,000,000",
        "1,555.00",
        "1,585.00",
        "1,545.00",
        "1,585.00",
        "+35.00",
        "100",
        "",
      ],
    ]);
    listedPayload.total = 2;
    const otcPayload = tpexMonth("3105", "穩懋", [
      [
        "115/01/02",
        "10",
        "3,550",
        "370.50",
        "372.50",
        "355.00",
        "355.00",
        "-18.00",
        "300",
      ],
    ]);
    otcPayload.tables[0].totalCount = 2;

    for (const fixture of [
      {
        market: "listed" as const,
        code: "2330",
        name: "台積電",
        payload: listedPayload,
      },
      {
        market: "otc" as const,
        code: "3105",
        name: "穩懋",
        payload: otcPayload,
      },
    ]) {
      const client = new PriceClient(
        vi.fn().mockResolvedValue(response(fixture.payload)) as typeof fetch,
        now,
        master([
          company(fixture.code, fixture.name, fixture.market, "1994-09-05"),
        ]),
        { retryDelayMs: 0 },
      );
      await expect(
        client.getStockOhlc({
          companyCode: fixture.code,
          startDate: "2026-01-01",
          endDate: "2026-01-31",
        }),
      ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
    }
  });

  it("uses a scope-bound month cursor to finish an arbitrary cross-year range", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const date = url.searchParams.get("date") as string;
      const isDecember = date.startsWith("202512");
      return response(
        twseMonth(
          "2330",
          "台積電",
          [
            [
              isDecember ? "114/12/31" : "115/01/02",
              "1,000",
              "1,000,000",
              isDecember ? "1,520.00" : "1,555.00",
              isDecember ? "1,550.00" : "1,585.00",
              isDecember ? "1,515.00" : "1,545.00",
              isDecember ? "1,550.00" : "1,585.00",
              "+1.00",
              "100",
              "",
            ],
          ],
          isDecember ? "114年12月" : "115年01月",
        ),
      );
    });
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0, monthsPerPage: 1 },
    );
    const query = {
      companyCode: "2330",
      startDate: "2025-12-27",
      endDate: "2026-01-06",
    };

    const first = await client.getStockOhlc(query);
    expect(first.bars.map((bar) => bar.date)).toEqual(["2025-12-31"]);
    expect(first.sources.map((source) => source.dataMonth)).toEqual(["2025-12"]);
    expect(first.coverage.coverageComplete).toBe(false);
    expect(first.coverage.nextCursor).toBeTruthy();

    const second = await client.getStockOhlc({
      ...query,
      cursor: first.coverage.nextCursor as string,
    });
    expect(second.bars.map((bar) => bar.date)).toEqual(["2026-01-02"]);
    expect(second.sources.map((source) => source.dataMonth)).toEqual(["2026-01"]);
    expect(second.coverage).toMatchObject({
      coveredThrough: "2026-01-06",
      coverageComplete: true,
      nextCursor: null,
    });

    await expect(
      client.getStockOhlc({
        ...query,
        endDate: "2026-01-07",
        cursor: first.coverage.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "CURSOR_INVALID",
      category: "pagination",
      action: "restart_pagination",
    });
    const cursor = first.coverage.nextCursor as string;
    await expect(
      client.getStockOhlc({
        ...query,
        cursor: `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const invalidMonthBody = Buffer.from(
      JSON.stringify({
        version: 1,
        companyCode: query.companyCode,
        startDate: query.startDate,
        endDate: query.endDate,
        nextMonth: "2025-13",
        sawData: false,
      }),
    ).toString("base64url");
    const invalidMonthChecksum = createHash("sha256")
      .update(`mopsfin-price-cursor-v1:${invalidMonthBody}`)
      .digest("base64url")
      .slice(0, 16);
    await expect(
      client.getStockOhlc({
        ...query,
        cursor: `ohlc1.${invalidMonthBody}.${invalidMonthChecksum}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("keeps a distinct source cutoff for every requested stock month", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const isDecember = (url.searchParams.get("date") as string).startsWith(
        "202512",
      );
      return response(
        twseMonth(
          "2330",
          "台積電",
          [
            [
              isDecember ? "114/12/31" : "115/01/02",
              "1,000",
              "1,000,000",
              "100",
              "101",
              "99",
              "100",
              "+1",
              "10",
              "",
            ],
          ],
          isDecember ? "114年12月" : "115年01月",
        ),
      );
    });
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    const result = await client.getStockOhlc({
      companyCode: "2330",
      startDate: "2025-12-01",
      endDate: "2026-01-31",
    });

    expect(result.sources.map((source) => source.dataMonth)).toEqual([
      "2025-12",
      "2026-01",
    ]);
    expect(result.sources).toHaveLength(2);
  });

  it("probes both markets for a delisted code that is absent from current master", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "www.twse.com.tw") {
        return response(
          twseMonth("2475", "華映", [
            ["107/01/02", "3,302,439", "7,768,647", "2.32", "2.37", "2.32", "2.33", "+0.02", "278", ""],
          ], "107年01月"),
        );
      }
      return response(tpexMonth("2475", "", [], "20180101"));
    });
    const client = new PriceClient(fetchMock as typeof fetch, now, master([]), {
      retryDelayMs: 0,
    });

    const result = await client.getStockOhlc({
      companyCode: "2475",
      startDate: "2018-01-01",
      endDate: "2018-01-31",
    });

    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({
      date: "2018-01-02",
      market: "listed",
      close: 2.33,
    });
  });

  it("preserves official no-trade dates as null OHLC instead of zero", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        tpexMonth("5301", "寶得利", [
          ["83/01/05", "0", "0", "--", "--", "--", "--", "0.00", "0"],
        ], "19940101"),
      ),
    );
    const client = new PriceClient(fetchMock as typeof fetch, now, master([]), {
      retryDelayMs: 0,
    });

    const result = await client.getStockOhlc({
      companyCode: "5301",
      startDate: "1994-01-01",
      endDate: "1994-01-31",
    });

    expect(result.bars[0]).toMatchObject({
      date: "1994-01-05",
      open: null,
      high: null,
      low: null,
      close: null,
      status: "no_trade",
      volumeShares: 0,
      turnoverTwd: 0,
      tradeCount: 0,
      change: 0,
      qualityStatus: "official_no_trade",
      missingFields: ["open", "high", "low", "close"],
    });
    expect(result.dataQualityComplete).toBe(true);
  });

  it("rejects conflicting normalized rows when a transfer month overlaps", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "www.twse.com.tw") {
        return response(
          twseMonth("3416", "融程電", [
            [
              "104/01/22",
              "102,000",
              "6,332,000",
              "61.90",
              "62.00",
              "61.60",
              "61.90",
              "+0.20",
              "72",
              "",
            ],
          ]),
        );
      }
      return response(
        tpexMonth("3416", "融程電", [
          [
            "104/01/22",
            "102",
            "6,331",
            "61.90",
            "62.00",
            "61.60",
            "61.90",
            "0.20",
            "72",
          ],
        ]),
      );
    });
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("3416", "融程電", "listed", "2015-01-23")]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getStockOhlc({
        companyCode: "3416",
        startDate: "2015-01-01",
        endDate: "2015-01-31",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it("deduplicates an identical cross-market overlap using the current market", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "www.twse.com.tw") {
        return response(
          twseMonth("3416", "融程電", [
            [
              "104/01/22",
              "102,000",
              "6,331,000",
              "61.90",
              "62.00",
              "61.60",
              "61.90",
              "+0.20",
              "72",
              "",
            ],
          ]),
        );
      }
      return response(
        tpexMonth("3416", "融程電", [
          [
            "104/01/22",
            "102",
            "6,331",
            "61.90",
            "62.00",
            "61.60",
            "61.90",
            "0.20",
            "72",
          ],
        ]),
      );
    });
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("3416", "融程電", "listed", "2015-01-23")]),
      { retryDelayMs: 0 },
    );

    const result = await client.getStockOhlc({
      companyCode: "3416",
      startDate: "2015-01-01",
      endDate: "2015-01-31",
    });

    expect(result.bars).toHaveLength(1);
    expect(result.bars[0]).toMatchObject({
      date: "2015-01-22",
      market: "listed",
      volumeShares: 102_000,
      turnoverTwd: 6_331_000,
    });
  });

  it("retries a transient non-JSON 520 body before accepting official JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("error code: 520"))
      .mockResolvedValueOnce(
        response(
          twseMonth("2330", "台積電", [
            ["115/01/02", "1,000", "1,000,000", "1,555.00", "1,585.00", "1,545.00", "1,585.00", "+35.00", "100", ""],
          ], "115年01月"),
        ),
      );
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    const result = await client.getStockOhlc({
      companyCode: "2330",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });

    expect(result.bars).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported TWSE history and future ranges", async () => {
    const client = new PriceClient(
      vi.fn() as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getStockOhlc({
        companyCode: "2330",
        startDate: "2009-12-01",
        endDate: "2009-12-31",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.getStockOhlc({
        companyCode: "2330",
        startDate: "2026-08-01",
        endDate: "2030-01-01",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("PriceClient getDailyMarketOhlc", () => {
  const twseDaily = {
    stat: "OK",
    date: "20260824",
    tables: [
      {
        fields: ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌(+/-)", "漲跌價差"],
        data: [
          ["0050", "元大台灣50", "1", "1", "1", "100", "101", "99", "100", "+", "1"],
          ["2330", "台積電", "2,000", "20", "4,750,000", "2410", "2410", "2375", "2375", "<p style= color:green>-</p>", "35"],
          ["9103", "美德醫療-DR", "1", "1", "1", "5", "5", "5", "5", "+", "0"],
        ],
      },
    ],
  };
  const tpexDaily = {
    stat: "ok",
    date: "20260824",
    tables: [
      {
        totalCount: 2,
        fields: ["代號", "名稱", "收盤", "漲跌", "開盤", "最高", "最低", "成交股數", "成交金額(元)", "成交筆數"],
        data: [
          ["006201", "元大富櫃50", "42.57", "-0.03", "42.61", "43.38", "42.57", "146,506", "6,277,302", "279"],
          ["3105", "穩懋", "355.00", "-18.00", "370.50", "372.50", "355.00", "10,000", "3,550,000", "300"],
        ],
      },
    ],
  };

  it("returns a complete historical all-market company snapshot", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return response(url.hostname === "www.twse.com.tw" ? twseDaily : tpexDaily);
    });
    const client = new PriceClient(fetchMock as typeof fetch, now, master([]), {
      retryDelayMs: 0,
    });

    const result = await client.getDailyMarketOhlc({
      market: "all",
      date: "2026-08-24",
    });

    expect(result.coverageComplete).toBe(true);
    expect(result.classificationMethod).toBe("historical_code_rule");
    expect(result.classificationPolicy).toBe("historical_code_rule");
    expect(result.universeCoverageVerified).toBe(false);
    expect(result.reconciliation).toEqual([]);
    expect(result.dataQualityComplete).toBe(true);
    expect(result.bars.map((bar) => bar.code)).toEqual(["2330", "3105"]);
    expect(result.counts).toEqual({ listed: 1, otc: 1, returned: 2 });
    expect(result.bars).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2330",
          volumeShares: 2000,
          turnoverTwd: 4_750_000,
          tradeCount: 20,
          change: -35,
          changeMarker: null,
          qualityStatus: "complete",
        }),
        expect.objectContaining({
          code: "3105",
          volumeShares: 10_000,
          turnoverTwd: 3_550_000,
          tradeCount: 300,
          change: -18,
          qualityStatus: "complete",
        }),
      ]),
    );
    expect(
      dailyMarketOhlcOutputSchema.safeParse({ ok: true, meta: buildResultMeta(result), ...result }).success,
    ).toBe(true);
  });

  it("filters latest data through current master and reports missing selections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response([
        {
          Date: "1150824",
          Code: "2330",
          Name: "台積電",
          OpeningPrice: "2410.00",
          HighestPrice: "2410.00",
          LowestPrice: "2375.00",
          ClosingPrice: "2375.00",
        },
        {
          Date: "1150824",
          Code: "0050",
          Name: "元大台灣50",
          OpeningPrice: "100.00",
          HighestPrice: "101.00",
          LowestPrice: "99.00",
          ClosingPrice: "100.00",
        },
      ]),
    );
    const client = new PriceClient(
      fetchMock as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketOhlc({
      market: "listed",
      date: "latest",
      companyCodes: ["2330", "9999"],
    });

    expect(result.bars.map((bar) => bar.code)).toEqual(["2330"]);
    expect(result.selectionComplete).toBe(false);
    expect(result.missingCompanyCodes).toEqual(["9999"]);
    expect(result.classificationMethod).toBe("current_master");
    expect(result.classificationPolicy).toBe(
      "current_master_with_code_fallback",
    );
    expect(result.query.universePolicy).toBe("compatible");
    expect(result.universeCoverageVerified).toBe(true);
    expect(result.reconciliation).toEqual([
      {
        market: "listed",
        masterCount: 1,
        sourceRowCount: 1,
        matchedCount: 1,
        marketOnlyCodes: [],
        masterMissingCodes: [],
        matchRatio: 1,
        coverageComplete: true,
      },
    ]);
    expect(result.dataQualityComplete).toBe(false);
    expect(result.bars[0]).toMatchObject({
      volumeShares: null,
      turnoverTwd: null,
      tradeCount: null,
      change: null,
      qualityStatus: "partial",
      missingFields: [
        "volumeShares",
        "turnoverTwd",
        "tradeCount",
        "change",
      ],
    });
    expect(
      dailyMarketOhlcOutputSchema.safeParse({ ok: true, meta: buildResultMeta(result), ...result }).success,
    ).toBe(true);
  });

  it("supports exact strict-master reconciliation and rejects any mismatch", async () => {
    const payload = [
      {
        Date: "1150824",
        Code: "2330",
        Name: "台積電",
        TradeVolume: "2,000",
        TradeValue: "4,750,000",
        OpeningPrice: "2410.00",
        HighestPrice: "2410.00",
        LowestPrice: "2375.00",
        ClosingPrice: "2375.00",
        Change: "-35.00",
        Transaction: "20",
      },
      {
        Date: "1150824",
        Code: "9999",
        Name: "新公司",
        TradeVolume: "1,000",
        TradeValue: "100,000",
        OpeningPrice: "100",
        HighestPrice: "100",
        LowestPrice: "100",
        ClosingPrice: "100",
        Change: "+1",
        Transaction: "10",
      },
    ];
    const exactClient = new PriceClient(
      vi.fn().mockResolvedValue(response(payload.slice(0, 1))) as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    const exact = await exactClient.getDailyMarketOhlc({
      market: "listed",
      date: "latest",
      universePolicy: "strict_current_master",
    });
    expect(exact.classificationPolicy).toBe("current_master_strict");
    expect(exact.query.universePolicy).toBe("strict_current_master");
    expect(exact.universeCoverageVerified).toBe(true);
    expect(exact.dataQualityComplete).toBe(true);
    expect(exact.reconciliation[0]).toMatchObject({
      matchRatio: 1,
      coverageComplete: true,
      marketOnlyCodes: [],
      masterMissingCodes: [],
    });

    const mismatchClient = new PriceClient(
      vi.fn().mockResolvedValue(response(payload)) as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );
    await expect(
      mismatchClient.getDailyMarketOhlc({
        market: "listed",
        date: "latest",
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({
      code: "INCOMPLETE_COVERAGE",
      details: {
        universePolicy: "strict_current_master",
        reconciliation: [
          expect.objectContaining({
            marketOnlyCodes: ["9999"],
            coverageComplete: false,
          }),
        ],
      },
    });
  });

  it("keeps compatible master-only fallback but rejects low master coverage", async () => {
    const onlyFallbackPayload = [
      {
        Date: "1150824",
        Code: "9999",
        Name: "新公司",
        TradeVolume: "1,000",
        TradeValue: "100,000",
        OpeningPrice: "100",
        HighestPrice: "100",
        LowestPrice: "100",
        ClosingPrice: "100",
        Change: "+1",
        Transaction: "10",
      },
    ];
    const client = new PriceClient(
      vi.fn().mockResolvedValue(response(onlyFallbackPayload)) as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketOhlc({
        market: "listed",
        date: "latest",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "INCOMPLETE_COVERAGE" });

    const fallbackClient = new PriceClient(
      vi.fn().mockResolvedValue(
        response([
          {
            ...onlyFallbackPayload[0],
            Code: "2330",
            Name: "台積電",
          },
          onlyFallbackPayload[0],
        ]),
      ) as typeof fetch,
      now,
      master([company("2330", "台積電", "listed", "1994-09-05")]),
      { retryDelayMs: 0 },
    );
    const fallback = await fallbackClient.getDailyMarketOhlc({
      market: "listed",
      date: "latest",
      companyCodes: ["9999"],
    });
    expect(fallback.bars.map((bar) => bar.code)).toEqual(["9999"]);
    expect(fallback.reconciliation[0]).toMatchObject({
      marketOnlyCodes: ["9999"],
      matchRatio: 1,
      coverageComplete: false,
    });
    expect(fallback.universeCoverageVerified).toBe(false);
    expect(fallback.warnings.join(" ")).toContain("compatible");
  });

  it("rejects strict current-master policy for historical dates and duplicates", async () => {
    const client = new PriceClient(vi.fn() as typeof fetch, now, master([]), {
      retryDelayMs: 0,
    });

    await expect(
      client.getDailyMarketOhlc({
        market: "listed",
        date: "2026-08-24",
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.getDailyMarketOhlc({
        market: "listed",
        date: "latest",
        companyCodes: ["2330", "2330"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects mixed latest source dates and historical dates before market support", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.hostname === "openapi.twse.com.tw") {
        return response([
          {
            Date: "1150824",
            Code: "2330",
            Name: "台積電",
            OpeningPrice: "1",
            HighestPrice: "1",
            LowestPrice: "1",
            ClosingPrice: "1",
          },
        ]);
      }
      return response([
        {
          Date: "1150825",
          SecuritiesCompanyCode: "3105",
          CompanyName: "穩懋",
          Open: "1",
          High: "1",
          Low: "1",
          Close: "1",
        },
      ]);
    });
    const client = new PriceClient(fetchMock as typeof fetch, now, master([]), {
      retryDelayMs: 0,
    });

    await expect(
      client.getDailyMarketOhlc({ market: "all", date: "latest" }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
    await expect(
      client.getDailyMarketOhlc({ market: "all", date: "2007-04-22" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
