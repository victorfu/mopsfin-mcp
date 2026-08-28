import { createHash } from "node:crypto";

import { companyMasterClient } from "@/lib/company-master/client";
import type {
  CompanyMarket,
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import { COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI } from "@/lib/freshness/completed-session-resolver";
import {
  OfficialJsonLoader,
  type JsonSnapshot,
  type OfficialJsonLoaderOptions,
} from "@/lib/market-data/client-utils";
import { MopsfinError } from "@/lib/mopsfin/errors";

import type {
  DailyMarketReconciliation,
  DailyMarketOhlcQuery,
  DailyMarketOhlcResult,
  ExactCurrentCompanyOhlcQuery,
  ExactCurrentCompanyOhlcResult,
  OhlcBar,
  OhlcMissingField,
  PriceSource,
  PriceUnitNormalization,
  StockOhlcQuery,
  StockOhlcResult,
} from "./types";

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

interface PriceClientOptions
  extends Omit<OfficialJsonLoaderOptions, "cacheTtlMs"> {
  currentTtlMs?: number;
  historicalTtlMs?: number;
  monthsPerPage?: number;
  concurrency?: number;
}

interface MonthResult {
  market: CompanyMarket;
  source: PriceSource;
  snapshotIdentity?: "verified" | "unverified_empty";
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

function sourceSnapshotMismatch(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason: "SOURCE_SNAPSHOT_MISMATCH",
    category: "upstream",
    retryable: false,
    action: "none",
    details,
  });
}

