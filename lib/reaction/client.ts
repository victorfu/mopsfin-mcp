import { createHash } from "node:crypto";

import { companyMasterClient } from "@/lib/company-master/client";
import type {
  CompanyMarket,
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import type { OfficialMarketClientOptions } from "@/lib/market-data/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { priceClient } from "@/lib/price/client";
import type {
  OhlcBar,
  PriceSource,
  StockOhlcQuery,
  StockOhlcResult,
} from "@/lib/price/types";

import { BenchmarkClient } from "./benchmark-client";
import {
  calculateAverageWindowSignal,
  calculatePricePathSignal,
  calculateRatioSignal,
  calculateReturnSignal,
  exactSessionWindow,
} from "./calculations";
import {
  benchmarkFingerprint,
  decodeReactionCursor,
  encodeReactionCursor,
  reactionQueryHash,
  type ReactionCursorPayload,
} from "./cursor";
import type {
  BenchmarkHistory,
  CompanyReactionSignals,
  ExcessReturnComparabilityReason,
  ReactionComparability,
  ReactionHorizon,
  ReturnReactionSignal,
  StockReactionSignalsQuery,
  StockReactionSignalsResult,
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

interface StockPriceLike {
  getStockOhlc(query: StockOhlcQuery): Promise<StockOhlcResult>;
}

interface BenchmarkLike {
  getHistory(market: CompanyMarket, months: string[]): Promise<BenchmarkHistory>;
}

interface ReactionClientOptions extends OfficialMarketClientOptions {
  concurrency?: number;
  benchmarkConcurrency?: number;
  benchmarkClient?: BenchmarkLike;
}

interface NormalizedQuery {
  companyCodes: string[];
  asOf: "latest" | string;
  horizons: ReactionHorizon[];
  pageSize: number;
  cursor?: string;
}

interface PlannedCompany {
  company: MasterCompany;
  startDate: string;
  endDate: string;
  workUnits: number;
}

interface LoadedStockHistory {
  noData: boolean;
  bars: OhlcBar[];
  observedNames: string[];
  sources: PriceSource[];
}

const WORK_UNIT_LIMIT = 48 as const;
const BENCHMARK_SUPPORTED_FROM = "1999-01-05";
const TWSE_STOCK_SUPPORTED_FROM = "2010-01-04";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_HORIZONS = new Set<ReactionHorizon>([5, 20, 60, 120]);

function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError(code, message, { details });
}

function cursorInvalid(message: string, details?: Record<string, unknown>): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "CURSOR_INVALID",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

function snapshotChanged(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "SNAPSHOT_CHANGED",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

function workBudgetExceeded(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "WORK_BUDGET_EXCEEDED",
    category: "input",
    retryable: false,
    action: "change_query",
  });
}

