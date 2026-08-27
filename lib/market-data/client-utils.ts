import type {
  CompanyMarket,
  CompanyMarketSelection,
  MasterCompany,
} from "@/lib/company-master/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import {
  AbsoluteDeadline,
  assertJsonWithinLimits,
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
  type AttemptAbortScope,
  type SharedUpstreamFlight,
} from "@/lib/upstream/reliability";

import type {
  CodeIdentity,
  CurrentMasterClassificationPolicy,
  MarketReconciliation,
  OfficialMarketClientOptions,
  ReconciledMarket,
  UniversePolicy,
} from "./types";

type FetchLike = typeof fetch;

export interface OfficialSourceConfig {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
}

export interface JsonSnapshot {
  payload: unknown;
  retrievedAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MISSING_MARKER = /^(?:-|--|---|—|－|N\/?A|null)$/i;

export function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError(code, message, { details });
}

function formatCalendarDate(year: number, month: number, day: number): string {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "官方資料日期不是有效日曆日期。", {
      year,
      month,
      day,
    });
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeCompactDate(raw: unknown, field: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `官方資料的 ${field} 不是日期字串。`, {
      field,
      value: raw,
    });
  }
  const value = String(raw).trim();
  const gregorian = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (gregorian && Number(gregorian[1]) >= 1911) {
    return formatCalendarDate(
      Number(gregorian[1]),
      Number(gregorian[2]),
      Number(gregorian[3]),
    );
  }
  const roc = /^(\d{2,3})(\d{2})(\d{2})$/.exec(value);
  if (!roc) {
    fail("UPSTREAM_BAD_RESPONSE", `官方資料的 ${field} 日期格式錯誤。`, {
      field,
      value: raw,
    });
  }
  return formatCalendarDate(
    Number(roc[1]) + 1911,
    Number(roc[2]),
    Number(roc[3]),
  );
}

export function normalizeCompactMonth(raw: unknown, field: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `官方資料的 ${field} 不是年月字串。`, {
      field,
      value: raw,
    });
  }
  const value = String(raw).trim();
  const gregorian = /^(\d{4})(\d{2})$/.exec(value);
  let year: number;
  let month: number;
  if (gregorian && Number(gregorian[1]) >= 1911) {
    year = Number(gregorian[1]);
    month = Number(gregorian[2]);
  } else {
    const roc = /^(\d{2,3})(\d{2})$/.exec(value);
    if (!roc) {
      fail("UPSTREAM_BAD_RESPONSE", `官方資料的 ${field} 年月格式錯誤。`, {
        field,
        value: raw,
      });
    }
    year = Number(roc[1]) + 1911;
    month = Number(roc[2]);
  }
  if (month < 1 || month > 12) {
    fail("UPSTREAM_BAD_RESPONSE", `官方資料的 ${field} 月份超出範圍。`, {
      field,
      value: raw,
    });
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function normalizeRequiredText(
  raw: unknown,
  field: string,
  market: CompanyMarket,
): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `${market} 官方資料缺少 ${field}。`, {
      field,
      market,
    });
  }
  const value = String(raw).replace(/\s+/g, " ").trim();
  if (!value) {
    fail("UPSTREAM_BAD_RESPONSE", `${market} 官方資料的 ${field} 為空。`, {
      field,
      market,
    });
  }
  return value;
}

export function normalizeOptionalText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).replace(/\s+/g, " ").trim();
  if (!value || MISSING_MARKER.test(value)) return null;
  return value;
}

export function parseOfficialNumber(
  raw: unknown,
): { value: number | null; missing: boolean; invalid: boolean } {
  if (raw === null || raw === undefined) {
    return { value: null, missing: true, invalid: false };
  }
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { value: null, missing: false, invalid: true };
  }
  const normalized = String(raw).replace(/,/g, "").trim();
  if (!normalized || MISSING_MARKER.test(normalized)) {
    return { value: null, missing: true, invalid: false };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return { value: null, missing: false, invalid: true };
  }
  return { value, missing: false, invalid: false };
}

