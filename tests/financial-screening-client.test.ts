import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { TaiwanFinancialScreenClient } from "@/lib/financial-screening/client";
import type {
  FinancialInstitutionBatchCompany,
  FinancialInstitutionBatchMetric,
} from "@/lib/financial-screening/institution-batch";
import {
  resolveFinancialScreenMetricRoles,
  resolvedFinancialMetric,
} from "@/lib/financial-screening/metric-roles";
import { screenTaiwanFinancialCandidatesDataSchema } from "@/lib/mcp/schema/financial-screening";
import { parseCatalogHtml } from "@/lib/mopsfin/catalog";
import type {
  CompanyMetricsBatchCompany,
  CompanyMetricsBatchMetric,
} from "@/lib/mopsfin/batch";
import type { CompanyReactionSignals } from "@/lib/reaction/types";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);
const catalog = parseCatalogHtml(
  catalogHtml,
  new Date("2026-08-30T00:00:00.000Z"),
);
catalog.financialInstitutions = [
  { code: "2801", name: "彰銀", sector: "bank" },
  { code: "2812", name: "台中銀", sector: "bank" },
  { code: "2834", name: "臺企銀", sector: "bank" },
];
const resolution = resolveFinancialScreenMetricRoles(catalog);
const periods = ["2025Q2", "2025Q3", "2025Q4", "2026Q1", "2026Q2"];

function masterCompany(
  code: string,
  shortName: string,
  options: { financial?: boolean; ky?: boolean } = {},
) {
  return {
    code,
    name: shortName,
    shortName,
    market: "listed" as const,
    exchange: "TWSE" as const,
    industryCode: options.financial === false ? "24" : "17",
    listingDate: "2001-01-01",
    incorporationDate: null,
    paidInCapitalTwd: null,
    issuedCommonShares: null,
    parValueText: null,
    financialReportTypeCode: null,
    profileValueStatus: {
      incorporationDate: "missing" as const,
      paidInCapitalTwd: "missing" as const,
      issuedCommonShares: "missing" as const,
      parValueText: "missing" as const,
      financialReportTypeCode: "missing" as const,
    },
    domicileCode: options.ky ? "KY" : "TW",
    isKy: options.ky ?? false,
    isFinancial: options.financial ?? true,
  };
}

function companyMasterResult(companies: ReturnType<typeof masterCompany>[]) {
  return {
    query: { market: "listed" as const, includeFinancial: true, includeKy: true },
    generatedAt: "2026-08-30T00:00:00.000Z",
    snapshotId: "listed-2026-08-30",
    coverageVerification: {
      status: "heuristic" as const,
      method: "required_sources_schema_single_report_date_minimum_count" as const,
      officialDeclaredRowCountAvailable: false as const,
    },
    coverageComplete: true as const,
    sources: [{
      market: "listed" as const,
      exchange: "TWSE" as const,
      sourceName: "TWSE master",
      sourceUrl: "https://example.test/master",
      reportDate: "2026-08-30",
      retrievedAt: "2026-08-30T00:00:00.000Z",
      rawCount: companies.length,
      excludedTdrCount: 0,
      companyCount: companies.length,
      minimumExpectedCount: 1,
    }],
    counts: {
      raw: companies.length,
      excludedTdr: 0,
      eligible: companies.length,
      excludedFinancial: 0,
      excludedKy: 0,
      listed: companies.length,
      otc: 0,
      returned: companies.length,
    },
    profileCoverage: {
      incorporationDate: { reported: 0, missing: companies.length, invalid: 0 },
      paidInCapitalTwd: { reported: 0, missing: companies.length, invalid: 0 },
      issuedCommonShares: { reported: 0, missing: companies.length, invalid: 0 },
      parValueText: { reported: 0, missing: companies.length, invalid: 0 },
      financialReportTypeCode: { reported: 0, missing: companies.length, invalid: 0 },
    },
    companies,
    warnings: [],
  };
}

