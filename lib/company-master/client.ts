import { MopsfinError } from "@/lib/mopsfin/errors";

import type {
  CompanyMarket,
  CompanyMarketSnapshot,
  CompanyMasterQuery,
  CompanyMasterResult,
  MasterCompany,
} from "./types";

type FetchLike = typeof fetch;

interface SourceConfig {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
}

interface CompanyMasterClientOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  cacheTtlMs?: number;
  minimumCompanyCounts?: Partial<Record<CompanyMarket, number>>;
}

const SOURCE_CONFIGS: Record<CompanyMarket, SourceConfig> = {
  listed: {
    market: "listed",
    exchange: "TWSE",
    sourceName: "臺灣證券交易所－上市公司基本資料",
    sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
  },
  otc: {
    market: "otc",
    exchange: "TPEx",
    sourceName: "證券櫃檯買賣中心－上櫃股票基本資料",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
  },
};

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MINIMUM_COMPANY_COUNTS: Record<CompanyMarket, number> = {
  listed: 1_000,
  otc: 800,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, { details });
}

function normalizeText(value: unknown, field: string, market: CompanyMarket): string {
  if (typeof value !== "string") {
    fail(`${market} 公司基本資料缺少 ${field}。`, { field, market });
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    fail(`${market} 公司基本資料的 ${field} 為空。`, { field, market });
  }
  return normalized;
}

function formatCalendarDate(
  year: number,
  month: number,
  day: number,
  field: string,
): string {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    fail(`公司基本資料的 ${field} 不是有效日期。`, { year, month, day });
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeReportDate(raw: string): string {
  const match = /^(\d{2,3})(\d{2})(\d{2})$/.exec(raw);
  if (!match) {
    fail("公司基本資料的出表日期格式錯誤。", { reportDate: raw });
  }
  return formatCalendarDate(
    Number(match[1]) + 1911,
    Number(match[2]),
    Number(match[3]),
    "出表日期",
  );
}

function normalizeListingDate(raw: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!match) {
    fail("公司基本資料的掛牌日期格式錯誤。", { listingDate: raw });
  }
  return formatCalendarDate(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    "掛牌日期",
  );
}

type OptionalProfileValue<T> = {
  value: T | null;
  status: "reported" | "missing" | "invalid_upstream";
};

function optionalText(value: unknown): OptionalProfileValue<string> {
  if (value === undefined || value === null) return { value: null, status: "missing" };
  if (typeof value !== "string") return { value: null, status: "invalid_upstream" };
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || /^(?:－|-|—|N\/?A)$/i.test(normalized)) {
    return { value: null, status: "missing" };
  }
  return { value: normalized, status: "reported" };
}

function optionalGregorianDate(value: unknown): OptionalProfileValue<string> {
  const text = optionalText(value);
  if (text.status !== "reported" || text.value === null) return text;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text.value);
  if (!match) return { value: null, status: "invalid_upstream" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return { value: null, status: "invalid_upstream" };
  }
  return {
    value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    status: "reported",
  };
}

function optionalSafeInteger(value: unknown): OptionalProfileValue<number> {
  const text = optionalText(value);
  if (text.status !== "reported" || text.value === null) {
    return { value: null, status: text.status };
  }
  const normalized = text.value.replace(/,/g, "");
  if (!/^\d+$/.test(normalized)) return { value: null, status: "invalid_upstream" };
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { value: null, status: "invalid_upstream" };
  }
  return { value: parsed, status: "reported" };
}

function normalizeDomicileCode(raw: string): string {
  const normalized = raw.trim();
  if (!normalized || /^(?:－|-|—)$/.test(normalized)) return "TW";
  const code = normalized.split(/\s+/)[0].toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    fail("公司基本資料的外國註冊地國代碼格式錯誤。", { domicile: raw });
  }
  return code;
}

