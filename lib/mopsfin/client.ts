import {
  MOPSFIN_SOURCE_URL,
  type AllowedPostPath,
} from "./constants";
import { CatalogService } from "./catalog";
import { MopsfinError, asMopsfinError } from "./errors";
import {
  companyMetricWarnings,
  financialInstitutionWarnings,
  industryWarnings,
  mergeWarnings,
  noteWarnings,
  statementWarnings,
} from "./guidance";
import { parseHtmlTables, paginateTables } from "./html";
import { MopsfinHttpClient } from "./http";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import { normalizeTrendJson } from "./normalize";
import {
  assertJsonWithinLimits,
  BoundedSemaphore,
  createSharedUpstreamFlight,
  getCurrentDeadline,
  UpstreamReliabilityError,
  type AbsoluteDeadline,
  type SharedUpstreamFlight,
} from "@/lib/upstream/reliability";
import {
  comparePeriods,
  latestPeriodCandidates,
  parsePeriod,
  sliceTrend,
  toPeriod,
  toYs,
} from "./periods";
import type {
  Catalog,
  CompanySuggestion,
  EndpointFamily,
  FinancialInstitutionDefinition,
  MetricDefinition,
  NormalizedTrend,
  ParsedHtmlResponse,
  SourceMetadata,
  TrendSeries,
  TrendSeriesType,
} from "./types";

export type HistoryMode = "recent_12" | "all";
export type CompanyMetricBasis = "quarterly" | "cumulative_yoy";
export type StatementKind =
  | "balance_sheet"
  | "income_statement"
  | "cash_flow";
export type NoteKind =
  | "consolidated_subsidiaries"
  | "loans_to_others"
  | "endorsements_guarantees"
  | "investees"
  | "mainland_china_investments";
export type IndustryMode = "statistics" | "trend";
export type IndustryMeasure = "revenue" | "net_profit";

export interface TrendRange {
  history: HistoryMode;
  startPeriod?: string;
  endPeriod?: string;
}

export interface TablePage {
  offset: number;
  limit: number;
}

export interface ResolveCompaniesOptions {
  maximumCompanyCount?: number;
}

export interface MopsfinClientOptions {
  identityLookupConcurrency?: number;
  identityLookupMaximumQueue?: number;
  identityCacheTtlMs?: number;
  identityCacheMaximumEntries?: number;
  identityFlightDeadlineMs?: number;
}

const DEFAULT_IDENTITY_LOOKUP_CONCURRENCY = 4;
const DEFAULT_IDENTITY_LOOKUP_MAXIMUM_QUEUE = 200;
const DEFAULT_IDENTITY_CACHE_TTL_MS = 60_000;
const DEFAULT_IDENTITY_CACHE_MAXIMUM_ENTRIES = 500;
const DEFAULT_IDENTITY_FLIGHT_DEADLINE_MS = 50_000;
const MAXIMUM_RESOLVABLE_COMPANIES = 100;

const STATEMENT_NAMES: Record<StatementKind, RegExp> = {
  balance_sheet: /資產負債表/,
  income_statement: /綜合損益表/,
  cash_flow: /現金流量表/,
};

const NOTE_NAMES: Record<NoteKind, RegExp> = {
  consolidated_subsidiaries: /列入合併財務報表之子公司/,
  loans_to_others: /資金貸與他人/,
  endorsements_guarantees: /為他人背書保證/,
  investees: /被投資公司名稱.*相關資訊/,
  mainland_china_investments: /大陸地區之事業相關資訊/,
};

function parseJson(body: string): unknown {
  try {
    const payload = JSON.parse(body) as unknown;
    assertJsonWithinLimits(payload, { maximumArrayLength: 20_000 });
    return payload;
  } catch (error) {
    if (
      error instanceof UpstreamReliabilityError &&
      error.code === "ROW_LIMIT_EXCEEDED"
    ) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "Mopsfin JSON 回應超過服務安全處理上限。",
        {
          cause: error,
          reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
          retryable: false,
          action: "none",
        },
      );
    }
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Mopsfin 回傳無效 JSON。",
      { cause: error },
    );
  }
}

function matchesReturnedPeriod(raw: string | undefined, expected: string): boolean {
  if (!raw) return false;
  return raw.replace(/[Qq]/g, "") === expected.replace("Q", "");
}

function validateCompanyCodes(
  companyCodes: string[],
  maximumCompanyCount = 10,
): string[] {
  if (
    !Number.isInteger(maximumCompanyCount) ||
    maximumCompanyCount < 1 ||
    maximumCompanyCount > MAXIMUM_RESOLVABLE_COMPANIES
  ) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `maximum_company_count 必須是 1 至 ${MAXIMUM_RESOLVABLE_COMPANIES} 的整數。`,
    );
  }
  if (companyCodes.length === 0 || companyCodes.length > maximumCompanyCount) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `company_codes 必須包含 1 至 ${maximumCompanyCount} 個公司代號。`,
    );
  }

  return companyCodes.map((raw) => {
    const code = raw.trim();
    if (!/^[0-9A-Za-z]{1,10}$/.test(code)) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        `無效公司代號 ${raw}。`,
      );
    }
    return code;
  });
}