function parseIsoDate(raw: string, field: string): Date {
  if (!ISO_DATE.test(raw)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 YYYY-MM-DD 或 latest。`, {
      field,
      value: raw,
    });
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

function subtractDays(date: string, days: number): string {
  const parsed = parseIsoDate(date, "as_of");
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function addMonths(month: string, count: number): string {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + count, 1))
    .toISOString()
    .slice(0, 7);
}

function monthEnd(month: string): string {
  const [year, value] = addMonths(month, 1).split("-").map(Number);
  return new Date(Date.UTC(year, value - 1, 0)).toISOString().slice(0, 10);
}

function monthsBetween(startDate: string, endDate: string): string[] {
  const startMonth = monthOf(startDate);
  const endMonth = monthOf(endDate);
  const months: string[] = [];
  for (let month = startMonth; month <= endMonth; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
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

function normalizeQuery(query: StockReactionSignalsQuery, today: string): NormalizedQuery {
  if (
    !Array.isArray(query.companyCodes) ||
    query.companyCodes.length < 1 ||
    query.companyCodes.length > 50
  ) {
    fail("INVALID_ARGUMENT", "company_codes 必須包含 1 至 50 個公司股票代號。");
  }
  const companyCodes = query.companyCodes.map((code) =>
    typeof code === "string" ? code.trim() : String(code),
  );
  if (companyCodes.some((code) => !/^\d{4}$/.test(code))) {
    fail("INVALID_ARGUMENT", "company_codes 只能包含四碼公司股票代號。");
  }
  if (new Set(companyCodes).size !== companyCodes.length) {
    fail("INVALID_ARGUMENT", "company_codes 不得包含重複代號。");
  }
  if (!Array.isArray(query.horizons) || query.horizons.length < 1) {
    fail("INVALID_ARGUMENT", "horizons 至少要指定一個交易日視窗。");
  }
  if (
    query.horizons.some((horizon) => !ALLOWED_HORIZONS.has(horizon)) ||
    new Set(query.horizons).size !== query.horizons.length
  ) {
    fail("INVALID_ARGUMENT", "horizons 只能是不重複的 5、20、60、120 子集合。", {
      horizons: query.horizons,
    });
  }
  const horizons = [...query.horizons].sort(
    (left, right) => left - right,
  ) as ReactionHorizon[];
  const pageSize = query.pageSize ?? 10;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) {
    fail("INVALID_ARGUMENT", "page_size 必須是 1 至 10 的整數。", {
      pageSize: query.pageSize,
    });
  }
  if (query.asOf !== "latest") {
    parseIsoDate(query.asOf, "as_of");
    if (query.asOf > today) {
      fail("INVALID_ARGUMENT", "as_of 不得晚於台北今日日期。", { today });
    }
    if (query.asOf < BENCHMARK_SUPPORTED_FROM) {
      fail("INVALID_ARGUMENT", "as_of 早於 benchmark 官方歷史支援範圍。", {
        supportedFrom: BENCHMARK_SUPPORTED_FROM,
      });
    }
  }
  return {
    companyCodes,
    asOf: query.asOf,
    horizons,
    pageSize,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

function requestedMarkets(companies: MasterCompany[]): CompanyMarket[] {
  return (["listed", "otc"] as const).filter((market) =>
    companies.some((company) => company.market === market),
  );
}

function selectedMasterFingerprint(companies: MasterCompany[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        companies.map((company) => ({
          code: company.code,
          name: company.name,
          shortName: company.shortName,
          market: company.market,
          exchange: company.exchange,
          listingDate: company.listingDate,
        })),
      ),
    )
    .digest("hex");
}

function benchmarkMap(histories: BenchmarkHistory[]): Map<CompanyMarket, BenchmarkHistory> {
  return new Map(histories.map((history) => [history.market, history]));
}

function resolveBenchmarkAsOf(
  history: BenchmarkHistory,
  requested: "latest" | string,
  rangeEnd: string,
): string {
  if (requested !== "latest") {
    if (!history.bars.some((bar) => bar.date === requested)) {
      fail("NO_DATA", "as_of 不是指定市場的官方交易日。", {
        market: history.market,
        asOf: requested,
      });
    }
    return requested;
  }
  const resolved = history.bars
    .filter((bar) => bar.date <= rangeEnd)
    .at(-1)?.date;
  if (!resolved) {
    fail("NO_DATA", "latest 範圍內查無 benchmark 官方交易日。", {
      market: history.market,
      through: rangeEnd,
    });
  }
  return resolved;
}

function exactResolvedMap(
  values: Array<{ market: CompanyMarket; date: string }>,
): Map<CompanyMarket, string> {
  return new Map(values.map((value) => [value.market, value.date]));
}

function sameResolvedDates(
  left: Array<{ market: CompanyMarket; date: string }>,
  right: Array<{ market: CompanyMarket; date: string }>,
): boolean {
  const leftMap = exactResolvedMap(left);
  const rightMap = exactResolvedMap(right);
  return (
    leftMap.size === rightMap.size &&
    [...leftMap].every(([market, date]) => rightMap.get(market) === date)
  );
}

function estimatedStockWorkUnits(
  company: MasterCompany,
  startDate: string,
  endDate: string,
): number {
  const listingMonth = monthOf(company.listingDate);
  return monthsBetween(startDate, endDate).reduce((units, month) => {
    if (month < listingMonth) {
      return units + (monthEnd(month) >= TWSE_STOCK_SUPPORTED_FROM ? 2 : 1);
    }
    if (month === listingMonth) return units + 2;
    return units + 1;
  }, 0);
}

function uniquePriceSources(values: PriceSource[]): PriceSource[] {
  const seen = new Set<string>();
  return values.filter((source) => {
    const key = `${source.market}:${source.sourceUrl}:${source.dataDate ?? ""}:${source.dataMonth ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function noDataPriceSources(error: MopsfinError): PriceSource[] {
  const values = error.details?.sources;
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC dependency 的 NO_DATA sources 格式錯誤。");
  }
  const sources = values.filter((value): value is PriceSource => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const source = value as Partial<PriceSource>;
    return (
      (source.market === "listed" || source.market === "otc") &&
      typeof source.sourceName === "string" &&
      typeof source.sourceUrl === "string" &&
      typeof source.retrievedAt === "string" &&
      Boolean(source.normalization) &&
      typeof source.normalization === "object"
    );
  });
  if (sources.length !== values.length) {
    fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC dependency 的 NO_DATA sources 內容錯誤。");
  }
  return sources;
}

function sameBar(left: OhlcBar, right: OhlcBar): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparability(
  company: MasterCompany,
  bars: OhlcBar[],
  observedNames: string[],
  noStockData: boolean,
): ReactionComparability {
  const observedMarkets = (["listed", "otc"] as const).filter((market) =>
    bars.some((bar) => bar.market === market),
  );
  const marketTransitionDetected =
    observedMarkets.length > 1 ||
    observedMarkets.some((market) => market !== company.market);
  const officialChangeMarkers = bars
    .filter((bar) => bar.changeMarker !== null)
    .map((bar) => ({ date: bar.date, marker: bar.changeMarker as string }));
  const reasons: ReactionComparability["reasons"] = ["raw_prices_not_adjusted"];
  if (noStockData) reasons.push("no_stock_data");
  if (officialChangeMarkers.length > 0) {
    reasons.push("official_change_marker_present");
  }
  if (marketTransitionDetected) {
    reasons.push("market_transition_or_historical_market_mismatch");
  }
  if (
    new Set([company.shortName, ...observedNames].map((name) => name.trim())).size > 1
  ) {
    reasons.push("multiple_observed_names");
  }
  return {
    status: noStockData
      ? "unavailable"
      : reasons.length > 1
        ? "not_comparable"
        : "provisional_raw",
    priceBasis: "raw_unadjusted",
    corporateActionAdjustment: "not_applied",
    corporateActionEvidence:
      officialChangeMarkers.length > 0
        ? "official_marker_present"
        : "none_observed",
    marketTransitionDetected,
    observedMarkets,
    officialChangeMarkers,
    reasons,
  };
}

function applyReturnComparability(
  signal: ReturnReactionSignal,
  company: MasterCompany,
  bars: OhlcBar[],
  observedNames: string[],
): ReturnReactionSignal {
  if (signal.status !== "available") return signal;
  const horizonBars = bars.filter(
    (bar) => bar.date >= signal.startDate && bar.date <= signal.endDate,
  );
  const reasons: ExcessReturnComparabilityReason[] = [];
  if (horizonBars.some((bar) => bar.changeMarker !== null)) {
    reasons.push("official_change_marker_within_horizon");
  }
  const horizonMarkets = new Set(horizonBars.map((bar) => bar.market));
  if (
    horizonMarkets.size > 1 ||
    [...horizonMarkets].some((market) => market !== company.market)
  ) {
    reasons.push(
      "market_transition_or_historical_market_mismatch_within_horizon",
    );
  }
  if (
    new Set([company.shortName, ...observedNames].map((name) => name.trim())).size > 1
  ) {
    reasons.push("multiple_observed_names");
  }
  return reasons.length === 0
    ? signal
    : {
        ...signal,
        excessReturnPercentagePoints: null,
        excessReturnStatus: "not_comparable",
        excessReturnReasons: reasons,
      };
}

function companySignals(
  company: MasterCompany,
  requestedAsOf: "latest" | string,
  horizons: ReactionHorizon[],
  benchmark: BenchmarkHistory,
  resolvedAsOf: string,
  stock: LoadedStockHistory,
): CompanyReactionSignals {
  const barsByDate = new Map(stock.bars.map((bar) => [bar.date, bar]));
  const returns = horizons.map((horizon) =>
    applyReturnComparability(
      calculateReturnSignal(
        horizon,
        exactSessionWindow(benchmark.bars, resolvedAsOf, horizon + 1),
        barsByDate,
        stock.noData,
      ),
      company,
      stock.bars,
      stock.observedNames,
    ),
  );
  const volume5 = calculateAverageWindowSignal(
    5,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 5),
    barsByDate,
    "volumeShares",
    stock.noData,
  );
  const volume20 = calculateAverageWindowSignal(
    20,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 20),
    barsByDate,
    "volumeShares",
    stock.noData,
  );
  const turnover20 = calculateAverageWindowSignal(
    20,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 20),
    barsByDate,
    "turnoverTwd",
    stock.noData,
  );
  const turnover60 = calculateAverageWindowSignal(
    60,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 60),
    barsByDate,
    "turnoverTwd",
    stock.noData,
  );
  const longestHorizon = horizons.at(-1) as ReactionHorizon;
  const longestBenchmarkWindow = exactSessionWindow(
    benchmark.bars,
    resolvedAsOf,
    longestHorizon + 1,
  );
  const pricePath = calculatePricePathSignal(
    longestHorizon,
    longestBenchmarkWindow,
    barsByDate,
    stock.noData,
  );
  const comparison = comparability(
    company,
    stock.bars.filter(
      (bar) =>
        bar.date >= longestBenchmarkWindow[0].date && bar.date <= resolvedAsOf,
    ),
    stock.observedNames,
    stock.noData,
  );
  const volumeRatio = calculateRatioSignal(volume5, volume20);
  const turnoverRatio = calculateRatioSignal(turnover20, turnover60);
  const statuses = [
    ...returns.map((signal) => signal.status),
    volume5.status,
    volume20.status,
    volumeRatio.status,
    turnover20.status,
    turnover60.status,
    turnoverRatio.status,
    pricePath.status,
  ];
  const warnings: string[] = [];
  if (stock.noData) {
    warnings.push("指定 exact benchmark 視窗內查無個股官方 OHLC。");
  } else if (statuses.some((status) => status !== "available")) {
    warnings.push("個股在部分 exact benchmark sessions 缺少必要成交或收盤欄位；相關 signal 為 null。");
  }
  if (comparison.officialChangeMarkers.length > 0) {
    warnings.push("requested return 視窗內存在官方漲跌註記；受影響 horizon 的 excess return 為 null。");
  }
  if (comparison.marketTransitionDetected) {
    warnings.push("requested return 視窗內市場別與目前母體不一致或跨市場；受影響 horizon 的 excess return 為 null。");
  }
  if (comparison.reasons.includes("multiple_observed_names")) {
    warnings.push("同一代號出現多個公司名稱；可能為改名或代號重用，須先確認 identity。");
  }
  return {
    companyCode: company.code,
    companyName: company.shortName,
    market: company.market,
    benchmarkCode: benchmark.benchmarkCode,
    requestedAsOf,
    resolvedAsOf,
    stockDataStatus: stock.noData ? "no_data" : "available",
    returns,
    liquidity: {
      averageVolume5SessionsShares: volume5,
      averageVolume20SessionsShares: volume20,
      volume5To20Ratio: volumeRatio,
      averageTurnover20SessionsTwd: turnover20,
      averageTurnover60SessionsTwd: turnover60,
      turnover20To60Ratio: turnoverRatio,
    },
    pricePath,
    comparability: comparison,
    dataQualityComplete: statuses.every((status) => status === "available"),
    warnings,
  };
}