function normalizeCompany(
  row: unknown,
  config: SourceConfig,
): { company: MasterCompany | null; reportDate: string; isTdr: boolean } {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(`${config.market} 公司基本資料包含非物件資料列。`, {
      market: config.market,
    });
  }
  const record = row as Record<string, unknown>;
  const field = (listed: string, otc: string) =>
    normalizeText(record[config.market === "listed" ? listed : otc], listed, config.market);

  const reportDate = normalizeReportDate(field("出表日期", "Date"));
  const code = field("公司代號", "SecuritiesCompanyCode");
  const name = field("公司名稱", "CompanyName");
  const shortName = field("公司簡稱", "CompanyAbbreviation");
  const isTdr = config.market === "listed" && /-DR$/i.test(shortName);
  if (isTdr) return { company: null, reportDate, isTdr };
  if (!/^\d{4}$/.test(code)) {
    fail(`${config.market} 公司基本資料出現非四碼普通股公司代號。`, {
      code,
      market: config.market,
    });
  }

  const industryCode = field("產業別", "SecuritiesIndustryCode");
  const domicileCode = normalizeDomicileCode(
    field("外國企業註冊地國", "Registration"),
  );
  const listingDate = normalizeListingDate(field("上市日期", "DateOfListing"));
  const incorporationDate = optionalGregorianDate(
    record[config.market === "listed" ? "成立日期" : "DateOfIncorporation"],
  );
  const paidInCapitalTwd = optionalSafeInteger(
    record[config.market === "listed" ? "實收資本額" : "Paidin.Capital.NTDollars"],
  );
  const issuedCommonShares = optionalSafeInteger(
    record[
      config.market === "listed"
        ? "已發行普通股數或TDR原股發行股數"
        : "IssueShares"
    ],
  );
  const parValueText = optionalText(
    record[config.market === "listed" ? "普通股每股面額" : "ParValueOfCommonStock"],
  );
  const financialReportTypeCode = optionalText(
    record[
      config.market === "listed"
        ? "編制財務報表類型"
        : "PreparationOfFinancialReportType"
    ],
  );

  return {
    reportDate,
    isTdr,
    company: {
      code,
      name,
      shortName,
      market: config.market,
      exchange: config.exchange,
      industryCode,
      listingDate,
      incorporationDate: incorporationDate.value,
      paidInCapitalTwd: paidInCapitalTwd.value,
      issuedCommonShares: issuedCommonShares.value,
      parValueText: parValueText.value,
      financialReportTypeCode: financialReportTypeCode.value,
      profileValueStatus: {
        incorporationDate: incorporationDate.status,
        paidInCapitalTwd: paidInCapitalTwd.status,
        issuedCommonShares: issuedCommonShares.status,
        parValueText: parValueText.status,
        financialReportTypeCode: financialReportTypeCode.status,
      },
      domicileCode,
      isKy: domicileCode === "KY" || /-KY(?:$|\b)/i.test(shortName),
      isFinancial: industryCode === "17",
    },
  };
}

export function normalizeCompanyMarketPayload(
  payload: unknown,
  config: SourceConfig,
  retrievedAt: string,
): CompanyMarketSnapshot {
  if (!Array.isArray(payload) || payload.length === 0) {
    fail(`${config.market} 公司基本資料不是非空陣列。`, {
      market: config.market,
    });
  }

  const reportDates = new Set<string>();
  const companyCodes = new Set<string>();
  const companies: MasterCompany[] = [];
  let excludedTdrCount = 0;

  for (const row of payload) {
    const normalized = normalizeCompany(row, config);
    reportDates.add(normalized.reportDate);
    if (normalized.isTdr) {
      excludedTdrCount += 1;
      continue;
    }
    const company = normalized.company as MasterCompany;
    if (companyCodes.has(company.code)) {
      fail(`${config.market} 公司基本資料含重複公司代號。`, {
        code: company.code,
        market: config.market,
      });
    }
    companyCodes.add(company.code);
    companies.push(company);
  }

  if (reportDates.size !== 1 || companies.length === 0) {
    fail(`${config.market} 公司基本資料無法形成單一完整快照。`, {
      market: config.market,
      reportDates: [...reportDates],
      companyCount: companies.length,
    });
  }

  companies.sort((left, right) => left.code.localeCompare(right.code));
  return {
    source: {
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      reportDate: [...reportDates][0],
      retrievedAt,
      rawCount: payload.length,
      excludedTdrCount,
      companyCount: companies.length,
    },
    companies,
  };
}