function revenueRow(code: string, name: string) {
  return {
    code,
    name,
    market: "listed" as const,
    industryCode: "17",
    sourceIndustryName: "金融保險業",
    sourceReportDate: "2026-08-10",
    currentMonthRevenueTwd: 120,
    previousMonthRevenueTwd: 110,
    sameMonthLastYearRevenueTwd: 100,
    momPercent: 9,
    yoyPercent: 20,
    currentYearCumulativeRevenueTwd: 700,
    previousYearCumulativeRevenueTwd: 600,
    cumulativeYoyPercent: 16,
    note: null,
    valueStatus: {
      currentMonthRevenueTwd: "reported" as const,
      previousMonthRevenueTwd: "reported" as const,
      sameMonthLastYearRevenueTwd: "reported" as const,
      momPercent: "reported" as const,
      yoyPercent: "reported" as const,
      currentYearCumulativeRevenueTwd: "reported" as const,
      previousYearCumulativeRevenueTwd: "reported" as const,
      cumulativeYoyPercent: "reported" as const,
    },
  };
}

function valuationRow(code: string, name: string) {
  return {
    code,
    name,
    market: "listed" as const,
    peRatio: 15,
    priceToBookRatio: 2,
    dividendYieldPercent: 3,
    closePriceTwd: 50,
    dividendPerShareTwd: null,
    dividendFiscalYear: null,
    referenceFiscalPeriod: null,
    valueStatus: {
      peRatio: "reported" as const,
      priceToBookRatio: "reported" as const,
      dividendYieldPercent: "reported" as const,
      closePriceTwd: "reported" as const,
      dividendPerShareTwd: "not_provided_by_source" as const,
      dividendFiscalYear: "not_provided_by_source" as const,
      referenceFiscalPeriod: "not_provided_by_source" as const,
    },
    rawValue: {
      peRatio: "15",
      priceToBookRatio: "2",
      dividendYieldPercent: "3",
      closePriceTwd: "50",
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: null,
    },
  };
}

function profitabilityMetric(
  role: "roe" | "net_profit" | "eps",
  values: number[],
): CompanyMetricsBatchMetric {
  const definition = resolvedFinancialMetric(resolution, role);
  const points = periods.map((period, index) => ({
    period,
    value: values[index] as number,
    valueStatus: "reported" as const,
  }));
  return {
    metricCode: definition.metricCode,
    metricName: definition.metricName,
    unit: definition.unit,
    availability: "available",
    periods,
    points,
    coverage: {
      seriesReturned: true,
      nonNullPoints: points.length,
      missingPoints: 0,
      invalidPoints: 0,
      firstReportedPeriod: periods[0],
      latestReportedPeriod: periods.at(-1) as string,
      missingPeriods: [],
    },
    failure: null,
  };
}

function profitabilityCompany(code = "2801"): CompanyMetricsBatchCompany {
  return {
    companyCode: code,
    companyName: "彰銀",
    displayName: `${code} 彰銀`,
    evaluationStatus: "complete",
    metrics: [
      profitabilityMetric("roe", [8, 8, 10, 10, 11]),
      profitabilityMetric("net_profit", [80, 90, 100, 110, 120]),
      profitabilityMetric("eps", [1, 1.1, 1.2, 1.3, 1.5]),
    ],
  };
}

function institutionMetric(
  role:
    | "bank_capital_adequacy_ratio"
    | "loan_overdue_ratio"
    | "loan_loss_reserve_coverage_ratio",
  values: [number, number],
  average: [number, number],
): FinancialInstitutionBatchMetric {
  const definition = resolvedFinancialMetric(resolution, role);
  const metricPeriods = ["2025Q2", "2026Q2"];
  return {
    role,
    metricCode: definition.metricCode,
    metricName: definition.metricName,
    family: definition.family as "fin" | "adequacy",
    unit: definition.unit,
    availability: "available",
    periods: metricPeriods,
    points: metricPeriods.map((period, index) => ({
      period,
      value: values[index],
      valueStatus: "reported" as const,
    })),
    industryAveragePoints: metricPeriods.map((period, index) => ({
      period,
      value: average[index],
      valueStatus: "reported" as const,
    })),
    coverage: {
      seriesReturned: true,
      nonNullPoints: 2,
      missingPoints: 0,
      invalidPoints: 0,
      firstReportedPeriod: "2025Q2",
      latestReportedPeriod: "2026Q2",
      missingPeriods: [],
      industryAverageSeriesReturned: true,
    },
    failure: null,
  };
}

