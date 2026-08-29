import { companyMasterClient } from "@/lib/company-master/client";
import type { CompanyMarket } from "@/lib/company-master/types";
import {
  assertUniqueCodes,
  fail,
  isEligibleCompanyIdentity,
  normalizeCompactDate,
  normalizeCompactMonth,
  normalizeOptionalText,
  normalizeRequestedCodes,
  normalizeRequiredText,
  OfficialJsonLoader,
  parseOfficialNumber,
  reconcileMarket,
  selectedMarkets,
  type JsonSnapshot,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import type {
  CurrentCompanyMasterLike,
  OfficialMarketClientOptions,
} from "@/lib/market-data/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { UPSTREAM_HTTP_USER_AGENT } from "@/lib/server/identity";
import {
  observeCache,
  type CacheProvenance,
  type CacheStatus,
} from "@/lib/upstream/cache-provenance";
import {
  AbsoluteDeadline,
  allOrAbortOnError,
  assertRowCount,
  BoundedSemaphore,
  BoundedTtlLru,
  createSharedUpstreamFlight,
  createAttemptAbortScope,
  delayWithinDeadline,
  globalUpstreamSemaphore,
  parseRetryAfterMs,
  readResponseTextWithLimit,
  recordUpstreamReliabilityEvent,
  retryDelayMs,
  UpstreamReliabilityError,
  waitForPromiseWithinDeadline,
  type AttemptAbortScope,
  type SharedUpstreamFlight,
} from "@/lib/upstream/reliability";

import { parseRevenueCsv, RevenueCsvParseError } from "./csv";

import type {
  MonthlyRevenueQuery,
  MonthlyRevenueResult,
  MonthlyRevenueRow,
  MonthlyRevenueSource,
  MonthlyRevenueIdentityTransition,
  MonthlyRevenueTrendCompany,
  MonthlyRevenueTrendComparability,
  MonthlyRevenueTrendDerivedValues,
  MonthlyRevenueTrendPoint,
  MonthlyRevenueTrendQuery,
  MonthlyRevenueTrendResult,
  RevenueIdentityTransitionReason,
  RevenueSourceCoverage,
  RevenueValueStatus,
} from "./types";

interface ParsedRevenueSource {
  market: CompanyMarket;
  dataMonth: string;
  sourceReportDate: string;
  rows: MonthlyRevenueRow[];
  source: MonthlyRevenueSource;
  sourceKind: "openapi" | "archive";
}

export interface RevenueCsvSnapshot {
  payload: Array<Record<string, string>>;
  retrievedAt: string;
  /** Acquisition-layer metadata; public tool schemas wire this separately. */
  cache?: CacheProvenance;
}

export interface RevenueCsvSourceConfig extends OfficialSourceConfig {
  dataMonth: string;
}

interface StoredRevenueCsvSnapshot {
  snapshot: Omit<RevenueCsvSnapshot, "cache">;
  storedAtMs: number | null;
}

interface LoadedRevenueSources {
  sourceResults: ParsedRevenueSource[];
  warnings: string[];
}

interface RevenueReliabilityOptions {
  deadlineMs?: number;
  maxResponseBytes?: number;
  maxJsonArrayLength?: number;
  maxCsvRows?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  semaphore?: BoundedSemaphore;
}

const OPENAPI_SOURCE_CONFIGS: Record<CompanyMarket, OfficialSourceConfig> = {
  listed: {
    market: "listed",
    exchange: "TWSE",
    sourceName: "臺灣證券交易所－上市公司每月營業收入彙總表",
    sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
  },
  otc: {
    market: "otc",
    exchange: "TPEx",
    sourceName: "證券櫃檯買賣中心－上櫃公司每月營業收入彙總表",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
  },
};

const ARCHIVE_SUPPORTED_FROM = "2013-01";
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const TREND_COMPANY_LIMIT = 100;
const TREND_CONCURRENCY = 4;

const FIELDS = {
  reportDate: "出表日期",
  dataMonth: "資料年月",
  code: "公司代號",
  name: "公司名稱",
  industryCode: "產業別",
  currentMonthRevenue: "營業收入-當月營收",
  previousMonthRevenue: "營業收入-上月營收",
  sameMonthLastYearRevenue: "營業收入-去年當月營收",
  momPercent: "營業收入-上月比較增減(%)",
  yoyPercent: "營業收入-去年同月增減(%)",
  currentYearCumulativeRevenue: "累計營業收入-當月累計營收",
  previousYearCumulativeRevenue: "累計營業收入-去年累計營收",
  cumulativeYoyPercent: "累計營業收入-前期比較增減(%)",
  note: "備註",
} as const;

const CSV_FIELD_ALIASES: Partial<Record<(typeof FIELDS)[keyof typeof FIELDS], string>> = {
  [FIELDS.currentMonthRevenue]: "當月營收",
  [FIELDS.previousMonthRevenue]: "上月營收",
  [FIELDS.sameMonthLastYearRevenue]: "去年當月營收",
  [FIELDS.momPercent]: "上月比較增減(%)",
  [FIELDS.yoyPercent]: "去年同月增減(%)",
  [FIELDS.currentYearCumulativeRevenue]: "當月累計營收",
  [FIELDS.previousYearCumulativeRevenue]: "去年累計營收",
  [FIELDS.cumulativeYoyPercent]: "前期比較增減(%)",
};

const NUMERIC_ROW_FIELDS = [
  "currentMonthRevenueTwd",
  "previousMonthRevenueTwd",
  "sameMonthLastYearRevenueTwd",
  "momPercent",
  "yoyPercent",
  "currentYearCumulativeRevenueTwd",
  "previousYearCumulativeRevenueTwd",
  "cumulativeYoyPercent",
] as const satisfies ReadonlyArray<keyof MonthlyRevenueRow>;

function validateUniversePolicy(universePolicy: unknown): asserts universePolicy is MonthlyRevenueQuery["universePolicy"] {
  if (universePolicy !== "compatible" && universePolicy !== "strict_current_master") {
    fail(
      "INVALID_ARGUMENT",
      "universe_policy 必須是 compatible 或 strict_current_master。",
      { universePolicy },
    );
  }
}

function parseYearMonth(value: unknown, field: string): string {
  if (typeof value !== "string" || !YEAR_MONTH.test(value)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 latest 或 YYYY-MM。`, {
      field,
      value,
    });
  }
  return value;
}

function addMonths(month: string, count: number): string {
  const match = YEAR_MONTH.exec(month);
  if (!match) {
    fail("INVALID_ARGUMENT", "年月必須是 YYYY-MM。", { month });
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + count, 1));
  return date.toISOString().slice(0, 7);
}

function monthsEndingAt(endMonth: string, count: number): string[] {
  const start = addMonths(endMonth, -(count - 1));
  const values: string[] = [];
  for (let month = start; month <= endMonth; month = addMonths(month, 1)) {
    values.push(month);
  }
  return values;
}

function archiveConfig(
  market: CompanyMarket,
  dataMonth: string,
): RevenueCsvSourceConfig {
  const [year, month] = dataMonth.split("-").map(Number);
  const rocYear = year - 1911;
  const marketPath = market === "listed" ? "sii" : "otc";
  return {
    market,
    exchange: market === "listed" ? "TWSE" : "TPEx",
    sourceName:
      market === "listed"
        ? "公開資訊觀測站－上市公司歷史每月營業收入彙總表"
        : "公開資訊觀測站－上櫃公司歷史每月營業收入彙總表",
    sourceUrl: `https://mopsov.twse.com.tw/nas/t21/${marketPath}/t21sc03_${rocYear}_${month}.csv`,
    dataMonth,
  };
}

function normalizeRevenueDate(raw: unknown, field: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return normalizeCompactDate(raw, field);
  }
  const value = String(raw).trim();
  const separated = /^(\d{2,4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(value);
  if (!separated) return normalizeCompactDate(value, field);
  return normalizeCompactDate(
    `${separated[1]}${separated[2].padStart(2, "0")}${separated[3].padStart(2, "0")}`,
    field,
  );
}

function normalizeRevenueMonth(raw: unknown, field: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return normalizeCompactMonth(raw, field);
  }
  const value = String(raw).trim();
  const separated = /^(\d{2,4})(?:[\/-]|年)(\d{1,2})(?:月)?$/.exec(value);
  if (!separated) return normalizeCompactMonth(value, field);
  return normalizeCompactMonth(
    `${separated[1]}${separated[2].padStart(2, "0")}`,
    field,
  );
}

function revenueNumber(
  raw: unknown,
  multiplier = 1,
  recognizePercentageSentinel = false,
): { value: number | null; status: RevenueValueStatus } {
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing) return { value: null, status: "missing" };
  if (parsed.invalid || parsed.value === null) {
    return { value: null, status: "invalid_upstream" };
  }
  if (recognizePercentageSentinel && Math.abs(parsed.value) === 999_999.99) {
    return { value: null, status: "missing" };
  }
  const value = parsed.value * multiplier;
  if (!Number.isFinite(value)) {
    return { value: null, status: "invalid_upstream" };
  }
  return { value, status: "reported" };
}

