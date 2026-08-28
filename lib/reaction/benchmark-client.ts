import type { CompanyMarket } from "@/lib/company-master/types";
import {
  fail,
  OfficialJsonLoader,
  parseOfficialNumber,
  type JsonSnapshot,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import type { OfficialMarketClientOptions } from "@/lib/market-data/types";

import type {
  BenchmarkBar,
  BenchmarkHistory,
  BenchmarkSource,
} from "./types";

const TWSE_BENCHMARK_URL =
  "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST";
const TPEX_BENCHMARK_URL =
  "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingIndex";

interface ParsedBenchmarkMonth {
  bars: BenchmarkBar[];
  source: BenchmarkSource;
}

function compactMonth(month: string): string {
  return month.replace("-", "");
}

function requestedCompactDate(month: string): string {
  return `${compactMonth(month)}01`;
}

function parseRocDate(raw: unknown, context: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 日期不是字串。`, { value: raw });
  }
  const match = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(raw).trim());
  if (!match) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 民國日期格式錯誤。`, {
      value: raw,
    });
  }
  const year = Number(match[1]) + 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 日期不是有效日曆日期。`, {
      value: raw,
    });
  }
  return candidate.toISOString().slice(0, 10);
}

function normalizedField(raw: unknown): string {
  return String(raw)
    .replace(/[\s　]/g, "")
    .replace(/[()（）]/g, "")
    .trim();
}

function requiredField(fields: unknown[], names: string[], context: string): number {
  const normalizedNames = new Set(names.map(normalizedField));
  const index = fields.findIndex((field) => normalizedNames.has(normalizedField(field)));
  if (index < 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 缺少必要欄位。`, {
      expectedFields: names,
      fields,
    });
  }
  return index;
}

function parsePositiveIndex(raw: unknown, context: string): number {
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing || parsed.invalid || parsed.value === null || parsed.value <= 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 指數值無效。`, { value: raw });
  }
  return parsed.value;
}

function assertDeclaredCount(raw: unknown, actual: number, context: string): void {
  if (raw === undefined || raw === null || raw === "") return;
  const parsed = parseOfficialNumber(raw);
  if (
    parsed.invalid ||
    parsed.missing ||
    parsed.value === null ||
    !Number.isSafeInteger(parsed.value) ||
    parsed.value < 0
  ) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 宣告筆數格式錯誤。`, {
      declaredCount: raw,
      actualCount: actual,
    });
  }
  if (parsed.value !== actual) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 宣告筆數與資料列數不一致。`, {
      declaredCount: parsed.value,
      actualCount: actual,
    });
  }
}

function assertPayloadMonth(
  payload: Record<string, unknown>,
  expectedMonth: string,
  context: string,
): void {
  const expected = requestedCompactDate(expectedMonth);
  const actual = String(payload.date ?? "").trim();
  if (actual !== expected) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 回傳月份與請求不符。`, {
      expectedDate: expected,
      actualDate: actual,
    });
  }
}

function assertUniqueMonthBars(
  bars: BenchmarkBar[],
  expectedMonth: string,
  context: string,
): void {
  const seen = new Set<string>();
  for (const bar of bars) {
    if (bar.date.slice(0, 7) !== expectedMonth) {
      fail("UPSTREAM_BAD_RESPONSE", `${context} 含請求月份以外的資料。`, {
        expectedMonth,
        date: bar.date,
      });
    }
    if (seen.has(bar.date)) {
      fail("UPSTREAM_BAD_RESPONSE", `${context} 含重複交易日期。`, {
        date: bar.date,
      });
    }
    seen.add(bar.date);
  }
  bars.sort((left, right) => left.date.localeCompare(right.date));
}

export function normalizeTwseBenchmarkMonth(
  snapshot: JsonSnapshot,
  month: string,
  sourceUrl: string,
): ParsedBenchmarkMonth {
  if (!snapshot.payload || typeof snapshot.payload !== "object" || Array.isArray(snapshot.payload)) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE TAIEX 歷史資料格式錯誤。");
  }
  const payload = snapshot.payload as Record<string, unknown>;
  const stat = String(payload.stat ?? "");
  if (stat !== "OK") {
    if (/沒有符合|查無|no\s*data/i.test(stat)) {
      return {
        bars: [],
        source: {
          market: "listed",
          exchange: "TWSE",
          benchmarkCode: "TAIEX",
          benchmarkName: "發行量加權股價指數",
          sourceName: "臺灣證券交易所－發行量加權股價指數歷史資料",
          sourceUrl,
          dataMonth: month,
          retrievedAt: snapshot.retrievedAt,
          ...(snapshot.cache ? { cache: snapshot.cache } : {}),
          rowCount: 0,
        },
      };
    }
    fail("UPSTREAM_BAD_RESPONSE", "TWSE TAIEX 歷史資料回傳異常狀態。", {
      month,
      stat,
    });
  }
  assertPayloadMonth(payload, month, "TWSE TAIEX");
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const data = Array.isArray(payload.data) ? payload.data : [];
  if (fields.length === 0) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE TAIEX 歷史資料缺少欄位定義。");
  }
  assertDeclaredCount(payload.total, data.length, "TWSE TAIEX");
  const dateIndex = requiredField(fields, ["日期"], "TWSE TAIEX");
  const closeIndex = requiredField(fields, ["收盤指數"], "TWSE TAIEX");
  const bars = data.map((raw) => {
    if (!Array.isArray(raw)) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE TAIEX 含非陣列資料列。");
    }
    return {
      date: parseRocDate(raw[dateIndex], "TWSE TAIEX"),
      close: parsePositiveIndex(raw[closeIndex], "TWSE TAIEX"),
    };
  });
  assertUniqueMonthBars(bars, month, "TWSE TAIEX");
  return {
    bars,
    source: {
      market: "listed",
      exchange: "TWSE",
      benchmarkCode: "TAIEX",
      benchmarkName: "發行量加權股價指數",
      sourceName: "臺灣證券交易所－發行量加權股價指數歷史資料",
      sourceUrl,
      dataMonth: month,
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      rowCount: bars.length,
    },
  };
}

