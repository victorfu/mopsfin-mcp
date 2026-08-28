import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import type {
  CompanyMetricsBatchCompany,
  CompanyMetricsBatchResult,
} from "@/lib/mopsfin/batch";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { Catalog } from "@/lib/mopsfin/types";
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
import { resolveScreenMetricRoles } from "@/lib/screening/metric-roles";
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

const SCREEN_CATALOG: Catalog = {
  metrics: [
    ["ROE", "權益報酬率", "%"],
    ["NetProfit", "稅後純益", "新台幣仟元"],
    ["OperatingCashflow", "營業活動現金流量", "新台幣仟元"],
    ["DebtRatio", "負債佔資產比率", "%"],
    ["GrossMargin", "毛利率", "%"],
    ["OperatingMargin", "營業利益率", "%"],
    ["EPS", "每股盈餘", "元"],
  ].map(([code, name, unit]) => ({
    code: code as string,
    name: name as string,
    unit: unit as string,
    category: "一般公司指標",
    family: "data" as const,
  })),
  industries: [{ code: "24", name: "半導體業" }],
  financialInstitutions: [],
  years: [2025, 2026],
  quarters: [1, 2, 3, 4],
  discoveredAt: "2026-08-28T00:00:00.000Z",
};

const SCREEN_METRIC_RESOLUTION = resolveScreenMetricRoles(SCREEN_CATALOG);

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
    NetProfit: [8, 10, 10, 10, 10],
    OperatingCashflow: [8, 9, 9, 9, 9],
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
      const definition = SCREEN_METRIC_RESOLUTION.resolvedFinancialMetrics.find(
        (metric) => metric.metricCode === metricCode,
      );
      if (!definition) {
        throw new Error(`Missing screen metric fixture definition for ${metricCode}`);
      }
      const values = overrides[metricCode] ?? defaultValues;
      const points = PERIODS.map((period, index) => ({
        period,
        value: values[index] ?? null,
        valueStatus: values[index] === null ? "missing" as const : "reported" as const,
      }));
      const reported = points.filter((point) => point.valueStatus === "reported");
      return {
        metricCode,
        metricName: definition.metricName,
        unit: definition.unit,
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
  options: {
    excess20?: number;
    turnover?: number;
    rawStockReturn20?: number;
    adjustedStockReturn20?: number;
    comparabilityStatus?: CompanyReactionSignals["comparability"]["status"];
    corporateActionCoverageComplete?: boolean;
    stockDataUnavailable?: boolean;
  } = {},
): CompanyReactionSignals {
  const excess20 = options.excess20 ?? 2;
  const comparabilityStatus = options.comparabilityStatus ??
    (options.stockDataUnavailable ? "unavailable" : "price_index_compatible");
  const corporateActionCoverageComplete =
    options.corporateActionCoverageComplete ?? true;
  const average = (windowSessions: 5 | 20 | 60, value: number) => ({
    windowSessions,
    startDate: "2026-05-01",
    endDate: "2026-07-31",
    expectedObservationCount: windowSessions,
    observationCount: options.stockDataUnavailable ? 0 : windowSessions,
    value: options.stockDataUnavailable ? null : value,
    status: options.stockDataUnavailable
      ? "stock_data_unavailable" as const
      : "available" as const,
  });
  return {
    companyCode: code,
    companyName: `C${code}`,
    market: "listed",
    benchmarkCode: "TAIEX",
    requestedAsOf: "latest",
    resolvedAsOf: "2026-07-31",
    stockDataStatus: options.stockDataUnavailable ? "unavailable" : "available",
    stockDataFailure: options.stockDataUnavailable
      ? {
          code: "UPSTREAM_TIMEOUT",
          reason: "UPSTREAM_REQUEST_TIMEOUT",
          message: `OHLC unavailable for ${code}`,
          retryable: true,
          retryAfterMs: null,
          action: "retry",
        }
      : null,
    returns: ([5, 20, 60] as const).map((horizonSessions) => ({
      horizonSessions,
      startDate: "2026-05-01",
      endDate: "2026-07-31",
      stockReturnPercent: options.stockDataUnavailable
        ? null
        : horizonSessions === 20
          ? options.rawStockReturn20 ?? excess20 + 1
          : 2,
      priceIndexCompatibleStockReturnPercent: options.stockDataUnavailable
        ? null
        : horizonSessions === 20
          ? options.adjustedStockReturn20 ?? excess20 + 1
          : 2,
      corporateActionAdjustmentFactor:
        corporateActionCoverageComplete && !options.stockDataUnavailable ? 1 : null,
      benchmarkReturnPercent: 1,
      excessReturnPercentagePoints:
        comparabilityStatus === "price_index_compatible" &&
        !options.stockDataUnavailable
          ? horizonSessions === 20
            ? excess20
            : 1
          : null,
      status: options.stockDataUnavailable
        ? "stock_data_unavailable" as const
        : corporateActionCoverageComplete
          ? "available" as const
          : "not_comparable_corporate_action" as const,
      excessReturnStatus: options.stockDataUnavailable
        ? "stock_data_unavailable" as const
        : comparabilityStatus === "price_index_compatible"
          ? "available" as const
          : "not_comparable" as const,
      excessReturnReasons: comparabilityStatus === "price_index_compatible"
        ? []
        : options.stockDataUnavailable
          ? []
          : ["corporate_action_coverage_incomplete" as const],
    })),
    liquidity: {
      averageVolume5SessionsShares: average(5, 100_000),
      averageVolume20SessionsShares: average(20, 100_000),
      volume5To20Ratio: {
        numeratorWindowSessions: 5,
        denominatorWindowSessions: 20,
        value: options.stockDataUnavailable ? null : 1,
        status: options.stockDataUnavailable
          ? "stock_data_unavailable"
          : "available",
      },
      averageTurnover20SessionsTwd: average(20, options.turnover ?? 10_000_000),
      averageTurnover60SessionsTwd: average(60, 10_000_000),
      turnover20To60Ratio: {
        numeratorWindowSessions: 20,
        denominatorWindowSessions: 60,
        value: options.stockDataUnavailable ? null : 1,
        status: options.stockDataUnavailable
          ? "stock_data_unavailable"
          : "available",
      },
    },
    pricePath: {
      horizonSessions: 60,
      startDate: "2026-05-01",
      endDate: "2026-07-31",
      expectedObservationCount: 60,
      observationCount: options.stockDataUnavailable ? 0 : 60,
      maximumDrawdownPercent: options.stockDataUnavailable ? null : -10,
      distanceBelowWindowHighPercent: options.stockDataUnavailable ? null : 10,
      priceBasis: "price_index_compatible_corporate_action_adjusted",
      status: options.stockDataUnavailable
        ? "stock_data_unavailable"
        : corporateActionCoverageComplete
          ? "available"
          : "not_comparable_corporate_action",
    },
    comparability: {
      status: comparabilityStatus,
      rawPriceBasis: "raw_unadjusted",
      returnBasis: "price_index_compatible_corporate_action_adjusted",
      corporateActionAdjustment: corporateActionCoverageComplete
        ? "not_required"
        : "incomplete",
      corporateActionEvidence: corporateActionCoverageComplete
        ? "official_history_verified_no_event"
        : "official_history_incomplete",
      corporateActionCoverageComplete,
      marketTransitionDetected: false,
      observedMarkets: ["listed"],
      corporateActions: [],
      officialChangeMarkers: [],
      unmatchedOfficialChangeMarkers: [],
      reasons: comparabilityStatus === "price_index_compatible"
        ? []
        : options.stockDataUnavailable
          ? ["stock_data_unavailable"]
          : ["corporate_action_coverage_incomplete"],
    },
    dataQualityComplete: comparabilityStatus === "price_index_compatible",
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
    const passing = buildCompanyQualityPillar(
      metrics("1101"),
      "2026Q2",
      SCREEN_METRIC_RESOLUTION,
    );
    const failing = buildCompanyQualityPillar(
      metrics("1102", {
        ROE: [-1, -1, -1, -1, -1],
        NetProfit: [-5, -5, -5, -5, -5],
        OperatingCashflow: [-5, -5, -5, -5, -5],
        DebtRatio: [90, 90, 90, 90, 90],
      }),
      "2026Q2",
      SCREEN_METRIC_RESOLUTION,
    );
    const withMissingCashFlow = buildCompanyQualityPillar(
      metrics("1103", { OperatingCashflow: [8, 9, 9, 9, null] }),
      "2026Q2",
      SCREEN_METRIC_RESOLUTION,
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

    const result = buildCompanyQualityPillar(
      staleAnnual,
      "2026Q2",
      SCREEN_METRIC_RESOLUTION,
    );

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
      SCREEN_METRIC_RESOLUTION,
    );
    const failing = buildFundamentalImprovementPillar(
      metrics("1202"),
      trend("1202", -5),
      "2026Q2",
      SCREEN_METRIC_RESOLUTION,
    );
    const unknown = buildFundamentalImprovementPillar(
      metrics("1203", { EPS: [null, 1.2, 1.4, 1.5, 2] }),
      trend("1203"),
      "2026Q2",
      SCREEN_METRIC_RESOLUTION,
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

    const verifiedAdjusted = buildMarketUnderreactionPillar(
      reaction("1301", {
        rawStockReturn20: 51,
        adjustedStockReturn20: 3,
        excess20: 2,
      }),
    );
    expect(verifiedAdjusted.status).toBe("pass");
    expect(
      verifiedAdjusted.criteria.find((item) => item.code === "excess_return_20"),
    ).toMatchObject({
      value: 2,
      context: {
        rawStockReturnPercent: 51,
        priceIndexCompatibleStockReturnPercent: 3,
        benchmarkReturnPercent: 1,
      },
    });
    expect(buildMarketUnderreactionPillar(reaction("1302", { excess20: 20 })).status).toBe("fail");

    const incompleteCorporateActions = buildMarketUnderreactionPillar(
      reaction("1303", {
        excess20: 99,
        comparabilityStatus: "not_comparable",
        corporateActionCoverageComplete: false,
      }),
    );
    expect(incompleteCorporateActions).toMatchObject({
      status: "unknown",
      score: null,
      knownWeight: 0,
      hardFailReasons: [],
    });
    expect(incompleteCorporateActions.criteria).toHaveLength(7);
    expect(incompleteCorporateActions.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unknown",
          value: null,
          reasonCodes: ["price_index_compatible_reaction_unavailable"],
        }),
      ]),
    );
    expect(
      incompleteCorporateActions.criteria.every((item) => item.status === "unknown"),
    ).toBe(true);
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
        "NetProfit",
        "OperatingCashflow",
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
    metricDefinitions: SCREEN_METRIC_RESOLUTION.resolvedFinancialMetrics.map(
      ({ metricCode: code, metricName: name, unit, category }) => ({
        code,
        name,
        unit,
        category,
      }),
    ),
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