function normalizeMonthlyRevenueRecords(
  records: Array<Record<string, unknown>>,
  retrievedAt: string,
  config: OfficialSourceConfig,
  sourceKind: ParsedRevenueSource["sourceKind"],
  expectedDataMonth?: string,
  cache?: CacheProvenance,
): ParsedRevenueSource {
  if (records.length === 0) {
    fail("NO_DATA", `${config.exchange} 月營收資料為空。`, {
      market: config.market,
      sourceUrl: config.sourceUrl,
      expectedDataMonth,
    });
  }

  const dataMonths = new Set<string>();
  const reportDates = new Set<string>();
  const rows: MonthlyRevenueRow[] = [];
  for (const record of records) {
    const sourceReportDate = normalizeRevenueDate(
      record[FIELDS.reportDate],
      FIELDS.reportDate,
    );
    const dataMonth = normalizeRevenueMonth(
      record[FIELDS.dataMonth],
      FIELDS.dataMonth,
    );
    const code = normalizeRequiredText(record[FIELDS.code], FIELDS.code, config.market);
    const name = normalizeRequiredText(record[FIELDS.name], FIELDS.name, config.market);
    reportDates.add(sourceReportDate);
    dataMonths.add(dataMonth);
    if (!isEligibleCompanyIdentity(code, name)) continue;

    const currentMonth = revenueNumber(record[FIELDS.currentMonthRevenue], 1000);
    const previousMonth = revenueNumber(record[FIELDS.previousMonthRevenue], 1000);
    const sameMonthLastYear = revenueNumber(
      record[FIELDS.sameMonthLastYearRevenue],
      1000,
    );
    const mom = revenueNumber(record[FIELDS.momPercent], 1, true);
    const yoy = revenueNumber(record[FIELDS.yoyPercent], 1, true);
    const currentCumulative = revenueNumber(
      record[FIELDS.currentYearCumulativeRevenue],
      1000,
    );
    const previousCumulative = revenueNumber(
      record[FIELDS.previousYearCumulativeRevenue],
      1000,
    );
    const cumulativeYoy = revenueNumber(
      record[FIELDS.cumulativeYoyPercent],
      1,
      true,
    );
    rows.push({
      code,
      name,
      market: config.market,
      industryCode: null,
      sourceIndustryName: normalizeOptionalText(record[FIELDS.industryCode]),
      sourceReportDate,
      currentMonthRevenueTwd: currentMonth.value,
      previousMonthRevenueTwd: previousMonth.value,
      sameMonthLastYearRevenueTwd: sameMonthLastYear.value,
      momPercent: mom.value,
      yoyPercent: yoy.value,
      currentYearCumulativeRevenueTwd: currentCumulative.value,
      previousYearCumulativeRevenueTwd: previousCumulative.value,
      cumulativeYoyPercent: cumulativeYoy.value,
      note: normalizeOptionalText(record[FIELDS.note]),
      valueStatus: {
        currentMonthRevenueTwd: currentMonth.status,
        previousMonthRevenueTwd: previousMonth.status,
        sameMonthLastYearRevenueTwd: sameMonthLastYear.status,
        momPercent: mom.status,
        yoyPercent: yoy.status,
        currentYearCumulativeRevenueTwd: currentCumulative.status,
        previousYearCumulativeRevenueTwd: previousCumulative.status,
        cumulativeYoyPercent: cumulativeYoy.status,
      },
    });
  }

  if (dataMonths.size !== 1 || reportDates.size !== 1 || rows.length === 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 月營收資料無法形成單一有效快照。`, {
      market: config.market,
      dataMonths: [...dataMonths],
      sourceReportDates: [...reportDates],
      eligibleRowCount: rows.length,
      sourceUrl: config.sourceUrl,
    });
  }
  const dataMonth = [...dataMonths][0];
  if (expectedDataMonth && dataMonth !== expectedDataMonth) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 歷史月營收檔案年月與查詢不符。`, {
      market: config.market,
      expectedDataMonth,
      actualDataMonth: dataMonth,
      sourceUrl: config.sourceUrl,
    });
  }
  assertUniqueCodes(rows, `${config.exchange} ${dataMonth} 月營收資料`);
  rows.sort((left, right) => left.code.localeCompare(right.code));
  const sourceReportDate = [...reportDates][0];
  return {
    market: config.market,
    dataMonth,
    sourceReportDate,
    rows,
    sourceKind,
    source: {
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      retrievedAt,
      rawCount: records.length,
      eligibleRowCount: rows.length,
      dataMonth,
      sourceReportDate,
      sourceAmountUnit: "thousand_TWD",
      outputAmountUnit: "TWD",
      amountMultiplier: 1000,
      ...(cache ? { cache } : {}),
      integrity: {
        format: sourceKind === "archive" ? "rfc4180_csv" : "json_array",
        structure: "verified",
        snapshotIdentity: "verified",
        eligibleCompanyCodesUnique: "verified",
        officialDeclaredRowCount: null,
        rowsetCompleteness: "unverified_no_official_declared_count",
      },
    },
  };
}