function validateResolvedCompanies(
  companyCodes: string[],
  resolvedCompanies: readonly CompanySuggestion[],
): CompanySuggestion[] {
  if (resolvedCompanies.length !== companyCodes.length) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "resolved company identities 必須與 company_codes 數量及順序完全一致。",
    );
  }

  return resolvedCompanies.map((company, index) => {
    const expectedCode = companyCodes[index];
    if (
      !company ||
      typeof company.code !== "string" ||
      typeof company.name !== "string" ||
      typeof company.displayName !== "string" ||
      canonicalIdentity(company.code) !== canonicalIdentity(expectedCode) ||
      !company.name.trim() ||
      !company.displayName.trim()
    ) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        `resolved company identity 與 company_codes[${index}]（${expectedCode}）不一致。`,
      );
    }
    return company;
  });
}

function validateUniqueCompanyCodes(codes: string[]): void {
  const normalized = codes.map((code) => code.toLowerCase());
  const duplicate = codes.find(
    (_, index) => normalized.indexOf(normalized[index]) !== index,
  );
  if (duplicate) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `company_codes 不得重複：${duplicate}。`,
    );
  }
}

function validateCompanyMetricRequest(options: {
  basis: CompanyMetricBasis;
  yoyQuarter?: number;
  range: TrendRange;
}): void {
  if (options.basis === "cumulative_yoy") {
    if (
      options.yoyQuarter === undefined ||
      !Number.isInteger(options.yoyQuarter) ||
      options.yoyQuarter < 1 ||
      options.yoyQuarter > 4
    ) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "basis 為 cumulative_yoy 時必須提供 1 至 4 的 yoy_quarter。",
      );
    }
  } else if (options.yoyQuarter !== undefined) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "basis 為 quarterly 時不得提供 yoy_quarter。",
    );
  }

  if (options.range.startPeriod) parsePeriod(options.range.startPeriod);
  if (options.range.endPeriod) parsePeriod(options.range.endPeriod);
  if (
    options.range.startPeriod &&
    options.range.endPeriod &&
    comparePeriods(options.range.startPeriod, options.range.endPeriod) > 0
  ) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "start_period 不得晚於 end_period。",
    );
  }
}

function canonicalIdentity(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function canonicalReportUnit(value: string): string {
  return canonicalIdentity(value).replace(/仟/g, "千");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsCompanyCode(value: string, code: string): boolean {
  return new RegExp(
    `(^|[^0-9A-Za-z])${escapeRegExp(code)}([^0-9A-Za-z]|$)`,
    "i",
  ).test(value);
}

function directCompanyMatches(
  value: string,
  companies: CompanySuggestion[],
): CompanySuggestion[] {
  const canonical = canonicalIdentity(value);
  return companies.filter((company) => {
    const exactAliases = [company.code, company.name, company.displayName].map(
      canonicalIdentity,
    );
    return (
      exactAliases.includes(canonical) ||
      containsCompanyCode(value, company.code)
    );
  });
}

function companyIdentityAliases(
  trend: NormalizedTrend,
  companies: CompanySuggestion[],
): Map<string, Set<string>> {
  const aliases = new Map(
    companies.map((company) => [
      company.code,
      new Set(
        [company.code, company.name, company.displayName].map(canonicalIdentity),
      ),
    ]),
  );
  const metadataLists = [trend.checkedNames, trend.displayNames];
  const metadataLength = Math.max(
    trend.showNames.length,
    trend.checkedNames.length,
    trend.displayNames.length,
  );
  const claimedMetadataPositions = new Map<string, number>();

  for (let index = 0; index < metadataLength; index += 1) {
    const identityValues = [
      trend.showNames[index],
      ...metadataLists.flatMap((list) => (list[index] ? [list[index]] : [])),
    ].filter((value): value is string => Boolean(value));
    const matches = new Map<string, CompanySuggestion>();
    for (const value of identityValues) {
      for (const company of directCompanyMatches(value, companies)) {
        matches.set(company.code, company);
      }
    }
    if (matches.size > 1) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `Mopsfin 公司 identity metadata 在位置 ${index + 1} 互相衝突。`,
      );
    }
    const company = [...matches.values()][0];
    if (!company) continue;
    const priorPosition = claimedMetadataPositions.get(company.code);
    if (priorPosition !== undefined && priorPosition !== index) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `Mopsfin 對公司 ${company.code} 回傳重複的 identity metadata。`,
      );
    }
    claimedMetadataPositions.set(company.code, index);
    const companyAliases = aliases.get(company.code) as Set<string>;
    for (const value of [
      trend.showNames[index],
      trend.checkedNames[index],
      trend.displayNames[index],
    ]) {
      if (value) companyAliases.add(canonicalIdentity(value));
    }
  }

  return aliases;
}