function reactionResult(
  codes: string[],
  options: {
    corporateActionIncompleteCompanyCode?: string;
    stockDataUnavailableCompanyCode?: string;
  } = {},
) {
  const corporateActionHistoryComplete =
    options.corporateActionIncompleteCompanyCode === undefined;
  const dataQualityComplete =
    corporateActionHistoryComplete &&
    options.stockDataUnavailableCompanyCode === undefined;
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
    returnBasis: "price_index_compatible_corporate_action_adjusted" as const,
    benchmarkBasis: "price_index" as const,
    asOf: { requested: "latest" as const, resolvedByMarket: [{ market: "listed" as const, date: "2026-07-31" }] },
    coverage: {
      selectionComplete: true as const,
      benchmarkHistoryComplete: true as const,
      corporateActionHistoryComplete,
      dataQualityComplete,
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
      corporateActionRequests: 3,
      corporateActionRequestDefinition:
        "one_official_range_or_detail_request" as const,
    },
    companies: [...codes].reverse().map((code) =>
      reaction(
        code,
        code === options.corporateActionIncompleteCompanyCode
          ? {
              comparabilityStatus: "not_comparable",
              corporateActionCoverageComplete: false,
            }
          : code === options.stockDataUnavailableCompanyCode
            ? { stockDataUnavailable: true }
          : {},
      ),
    ),
    benchmarkSources: [],
    stockSources: [],
    corporateActionSources: [{
      market: "listed" as const,
      exchange: "TWSE" as const,
      family: "ex_right_dividend" as const,
      scope: "range_summary" as const,
      sourceName: "TWSE 除權除息計算結果表",
      sourceUrl: "https://example.test/corporate-actions",
      retrievedAt: "2026-08-01T00:00:00.000Z",
      supportedFrom: "2003-05-05",
      queryStart: "2026-05-01",
      queryEnd: "2026-07-31",
      responseStart: null,
      responseEnd: null,
      rawRowCount: 0,
      companyEventCount: 0,
      officialDeclaredRowCount: 0,
      officialDeclaredRowCountAvailable: true,
    }],
    warnings: [],
  };
}