function institutionCompany(): FinancialInstitutionBatchCompany {
  return {
    companyCode: "2801",
    institutionCode: "2801",
    institutionName: "彰銀",
    sector: "bank",
    evaluationStatus: "complete",
    metrics: [
      institutionMetric("bank_capital_adequacy_ratio", [14, 15], [14, 14.5]),
      institutionMetric("loan_overdue_ratio", [1.2, 1], [1.1, 1.1]),
      institutionMetric(
        "loan_loss_reserve_coverage_ratio",
        [120, 130],
        [121, 125],
      ),
    ],
  };
}

function reaction(code: string): CompanyReactionSignals {
  const average = (windowSessions: 5 | 20 | 60, value: number) => ({
    windowSessions,
    startDate: "2026-05-01",
    endDate: "2026-08-28",
    expectedObservationCount: windowSessions,
    observationCount: windowSessions,
    value,
    status: "available" as const,
  });
  return {
    companyCode: code,
    companyName: "彰銀",
    market: "listed",
    benchmarkCode: "TAIEX",
    requestedAsOf: "latest",
    resolvedAsOf: "2026-08-28",
    stockDataStatus: "available",
    stockDataFailure: null,
    returns: ([5, 20, 60] as const).map((horizonSessions) => ({
      horizonSessions,
      startDate: "2026-05-01",
      endDate: "2026-08-28",
      stockReturnPercent: 2,
      priceIndexCompatibleStockReturnPercent: 2,
      corporateActionAdjustmentFactor: 1,
      benchmarkReturnPercent: 1,
      excessReturnPercentagePoints: 1,
      status: "available" as const,
      excessReturnStatus: "available" as const,
      excessReturnReasons: [],
    })),
    liquidity: {
      averageVolume5SessionsShares: average(5, 100_000),
      averageVolume20SessionsShares: average(20, 100_000),
      volume5To20Ratio: {
        numeratorWindowSessions: 5,
        denominatorWindowSessions: 20,
        value: 1,
        status: "available",
      },
      averageTurnover20SessionsTwd: average(20, 10_000_000),
      averageTurnover60SessionsTwd: average(60, 10_000_000),
      turnover20To60Ratio: {
        numeratorWindowSessions: 20,
        denominatorWindowSessions: 60,
        value: 1,
        status: "available",
      },
    },
    pricePath: {
      horizonSessions: 60,
      startDate: "2026-05-01",
      endDate: "2026-08-28",
      expectedObservationCount: 60,
      observationCount: 60,
      maximumDrawdownPercent: -10,
      distanceBelowWindowHighPercent: 10,
      priceBasis: "price_index_compatible_corporate_action_adjusted",
      status: "available",
    },
    comparability: {
      status: "price_index_compatible",
      rawPriceBasis: "raw_unadjusted",
      returnBasis: "price_index_compatible_corporate_action_adjusted",
      corporateActionAdjustment: "not_required",
      corporateActionEvidence: "official_history_verified_no_event",
      corporateActionCoverageComplete: true,
      marketTransitionDetected: false,
      observedMarkets: ["listed"],
      corporateActions: [],
      officialChangeMarkers: [],
      unmatchedOfficialChangeMarkers: [],
      reasons: [],
    },
    dataQualityComplete: true,
    warnings: [],
  };
}