function cursorInvalid(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "CURSOR_INVALID",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
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

function parseNonNegativeNumber(raw: unknown, multiplier = 1): number | null {
  const parsed = parsePrice(raw);
  if (parsed === null || parsed < 0) return null;
  const normalized = parsed * multiplier;
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function normalizeMarker(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const marker = String(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/&plus;|&#43;|&#x2b;/gi, "+")
    .replace(/&minus;|&#45;|&#x2d;/gi, "-")
    .replace(/＋/g, "+")
    .replace(/－/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return !marker || /^(?:--|---)$/.test(marker) ? null : marker;
}

function parseChange(
  rawChange: unknown,
  rawMarker?: unknown,
): { change: number | null; changeMarker: string | null } {
  const markers = new Set<string>();
  const explicitMarker = normalizeMarker(rawMarker);
  const explicitSign =
    explicitMarker === "+" || explicitMarker === "-" ? explicitMarker : null;
  if (explicitMarker && !explicitSign) markers.add(explicitMarker);

  if (typeof rawChange !== "string" && typeof rawChange !== "number") {
    return {
      change: null,
      changeMarker: markers.size > 0 ? [...markers].join(" ") : null,
    };
  }
  let normalized = String(rawChange)
    .replace(/,/g, "")
    .replace(/＋/g, "+")
    .replace(/－/g, "-")
    .trim();
  if (explicitSign && !/^[+-]/.test(normalized)) {
    normalized = `${explicitSign}${normalized}`;
  }
  if (!normalized || /^(?:--|---)$/.test(normalized)) {
    return {
      change: null,
      changeMarker: markers.size > 0 ? [...markers].join(" ") : null,
    };
  }
  const match = /^(.*?)([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(normalized);
  if (!match) {
    markers.add(normalized);
    return { change: null, changeMarker: [...markers].join(" ") };
  }
  const prefix = match[1].trim();
  if (prefix) markers.add(prefix);
  const change = Number(match[2]);
  return {
    change: Number.isFinite(change) ? change : null,
    changeMarker: markers.size > 0 ? [...markers].join(" ") : null,
  };
}

interface RawBarValues {
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  volume?: unknown;
  turnover?: unknown;
  tradeCount?: unknown;
  change?: unknown;
  changeMarker?: unknown;
  volumeMultiplier?: number;
  turnoverMultiplier?: number;
}

function normalizeBar(
  date: string,
  market: CompanyMarket,
  raw: RawBarValues,
): OhlcBar {
  const normalized = [raw.open, raw.high, raw.low, raw.close]
    .map(parsePrice)
    .map((value) => (value !== null && value > 0 ? value : null));
  const volumeShares = parseNonNegativeNumber(
    raw.volume,
    raw.volumeMultiplier ?? 1,
  );
  const turnoverTwd = parseNonNegativeNumber(
    raw.turnover,
    raw.turnoverMultiplier ?? 1,
  );
  const tradeCount = parseNonNegativeNumber(raw.tradeCount);
  const { change, changeMarker } = parseChange(raw.change, raw.changeMarker);
  const traded =
    normalized.some((value) => value !== null) ||
    [volumeShares, turnoverTwd, tradeCount].some(
      (value) => value !== null && value > 0,
    );
  const officialNoTrade =
    !traded && volumeShares === 0 && turnoverTwd === 0 && tradeCount === 0;
  const missingFields = (
    [
      ["open", normalized[0]],
      ["high", normalized[1]],
      ["low", normalized[2]],
      ["close", normalized[3]],
      ["volumeShares", volumeShares],
      ["turnoverTwd", turnoverTwd],
      ["tradeCount", tradeCount],
      ["change", change],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([field]) => field satisfies OhlcMissingField);
  return {
    date,
    open: normalized[0],
    high: normalized[1],
    low: normalized[2],
    close: normalized[3],
    volumeShares,
    turnoverTwd,
    tradeCount,
    change,
    changeMarker,
    market,
    status: traded ? "traded" : "no_trade",
    qualityStatus: officialNoTrade
      ? "official_no_trade"
      : missingFields.length === 0
        ? "complete"
        : "partial",
    missingFields,
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

function findOptionalField(fields: unknown[], names: string[]): number | null {
  const normalized = fields.map((field) => String(field).replace(/\s+/g, ""));
  const index = normalized.findIndex((field) => names.includes(field));
  return index < 0 ? null : index;
}

interface MeasuredField {
  index: number;
  normalization: PriceUnitNormalization;
}

function findMeasuredField(
  fields: unknown[],
  candidates: Array<{
    names: string[];
    normalization: PriceUnitNormalization;
  }>,
): MeasuredField | null {
  for (const candidate of candidates) {
    const index = findOptionalField(fields, candidate.names);
    if (index !== null) return { index, normalization: candidate.normalization };
  }
  return null;
}

const SHARE_NORMALIZATION = {
  sourceUnit: "share",
  outputUnit: "share",
  multiplier: 1,
} as const satisfies PriceUnitNormalization;
const LOT_NORMALIZATION = {
  sourceUnit: "lot",
  outputUnit: "share",
  multiplier: 1000,
} as const satisfies PriceUnitNormalization;
const TWD_NORMALIZATION = {
  sourceUnit: "TWD",
  outputUnit: "TWD",
  multiplier: 1,
} as const satisfies PriceUnitNormalization;
const TWD_THOUSAND_NORMALIZATION = {
  sourceUnit: "TWD_thousand",
  outputUnit: "TWD",
  multiplier: 1000,
} as const satisfies PriceUnitNormalization;
const TRADE_NORMALIZATION = {
  sourceUnit: "trade",
  outputUnit: "trade",
  multiplier: 1,
} as const satisfies PriceUnitNormalization;

function sourceNormalization(
  volumeShares: PriceUnitNormalization = SHARE_NORMALIZATION,
  turnoverTwd: PriceUnitNormalization = TWD_NORMALIZATION,
): PriceSource["normalization"] {
  return { volumeShares, turnoverTwd, tradeCount: TRADE_NORMALIZATION };
}

function rawAt(row: unknown[], index: number | null): unknown {
  return index === null ? undefined : row[index];
}

function assertDeclaredRowCount(
  rawCount: unknown,
  actualCount: number,
  context: string,
): void {
  if (rawCount === undefined || rawCount === null || rawCount === "") return;
  const normalized =
    typeof rawCount === "number"
      ? rawCount
      : Number(String(rawCount).replace(/,/g, "").trim());
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 的官方宣告筆數格式錯誤。`, {
      declaredCount: rawCount,
      actualCount,
    });
  }
  if (normalized !== actualCount) {
    fail("UPSTREAM_BAD_RESPONSE", `${context} 的官方宣告筆數與資料列數不一致。`, {
      declaredCount: normalized,
      actualCount,
    });
  }
}

function sameNormalizedBar(left: OhlcBar, right: OhlcBar): boolean {
  return (
    left.date === right.date &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volumeShares === right.volumeShares &&
    left.turnoverTwd === right.turnoverTwd &&
    left.tradeCount === right.tradeCount &&
    left.change === right.change &&
    left.changeMarker === right.changeMarker &&
    left.status === right.status &&
    left.qualityStatus === right.qualityStatus &&
    left.missingFields.join("|") === right.missingFields.join("|")
  );
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
    cursorInvalid("cursor 格式錯誤。");
  }
  try {
    const encoded = cursor.slice(CURSOR_PREFIX.length);
    const [body, checksum, ...extra] = encoded.split(".");
    const expected = createHash("sha256")
      .update(`mopsfin-price-cursor-v1:${body}`)
      .digest("base64url")
      .slice(0, 16);
    if (!body || !checksum || extra.length > 0 || checksum !== expected) {
      cursorInvalid("cursor checksum 驗證失敗。");
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
      !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(parsed.nextMonth)
    ) {
      cursorInvalid("cursor 內容格式錯誤。");
    }
    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof MopsfinError) throw error;
    cursorInvalid("cursor 無法解析。");
  }
}

function uniqueSources(results: MonthResult[]): PriceSource[] {
  const byRequest = new Map<string, PriceSource>();
  for (const result of results) {
    const key = `${result.market}:${result.source.sourceUrl}:${result.source.dataMonth ?? ""}:${JSON.stringify(result.source.normalization)}`;
    byRequest.set(key, result.source);
  }
  return [...byRequest.values()].sort((left, right) => {
    const marketOrder = left.market.localeCompare(right.market);
    return marketOrder !== 0
      ? marketOrder
      : (left.dataMonth ?? "").localeCompare(right.dataMonth ?? "") ||
          left.sourceUrl.localeCompare(right.sourceUrl);
  });
}

export class PriceClient {
  private readonly currentTtlMs: number;
  private readonly historicalTtlMs: number;
  private readonly monthsPerPage: number;
  private readonly concurrency: number;
  private readonly currentLoader: OfficialJsonLoader;
  private readonly historicalLoader: OfficialJsonLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CompanyMasterLike = companyMasterClient,
    options: PriceClientOptions = {},
  ) {
    this.currentTtlMs = options.currentTtlMs ?? 5 * 60 * 1000;
    this.historicalTtlMs = options.historicalTtlMs ?? 24 * 60 * 60 * 1000;
    this.monthsPerPage = options.monthsPerPage ?? 12;
    this.concurrency = options.concurrency ?? 2;
    this.currentLoader = new OfficialJsonLoader(fetchImpl, now, {
      ...options,
      maxAttempts: options.maxAttempts ?? 3,
      cacheTtlMs: this.currentTtlMs,
    });
    this.historicalLoader = new OfficialJsonLoader(fetchImpl, now, {
      ...options,
      maxAttempts: options.maxAttempts ?? 3,
      cacheTtlMs: this.historicalTtlMs,
    });
  }

  async getExactCurrentCompanyOhlc(
    query: ExactCurrentCompanyOhlcQuery,
  ): Promise<ExactCurrentCompanyOhlcResult> {
    const { company } = query;
    if (!/^[1-9]\d{3}$/.test(company.code)) {
      fail("INVALID_ARGUMENT", "company.code 必須是首碼非 0 的四碼公司股票代號。", {
        companyCode: company.code,
      });
    }
    if (!company.shortName.trim()) {
      fail("INVALID_ARGUMENT", "company.shortName 不得為空。", {
        companyCode: company.code,
      });
    }
    const expectedExchange = company.market === "listed" ? "TWSE" : "TPEx";
    if (company.exchange !== expectedExchange) {
      fail("INVALID_ARGUMENT", "company.market 與 company.exchange 不一致。", {
        companyCode: company.code,
        market: company.market,
        exchange: company.exchange,
        expectedExchange,
      });
    }
    parseIsoDate(query.date, "date");
    const today = taipeiToday(this.now());
    if (query.date > today) {
      fail("INVALID_ARGUMENT", "date 不得晚於台北今日日期。", {
        date: query.date,
        today,
      });
    }
    if (
      company.market === "listed" &&
      query.date < TWSE_STOCK_SUPPORTED_FROM
    ) {
      fail("INVALID_ARGUMENT", "上市個股月資料自 2010-01-04 起提供。", {
        supportedFrom: TWSE_STOCK_SUPPORTED_FROM,
      });
    }
    if (query.date < TPEX_STOCK_SUPPORTED_FROM) {
      fail("INVALID_ARGUMENT", "date 早於官方個股歷史支援範圍。", {
        supportedFrom: TPEX_STOCK_SUPPORTED_FROM,
      });
    }

    const dataMonth = monthOf(query.date);
    let monthResult = await this.getStockMonth(
      company.code,
      dataMonth,
      company.market,
    );
    const initialCacheStatus = monthResult.source.cache?.status ?? null;
    let bars = monthResult.bars.filter((bar) => bar.date === query.date);
    let cacheRefreshAttempted = false;
    const initialRetrievedAtMs = Date.parse(monthResult.source.retrievedAt);
    const sessionCompletionMs = Date.parse(
      `${query.date}T${COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI}+08:00`,
    );
    const cachedSnapshotPredatesCompletion =
      Number.isFinite(initialRetrievedAtMs) &&
      initialRetrievedAtMs < sessionCompletionMs;
    if (
      initialCacheStatus === "hit" &&
      (bars.length === 0 || cachedSnapshotPredatesCompletion)
    ) {
      this.invalidateJson(new URL(monthResult.source.sourceUrl));
      monthResult = await this.getStockMonth(
        company.code,
        dataMonth,
        company.market,
      );
      bars = monthResult.bars.filter((bar) => bar.date === query.date);
      cacheRefreshAttempted = true;
    }

    if (
      monthResult.snapshotIdentity === "unverified_empty" ||
      monthResult.source.snapshotIdentity === "unverified_empty"
    ) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "官方單股 OHLC 空回應缺少可核對的 requested-month snapshot identity。",
        {
          reason: "EXACT_STOCK_OHLC_SNAPSHOT_UNVERIFIED",
          category: "upstream",
          retryable: true,
          action: "retry",
          details: {
            companyCode: company.code,
            market: company.market,
            requestedMonth: dataMonth,
            sourceUrl: monthResult.source.sourceUrl,
            cacheRefreshAttempted,
          },
        },
      );
    }
    if (
      monthResult.market !== company.market ||
      monthResult.source.market !== company.market ||
      monthResult.snapshotIdentity !== "verified" ||
      monthResult.source.snapshotIdentity !== "verified" ||
      monthResult.source.dataMonth !== dataMonth ||
      monthResult.source.dataDate !== undefined
    ) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "官方單股 OHLC source identity 與 requested current company/month 不符。",
        {
          companyCode: company.code,
          market: company.market,
          requestedMonth: dataMonth,
          sourceMarket: monthResult.source.market,
          sourceDataMonth: monthResult.source.dataMonth ?? null,
          sourceDataDate: monthResult.source.dataDate ?? null,
          snapshotIdentity:
            monthResult.snapshotIdentity ??
            monthResult.source.snapshotIdentity ??
            null,
        },
      );
    }
    const { dataDate: _dataDate, ...monthSource } = monthResult.source;

    return {
      query: {
        companyCode: company.code,
        market: company.market,
        date: query.date,
      },
      companyCode: company.code,
      market: company.market,
      observedName: monthResult.observedName?.trim() || null,
      dataMonth,
      selectedBarDate: bars.length === 1 ? bars[0].date : null,
      coverageComplete: true,
      bars,
      source: {
        ...monthSource,
        snapshotIdentity: "verified",
        dataMonth,
      },
      cacheRefresh: {
        attempted: cacheRefreshAttempted,
        initialCacheStatus,
      },
    };
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
        cursorInvalid("cursor 與本次 OHLC 查詢範圍不符。");
      }
      nextMonth = cursor.nextMonth;
      sawData = cursor.sawData;
      if (nextMonth < monthOf(query.startDate) || nextMonth > monthOf(query.endDate)) {
        cursorInvalid("cursor 的續查月份超出查詢範圍。");
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
        const existing = byDate.get(bar.date);
        if (existing) {
          if (
            existing.market === bar.market ||
            !sameNormalizedBar(existing, bar)
          ) {
            fail(
              "UPSTREAM_BAD_RESPONSE",
              existing.market === bar.market
                ? "同一股票同一市場同一日期出現重複成交資料。"
                : "同一股票同一日期出現不一致的跨市場成交資料。",
              {
                companyCode: query.companyCode,
                date: bar.date,
                markets: [existing.market, bar.market],
              },
            );
          }
          if (
            bar.market === currentCompany?.market ||
            (!currentCompany && bar.market === "listed")
          ) {
            byDate.set(bar.date, bar);
          }
          continue;
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
        sources: uniqueSources(monthResults),
      });
    }

    const dataQualityComplete = bars.every(
      (bar) => bar.qualityStatus !== "partial",
    );
    const warnings = [
      "價格為官方原始未還原權值日線，不含 adjusted close；不可直接視為含公司行動調整的報酬率。",
      "只回實際官方交易日期；週末、休市與停牌日期不補合成 bar。",
    ];
    if (!dataQualityComplete) {
      warnings.push(
        "部分 bars 的官方成交或價格欄位缺失／無法解析；請依 qualityStatus 與 missingFields 判斷。",
      );
    }
    if (observedNames.length > 1) {
      warnings.push(
        `此代號在查詢相關資料中出現多個名稱：${observedNames.join("、")}；可能是改名或代號重用。`,
      );
    }
    if (!coverageComplete) {
      warnings.push("本頁尚未涵蓋完整 requested range；請使用 nextCursor 繼續查詢。");
    }
    const unverifiedEmptySnapshots = monthResults.filter(
      (result) => result.snapshotIdentity === "unverified_empty",
    );
    if (unverifiedEmptySnapshots.length > 0) {
      warnings.push(
        `${unverifiedEmptySnapshots.length} 個官方 no-data response 未提供可核對的 title/date；已保留 attempted source URL 並視為空回應，但 source.dataMonth 省略，不能宣稱該空回應的 requested-month snapshot identity 已驗證。`,
      );
    }

    return {
      query,
      companyCode: query.companyCode,
      observedNames,
      currency: "TWD",
      timezone: "Asia/Taipei",
      interval: "1d",
      priceBasis: "raw_unadjusted",
      dataQualityComplete,
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
    const normalizedRequestedCodes = query.companyCodes?.map((code) => code.trim());
    const requestedCodes = normalizedRequestedCodes
      ? [...new Set(normalizedRequestedCodes)]
      : undefined;
    if (normalizedRequestedCodes && normalizedRequestedCodes.length === 0) {
      fail("INVALID_ARGUMENT", "company_codes 至少要有一個公司股票代號。");
    }
    if (normalizedRequestedCodes && normalizedRequestedCodes.length > 500) {
      fail("INVALID_ARGUMENT", "company_codes 最多只能指定 500 個代號。");
    }
    if (
      normalizedRequestedCodes &&
      requestedCodes?.length !== normalizedRequestedCodes.length
    ) {
      fail("INVALID_ARGUMENT", "company_codes 不得包含重複代號。");
    }
    if (requestedCodes?.some((code) => !/^\d{4}$/.test(code))) {
      fail("INVALID_ARGUMENT", "company_codes 只能包含四碼公司股票代號。");
    }
    const universePolicy = query.universePolicy ?? "compatible";
    if (
      universePolicy !== "compatible" &&
      universePolicy !== "strict_current_master"
    ) {
      fail("INVALID_ARGUMENT", "universe_policy 不支援指定的政策。");
    }
    if (universePolicy === "strict_current_master" && query.date !== "latest") {
      fail(
        "INVALID_ARGUMENT",
        "strict_current_master 只支援 date=latest，不能用目前母體驗證歷史日期。",
      );
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
    for (const result of results) {
      const sourceCodes = new Set<string>();
      for (const row of result.rows) {
        if (!row.code || !row.name) {
          fail("UPSTREAM_BAD_RESPONSE", "單日全市場行情包含空白代號或名稱。", {
            market: result.market,
            code: row.code,
            name: row.name,
          });
        }
        if (sourceCodes.has(row.code)) {
          fail("UPSTREAM_BAD_RESPONSE", "單日市場來源包含重複證券代號。", {
            market: result.market,
            code: row.code,
            dataDate: result.dataDate,
          });
        }
        sourceCodes.add(row.code);
      }
    }

    const classificationMethod = query.date === "latest"
      ? "current_master"
      : "historical_code_rule";
    const classificationPolicy = query.date === "latest"
      ? universePolicy === "strict_current_master"
        ? "current_master_strict"
        : "current_master_with_code_fallback"
      : "historical_code_rule";
    let allowedCurrentCodes: Set<string> | undefined;
    let currentMasterMarketByCode: Map<string, CompanyMarket> | undefined;
    let reconciliation: DailyMarketReconciliation[] = [];
    if (query.date === "latest") {
      const master = await this.companyMaster.listCompanies({
        market: query.market,
        includeFinancial: true,
        includeKy: true,
      });
      allowedCurrentCodes = new Set(master.companies.map((company) => company.code));
      currentMasterMarketByCode = new Map(
        master.companies.map((company) => [company.code, company.market]),
      );
      reconciliation = results.map((result) => {
        const marketMasterCodes = new Set(
          master.companies
            .filter((company) => company.market === result.market)
            .map((company) => company.code),
        );
        const sourceCompanyCodes = new Set(
          result.rows
            .filter(
              (row) => !/-DR$/i.test(row.name) && /^[1-9]\d{3}$/.test(row.code),
            )
            .map((row) => row.code),
        );
        const matchedCount = [...marketMasterCodes].filter((code) =>
          sourceCompanyCodes.has(code),
        ).length;
        const marketOnlyCodes = [...sourceCompanyCodes]
          .filter((code) => !marketMasterCodes.has(code))
          .sort();
        const masterMissingCodes = [...marketMasterCodes]
          .filter((code) => !sourceCompanyCodes.has(code))
          .sort();
        const matchRatio =
          marketMasterCodes.size === 0
            ? sourceCompanyCodes.size === 0
              ? 1
              : 0
            : Number((matchedCount / marketMasterCodes.size).toFixed(6));
        const coverageComplete =
          marketOnlyCodes.length === 0 && masterMissingCodes.length === 0;
        return {
          market: result.market,
          masterCount: marketMasterCodes.size,
          sourceRowCount: sourceCompanyCodes.size,
          matchedCount,
          marketOnlyCodes,
          masterMissingCodes,
          matchRatio,
          coverageComplete,
        };
      });
      const coverageInsufficient = reconciliation.some((item) =>
        universePolicy === "strict_current_master"
          ? !item.coverageComplete
          : item.matchRatio < 0.95,
      );
      if (coverageInsufficient) {
        fail(
          "INCOMPLETE_COVERAGE",
          universePolicy === "strict_current_master"
            ? "最新全市場行情未與目前公司母體完全吻合。"
            : "最新全市場行情與目前公司母體吻合率低於 95%。",
          { universePolicy, reconciliation },
        );
      }
    }
    const universeCoverageVerified =
      query.date === "latest" &&
      reconciliation.every((item) => item.coverageComplete);

    let rows = results.flatMap((result) => result.rows);
    rows = rows.filter((row) => {
      if (/-DR$/i.test(row.name)) return false;
      const eligibleCompanyCode = /^[1-9]\d{3}$/.test(row.code);
      if (!eligibleCompanyCode) return false;
      if (classificationPolicy === "current_master_strict") {
        return allowedCurrentCodes?.has(row.code) ?? false;
      }
      return true;
    });
    const currentMasterFallbackCodes = new Set(
      query.date === "latest"
        ? rows
            .filter((row) => !allowedCurrentCodes?.has(row.code))
            .map((row) => row.code)
        : [],
    );
    if (requestedCodes) {
      const selected = new Set(requestedCodes);
      rows = rows.filter((row) => selected.has(row.code));
    }
    rows.sort((left, right) => left.code.localeCompare(right.code));
    const byCode = new Map<string, DailyRow>();
    for (const row of rows) {
      const existing = byCode.get(row.code);
      if (existing) {
        if (
          existing.market === row.market ||
          existing.name !== row.name ||
          !sameNormalizedBar(existing, row)
        ) {
          fail(
            "UPSTREAM_BAD_RESPONSE",
            "單日全市場行情出現不一致的跨市場重複公司代號。",
            {
              code: row.code,
              dataDate: dates[0],
              markets: [existing.market, row.market],
            },
          );
        }
        const preferredMarket =
          currentMasterMarketByCode?.get(row.code) ?? "listed";
        if (row.market === preferredMarket) byCode.set(row.code, row);
        continue;
      }
      byCode.set(row.code, row);
    }
    rows = [...byCode.values()].sort((left, right) =>
      left.code.localeCompare(right.code),
    );

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

    const dataQualityComplete = rows.every(
      (row) => row.qualityStatus !== "partial",
    );
    const warnings = [
      "價格為官方原始未還原權值日線，不含 adjusted close；不可直接視為含公司行動調整的報酬率。",
      query.date === "latest"
        ? "latest 代表最近完成交易日，不是盤中即時報價。"
        : "歷史官方市場 snapshot 以四碼、首碼非 0 且非 -DR 的證券列辨識公司股票；不可據此推論歷史母體已被獨立驗證。",
    ];
    if (!dataQualityComplete) {
      warnings.push(
        "部分 bars 的官方成交或價格欄位缺失／無法解析；請依 qualityStatus 與 missingFields 判斷。",
      );
    }
    if (missingCompanyCodes.length > 0) {
      warnings.push(`以下代號未出現在指定市場日期：${missingCompanyCodes.join("、")}。`);
    }
    const returnedFallbackCodes = [...currentMasterFallbackCodes].filter((code) =>
      returnedCodes.has(code),
    );
    if (returnedFallbackCodes.length > 0) {
      warnings.push(
        `以下最新行情代號尚未出現在目前公司母體快照，但 compatible 政策依公司股票代號規則保留：${returnedFallbackCodes.join("、")}。`,
      );
    }
    if (query.date === "latest" && !universeCoverageVerified) {
      warnings.push(
        "最新行情公司集合通過 compatible 防截斷門檻但未與目前 master 完全吻合；請保留 reconciliation 差異。",
      );
    }

    return {
      query: {
        market: query.market,
        date: query.date,
        ...(requestedCodes ? { companyCodes: requestedCodes } : {}),
        universePolicy,
      },
      dataDate: dates[0],
      currency: "TWD",
      timezone: "Asia/Taipei",
      interval: "1d",
      priceBasis: "raw_unadjusted",
      classificationMethod,
      classificationPolicy,
      coverageComplete: true,
      universeCoverageVerified,
      dataQualityComplete,
      reconciliation,
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
          undefined,
          undefined,
          undefined,
          month,
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
      try {
        return this.parseTwseStockMonth(
          snapshot,
          url.toString(),
          month,
          code,
        );
      } catch (error) {
        if (
          error instanceof MopsfinError &&
          error.reason === "SOURCE_SNAPSHOT_MISMATCH"
        ) {
          this.invalidateJson(url);
        }
        throw error;
      }
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
    try {
      return this.parseTpexStockMonth(
        snapshot,
        url.toString(),
        month,
        code,
      );
    } catch (error) {
      if (
        error instanceof MopsfinError &&
        error.reason === "SOURCE_SNAPSHOT_MISMATCH"
      ) {
        this.invalidateJson(url);
      }
      throw error;
    }
  }

  private parseTwseStockMonth(
    snapshot: JsonSnapshot,
    sourceUrl: string,
    dataMonth: string,
    companyCode: string,
  ): MonthResult {
    const payload = snapshot.payload as Record<string, unknown>;
    const stat = String(payload?.stat ?? "");
    const defaultSource = this.priceSource(
      "listed",
      "臺灣證券交易所－個股日成交資訊",
      sourceUrl,
      snapshot.retrievedAt,
      snapshot.cache,
      undefined,
      undefined,
      dataMonth,
    );
    const title = typeof payload.title === "string" ? payload.title : "";
    const titleMatch = /^\s*(\d{2,3})年\s*(\d{1,2})月\s+(\S+)(?:\s+(.+?)\s+各日成交資訊)?\s*$/.exec(
      title,
    );
    const reportedMonths: string[] = [];
    if (title) {
      if (!titleMatch) {
        sourceSnapshotMismatch("TWSE 個股 OHLC 無法核對 requested month snapshot identity。", {
          market: "listed",
          companyCode,
          requestedMonth: dataMonth,
          sourceUrl,
          identityField: "title",
        });
      }
      const titleYear = Number(titleMatch[1]) + 1911;
      const titleMonth = Number(titleMatch[2]);
      if (titleMonth < 1 || titleMonth > 12) {
        sourceSnapshotMismatch("TWSE 個股 OHLC title 月份無效。", {
          market: "listed",
          companyCode,
          requestedMonth: dataMonth,
          reportedYear: titleYear,
          reportedMonthNumber: titleMonth,
          sourceUrl,
        });
      }
      reportedMonths.push(
        `${String(titleYear).padStart(4, "0")}-${String(titleMonth).padStart(2, "0")}`,
      );
      if (titleMatch[3].toLowerCase() !== companyCode.toLowerCase()) {
        sourceSnapshotMismatch("TWSE 個股 OHLC 回傳公司代號與 requested company 不符。", {
          market: "listed",
          companyCode,
          reportedCompanyCode: titleMatch[3],
          requestedMonth: dataMonth,
          sourceUrl,
        });
      }
    }
    if (payload.date !== undefined && payload.date !== null) {
      let reportedDate: string;
      try {
        reportedDate = parseCompactGregorianDate(payload.date);
      } catch {
        sourceSnapshotMismatch("TWSE 個股 OHLC date 無法核對 requested month。", {
          market: "listed",
          companyCode,
          requestedMonth: dataMonth,
          sourceUrl,
          identityField: "date",
        });
      }
      reportedMonths.push(monthOf(reportedDate));
    }
    if (reportedMonths.some((reportedMonth) => reportedMonth !== dataMonth)) {
      sourceSnapshotMismatch("TWSE 個股 OHLC 回傳月份與 requested month 不符。", {
        market: "listed",
        companyCode,
        requestedMonth: dataMonth,
        reportedMonths: [...new Set(reportedMonths)],
        sourceUrl,
      });
    }
    if (stat !== "OK") {
      if (/沒有符合條件/.test(stat)) {
        if (reportedMonths.length > 0) {
          return {
            market: "listed",
            source: defaultSource,
            snapshotIdentity: "verified",
            bars: [],
          };
        }
        return {
          market: "listed",
          source: this.priceSource(
            "listed",
            "臺灣證券交易所－個股日成交資訊",
            sourceUrl,
            snapshot.retrievedAt,
            snapshot.cache,
            undefined,
            undefined,
            undefined,
            "unverified_empty",
          ),
          snapshotIdentity: "unverified_empty",
          bars: [],
        };
      }
      fail("UPSTREAM_BAD_RESPONSE", `TWSE 個股 OHLC 回傳異常：${stat || "未知狀態"}`);
    }
    if (reportedMonths.length === 0) {
      sourceSnapshotMismatch("TWSE 個股 OHLC 無法核對 requested month snapshot identity。", {
        market: "listed",
        companyCode,
        requestedMonth: dataMonth,
        sourceUrl,
        identityFields: ["title", "date"],
      });
    }
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    const data = Array.isArray(payload.data) ? payload.data : [];
    assertDeclaredRowCount(payload.total, data.length, "TWSE 個股 OHLC");
    if (fields.length === 0) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE 個股 OHLC 回應缺少欄位定義。");
    }
    const dateIndex = findField(fields, ["日期"]);
    const openIndex = findField(fields, ["開盤價", "開盤"]);
    const highIndex = findField(fields, ["最高價", "最高"]);
    const lowIndex = findField(fields, ["最低價", "最低"]);
    const closeIndex = findField(fields, ["收盤價", "收盤"]);
    const volume = findMeasuredField(fields, [
      { names: ["成交股數"], normalization: SHARE_NORMALIZATION },
      { names: ["成交張數"], normalization: LOT_NORMALIZATION },
    ]);
    const turnover = findMeasuredField(fields, [
      { names: ["成交金額", "成交金額(元)"], normalization: TWD_NORMALIZATION },
      {
        names: ["成交仟元", "成交金額(仟元)"],
        normalization: TWD_THOUSAND_NORMALIZATION,
      },
    ]);
    const tradeCountIndex = findOptionalField(fields, ["成交筆數", "筆數"]);
    const changeIndex = findOptionalField(fields, ["漲跌價差", "漲跌"]);
    const changeMarkerIndex = findOptionalField(fields, ["註記", "漲跌(+/-)"]);
    const normalization = sourceNormalization(
      volume?.normalization ?? SHARE_NORMALIZATION,
      turnover?.normalization ?? TWD_NORMALIZATION,
    );
    const source = { ...defaultSource, normalization };
    const bars = data.map((raw) => {
      if (!Array.isArray(raw)) {
        fail("UPSTREAM_BAD_RESPONSE", "TWSE 個股 OHLC 資料列格式錯誤。");
      }
      const date = parseRocDate(raw[dateIndex]);
      if (monthOf(date) !== dataMonth) {
        sourceSnapshotMismatch("TWSE 個股 OHLC 資料列月份與 requested month 不符。", {
          market: "listed",
          companyCode,
          requestedMonth: dataMonth,
          rowDate: date,
          sourceUrl,
        });
      }
      return normalizeBar(
        date,
        "listed",
        {
          open: raw[openIndex],
          high: raw[highIndex],
          low: raw[lowIndex],
          close: raw[closeIndex],
          volume: rawAt(raw, volume?.index ?? null),
          turnover: rawAt(raw, turnover?.index ?? null),
          tradeCount: rawAt(raw, tradeCountIndex),
          change: rawAt(raw, changeIndex),
          changeMarker: rawAt(raw, changeMarkerIndex),
          volumeMultiplier: volume?.normalization.multiplier,
          turnoverMultiplier: turnover?.normalization.multiplier,
        },
      );
    });
    return {
      market: "listed",
      source,
      snapshotIdentity: "verified",
      observedName: titleMatch?.[4]?.trim(),
      bars,
    };
  }

  private parseTpexStockMonth(
    snapshot: JsonSnapshot,
    sourceUrl: string,
    dataMonth: string,
    companyCode: string,
  ): MonthResult {
    const payload = snapshot.payload as Record<string, unknown>;
    const defaultSource = this.priceSource(
      "otc",
      "證券櫃檯買賣中心－個股日成交資訊",
      sourceUrl,
      snapshot.retrievedAt,
      snapshot.cache,
      undefined,
      sourceNormalization(LOT_NORMALIZATION, TWD_THOUSAND_NORMALIZATION),
      dataMonth,
    );
    let reportedDate: string;
    try {
      reportedDate = parseCompactGregorianDate(payload?.date);
    } catch {
      sourceSnapshotMismatch("TPEx 個股 OHLC date 無法核對 requested month。", {
        market: "otc",
        companyCode,
        requestedMonth: dataMonth,
        sourceUrl,
        identityField: "date",
      });
    }
    const reportedCompanyCode = String(payload?.code ?? "").trim();
    if (
      monthOf(reportedDate) !== dataMonth ||
      reportedCompanyCode.toLowerCase() !== companyCode.toLowerCase()
    ) {
      sourceSnapshotMismatch("TPEx 個股 OHLC snapshot identity 與 request 不符。", {
        market: "otc",
        companyCode,
        reportedCompanyCode: reportedCompanyCode || null,
        requestedMonth: dataMonth,
        reportedMonth: monthOf(reportedDate),
        sourceUrl,
      });
    }
    if (String(payload?.stat ?? "") !== "ok") {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 個股 OHLC 回傳狀態錯誤。", {
        stat: payload?.stat,
      });
    }
    const tables = Array.isArray(payload.tables) ? payload.tables : [];
    const table = tables[0] as Record<string, unknown> | undefined;
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    const data = Array.isArray(table?.data) ? table.data : [];
    assertDeclaredRowCount(table?.totalCount, data.length, "TPEx 個股 OHLC");
    if (fields.length === 0) {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 個股 OHLC 回應缺少欄位定義。");
    }
    const dateIndex = findField(fields, ["日期"]);
    const openIndex = findField(fields, ["開盤"]);
    const highIndex = findField(fields, ["最高"]);
    const lowIndex = findField(fields, ["最低"]);
    const closeIndex = findField(fields, ["收盤"]);
    const volume = findMeasuredField(fields, [
      { names: ["成交股數"], normalization: SHARE_NORMALIZATION },
      { names: ["成交張數"], normalization: LOT_NORMALIZATION },
    ]);
    const turnover = findMeasuredField(fields, [
      { names: ["成交金額", "成交金額(元)"], normalization: TWD_NORMALIZATION },
      {
        names: ["成交仟元", "成交金額(仟元)"],
        normalization: TWD_THOUSAND_NORMALIZATION,
      },
    ]);
    const tradeCountIndex = findOptionalField(fields, ["成交筆數", "筆數"]);
    const changeIndex = findOptionalField(fields, ["漲跌價差", "漲跌"]);
    const changeMarkerIndex = findOptionalField(fields, ["註記", "漲跌(+/-)"]);
    const source = {
      ...defaultSource,
      normalization: sourceNormalization(
        volume?.normalization ?? LOT_NORMALIZATION,
        turnover?.normalization ?? TWD_THOUSAND_NORMALIZATION,
      ),
    };
    const bars = data.map((raw) => {
      if (!Array.isArray(raw)) {
        fail("UPSTREAM_BAD_RESPONSE", "TPEx 個股 OHLC 資料列格式錯誤。");
      }
      const date = parseRocDate(raw[dateIndex]);
      if (monthOf(date) !== dataMonth) {
        sourceSnapshotMismatch("TPEx 個股 OHLC 資料列月份與 requested month 不符。", {
          market: "otc",
          companyCode,
          requestedMonth: dataMonth,
          rowDate: date,
          sourceUrl,
        });
      }
      return normalizeBar(
        date,
        "otc",
        {
          open: raw[openIndex],
          high: raw[highIndex],
          low: raw[lowIndex],
          close: raw[closeIndex],
          volume: rawAt(raw, volume?.index ?? null),
          turnover: rawAt(raw, turnover?.index ?? null),
          tradeCount: rawAt(raw, tradeCountIndex),
          change: rawAt(raw, changeIndex),
          changeMarker: rawAt(raw, changeMarkerIndex),
          volumeMultiplier: volume?.normalization.multiplier,
          turnoverMultiplier: turnover?.normalization.multiplier,
        },
      );
    });
    return {
      market: "otc",
      source,
      snapshotIdentity: "verified",
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
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fail("UPSTREAM_BAD_RESPONSE", "TWSE 最新行情包含非物件資料列。");
      }
      const row = raw as Record<string, unknown>;
      const date = parseCompactRocDate(row.Date);
      return {
        code: String(row.Code ?? "").trim(),
        name: String(row.Name ?? "").trim(),
        ...normalizeBar(
          date,
          "listed",
          {
            open: row.OpeningPrice,
            high: row.HighestPrice,
            low: row.LowestPrice,
            close: row.ClosingPrice,
            volume: row.TradeVolume,
            turnover: row.TradeValue,
            tradeCount: row.Transaction,
            change: row.Change,
          },
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
        snapshot.cache,
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
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fail("UPSTREAM_BAD_RESPONSE", "TPEx 最新行情包含非物件資料列。");
      }
      const row = raw as Record<string, unknown>;
      const date = parseCompactRocDate(row.Date);
      return {
        code: String(row.SecuritiesCompanyCode ?? "").trim(),
        name: String(row.CompanyName ?? "").trim(),
        ...normalizeBar(date, "otc", {
          open: row.Open,
          high: row.High,
          low: row.Low,
          close: row.Close,
          volume: row.TradingShares,
          turnover: row.TransactionAmount,
          tradeCount: row.TransactionNumber,
          change: row.Change,
        }),
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
        snapshot.cache,
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
      return (
        Array.isArray(fields) &&
        findOptionalField(fields, ["證券代號"]) !== null &&
        findOptionalField(fields, ["收盤價"]) !== null
      );
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
        snapshot.cache,
        dataDate,
      ),
      {
        code: ["證券代號"],
        name: ["證券名稱"],
        open: ["開盤價"],
        high: ["最高價"],
        low: ["最低價"],
        close: ["收盤價"],
        change: ["漲跌價差", "漲跌"],
        changeMarker: ["漲跌(+/-)", "註記"],
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
        snapshot.cache,
        dataDate,
      ),
      {
        code: ["代號"],
        name: ["名稱"],
        open: ["開盤"],
        high: ["最高"],
        low: ["最低"],
        close: ["收盤"],
        change: ["漲跌", "漲跌價差"],
        changeMarker: ["註記", "漲跌(+/-)"],
      },
    );
  }

  private parseDailyTable(
    market: CompanyMarket,
    dataDate: string,
    table: Record<string, unknown> | undefined,
    source: PriceSource,
    names: Record<
      | "code"
      | "name"
      | "open"
      | "high"
      | "low"
      | "close"
      | "change"
      | "changeMarker",
      string[]
    >,
  ): DailyResult {
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    const data = Array.isArray(table?.data) ? table.data : [];
    assertDeclaredRowCount(
      table?.totalCount,
      data.length,
      `${source.sourceName} ${dataDate}`,
    );
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
      change: findOptionalField(fields, names.change),
      changeMarker: findOptionalField(fields, names.changeMarker),
    };
    const volume = findMeasuredField(fields, [
      { names: ["成交股數"], normalization: SHARE_NORMALIZATION },
      { names: ["成交張數"], normalization: LOT_NORMALIZATION },
    ]);
    const turnover = findMeasuredField(fields, [
      { names: ["成交金額", "成交金額(元)"], normalization: TWD_NORMALIZATION },
      {
        names: ["成交仟元", "成交金額(仟元)"],
        normalization: TWD_THOUSAND_NORMALIZATION,
      },
    ]);
    const tradeCountIndex = findOptionalField(fields, ["成交筆數", "筆數"]);
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
          {
            open: raw[indexes.open],
            high: raw[indexes.high],
            low: raw[indexes.low],
            close: raw[indexes.close],
            volume: rawAt(raw, volume?.index ?? null),
            turnover: rawAt(raw, turnover?.index ?? null),
            tradeCount: rawAt(raw, tradeCountIndex),
            change: rawAt(raw, indexes.change),
            changeMarker: rawAt(raw, indexes.changeMarker),
            volumeMultiplier: volume?.normalization.multiplier,
            turnoverMultiplier: turnover?.normalization.multiplier,
          },
        ),
      };
    });
    return {
      market,
      dataDate,
      source: {
        ...source,
        normalization: sourceNormalization(
          volume?.normalization ?? source.normalization.volumeShares,
          turnover?.normalization ?? source.normalization.turnoverTwd,
        ),
      },
      rows,
    };
  }

  private priceSource(
    market: CompanyMarket,
    sourceName: string,
    sourceUrl: string,
    retrievedAt: string,
    cache?: PriceSource["cache"],
    dataDate?: string,
    normalization: PriceSource["normalization"] = sourceNormalization(),
    dataMonth?: string,
    snapshotIdentity: NonNullable<PriceSource["snapshotIdentity"]> = "verified",
  ): PriceSource {
    return {
      market,
      sourceName,
      sourceUrl,
      retrievedAt,
      ...(cache ? { cache } : {}),
      snapshotIdentity,
      ...(dataDate ? { dataDate } : {}),
      ...(dataMonth ? { dataMonth } : {}),
      normalization,
    };
  }

  private async getJson(url: URL, ttlMs: number): Promise<JsonSnapshot> {
    const loader =
      ttlMs === this.currentTtlMs
        ? this.currentLoader
        : this.historicalLoader;
    return loader.get({
      market: url.hostname.includes("tpex.org.tw") ? "otc" : "listed",
      exchange: url.hostname.includes("tpex.org.tw") ? "TPEx" : "TWSE",
      sourceName: "官方 OHLC／行情資料",
      sourceUrl: url.toString(),
    });
  }

  private invalidateJson(url: URL): void {
    const key = url.toString();
    this.currentLoader.invalidate(key);
    this.historicalLoader.invalidate(key);
  }
}

export const priceClient = new PriceClient();
