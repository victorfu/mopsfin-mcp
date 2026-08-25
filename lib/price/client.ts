import { createHash } from "node:crypto";

import { companyMasterClient } from "@/lib/company-master/client";
import type {
  CompanyMarket,
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import { MopsfinError } from "@/lib/mopsfin/errors";

import type {
  DailyMarketOhlcQuery,
  DailyMarketOhlcResult,
  OhlcBar,
  PriceSource,
  StockOhlcQuery,
  StockOhlcResult,
} from "./types";

type FetchLike = typeof fetch;

interface CompanyMasterLike {
  listCompanies(
    query: {
      market: "all" | "listed" | "otc";
      includeFinancial: boolean;
      includeKy: boolean;
    },
    force?: boolean,
  ): Promise<CompanyMasterResult>;
}

interface PriceClientOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  currentTtlMs?: number;
  historicalTtlMs?: number;
  monthsPerPage?: number;
  concurrency?: number;
}

interface JsonSnapshot {
  payload: unknown;
  retrievedAt: string;
}

interface MonthResult {
  market: CompanyMarket;
  source: PriceSource;
  observedName?: string;
  bars: OhlcBar[];
}

interface DailyRow extends OhlcBar {
  code: string;
  name: string;
}

interface DailyResult {
  market: CompanyMarket;
  dataDate: string;
  source: PriceSource;
  rows: DailyRow[];
}

interface CursorPayload {
  version: 1;
  companyCode: string;
  startDate: string;
  endDate: string;
  nextMonth: string;
  sawData: boolean;
}

const TWSE_STOCK_MONTH_URL =
  "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY";
const TPEX_STOCK_MONTH_URL =
  "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock";
const TWSE_DAILY_MARKET_URL =
  "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX";
const TPEX_DAILY_MARKET_URL =
  "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes";
const TWSE_LATEST_MARKET_URL =
  "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_LATEST_MARKET_URL =
  "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

const TWSE_STOCK_SUPPORTED_FROM = "2010-01-04";
const TPEX_STOCK_SUPPORTED_FROM = "1994-01-01";
const TWSE_MARKET_SUPPORTED_FROM = "2004-02-11";
const TPEX_MARKET_SUPPORTED_FROM = "2007-04-23";
const CURSOR_PREFIX = "ohlc1.";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError(code, message, { details });
}

function parseIsoDate(raw: string, field: string): Date {
  if (!ISO_DATE.test(raw)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 YYYY-MM-DD。`, { field, value: raw });
  }
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${field} 不是有效日期。`, { field, value: raw });
  }
  return parsed;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function taipeiToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function monthStart(month: string): string {
  return `${month}-01`;
}

function addMonths(month: string, count: number): string {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + count, 1));
  return date.toISOString().slice(0, 7);
}

function monthEnd(month: string): string {
  const next = addMonths(month, 1);
  const [year, value] = next.split("-").map(Number);
  return toIsoDate(new Date(Date.UTC(year, value - 1, 0)));
}

function monthsBetween(start: string, end: string): string[] {
  const months: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addMonths(cursor, 1)) {
    months.push(cursor);
  }
  return months;
}

function parseRocDate(raw: unknown): string {
  if (typeof raw !== "string") {
    fail("UPSTREAM_BAD_RESPONSE", "官方 OHLC 日期欄位不是字串。");
  }
  const match = /^\s*(\d{2,3})\/(\d{2})\/(\d{2})/.exec(raw);
  if (!match) {
    fail("UPSTREAM_BAD_RESPONSE", "官方 OHLC 民國日期格式錯誤。", {
      value: raw,
    });
  }
  const iso = `${String(Number(match[1]) + 1911).padStart(4, "0")}-${match[2]}-${match[3]}`;
  parseIsoDate(iso, "upstream_date");
  return iso;
}

function parseCompactRocDate(raw: unknown): string {
  if (typeof raw !== "string") {
    fail("UPSTREAM_BAD_RESPONSE", "官方行情日期欄位不是字串。");
  }
  const match = /^(\d{2,3})(\d{2})(\d{2})$/.exec(raw.trim());
  if (!match) {
    fail("UPSTREAM_BAD_RESPONSE", "官方行情民國日期格式錯誤。", {
      value: raw,
    });
  }
  const iso = `${String(Number(match[1]) + 1911).padStart(4, "0")}-${match[2]}-${match[3]}`;
  parseIsoDate(iso, "upstream_date");
  return iso;
}