function happyFixture() {
  const companies = [
    masterCompany("2801", "彰銀"),
    masterCompany("2812", "台中銀"),
    masterCompany("2834", "臺企銀"),
  ];
  const getCompanyMetricsBatch = vi.fn().mockResolvedValue({
    query: {
      companyCodes: ["2801"],
      metricCodes: ["ROE", "NetProfit", "EPS"],
      basis: "quarterly",
      history: "recent_12",
    },
    retrievedAt: "2026-08-30T00:00:00.000Z",
    snapshotId: "profitability",
    metricDefinitions: ["roe", "net_profit", "eps"].map((role) => {
      const metric = resolvedFinancialMetric(
        resolution,
        role as "roe" | "net_profit" | "eps",
      );
      return {
        code: metric.metricCode,
        name: metric.metricName,
        unit: metric.unit,
        category: metric.category,
      };
    }),
    companies: [profitabilityCompany()],
    failures: [],
    coverage: {
      selectionComplete: true,
      requestedCompanyCodes: ["2801"],
      returnedCompanyCodes: ["2801"],
      missingCompanyCodes: [],
      noValidDataCompanyCodes: [],
      unavailableCompanyCodes: [],
      sourceComplete: true,
      failureIsolationComplete: true,
      identityFailedCompanyCodes: [],
      metrics: [],
    },
    workBudget: {
      comparisonPlanUnits: 3,
      comparisonExecutedUnits: 3,
      isolationRetryUnits: 0,
      comparisonUnitLimit: 24,
      identityLookupUpperBound: 1,
      unitDefinition: "one_metric_by_up_to_ten_companies_request",
    },
    sources: [],
    warnings: [],
  });
  const getFinancialInstitutionMetricsBatch = vi.fn().mockResolvedValue({
    query: {
      companyCodes: ["2801"],
      institutionCodes: ["2801"],
      metricRoles: [
        "bank_capital_adequacy_ratio",
        "loan_overdue_ratio",
        "loan_loss_reserve_coverage_ratio",
      ],
      history: "recent_12",
    },
    retrievedAt: "2026-08-30T00:00:00.000Z",
    snapshotId: "institution",
    catalogDiscoveredAt: resolution.catalogDiscoveredAt,
    catalogSnapshotId: resolution.catalogSnapshotId,
    metricDefinitions: [
      "bank_capital_adequacy_ratio",
      "loan_overdue_ratio",
      "loan_loss_reserve_coverage_ratio",
    ].map((role) => resolvedFinancialMetric(
      resolution,
      role as
        | "bank_capital_adequacy_ratio"
        | "loan_overdue_ratio"
        | "loan_loss_reserve_coverage_ratio",
    )),
    companies: [institutionCompany()],
    failures: [],
    coverage: {
      selectionComplete: true,
      sourceComplete: true,
      failureIsolationComplete: true,
      requestedCompanyCodes: ["2801"],
      unavailableCompanyCodes: [],
      noValidDataCompanyCodes: [],
      metrics: [],
    },
    workBudget: {
      comparisonPlanUnits: 3,
      comparisonExecutedUnits: 3,
      isolationRetryUnits: 0,
      comparisonUnitLimit: 24,
      concurrencyLimit: 2,
      unitDefinition:
        "one_financial_metric_by_up_to_ten_institutions_request",
    },
    sources: [],
    warnings: [],
  });
  const client = new TaiwanFinancialScreenClient(
    {
      companyMaster: {
        listCompanies: vi.fn().mockResolvedValue(companyMasterResult(companies)),
      },
      catalog: { getCatalog: vi.fn().mockResolvedValue(catalog) },
      revenue: {
        getMonthlyRevenue: vi.fn().mockResolvedValue({
          query: { market: "listed", dataMonth: "latest", companyCodes: ["2801"], universePolicy: "compatible" },
          dataMonth: "2026-07",
          currency: "TWD",
          amountUnit: "TWD",
          coverageComplete: true,
          sourceCoverage: { status: "verified", method: "current_master_exact_match", complete: true },
          selectionComplete: true,
          missingCompanyCodes: [],
          counts: { raw: 1, returned: 1 },
          filingCoverage: [],
          reconciliation: [],
          rows: [revenueRow("2801", "彰銀")],
          sources: [],
          warnings: [],
        }),
        getMonthlyRevenueTrend: vi.fn().mockResolvedValue({
          query: { market: "listed", companyCodes: ["2801"], endMonth: "latest", lookbackMonths: 6, universePolicy: "compatible" },
          startMonth: "2026-02",
          endMonth: "2026-07",
          currency: "TWD",
          amountUnit: "TWD",
          coverageComplete: true,
          sourceCoverage: { status: "verified", method: "current_master_exact_match", complete: true },
          selectionComplete: true,
          missingCompanyCodes: [],
          counts: { requestedCompanies: 1, returnedCompanies: 1, requestedMonths: 6 },
          companies: [{
            code: "2801",
            name: "彰銀",
            market: "listed",
            industryCode: "17",
            sourceIndustryName: "金融保險業",
            observedNames: ["彰銀"],
            observedMarkets: ["listed"],
            comparability: { status: "comparable", reasons: [], transitions: [] },
            missingMonths: [],
            points: [2, 4, 6, 8, 10, 12].map((yoyPercent, index) => ({
              dataMonth: `2026-0${index + 2}`,
              name: "彰銀",
              market: "listed",
              sourceReportDate: "2026-08-10",
              sourceIndustryName: "金融保險業",
              currentMonthRevenueTwd: 100,
              sameMonthLastYearRevenueTwd: 90,
              momPercent: 1,
              yoyPercent,
              valueStatus: {
                currentMonthRevenueTwd: "reported",
                sameMonthLastYearRevenueTwd: "reported",
                momPercent: "reported",
                yoyPercent: "reported",
              },
            })),
            derived: {
              latestYoyPercent: 12,
              rolling3MonthYoyPercent: 10,
              rolling6MonthYoyPercent: 7,
              yoyAccelerationVs3MonthsAgoPp: 6,
              positiveYoyMonthsInWindow: 6,
              reportedYoyMonthsInWindow: 6,
              consecutivePositiveYoyMonths: 6,
              valueStatus: {
                latestYoyPercent: "reported",
                rolling3MonthYoyPercent: "reported",
                rolling6MonthYoyPercent: "reported",
                yoyAccelerationVs3MonthsAgoPp: "reported",
                positiveYoyMonthsInWindow: "reported",
                reportedYoyMonthsInWindow: "reported",
                consecutivePositiveYoyMonths: "reported",
              },
            },
          }],
          sources: [],
          warnings: [],
        }),
      },
      valuation: {
        getDailyMarketValuation: vi.fn().mockResolvedValue({
          query: { market: "listed", date: "latest", universePolicy: "compatible" },
          dataDate: "2026-08-28",
          currency: "TWD",
          classificationPolicy: "current_master_with_compatible_code_fallback",
          coverageComplete: true,
          universeCoverageVerified: true,
          selectionComplete: true,
          missingCompanyCodes: [],
          reconciliation: [],
          counts: { raw: 3, returned: 3, withPe: 3, withPb: 3, withDividendYield: 3, withClosePrice: 3, withDividendPerShare: 0, withDividendFiscalYear: 0, withReferenceFiscalPeriod: 0 },
          rows: companies.map((company) => valuationRow(company.code, company.shortName)),
          sources: [],
          warnings: [],
        }),
      },
      metrics: { getCompanyMetricsBatch },
      institutionMetrics: { getFinancialInstitutionMetricsBatch },
      reaction: {
        getStockReactionSignals: vi.fn().mockResolvedValue({
          query: { companyCodes: ["2801"], asOf: "latest", horizons: [5, 20, 60], pageSize: 1 },
          timezone: "Asia/Taipei",
          currency: "TWD",
          priceBasis: "raw_unadjusted",
          returnBasis: "price_index_compatible_corporate_action_adjusted",
          benchmarkBasis: "price_index",
          asOf: { requested: "latest", resolvedByMarket: [{ market: "listed", date: "2026-08-28" }] },
          coverage: { selectionComplete: true, benchmarkHistoryComplete: true, corporateActionHistoryComplete: true, dataQualityComplete: true, missingCompanyCodes: [] },
          pagination: { snapshotId: "reaction", requestedCompanyCount: 1, requestedPageSize: 1, pageStartIndex: 0, returnedCompanyCount: 1, nextCompanyIndex: 1, hasMore: false, nextCursor: null },
          workBudget: { limit: 48, consumed: 3, benchmarkUnits: 1, stockUnits: 2, unitDefinition: "one_official_market_month_request", corporateActionRequests: 1, corporateActionRequestDefinition: "one_official_range_or_detail_request" },
          companies: [reaction("2801")],
          benchmarkSources: [],
          stockSources: [],
          corporateActionSources: [],
          warnings: [],
        }),
      },
    } as never,
    () => new Date("2026-08-30T00:00:00.000Z"),
  );
  return { client, getCompanyMetricsBatch, getFinancialInstitutionMetricsBatch };
}

