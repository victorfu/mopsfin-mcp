import { describe, expect, it, vi } from "vitest";

import {
  CompletedSessionResolver,
  normalizeTpexTradingCalendar,
  normalizeTwseTradingCalendar,
  OfficialTradingCalendarClient,
  type OfficialTradingCalendar,
} from "@/lib/freshness/completed-session-resolver";
import type { JsonSnapshot } from "@/lib/market-data/client-utils";
import type { BenchmarkHistory } from "@/lib/reaction/types";
import { completedSessionResolverEvidenceSchema } from "@/lib/mcp/schema/common";
import { OfficialJsonPostLoader } from "@/lib/freshness/official-json-post-loader";

const CACHE = {
  status: "miss" as const,
  observedAt: "2026-08-28T07:00:00.000Z",
  storedAt: "2026-08-28T07:00:00.000Z",
  ageMs: 0,
  ttlMs: 300_000,
};

function twsePayload(year = 2026) {
  return {
    stat: "ok",
    date: `${year}0101`,
    title: `${year - 1911} 年市場開休市日期`,
    fields: ["日期", "名稱", "說明"],
    data: [
      [`${year}-01-01`, "中華民國開國紀念日", "依規定放假1日。"],
      [`${year}-01-02`, "國曆新年開始交易日", "國曆新年開始交易。"],
      [`${year}-02-11`, "農曆春節前最後交易日", "農曆春節前最後交易。"],
      [`${year}-02-12`, "市場無交易，僅辦理結算交割作業", ""],
      [`${year}-02-13`, "市場無交易，僅辦理結算交割作業", ""],
      [`${year}-02-20`, "農曆除夕及春節", "依規定放假1日。"],
      [`${year}-02-23`, "農曆春節後開始交易日", "開始交易。"],
      [`${year}-02-27`, "和平紀念日", "於2月27日（星期五）補假。"],
      [
        `${year}-04-05`,
        "民族掃墓節",
        "4月6日調整放假，4月14日補行開市交易。",
      ],
      [`${year}-09-26`, "補行開市交易日", "補行開市交易。"],
    ],
    queryYear: year,
    total: 10,
  };
}

function twseSnapshot(payload = twsePayload()): JsonSnapshot {
  return {
    payload,
    retrievedAt: "2026-08-28T07:00:00.000Z",
    cache: CACHE,
  };
}

function tpexHtml(year = 2026): string {
  const roc = year - 1911;
  return `
    <table><tr><td>中華民國${roc}年有價證券櫃檯買賣市場開（休）市日期表</td></tr></table>
    <table>
      <tr><th>紀念節日名稱</th><th>日期</th><th>星期</th><th>說明</th></tr>
      <tr><td>中華民國開國紀念日</td><td>1月1日</td><td>四</td><td>依規定放假1日。</td></tr>
      <tr><td>國曆新年開始交易日</td><td>1月2日</td><td>五</td><td>國曆新年開始交易。</td></tr>
      <tr><td>農曆春節前國際債券交易系統最後交易日</td><td>2月10日</td><td>二</td><td>2月11日、2月12日及2月13日市場無交易。</td></tr>
      <tr><td>農曆春節前股票交易系統最後交易日</td><td rowspan="2">2月11日</td><td rowspan="2">三</td><td rowspan="2">2月12日及2月13日市場無交易。</td></tr>
      <tr><td>農曆春節前債券等殖成交系統最後交易日</td></tr>
      <tr><td rowspan="2">農曆除夕及春節</td><td>2月19日</td><td>四</td><td>依規定放假1日。</td></tr>
      <tr><td>2月20日</td><td>五</td><td>依規定放假1日。</td></tr>
      <tr><td>農曆春節後開始交易日</td><td>2月23日</td><td>一</td><td>開始交易。</td></tr>
      <tr><td>和平紀念日</td><td>2月27日</td><td>五</td><td>於2月27日（星期五）補假。</td></tr>
      <tr><td>民族掃墓節</td><td>4月5日</td><td>四</td><td>4月6日調整放假，4月14日補行開市交易。</td></tr>
      <tr><td>fixture 連續休假</td><td>7月1日至7月3日</td><td>三至五</td><td>依規定放假。</td></tr>
      <tr><td>補行開市交易日</td><td>9月26日</td><td>六</td><td>補行開市交易。</td></tr>
    </table>`;
}

