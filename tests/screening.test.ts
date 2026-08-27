import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import type {
  CompanyMetricsBatchCompany,
  CompanyMetricsBatchResult,
} from "@/lib/mopsfin/batch";
import type { CompanyReactionSignals } from "@/lib/reaction/types";
import type {
  MonthlyRevenueResult,
  MonthlyRevenueRow,
  MonthlyRevenueTrendCompany,
  MonthlyRevenueTrendResult,
} from "@/lib/revenue/types";
import {
  buildCompanyQualityPillar,
  buildFundamentalImprovementPillar,
  buildMarketUnderreactionPillar,
  buildReasonableValuationPillar,
  classifyCandidate,
  compareScreenCandidates,
  valuationPeerContext,
} from "@/lib/screening/calculations";
import { TaiwanStockScreenClient } from "@/lib/screening/client";
import {
  TAIWAN_STOCK_SCREEN_PRESET,
  type ScreenPillar,
  type TaiwanStockScreenCandidate,
} from "@/lib/screening/types";
import type {
  DailyMarketValuationResult,
  ValuationRow,
} from "@/lib/valuation/types";

const PERIODS = [
  "2025Q2",
  "2025Q3",
  "2025Q4",
  "2026Q1",
  "2026Q2",
] as const;

function company(code: string, industryCode = "24"): MasterCompany {
  return {
    code,
    name: `公司${code}`,
    shortName: `C${code}`,
    market: "listed",
    exchange: "TWSE",
    industryCode,
    listingDate: "2000-01-01",
    incorporationDate: null,
    paidInCapitalTwd: null,
    issuedCommonShares: null,
    parValueText: null,
    financialReportTypeCode: null,
    profileValueStatus: {
      incorporationDate: "missing",
      paidInCapitalTwd: "missing",
      issuedCommonShares: "missing",
      parValueText: "missing",
      financialReportTypeCode: "missing",
    },
    domicileCode: "TW",
    isKy: false,
    isFinancial: false,
  };
}

function valuation(
  code: string,
  values: Partial<Pick<ValuationRow, "peRatio" | "priceToBookRatio" | "dividendYieldPercent">> = {},
): ValuationRow {
  const peRatio = values.peRatio === undefined ? 15 : values.peRatio;
  const priceToBookRatio = values.priceToBookRatio === undefined
    ? 2
    : values.priceToBookRatio;
  const dividendYieldPercent = values.dividendYieldPercent === undefined
    ? 3
    : values.dividendYieldPercent;
  const status = (value: number | null) =>
    value === null ? "missing_or_not_meaningful" as const : "reported" as const;
  return {
    code,
    name: `C${code}`,
    market: "listed",
    peRatio,
    priceToBookRatio,
    dividendYieldPercent,
    closePriceTwd: 100,
    dividendPerShareTwd: null,
    dividendFiscalYear: null,
    referenceFiscalPeriod: null,
    valueStatus: {
      peRatio: status(peRatio),
      priceToBookRatio: status(priceToBookRatio),
      dividendYieldPercent: status(dividendYieldPercent),
      closePriceTwd: "reported",
      dividendPerShareTwd: "not_provided_by_source",
      dividendFiscalYear: "not_provided_by_source",
      referenceFiscalPeriod: "not_provided_by_source",
    },
    rawValue: {
      peRatio: peRatio?.toString() ?? null,
      priceToBookRatio: priceToBookRatio?.toString() ?? null,
      dividendYieldPercent: dividendYieldPercent?.toString() ?? null,
      closePriceTwd: "100",
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: null,
    },
  };
}