export function selectedMarkets(market: CompanyMarketSelection): CompanyMarket[] {
  if (market === "all") return ["listed", "otc"];
  if (market === "listed" || market === "otc") return [market];
  fail("INVALID_ARGUMENT", "market 必須是 all、listed 或 otc。", { market });
}

export function normalizeRequestedCodes(
  companyCodes: string[] | undefined,
): string[] | undefined {
  if (companyCodes === undefined) return undefined;
  if (!Array.isArray(companyCodes) || companyCodes.length < 1 || companyCodes.length > 500) {
    fail("INVALID_ARGUMENT", "company_codes 必須包含 1 至 500 個四碼公司代號。");
  }
  const normalized = companyCodes.map((code) =>
    typeof code === "string" ? code.trim() : String(code),
  );
  if (normalized.some((code) => !/^\d{4}$/.test(code))) {
    fail("INVALID_ARGUMENT", "company_codes 只能包含四碼公司代號。");
  }
  if (new Set(normalized).size !== normalized.length) {
    fail("INVALID_ARGUMENT", "company_codes 不得包含重複代號。");
  }
  return normalized;
}

export function validateLatestQuery(
  latest: unknown,
  field: "date" | "data_month",
  universePolicy: UniversePolicy,
): void {
  if (latest !== "latest") {
    fail("INVALID_ARGUMENT", `${field} 目前只支援 latest。`, {
      field,
      value: latest,
    });
  }
  if (universePolicy !== "compatible" && universePolicy !== "strict_current_master") {
    fail(
      "INVALID_ARGUMENT",
      "universe_policy 必須是 compatible 或 strict_current_master。",
      { universePolicy },
    );
  }
}

export function isEligibleCompanyIdentity(code: string, name: string): boolean {
  return /^[1-9]\d{3}$/.test(code) && !/-DR(?:$|\b)/i.test(name);
}

export function assertUniqueCodes<T extends CodeIdentity>(
  rows: T[],
  context: string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.code)) {
      fail("UPSTREAM_BAD_RESPONSE", `${context} 含重複公司代號。`, {
        code: row.code,
        market: row.market,
      });
    }
    seen.add(row.code);
  }
}

export function reconcileMarket<T extends CodeIdentity>(
  market: CompanyMarket,
  rows: T[],
  masterCompanies: MasterCompany[],
  universePolicy: UniversePolicy,
): ReconciledMarket<T> {
  const marketMaster = masterCompanies.filter((company) => company.market === market);
  const masterByCode = new Map(marketMaster.map((company) => [company.code, company]));
  const sourceByCode = new Map(rows.map((row) => [row.code, row]));
  const marketOnlyCodes = rows
    .filter((row) => !masterByCode.has(row.code))
    .map((row) => row.code)
    .sort();
  const masterMissingCodes = marketMaster
    .filter((company) => !sourceByCode.has(company.code))
    .map((company) => company.code)
    .sort();
  const matchedCount = rows.length - marketOnlyCodes.length;
  const matchRatio = marketMaster.length === 0 ? 0 : matchedCount / marketMaster.length;
  const reconciliation: MarketReconciliation = {
    market,
    masterCount: marketMaster.length,
    sourceRowCount: rows.length,
    matchedCount,
    marketOnlyCodes,
    masterMissingCodes,
    matchRatio,
    coverageComplete: marketOnlyCodes.length === 0 && masterMissingCodes.length === 0,
  };
  return {
    reconciliation,
    masterByCode,
    acceptedRows:
      universePolicy === "strict_current_master"
        ? rows.filter((row) => masterByCode.has(row.code))
        : rows,
  };
}

export function classificationPolicyFor(
  universePolicy: UniversePolicy,
): CurrentMasterClassificationPolicy {
  return universePolicy === "strict_current_master"
    ? "current_master_strict"
    : "current_master_with_code_fallback";
}

export function assertIsoDate(value: string): void {
  if (!ISO_DATE.test(value)) {
    fail("UPSTREAM_BAD_RESPONSE", "正規化後的官方日期格式錯誤。", { value });
  }
}

export interface OfficialJsonLoaderOptions extends OfficialMarketClientOptions {
  deadlineMs?: number;
  maxResponseBytes?: number;
  maxJsonArrayLength?: number;
  maxJsonNodes?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  semaphore?: BoundedSemaphore;
}