export function normalizeMonthlyRevenuePayload(
  snapshot: JsonSnapshot,
  config: OfficialSourceConfig,
): ParsedRevenueSource {
  if (!Array.isArray(snapshot.payload) || snapshot.payload.length === 0) {
    fail("NO_DATA", `${config.exchange} 最新月營收資料為空。`, {
      market: config.market,
      sourceUrl: config.sourceUrl,
    });
  }

  const records: Array<Record<string, unknown>> = [];
  for (const raw of snapshot.payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 月營收資料包含非物件資料列。`, {
        market: config.market,
      });
    }
    records.push(raw as Record<string, unknown>);
  }
  return normalizeMonthlyRevenueRecords(
    records,
    snapshot.retrievedAt,
    config,
    "openapi",
    undefined,
    snapshot.cache,
  );
}

export function normalizeMonthlyRevenueCsv(
  snapshot: RevenueCsvSnapshot,
  config: RevenueCsvSourceConfig,
): ParsedRevenueSource {
  const records = snapshot.payload.map((record) => {
    const normalized: Record<string, unknown> = { ...record };
    for (const [target, alias] of Object.entries(CSV_FIELD_ALIASES)) {
      if (normalized[target] === undefined && alias) {
        normalized[target] = record[alias];
      }
    }
    return normalized;
  });
  return normalizeMonthlyRevenueRecords(
    records,
    snapshot.retrievedAt,
    config,
    "archive",
    config.dataMonth,
    snapshot.cache,
  );
}

export class OfficialRevenueCsvLoader {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly cacheTtlMs: number;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRows: number;
  private readonly semaphore: BoundedSemaphore;
  private readonly cache: BoundedTtlLru<string, StoredRevenueCsvSnapshot>;
  private readonly pending = new Map<
    string,
    SharedUpstreamFlight<StoredRevenueCsvSnapshot>
  >();

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => Date,
    options: OfficialMarketClientOptions & RevenueReliabilityOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.deadlineMs = options.deadlineMs ?? 50_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.maxRows = options.maxCsvRows ?? 10_000;
    this.semaphore = options.semaphore ?? globalUpstreamSemaphore;
    this.cache = new BoundedTtlLru(
      options.cacheMaxEntries ?? 64,
      options.cacheMaxBytes ?? 32 * 1024 * 1024,
    );
  }

  async get(
    config: RevenueCsvSourceConfig,
    operationDeadline?: AbsoluteDeadline,
  ): Promise<RevenueCsvSnapshot> {
    const deadline = operationDeadline ?? new AbsoluteDeadline(this.deadlineMs);
    const ownsDeadline = operationDeadline === undefined;
    const now = this.now().getTime();
    try {
      deadline.throwIfExpired();
      const cached = this.cache.get(config.sourceUrl, now);
      if (cached) return this.observe(cached, "hit", now);
      let flight = this.pending.get(config.sourceUrl);
      let status: CacheStatus = "shared";
      if (!flight) {
        status = this.cacheTtlMs > 0 ? "miss" : "bypass";
        flight = createSharedUpstreamFlight(
          this.deadlineMs,
          async (sharedDeadline) => {
            const { snapshot, byteLength } = await this.requestCsv(
              config,
              sharedDeadline,
            );
            const storedAtMs =
              this.cacheTtlMs > 0 ? this.now().getTime() : null;
            const stored = { snapshot, storedAtMs };
            if (storedAtMs !== null) {
              this.cache.set(config.sourceUrl, stored, {
                ttlMs: this.cacheTtlMs,
                weight: byteLength,
                nowMs: storedAtMs,
              });
            }
            return stored;
          },
        );
        this.pending.set(config.sourceUrl, flight);
        const currentFlight = flight;
        const clearFlight = () => {
          if (this.pending.get(config.sourceUrl) === currentFlight) {
            this.pending.delete(config.sourceUrl);
          }
        };
        void flight.promise.then(clearFlight, clearFlight);
      }
      const stored = await flight.wait(deadline);
      return this.observe(stored, status, this.now().getTime());
    } catch (error) {
      if (error instanceof UpstreamReliabilityError) {
        throw this.timeoutError(config, error);
      }
      throw error;
    } finally {
      if (ownsDeadline) deadline.dispose();
    }
  }

  private observe(
    stored: StoredRevenueCsvSnapshot,
    status: CacheStatus,
    observedAtMs: number,
  ): RevenueCsvSnapshot {
    return {
      ...stored.snapshot,
      cache: observeCache({
        status,
        observedAtMs,
        storedAtMs: stored.storedAtMs,
        ttlMs: this.cacheTtlMs,
      }),
    };
  }

  private async requestCsv(
    config: RevenueCsvSourceConfig,
    deadline: AbsoluteDeadline,
  ): Promise<{
    snapshot: Omit<RevenueCsvSnapshot, "cache">;
    byteLength: number;
  }> {
    let lastError: MopsfinError | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let scope: AttemptAbortScope | undefined;
      let release: (() => void) | undefined;
      let upstreamRetryAfterMs: number | null = null;
      try {
        scope = createAttemptAbortScope(deadline, this.timeoutMs);
        release = await this.semaphore.acquire(scope.signal);
        const response = await this.fetchImpl(config.sourceUrl, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          signal: scope.signal,
          headers: {
            Accept: "text/csv,text/plain;q=0.9,*/*;q=0.1",
            "User-Agent": UPSTREAM_HTTP_USER_AGENT,
          },
        });
        const body = await readResponseTextWithLimit(
          response,
          this.maxResponseBytes,
        );
        upstreamRetryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );
        if (response.ok) {
          try {
            const payload = parseRevenueCsv(body.text);
            assertRowCount(payload.length, this.maxRows, "Revenue CSV");
            return {
              snapshot: {
                payload,
                retrievedAt: this.now().toISOString(),
              },
              byteLength: body.byteLength,
            };
          } catch (error) {
            if (error instanceof UpstreamReliabilityError) throw error;
            lastError = new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `${config.exchange} ${config.sourceName}不是有效 RFC 4180 CSV。`,
              {
                cause: error,
                details: { sourceUrl: config.sourceUrl, dataMonth: config.dataMonth },
                reason: "UPSTREAM_INVALID_CSV",
                retryable: true,
                action: "retry",
              },
            );
          }
        } else {
          const transient = response.status === 429 || response.status >= 500;
          lastError = new MopsfinError(
            response.status === 429
              ? "UPSTREAM_RATE_LIMITED"
              : response.status === 404
                ? "NO_DATA"
                : "UPSTREAM_BAD_RESPONSE",
            `${config.exchange} ${config.sourceName}回傳 HTTP ${response.status}。`,
            {
              status: response.status,
              details: { sourceUrl: config.sourceUrl, dataMonth: config.dataMonth },
              reason:
                response.status === 429
                  ? "UPSTREAM_HTTP_429"
                  : response.status >= 500
                    ? "UPSTREAM_HTTP_5XX"
                    : response.status === 404
                      ? "UPSTREAM_HTTP_404"
                      : "UPSTREAM_HTTP_4XX",
              retryable: transient,
              retryAfterMs: upstreamRetryAfterMs ?? undefined,
              action: transient ? "retry" : "none",
            },
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
        } else if (error instanceof UpstreamReliabilityError) {
          if (error.code === "BACKPRESSURE") {
            throw new MopsfinError(
              "UPSTREAM_RATE_LIMITED",
              "服務目前有過多上游工作，請稍後再試。",
              {
                cause: error,
                details: { sourceUrl: config.sourceUrl, dataMonth: config.dataMonth },
                reason: "UPSTREAM_BACKPRESSURE",
                retryable: true,
                retryAfterMs: error.retryAfterMs,
                action: "retry",
              },
            );
          }
          if (
            error.code === "RESPONSE_TOO_LARGE" ||
            error.code === "ROW_LIMIT_EXCEEDED"
          ) {
            throw new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `${config.exchange} ${config.sourceName}回應超過服務安全處理上限。`,
              {
                cause: error,
                details: { sourceUrl: config.sourceUrl, dataMonth: config.dataMonth },
                reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
                retryable: false,
                action: "none",
              },
            );
          }
          lastError = this.timeoutError(config, error, scope);
        } else if (scope?.signal.aborted) {
          lastError = this.timeoutError(config, error, scope);
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `${config.exchange} ${config.sourceName}網路查詢失敗。`,
            {
              cause: error,
              details: { sourceUrl: config.sourceUrl, dataMonth: config.dataMonth },
              reason: "UPSTREAM_NETWORK_ERROR",
              retryable: true,
              action: "retry",
            },
          );
        }
      } finally {
        release?.();
        scope?.cleanup();
      }
      if (attempt + 1 < this.maxAttempts) {
        recordUpstreamReliabilityEvent("retryScheduled");
        try {
          await delayWithinDeadline(
            retryDelayMs({
              attempt,
              baseDelayMs: this.retryDelayMs,
              retryAfterMs: lastError?.retryAfterMs ?? upstreamRetryAfterMs,
            }),
            deadline,
          );
        } catch (error) {
          throw this.timeoutError(config, error);
        }
      }
    }

    throw (
      lastError ??
      new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `${config.exchange} ${config.sourceName}查詢失敗。`,
      )
    );
  }

  private timeoutError(
    config: RevenueCsvSourceConfig,
    cause: unknown,
    scope?: AttemptAbortScope,
  ): MopsfinError {
    const deadlineExceeded =
      scope?.abortKind() === "deadline" ||
      (cause instanceof UpstreamReliabilityError &&
        cause.code === "DEADLINE_EXCEEDED");
    return new MopsfinError(
      "UPSTREAM_TIMEOUT",
      deadlineExceeded
        ? `${config.exchange} ${config.sourceName}超過本次工作的總時間上限。`
        : `${config.exchange} ${config.sourceName}查詢逾時。`,
      {
        cause,
        details: { sourceUrl: config.sourceUrl, dataMonth: config.dataMonth },
        reason: deadlineExceeded
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : "UPSTREAM_ATTEMPT_TIMEOUT",
        retryable: true,
        action: "retry",
      },
    );
  }
}

function sourceErrorLabel(error: unknown): string {
  if (error instanceof MopsfinError) return error.code;
  if (error instanceof RevenueCsvParseError) return error.name;
  return "UNKNOWN_ERROR";
}

function throwRevenueOperationError(error: unknown): never {
  if (error instanceof UpstreamReliabilityError) {
    const deadlineExceeded = error.code === "DEADLINE_EXCEEDED";
    throw new MopsfinError(
      "UPSTREAM_TIMEOUT",
      deadlineExceeded
        ? "月營收查詢超過本次工作的總時間上限。"
        : "月營收查詢已取消。",
      {
        cause: error,
        reason: deadlineExceeded
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : "UPSTREAM_OPERATION_ABORTED",
        retryable: true,
        action: "retry",
      },
    );
  }
  throw error;
}

function reconcileSameMonthSources(
  openapi: ParsedRevenueSource,
  archive: ParsedRevenueSource,
): { selected: ParsedRevenueSource; warnings: string[] } {
  if (
    openapi.market !== archive.market ||
    openapi.dataMonth !== archive.dataMonth
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "OpenAPI 與 archive 月營收快照無法對齊。", {
      openapi: { market: openapi.market, dataMonth: openapi.dataMonth },
      archive: { market: archive.market, dataMonth: archive.dataMonth },
    });
  }

  const openapiByCode = new Map(openapi.rows.map((row) => [row.code, row]));
  const archiveByCode = new Map(archive.rows.map((row) => [row.code, row]));
  const numericConflicts: Array<{
    companyCode: string;
    conflictingFields: string[];
  }> = [];
  let overlappingRows = 0;
  for (const [code, openapiRow] of openapiByCode) {
    const archiveRow = archiveByCode.get(code);
    if (!archiveRow) continue;
    overlappingRows += 1;
    const conflictingFields = NUMERIC_ROW_FIELDS.filter(
      (field) => openapiRow[field] !== archiveRow[field],
    );
    if (conflictingFields.length > 0) {
      numericConflicts.push({ companyCode: code, conflictingFields });
    }
  }

  const sameReportDate =
    openapi.sourceReportDate === archive.sourceReportDate;
  const maximumRevisionConflicts = Math.max(
    5,
    Math.ceil(overlappingRows * 0.02),
  );
  const systemicConflict =
    numericConflicts.length > maximumRevisionConflicts;
  if (numericConflicts.length > 0 && (sameReportDate || systemicConflict)) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      sameReportDate
        ? "OpenAPI 與 archive 的同月、同出表日期公司營收數值不一致。"
        : "OpenAPI 與 archive 的同月營收出現大範圍數值不一致。",
      {
        market: openapi.market,
        dataMonth: openapi.dataMonth,
        openapiReportDate: openapi.sourceReportDate,
        archiveReportDate: archive.sourceReportDate,
        overlappingRows,
        conflictingCompanyCount: numericConflicts.length,
        maximumRevisionConflicts,
        conflicts: numericConflicts.slice(0, 20),
        openapiUrl: openapi.source.sourceUrl,
        archiveUrl: archive.source.sourceUrl,
      },
    );
  }

  const openapiCodes = [...openapiByCode.keys()].sort();
  const archiveCodes = [...archiveByCode.keys()].sort();
  const rowsetDiffers =
    openapiCodes.length !== archiveCodes.length ||
    openapiCodes.some((code, index) => archiveCodes[index] !== code);
  const selected =
    archive.sourceReportDate >= openapi.sourceReportDate ? archive : openapi;
  const warnings: string[] = [];
  if (numericConflicts.length > 0) {
    const conflictExamples = numericConflicts
      .slice(0, 10)
      .map(
        (conflict) =>
          `${conflict.companyCode}[${conflict.conflictingFields.join(",")}]`,
      )
      .join("、");
    warnings.push(
      `${openapi.market} ${openapi.dataMonth} 的 OpenAPI（${openapi.sourceReportDate}）與 archive（${archive.sourceReportDate}）有 ${numericConflicts.length} 家重疊公司數值不同（例：${conflictExamples}）；視為不同出表日期間的官方修訂，並採用較新的 ${selected.sourceKind} 快照。`,
    );
  }
  if (rowsetDiffers) {
    warnings.push(
      `${openapi.market} ${openapi.dataMonth} 的 OpenAPI 與 archive 公司列集合不同；重疊列已完成跨來源比對，並採用出表日期較新的 ${selected.sourceKind} 快照。`,
    );
  }
  return {
    selected,
    warnings,
  };
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
  deadline: AbsoluteDeadline,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  let stopped = false;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!stopped && nextIndex < values.length) {
        deadline.throwIfExpired();
        const index = nextIndex;
        nextIndex += 1;
        try {
          output[index] = await mapper(values[index], index);
        } catch (error) {
          stopped = true;
          deadline.abort(error);
          throw error;
        }
      }
    },
  );
  await allOrAbortOnError(workers, deadline);
  return output;
}

function uniqueSources(results: ParsedRevenueSource[]): MonthlyRevenueSource[] {
  const byUrl = new Map<string, MonthlyRevenueSource>();
  for (const result of results) byUrl.set(result.source.sourceUrl, result.source);
  return [...byUrl.values()].sort((left, right) =>
    `${left.dataMonth}:${left.market}`.localeCompare(
      `${right.dataMonth}:${right.market}`,
    ),
  );
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function trendStatusForOfficial(
  status: RevenueValueStatus,
): "reported" | "insufficient_data" | "invalid_upstream" {
  if (status === "reported") return "reported";
  return status === "invalid_upstream" ? "invalid_upstream" : "insufficient_data";
}

function unverifiedSourceCoverage(): RevenueSourceCoverage {
  return {
    status: "unverified",
    method: "structure_only_no_official_declared_count",
    complete: false,
  };
}

function needsReviewDerivedTrendValues(): MonthlyRevenueTrendDerivedValues {
  return {
    latestYoyPercent: null,
    rolling3MonthYoyPercent: null,
    rolling6MonthYoyPercent: null,
    yoyAccelerationVs3MonthsAgoPp: null,
    positiveYoyMonthsInWindow: null,
    reportedYoyMonthsInWindow: null,
    consecutivePositiveYoyMonths: null,
    valueStatus: {
      latestYoyPercent: "needs_review",
      rolling3MonthYoyPercent: "needs_review",
      rolling6MonthYoyPercent: "needs_review",
      yoyAccelerationVs3MonthsAgoPp: "needs_review",
      positiveYoyMonthsInWindow: "needs_review",
      reportedYoyMonthsInWindow: "needs_review",
      consecutivePositiveYoyMonths: "needs_review",
    },
  };
}

function trendComparability(
  observed: Array<{ dataMonth: string; row: MonthlyRevenueRow }>,
): MonthlyRevenueTrendComparability {
  const transitions: MonthlyRevenueIdentityTransition[] = [];
  for (let index = 1; index < observed.length; index += 1) {
    const previous = observed[index - 1];
    const current = observed[index];
    const reasons: RevenueIdentityTransitionReason[] = [];
    if (previous.row.name !== current.row.name) {
      reasons.push("observed_name_transition");
    }
    if (previous.row.market !== current.row.market) {
      reasons.push("observed_market_transition");
    }
    if (reasons.length === 0) continue;
    transitions.push({
      dataMonth: current.dataMonth,
      fromName: previous.row.name,
      toName: current.row.name,
      fromMarket: previous.row.market,
      toMarket: current.row.market,
      reasons,
    });
  }
  const reasons = [
    ...new Set(transitions.flatMap((transition) => transition.reasons)),
  ];
  return {
    status: transitions.length === 0 ? "comparable" : "needs_review",
    reasons,
    transitions,
  };
}

function rollingYoy(
  points: MonthlyRevenueTrendPoint[],
  months: number,
): { value: number | null; status: "reported" | "insufficient_data" | "invalid_upstream" } {
  if (points.length < months) return { value: null, status: "insufficient_data" };
  const selected = points.slice(-months);
  const statuses = selected.flatMap((point) => [
    point.valueStatus.currentMonthRevenueTwd,
    point.valueStatus.sameMonthLastYearRevenueTwd,
  ]);
  if (statuses.includes("invalid_upstream")) {
    return { value: null, status: "invalid_upstream" };
  }
  if (statuses.some((status) => status !== "reported")) {
    return { value: null, status: "insufficient_data" };
  }
  const current = selected.reduce(
    (sum, point) => sum + (point.currentMonthRevenueTwd as number),
    0,
  );
  const previous = selected.reduce(
    (sum, point) => sum + (point.sameMonthLastYearRevenueTwd as number),
    0,
  );
  if (previous <= 0) return { value: null, status: "insufficient_data" };
  return {
    value: roundPercent(100 * (current / previous - 1)),
    status: "reported",
  };
}

function derivedTrendValues(
  points: MonthlyRevenueTrendPoint[],
): MonthlyRevenueTrendDerivedValues {
  const latest = points.at(-1) as MonthlyRevenueTrendPoint;
  const latestStatus = trendStatusForOfficial(latest.valueStatus.yoyPercent);
  const rolling3 = rollingYoy(points, 3);
  const rolling6 = rollingYoy(points, 6);
  const threeMonthsAgo = points.at(-4);
  let acceleration: number | null = null;
  let accelerationStatus: "reported" | "insufficient_data" | "invalid_upstream" =
    "insufficient_data";
  if (threeMonthsAgo) {
    const comparisonStatuses = [
      latest.valueStatus.yoyPercent,
      threeMonthsAgo.valueStatus.yoyPercent,
    ];
    if (comparisonStatuses.includes("invalid_upstream")) {
      accelerationStatus = "invalid_upstream";
    } else if (comparisonStatuses.every((status) => status === "reported")) {
      acceleration = roundPercent(
        (latest.yoyPercent as number) - (threeMonthsAgo.yoyPercent as number),
      );
      accelerationStatus = "reported";
    }
  }

  const reportedYoy = points.filter(
    (point) => point.valueStatus.yoyPercent === "reported",
  );
  const reportedYoyMonthsInWindow = reportedYoy.length;
  const positiveYoyMonthsInWindow = reportedYoy.filter(
    (point) => (point.yoyPercent as number) > 0,
  ).length;
  const hasInvalidYoy = points.some(
    (point) => point.valueStatus.yoyPercent === "invalid_upstream",
  );
  const windowStatus =
    reportedYoyMonthsInWindow === points.length
      ? "reported"
      : reportedYoyMonthsInWindow > 0
        ? "partial"
        : hasInvalidYoy
          ? "invalid_upstream"
          : "insufficient_data";

  let consecutivePositiveYoyMonths = 0;
  let consecutiveStatus: MonthlyRevenueTrendDerivedValues["valueStatus"]["consecutivePositiveYoyMonths"] =
    "reported";
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point.valueStatus.yoyPercent !== "reported") {
      consecutiveStatus =
        consecutivePositiveYoyMonths > 0
          ? "partial"
          : trendStatusForOfficial(point.valueStatus.yoyPercent);
      break;
    }
    if ((point.yoyPercent as number) <= 0) break;
    consecutivePositiveYoyMonths += 1;
  }

  return {
    latestYoyPercent:
      latest.valueStatus.yoyPercent === "reported" ? latest.yoyPercent : null,
    rolling3MonthYoyPercent: rolling3.value,
    rolling6MonthYoyPercent: rolling6.value,
    yoyAccelerationVs3MonthsAgoPp: acceleration,
    positiveYoyMonthsInWindow,
    reportedYoyMonthsInWindow,
    consecutivePositiveYoyMonths,
    valueStatus: {
      latestYoyPercent: latestStatus,
      rolling3MonthYoyPercent: rolling3.status,
      rolling6MonthYoyPercent: rolling6.status,
      yoyAccelerationVs3MonthsAgoPp: accelerationStatus,
      positiveYoyMonthsInWindow: windowStatus,
      reportedYoyMonthsInWindow: "reported",
      consecutivePositiveYoyMonths: consecutiveStatus,
    },
  };
}

function normalizeTrendCompanyCodes(companyCodes: unknown): string[] {
  if (!Array.isArray(companyCodes)) {
    fail("INVALID_ARGUMENT", "company_codes 必須包含 1 至 100 個四碼公司代號。");
  }
  const normalized = normalizeRequestedCodes(companyCodes as string[]);
  if (!normalized || normalized.length > TREND_COMPANY_LIMIT) {
    fail("INVALID_ARGUMENT", "company_codes 必須包含 1 至 100 個四碼公司代號。");
  }
  return normalized;
}

export class MonthlyRevenueClient {
  private readonly loader: OfficialJsonLoader;
  private readonly archiveLoader: OfficialRevenueCsvLoader;
  private readonly deadlineMs: number;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CurrentCompanyMasterLike = companyMasterClient,
    options: OfficialMarketClientOptions & RevenueReliabilityOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? 50_000;
    this.loader = new OfficialJsonLoader(fetchImpl, now, options);
    this.archiveLoader = new OfficialRevenueCsvLoader(fetchImpl, now, options);
  }

  async getMonthlyRevenue(query: MonthlyRevenueQuery): Promise<MonthlyRevenueResult> {
    const deadline = new AbsoluteDeadline(this.deadlineMs);
    try {
      return await this.getMonthlyRevenueWithinDeadline(query, deadline);
    } catch (error) {
      throwRevenueOperationError(error);
    } finally {
      deadline.dispose();
    }
  }

  private async getMonthlyRevenueWithinDeadline(
    query: MonthlyRevenueQuery,
    deadline: AbsoluteDeadline,
  ): Promise<MonthlyRevenueResult> {
    validateUniversePolicy(query.universePolicy);
    const isLatest = query.dataMonth === "latest";
    const explicitMonth = isLatest
      ? null
      : parseYearMonth(query.dataMonth, "data_month");
    if (explicitMonth && explicitMonth < ARCHIVE_SUPPORTED_FROM) {
      fail("INVALID_ARGUMENT", "data_month 早於歷史月營收支援範圍。", {
        supportedFrom: ARCHIVE_SUPPORTED_FROM,
      });
    }
    if (explicitMonth && query.universePolicy === "strict_current_master") {
      fail(
        "INVALID_ARGUMENT",
        "歷史月營收不能使用 strict_current_master；請改用 compatible，以官方歷史列為準並將目前 master 核對視為輔助資訊。",
        { dataMonth: explicitMonth },
      );
    }
    const companyCodes = normalizeRequestedCodes(query.companyCodes);
    const markets = selectedMarkets(query.market);

    const [loaded, master] = await allOrAbortOnError([
      isLatest
        ? this.loadLatestSources(markets, deadline)
        : this.loadArchiveSources(markets, explicitMonth as string, deadline),
      waitForPromiseWithinDeadline(
        this.companyMaster.listCompanies({
          market: query.market,
          includeFinancial: true,
          includeKy: true,
        }),
        deadline,
      ),
    ], deadline);
    const sourceResults = loaded.sourceResults;

    const dataMonths = [...new Set(sourceResults.map((result) => result.dataMonth))];
    if (dataMonths.length !== 1) {
      fail(
        "NO_DATA",
        "上市與上櫃月營收資料年月不一致，請稍後重試或分市場查詢。",
        {
          sourceMonths: sourceResults.map((result) => ({
            market: result.market,
            dataMonth: result.dataMonth,
          })),
        },
      );
    }

    const sourceRows = sourceResults.flatMap((result) => result.rows);
    assertUniqueCodes(sourceRows, "上市與上櫃最新月營收資料");
    const reconciled = sourceResults.map((source) =>
      reconcileMarket(
        source.market,
        source.rows,
        master.companies,
        query.universePolicy,
      ),
    );
    const reconciliation = reconciled.map((value) => value.reconciliation);
    let rows = reconciled.flatMap((value) =>
      value.acceptedRows.map((row) => ({
        ...row,
        industryCode: value.masterByCode.get(row.code)?.industryCode ?? null,
      })),
    );
    if (companyCodes) {
      const selected = new Set(companyCodes);
      rows = rows.filter((row) => selected.has(row.code));
    }
    rows.sort((left, right) => left.code.localeCompare(right.code));
    const returnedCodes = new Set(rows.map((row) => row.code));
    const missingCompanyCodes = companyCodes
      ? companyCodes.filter((code) => !returnedCodes.has(code))
      : [];
    if (rows.length === 0) {
      fail("NO_DATA", "指定市場、年月與公司條件查無官方月營收資料。", {
        market: query.market,
        dataMonth: query.dataMonth,
        missingCompanyCodes,
      });
    }

    const expectedCompanyCount = reconciliation.reduce(
      (sum, value) => sum + value.masterCount,
      0,
    );
    const reportedCompanyCount = reconciliation.reduce(
      (sum, value) => sum + value.matchedCount,
      0,
    );
    const filingMissingCompanyCodes = reconciliation
      .flatMap((value) => value.masterMissingCodes)
      .sort();
    const filingCoverageComplete =
      isLatest && filingMissingCompanyCodes.length === 0;
    const filingCoverage = {
      expectedCompanyCount,
      reportedCompanyCount,
      missingCompanyCodes: filingMissingCompanyCodes,
      coverageRatio:
        expectedCompanyCount === 0 ? 0 : reportedCompanyCount / expectedCompanyCount,
      complete: filingCoverageComplete,
      status: isLatest
        ? filingCoverageComplete
          ? ("complete" as const)
          : ("partial" as const)
        : ("historical_cross_timepoint_unverified" as const),
    };
    const currentMasterExactMatch =
      isLatest && reconciliation.every((value) => value.coverageComplete);
    const sourceCoverage: RevenueSourceCoverage = currentMasterExactMatch
      ? {
          status: "verified",
          method: "current_master_exact_match",
          complete: true,
        }
      : unverifiedSourceCoverage();

    const warnings = [
      ...(isLatest
        ? [
            "latest 先以 OpenAPI 發現各市場目前月份，再與同月／前一月 MOPS archive 核對並選擇最新共同有效月份；資料可能在法定申報期限內持續增加。",
          ]
        : [
            "歷史 MOPS CSV 是目前可取得的修訂後檔案，不是當時發布內容的 vintage snapshot。",
            "歷史公司身分與 sourceIndustryName 使用該月官方列；industryCode 與 reconciliation 來自目前 company master，只供輔助且不代表歷史上市櫃母體完整性。",
            "MOPS 歷史月營收 CSV 沒有官方 declared row count、footer 或 checksum；本工具已驗證 RFC 4180、必要欄位、單一資料年月／出表日與公司代號唯一性，但不能證明全市場 rowset 完整，因此 coverageComplete=false。",
          ]),
      "營收金額已由官方仟元乘以 1,000 正規化為 TWD；百分比沿用官方值，不由本工具重算。",
      "sourceReportDate 是官方資料集出表日期，不是個別公司的申報時間 filedAt。",
      ...loaded.warnings,
    ];
    if (
      (isLatest && !filingCoverage.complete) ||
      (!isLatest && filingMissingCompanyCodes.length > 0)
    ) {
      warnings.push(
        isLatest
          ? `目前公司母體尚有 ${filingMissingCompanyCodes.length} 家未出現在最新月營收彙總；可能源於申報進度、資料適用性或公司狀態差異，請使用 filingCoverage 判讀並回查官方申報。`
          : `目前公司母體有 ${filingMissingCompanyCodes.length} 家未出現在 ${dataMonths[0]} 歷史檔；這是跨時點 master 差異，不可直接解讀為當月漏申報。`,
      );
    }
    if (isLatest && !sourceCoverage.complete) {
      warnings.push(
        "最新月營收 rowset 未與目前 master 完全吻合；這可能是正常申報進度，但因官方來源沒有 declared row count，也不能由檔案本身證明 rowset 完整，請分別檢查 sourceCoverage 與 filingCoverage。",
      );
    }
    const marketOnlyCodes = reconciliation.flatMap((value) => value.marketOnlyCodes);
    if (marketOnlyCodes.length > 0) {
      warnings.push(
        query.universePolicy === "strict_current_master"
          ? `以下官方申報代號不在目前公司母體，已依 strict_current_master 排除：${marketOnlyCodes.join("、")}。`
          : isLatest
            ? `以下官方申報代號不在目前公司母體，已依 compatible 保留且 industryCode 為 null：${marketOnlyCodes.join("、")}。`
            : `以下歷史官方代號不在目前公司母體，已依 compatible 保留且 industryCode 為 null；請使用 sourceIndustryName：${marketOnlyCodes.join("、")}。`,
      );
    }
    if (missingCompanyCodes.length > 0) {
      warnings.push(
        `以下指定代號未出現在本次結果：${missingCompanyCodes.join("、")}。`,
      );
    }
    const invalidFieldCount = rows.reduce(
      (sum, row) =>
        sum +
        Object.values(row.valueStatus).filter((status) => status === "invalid_upstream")
          .length,
      0,
    );
    if (invalidFieldCount > 0) {
      warnings.push(
        `本次有 ${invalidFieldCount} 個月營收欄位為無法解析的官方值，已回傳 null 與 invalid_upstream。`,
      );
    }

    return {
      query: {
        ...query,
        ...(companyCodes ? { companyCodes } : {}),
      },
      dataMonth: dataMonths[0],
      currency: "TWD",
      amountUnit: "TWD",
      coverageComplete: isLatest,
      sourceCoverage,
      selectionComplete: missingCompanyCodes.length === 0,
      missingCompanyCodes,
      filingCoverage,
      reconciliation,
      counts: {
        listed: rows.filter((row) => row.market === "listed").length,
        otc: rows.filter((row) => row.market === "otc").length,
        returned: rows.length,
      },
      rows,
      sources: sourceResults.map((result) => result.source),
      warnings,
    };
  }

  async getMonthlyRevenueTrend(
    query: MonthlyRevenueTrendQuery,
  ): Promise<MonthlyRevenueTrendResult> {
    const deadline = new AbsoluteDeadline(this.deadlineMs);
    try {
      return await this.getMonthlyRevenueTrendWithinDeadline(query, deadline);
    } catch (error) {
      throwRevenueOperationError(error);
    } finally {
      deadline.dispose();
    }
  }

  private async getMonthlyRevenueTrendWithinDeadline(
    query: MonthlyRevenueTrendQuery,
    deadline: AbsoluteDeadline,
  ): Promise<MonthlyRevenueTrendResult> {
    validateUniversePolicy(query.universePolicy);
    if (query.universePolicy !== "compatible") {
      fail(
        "INVALID_ARGUMENT",
        "月營收趨勢跨越歷史月份，不能使用 strict_current_master；請改用 compatible。",
      );
    }
    const companyCodes = normalizeTrendCompanyCodes(query.companyCodes);
    if (
      !Number.isInteger(query.lookbackMonths) ||
      query.lookbackMonths < 3 ||
      query.lookbackMonths > 24
    ) {
      fail("INVALID_ARGUMENT", "lookback_months 必須是 3 至 24 的整數。", {
        lookbackMonths: query.lookbackMonths,
      });
    }
    const markets = selectedMarkets(query.market);

    let endMonth: string;
    let latest: LoadedRevenueSources | null = null;
    if (query.endMonth === "latest") {
      latest = await this.loadLatestSources(markets, deadline);
      endMonth = latest.sourceResults[0].dataMonth;
    } else {
      endMonth = parseYearMonth(query.endMonth, "end_month");
    }
    const months = monthsEndingAt(endMonth, query.lookbackMonths);
    if ((months[0] as string) < ARCHIVE_SUPPORTED_FROM) {
      fail("INVALID_ARGUMENT", "月營收趨勢起始月份早於歷史資料支援範圍。", {
        supportedFrom: ARCHIVE_SUPPORTED_FROM,
        requestedStartMonth: months[0],
      });
    }
    const masterPromise = waitForPromiseWithinDeadline(
      this.companyMaster.listCompanies({
        market: query.market,
        includeFinancial: true,
        includeKy: true,
      }),
      deadline,
    );

    const historicalMonths = latest
      ? months.filter((month) => month !== endMonth)
      : months;
    const [historical, currentMaster] = await allOrAbortOnError([
      mapWithConcurrency(
        historicalMonths,
        TREND_CONCURRENCY,
        (month) => this.loadArchiveSources(markets, month, deadline),
        deadline,
      ),
      masterPromise,
    ], deadline);
    const currentMasterByCode = new Map(
      currentMaster.companies.map((company) => [company.code, company]),
    );
    const loadedByMonth = new Map<string, LoadedRevenueSources>();
    for (let index = 0; index < historicalMonths.length; index += 1) {
      loadedByMonth.set(historicalMonths[index], historical[index]);
    }
    if (latest) loadedByMonth.set(endMonth, latest);

    const rowsByMonth = new Map<string, Map<string, MonthlyRevenueRow>>();
    const allSourceResults: ParsedRevenueSource[] = [];
    const warnings = [
      "歷史 MOPS CSV 是目前可取得的修訂後檔案，不是各月份當時發布內容的 vintage snapshot。",
      "MOPS 歷史月營收 CSV 沒有官方 declared row count、footer 或 checksum；各檔雖已通過格式、snapshot identity 與唯一鍵檢查，完整 rowset 仍不可證明，因此 coverageComplete=false。",
      "rolling 3/6 個月 YoY = 100 × (期間當月營收合計 ÷ 去年同月營收合計 − 1)；所有必要值須為 reported 且去年同期合計須大於 0。",
      "yoyAccelerationVs3MonthsAgoPp = 最新月份官方 YoY − 三個月前官方 YoY；不以模型補值。",
    ];
    for (const month of months) {
      const loaded = loadedByMonth.get(month) as LoadedRevenueSources;
      warnings.push(...loaded.warnings);
      allSourceResults.push(...loaded.sourceResults);
      const byCode = new Map<string, MonthlyRevenueRow>();
      for (const row of loaded.sourceResults.flatMap((source) => source.rows)) {
        if (!companyCodes.includes(row.code)) continue;
        if (byCode.has(row.code)) {
          fail(
            "UPSTREAM_BAD_RESPONSE",
            "同一月份在多個市場出現相同公司代號，無法建立唯一趨勢。",
            { dataMonth: month, companyCode: row.code },
          );
        }
        byCode.set(row.code, row);
      }
      rowsByMonth.set(month, byCode);
    }

    const companies: MonthlyRevenueTrendCompany[] = [];
    const missingCompanyCodes: string[] = [];
    for (const code of companyCodes) {
      const observed = months
        .flatMap((dataMonth) => {
          const row = rowsByMonth.get(dataMonth)?.get(code);
          return row ? [{ dataMonth, row }] : [];
        });
      if (observed.length === 0) {
        missingCompanyCodes.push(code);
        continue;
      }
      const latestObserved = observed.at(-1)?.row as MonthlyRevenueRow;
      const comparability = trendComparability(observed);
      const points: MonthlyRevenueTrendPoint[] = months.map((month) => {
        const row = rowsByMonth.get(month)?.get(code);
        if (!row) {
          return {
            dataMonth: month,
            name: null,
            market: null,
            sourceReportDate: null,
            sourceIndustryName: null,
            currentMonthRevenueTwd: null,
            sameMonthLastYearRevenueTwd: null,
            momPercent: null,
            yoyPercent: null,
            valueStatus: {
              currentMonthRevenueTwd: "missing",
              sameMonthLastYearRevenueTwd: "missing",
              momPercent: "missing",
              yoyPercent: "missing",
            },
          };
        }
        return {
          dataMonth: month,
          name: row.name,
          market: row.market,
          sourceReportDate: row.sourceReportDate,
          sourceIndustryName: row.sourceIndustryName,
          currentMonthRevenueTwd: row.currentMonthRevenueTwd,
          sameMonthLastYearRevenueTwd: row.sameMonthLastYearRevenueTwd,
          momPercent: row.momPercent,
          yoyPercent: row.yoyPercent,
          valueStatus: {
            currentMonthRevenueTwd: row.valueStatus.currentMonthRevenueTwd,
            sameMonthLastYearRevenueTwd:
              row.valueStatus.sameMonthLastYearRevenueTwd,
            momPercent: row.valueStatus.momPercent,
            yoyPercent: row.valueStatus.yoyPercent,
          },
        };
      });
      companies.push({
        code,
        name: latestObserved.name,
        market: latestObserved.market,
        industryCode: currentMasterByCode.get(code)?.industryCode ?? null,
        sourceIndustryName: latestObserved.sourceIndustryName,
        observedNames: [...new Set(observed.map(({ row }) => row.name))],
        observedMarkets: [...new Set(observed.map(({ row }) => row.market))],
        comparability,
        missingMonths: points
          .filter((point) => point.sourceReportDate === null)
          .map((point) => point.dataMonth),
        points,
        derived:
          comparability.status === "comparable"
            ? derivedTrendValues(points)
            : needsReviewDerivedTrendValues(),
      });
    }
    if (companies.length === 0) {
      fail("NO_DATA", "指定公司與月份範圍查無官方月營收趨勢資料。", {
        companyCodes,
        startMonth: months[0],
        endMonth,
      });
    }
    if (missingCompanyCodes.length > 0) {
      warnings.push(
        `以下指定代號在整個趨勢範圍皆無官方列：${missingCompanyCodes.join("、")}。`,
      );
    }
    const partialCompanies = companies.filter(
      (company) => company.missingMonths.length > 0,
    );
    if (partialCompanies.length > 0) {
      warnings.push(
        `${partialCompanies.length} 家公司的趨勢期間含缺月；缺月 points 明確回傳 missing，衍生值不補值。`,
      );
    }
    const transitionCompanies = companies.filter(
      (company) => company.comparability.status === "needs_review",
    );
    if (transitionCompanies.length > 0) {
      warnings.push(
        `${transitionCompanies.length} 家公司在視窗內出現官方名稱或市場轉換；來源沒有改名／轉板／代號重用旗標，無法證明為同一可比 identity，因此 derived 全數回 null 與 needs_review，原始 points 保留供人工核對。`,
      );
    }

    const sourceCoverage = unverifiedSourceCoverage();

    return {
      query: { ...query, companyCodes },
      startMonth: months[0] as string,
      endMonth,
      currency: "TWD",
      amountUnit: "TWD",
      coverageComplete: sourceCoverage.complete,
      sourceCoverage,
      selectionComplete: missingCompanyCodes.length === 0,
      missingCompanyCodes,
      counts: {
        requestedCompanies: companyCodes.length,
        returnedCompanies: companies.length,
        requestedMonths: months.length,
      },
      companies,
      sources: uniqueSources(allSourceResults),
      warnings: [...new Set(warnings)],
    };
  }

  private async loadArchiveSource(
    market: CompanyMarket,
    dataMonth: string,
    deadline: AbsoluteDeadline,
  ): Promise<ParsedRevenueSource> {
    const config = archiveConfig(market, dataMonth);
    return normalizeMonthlyRevenueCsv(
      await this.archiveLoader.get(config, deadline),
      config,
    );
  }

  private async loadArchiveSources(
    markets: CompanyMarket[],
    dataMonth: string,
    deadline: AbsoluteDeadline,
  ): Promise<LoadedRevenueSources> {
    const sourceResults = await allOrAbortOnError(
      markets.map((market) =>
        this.loadArchiveSource(market, dataMonth, deadline),
      ),
      deadline,
    );
    return { sourceResults, warnings: [] };
  }

  private async loadLatestSources(
    markets: CompanyMarket[],
    deadline: AbsoluteDeadline,
  ): Promise<LoadedRevenueSources> {
    const perMarket = await allOrAbortOnError(
      markets.map(async (market) => {
        const config = OPENAPI_SOURCE_CONFIGS[market];
        const openapi = normalizeMonthlyRevenuePayload(
          await this.loader.get(config, deadline),
          config,
        );
        const candidateMonths = [
          openapi.dataMonth,
          addMonths(openapi.dataMonth, -1),
        ].filter((month) => month >= ARCHIVE_SUPPORTED_FROM);
        const candidates = new Map<string, ParsedRevenueSource>([
          [openapi.dataMonth, openapi],
        ]);
        const warnings: string[] = [];

        for (const month of candidateMonths) {
          let archive: ParsedRevenueSource;
          try {
            archive = await this.loadArchiveSource(market, month, deadline);
          } catch (error) {
            if (
              deadline.signal.aborted ||
              (error instanceof MopsfinError &&
                error.reason === "UPSTREAM_DEADLINE_EXCEEDED")
            ) {
              throw error;
            }
            if (month === openapi.dataMonth) {
              warnings.push(
                `${market} ${month} archive 無法取得（${sourceErrorLabel(error)}），本次保留 OpenAPI fallback。`,
              );
            }
            continue;
          }
          if (month === openapi.dataMonth) {
            const reconciled = reconcileSameMonthSources(openapi, archive);
            candidates.set(month, reconciled.selected);
            warnings.push(...reconciled.warnings);
          } else {
            candidates.set(month, archive);
          }
        }
        return { market, openapiMonth: openapi.dataMonth, candidates, warnings };
      }),
      deadline,
    );

    const commonMonths = [...perMarket[0].candidates.keys()]
      .filter((month) =>
        perMarket.every((market) => market.candidates.has(month)),
      )
      .sort();
    const selectedMonth = commonMonths.at(-1);
    if (!selectedMonth) {
      fail(
        "NO_DATA",
        "上市與上櫃找不到共同有效的最新月營收年月。",
        {
          markets: perMarket.map((value) => ({
            market: value.market,
            openapiMonth: value.openapiMonth,
            candidateMonths: [...value.candidates.keys()].sort(),
          })),
        },
      );
    }
    const warnings = perMarket.flatMap((value) => value.warnings);
    if (new Set(perMarket.map((value) => value.openapiMonth)).size > 1) {
      warnings.push(
        `各市場 OpenAPI 最新年月不一致，已選擇最新共同有效月份 ${selectedMonth}。`,
      );
    }
    return {
      sourceResults: perMarket.map(
        (value) => value.candidates.get(selectedMonth) as ParsedRevenueSource,
      ),
      warnings,
    };
  }
}

export const monthlyRevenueClient = new MonthlyRevenueClient();
