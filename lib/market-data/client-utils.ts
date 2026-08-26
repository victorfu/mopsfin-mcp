import type {
  CompanyMarket,
  CompanyMarketSelection,
  MasterCompany,
} from "@/lib/company-master/types";
import { MopsfinError } from "@/lib/mopsfin/errors";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export class OfficialJsonLoader {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { expiresAt: number; value: JsonSnapshot }>();
  private readonly pending = new Map<string, Promise<JsonSnapshot>>();

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly now: () => Date,
    options: OfficialMarketClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  }

  async get(config: OfficialSourceConfig): Promise<JsonSnapshot> {
    const now = this.now().getTime();
    const cached = this.cache.get(config.sourceUrl);
    if (cached && cached.expiresAt > now) return cached.value;
    const inFlight = this.pending.get(config.sourceUrl);
    if (inFlight) return inFlight;

    const request = this.requestJson(config)
      .then((snapshot) => {
        this.cache.set(config.sourceUrl, {
          expiresAt: this.now().getTime() + this.cacheTtlMs,
          value: snapshot,
        });
        return snapshot;
      })
      .finally(() => {
        this.pending.delete(config.sourceUrl);
      });
    this.pending.set(config.sourceUrl, request);
    return request;
  }

  private async requestJson(config: OfficialSourceConfig): Promise<JsonSnapshot> {
    let lastError: MopsfinError | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(config.sourceUrl, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "mopsfin-mcp/0.3.0 (+https://mopsfin.twse.com.tw/)",
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
              `${config.exchange} ${config.sourceName}不是有效 JSON。`,
              { cause: error, details: { sourceUrl: config.sourceUrl } },
            );
          }
        } else {
          lastError = new MopsfinError(
            response.status === 429
              ? "UPSTREAM_RATE_LIMITED"
              : "UPSTREAM_BAD_RESPONSE",
            `${config.exchange} ${config.sourceName}回傳 HTTP ${response.status}。`,
            { status: response.status, details: { sourceUrl: config.sourceUrl } },
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
        } else if (controller.signal.aborted) {
          lastError = new MopsfinError(
            "UPSTREAM_TIMEOUT",
            `${config.exchange} ${config.sourceName}查詢逾時。`,
            { cause: error, details: { sourceUrl: config.sourceUrl } },
          );
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `${config.exchange} ${config.sourceName}網路查詢失敗。`,
            { cause: error, details: { sourceUrl: config.sourceUrl } },
          );
        }
      } finally {
        clearTimeout(timeout);
      }

      if (attempt + 1 < this.maxAttempts) await delay(this.retryDelayMs);
    }

    throw (
      lastError ??
      new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `${config.exchange} ${config.sourceName}查詢失敗。`,
      )
    );
  }
}