function metrics(
  code: string,
  overrides: Partial<Record<string, Array<number | null>>> = {},
): CompanyMetricsBatchCompany {
  const defaults: Record<string, number[]> = {
    ROE: [10, 10, 12, 12, 12],
    NetIncome: [8, 10, 10, 10, 10],
    OperatingCashFlow: [8, 9, 9, 9, 9],
    DebtRatio: [50, 50, 50, 50, 50],
    GrossMargin: [30, 30, 30, 30, 31],
    OperatingMargin: [10, 10, 10, 10, 11],
    EPS: [1, 1.2, 1.4, 1.5, 2],
  };
  return {
    companyCode: code,
    companyName: `公司${code}`,
    displayName: `${code} 公司${code}`,
    evaluationStatus: "complete",
    metrics: Object.entries(defaults).map(([metricCode, defaultValues]) => {
      const values = overrides[metricCode] ?? defaultValues;
      const points = PERIODS.map((period, index) => ({
        period,
        value: values[index] ?? null,
        valueStatus: values[index] === null ? "missing" as const : "reported" as const,
      }));
      const reported = points.filter((point) => point.valueStatus === "reported");
      return {
        metricCode,
        metricName: metricCode,
        unit: ["ROE", "DebtRatio", "GrossMargin", "OperatingMargin"].includes(metricCode)
          ? "%"
          : "TWD",
        availability: "available",
        periods: [...PERIODS],
        points,
        coverage: {
          seriesReturned: true,
          nonNullPoints: reported.length,
          missingPoints: points.length - reported.length,
          invalidPoints: 0,
          firstReportedPeriod: reported[0]?.period ?? null,
          latestReportedPeriod: reported.at(-1)?.period ?? null,
          missingPeriods: points
            .filter((point) => point.valueStatus !== "reported")
            .map((point) => point.period),
        },
        failure: null,
      };
    }),
  };
}

