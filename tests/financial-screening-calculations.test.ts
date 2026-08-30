import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildFinancialCompanyQualityPillar,
  buildFinancialFundamentalImprovementPillar,
  buildFinancialReasonableValuationPillar,
  expectedCapitalPeriod,
  financialAnnualRoeEvidence,
  financialCoarseScore,
  financialProfitabilityThroughPeriod,
  financialValuationPeerContext,
} from "@/lib/financial-screening/calculations";
import {
  CORE_INSTITUTION_METRIC_ROLES,
  FINANCIAL_SCREEN_DEFINITION,
  FINANCIAL_SCREEN_THRESHOLDS,
} from "@/lib/financial-screening/definition";
import type {
  FinancialInstitutionBatchCompany,
  FinancialInstitutionBatchMetric,
} from "@/lib/financial-screening/institution-batch";
import {
  resolveFinancialScreenMetricRoles,
  resolvedFinancialMetric,
  type FinancialScreenMetricRole,
} from "@/lib/financial-screening/metric-roles";
import { parseCatalogHtml } from "@/lib/mopsfin/catalog";
import type {
  CompanyMetricsBatchCompany,
  CompanyMetricsBatchMetric,
} from "@/lib/mopsfin/batch";
import type { MonthlyRevenueTrendCompany } from "@/lib/revenue/types";
import type { ValuationRow } from "@/lib/valuation/types";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);
const resolution = resolveFinancialScreenMetricRoles(parseCatalogHtml(catalogHtml));
const PERIODS = [
  "2025Q2",
  "2025Q3",
  "2025Q4",
  "2026Q1",
  "2026Q2",
] as const;

function companyMetric(
  role: "roe" | "net_profit" | "eps",
  values: number[],
): CompanyMetricsBatchMetric {
  const definition = resolvedFinancialMetric(resolution, role);
  const points = PERIODS.map((period, index) => ({
    period,
    value: values[index] as number,
    valueStatus: "reported" as const,
  }));
  return {
    metricCode: definition.metricCode,
    metricName: definition.metricName,
    unit: definition.unit,
    availability: "available",
    periods: [...PERIODS],
    points,
    coverage: {
      seriesReturned: true,
      nonNullPoints: points.length,
      missingPoints: 0,
      invalidPoints: 0,
      firstReportedPeriod: PERIODS[0],
      latestReportedPeriod: PERIODS.at(-1) as string,
      missingPeriods: [],
    },
    failure: null,
  };
}

function profitability(
  overrides: Partial<Record<"roe" | "net_profit" | "eps", number[]>> = {},
): CompanyMetricsBatchCompany {
  return {
    companyCode: "2801",
    companyName: "彰銀",
    displayName: "2801 彰銀",
    evaluationStatus: "complete",
    metrics: [
      companyMetric("roe", overrides.roe ?? [7, 8, 10, 9, 11]),
      companyMetric(
        "net_profit",
        overrides.net_profit ?? [80, 90, 100, 110, 120],
      ),
      companyMetric("eps", overrides.eps ?? [1, 1.1, 1.2, 1.3, 1.5]),
    ],
  };
}

function institutionMetric(
  role: FinancialScreenMetricRole,
  values: [number, number],
  averages: [number, number],
): FinancialInstitutionBatchMetric {
  const definition = resolvedFinancialMetric(resolution, role);
  const periods = ["2025Q2", "2026Q2"];
  const points = periods.map((period, index) => ({
    period,
    value: values[index],
    valueStatus: "reported" as const,
  }));
  return {
    role,
    metricCode: definition.metricCode,
    metricName: definition.metricName,
    family: definition.family as "fin" | "adequacy",
    unit: definition.unit,
    availability: "available",
    periods,
    points,
    industryAveragePoints: periods.map((period, index) => ({
      period,
      value: averages[index],
      valueStatus: "reported" as const,
    })),
    coverage: {
      seriesReturned: true,
      nonNullPoints: 2,
      missingPoints: 0,
      invalidPoints: 0,
      firstReportedPeriod: periods[0],
      latestReportedPeriod: periods[1],
      missingPeriods: [],
      industryAverageSeriesReturned: true,
    },
    failure: null,
  };
}