function parseCompactGregorianDate(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{8}$/.test(raw.trim())) {
    fail("UPSTREAM_BAD_RESPONSE", "官方行情西元日期格式錯誤。", {
      value: raw,
    });
  }
  const value = raw.trim();
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  parseIsoDate(iso, "upstream_date");
  return iso;
}

function parsePrice(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const value = String(raw).replace(/,/g, "").trim();
  if (!value || /^(?:--|---)$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBar(
  date: string,
  market: CompanyMarket,
  rawOpen: unknown,
  rawHigh: unknown,
  rawLow: unknown,
  rawClose: unknown,
): OhlcBar {
  const values = [rawOpen, rawHigh, rawLow, rawClose].map(parsePrice);
  const traded = values.some((value) => value !== null && value > 0);
  const normalized = traded
    ? values.map((value) => (value !== null && value > 0 ? value : null))
    : [null, null, null, null];
  return {
    date,
    open: normalized[0],
    high: normalized[1],
    low: normalized[2],
    close: normalized[3],
    market,
    status: traded ? "traded" : "no_trade",
  };
}

function findField(fields: unknown[], names: string[]): number {
  const normalized = fields.map((field) => String(field).replace(/\s+/g, ""));
  const index = normalized.findIndex((field) => names.includes(field));
  if (index < 0) {
    fail("UPSTREAM_BAD_RESPONSE", "官方 OHLC 回應缺少必要欄位。", {
      names,
      fields,
    });
  }
  return index;
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

function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const checksum = createHash("sha256")
    .update(`mopsfin-price-cursor-v1:${body}`)
    .digest("base64url")
    .slice(0, 16);
  return `${CURSOR_PREFIX}${body}.${checksum}`;
}

function decodeCursor(cursor: string): CursorPayload {
  if (!cursor.startsWith(CURSOR_PREFIX) || cursor.length > 1_000) {
    fail("INVALID_ARGUMENT", "cursor 格式錯誤。");
  }
  try {
    const encoded = cursor.slice(CURSOR_PREFIX.length);
    const [body, checksum, ...extra] = encoded.split(".");
    const expected = createHash("sha256")
      .update(`mopsfin-price-cursor-v1:${body}`)
      .digest("base64url")
      .slice(0, 16);
    if (!body || !checksum || extra.length > 0 || checksum !== expected) {
      fail("INVALID_ARGUMENT", "cursor checksum 驗證失敗。");
    }
    const raw = Buffer.from(body, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.companyCode !== "string" ||
      typeof parsed.startDate !== "string" ||
      typeof parsed.endDate !== "string" ||
      typeof parsed.nextMonth !== "string" ||
      typeof parsed.sawData !== "boolean" ||
      !/^\d{4}-\d{2}$/.test(parsed.nextMonth)
    ) {
      fail("INVALID_ARGUMENT", "cursor 內容格式錯誤。");
    }
    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof MopsfinError) throw error;
    fail("INVALID_ARGUMENT", "cursor 無法解析。");
  }
}

function uniqueSources(results: MonthResult[]): PriceSource[] {
  const byMarket = new Map<CompanyMarket, PriceSource>();
  for (const result of results) byMarket.set(result.market, result.source);
  return [...byMarket.values()].sort((left, right) =>
    left.market.localeCompare(right.market),
  );
}

export class PriceClient {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly currentTtlMs: number;
  private readonly historicalTtlMs: number;
  private readonly monthsPerPage: number;
  private readonly concurrency: number;
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: JsonSnapshot }
  >();
  private readonly pending = new Map<string, Promise<JsonSnapshot>>();

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CompanyMasterLike = companyMasterClient,
    options: PriceClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.currentTtlMs = options.currentTtlMs ?? 5 * 60 * 1000;
    this.historicalTtlMs = options.historicalTtlMs ?? 24 * 60 * 60 * 1000;
    this.monthsPerPage = options.monthsPerPage ?? 12;
    this.concurrency = options.concurrency ?? 2;
  }

  async getStockOhlc(query: StockOhlcQuery): Promise<StockOhlcResult> {
    if (!/^\d{4}$/.test(query.companyCode)) {
      fail("INVALID_ARGUMENT", "company_code 必須是四碼公司股票代號。", {
        companyCode: query.companyCode,
      });
    }
    parseIsoDate(query.startDate, "start_date");
    parseIsoDate(query.endDate, "end_date");
    if (query.startDate > query.endDate) {
      fail("INVALID_ARGUMENT", "end_date 不得早於 start_date。");
    }
    const today = taipeiToday(this.now());
    if (query.endDate > today) {
      fail("INVALID_ARGUMENT", "end_date 不得晚於台北今日日期。", { today });
    }
    if (query.startDate < TPEX_STOCK_SUPPORTED_FROM) {
      fail("INVALID_ARGUMENT", "start_date 早於官方個股歷史支援範圍。", {
        supportedFrom: TPEX_STOCK_SUPPORTED_FROM,
      });
    }

    const master = await this.companyMaster.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    const currentCompany = master.companies.find(
      (company) => company.code === query.companyCode,
    );
    if (
      currentCompany?.market === "listed" &&
      currentCompany.listingDate <= query.startDate &&
      query.startDate < TWSE_STOCK_SUPPORTED_FROM
    ) {
      fail("INVALID_ARGUMENT", "上市個股月資料自 2010-01-04 起提供。", {
        supportedFrom: TWSE_STOCK_SUPPORTED_FROM,
      });
    }

    let nextMonth = monthOf(query.startDate);
    let sawData = false;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (
        cursor.companyCode !== query.companyCode ||
        cursor.startDate !== query.startDate ||
        cursor.endDate !== query.endDate
      ) {
        fail("INVALID_ARGUMENT", "cursor 與本次 OHLC 查詢範圍不符。");
      }
      nextMonth = cursor.nextMonth;
      sawData = cursor.sawData;
      if (nextMonth < monthOf(query.startDate) || nextMonth > monthOf(query.endDate)) {
        fail("INVALID_ARGUMENT", "cursor 的續查月份超出查詢範圍。");
      }
    }

    const allMonths = monthsBetween(nextMonth, monthOf(query.endDate));
    const pageMonths = allMonths.slice(0, this.monthsPerPage);
    const tasks = pageMonths.flatMap((month) =>
      this.marketsForStockMonth(month, currentCompany).map((market) => ({
        month,
        market,
      })),
    );
    const monthResults = await mapWithConcurrency(
      tasks,
      this.concurrency,
      ({ month, market }) => this.getStockMonth(query.companyCode, month, market),
    );

    const byDate = new Map<string, OhlcBar>();
    for (const result of monthResults) {
      for (const bar of result.bars) {
        if (bar.date < query.startDate || bar.date > query.endDate) continue;
        if (byDate.has(bar.date)) {
          fail("UPSTREAM_BAD_RESPONSE", "同一股票同一日期出現跨市場重複 OHLC。", {
            companyCode: query.companyCode,
            date: bar.date,
          });
        }
        byDate.set(bar.date, bar);
      }
    }
    const bars = [...byDate.values()].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    sawData ||= bars.length > 0;
    const observedNames = [
      ...new Set(
        [currentCompany?.shortName, ...monthResults.map((result) => result.observedName)]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.trim()),
      ),
    ];

    const lastMonth = pageMonths.at(-1) as string;
    const remaining = allMonths.length > pageMonths.length;
    const followingMonth = addMonths(lastMonth, 1);
    const coverageComplete = !remaining;
    const coveredThrough = coverageComplete
      ? query.endDate
      : [query.endDate, monthEnd(lastMonth)].sort()[0];
    if (coverageComplete && !sawData) {
      fail("NO_DATA", "指定股票與日期範圍查無官方 OHLC。", {
        companyCode: query.companyCode,
        startDate: query.startDate,
        endDate: query.endDate,
      });
    }

    const warnings = [
      "價格為官方原始未還原權值日線，不含 adjusted close、成交量或成交金額。",
      "只回實際官方交易日期；週末、休市與停牌日期不補合成 bar。",
    ];
    if (observedNames.length > 1) {
      warnings.push(
        `此代號在查詢相關資料中出現多個名稱：${observedNames.join("、")}；可能是改名或代號重用。`,
      );
    }
    if (!coverageComplete) {
      warnings.push("本頁尚未涵蓋完整 requested range；請使用 nextCursor 繼續查詢。");
    }

    return {
      query,
      companyCode: query.companyCode,
      observedNames,
      currency: "TWD",
      timezone: "Asia/Taipei",
      interval: "1d",
      priceBasis: "raw_unadjusted",
      bars,
      coverage: {
        requestedStart: query.startDate,
        requestedEnd: query.endDate,
        coveredThrough,
        coverageComplete,
        nextCursor: remaining
          ? encodeCursor({
              version: 1,
              companyCode: query.companyCode,
              startDate: query.startDate,
              endDate: query.endDate,
              nextMonth: followingMonth,
              sawData,
            })
          : null,
      },
      sources: uniqueSources(monthResults),
      warnings,
    };
  }

  async getDailyMarketOhlc(
    query: DailyMarketOhlcQuery,
  ): Promise<DailyMarketOhlcResult> {
    const requestedCodes = query.companyCodes
      ? [...new Set(query.companyCodes.map((code) => code.trim()))]
      : undefined;
    if (requestedCodes?.some((code) => !/^\d{4}$/.test(code))) {
      fail("INVALID_ARGUMENT", "company_codes 只能包含四碼公司股票代號。");
    }
    if (query.date !== "latest") {
      parseIsoDate(query.date, "date");
      if (query.date > taipeiToday(this.now())) {
        fail("INVALID_ARGUMENT", "date 不得晚於台北今日日期。");
      }
      const supportedFrom =
        query.market === "listed"
          ? TWSE_MARKET_SUPPORTED_FROM
          : TPEX_MARKET_SUPPORTED_FROM;
      if (query.date < supportedFrom) {
        fail("INVALID_ARGUMENT", "date 早於指定市場的全市場行情支援範圍。", {
          market: query.market,
          supportedFrom,
        });
      }
    }

    const markets: CompanyMarket[] =
      query.market === "all" ? ["listed", "otc"] : [query.market];
    const results = await Promise.all(
      markets.map((market) => this.getDailyMarket(market, query.date)),
    );
    const dates = [...new Set(results.map((result) => result.dataDate))];
    if (dates.length !== 1) {
      fail("NO_DATA", "上市與上櫃最新完成交易日不一致，請稍後重試或指定日期。", {
        sourceDates: results.map((result) => ({
          market: result.market,
          date: result.dataDate,
        })),
      });
    }

    const classificationMethod =
      query.date === "latest" ? "current_master" : "historical_code_rule";
    let allowedCurrentCodes: Set<string> | undefined;
    const currentMasterFallbackCodes = new Set<string>();
    if (classificationMethod === "current_master") {
      const master = await this.companyMaster.listCompanies({
        market: query.market,
        includeFinancial: true,
        includeKy: true,
      });
      allowedCurrentCodes = new Set(master.companies.map((company) => company.code));
    }

    let rows = results.flatMap((result) => result.rows);
    rows = rows.filter((row) => {
      if (/-DR$/i.test(row.name)) return false;
      if (classificationMethod === "current_master") {
        if (allowedCurrentCodes?.has(row.code)) return true;
        const eligibleFallback = /^[1-9]\d{3}$/.test(row.code);
        if (
          eligibleFallback &&
          (!requestedCodes || requestedCodes.includes(row.code))
        ) {
          currentMasterFallbackCodes.add(row.code);
        }
        return eligibleFallback;
      }
      return /^[1-9]\d{3}$/.test(row.code);
    });
    if (requestedCodes) {
      const selected = new Set(requestedCodes);
      rows = rows.filter((row) => selected.has(row.code));
    }
    rows.sort((left, right) => left.code.localeCompare(right.code));
    const seenCodes = new Set<string>();
    for (const row of rows) {
      if (seenCodes.has(row.code)) {
        fail("UPSTREAM_BAD_RESPONSE", "單日全市場行情出現跨市場重複公司代號。", {
          code: row.code,
          dataDate: dates[0],
        });
      }
      seenCodes.add(row.code);
    }

    const returnedCodes = new Set(rows.map((row) => row.code));
    const missingCompanyCodes = requestedCodes
      ? requestedCodes.filter((code) => !returnedCodes.has(code))
      : [];
    if (rows.length === 0) {
      fail("NO_DATA", "指定市場、日期與公司條件查無官方 OHLC。", {
        market: query.market,
        date: query.date,
        missingCompanyCodes,
      });
    }

    const warnings = [
      "價格為官方原始未還原權值日線，不含 adjusted close、成交量或成交金額。",
      query.date === "latest"
        ? "latest 代表最近完成交易日，不是盤中即時報價。"
        : "歷史完整市場以四碼、首碼非 0 且非 -DR 的官方證券列辨識公司股票。",
    ];
    if (missingCompanyCodes.length > 0) {
      warnings.push(`以下代號未出現在指定市場日期：${missingCompanyCodes.join("、")}。`);
    }
    if (currentMasterFallbackCodes.size > 0) {
      warnings.push(
        `以下最新行情代號尚未出現在目前公司母體快照，但符合公司股票代號規則：${[...currentMasterFallbackCodes].join("、")}。`,
      );
    }

    return {
      query: {
        ...query,
        ...(requestedCodes ? { companyCodes: requestedCodes } : {}),
      },
      dataDate: dates[0],
      currency: "TWD",
      timezone: "Asia/Taipei",
      interval: "1d",
      priceBasis: "raw_unadjusted",
      classificationMethod,
      coverageComplete: true,
      selectionComplete: missingCompanyCodes.length === 0,
      missingCompanyCodes,
      counts: {
        listed: rows.filter((row) => row.market === "listed").length,
        otc: rows.filter((row) => row.market === "otc").length,
        returned: rows.length,
      },
      bars: rows,
      sources: results.map((result) => result.source),
      warnings,
    };
  }

  private marketsForStockMonth(
    month: string,
    currentCompany?: MasterCompany,
  ): CompanyMarket[] {
    if (!currentCompany) {
      const markets: CompanyMarket[] = ["otc"];
      if (monthEnd(month) >= TWSE_STOCK_SUPPORTED_FROM) markets.push("listed");
      return markets;
    }
    const listingMonth = monthOf(currentCompany.listingDate);
    if (month < listingMonth) {
      const markets: CompanyMarket[] = ["otc"];
      if (monthEnd(month) >= TWSE_STOCK_SUPPORTED_FROM) markets.push("listed");
      return markets;
    }
    if (month === listingMonth) {
      return currentCompany.market === "listed"
        ? ["otc", "listed"]
        : ["listed", "otc"];
    }
    return [currentCompany.market];
  }

  private async getStockMonth(
    code: string,
    month: string,
    market: CompanyMarket,
  ): Promise<MonthResult> {
    if (market === "listed" && monthEnd(month) < TWSE_STOCK_SUPPORTED_FROM) {
      return {
        market,
        source: this.priceSource(
          market,
          "臺灣證券交易所－個股日成交資訊",
          TWSE_STOCK_MONTH_URL,
          this.now().toISOString(),
        ),
        bars: [],
      };
    }
    const currentMonth = month === monthOf(taipeiToday(this.now()));
    if (market === "listed") {
      const date = month.replace("-", "") + "01";
      const url = new URL(TWSE_STOCK_MONTH_URL);
      url.search = new URLSearchParams({
        date,
        stockNo: code,
        response: "json",
      }).toString();
      const snapshot = await this.getJson(
        url,
        currentMonth ? this.currentTtlMs : this.historicalTtlMs,
      );
      return this.parseTwseStockMonth(snapshot, url.toString());
    }

    const [year, value] = month.split("-");
    const url = new URL(TPEX_STOCK_MONTH_URL);
    url.search = new URLSearchParams({
      code,
      date: `${year}/${value}/01`,
      response: "json",
    }).toString();
    const snapshot = await this.getJson(
      url,
      currentMonth ? this.currentTtlMs : this.historicalTtlMs,
    );
    return this.parseTpexStockMonth(snapshot, url.toString());
  }

  private parseTwseStockMonth(
    snapshot: JsonSnapshot,
    sourceUrl: string,
  ): MonthResult {
    const payload = snapshot.payload as Record<string, unknown>;
    const stat = String(payload?.stat ?? "");
    const source = this.priceSource(
      "listed",
      "臺灣證券交易所－個股日成交資訊",
      sourceUrl,
      snapshot.retrievedAt,
    );
    if (stat !== "OK") {
      if (/沒有符合條件/.test(stat)) return { market: "listed", source, bars: [] };
      fail("UPSTREAM_BAD_RESPONSE", `TWSE 個股 OHLC 回傳異常：${stat || "未知狀態"}`);
    }
    const data = Array.isArray(payload.data) ? payload.data : [];
    const title = typeof payload.title === "string" ? payload.title : "";
    const nameMatch = /^\s*\d+年\d+月\s+\S+\s+(.+?)\s+各日成交資訊/.exec(title);
    const bars = data.map((raw) => {
      if (!Array.isArray(raw) || raw.length < 7) {
        fail("UPSTREAM_BAD_RESPONSE", "TWSE 個股 OHLC 資料列格式錯誤。");
      }
      return normalizeBar(
        parseRocDate(raw[0]),
        "listed",
        raw[3],
        raw[4],
        raw[5],
        raw[6],
      );
    });
    return {
      market: "listed",
      source,
      observedName: nameMatch?.[1]?.trim(),
      bars,
    };
  }

  private parseTpexStockMonth(
    snapshot: JsonSnapshot,
    sourceUrl: string,
  ): MonthResult {
    const payload = snapshot.payload as Record<string, unknown>;
    const source = this.priceSource(
      "otc",
      "證券櫃檯買賣中心－個股日成交資訊",
      sourceUrl,
      snapshot.retrievedAt,
    );
    if (String(payload?.stat ?? "") !== "ok") {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 個股 OHLC 回傳狀態錯誤。", {
        stat: payload?.stat,
      });
    }
    const tables = Array.isArray(payload.tables) ? payload.tables : [];
    const table = tables[0] as Record<string, unknown> | undefined;
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    const data = Array.isArray(table?.data) ? table.data : [];
    if (fields.length === 0) {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 個股 OHLC 回應缺少欄位定義。");
    }
    const dateIndex = findField(fields, ["日期"]);
    const openIndex = findField(fields, ["開盤"]);
    const highIndex = findField(fields, ["最高"]);
    const lowIndex = findField(fields, ["最低"]);
    const closeIndex = findField(fields, ["收盤"]);
    const bars = data.map((raw) => {
      if (!Array.isArray(raw)) {
        fail("UPSTREAM_BAD_RESPONSE", "TPEx 個股 OHLC 資料列格式錯誤。");
      }
      return normalizeBar(
        parseRocDate(raw[dateIndex]),
        "otc",
        raw[openIndex],
        raw[highIndex],
        raw[lowIndex],
        raw[closeIndex],
      );
    });
    return {
      market: "otc",
      source,
      observedName: typeof payload.name === "string" ? payload.name.trim() : undefined,
      bars,
    };
  }

  private async getDailyMarket(
    market: CompanyMarket,
    date: "latest" | string,
  ): Promise<DailyResult> {
    if (date === "latest") {
      const url = new URL(
        market === "listed" ? TWSE_LATEST_MARKET_URL : TPEX_LATEST_MARKET_URL,
      );
      const snapshot = await this.getJson(url, this.currentTtlMs);
      return market === "listed"
        ? this.parseTwseLatest(snapshot, url.toString())
        : this.parseTpexLatest(snapshot, url.toString());
    }
    if (market === "listed") {
      const url = new URL(TWSE_DAILY_MARKET_URL);
      url.search = new URLSearchParams({
        date: date.replaceAll("-", ""),
        type: "ALLBUT0999",
        response: "json",
      }).toString();
      const snapshot = await this.getJson(
        url,
        date === taipeiToday(this.now()) ? this.currentTtlMs : this.historicalTtlMs,
      );
      return this.parseTwseDaily(snapshot, url.toString(), date);
    }
    const url = new URL(TPEX_DAILY_MARKET_URL);
    url.search = new URLSearchParams({ date: date.replaceAll("-", "/"), response: "json" }).toString();
    const snapshot = await this.getJson(
      url,
      date === taipeiToday(this.now()) ? this.currentTtlMs : this.historicalTtlMs,
    );
    return this.parseTpexDaily(snapshot, url.toString(), date);
  }

  private parseTwseLatest(snapshot: JsonSnapshot, sourceUrl: string): DailyResult {
    if (!Array.isArray(snapshot.payload) || snapshot.payload.length === 0) {
      fail("NO_DATA", "TWSE 最新完成交易日查無行情。");
    }
    const rows = snapshot.payload.map((raw) => {
      const row = raw as Record<string, unknown>;
      const date = parseCompactRocDate(row.Date);
      return {
        code: String(row.Code ?? "").trim(),
        name: String(row.Name ?? "").trim(),
        ...normalizeBar(
          date,
          "listed",
          row.OpeningPrice,
          row.HighestPrice,
          row.LowestPrice,
          row.ClosingPrice,
        ),
      };
    });
    const dates = [...new Set(rows.map((row) => row.date))];
    if (dates.length !== 1) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE 最新行情混入多個資料日期。", { dates });
    }
    return {
      market: "listed",
      dataDate: dates[0],
      source: this.priceSource(
        "listed",
        "臺灣證券交易所－上市個股日成交資訊",
        sourceUrl,
        snapshot.retrievedAt,
        dates[0],
      ),
      rows,
    };
  }

  private parseTpexLatest(snapshot: JsonSnapshot, sourceUrl: string): DailyResult {
    if (!Array.isArray(snapshot.payload) || snapshot.payload.length === 0) {
      fail("NO_DATA", "TPEx 最新完成交易日查無行情。");
    }
    const rows = snapshot.payload.map((raw) => {
      const row = raw as Record<string, unknown>;
      const date = parseCompactRocDate(row.Date);
      return {
        code: String(row.SecuritiesCompanyCode ?? "").trim(),
        name: String(row.CompanyName ?? "").trim(),
        ...normalizeBar(date, "otc", row.Open, row.High, row.Low, row.Close),
      };
    });
    const dates = [...new Set(rows.map((row) => row.date))];
    if (dates.length !== 1) {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 最新行情混入多個資料日期。", { dates });
    }
    return {
      market: "otc",
      dataDate: dates[0],
      source: this.priceSource(
        "otc",
        "證券櫃檯買賣中心－上櫃股票行情",
        sourceUrl,
        snapshot.retrievedAt,
        dates[0],
      ),
      rows,
    };
  }

  private parseTwseDaily(
    snapshot: JsonSnapshot,
    sourceUrl: string,
    requestedDate: string,
  ): DailyResult {
    const payload = snapshot.payload as Record<string, unknown>;
    if (String(payload?.stat ?? "") !== "OK") {
      fail("NO_DATA", "TWSE 指定日期查無全市場行情。", {
        requestedDate,
        stat: payload?.stat,
      });
    }
    const dataDate = parseCompactGregorianDate(payload.date);
    if (dataDate !== requestedDate) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE 回傳日期與 requested date 不符。", {
        requestedDate,
        dataDate,
      });
    }
    const tables = Array.isArray(payload.tables) ? payload.tables : [];
    const table = tables.find((candidate) => {
      const fields = (candidate as Record<string, unknown>)?.fields;
      return Array.isArray(fields) && fields[0] === "證券代號";
    }) as Record<string, unknown> | undefined;
    return this.parseDailyTable(
      "listed",
      dataDate,
      table,
      this.priceSource(
        "listed",
        "臺灣證券交易所－每日收盤行情",
        sourceUrl,
        snapshot.retrievedAt,
        dataDate,
      ),
      {
        code: ["證券代號"],
        name: ["證券名稱"],
        open: ["開盤價"],
        high: ["最高價"],
        low: ["最低價"],
        close: ["收盤價"],
      },
    );
  }

  private parseTpexDaily(
    snapshot: JsonSnapshot,
    sourceUrl: string,
    requestedDate: string,
  ): DailyResult {
    const payload = snapshot.payload as Record<string, unknown>;
    if (String(payload?.stat ?? "") !== "ok") {
      fail("NO_DATA", "TPEx 指定日期查無全市場行情。", {
        requestedDate,
        stat: payload?.stat,
      });
    }
    const dataDate = parseCompactGregorianDate(payload.date);
    if (dataDate !== requestedDate) {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 回傳日期與 requested date 不符。", {
        requestedDate,
        dataDate,
      });
    }
    const tables = Array.isArray(payload.tables) ? payload.tables : [];
    const table = tables[0] as Record<string, unknown> | undefined;
    return this.parseDailyTable(
      "otc",
      dataDate,
      table,
      this.priceSource(
        "otc",
        "證券櫃檯買賣中心－上櫃股票行情",
        sourceUrl,
        snapshot.retrievedAt,
        dataDate,
      ),
      {
        code: ["代號"],
        name: ["名稱"],
        open: ["開盤"],
        high: ["最高"],
        low: ["最低"],
        close: ["收盤"],
      },
    );
  }

  private parseDailyTable(
    market: CompanyMarket,
    dataDate: string,
    table: Record<string, unknown> | undefined,
    source: PriceSource,
    names: Record<"code" | "name" | "open" | "high" | "low" | "close", string[]>,
  ): DailyResult {
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    const data = Array.isArray(table?.data) ? table.data : [];
    if (fields.length === 0 || data.length === 0) {
      fail("NO_DATA", `${source.sourceName} 在 ${dataDate} 查無資料。`);
    }
    const indexes = {
      code: findField(fields, names.code),
      name: findField(fields, names.name),
      open: findField(fields, names.open),
      high: findField(fields, names.high),
      low: findField(fields, names.low),
      close: findField(fields, names.close),
    };
    const rows = data.map((raw) => {
      if (!Array.isArray(raw)) {
        fail("UPSTREAM_BAD_RESPONSE", `${source.sourceName} 資料列格式錯誤。`);
      }
      return {
        code: String(raw[indexes.code] ?? "").trim(),
        name: String(raw[indexes.name] ?? "").trim(),
        ...normalizeBar(
          dataDate,
          market,
          raw[indexes.open],
          raw[indexes.high],
          raw[indexes.low],
          raw[indexes.close],
        ),
      };
    });
    return { market, dataDate, source, rows };
  }

  private priceSource(
    market: CompanyMarket,
    sourceName: string,
    sourceUrl: string,
    retrievedAt: string,
    dataDate?: string,
  ): PriceSource {
    return {
      market,
      sourceName,
      sourceUrl,
      retrievedAt,
      ...(dataDate ? { dataDate } : {}),
    };
  }

  private async getJson(url: URL, ttlMs: number): Promise<JsonSnapshot> {
    const key = url.toString();
    const now = this.now().getTime();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const pending = this.requestJson(url)
      .then((value) => {
        this.cache.set(key, { expiresAt: this.now().getTime() + ttlMs, value });
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  private async requestJson(url: URL): Promise<JsonSnapshot> {
    let lastError: MopsfinError | undefined;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            Referer: `${url.origin}/`,
            "User-Agent": "mopsfin-mcp/0.1 (+https://mopsfin.twse.com.tw/)",
          },
        });
        const body = await response.text();
        if (response.ok) {
          try {
            return {
              payload: JSON.parse(body) as unknown,
              retrievedAt: this.now().toISOString(),
            };
          } catch (error) {
            lastError = new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `${url.hostname} OHLC 回應不是有效 JSON。`,
              { cause: error, details: { preview: body.slice(0, 120) } },
            );
          }
        } else {
          lastError = new MopsfinError(
            response.status === 429
              ? "UPSTREAM_RATE_LIMITED"
              : "UPSTREAM_BAD_RESPONSE",
            `${url.hostname} OHLC 回傳 HTTP ${response.status}。`,
            { status: response.status },
          );
          if (response.status !== 429 && response.status < 500) throw lastError;
        }
      } catch (error) {
        if (error instanceof MopsfinError) {
          lastError = error;
          if (
            error.status !== undefined &&
            error.status < 500 &&
            error.status !== 429
          ) {
            throw error;
          }
        } else if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new MopsfinError(
            "UPSTREAM_TIMEOUT",
            `${url.hostname} OHLC 查詢逾時。`,
            { cause: error },
          );
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `${url.hostname} OHLC 網路查詢失敗。`,
            { cause: error },
          );
        }
      } finally {
        clearTimeout(timeout);
      }
      if (attempt + 1 < this.maxAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * (attempt + 1)),
        );
      }
    }
    throw (
      lastError ??
      new MopsfinError("UPSTREAM_BAD_RESPONSE", `${url.hostname} OHLC 查詢失敗。`)
    );
  }
}

export const priceClient = new PriceClient();