export function normalizeTpexBenchmarkMonth(
  snapshot: JsonSnapshot,
  month: string,
  sourceUrl: string,
): ParsedBenchmarkMonth {
  if (!snapshot.payload || typeof snapshot.payload !== "object" || Array.isArray(snapshot.payload)) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 櫃買指數歷史資料格式錯誤。");
  }
  const payload = snapshot.payload as Record<string, unknown>;
  if (String(payload.stat ?? "").toLowerCase() !== "ok") {
    fail("NO_DATA", "TPEx 櫃買指數指定月份查無官方資料。", {
      month,
      stat: payload.stat,
    });
  }
  assertPayloadMonth(payload, month, "TPEx 櫃買指數");
  const tables = Array.isArray(payload.tables) ? payload.tables : [];
  const table = tables.find((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const fields = Array.isArray((raw as Record<string, unknown>).fields)
      ? ((raw as Record<string, unknown>).fields as unknown[])
      : [];
    return fields.some((field) => normalizedField(field) === "櫃買指數");
  }) as Record<string, unknown> | undefined;
  if (!table) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 回應缺少櫃買價格指數資料表。");
  }
  const fields = Array.isArray(table.fields) ? table.fields : [];
  const data = Array.isArray(table.data) ? table.data : [];
  const dateIndex = requiredField(fields, ["日期"], "TPEx 櫃買指數");
  const closeIndex = requiredField(fields, ["櫃買指數"], "TPEx 櫃買指數");
  assertDeclaredCount(table.totalCount, data.length, "TPEx 櫃買指數");
  const bars = data.map((raw) => {
    if (!Array.isArray(raw)) {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 櫃買指數含非陣列資料列。");
    }
    return {
      date: parseRocDate(raw[dateIndex], "TPEx 櫃買指數"),
      close: parsePositiveIndex(raw[closeIndex], "TPEx 櫃買指數"),
    };
  });
  assertUniqueMonthBars(bars, month, "TPEx 櫃買指數");
  return {
    bars,
    source: {
      market: "otc",
      exchange: "TPEx",
      benchmarkCode: "TPEX_PRICE_INDEX",
      benchmarkName: "櫃買指數",
      sourceName: "證券櫃檯買賣中心－櫃買價格指數歷史資料",
      sourceUrl,
      dataMonth: month,
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      rowCount: bars.length,
    },
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
  );
  return results;
}

export class BenchmarkClient {
  private readonly loader: OfficialJsonLoader;
  private readonly concurrency: number;

  constructor(
    fetchImpl: typeof fetch = fetch,
    now: () => Date = () => new Date(),
    options: OfficialMarketClientOptions & { concurrency?: number } = {},
  ) {
    this.loader = new OfficialJsonLoader(fetchImpl, now, options);
    this.concurrency = options.concurrency ?? 3;
  }

  async getHistory(
    market: CompanyMarket,
    months: string[],
  ): Promise<BenchmarkHistory> {
    const results = await mapWithConcurrency(months, this.concurrency, async (month) => {
      const sourceUrl = this.sourceUrl(market, month);
      const config: OfficialSourceConfig = {
        market,
        exchange: market === "listed" ? "TWSE" : "TPEx",
        sourceName:
          market === "listed"
            ? "發行量加權股價指數歷史資料"
            : "櫃買價格指數歷史資料",
        sourceUrl,
      };
      const snapshot = await this.loader.get(config);
      return market === "listed"
        ? normalizeTwseBenchmarkMonth(snapshot, month, sourceUrl)
        : normalizeTpexBenchmarkMonth(snapshot, month, sourceUrl);
    });
    const unexpectedEmptyMonths = results.flatMap((result, index) =>
      index < results.length - 1 && result.bars.length === 0
        ? [months[index]]
        : [],
    );
    if (unexpectedEmptyMonths.length > 0) {
      fail("INCOMPLETE_COVERAGE", "benchmark 歷史中間月份為空，不能形成連續交易日曆。", {
        market,
        emptyMonths: unexpectedEmptyMonths,
      });
    }
    const bars = results.flatMap((result) => result.bars);
    const seen = new Set<string>();
    for (const bar of bars) {
      if (seen.has(bar.date)) {
        fail("UPSTREAM_BAD_RESPONSE", "benchmark 跨月份出現重複交易日期。", {
          market,
          date: bar.date,
        });
      }
      seen.add(bar.date);
    }
    bars.sort((left, right) => left.date.localeCompare(right.date));
    return {
      market,
      benchmarkCode: market === "listed" ? "TAIEX" : "TPEX_PRICE_INDEX",
      benchmarkName: market === "listed" ? "發行量加權股價指數" : "櫃買指數",
      priceBasis: "price_index",
      bars,
      sources: results.map((result) => result.source),
    };
  }

  private sourceUrl(market: CompanyMarket, month: string): string {
    const url = new URL(market === "listed" ? TWSE_BENCHMARK_URL : TPEX_BENCHMARK_URL);
    url.search = new URLSearchParams(
      market === "listed"
        ? { date: requestedCompactDate(month), response: "json" }
        : { date: `${month.replace("-", "/")}/01`, response: "json" },
    ).toString();
    return url.toString();
  }
}