describe("TaiwanFinancialScreenClient", () => {
  it("orchestrates exact-mapped bank evidence and returns a model-local candidate", async () => {
    const fixture = happyFixture();
    const result = await fixture.client.screenTaiwanFinancialCandidates({
      market: "listed",
      companyCodes: ["2801"],
      includeKy: true,
      candidateLimit: 1,
      preset: "balanced_financial_v1",
    });

    expect(result.funnel).toMatchObject({
      selectedFinancial: 1,
      mappedSupported: 1,
      deepSelected: 1,
      reactionSelected: 1,
      returned: 1,
      buckets: { research_candidate: 1 },
    });
    expect(result.candidates[0]).toMatchObject({
      companyCode: "2801",
      financialSubtype: "bank",
      institutionCode: "2801",
      modelId: "taiwan_financial_screen.v1",
      preset: "balanced_financial_v1",
      scoreComparisonScope: "within_financial_model_only",
      bucket: "research_candidate",
      asOf: {
        profitabilityThroughPeriod: "2026Q2",
        capitalThroughPeriod: "2026Q2",
        assetQualityThroughPeriod: "2026Q2",
      },
    });
    expect(fixture.getCompanyMetricsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ metricCodes: ["ROE", "NetProfit", "EPS"] }),
    );
    expect(fixture.getFinancialInstitutionMetricsBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        metricRoles: [
          "bank_capital_adequacy_ratio",
          "loan_overdue_ratio",
          "loan_loss_reserve_coverage_ratio",
        ],
      }),
    );
    expect(screenTaiwanFinancialCandidatesDataSchema.safeParse(result).success).toBe(
      true,
    );
  });

  it("accounts for non-financial, KY and unmapped selections without running deep dependencies", async () => {
    const companies = [
      masterCompany("2330", "台積電", { financial: false }),
      masterCompany("2801", "彰銀", { ky: true }),
      masterCompany("2823", "中壽"),
    ];
    const deep = vi.fn();
    const client = new TaiwanFinancialScreenClient({
      companyMaster: {
        listCompanies: vi.fn().mockResolvedValue(companyMasterResult(companies)),
      },
      catalog: { getCatalog: vi.fn().mockResolvedValue(catalog) },
      revenue: {
        getMonthlyRevenue: vi.fn().mockResolvedValue({
          coverageComplete: true,
          sourceCoverage: { status: "verified" },
          selectionComplete: true,
          missingCompanyCodes: [],
          dataMonth: "2026-07",
          rows: [],
          sources: [],
        }),
        getMonthlyRevenueTrend: deep,
      },
      valuation: {
        getDailyMarketValuation: vi.fn().mockResolvedValue({
          coverageComplete: true,
          universeCoverageVerified: true,
          selectionComplete: true,
          missingCompanyCodes: [],
          dataDate: "2026-08-28",
          rows: [],
          sources: [],
        }),
      },
      metrics: { getCompanyMetricsBatch: deep },
      institutionMetrics: { getFinancialInstitutionMetricsBatch: deep },
      reaction: { getStockReactionSignals: deep },
    } as never);

    const result = await client.screenTaiwanFinancialCandidates({
      market: "listed",
      companyCodes: ["2330", "2801", "2823"],
      includeKy: false,
      candidateLimit: 1,
      preset: "balanced_financial_v1",
    });

    expect(result.funnel).toMatchObject({
      selectedFinancial: 1,
      mappedSupported: 0,
      excludedNonFinancial: 1,
      excludedKy: 1,
      institutionNotFound: 1,
      returned: 0,
    });
    expect(result.excluded.map(({ companyCode, reasonCodes }) => [
      companyCode,
      reasonCodes[0],
    ])).toEqual(expect.arrayContaining([
      ["2330", "non_financial_company_not_supported"],
      ["2801", "ky_company_excluded_by_query"],
      ["2823", "financial_institution_exact_code_not_found"],
    ]));
    expect(deep).not.toHaveBeenCalled();
  });
});