function trend(code: string, latestYoy = 12): MonthlyRevenueTrendCompany {
  const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  const yoys = [2, 4, 6, 8, 10, latestYoy];
  return {
    code,
    name: `C${code}`,
    market: "listed",
    industryCode: "24",
    sourceIndustryName: "半導體業",
    observedNames: [`C${code}`],
    observedMarkets: ["listed"],
    comparability: { status: "comparable", reasons: [], transitions: [] },
    missingMonths: [],
    points: months.map((dataMonth, index) => ({
      dataMonth,
      name: `C${code}`,
      market: "listed",
      sourceReportDate: `${dataMonth}-10`,
      sourceIndustryName: "半導體業",
      currentMonthRevenueTwd: 100 + index * 10,
      sameMonthLastYearRevenueTwd: 90,
      momPercent: 2,
      yoyPercent: yoys[index] as number,
      valueStatus: {
        currentMonthRevenueTwd: "reported",
        sameMonthLastYearRevenueTwd: "reported",
        momPercent: "reported",
        yoyPercent: "reported",
      },
    })),
    derived: {
      latestYoyPercent: latestYoy,
      rolling3MonthYoyPercent: (8 + 10 + latestYoy) / 3,
      rolling6MonthYoyPercent: yoys.reduce((sum, value) => sum + value, 0) / 6,
      yoyAccelerationVs3MonthsAgoPp: latestYoy - 6,
      positiveYoyMonthsInWindow: yoys.filter((value) => value > 0).length,
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
  };
}

function reaction(
  code: string,
  options: { excess20?: number; turnover?: number; comparable?: boolean } = {},
): CompanyReactionSignals {
  const excess20 = options.excess20 ?? 2;
  const average = (windowSessions: 5 | 20 | 60, value: number) => ({
    windowSessions,
    startDate: "2026-05-01",
    endDate: "2026-07-31",
    expectedObservationCount: windowSessions,
    observationCount: windowSessions,
    value,
    status: "available" as const,
  });
  return {
    companyCode: code,
    companyName: `C${code}`,
    market: "listed",
    benchmarkCode: "TAIEX",
    requestedAsOf: "latest",
    resolvedAsOf: "2026-07-31",
    stockDataStatus: "available",
    returns: ([5, 20, 60] as const).map((horizonSessions) => ({
      horizonSessions,
      startDate: "2026-05-01",
      endDate: "2026-07-31",
      stockReturnPercent: horizonSessions === 20 ? excess20 + 1 : 2,
      benchmarkReturnPercent: 1,
      excessReturnPercentagePoints: horizonSessions === 20 ? excess20 : 1,
      status: "available",
      excessReturnStatus: "available",
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
      averageTurnover20SessionsTwd: average(20, options.turnover ?? 10_000_000),
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
      endDate: "2026-07-31",
      expectedObservationCount: 60,
      observationCount: 60,
      maximumDrawdownPercent: -10,
      distanceBelowWindowHighPercent: 10,
      status: "available",
    },
    comparability: {
      status: options.comparable === false ? "not_comparable" : "provisional_raw",
      priceBasis: "raw_unadjusted",
      corporateActionAdjustment: "not_applied",
      corporateActionEvidence: "none_observed",
      marketTransitionDetected: false,
      observedMarkets: ["listed"],
      officialChangeMarkers: [],
      reasons: options.comparable === false
        ? ["multiple_observed_names"]
        : ["raw_prices_not_adjusted"],
    },
    dataQualityComplete: true,
    warnings: [],
  };
}

function pillar(
  key: ScreenPillar["key"],
  status: ScreenPillar["status"],
  score = status === "unknown" ? null : 80,
  hardFailReasons: string[] = [],
): ScreenPillar {
  return {
    key,
    label: key,
    status,
    score,
    knownWeight: status === "unknown" ? 0 : 100,
    totalWeight: 100,
    criteria: [],
    hardFailReasons,
    evidenceGaps: status === "unknown" ? [key] : [],
  };
}

function candidate(
  companyCode: string,
  bucket: TaiwanStockScreenCandidate["bucket"],
  overallScore: number | null,
  evidenceCompletenessPercent = 100,
): TaiwanStockScreenCandidate {
  const passPillars = {
    companyQuality: pillar("company_quality", "pass"),
    fundamentalImprovement: pillar("fundamental_improvement", "pass"),
    reasonableValuation: pillar("reasonable_valuation", "pass"),
    marketUnderreactionProxy: pillar("market_underreaction_proxy", "pass"),
  };
  return {
    rank: 0,
    companyCode,
    companyName: `C${companyCode}`,
    shortName: `C${companyCode}`,
    market: "listed",
    industryCode: "24",
    listingDate: "2000-01-01",
    isKy: false,
    bucket,
    overallScore,
    evidenceCompletenessPercent,
    broadEvidence: {
      revenueMonth: "2026-07",
      latestRevenueYoyPercent: 10,
      cumulativeRevenueYoyPercent: 10,
      valuationDate: "2026-07-31",
      peRatio: 15,
      priceToBookRatio: 2,
      dividendYieldPercent: 3,
      closePriceTwd: 100,
      coarseScore: 100,
    },
    pillars: passPillars,
    firstRejectionReasons: [],
    evidenceGaps: [],
    nextDiligence: [],
    asOf: {
      masterReportDate: "2026-07-31",
      revenueThroughMonth: "2026-07",
      valuationDate: "2026-07-31",
      financialThroughPeriod: "2026Q2",
      reactionDate: "2026-07-31",
    },
  };
}

describe("Taiwan stock screen calculations", () => {
  it("makes company quality pass, fail, or unknown without coercing missing evidence to zero", () => {
    const passing = buildCompanyQualityPillar(metrics("1101"), "2026Q2");
    const failing = buildCompanyQualityPillar(
      metrics("1102", {
        ROE: [-1, -1, -1, -1, -1],
        NetIncome: [-5, -5, -5, -5, -5],
        OperatingCashFlow: [-5, -5, -5, -5, -5],
        DebtRatio: [90, 90, 90, 90, 90],
      }),
      "2026Q2",
    );
    const withMissingCashFlow = buildCompanyQualityPillar(
      metrics("1103", { OperatingCashFlow: [8, 9, 9, 9, null] }),
      "2026Q2",
    );

    expect(passing.status).toBe("pass");
    expect(failing.status).toBe("fail");
    expect(failing.hardFailReasons).toEqual(
      expect.arrayContaining([
        "non_positive_annual_roe",
        "non_positive_ttm_net_income",
        "non_positive_ttm_operating_cash_flow",
        "debt_ratio_above_85_percent",
      ]),
    );
    expect(withMissingCashFlow.status).toBe("unknown");
    expect(
      withMissingCashFlow.criteria.find(
        (item) => item.code === "ttm_operating_cash_conversion",
      ),
    ).toMatchObject({ status: "unknown", value: null });
  });

  it("does not substitute an older annual ROE when the expected Q4 is missing", () => {
    const staleAnnual = metrics("1104", { ROE: [10, 10, null, 12, 12] });
    const roe = staleAnnual.metrics.find((item) => item.metricCode === "ROE");
    roe?.points.unshift({
      period: "2024Q4",
      value: 20,
      valueStatus: "reported",
    });

    const result = buildCompanyQualityPillar(staleAnnual, "2026Q2");

    expect(result.status).toBe("unknown");
    expect(result.criteria.find((item) => item.code === "annual_roe")).toMatchObject({
      status: "unknown",
      value: null,
      periods: [],
    });
  });

  it("makes fundamental improvement pass, fail, or unknown using exact-period evidence", () => {
    const passing = buildFundamentalImprovementPillar(
      metrics("1201"),
      trend("1201"),
      "2026Q2",
    );
    const failing = buildFundamentalImprovementPillar(
      metrics("1202"),
      trend("1202", -5),
      "2026Q2",
    );
    const unknown = buildFundamentalImprovementPillar(
      metrics("1203", { EPS: [null, 1.2, 1.4, 1.5, 2] }),
      trend("1203"),
      "2026Q2",
    );

    expect(passing.status).toBe("pass");
    expect(failing.status).toBe("fail");
    expect(failing.hardFailReasons).toContain("revenue_improvement_breadth_failed");
    expect(unknown.status).toBe("unknown");
    expect(unknown.criteria.find((item) => item.code === "eps_yoy")).toMatchObject({
      status: "unknown",
      value: 2,
    });
  });

  it("makes valuation and market-reaction pillars pass, fail, or unknown", () => {
    const peerContext = {
      scope: "same_industry" as const,
      peScope: "same_industry" as const,
      pbScope: "same_industry" as const,
      yieldScope: "same_industry" as const,
      pePeerCount: 30,
      pbPeerCount: 30,
      yieldPeerCount: 30,
      pePercentile: 50,
      pbPercentile: 50,
      yieldPercentile: 50,
    };
    const valuationPass = buildReasonableValuationPillar(
      valuation("1301"),
      { period: "2025Q4", value: 12 },
      peerContext,
      "2026-07-31",
    );
    const valuationFail = buildReasonableValuationPillar(
      valuation("1302", { peRatio: 60, priceToBookRatio: 8, dividendYieldPercent: 0 }),
      { period: "2025Q4", value: 10 },
      { ...peerContext, pePercentile: 95, pbPercentile: 95, yieldPercentile: 5 },
      "2026-07-31",
    );
    const valuationUnknown = buildReasonableValuationPillar(
      valuation("1303", {
        peRatio: null,
        priceToBookRatio: null,
        dividendYieldPercent: null,
      }),
      null,
      { ...peerContext, pePercentile: null, pbPercentile: null, yieldPercentile: null },
      "2026-07-31",
    );

    expect(valuationPass.status).toBe("pass");
    expect(valuationFail.status).toBe("fail");
    expect(valuationFail.hardFailReasons).toEqual(
      expect.arrayContaining(["pe_extreme_vs_peers", "roe_adjusted_pb_extreme_vs_peers"]),
    );
    expect(valuationUnknown.status).toBe("unknown");
    expect(valuationUnknown.criteria.find((item) => item.code === "pe_primary")).toMatchObject({
      status: "unknown",
      value: null,
    });

    expect(buildMarketUnderreactionPillar(reaction("1301")).status).toBe("pass");
    expect(buildMarketUnderreactionPillar(reaction("1302", { excess20: 20 })).status).toBe("fail");
    expect(buildMarketUnderreactionPillar(reaction("1303", { comparable: false })).status).toBe("unknown");
  });

  it("uses deterministic mid-rank percentiles and falls back from industry to market", () => {
    const subject = company("2000", "99");
    const peers = Array.from({ length: 21 }, (_, index) =>
      company(String(2000 + index), index === 0 ? "99" : "24"),
    );
    const rows = peers.map((item, index) =>
      valuation(item.code, {
        peRatio: index + 10,
        priceToBookRatio: index + 1,
        dividendYieldPercent: index,
      }),
    );
    const context = valuationPeerContext(subject, rows[0] as ValuationRow, peers, rows);

    expect(context.scope).toBe("same_market");
    expect(context.pePeerCount).toBe(21);
    expect(context.pePercentile).toBe(2.4);
    expect(context.pbPercentile).toBe(2.4);
    expect(context.yieldPercentile).toBe(2.4);
  });

  it("enforces pillar gates before score and sorts deterministically", () => {
    const allPass = {
      companyQuality: pillar("company_quality", "pass"),
      fundamentalImprovement: pillar("fundamental_improvement", "pass"),
      reasonableValuation: pillar("reasonable_valuation", "pass"),
      marketUnderreactionProxy: pillar("market_underreaction_proxy", "pass"),
    };
    expect(classifyCandidate(allPass)).toBe("research_candidate");
    expect(
      classifyCandidate({
        ...allPass,
        reasonableValuation: pillar("reasonable_valuation", "fail", 99),
      }),
    ).toBe("watchlist");
    expect(
      classifyCandidate({
        ...allPass,
        reasonableValuation: pillar("reasonable_valuation", "unknown"),
      }),
    ).toBe("insufficient_data");
    expect(
      classifyCandidate({
        ...allPass,
        companyQuality: pillar("company_quality", "fail", 99, ["quality_hard_fail"]),
      }),
    ).toBe("deprioritized");

    const sorted = [
      candidate("1004", "deprioritized", 99),
      candidate("1003", "watchlist", 90),
      candidate("1002", "research_candidate", 80),
      candidate("1001", "research_candidate", 80),
    ].sort(compareScreenCandidates);
    expect(sorted.map((item) => item.companyCode)).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
    ]);
  });
});

function masterResult(companies: MasterCompany[]): CompanyMasterResult {
  return {
    query: { market: "all", includeFinancial: true, includeKy: true },
    generatedAt: "2026-08-01T00:00:00.000Z",
    snapshotId: "master-snapshot",
    coverageVerification: {
      status: "heuristic",
      method: "required_sources_schema_single_report_date_minimum_count",
      officialDeclaredRowCountAvailable: false,
    },
    coverageComplete: true,
    sources: [{
      market: "listed",
      exchange: "TWSE",
      sourceName: "TWSE",
      sourceUrl: "https://example.test/master",
      reportDate: "2026-07-31",
      retrievedAt: "2026-08-01T00:00:00.000Z",
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

function revenueRow(code: string): MonthlyRevenueRow {
  return {
    code,
    name: `C${code}`,
    market: "listed",
    industryCode: "24",
    sourceIndustryName: "半導體業",
    sourceReportDate: "2026-08-10",
    currentMonthRevenueTwd: 120,
    previousMonthRevenueTwd: 110,
    sameMonthLastYearRevenueTwd: 100,
    momPercent: 9.1,
    yoyPercent: 20,
    currentYearCumulativeRevenueTwd: 700,
    previousYearCumulativeRevenueTwd: 600,
    cumulativeYoyPercent: 16.7,
    note: null,
    valueStatus: {
      currentMonthRevenueTwd: "reported",
      previousMonthRevenueTwd: "reported",
      sameMonthLastYearRevenueTwd: "reported",
      momPercent: "reported",
      yoyPercent: "reported",
      currentYearCumulativeRevenueTwd: "reported",
      previousYearCumulativeRevenueTwd: "reported",
      cumulativeYoyPercent: "reported",
    },
  };
}

function latestRevenue(companies: MasterCompany[]): MonthlyRevenueResult {
  return {
    query: { market: "all", dataMonth: "latest", universePolicy: "compatible" },
    dataMonth: "2026-07",
    currency: "TWD",
    amountUnit: "TWD",
    coverageComplete: true,
    sourceCoverage: {
      status: "verified",
      method: "current_master_exact_match",
      complete: true,
    },
    selectionComplete: true,
    missingCompanyCodes: [],
    filingCoverage: {
      expectedCompanyCount: companies.length,
      reportedCompanyCount: companies.length,
      missingCompanyCodes: [],
      coverageRatio: 1,
      complete: true,
      status: "complete",
    },
    reconciliation: [],
    counts: { listed: companies.length, otc: 0, returned: companies.length },
    rows: companies.map((item) => revenueRow(item.code)),
    sources: [],
    warnings: [],
  };
}

function latestValuation(companies: MasterCompany[]): DailyMarketValuationResult {
  return {
    query: { market: "all", date: "latest", universePolicy: "compatible" },
    dataDate: "2026-07-31",
    currency: "TWD",
    classificationPolicy: "current_master_strict",
    coverageComplete: true,
    universeCoverageVerified: true,
    selectionComplete: true,
    missingCompanyCodes: [],
    reconciliation: [],
    counts: {
      raw: companies.length,
      returned: companies.length,
      withPe: companies.length,
      withPb: companies.length,
      withDividendYield: companies.length,
      withClosePrice: companies.length,
      withDividendPerShare: 0,
      withDividendFiscalYear: 0,
      withReferenceFiscalPeriod: 0,
    },
    rows: companies.map((item) => valuation(item.code)),
    sources: [],
    warnings: [],
  };
}

function trendResult(codes: string[]): MonthlyRevenueTrendResult {
  return {
    query: {
      market: "all",
      companyCodes: codes,
      endMonth: "latest",
      lookbackMonths: 6,
      universePolicy: "compatible",
    },
    startMonth: "2026-02",
    endMonth: "2026-07",
    currency: "TWD",
    amountUnit: "TWD",
    coverageComplete: true,
    sourceCoverage: {
      status: "verified",
      method: "current_master_exact_match",
      complete: true,
    },
    selectionComplete: true,
    missingCompanyCodes: [],
    counts: { requestedCompanies: codes.length, returnedCompanies: codes.length, requestedMonths: 6 },
    companies: codes.map((code) => trend(code)),
    sources: [],
    warnings: [],
  };
}

function metricsResult(
  codes: string[],
  options: {
    identityUnavailableCompanyCode?: string;
    metricUnavailableCompanyCode?: string;
  } = {},
): CompanyMetricsBatchResult {
  const identityUnavailableCodes = options.identityUnavailableCompanyCode
    ? [options.identityUnavailableCompanyCode]
    : [];
  const metricUnavailableCodes = options.metricUnavailableCompanyCode
    ? [options.metricUnavailableCompanyCode]
    : [];
  const resolvedCodes = codes.filter(
    (code) => code !== options.identityUnavailableCompanyCode,
  );
  const unavailableCodes = codes.filter(
    (code) =>
      identityUnavailableCodes.includes(code) || metricUnavailableCodes.includes(code),
  );
  const metricFailure = {
    code: "UPSTREAM_BAD_RESPONSE" as const,
    reason: "COMPANY_SERIES_IDENTITY_AMBIGUOUS",
    message: `metric unavailable for ${options.metricUnavailableCompanyCode ?? "unknown"}`,
    retryable: false,
    retryAfterMs: null,
    action: "none" as const,
  };
  return {
    query: {
      companyCodes: codes,
      metricCodes: [
        "ROE",
        "NetIncome",
        "OperatingCashFlow",
        "DebtRatio",
        "GrossMargin",
        "OperatingMargin",
        "EPS",
      ],
      basis: "quarterly",
      history: "recent_12",
    },
    retrievedAt: "2026-08-01T00:00:00.000Z",
    snapshotId: "metrics-snapshot",
    metricDefinitions: [],
    companies: resolvedCodes.map((code) => {
      const company = metrics(code);
      if (code !== options.metricUnavailableCompanyCode) return company;
      return {
        ...company,
        evaluationStatus: "partial" as const,
        metrics: company.metrics.map((metric) =>
          metric.metricCode === "ROE"
            ? {
                ...metric,
                availability: "unavailable" as const,
                periods: [],
                points: [],
                coverage: {
                  seriesReturned: false,
                  nonNullPoints: 0,
                  missingPoints: 0,
                  invalidPoints: 0,
                  firstReportedPeriod: null,
                  latestReportedPeriod: null,
                  missingPeriods: [],
                },
                failure: metricFailure,
              }
            : metric,
        ),
      };
    }),
    failures: [
      ...(options.identityUnavailableCompanyCode
        ? [{
          companyCode: options.identityUnavailableCompanyCode,
          stage: "identity",
          metricCode: null,
          attribution: "company",
          code: "UPSTREAM_TIMEOUT",
          reason: null,
          message: `metrics unavailable for ${options.identityUnavailableCompanyCode}`,
          retryable: true,
          retryAfterMs: null,
          action: "retry",
        } as const]
        : []),
      ...(options.metricUnavailableCompanyCode
        ? [{
            companyCode: options.metricUnavailableCompanyCode,
            stage: "metric",
            metricCode: "ROE",
            attribution: "company",
            ...metricFailure,
          } as const]
        : []),
    ],
    coverage: {
      selectionComplete: unavailableCodes.length === 0,
      requestedCompanyCodes: codes,
      returnedCompanyCodes: codes.filter((code) => !unavailableCodes.includes(code)),
      missingCompanyCodes: unavailableCodes,
      noValidDataCompanyCodes: identityUnavailableCodes,
      unavailableCompanyCodes: unavailableCodes,
      sourceComplete: unavailableCodes.length === 0,
      failureIsolationComplete: true,
      identityFailedCompanyCodes: identityUnavailableCodes,
      metrics: [],
    },
    workBudget: {
      comparisonPlanUnits: 7,
      comparisonExecutedUnits: 7,
      isolationRetryUnits: 0,
      comparisonUnitLimit: 24,
      identityLookupUpperBound: codes.length,
      unitDefinition: "one_metric_by_up_to_ten_companies_request",
    },
    sources: [],
    warnings: [],
  };
}

function reactionResult(codes: string[]) {
  return {
    query: {
      companyCodes: codes,
      asOf: "latest" as const,
      horizons: [5, 20, 60] as Array<5 | 20 | 60>,
      pageSize: codes.length,
    },
    timezone: "Asia/Taipei" as const,
    currency: "TWD" as const,
    priceBasis: "raw_unadjusted" as const,
    benchmarkBasis: "price_index" as const,
    asOf: { requested: "latest" as const, resolvedByMarket: [{ market: "listed" as const, date: "2026-07-31" }] },
    coverage: {
      selectionComplete: true as const,
      benchmarkHistoryComplete: true as const,
      dataQualityComplete: true,
      missingCompanyCodes: [] as [],
    },
    pagination: {
      snapshotId: "reaction-snapshot",
      requestedCompanyCount: codes.length,
      requestedPageSize: codes.length,
      pageStartIndex: 0,
      returnedCompanyCount: codes.length,
      nextCompanyIndex: codes.length,
      hasMore: false,
      nextCursor: null,
    },
    workBudget: {
      limit: 48 as const,
      consumed: codes.length * 2,
      benchmarkUnits: 1,
      stockUnits: codes.length,
      unitDefinition: "one_official_market_month_request" as const,
    },
    companies: [...codes].reverse().map((code) => reaction(code)),
    benchmarkSources: [],
    stockSources: [],
    warnings: [],
  };
}

function screenClientFixture(
  options: {
    metricsFailure?: Error;
    metricsPartialCompanyCode?: string;
    metricsPartialMetricCompanyCode?: string;
  } = {},
) {
  const companies = Array.from({ length: 12 }, (_, index) =>
    company(String(1001 + index)),
  );
  const getMonthlyRevenueTrend = vi.fn(async (query: { companyCodes: string[] }) =>
    trendResult(query.companyCodes),
  );
  const getCompanyMetricsBatch = options.metricsFailure
    ? vi.fn().mockRejectedValue(options.metricsFailure)
    : vi.fn(async (query: { companyCodes: string[] }) =>
        metricsResult(query.companyCodes, {
          identityUnavailableCompanyCode: options.metricsPartialCompanyCode,
          metricUnavailableCompanyCode: options.metricsPartialMetricCompanyCode,
        }),
      );
  const getStockReactionSignals = vi.fn(async (query: { companyCodes: string[] }) =>
    reactionResult(query.companyCodes),
  );
  const client = new TaiwanStockScreenClient(
    {
      companyMaster: { listCompanies: vi.fn(async () => masterResult(companies)) },
      revenue: {
        getMonthlyRevenue: vi.fn(async () => latestRevenue(companies)),
        getMonthlyRevenueTrend,
      },
      valuation: { getDailyMarketValuation: vi.fn(async () => latestValuation(companies)) },
      metrics: { getCompanyMetricsBatch },
      reaction: { getStockReactionSignals },
    },
    () => new Date("2026-08-01T00:00:00.000Z"),
  );
  return {
    client,
    getMonthlyRevenueTrend,
    getCompanyMetricsBatch,
    getStockReactionSignals,
  };
}

const SCREEN_QUERY = {
  market: "all" as const,
  includeKy: true,
  candidateLimit: 2,
  preset: TAIWAN_STOCK_SCREEN_PRESET,
};

describe("TaiwanStockScreenClient", () => {
  it("bounds the two-stage funnel and preserves stable ranking when dependencies return reversed rows", async () => {
    const fixture = screenClientFixture();
    const result = await fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY);

    expect(result.funnel).toMatchObject({
      currentMaster: 12,
      coarseEligible: 12,
      deepSelected: 10,
      deepScored: 10,
      reactionSelected: 2,
      reactionScored: 2,
      returned: 2,
    });
    expect(result.notDeepScored.map((item) => item.companyCode)).toEqual(["1011", "1012"]);
    expect(result.notReactionScored).toHaveLength(8);
    expect(result.candidates.map((item) => item.companyCode)).toEqual(["1001", "1002"]);
    expect(fixture.getMonthlyRevenueTrend).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: Array.from({ length: 10 }, (_, index) => String(1001 + index)) }),
    );
    expect(fixture.getCompanyMetricsBatch).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: Array.from({ length: 10 }, (_, index) => String(1001 + index)) }),
    );
    expect(fixture.getStockReactionSignals).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: ["1001", "1002"] }),
    );
  });

  it("retains the coarse funnel but never ranks companies after a deep dependency failure", async () => {
    const fixture = screenClientFixture({ metricsFailure: new Error("metrics unavailable") });
    const result = await fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY);

    expect(result.funnel).toMatchObject({
      coarseEligible: 12,
      deepSelected: 10,
      reactionSelected: 0,
      reactionScored: 0,
      returned: 0,
    });
    expect(result.candidates).toEqual([]);
    expect(result.notReactionScored).toHaveLength(10);
    expect(result.dependencyStatus).toContainEqual(
      expect.objectContaining({
        dependency: "company_metrics_batch",
        status: "failed",
      }),
    );
    expect(fixture.getStockReactionSignals).not.toHaveBeenCalled();
    expect(result.warnings.join(" ")).toContain("沒有被當成已完成評估或自動遞補排名");
  });

  it("isolates a fulfilled partial metrics batch to the affected company", async () => {
    const fixture = screenClientFixture({ metricsPartialCompanyCode: "1001" });
    const result = await fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY);

    expect(result.funnel).toMatchObject({
      coarseEligible: 12,
      deepSelected: 10,
      deepScored: 9,
      reactionSelected: 2,
      reactionScored: 2,
      returned: 2,
    });
    expect(fixture.getStockReactionSignals).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: ["1002", "1003"] }),
    );
    expect(result.candidates.map((item) => item.companyCode)).toEqual(["1002", "1003"]);
    expect(result.candidates.some((item) => item.companyCode === "1001")).toBe(false);
    expect(result.dependencyStatus).toContainEqual(
      expect.objectContaining({
        dependency: "company_metrics_batch",
        status: "partial",
        affectedCompanyCodes: ["1001"],
      }),
    );
    expect(result.notReactionScored).toContainEqual(
      expect.objectContaining({
        companyCode: "1001",
        reasonCodes: expect.arrayContaining([
          "company_metrics_unavailable",
          "company_quality_unknown",
          "fundamental_improvement_unknown",
        ]),
      }),
    );
    expect(result.coverage).toMatchObject({
      deepEvidenceComplete: false,
      reactionEvidenceComplete: true,
    });
  });

  it("isolates an unavailable metric while retaining the affected company row", async () => {
    const fixture = screenClientFixture({ metricsPartialMetricCompanyCode: "1001" });
    const result = await fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY);

    expect(result.funnel).toMatchObject({
      deepSelected: 10,
      deepScored: 9,
      reactionSelected: 2,
      reactionScored: 2,
      returned: 2,
    });
    expect(fixture.getStockReactionSignals).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: ["1002", "1003"] }),
    );
    expect(result.candidates.map((item) => item.companyCode)).toEqual(["1002", "1003"]);
    expect(result.dependencyStatus).toContainEqual(
      expect.objectContaining({
        dependency: "company_metrics_batch",
        status: "partial",
        affectedCompanyCodes: ["1001"],
      }),
    );
    expect(result.notReactionScored).toContainEqual(
      expect.objectContaining({
        companyCode: "1001",
        reasonCodes: expect.arrayContaining([
          "company_metrics_unavailable",
          "company_quality_unknown",
          "fundamental_improvement_unknown",
        ]),
      }),
    );
    expect(result.coverage.deepEvidenceComplete).toBe(false);
  });
});