function classifyAverageSeries(
  label: string,
  extraNames: string[],
  options: {
    includeIndustryAverage: boolean;
    includeCompanyAverage: boolean;
  },
): Exclude<TrendSeriesType, "company"> {
  const canonical = canonicalIdentity(label);
  if (/產業.*平均|同業.*平均|業別.*平均|業平均/.test(canonical)) {
    return "industry_average";
  }
  if (/公司平均|所選.*平均|選取.*平均|選擇.*平均/.test(canonical)) {
    return "selection_average";
  }

  const isUpstreamExtra = extraNames.some(
    (name) => canonicalIdentity(name) === canonical,
  );
  if (isUpstreamExtra) {
    if (options.includeIndustryAverage && /產業|業$/.test(canonical)) {
      return "industry_average";
    }
    if (options.includeCompanyAverage && /平均/.test(canonical)) {
      return "selection_average";
    }
    if (options.includeIndustryAverage && !options.includeCompanyAverage) {
      return "industry_average";
    }
    if (options.includeCompanyAverage && !options.includeIndustryAverage) {
      return "selection_average";
    }
  }
  return "other";
}

function identifyCompanySeries(
  trend: NormalizedTrend,
  companies: CompanySuggestion[],
  options: {
    includeIndustryAverage: boolean;
    includeCompanyAverage: boolean;
  },
): NormalizedTrend {
  const aliases = companyIdentityAliases(trend, companies);
  const claimedCompanies = new Set<string>();
  const series = trend.series.map((item): TrendSeries => {
    const base = { label: item.label, points: item.points };
    const nonCompanyType = classifyAverageSeries(
      item.label,
      trend.extraNames,
      options,
    );
    if (nonCompanyType !== "other") {
      return { ...base, seriesType: nonCompanyType };
    }
    const canonicalLabel = canonicalIdentity(item.label);
    const candidates = companies.filter(
      (company) =>
        aliases.get(company.code)?.has(canonicalLabel) ||
        containsCompanyCode(item.label, company.code),
    );
    if (candidates.length > 1) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `Mopsfin series「${item.label}」同時符合多家公司，無法安全綁定 identity。`,
      );
    }
    const company = candidates[0];
    if (!company) {
      return { ...base, seriesType: "other" };
    }
    if (claimedCompanies.has(company.code)) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `Mopsfin 對公司 ${company.code} 回傳多個 company series，無法安全選擇。`,
      );
    }
    claimedCompanies.add(company.code);
    return {
      ...base,
      seriesType: "company",
      companyCode: company.code,
      companyName: company.name,
      displayName: company.displayName,
    };
  });

  return { ...trend, series };
}

function companyCoverage(
  trend: NormalizedTrend,
  companies: CompanySuggestion[],
) {
  const companySeries = new Map(
    trend.series.flatMap((series) =>
      series.seriesType === "company" && series.companyCode
        ? [[series.companyCode, series] as const]
        : [],
    ),
  );
  const details = companies.map((company) => {
    const series = companySeries.get(company.code);
    const pointsByPeriod = new Map<string, TrendSeries["points"][number]>();
    for (const point of series?.points ?? []) {
      if (pointsByPeriod.has(point.period)) {
        throw new MopsfinError(
          "UPSTREAM_BAD_RESPONSE",
          `Mopsfin 對公司 ${company.code} 的 ${point.period} 回傳重複資料點。`,
        );
      }
      pointsByPeriod.set(point.period, point);
    }
    const reportedPeriods = trend.periods.filter(
      (period) => pointsByPeriod.get(period)?.valueStatus === "reported",
    );
    const missingPeriods = trend.periods.filter(
      (period) => pointsByPeriod.get(period)?.valueStatus !== "reported",
    );
    const invalidPoints = [...pointsByPeriod.values()].filter(
      (point) => point.valueStatus === "invalid_upstream",
    ).length;
    return {
      companyCode: company.code,
      seriesReturned: series !== undefined,
      nonNullPoints: reportedPeriods.length,
      missingPoints: missingPeriods.length,
      invalidPoints,
      firstReportedPeriod: reportedPeriods[0] ?? null,
      latestReportedPeriod: reportedPeriods.at(-1) ?? null,
      missingPeriods,
    };
  });
  const returnedCompanyCodes = companies
    .filter((company) => companySeries.has(company.code))
    .map((company) => company.code);
  const missingCompanyCodes = companies
    .filter((company) => !companySeries.has(company.code))
    .map((company) => company.code);
  const noValidDataCompanyCodes = details
    .filter((detail) => detail.nonNullPoints === 0)
    .map((detail) => detail.companyCode);
  const commonThroughPeriod =
    [...trend.periods]
      .reverse()
      .find((period) =>
        companies.every(
          (company) =>
            companySeries
              .get(company.code)
              ?.points.some(
                (point) =>
                  point.period === period && point.valueStatus === "reported",
              ) === true,
        ),
      ) ?? null;

  return {
    selectionComplete:
      missingCompanyCodes.length === 0 &&
      noValidDataCompanyCodes.length === 0,
    requestedCompanyCodes: companies.map((company) => company.code),
    returnedCompanyCodes,
    missingCompanyCodes,
    noValidDataCompanyCodes,
    commonThroughPeriod,
    companies: details,
  };
}