function bankInstitution(
  overrides: Partial<Record<
    | "bank_capital_adequacy_ratio"
    | "loan_overdue_ratio"
    | "loan_loss_reserve_coverage_ratio",
    FinancialInstitutionBatchMetric
  >> = {},
): FinancialInstitutionBatchCompany {
  return {
    companyCode: "2801",
    institutionCode: "2801",
    institutionName: "彰銀",
    sector: "bank",
    evaluationStatus: "complete",
    metrics: [
      overrides.bank_capital_adequacy_ratio ?? institutionMetric(
        "bank_capital_adequacy_ratio",
        [14, 15],
        [14, 14.5],
      ),
      overrides.loan_overdue_ratio ?? institutionMetric(
        "loan_overdue_ratio",
        [1.2, 1],
        [1.1, 1.1],
      ),
      overrides.loan_loss_reserve_coverage_ratio ?? institutionMetric(
        "loan_loss_reserve_coverage_ratio",
        [120, 130],
        [121, 125],
      ),
    ],
  };
}

function revenueTrend(latestYoy = 12): MonthlyRevenueTrendCompany {
  const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  const yoys = [2, 4, 6, 8, 10, latestYoy];
  return {
    code: "2801",
    name: "彰銀",
    market: "listed",
    industryCode: "17",
    sourceIndustryName: "金融保險業",
    observedNames: ["彰銀"],
    observedMarkets: ["listed"],
    comparability: { status: "comparable", reasons: [], transitions: [] },
    missingMonths: [],
    points: months.map((dataMonth, index) => ({
      dataMonth,
      name: "彰銀",
      market: "listed",
      sourceReportDate: `${dataMonth}-10`,
      sourceIndustryName: "金融保險業",
      currentMonthRevenueTwd: 100 + index,
      sameMonthLastYearRevenueTwd: 90,
      momPercent: 1,
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

function valuation(
  code: string,
  priceToBookRatio: number | null = 2,
  peRatio: number | null = 15,
  dividendYieldPercent: number | null = 3,
): ValuationRow {
  const status = (value: number | null) =>
    value === null ? "missing_or_not_meaningful" as const : "reported" as const;
  return {
    code,
    name: code,
    market: "listed",
    peRatio,
    priceToBookRatio,
    dividendYieldPercent,
    closePriceTwd: 50,
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
      closePriceTwd: "50",
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: null,
    },
  };
}

describe("balanced_financial_v1 definition", () => {
  it("centralizes subtype applicability and non-comparable model policy", () => {
    expect(FINANCIAL_SCREEN_DEFINITION).toMatchObject({
      id: "taiwan_financial_screen.v1",
      preset: "balanced_financial_v1",
      supportedSectors: ["holding", "bank", "bills"],
      crossModelScoreComparable: false,
    });
    expect(CORE_INSTITUTION_METRIC_ROLES.bank).toEqual([
      "bank_capital_adequacy_ratio",
      "loan_overdue_ratio",
      "loan_loss_reserve_coverage_ratio",
    ]);
    expect(FINANCIAL_SCREEN_THRESHOLDS).toMatchObject({
      qualityScoreMinimum: 70,
      improvementScoreMinimum: 60,
      valuationPeerMinimum: 3,
    });
  });

  it.each([
    ["2026Q1", "2025Q4"],
    ["2026Q2", "2026Q2"],
    ["2026Q3", "2026Q2"],
    ["2026Q4", "2026Q4"],
  ])("routes profitability %s to expected capital period %s", (through, expected) => {
    expect(expectedCapitalPeriod(through)).toBe(expected);
  });
});

describe("financial quality and improvement pillars", () => {
  it("passes a bank only when profitability, CAR and asset quality evidence meet the gates", () => {
    const metrics = profitability();
    const through = financialProfitabilityThroughPeriod(metrics, resolution);
    expect(through).toBe("2026Q2");

    const quality = buildFinancialCompanyQualityPillar({
      sector: "bank",
      profitability: metrics,
      institution: bankInstitution(),
      profitabilityThroughPeriod: through,
      resolution,
    });
    const improvement = buildFinancialFundamentalImprovementPillar({
      sector: "bank",
      profitability: metrics,
      institution: bankInstitution(),
      revenueTrend: revenueTrend(),
      profitabilityThroughPeriod: through,
      resolution,
    });

    expect(quality).toMatchObject({ status: "pass", score: 100, knownWeight: 100 });
    expect(improvement).toMatchObject({ status: "pass", score: 100, knownWeight: 100 });
    expect(
      improvement.criteria.find((item) => item.code === "capital_adequacy_yoy"),
    ).toMatchObject({ periods: ["2025Q2", "2026Q2"], value: 1 });
    expect(
      improvement.criteria.find((item) => item.code === "loan_overdue_ratio_yoy"),
    ).toMatchObject({ status: "pass", value: -0.2 });
  });

  it("keeps missing industry comparison evidence unknown and non-positive profit as a hard fail", () => {
    const missingAverage = institutionMetric(
      "bank_capital_adequacy_ratio",
      [14, 15],
      [14, 14.5],
    );
    missingAverage.industryAveragePoints = [];
    const unknown = buildFinancialCompanyQualityPillar({
      sector: "bank",
      profitability: profitability(),
      institution: bankInstitution({
        bank_capital_adequacy_ratio: missingAverage,
      }),
      profitabilityThroughPeriod: "2026Q2",
      resolution,
    });
    expect(unknown.status).toBe("unknown");
    expect(unknown.evidenceGaps).toContain("bank_capital_adequacy_vs_industry");

    const hardFail = buildFinancialCompanyQualityPillar({
      sector: "bank",
      profitability: profitability({ net_profit: [-10, -10, -10, -10, -10] }),
      institution: bankInstitution(),
      profitabilityThroughPeriod: "2026Q2",
      resolution,
    });
    expect(hardFail.status).toBe("fail");
    expect(hardFail.hardFailReasons).toContain("non_positive_ttm_net_income");
  });

  it("treats failed revenue breadth as a hard fail even when another trend is unknown", () => {
    const car = institutionMetric(
      "bank_capital_adequacy_ratio",
      [14, 15],
      [14, 14.5],
    );
    car.points = car.points.slice(1);
    const pillar = buildFinancialFundamentalImprovementPillar({
      sector: "bank",
      profitability: profitability(),
      institution: bankInstitution({ bank_capital_adequacy_ratio: car }),
      revenueTrend: revenueTrend(-3),
      profitabilityThroughPeriod: "2026Q2",
      resolution,
    });
    expect(pillar.status).toBe("fail");
    expect(pillar.hardFailReasons).toEqual(["revenue_improvement_breadth_failed"]);
  });
});

describe("financial valuation", () => {
  it("uses only same-subtype peers and requires both PB primary conditions", () => {
    const subject = valuation("2801", 2, 15, 3);
    const peers = financialValuationPeerContext({
      subjectCode: "2801",
      sector: "bank",
      valuation: subject,
      peers: [
        { companyCode: "2801", sector: "bank", peRatio: 15, priceToBookRatio: 2, dividendYieldPercent: 3 },
        { companyCode: "2812", sector: "bank", peRatio: 20, priceToBookRatio: 3, dividendYieldPercent: 2 },
        { companyCode: "2834", sector: "bank", peRatio: 10, priceToBookRatio: 1, dividendYieldPercent: 4 },
        { companyCode: "2881", sector: "holding", peRatio: 5, priceToBookRatio: 0.5, dividendYieldPercent: 8 },
      ],
    });
    const annualRoe = financialAnnualRoeEvidence(
      profitability(),
      "2026Q2",
      resolution,
    );
    const pillar = buildFinancialReasonableValuationPillar({
      valuation: subject,
      annualRoeEvidence: annualRoe,
      peers,
      valuationDate: "2026-08-28",
    });

    expect(peers).toMatchObject({
      scope: "same_financial_subtype",
      pbPeerCount: 3,
      pbPercentile: 50,
    });
    expect(pillar.status).toBe("pass");
  });

  it("does not fall back to another subtype when fewer than three peers exist", () => {
    const subject = valuation("2872", 1.5, 12, 3);
    const peers = financialValuationPeerContext({
      subjectCode: "2872",
      sector: "bills",
      valuation: subject,
      peers: [
        { companyCode: "2872", sector: "bills", peRatio: 12, priceToBookRatio: 1.5, dividendYieldPercent: 3 },
        { companyCode: "2873", sector: "bills", peRatio: 13, priceToBookRatio: 1.6, dividendYieldPercent: 3 },
        { companyCode: "2881", sector: "holding", peRatio: 5, priceToBookRatio: 0.5, dividendYieldPercent: 8 },
      ],
    });
    const pillar = buildFinancialReasonableValuationPillar({
      valuation: subject,
      annualRoeEvidence: { period: "2025Q4", value: 10 },
      peers,
      valuationDate: "2026-08-28",
    });

    expect(peers.scope).toBe("unavailable");
    expect(peers.pbPeerCount).toBe(2);
    expect(pillar.status).toBe("unknown");
  });
});

describe("financial coarse ranking", () => {
  it("makes PB primary while keeping the score deterministic", () => {
    expect(financialCoarseScore(5, 3, valuation("2801", 2, 20, 3))).toBe(100);
    expect(financialCoarseScore(5, 3, valuation("2801", null, 20, 3))).toBe(75);
  });
});