function tpexSnapshot(payload: unknown = {
  stat: "ok",
  endDate: "20260101",
  data: { html: tpexHtml() },
}) {
  return {
    payload,
    retrievedAt: "2026-08-28T07:00:00.000Z",
    cache: CACHE,
  };
}

function calendar(
  market: "listed" | "otc",
  rules: Array<[string, "open" | "closed"]> = [],
): OfficialTradingCalendar {
  return {
    market,
    year: 2026,
    rules: new Map(rules),
    source: {
      market,
      exchange: market === "listed" ? "TWSE" : "TPEx",
      sourceName: `${market} calendar`,
      sourceUrl:
        market === "listed"
          ? "https://www.twse.com.tw/holidaySchedule/holidaySchedule?queryYear=115&response=json"
          : "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate",
      retrievedAt: "2026-08-28T07:00:00.000Z",
      cache: CACHE,
      calendarYear: 2026,
      rowCount: rules.length,
    },
  };
}

function benchmark(
  market: "listed" | "otc",
  month: string,
  dates: string[],
): BenchmarkHistory {
  return {
    market,
    benchmarkCode: market === "listed" ? "TAIEX" : "TPEX_PRICE_INDEX",
    benchmarkName: market === "listed" ? "發行量加權股價指數" : "櫃買指數",
    priceBasis: "price_index",
    bars: dates.map((date, index) => ({ date, close: 100 + index })),
    sources: [
      {
        market,
        exchange: market === "listed" ? "TWSE" : "TPEx",
        benchmarkCode: market === "listed" ? "TAIEX" : "TPEX_PRICE_INDEX",
        benchmarkName: market === "listed" ? "發行量加權股價指數" : "櫃買指數",
        sourceName: `${market} benchmark`,
        sourceUrl:
          market === "listed"
            ? `https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?date=${month.replace("-", "")}01&response=json`
            : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex?date=${month.replace("-", "%2F")}%2F01&response=json`,
        dataMonth: month,
        retrievedAt: "2026-08-28T07:01:00.000Z",
        cache: CACHE,
        rowCount: dates.length,
      },
    ],
  };
}

describe("official trading calendar normalization", () => {
  it("normalizes TWSE closed days and explicit open/make-up markers", () => {
    const result = normalizeTwseTradingCalendar(
      twseSnapshot(),
      2026,
      "https://www.twse.com.tw/holidaySchedule/holidaySchedule?queryYear=115&response=json",
    );
    expect(result.rules.get("2026-02-11")).toBe("open");
    expect(result.rules.get("2026-02-12")).toBe("closed");
    expect(result.rules.get("2026-02-27")).toBe("closed");
    expect(result.rules.get("2026-04-05")).toBe("closed");
    expect(result.rules.get("2026-04-06")).toBe("closed");
    expect(result.rules.get("2026-04-14")).toBe("open");
    expect(result.rules.get("2026-09-26")).toBe("open");
  });

  it("rejects TWSE fallback-to-current-year and semantic drift", () => {
    expect(() =>
      normalizeTwseTradingCalendar(
        twseSnapshot({ ...twsePayload(), queryYear: 2025 }),
        2026,
        "https://www.twse.com.tw/holidaySchedule/holidaySchedule?queryYear=115&response=json",
      ),
    ).toThrow(/年度/);
    const payload = twsePayload();
    payload.data[0] = ["2026-01-01", "未知事件", "未知說明"];
    expect(() =>
      normalizeTwseTradingCalendar(twseSnapshot(payload), 2026, "https://www.twse.com.tw/calendar"),
    ).toThrow(/語意/);
  });

  it("normalizes TPEx rowspans, ignores bond-only rows, and keeps stock no-trade days", () => {
    const result = normalizeTpexTradingCalendar(
      tpexSnapshot(),
      2026,
      "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate",
    );
    expect(result.rules.get("2026-02-10")).toBeUndefined();
    expect(result.rules.get("2026-02-11")).toBe("open");
    expect(result.rules.get("2026-02-12")).toBe("closed");
    expect(result.rules.get("2026-02-13")).toBe("closed");
    expect(result.rules.get("2026-02-20")).toBe("closed");
    expect(result.rules.get("2026-02-27")).toBe("closed");
    expect(result.rules.get("2026-04-05")).toBe("closed");
    expect(result.rules.get("2026-04-06")).toBe("closed");
    expect(result.rules.get("2026-04-14")).toBe("open");
    expect(result.rules.get("2026-07-02")).toBe("closed");
    expect(result.rules.get("2026-09-26")).toBe("open");
  });

  it("rejects TPEx year and HTML contract drift", () => {
    expect(() =>
      normalizeTpexTradingCalendar(
        tpexSnapshot({
          stat: "ok",
          endDate: "20250101",
          data: { html: tpexHtml() },
        }),
        2026,
        "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate",
      ),
    ).toThrow(/endDate/);
    expect(() =>
      normalizeTpexTradingCalendar(
        tpexSnapshot({ stat: "ok", endDate: "20260101", data: { html: "<p>drift</p>" } }),
        2026,
        "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate",
      ),
    ).toThrow(/title/);
  });
});

describe("completed-session resolver", () => {
  function build(options: {
    calendars?: Partial<Record<"listed" | "otc", OfficialTradingCalendar>>;
    dates?: Partial<Record<"listed" | "otc", string[]>>;
  } = {}) {
    const getCalendar = vi.fn(async (market: "listed" | "otc") =>
      options.calendars?.[market] ?? calendar(market),
    );
    const getHistory = vi.fn(async (market: "listed" | "otc", months: string[]) =>
      benchmark(
        market,
        months[0],
        options.dates?.[market] ?? ["2026-08-27", "2026-08-28"],
      ),
    );
    return {
      resolver: new CompletedSessionResolver(
        fetch,
        () => new Date("2026-08-28T07:00:00.000Z"),
        {
          calendarClient: { getCalendar },
          benchmarkClient: { getHistory },
        },
      ),
      getCalendar,
      getHistory,
    };
  }

  it("uses the prior session before 13:33 and today's confirmed session at 13:33", async () => {
    const before = build();
    const beforeResult = await before.resolver.resolve({
      market: "listed",
      evaluatedAt: "2026-08-28T13:32:59+08:00",
    });
    expect(beforeResult).toMatchObject({
      status: "resolved",
      expectedAsOf: "2026-08-27",
      completionGuardTaipei: "13:33:00",
    });

    const atGuard = build();
    const atGuardResult = await atGuard.resolver.resolve({
      market: "listed",
      evaluatedAt: "2026-08-28T13:33:00+08:00",
    });
    expect(atGuardResult).toMatchObject({
      status: "resolved",
      expectedAsOf: "2026-08-28",
    });
  });

  it("handles a holiday/weekend and an explicit Saturday make-up session", async () => {
    const holidayCalendar = calendar("listed", [
      ["2026-08-28", "closed"],
      ["2026-08-29", "open"],
    ]);
    const holiday = build({
      calendars: { listed: holidayCalendar },
      dates: { listed: ["2026-08-27"] },
    });
    expect(
      await holiday.resolver.resolve({
        market: "listed",
        evaluatedAt: "2026-08-28T15:00:00+08:00",
      }),
    ).toMatchObject({ expectedAsOf: "2026-08-27" });

    const makeUp = build({
      calendars: { listed: holidayCalendar },
      dates: { listed: ["2026-08-27", "2026-08-29"] },
    });
    expect(
      await makeUp.resolver.resolve({
        market: "listed",
        evaluatedAt: "2026-08-29T13:33:00+08:00",
      }),
    ).toMatchObject({ expectedAsOf: "2026-08-29" });
  });

  it("fails closed when today's scheduled marker is absent", async () => {
    const { resolver } = build({ dates: { listed: ["2026-08-27"] } });
    expect(
      await resolver.resolve({
        market: "listed",
        evaluatedAt: "2026-08-28T15:00:00+08:00",
      }),
    ).toMatchObject({
      status: "unresolved",
      expectedAsOf: null,
      reasonCode: "SESSION_MARKER_NOT_CONFIRMED",
    });
  });

  it("fails closed when the benchmark reveals a later make-up session missing from the calendar", async () => {
    const { resolver } = build({
      dates: { listed: ["2026-08-28", "2026-08-29"] },
    });

    expect(
      await resolver.resolve({
        market: "listed",
        evaluatedAt: "2026-08-29T15:00:00+08:00",
      }),
    ).toMatchObject({
      status: "unresolved",
      expectedAsOf: null,
      marketResolutions: [
        {
          scheduledCandidate: "2026-08-28",
          reasonCode: "SESSION_MARKER_NOT_CONFIRMED",
        },
      ],
    });
  });

  it("requires listed and OTC expected dates to agree", async () => {
    const { resolver, getCalendar, getHistory } = build({
      calendars: {
        otc: calendar("otc", [["2026-08-28", "closed"]]),
      },
      dates: {
        listed: ["2026-08-28"],
        otc: ["2026-08-27"],
      },
    });
    const result = await resolver.resolve({
      market: "all",
      evaluatedAt: "2026-08-28T15:00:00+08:00",
    });
    expect(result).toMatchObject({
      status: "unresolved",
      expectedAsOf: null,
      reasonCode: "CROSS_MARKET_EXPECTED_AS_OF_MISMATCH",
    });
    expect(getCalendar).toHaveBeenCalledTimes(2);
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it("uses one calendar plus one exact benchmark load per market at a year boundary", async () => {
    const { resolver, getCalendar, getHistory } = build({
      calendars: {
        listed: {
          ...calendar("listed", [["2026-01-01", "closed"]]),
          year: 2026,
        },
      },
      dates: { listed: ["2025-12-30", "2025-12-31"] },
    });
    const result = await resolver.resolve({
      market: "listed",
      evaluatedAt: "2026-01-01T12:00:00+08:00",
    });
    expect(result).toMatchObject({
      status: "resolved",
      expectedAsOf: "2025-12-31",
      marketResolutions: [{ scheduledCandidate: null }],
      workBudget: {
        scope: "freshness_meta_layer",
        actualTotal: 2,
        maximumTotal: 2,
      },
    });
    expect(getCalendar).toHaveBeenCalledTimes(1);
    expect(getHistory).toHaveBeenCalledWith("listed", ["2025-12"]);
  });

  it("enforces resolver evidence cross-field invariants", async () => {
    const { resolver } = build();
    const evidence = await resolver.resolve({
      market: "all",
      evaluatedAt: "2026-08-28T15:00:00+08:00",
    });
    expect(completedSessionResolverEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );

    const duplicateMarkets = structuredClone(evidence);
    duplicateMarkets.markets = ["listed", "listed"];
    expect(
      completedSessionResolverEvidenceSchema.safeParse(duplicateMarkets)
        .success,
    ).toBe(false);

    const wrongExpected = structuredClone(evidence);
    wrongExpected.expectedAsOf = "2026-08-27";
    expect(
      completedSessionResolverEvidenceSchema.safeParse(wrongExpected).success,
    ).toBe(false);

    const wrongSourceMarket = structuredClone(evidence);
    wrongSourceMarket.marketResolutions[0]!.sources[0]!.market = "otc";
    expect(
      completedSessionResolverEvidenceSchema.safeParse(wrongSourceMarket)
        .success,
    ).toBe(false);

    const wrongBudget = structuredClone(evidence);
    wrongBudget.workBudget.actualTotal = 3;
    expect(
      completedSessionResolverEvidenceSchema.safeParse(wrongBudget).success,
    ).toBe(false);
  });
});

describe("TPEx calendar acquisition", () => {
  it("uses the exact allowlisted POST body and shares the five-minute cache", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toBe("date=2026&response=json");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response(JSON.stringify(tpexSnapshot().payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new OfficialTradingCalendarClient(
      fetchImpl,
      () => new Date("2026-08-28T07:00:00.000Z"),
      { maxAttempts: 1 },
    );
    await client.getCalendar("otc", 2026);
    await client.getCalendar("otc", 2026);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a POST URL outside the exact origin/path allowlist before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const loader = new OfficialJsonPostLoader(
      fetchImpl,
      () => new Date("2026-08-28T07:00:00.000Z"),
    );
    await expect(
      loader.post({
        sourceName: "fixture",
        sourceUrl:
          "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate?unexpected=1",
        fields: { date: "2026", response: "json" },
        allowedOrigin: "https://www.tpex.org.tw",
        allowedPath: "/www/zh-tw/bulletin/tradingDate",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