function defaultPostFields(
  metric: MetricDefinition,
): Record<string, string | number | boolean | Array<string | number>> {
  return {
    compareItem: metric.code,
    ylabel: metric.unit,
    quarter: true,
    revenue: true,
    ys: "0",
    qnumber: "",
    bcodeAvg: false,
    companyAvg: false,
  };
}

export class MopsfinClient {
  readonly http: MopsfinHttpClient;
  readonly catalog: CatalogService;
  private readonly identityLookupConcurrency: number;
  private readonly identityLookupSemaphore: BoundedSemaphore;
  private readonly identityCacheTtlMs: number;
  private readonly identityCacheMaximumEntries: number;
  private readonly identityFlightDeadlineMs: number;
  private readonly identityCache = new Map<
    string,
    { company: CompanySuggestion; expiresAt: number }
  >();
  private readonly identitySingleFlights = new Map<
    string,
    SharedUpstreamFlight<CompanySuggestion>
  >();

  constructor(
    http = new MopsfinHttpClient(),
    private readonly now: () => Date = () => new Date(),
    options: MopsfinClientOptions = {},
  ) {
    this.http = http;
    this.catalog = new CatalogService(http, now);
    this.identityLookupConcurrency = this.positiveIntegerOption(
      options.identityLookupConcurrency,
      DEFAULT_IDENTITY_LOOKUP_CONCURRENCY,
      "identityLookupConcurrency",
    );
    this.identityLookupSemaphore = new BoundedSemaphore(
      this.identityLookupConcurrency,
      this.positiveIntegerOption(
        options.identityLookupMaximumQueue,
        DEFAULT_IDENTITY_LOOKUP_MAXIMUM_QUEUE,
        "identityLookupMaximumQueue",
      ),
    );
    this.identityCacheMaximumEntries = this.positiveIntegerOption(
      options.identityCacheMaximumEntries,
      DEFAULT_IDENTITY_CACHE_MAXIMUM_ENTRIES,
      "identityCacheMaximumEntries",
    );
    this.identityFlightDeadlineMs = this.positiveIntegerOption(
      options.identityFlightDeadlineMs,
      DEFAULT_IDENTITY_FLIGHT_DEADLINE_MS,
      "identityFlightDeadlineMs",
    );
    this.identityCacheTtlMs =
      options.identityCacheTtlMs ?? DEFAULT_IDENTITY_CACHE_TTL_MS;
    if (
      !Number.isFinite(this.identityCacheTtlMs) ||
      this.identityCacheTtlMs < 0
    ) {
      throw new TypeError("identityCacheTtlMs 必須是大於或等於 0 的有限數字。");
    }
  }

  async getCatalog(force = false): Promise<Catalog> {
    return this.catalog.getCatalog(force);
  }

  async findCompanies(query: string, limit = 10): Promise<CompanySuggestion[]> {
    return (await this.findCompaniesWithSource(query, limit)).companies;
  }

