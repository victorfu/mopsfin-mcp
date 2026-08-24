import {
  MOPSFIN_SOURCE_URL,
  type AllowedPostPath,
} from "./constants";
import { CatalogService } from "./catalog";
import { MopsfinError, asMopsfinError } from "./errors";
import { parseHtmlTables, paginateTables } from "./html";
import { MopsfinHttpClient } from "./http";
import { normalizeTrendJson } from "./normalize";
import {
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
    return JSON.parse(body) as unknown;
  } catch (error) {
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

function validateCompanyCodes(companyCodes: string[]): string[] {
  if (companyCodes.length === 0 || companyCodes.length > 10) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "company_codes 必須包含 1 至 10 個公司代號。",
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

  constructor(
    http = new MopsfinHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.http = http;
    this.catalog = new CatalogService(http);
  }

  async getCatalog(force = false): Promise<Catalog> {
    return this.catalog.getCatalog(force);
  }

  async findCompanies(query: string, limit = 10): Promise<CompanySuggestion[]> {
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

    return suggestions
      .flatMap((item): CompanySuggestion[] => {
        if (typeof item !== "string") return [];
        const displayName = item.replace(/\s+/g, " ").trim();
        const match = /^(\S+)\s+(.+)$/.exec(displayName);
        if (!match) return [];
        return [{ code: match[1], name: match[2], displayName }];
      })
      .slice(0, limit);
  }

  async resolveCompanies(companyCodes: string[]): Promise<CompanySuggestion[]> {
    const codes = validateCompanyCodes(companyCodes);
    return Promise.all(
      codes.map(async (code) => {
        const suggestions = await this.findCompanies(code, 20);
        const exact = suggestions.find(
          (suggestion) => suggestion.code.toLowerCase() === code.toLowerCase(),
        );
        if (!exact) {
          throw new MopsfinError(
            "NOT_FOUND",
            `找不到公司代號 ${code}；請先使用 find_companies。`,
          );
        }
        return exact;
      }),
    );
  }

  async getCompanyMetric(options: {
    metricCode: string;
    companyCodes: string[];
    basis: CompanyMetricBasis;
    yoyQuarter?: number;
    includeIndustryAverage: boolean;
    includeCompanyAverage: boolean;
    range: TrendRange;
  }) {
    if (options.basis === "cumulative_yoy" && !options.yoyQuarter) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "basis 為 cumulative_yoy 時必須提供 yoy_quarter。",
      );
    }
    const metric = await this.requireMetric(options.metricCode, "data");
    const companies = await this.resolveCompanies(options.companyCodes);
    const response = await this.http.post("/compare/data", {
      ...defaultPostFields(metric),
      companyId: companies.map((company) => company.displayName),
      quarter: options.basis === "quarterly",
      qnumber: options.yoyQuarter ?? "",
      bcodeAvg: options.includeIndustryAverage,
      companyAvg: options.includeCompanyAverage,
    });
    const trend = sliceTrend(normalizeTrendJson(parseJson(response.body)), options.range);
    this.assertTrendHasData(trend);

    return {
      ...this.source("/compare/data"),
      query: {
        metricCode: metric.code,
        metricName: metric.name,
        companyCodes: companies.map((company) => company.code),
        companies: companies.map((company) => company.displayName),
        basis: options.basis,
        ...(options.yoyQuarter ? { yoyQuarter: options.yoyQuarter } : {}),
        ...options.range,
      },
      unit: trend.unit || metric.unit,
      periods: trend.periods,
      series: trend.series,
      warnings: this.trendWarnings(trend),
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
        ...this.source("/compare/bcode"),
        query: {
          mode: options.mode,
          measure: options.measure,
          industryCodes: industries.map((industry) => industry.code),
          period: result.period,
        },
        unit: result.trend.unit || metric.unit,
        periods: result.trend.periods,
        series: result.trend.series,
        warnings: this.trendWarnings(result.trend),
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
      ...this.source("/compare/bcode"),
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
      warnings: this.trendWarnings(trend),
    };
  }

  async getFinancialInstitutionMetric(options: {
    metricCode: string;
    institutionCodes: string[];
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
    });
    const trend = sliceTrend(normalizeTrendJson(parseJson(response.body)), options.range);
    this.assertTrendHasData(trend);

    return {
      ...this.source(route),
      query: {
        metricCode: metric.code,
        metricName: metric.name,
        institutionCodes: institutions.map((institution) => institution.code),
        institutions: institutions.map((institution) => institution.name),
        ...options.range,
      },
      unit: trend.unit || metric.unit,
      periods: trend.periods,
      series: trend.series,
      warnings: this.trendWarnings(trend),
    };
  }

  private async getHtmlReport<TQuery extends Record<string, string>>(options: {
    metric: MetricDefinition;
    route: "/compare/report" | "/compare/xb";
    companyCodes: string[];
    requestedPeriod: "latest" | string;
    page: TablePage;
    query: TQuery;
  }) {
    const companies = await this.resolveCompanies(options.companyCodes);
    const result = await this.probeHtmlReport({
      ...options,
      companyDisplayNames: companies.map((company) => company.displayName),
    });
    const paginated = paginateTables(result.parsed, options.page.offset, options.page.limit);

    return {
      ...this.source(options.route),
      query: {
        ...options.query,
        companyCodes: companies.map((company) => company.code),
        companies: companies.map((company) => company.displayName),
        period: result.period,
      },
      unit: options.metric.unit,
      period: result.period,
      reportNames: result.parsed.reportNames,
      tables: paginated.tables,
      pagination: paginated.pagination,
      warnings: paginated.pagination.returnedRows === 0
        ? ["此分頁沒有資料列；請檢查 offset。"]
        : [],
    };
  }

  private async probeHtmlReport(options: {
    metric: MetricDefinition;
    route: "/compare/report" | "/compare/xb";
    companyDisplayNames: string[];
    requestedPeriod: "latest" | string;
  }): Promise<{ period: string; parsed: ParsedHtmlResponse }> {
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
          return { period, parsed };
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
  }): Promise<{ period: string; trend: NormalizedTrend }> {
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
          return { period: toPeriod(expected.year, expected.quarter), trend };
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
      !trend.series.some((series) => series.points.length > 0)
    ) {
      throw new MopsfinError("NO_DATA", "Mopsfin 查無符合條件的趨勢資料。");
    }
  }

  private trendWarnings(trend: NormalizedTrend): string[] {
    const warnings: string[] = [];
    if (trend.series.some((series) => series.points.some((point) => point.value === null))) {
      warnings.push("部分資料點缺值；可能是該公司不適用或尚未申報。 ");
    }
    return warnings.map((warning) => warning.trim());
  }

  private source(route: string): SourceMetadata {
    return {
      sourceName: "公開資訊觀測站－財務比較 E 點通",
      sourceUrl: MOPSFIN_SOURCE_URL,
      retrievedAt: new Date().toISOString(),
      upstreamRoute: route,
      freshnessNote: "原站每日更新一次，資料可能較最新申報落後約一日。",
    };
  }
}

export const mopsfinClient = new MopsfinClient();