export class CompanyMasterClient {
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly cacheTtlMs: number;
  private readonly minimumCompanyCounts: Record<CompanyMarket, number>;
  private readonly cached = new Map<
    CompanyMarket,
    { expiresAt: number; snapshot: CompanyMarketSnapshot }
  >();
  private readonly pending = new Map<CompanyMarket, Promise<CompanyMarketSnapshot>>();

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
    options: CompanyMasterClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.minimumCompanyCounts = {
      ...DEFAULT_MINIMUM_COMPANY_COUNTS,
      ...options.minimumCompanyCounts,
    };
  }

  async getMarketSnapshot(
    market: CompanyMarket,
    force = false,
  ): Promise<CompanyMarketSnapshot> {
    const now = this.now().getTime();
    const cached = this.cached.get(market);
    if (!force && cached && cached.expiresAt > now) return cached.snapshot;
    const existing = this.pending.get(market);
    if (!force && existing) return existing;

    const request = this.loadMarket(market)
      .then((snapshot) => {
        this.cached.set(market, {
          expiresAt: this.now().getTime() + this.cacheTtlMs,
          snapshot,
        });
        return snapshot;
      })
      .finally(() => {
        this.pending.delete(market);
      });
    this.pending.set(market, request);
    return request;
  }

  async listCompanies(
    query: CompanyMasterQuery,
    force = false,
  ): Promise<CompanyMasterResult> {
    const markets: CompanyMarket[] =
      query.market === "all" ? ["listed", "otc"] : [query.market];
    const snapshots = await Promise.all(
      markets.map((market) => this.getMarketSnapshot(market, force)),
    );
    const baseCompanies = snapshots.flatMap((snapshot) => snapshot.companies);
    const uniqueCodes = new Set<string>();
    for (const company of baseCompanies) {
      if (uniqueCodes.has(company.code)) {
        fail("上市與上櫃公司基本資料含跨市場重複代號。", {
          code: company.code,
        });
      }
      uniqueCodes.add(company.code);
    }

    let companies = baseCompanies;
    let excludedFinancial = 0;
    let excludedKy = 0;
    if (!query.includeFinancial) {
      excludedFinancial = companies.filter((company) => company.isFinancial).length;
      companies = companies.filter((company) => !company.isFinancial);
    }
    if (!query.includeKy) {
      excludedKy = companies.filter((company) => company.isKy).length;
      companies = companies.filter((company) => !company.isKy);
    }

    const profileFields = [
      "incorporationDate",
      "paidInCapitalTwd",
      "issuedCommonShares",
      "parValueText",
      "financialReportTypeCode",
    ] as const;
    const profileCoverage = Object.fromEntries(
      profileFields.map((profileField) => {
        const statuses = companies.map(
          (company) => company.profileValueStatus[profileField],
        );
        return [
          profileField,
          {
            reported: statuses.filter((status) => status === "reported").length,
            missing: statuses.filter((status) => status === "missing").length,
            invalid: statuses.filter((status) => status === "invalid_upstream").length,
          },
        ];
      }),
    ) as CompanyMasterResult["profileCoverage"];
    companies = [...companies].sort((left, right) => left.code.localeCompare(right.code));

    const sources = snapshots.map((snapshot) => snapshot.source);
    const generatedAt = this.now().toISOString();
    const warnings = [
      "本清單代表 TWSE／TPEx 官方公司母體，不保證每家公司在 Mopsfin 的每個指標或期別都有資料。",
      "上市清單已排除 TDR；ETF、ETN、權證與特別股不在本工具的公司母體內。",
    ];
    if (!query.includeFinancial) {
      warnings.push(`已依產業代號 17 排除 ${excludedFinancial} 家金融保險業公司。`);
    }
    if (!query.includeKy) {
      warnings.push(`已排除 ${excludedKy} 家註冊地為 KY 或簡稱標示 -KY 的公司。`);
    }

    return {
      query,
      generatedAt,
      snapshotId: sources
        .map((source) => `${source.market}-${source.reportDate}`)
        .join("+"),
      coverageComplete: true,
      sources,
      counts: {
        raw: sources.reduce((sum, source) => sum + source.rawCount, 0),
        excludedTdr: sources.reduce(
          (sum, source) => sum + source.excludedTdrCount,
          0,
        ),
        eligible: baseCompanies.length,
        excludedFinancial,
        excludedKy,
        listed: companies.filter((company) => company.market === "listed").length,
        otc: companies.filter((company) => company.market === "otc").length,
        returned: companies.length,
      },
      profileCoverage,
      companies,
      warnings,
    };
  }

  private async loadMarket(market: CompanyMarket): Promise<CompanyMarketSnapshot> {
    const config = SOURCE_CONFIGS[market];
    const payload = await this.requestJson(config);
    const snapshot = normalizeCompanyMarketPayload(
      payload,
      config,
      this.now().toISOString(),
    );
    const minimum = this.minimumCompanyCounts[market];
    if (snapshot.companies.length < minimum) {
      fail(`${config.exchange} 公司基本資料筆數低於完整性基準。`, {
        market,
        companyCount: snapshot.companies.length,
        minimum,
      });
    }
    return snapshot;
  }

  private async requestJson(config: SourceConfig): Promise<unknown> {
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
            return JSON.parse(body) as unknown;
          } catch (error) {
            throw new MopsfinError(
              "UPSTREAM_BAD_RESPONSE",
              `${config.exchange} 公司基本資料不是有效 JSON。`,
              { cause: error },
            );
          }
        }

        lastError = new MopsfinError(
          response.status === 429
            ? "UPSTREAM_RATE_LIMITED"
            : "UPSTREAM_BAD_RESPONSE",
          `${config.exchange} 公司基本資料回傳 HTTP ${response.status}。`,
          { status: response.status },
        );
        if (response.status !== 429 && response.status < 500) throw lastError;
      } catch (error) {
        if (error instanceof MopsfinError) {
          lastError = error;
          if (
            error.code === "UPSTREAM_BAD_RESPONSE" &&
            error.status !== undefined &&
            error.status < 500
          ) {
            throw error;
          }
          if (
            error.code === "UPSTREAM_BAD_RESPONSE" &&
            error.status === undefined
          ) {
            throw error;
          }
        } else if (error instanceof DOMException && error.name === "AbortError") {
          lastError = new MopsfinError(
            "UPSTREAM_TIMEOUT",
            `${config.exchange} 公司基本資料查詢逾時。`,
            { cause: error },
          );
        } else {
          lastError = new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `${config.exchange} 公司基本資料網路查詢失敗。`,
            { cause: error },
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
        `${config.exchange} 公司基本資料查詢失敗。`,
      )
    );
  }
}

export const companyMasterClient = new CompanyMasterClient();