export class OfficialJsonLoader {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly cacheTtlMs: number;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxJsonArrayLength: number;
  private readonly maxJsonNodes: number;
  private readonly semaphore: BoundedSemaphore;
  private readonly cache: BoundedTtlLru<string, JsonSnapshot>;
  private readonly pending = new Map<string, SharedUpstreamFlight<JsonSnapshot>>();

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly now: () => Date,
    options: OfficialJsonLoaderOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.deadlineMs = options.deadlineMs ?? 50_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.maxJsonArrayLength = options.maxJsonArrayLength ?? 20_000;
    this.maxJsonNodes = options.maxJsonNodes ?? 500_000;
    this.semaphore = options.semaphore ?? globalUpstreamSemaphore;
    this.cache = new BoundedTtlLru(
      options.cacheMaxEntries ?? 128,
      options.cacheMaxBytes ?? 32 * 1024 * 1024,
    );
  }

  async get(
    config: OfficialSourceConfig,
    operationDeadline?: AbsoluteDeadline,
  ): Promise<JsonSnapshot> {
    const deadline = operationDeadline ?? new AbsoluteDeadline(this.deadlineMs);
    const ownsDeadline = operationDeadline === undefined;
    const now = this.now().getTime();
    try {
      deadline.throwIfExpired();
      const cached = this.cache.get(config.sourceUrl, now);
      if (cached) return cached;
      let flight = this.pending.get(config.sourceUrl);
      if (!flight) {
        flight = createSharedUpstreamFlight(
          this.deadlineMs,
          async (sharedDeadline) => {
            const { snapshot, byteLength } = await this.requestJson(
              config,
              sharedDeadline,
            );
            this.cache.set(config.sourceUrl, snapshot, {
              ttlMs: this.cacheTtlMs,
              weight: byteLength,
              nowMs: this.now().getTime(),
            });
            return snapshot;
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
      return await flight.wait(deadline);
    } catch (error) {
      if (error instanceof UpstreamReliabilityError) {
        throw this.timeoutError(config, error);
      }
      throw error;
    } finally {
      if (ownsDeadline) deadline.dispose();
    }
  }

  invalidate(sourceUrl: string): void {
    this.cache.delete(sourceUrl);
  }

  private async requestJson(
    config: OfficialSourceConfig,
    deadline: AbsoluteDeadline,
  ): Promise<{ snapshot: JsonSnapshot; byteLength: number }> {
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
            Accept: "application/json",
            "User-Agent": "mopsfin-mcp/0.6.0 (+https://mopsfin.twse.com.tw/)",
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
            const payload = JSON.parse(body.text) as unknown;
            assertJsonWithinLimits(payload, {
              maximumArrayLength: this.maxJsonArrayLength,
              maximumNodes: this.maxJsonNodes,
            });
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
              `${config.exchange} ${config.sourceName}不是有效 JSON。`,
              {
                cause: error,
                details: { sourceUrl: config.sourceUrl },
                reason: "UPSTREAM_INVALID_JSON",
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
              : "UPSTREAM_BAD_RESPONSE",
            `${config.exchange} ${config.sourceName}回傳 HTTP ${response.status}。`,
            {
              status: response.status,
              details: { sourceUrl: config.sourceUrl },
              reason:
                response.status === 429
                  ? "UPSTREAM_HTTP_429"
                  : response.status >= 500
                    ? "UPSTREAM_HTTP_5XX"
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
            (error.status !== undefined && error.status < 500 && error.status !== 429) ||
            error.status === undefined
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
                details: { sourceUrl: config.sourceUrl },
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
                details: { sourceUrl: config.sourceUrl },
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
              details: { sourceUrl: config.sourceUrl },
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
    config: OfficialSourceConfig,
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
        details: { sourceUrl: config.sourceUrl },
        reason: deadlineExceeded
          ? "UPSTREAM_DEADLINE_EXCEEDED"
          : "UPSTREAM_ATTEMPT_TIMEOUT",
        retryable: true,
        action: "retry",
      },
    );
  }
}
