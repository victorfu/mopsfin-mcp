import { describe, expect, it, vi } from "vitest";

import type { CompanyMasterResult, MasterCompany } from "@/lib/company-master/types";
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
    expect(first.coverage.coverageComplete).toBe(false);
    expect(first.coverage.nextCursor).toBeTruthy();

    const second = await client.getStockOhlc({
      ...query,
      cursor: first.coverage.nextCursor as string,
    });
    expect(second.bars.map((bar) => bar.date)).toEqual(["2026-01-02"]);
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
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const cursor = first.coverage.nextCursor as string;
    await expect(
      client.getStockOhlc({
        ...query,
        cursor: `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
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
        fields: ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價"],
        data: [
          ["0050", "元大台灣50", "1", "1", "1", "100", "101", "99", "100"],
          ["2330", "台積電", "1", "1", "1", "2410", "2410", "2375", "2375"],
          ["9103", "美德醫療-DR", "1", "1", "1", "5", "5", "5", "5"],
        ],
      },
    ],
  };
  const tpexDaily = {
    stat: "ok",
    date: "20260824",
    tables: [
      {
        fields: ["代號", "名稱", "收盤", "漲跌", "開盤", "最高", "最低"],
        data: [
          ["006201", "元大富櫃50", "42.57", "-0.03", "42.61", "43.38", "42.57"],
          ["3105", "穩懋", "355.00", "-18.00", "370.50", "372.50", "355.00"],
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
    expect(result.bars.map((bar) => bar.code)).toEqual(["2330", "3105"]);
    expect(result.counts).toEqual({ listed: 1, otc: 1, returned: 2 });
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