  async findCompaniesWithSource(
    query: string,
    limit = 10,
  ): Promise<{
    companies: CompanySuggestion[];
    retrievedAt: string;
    cache: CacheProvenance;
  }> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 30) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "query 必須是 1 至 30 個字元的公司名稱或代號。",
      );
    }

    const search = new URLSearchParams({ query: normalized });
    const response = await this.http.get("/suggestCompany", search);
    const raw = parseJson(response.body);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "Mopsfin 公司搜尋回應格式錯誤。",
      );
    }

    const suggestions = (raw as Record<string, unknown>).suggestions;
    if (!Array.isArray(suggestions)) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "Mopsfin 公司搜尋回應缺少 suggestions。",
      );
    }

    const companies = suggestions
      .flatMap((item): CompanySuggestion[] => {
        if (typeof item !== "string") return [];
        const displayName = item.replace(/\s+/g, " ").trim();
        const match = /^(\S+)\s+(.+)$/.exec(displayName);
        if (!match) return [];
        return [{ code: match[1], name: match[2], displayName }];
      })
      .slice(0, limit);
    return {
      companies,
      retrievedAt: response.retrievedAt,
      cache: response.cache,
    };
  }

  async resolveCompanies(
    companyCodes: string[],
    options: ResolveCompaniesOptions = {},
  ): Promise<CompanySuggestion[]> {
    const codes = validateCompanyCodes(
      companyCodes,
      options.maximumCompanyCount ?? 10,
    );
    return Promise.all(codes.map((code) => this.resolveCompany(code)));
  }

  async getCompanyMetric(
    options: {
      metricCode: string;
      companyCodes: string[];
      basis: CompanyMetricBasis;
      yoyQuarter?: number;
      includeIndustryAverage: boolean;
      includeCompanyAverage: boolean;
      range: TrendRange;
    },
    resolvedCompanies?: readonly CompanySuggestion[],
  ) {
    validateCompanyMetricRequest(options);
    const companyCodes = validateCompanyCodes(options.companyCodes);
    validateUniqueCompanyCodes(companyCodes);
    const suppliedCompanies = resolvedCompanies
      ? validateResolvedCompanies(companyCodes, resolvedCompanies)
      : undefined;
    const metric = await this.requireMetric(options.metricCode, "data");
    const companies = suppliedCompanies ?? await this.resolveCompanies(companyCodes);
    const response = await this.http.post("/compare/data", {
      ...defaultPostFields(metric),
      companyId: companies.map((company) => company.displayName),
      quarter: options.basis === "quarterly",
      qnumber: options.yoyQuarter ?? "",
      bcodeAvg: options.includeIndustryAverage,
      companyAvg: options.includeCompanyAverage,
    });
    const identifiedTrend = identifyCompanySeries(
      normalizeTrendJson(parseJson(response.body)),
      companies,
      options,
    );
    const trend = sliceTrend(identifiedTrend, {
      ...options.range,
      recentSeriesTypes: ["company"],
      recentReportedOnly: true,
    });
    const coverage = companyCoverage(trend, companies);
    if (coverage.noValidDataCompanyCodes.length === companies.length) {
      throw new MopsfinError(
        "NO_DATA",
        "Mopsfin 未回傳任何受查公司的有效財務指標資料。",
      );
    }

    const selectionWarnings: string[] = [];
    if (coverage.missingCompanyCodes.length > 0) {
      selectionWarnings.push(
        `Mopsfin 未回傳公司 series：${coverage.missingCompanyCodes.join("、")}；selectionComplete=false。`,
      );
    }
    const returnedWithoutData = coverage.noValidDataCompanyCodes.filter(
      (code) => !coverage.missingCompanyCodes.includes(code),
    );
    if (returnedWithoutData.length > 0) {
      selectionWarnings.push(
        `下列公司在本次期別範圍沒有有效數值：${returnedWithoutData.join("、")}；selectionComplete=false。`,
      );
    }

    return {
      ...this.source("/compare/data", response.retrievedAt, response.cache),
      query: {
        metricCode: metric.code,
        metricName: metric.name,
        companyCodes: companies.map((company) => company.code),
        companies: companies.map((company) => company.displayName),
        basis: options.basis,
        ...(options.yoyQuarter ? { yoyQuarter: options.yoyQuarter } : {}),
        includeIndustryAverage: options.includeIndustryAverage,
        includeCompanyAverage: options.includeCompanyAverage,
        ...options.range,
      },
      unit: trend.unit || metric.unit,
      periods: trend.periods,
      series: trend.series,
      coverage,
      warnings: mergeWarnings(
        this.trendWarnings(trend),
        selectionWarnings,
        companyMetricWarnings(
          metric,
          options.basis,
          options.includeIndustryAverage,
          options.includeCompanyAverage,
        ),
      ),
    };
  }

  async getFinancialStatement(options: {
    statement: StatementKind;
    companyCodes: string[];
    period: "latest" | string;
    page: TablePage;
  }) {
    const metric = await this.requireNamedMetric(
      "report",
      STATEMENT_NAMES[options.statement],
      `找不到 ${options.statement} 對應的 Mopsfin 報表。`,
    );
    return this.getHtmlReport({
      metric,
      route: "/compare/report",
      companyCodes: options.companyCodes,
      requestedPeriod: options.period,
      page: options.page,
      query: { statement: options.statement },
      warnings: statementWarnings(options.statement),
    });
  }

  async getFinancialNote(options: {
    note: NoteKind;
    companyCodes: string[];
    period: "latest" | string;
    page: TablePage;
  }) {
    const metric = await this.requireNamedMetric(
      "xb",
      NOTE_NAMES[options.note],
      `找不到 ${options.note} 對應的 Mopsfin 財報附註。`,
    );
    return this.getHtmlReport({
      metric,
      route: "/compare/xb",
      companyCodes: options.companyCodes,
      requestedPeriod: options.period,
      page: options.page,
      query: { note: options.note },
      warnings: noteWarnings(),
    });
  }

  async getIndustryData(options: {
    mode: IndustryMode;
    measure: IndustryMeasure;
    industryCodes: string[];
    period: "latest" | string;
    range: TrendRange;
  }) {
    const catalog = await this.getCatalog();
    const metricName = options.mode === "statistics" ? /產業統計/ : /產業趨勢/;
    const metric = catalog.metrics.find(
      (item) => item.family === "bcode" && metricName.test(item.name),
    );
    if (!metric) {
      throw new MopsfinError(
        "NOT_FOUND",
        `找不到 Mopsfin ${options.mode} 指標；請使用 list_catalog 重新取得目錄。`,
      );
    }
    const industries = options.industryCodes.map((code) => {
      const found = catalog.industries.find((industry) => industry.code === code);
      if (!found) {
        throw new MopsfinError(
          "NOT_FOUND",
          `找不到產業代號 ${code}；請使用 list_catalog 查詢 industries。`,
        );
      }
      return found;
    });

    if (options.mode === "trend" && industries.length === 0) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "產業趨勢至少需要一個 industry_codes。",
      );
    }

    if (options.mode === "statistics") {
      const result = await this.probeIndustryStatistics({
        metric,
        industries,
        measure: options.measure,
        requestedPeriod: options.period,
      });
      return {
        ...this.source("/compare/bcode", result.retrievedAt, result.cache),
        query: {
          mode: options.mode,
          measure: options.measure,
          industryCodes: industries.map((industry) => industry.code),
          period: result.period,
        },
        unit: result.trend.unit || metric.unit,
        periods: result.trend.periods,
        series: result.trend.series,
        warnings: mergeWarnings(
          this.trendWarnings(result.trend),
          industryWarnings(options.mode),
        ),
      };
    }

    const response = await this.http.post("/compare/bcode", {
      ...defaultPostFields(metric),
      bcodeId: industries.map((industry) => industry.code),
      revenue: options.measure === "revenue",
    });
    const trend = sliceTrend(normalizeTrendJson(parseJson(response.body)), options.range);
    this.assertTrendHasData(trend);
    return {
      ...this.source("/compare/bcode", response.retrievedAt, response.cache),
      query: {
        mode: options.mode,
        measure: options.measure,
        industryCodes: industries.map((industry) => industry.code),
        industries: industries.map((industry) => industry.name),
        ...options.range,
      },
      unit: trend.unit || metric.unit,
      periods: trend.periods,
      series: trend.series,
      warnings: mergeWarnings(
        this.trendWarnings(trend),
        industryWarnings(options.mode),
      ),
    };
  }

  async getFinancialInstitutionMetric(options: {
    metricCode: string;
    institutionCodes: string[];
    includeIndustryAverage: boolean;
    includeInstitutionAverage: boolean;
    range: TrendRange;
  }) {
    if (options.institutionCodes.length === 0 || options.institutionCodes.length > 10) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "institution_codes 必須包含 1 至 10 個金融機構代號。",
      );
    }
    const catalog = await this.getCatalog();
    const metric = catalog.metrics.find(
      (item) =>
        item.code === options.metricCode &&
        (item.family === "fin" || item.family === "adequacy"),
    );
    if (!metric) {
      throw new MopsfinError(
        "NOT_FOUND",
        `找不到金融指標 ${options.metricCode}；請使用 list_catalog。`,
      );
    }
    const institutions = options.institutionCodes.map((code) =>
      this.requireInstitution(catalog, code),
    );
    const route: AllowedPostPath =
      metric.family === "adequacy" ? "/compare/adequacy" : "/compare/fin";
    const response = await this.http.post(route, {
      ...defaultPostFields(metric),
      finCompanyId: institutions.map((institution) => institution.code),
      bcodeAvg: options.includeIndustryAverage,
      companyAvg: options.includeInstitutionAverage,
    });
    const trend = sliceTrend(normalizeTrendJson(parseJson(response.body)), options.range);
    this.assertTrendHasData(trend);

    return {
      ...this.source(route, response.retrievedAt, response.cache),
      query: {
        metricCode: metric.code,
        metricName: metric.name,
        institutionCodes: institutions.map((institution) => institution.code),
        institutions: institutions.map((institution) => institution.name),
        includeIndustryAverage: options.includeIndustryAverage,
        includeInstitutionAverage: options.includeInstitutionAverage,
        ...options.range,
      },
      unit: trend.unit || metric.unit,
      periods: trend.periods,
      series: trend.series,
      warnings: mergeWarnings(
        this.trendWarnings(trend),
        financialInstitutionWarnings(
          metric.family === "adequacy" ? "adequacy" : "fin",
          options.includeIndustryAverage,
          options.includeInstitutionAverage,
        ),
      ),
    };
  }

  private positiveIntegerOption(
    value: number | undefined,
    fallback: number,
    name: string,
  ): number {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 1) {
      throw new TypeError(`${name} 必須是正整數。`);
    }
    return resolved;
  }

  private cachedCompany(key: string): CompanySuggestion | undefined {
    const cached = this.identityCache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.now().getTime()) {
      this.identityCache.delete(key);
      return undefined;
    }
    // Refresh insertion order so the bounded Map behaves as a small LRU.
    this.identityCache.delete(key);
    this.identityCache.set(key, cached);
    return cached.company;
  }

  private cacheCompany(key: string, company: CompanySuggestion): void {
    if (this.identityCacheTtlMs === 0) return;
    const now = this.now().getTime();
    for (const [cachedKey, cached] of this.identityCache) {
      if (cached.expiresAt <= now) this.identityCache.delete(cachedKey);
    }
    this.identityCache.delete(key);
    while (this.identityCache.size >= this.identityCacheMaximumEntries) {
      const oldestKey = this.identityCache.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) break;
      this.identityCache.delete(oldestKey);
    }
    this.identityCache.set(key, {
      company,
      expiresAt: now + this.identityCacheTtlMs,
    });
  }

  private async resolveCompany(code: string): Promise<CompanySuggestion> {
    const key = canonicalIdentity(code);
    const cached = this.cachedCompany(key);
    if (cached) return cached;
    const callerDeadline = getCurrentDeadline();

    const existing = this.identitySingleFlights.get(key);
    if (existing) {
      return this.waitForIdentityLookup(existing, callerDeadline);
    }

    const lookup = createSharedUpstreamFlight(
      this.identityFlightDeadlineMs,
      () =>
        this.withIdentityLookupSlot(async () => {
          const suggestions = await this.findCompanies(code, 20);
          const exact = suggestions.find(
            (suggestion) => canonicalIdentity(suggestion.code) === key,
          );
          if (!exact) {
            throw new MopsfinError(
              "NOT_FOUND",
              `找不到公司代號 ${code}；請先使用 find_companies。`,
            );
          }
          this.cacheCompany(key, exact);
          return exact;
        }),
    );
    this.identitySingleFlights.set(key, lookup);
    const clearSingleFlight = () => {
      if (this.identitySingleFlights.get(key) === lookup) {
        this.identitySingleFlights.delete(key);
      }
    };
    void lookup.promise.then(clearSingleFlight, clearSingleFlight);
    return this.waitForIdentityLookup(lookup, callerDeadline);
  }

  private async waitForIdentityLookup(
    lookup: SharedUpstreamFlight<CompanySuggestion>,
    deadline: AbsoluteDeadline | undefined,
  ): Promise<CompanySuggestion> {
    try {
      return await lookup.wait(deadline);
    } catch (error) {
      if (error instanceof UpstreamReliabilityError) {
        throw this.identityReliabilityError(error);
      }
      throw error;
    }
  }

  private async withIdentityLookupSlot<T>(task: () => Promise<T>): Promise<T> {
    const deadline = getCurrentDeadline();
    let release: (() => void) | undefined;
    try {
      release = await this.identityLookupSemaphore.acquire(deadline?.signal);
      return await task();
    } catch (error) {
      if (error instanceof UpstreamReliabilityError) {
        throw this.identityReliabilityError(error);
      }
      throw error;
    } finally {
      release?.();
    }
  }

  private identityReliabilityError(error: UpstreamReliabilityError): MopsfinError {
    if (error.code === "BACKPRESSURE") {
      return new MopsfinError(
        "UPSTREAM_RATE_LIMITED",
        "公司 identity 查詢佇列已滿，請稍後再試。",
        {
          cause: error,
          reason: "IDENTITY_LOOKUP_BACKPRESSURE",
          retryable: true,
          retryAfterMs: error.retryAfterMs,
          action: "retry",
        },
      );
    }
    const deadlineExceeded =
      error.code === "DEADLINE_EXCEEDED" ||
      (error.cause instanceof UpstreamReliabilityError &&
        error.cause.code === "DEADLINE_EXCEEDED");
    return new MopsfinError(
      "UPSTREAM_TIMEOUT",
      deadlineExceeded
        ? "公司 identity 查詢超過本次工作的總時間上限。"
        : "公司 identity 查詢已取消。",
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

  private async getHtmlReport<TQuery extends Record<string, string>>(options: {
    metric: MetricDefinition;
    route: "/compare/report" | "/compare/xb";
    companyCodes: string[];
    requestedPeriod: "latest" | string;
    page: TablePage;
    query: TQuery;
    warnings: string[];
  }) {
    const companies = await this.resolveCompanies(options.companyCodes);
    const result = await this.probeHtmlReport({
      ...options,
      companyDisplayNames: companies.map((company) => company.displayName),
    });
    const paginated = paginateTables(result.parsed, options.page.offset, options.page.limit);
    const responseUnit = result.parsed.unit?.trim() ?? "";
    const catalogUnit = options.metric.unit.trim();
    if (
      responseUnit &&
      catalogUnit &&
      canonicalReportUnit(responseUnit) !== canonicalReportUnit(catalogUnit)
    ) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "Mopsfin 報表 HTML 與 catalog 宣告的單位不一致。",
        {
          reason: "STATEMENT_UNIT_MISMATCH",
          category: "upstream",
          retryable: false,
          action: "none",
          details: { responseUnit, catalogUnit, period: result.period },
        },
      );
    }
    const unit = responseUnit || catalogUnit;

    return {
      ...this.source(options.route, result.retrievedAt, result.cache),
      query: {
        ...options.query,
        companyCodes: companies.map((company) => company.code),
        companies: companies.map((company) => company.displayName),
        period: result.period,
      },
      unit,
      unitSource: responseUnit
        ? "response_html" as const
        : catalogUnit
          ? "catalog" as const
          : "unavailable" as const,
      period: result.period,
      reportNames: result.parsed.reportNames,
      tables: paginated.tables,
      pagination: paginated.pagination,
      warnings: mergeWarnings(
        options.warnings,
        paginated.pagination.returnedRows === 0
          ? ["此分頁沒有資料列；請檢查 offset。"]
          : [],
        paginated.pagination.nextOffset !== null
          ? [
              `表格尚未讀完；如需完整內容，請以 offset=${paginated.pagination.nextOffset} 繼續查詢。`,
            ]
          : [],
      ),
    };
  }

  private async probeHtmlReport(options: {
    metric: MetricDefinition;
    route: "/compare/report" | "/compare/xb";
    companyDisplayNames: string[];
    requestedPeriod: "latest" | string;
  }): Promise<{
    period: string;
    parsed: ParsedHtmlResponse;
    retrievedAt: string;
    cache: CacheProvenance;
  }> {
    const candidates =
      options.requestedPeriod === "latest"
        ? latestPeriodCandidates(this.now())
        : [options.requestedPeriod];

    for (const period of candidates) {
      parsePeriod(period);
      try {
        const response = await this.http.post(options.route, {
          ...defaultPostFields(options.metric),
          companyId: options.companyDisplayNames,
          ys: toYs(period),
        });
        const parsed = parseHtmlTables(response.body);
        if (
          matchesReturnedPeriod(parsed.period, period) &&
          parsed.totalRows > 0
        ) {
          return {
            period,
            parsed,
            retrievedAt: response.retrievedAt,
            cache: response.cache,
          };
        }
      } catch (error) {
        const normalized = asMopsfinError(error);
        if (normalized.code !== "NO_DATA") throw normalized;
      }
    }

    throw new MopsfinError(
      "NO_DATA",
      options.requestedPeriod === "latest"
        ? "往前 12 季皆找不到可用資料。"
        : `${options.requestedPeriod} 沒有可用資料，或 Mopsfin 回傳了不同期別。`,
    );
  }

  private async probeIndustryStatistics(options: {
    metric: MetricDefinition;
    industries: Array<{ code: string; name: string }>;
    measure: IndustryMeasure;
    requestedPeriod: "latest" | string;
  }): Promise<{
    period: string;
    trend: NormalizedTrend;
    retrievedAt: string;
    cache: CacheProvenance;
  }> {
    const candidates =
      options.requestedPeriod === "latest"
        ? latestPeriodCandidates(this.now())
        : [options.requestedPeriod];

    for (const period of candidates) {
      const expected = parsePeriod(period);
      try {
        const response = await this.http.post("/compare/bcode", {
          ...defaultPostFields(options.metric),
          bcodeId: options.industries.map((industry) => industry.code),
          revenue: options.measure === "revenue",
          ys: toYs(period),
        });
        const trend = normalizeTrendJson(parseJson(response.body));
        if (
          trend.year === expected.year &&
          trend.quarter === expected.quarter &&
          trend.series.some((series) => series.points.length > 0)
        ) {
          return {
            period: toPeriod(expected.year, expected.quarter),
            trend,
            retrievedAt: response.retrievedAt,
            cache: response.cache,
          };
        }
      } catch (error) {
        const normalized = asMopsfinError(error);
        if (normalized.code !== "NO_DATA") throw normalized;
      }
    }

    throw new MopsfinError(
      "NO_DATA",
      options.requestedPeriod === "latest"
        ? "往前 12 季皆找不到產業統計資料。"
        : `${options.requestedPeriod} 沒有產業統計資料，或 Mopsfin 回傳了不同期別。`,
    );
  }

  private async requireMetric(
    code: string,
    family: EndpointFamily,
  ): Promise<MetricDefinition> {
    const catalog = await this.getCatalog();
    const metric = catalog.metrics.find(
      (item) => item.code === code && item.family === family,
    );
    if (!metric) {
      throw new MopsfinError(
        "NOT_FOUND",
        `找不到 ${family} 指標 ${code}；請先使用 list_catalog。`,
      );
    }
    return metric;
  }

  private async requireNamedMetric(
    family: EndpointFamily,
    pattern: RegExp,
    message: string,
  ): Promise<MetricDefinition> {
    const catalog = await this.getCatalog();
    const metric = catalog.metrics.find(
      (item) => item.family === family && pattern.test(item.name),
    );
    if (!metric) throw new MopsfinError("NOT_FOUND", message);
    return metric;
  }

  private requireInstitution(
    catalog: Catalog,
    code: string,
  ): FinancialInstitutionDefinition {
    const institution = catalog.financialInstitutions.find(
      (item) => item.code === code,
    );
    if (!institution) {
      throw new MopsfinError(
        "NOT_FOUND",
        `找不到金融機構 ${code}；請使用 list_catalog 查詢 financial_institutions。`,
      );
    }
    return institution;
  }

  private assertTrendHasData(trend: NormalizedTrend): void {
    if (
      trend.periods.length === 0 ||
      !trend.series.some((series) =>
        series.points.some((point) => point.valueStatus === "reported"),
      )
    ) {
      throw new MopsfinError("NO_DATA", "Mopsfin 查無符合條件的趨勢資料。");
    }
  }

  private trendWarnings(trend: NormalizedTrend): string[] {
    const warnings: string[] = [...trend.normalizationWarnings];
    if (
      trend.series.some((series) =>
        series.points.some((point) => point.valueStatus === "missing"),
      )
    ) {
      warnings.push("部分資料點缺值；可能是該公司不適用或尚未申報。 ");
    }
    return warnings.map((warning) => warning.trim());
  }

  private source(
    route: string,
    retrievedAt: string,
    cache?: CacheProvenance,
  ): SourceMetadata {
    return {
      sourceName: "公開資訊觀測站－財務比較 E 點通",
      sourceUrl: MOPSFIN_SOURCE_URL,
      retrievedAt,
      ...(cache ? { cache } : {}),
      upstreamRoute: route,
      freshnessNote: "原站每日更新一次，資料可能較最新申報落後約一日。",
    };
  }
}

export const mopsfinClient = new MopsfinClient();