export class ReactionClient {
  private readonly benchmarkClient: BenchmarkLike;
  private readonly concurrency: number;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CompanyMasterLike = companyMasterClient,
    private readonly stockPrice: StockPriceLike = priceClient,
    options: ReactionClientOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 2));
    this.benchmarkClient =
      options.benchmarkClient ??
      new BenchmarkClient(fetchImpl, now, {
        timeoutMs: options.timeoutMs,
        retryDelayMs: options.retryDelayMs,
        maxAttempts: options.maxAttempts,
        cacheTtlMs: options.cacheTtlMs,
        concurrency: Math.max(
          1,
          Math.min(options.benchmarkConcurrency ?? 4, 4),
        ),
      });
  }

  async getStockReactionSignals(
    query: StockReactionSignalsQuery,
  ): Promise<StockReactionSignalsResult> {
    const today = taipeiToday(this.now());
    const normalized = normalizeQuery(query, today);
    const master = await this.companyMaster.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    const byCode = new Map(master.companies.map((company) => [company.code, company]));
    const missingCompanyCodes = normalized.companyCodes.filter((code) => !byCode.has(code));
    if (missingCompanyCodes.length > 0) {
      fail("NOT_FOUND", "部分 company_codes 不在目前 TWSE／TPEx 公司母體。", {
        missingCompanyCodes,
        masterSnapshotId: master.snapshotId,
      });
    }
    const requestedCompanies = normalized.companyCodes.map(
      (code) => byCode.get(code) as MasterCompany,
    );
    const masterFingerprint = selectedMasterFingerprint(requestedCompanies);
    const markets = requestedMarkets(requestedCompanies);
    const normalizedForHash = {
      companyCodes: normalized.companyCodes,
      asOf: normalized.asOf,
      horizons: normalized.horizons,
      pageSize: normalized.pageSize,
    };
    const queryHash = reactionQueryHash(normalizedForHash);
    const decodedCursor = normalized.cursor
      ? decodeReactionCursor(normalized.cursor)
      : undefined;
    if (decodedCursor && decodedCursor.queryHash !== queryHash) {
      cursorInvalid("cursor 與本次 reaction 查詢不符。");
    }
    if (decodedCursor && decodedCursor.masterSnapshotId !== master.snapshotId) {
      snapshotChanged("cursor 的公司母體快照已變更，請重新開始查詢。", {
        cursorMasterSnapshotId: decodedCursor.masterSnapshotId,
        currentMasterSnapshotId: master.snapshotId,
      });
    }
    if (decodedCursor && decodedCursor.masterFingerprint !== masterFingerprint) {
      snapshotChanged("cursor 的公司 identity／市場快照已變更，請重新開始查詢。", {
        masterSnapshotId: master.snapshotId,
      });
    }
    const startIndex = decodedCursor?.nextIndex ?? 0;
    if (startIndex < 0 || startIndex >= requestedCompanies.length) {
      cursorInvalid("cursor 的公司續查位置超出查詢範圍。", {
        nextIndex: startIndex,
        companyCount: requestedCompanies.length,
      });
    }

    const largestRequiredSessionSpan = Math.max(
      normalized.horizons.at(-1) as ReactionHorizon,
      59,
    );
    const rangeEnd = decodedCursor?.rangeEnd ??
      (normalized.asOf === "latest" ? today : normalized.asOf);
    if (
      decodedCursor &&
      (rangeEnd > today ||
        (normalized.asOf !== "latest" && rangeEnd !== normalized.asOf))
    ) {
      cursorInvalid("cursor 的釘住日期與本次 as_of 不符。", {
        cursorRangeEnd: rangeEnd,
        asOf: normalized.asOf,
        today,
      });
    }
    const calculatedStart = subtractDays(
      rangeEnd,
      Math.ceil(largestRequiredSessionSpan * 7 / 5) + 31,
    );
    const expectedRangeStart =
      calculatedStart < BENCHMARK_SUPPORTED_FROM
        ? BENCHMARK_SUPPORTED_FROM
        : calculatedStart;
    if (decodedCursor && decodedCursor.rangeStart !== expectedRangeStart) {
      cursorInvalid("cursor 的 benchmark 視窗與本次查詢不符。", {
        cursorRangeStart: decodedCursor.rangeStart,
        expectedRangeStart,
      });
    }
    const rangeStart = decodedCursor?.rangeStart ?? expectedRangeStart;
    const benchmarkMonths = monthsBetween(rangeStart, rangeEnd);

    const histories: BenchmarkHistory[] = [];
    for (const market of markets) {
      histories.push(await this.benchmarkClient.getHistory(market, benchmarkMonths));
    }
    const historyByMarket = benchmarkMap(histories);
    const resolvedByMarket = markets.map((market) => {
      const history = historyByMarket.get(market) as BenchmarkHistory;
      return {
        market,
        date: resolveBenchmarkAsOf(history, normalized.asOf, rangeEnd),
      };
    });
    if (
      decodedCursor &&
      !sameResolvedDates(decodedCursor.resolvedByMarket, resolvedByMarket)
    ) {
      snapshotChanged("cursor 釘住的 benchmark as-of 已無法重現，請重新查詢。", {
        cursorResolvedByMarket: decodedCursor.resolvedByMarket,
        currentResolvedByMarket: resolvedByMarket,
      });
    }
    const requiredObservationCount = Math.max(
      (normalized.horizons.at(-1) as ReactionHorizon) + 1,
      60,
    );
    for (const { market, date } of resolvedByMarket) {
      const bars = (historyByMarket.get(market) as BenchmarkHistory).bars;
      const endIndex = bars.findIndex((bar) => bar.date === date);
      if (endIndex < 0 || endIndex + 1 < requiredObservationCount) {
        fail("NO_DATA", "benchmark 不足以形成 requested exact-session 視窗。", {
          market,
          resolvedAsOf: date,
          requiredObservationCount,
          availableObservationCount: Math.max(0, endIndex + 1),
        });
      }
    }
    const fingerprint = benchmarkFingerprint(
      histories.map((history) => ({
        market: history.market,
        bars: history.bars.filter(
          (bar) => bar.date <= rangeEnd,
        ),
      })),
    );
    if (decodedCursor && decodedCursor.benchmarkFingerprint !== fingerprint) {
      snapshotChanged("cursor 釘住的 benchmark 資料已變更，請重新開始查詢。");
    }

    const resolvedMap = exactResolvedMap(resolvedByMarket);
    const benchmarkUnits = benchmarkMonths.length * markets.length;
    const plannedCompanies: PlannedCompany[] = [];
    let stockUnits = 0;
    for (let index = startIndex; index < requestedCompanies.length; index += 1) {
      if (plannedCompanies.length >= normalized.pageSize) break;
      const company = requestedCompanies[index];
      const history = historyByMarket.get(company.market) as BenchmarkHistory;
      const resolved = resolvedMap.get(company.market) as string;
      const startDate = exactSessionWindow(
        history.bars,
        resolved,
        requiredObservationCount,
      )[0].date;
      const workUnits = estimatedStockWorkUnits(company, startDate, resolved);
      if (benchmarkUnits + stockUnits + workUnits > WORK_UNIT_LIMIT) break;
      plannedCompanies.push({
        company,
        startDate,
        endDate: resolved,
        workUnits,
      });
      stockUnits += workUnits;
    }
    if (plannedCompanies.length === 0) {
      workBudgetExceeded("單一公司 reaction 查詢已超過每頁 48 work units。", {
        benchmarkUnits,
        firstCompanyCode: requestedCompanies[startIndex].code,
      });
    }

    const loadedStocks = await mapWithConcurrency(
      plannedCompanies,
      this.concurrency,
      (plan) => this.loadStockHistory(plan),
    );
    const companies = plannedCompanies.map((plan, index) => {
      const benchmark = historyByMarket.get(plan.company.market) as BenchmarkHistory;
      return companySignals(
        plan.company,
        normalized.asOf,
        normalized.horizons,
        benchmark,
        plan.endDate,
        loadedStocks[index],
      );
    });
    const nextIndex = startIndex + plannedCompanies.length;
    const hasMore = nextIndex < requestedCompanies.length;
    const cursorPayload: Omit<ReactionCursorPayload, "nextIndex"> = {
      version: 1,
      queryHash,
      masterSnapshotId: master.snapshotId,
      masterFingerprint,
      rangeStart,
      rangeEnd,
      resolvedByMarket,
      benchmarkFingerprint: fingerprint,
    };
    const snapshotId = createHash("sha256")
      .update(JSON.stringify(cursorPayload))
      .digest("hex")
      .slice(0, 24);
    const dataQualityComplete = companies.every(
      (company) => company.dataQualityComplete,
    );
    const warnings = [
      "所有個股價格與報酬均為 raw unadjusted；沒有 adjusted close，也沒有股息再投資。",
      "benchmark 使用官方 price index，不是 total-return index。",
      "N-session 報酬只使用 benchmark 交易日曆的 exact 起訖日期；個股缺少任一錨點時不以前一成交日代填。",
      "官方 change marker 只能提示部分公司行動；none_observed 不代表已驗證期間內沒有公司行動。",
    ];
    if (hasMore) {
      warnings.push("本頁受 48 work-unit 上限限制；請使用 nextCursor 續查其餘公司。");
    }
    if (!dataQualityComplete) {
      warnings.push("部分公司無法形成完整 exact-session signals；請依各 signal status 判斷。");
    }
    return {
      query: normalizedForHash,
      timezone: "Asia/Taipei",
      currency: "TWD",
      priceBasis: "raw_unadjusted",
      benchmarkBasis: "price_index",
      asOf: {
        requested: normalized.asOf,
        resolvedByMarket,
      },
      coverage: {
        selectionComplete: true,
        benchmarkHistoryComplete: true,
        dataQualityComplete,
        missingCompanyCodes: [],
      },
      pagination: {
        snapshotId,
        requestedCompanyCount: requestedCompanies.length,
        requestedPageSize: normalized.pageSize,
        pageStartIndex: startIndex,
        returnedCompanyCount: companies.length,
        nextCompanyIndex: nextIndex,
        hasMore,
        nextCursor: hasMore
          ? encodeReactionCursor({ ...cursorPayload, nextIndex })
          : null,
      },
      workBudget: {
        limit: WORK_UNIT_LIMIT,
        consumed: benchmarkUnits + stockUnits,
        benchmarkUnits,
        stockUnits,
        unitDefinition: "one_official_market_month_request",
      },
      companies,
      benchmarkSources: histories.flatMap((history) => history.sources),
      stockSources: uniquePriceSources(
        loadedStocks.flatMap((stock) => stock.sources),
      ),
      warnings,
    };
  }

  private async loadStockHistory(plan: PlannedCompany): Promise<LoadedStockHistory> {
    const barsByDate = new Map<string, OhlcBar>();
    const observedNames = new Set<string>();
    const sources: PriceSource[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    try {
      for (let page = 0; page < 24; page += 1) {
        const result = await this.stockPrice.getStockOhlc({
          companyCode: plan.company.code,
          startDate: plan.startDate,
          endDate: plan.endDate,
          ...(cursor ? { cursor } : {}),
        });
        if (
          result.companyCode !== plan.company.code ||
          result.priceBasis !== "raw_unadjusted" ||
          result.coverage.requestedStart !== plan.startDate ||
          result.coverage.requestedEnd !== plan.endDate
        ) {
          fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC dependency 回傳查詢 scope 不一致。", {
            requestedCompanyCode: plan.company.code,
            returnedCompanyCode: result.companyCode,
            requestedStart: plan.startDate,
            returnedStart: result.coverage.requestedStart,
            requestedEnd: plan.endDate,
            returnedEnd: result.coverage.requestedEnd,
            priceBasis: result.priceBasis,
          });
        }
        for (const name of result.observedNames) observedNames.add(name);
        sources.push(...result.sources);
        for (const bar of result.bars) {
          if (bar.date < plan.startDate || bar.date > plan.endDate) {
            fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC dependency 回傳 scope 外日期。", {
              companyCode: plan.company.code,
              date: bar.date,
              requestedStart: plan.startDate,
              requestedEnd: plan.endDate,
            });
          }
          const existing = barsByDate.get(bar.date);
          if (existing && !sameBar(existing, bar)) {
            fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC 分頁包含衝突的重複日期。", {
              companyCode: plan.company.code,
              date: bar.date,
            });
          }
          barsByDate.set(bar.date, bar);
        }
        if (result.coverage.coverageComplete) {
          if (result.coverage.coveredThrough !== plan.endDate) {
            fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC 宣稱完整但 coveredThrough 不符。", {
              companyCode: plan.company.code,
              coveredThrough: result.coverage.coveredThrough,
              requestedEnd: plan.endDate,
            });
          }
          const bars = [...barsByDate.values()].sort((left, right) =>
            left.date.localeCompare(right.date),
          );
          return {
            noData: bars.length === 0,
            bars,
            observedNames:
              observedNames.size > 0
                ? [...observedNames]
                : [plan.company.shortName],
            sources: uniquePriceSources(sources),
          };
        }
        const nextCursor = result.coverage.nextCursor;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC 分頁 cursor 未前進。", {
            companyCode: plan.company.code,
          });
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC 分頁超過安全上限。", {
        companyCode: plan.company.code,
      });
    } catch (error) {
      if (error instanceof MopsfinError && error.code === "NO_DATA") {
        return {
          noData: true,
          bars: [],
          observedNames: [plan.company.shortName],
          sources: uniquePriceSources([
            ...sources,
            ...noDataPriceSources(error),
          ]),
        };
      }
      throw error;
    }
  }
}

export const reactionClient = new ReactionClient();