function screenClientFixture(
  options: {
    metricsFailure?: Error;
    metricsPartialCompanyCode?: string;
    metricsPartialMetricCompanyCode?: string;
    reactionCorporateActionIncompleteCompanyCode?: string;
    reactionStockDataUnavailableCompanyCode?: string;
    companyCount?: number;
    catalog?: Catalog;
    metricsDefinitionNameDrift?: boolean;
  } = {},
) {
  const companies = Array.from({ length: options.companyCount ?? 12 }, (_, index) =>
    company(String(1001 + index)),
  );
  const getMonthlyRevenueTrend = vi.fn(async (query: { companyCodes: string[] }) =>
    trendResult(query.companyCodes),
  );
  const getCompanyMetricsBatch = options.metricsFailure
    ? vi.fn().mockRejectedValue(options.metricsFailure)
    : vi.fn(async (query: { companyCodes: string[] }) => {
        const result = metricsResult(query.companyCodes, {
          identityUnavailableCompanyCode: options.metricsPartialCompanyCode,
          metricUnavailableCompanyCode: options.metricsPartialMetricCompanyCode,
        });
        if (options.metricsDefinitionNameDrift) {
          result.metricDefinitions = result.metricDefinitions.map((definition) =>
            definition.code === "NetProfit"
              ? { ...definition, name: "漂移後獲利名稱" }
              : definition,
          );
        }
        return result;
      });
  const getStockReactionSignals = vi.fn(async (query: { companyCodes: string[] }) =>
    reactionResult(query.companyCodes, {
      corporateActionIncompleteCompanyCode:
        options.reactionCorporateActionIncompleteCompanyCode,
      stockDataUnavailableCompanyCode:
        options.reactionStockDataUnavailableCompanyCode,
    }),
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
      catalog: { getCatalog: vi.fn(async () => options.catalog ?? SCREEN_CATALOG) },
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
    expect(result.query.preset).toBe("balanced_non_financial_v2");
    expect(result.screenDefinition).toMatchObject({
      id: "taiwan_stock_screen.v2",
      preset: "balanced_non_financial_v2",
      evidencePolicies: {
        reactionPriceBasis:
          "price_index_compatible_corporate_action_adjusted_vs_price_index",
        requiredFinancialMetricRoles: [
          "roe",
          "net_profit",
          "operating_cashflow",
          "debt_ratio",
          "gross_margin",
          "operating_margin",
          "eps",
        ],
        financialMetricCodes: [
          "ROE",
          "NetProfit",
          "OperatingCashflow",
          "DebtRatio",
          "GrossMargin",
          "OperatingMargin",
          "EPS",
        ],
        resolvedFinancialMetrics: expect.arrayContaining([
          expect.objectContaining({
            role: "net_profit",
            metricCode: "NetProfit",
            metricName: "稅後純益",
            family: "data",
          }),
        ]),
        catalogDiscoveredAt: "2026-08-28T00:00:00.000Z",
        catalogSnapshotId: expect.stringMatching(/^mopsfin-catalog-[a-f0-9]{64}$/),
      },
    });
    expect(result.workBudget.reactionCorporateActionRequests).toBe(3);
    expect(result.sources).toContainEqual(
      expect.objectContaining({
        kind: "reaction_corporate_action",
        sourceName: "TWSE 除權除息計算結果表",
      }),
    );
    expect(fixture.getMonthlyRevenueTrend).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: Array.from({ length: 10 }, (_, index) => String(1001 + index)) }),
    );
    expect(fixture.getCompanyMetricsBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        companyCodes: Array.from({ length: 10 }, (_, index) => String(1001 + index)),
        metricCodes: [
          "ROE",
          "NetProfit",
          "OperatingCashflow",
          "DebtRatio",
          "GrossMargin",
          "OperatingMargin",
          "EPS",
        ],
      }),
    );
    expect(fixture.getStockReactionSignals).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: ["1001", "1002"] }),
    );
  });

  it("fails closed before deep metrics when a required catalog role cannot resolve", async () => {
    const catalog: Catalog = {
      ...SCREEN_CATALOG,
      metrics: SCREEN_CATALOG.metrics.filter(
        (metric) => metric.code !== "NetProfit",
      ),
    };
    const fixture = screenClientFixture({ catalog });

    await expect(
      fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CATALOG_CONTRACT_MISMATCH",
    });
    expect(fixture.getCompanyMetricsBatch).not.toHaveBeenCalled();
  });

  it("fails closed when a fulfilled batch no longer matches its catalog resolution", async () => {
    const fixture = screenClientFixture({ metricsDefinitionNameDrift: true });

    await expect(
      fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CATALOG_CONTRACT_MISMATCH",
    });
  });

  it("converts a batch catalog race into the semantic contract error", async () => {
    const fixture = screenClientFixture({
      metricsFailure: new MopsfinError(
        "NOT_FOUND",
        "找不到 family=data 的 metric_code NetProfit；請先呼叫 list_catalog。",
        { reason: "CATALOG_METRIC_NOT_FOUND" },
      ),
    });

    await expect(
      fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CATALOG_CONTRACT_MISMATCH",
    });
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

  it("isolates incomplete corporate-action evidence without turning unknown into fail or blocking peers", async () => {
    const fixture = screenClientFixture({
      reactionCorporateActionIncompleteCompanyCode: "1001",
      companyCount: 21,
    });
    const result = await fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY);

    expect(result.funnel).toMatchObject({
      reactionSelected: 2,
      reactionScored: 2,
      returned: 2,
    });
    expect(result.dependencyStatus).toContainEqual(
      expect.objectContaining({
        dependency: "stock_reaction_signals",
        status: "partial",
        affectedCompanyCodes: ["1001"],
      }),
    );
    const incomplete = result.candidates.find(
      (item) => item.companyCode === "1001",
    );
    expect(incomplete).toMatchObject({
      bucket: "insufficient_data",
      overallScore: null,
      pillars: {
        marketUnderreactionProxy: {
          status: "unknown",
          score: null,
          knownWeight: 0,
          hardFailReasons: [],
        },
      },
    });
    expect(
      incomplete?.pillars.marketUnderreactionProxy.criteria.every(
        (item) =>
          item.status === "unknown" &&
          item.value === null &&
          item.reasonCodes.includes("price_index_compatible_reaction_unavailable"),
      ),
    ).toBe(true);
    expect(incomplete?.firstRejectionReasons).toEqual([]);

    const unaffected = result.candidates.find(
      (item) => item.companyCode === "1002",
    );
    expect(unaffected).toMatchObject({
      bucket: "research_candidate",
      pillars: { marketUnderreactionProxy: { status: "pass" } },
    });
    expect(result.candidates.map((item) => item.companyCode)).toEqual(["1002", "1001"]);
    expect(result.coverage).toMatchObject({
      reactionEvidenceComplete: false,
      sourceComplete: false,
    });
  });

  it("isolates an unavailable company OHLC dependency without blocking reaction peers", async () => {
    const fixture = screenClientFixture({
      reactionStockDataUnavailableCompanyCode: "1001",
      companyCount: 21,
    });
    const result = await fixture.client.screenTaiwanStockCandidates(SCREEN_QUERY);

    expect(result.dependencyStatus).toContainEqual(
      expect.objectContaining({
        dependency: "stock_reaction_signals",
        status: "partial",
        affectedCompanyCodes: ["1001"],
      }),
    );
    const unavailable = result.candidates.find(
      (item) => item.companyCode === "1001",
    );
    expect(unavailable).toMatchObject({
      bucket: "insufficient_data",
      overallScore: null,
      pillars: {
        marketUnderreactionProxy: {
          status: "unknown",
          score: null,
          knownWeight: 0,
          hardFailReasons: [],
        },
      },
    });
    expect(
      unavailable?.pillars.marketUnderreactionProxy.criteria.every(
        (item) =>
          item.status === "unknown" &&
          item.value === null &&
          item.reasonCodes.includes("price_index_compatible_reaction_unavailable"),
      ),
    ).toBe(true);
    expect(unavailable?.firstRejectionReasons).toEqual([]);

    expect(result.candidates.find((item) => item.companyCode === "1002")).toMatchObject({
      bucket: "research_candidate",
      pillars: { marketUnderreactionProxy: { status: "pass" } },
    });
    expect(result.candidates.map((item) => item.companyCode)).toEqual(["1002", "1001"]);
    expect(result.coverage).toMatchObject({
      reactionEvidenceComplete: false,
      sourceComplete: false,
    });
  });
});
