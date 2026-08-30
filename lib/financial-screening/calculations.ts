import type {
  CompanyMetricsBatchCompany,
  CompanyMetricsBatchMetric,
} from "@/lib/mopsfin/batch";
import type { MonthlyRevenueTrendCompany } from "@/lib/revenue/types";
import {
  buildMarketUnderreactionPillar,
  shiftQuarter,
} from "@/lib/screening/calculations";
import type {
  ScreenCriterion,
  ScreenPillar,
} from "@/lib/screening/types";
import type { ValuationRow } from "@/lib/valuation/types";

import {
  CORE_INSTITUTION_METRIC_ROLES,
  FINANCIAL_SCREEN_THRESHOLDS,
} from "./definition";
import type {
  FinancialInstitutionBatchCompany,
  FinancialInstitutionBatchMetric,
} from "./institution-batch";
import {
  resolvedFinancialMetric,
  type FinancialScreenMetricCatalogResolution,
  type FinancialScreenMetricRole,
} from "./metric-roles";
import type { SupportedFinancialSector } from "./types";

const EPSILON = 1e-9;

export interface FinancialScreenPillars {
  companyQuality: ScreenPillar;
  fundamentalImprovement: ScreenPillar;
  reasonableValuation: ScreenPillar;
  marketUnderreactionProxy: ReturnType<typeof buildMarketUnderreactionPillar>;
}

export interface FinancialValuationPeerObservation {
  companyCode: string;
  sector: SupportedFinancialSector;
  peRatio: number | null;
  priceToBookRatio: number | null;
  dividendYieldPercent: number | null;
}

export interface FinancialValuationPeerContext {
  scope: "same_financial_subtype" | "unavailable";
  sector: SupportedFinancialSector;
  minimumPeerCount: 3;
  pePeerCount: number;
  pbPeerCount: number;
  yieldPeerCount: number;
  pePercentile: number | null;
  pbPercentile: number | null;
  yieldPercentile: number | null;
}

interface CriterionInput {
  code: string;
  label: string;
  status: ScreenCriterion["status"];
  value: number | null;
  unit: string;
  periods: string[];
  rule: string;
  weight: number;
  mandatory?: boolean;
  context?: ScreenCriterion["context"];
  reasonCodes?: string[];
}

function round(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function criterion(input: CriterionInput): ScreenCriterion {
  return {
    ...input,
    mandatory: input.mandatory ?? true,
    context: input.context ?? {},
    reasonCodes: input.reasonCodes ?? [
      input.status === "pass"
        ? "criterion_pass"
        : input.status === "fail"
          ? "criterion_fail"
          : "evidence_unavailable",
    ],
  };
}

function scoreKnownCriteria(criteria: ScreenCriterion[]): number | null {
  const known = criteria.filter((item) => item.status !== "unknown");
  const knownWeight = known.reduce((sum, item) => sum + item.weight, 0);
  if (knownWeight === 0) return null;
  const passedWeight = known
    .filter((item) => item.status === "pass")
    .reduce((sum, item) => sum + item.weight, 0);
  return round((passedWeight / knownWeight) * 100, 1);
}

function finalizePillar(options: {
  key: ScreenPillar["key"];
  label: string;
  criteria: ScreenCriterion[];
  status: ScreenPillar["status"];
  hardFailReasons?: string[];
}): ScreenPillar {
  return {
    key: options.key,
    label: options.label,
    status: options.status,
    score: scoreKnownCriteria(options.criteria),
    knownWeight: options.criteria
      .filter((item) => item.status !== "unknown")
      .reduce((sum, item) => sum + item.weight, 0),
    totalWeight: 100,
    criteria: options.criteria,
    hardFailReasons: options.hardFailReasons ?? [],
    evidenceGaps: options.criteria
      .filter((item) => item.status === "unknown")
      .map((item) => item.code),
  };
}

function quarterIndex(period: string): number | null {
  const match = /^(\d{4})Q([1-4])$/.exec(period);
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

function exactTrailingPeriods(period: string, count: number): string[] | null {
  if (quarterIndex(period) === null) return null;
  const periods = Array.from({ length: count }, (_, index) =>
    shiftQuarter(period, index - count + 1)
  );
  return periods.every((candidate) => candidate !== null)
    ? periods as string[]
    : null;
}

function reportedValue(
  points: Array<{ period: string; value: number | null; valueStatus: string }>,
  period: string,
): number | null {
  const point = points.find((candidate) => candidate.period === period);
  return point?.valueStatus === "reported" && point.value !== null
    ? point.value
    : null;
}

function companyMetricByRole(
  company: CompanyMetricsBatchCompany | null,
  resolution: FinancialScreenMetricCatalogResolution,
  role: Extract<FinancialScreenMetricRole, "roe" | "net_profit" | "eps">,
): CompanyMetricsBatchMetric | null {
  if (!company) return null;
  const metricCode = resolvedFinancialMetric(resolution, role).metricCode;
  return company.metrics.find((metric) => metric.metricCode === metricCode) ?? null;
}

function institutionMetricByRole(
  company: FinancialInstitutionBatchCompany | null,
  role: FinancialScreenMetricRole,
): FinancialInstitutionBatchMetric | null {
  return company?.metrics.find((metric) => metric.role === role) ?? null;
}

export function financialProfitabilityThroughPeriod(
  company: CompanyMetricsBatchCompany | null,
  resolution: FinancialScreenMetricCatalogResolution,
): string | null {
  const metrics = (["roe", "net_profit", "eps"] as const).map((role) =>
    companyMetricByRole(company, resolution, role)
  );
  if (metrics.some((metric) => metric === null)) return null;
  const reportedSets = (metrics as CompanyMetricsBatchMetric[]).map(
    (metric) => new Set(
      metric.points
        .filter((point) =>
          point.valueStatus === "reported" && quarterIndex(point.period) !== null
        )
        .map((point) => point.period),
    ),
  );
  return [...reportedSets[0]]
    .filter((period) => reportedSets.slice(1).every((set) => set.has(period)))
    .sort((left, right) => (quarterIndex(left) as number) - (quarterIndex(right) as number))
    .at(-1) ?? null;
}

function expectedAnnualPeriod(throughPeriod: string): string | null {
  const match = /^(\d{4})Q([1-4])$/.exec(throughPeriod);
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  return `${quarter === 4 ? year : year - 1}Q4`;
}

export function expectedCapitalPeriod(throughPeriod: string): string | null {
  const match = /^(\d{4})Q([1-4])$/.exec(throughPeriod);
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  if (quarter === 1) return `${year - 1}Q4`;
  if (quarter === 2 || quarter === 3) return `${year}Q2`;
  return `${year}Q4`;
}

function annualRoe(
  company: CompanyMetricsBatchCompany | null,
  throughPeriod: string | null,
  resolution: FinancialScreenMetricCatalogResolution,
): { period: string; value: number } | null {
  if (!throughPeriod) return null;
  const period = expectedAnnualPeriod(throughPeriod);
  const metric = companyMetricByRole(company, resolution, "roe");
  if (!period || !metric) return null;
  const value = reportedValue(metric.points, period);
  return value === null ? null : { period, value };
}

function ttmNetProfit(
  company: CompanyMetricsBatchCompany | null,
  throughPeriod: string | null,
  resolution: FinancialScreenMetricCatalogResolution,
): { periods: string[]; value: number; positiveQuarters: number } | null {
  if (!throughPeriod) return null;
  const periods = exactTrailingPeriods(throughPeriod, 4);
  const metric = companyMetricByRole(company, resolution, "net_profit");
  if (!periods || !metric) return null;
  const values = periods.map((period) => reportedValue(metric.points, period));
  if (values.some((value) => value === null)) return null;
  const numbers = values as number[];
  return {
    periods,
    value: numbers.reduce((sum, value) => sum + value, 0),
    positiveQuarters: numbers.filter((value) => value > 0).length,
  };
}

function specialMetricComparison(
  metric: FinancialInstitutionBatchMetric | null,
  period: string | null,
  validity: "positive" | "non_negative",
): { period: string; value: number; industryAverage: number } | null {
  if (!metric || metric.availability !== "available" || !period) return null;
  const value = reportedValue(metric.points, period);
  const industryAverage = reportedValue(metric.industryAveragePoints, period);
  const valid = (candidate: number | null) =>
    candidate !== null && Number.isFinite(candidate) &&
    (validity === "positive" ? candidate > 0 : candidate >= 0);
  return valid(value) && valid(industryAverage)
    ? { period, value: value as number, industryAverage: industryAverage as number }
    : null;
}

function qualityCriteriaDefinitions(sector: SupportedFinancialSector) {
  if (sector === "bank") {
    return [
      ["annual_roe", "最近完整年度 ROE", 20],
      ["ttm_net_income", "近四季獲利品質", 20],
      ["bank_capital_adequacy_vs_industry", "銀行資本適足率相對業別", 20],
      ["loan_overdue_ratio_vs_industry", "放款逾放比相對業別", 20],
      ["loan_loss_coverage_vs_industry", "放款備抵覆蓋率相對業別", 20],
    ] as const;
  }
  return [
    ["annual_roe", "最近完整年度 ROE", 30],
    ["ttm_net_income", "近四季獲利品質", 30],
    ["capital_adequacy_vs_industry", "資本適足率相對業別", 40],
  ] as const;
}

export function buildFinancialCompanyQualityPillar(options: {
  sector: SupportedFinancialSector;
  profitability: CompanyMetricsBatchCompany | null;
  institution: FinancialInstitutionBatchCompany | null;
  profitabilityThroughPeriod: string | null;
  resolution: FinancialScreenMetricCatalogResolution;
}): ScreenPillar {
  const { sector, profitability, institution, profitabilityThroughPeriod, resolution } = options;
  const roe = annualRoe(profitability, profitabilityThroughPeriod, resolution);
  const netProfit = ttmNetProfit(
    profitability,
    profitabilityThroughPeriod,
    resolution,
  );
  const capitalPeriod = profitabilityThroughPeriod
    ? expectedCapitalPeriod(profitabilityThroughPeriod)
    : null;
  const assetQualityPeriod = profitabilityThroughPeriod;
  const capitalRole = CORE_INSTITUTION_METRIC_ROLES[sector][0];
  const capital = specialMetricComparison(
    institutionMetricByRole(institution, capitalRole),
    capitalPeriod,
    "positive",
  );
  const annualRoeCriterion = criterion({
    code: "annual_roe",
    label: "最近完整年度 ROE",
    status: roe
      ? roe.value >= FINANCIAL_SCREEN_THRESHOLDS.annualRoeMinimumPercent
        ? "pass"
        : "fail"
      : "unknown",
    value: roe?.value ?? null,
    unit: "%",
    periods: roe ? [roe.period] : [],
    rule: `>= ${FINANCIAL_SCREEN_THRESHOLDS.annualRoeMinimumPercent}%`,
    weight: sector === "bank" ? 20 : 30,
  });
  const netProfitCriterion = criterion({
    code: "ttm_net_income",
    label: "近四季獲利品質",
    status: netProfit
      ? netProfit.value > 0 &&
          netProfit.positiveQuarters >=
            FINANCIAL_SCREEN_THRESHOLDS.positiveTtmNetProfitQuartersMinimum
        ? "pass"
        : "fail"
      : "unknown",
    value: netProfit?.value ?? null,
    unit: companyMetricByRole(profitability, resolution, "net_profit")?.unit ??
      "source_unit",
    periods: netProfit?.periods ?? [],
    rule: "TTM > 0 且至少三季為正",
    weight: sector === "bank" ? 20 : 30,
    context: { positiveQuarterCount: netProfit?.positiveQuarters ?? null },
  });
  const capitalCriterion = criterion({
    code: sector === "bank"
      ? "bank_capital_adequacy_vs_industry"
      : "capital_adequacy_vs_industry",
    label: sector === "holding"
      ? "金控集團資本適足率相對業別"
      : sector === "bank"
        ? "銀行資本適足率相對業別"
        : "票券業資本適足率相對業別",
    status: capital
      ? capital.value >= capital.industryAverage ? "pass" : "fail"
      : "unknown",
    value: capital?.value ?? null,
    unit: "%",
    periods: capital ? [capital.period] : [],
    rule: "同 metric、同一期公司值 >= Mopsfin 業別平均",
    weight: sector === "bank" ? 20 : 40,
    context: { industryAverage: capital?.industryAverage ?? null },
  });
  const criteria: ScreenCriterion[] = [
    annualRoeCriterion,
    netProfitCriterion,
    capitalCriterion,
  ];
  if (sector === "bank") {
    const overdue = specialMetricComparison(
      institutionMetricByRole(institution, "loan_overdue_ratio"),
      assetQualityPeriod,
      "non_negative",
    );
    const coverage = specialMetricComparison(
      institutionMetricByRole(
        institution,
        "loan_loss_reserve_coverage_ratio",
      ),
      assetQualityPeriod,
      "non_negative",
    );
    criteria.push(
      criterion({
        code: "loan_overdue_ratio_vs_industry",
        label: "放款逾放比相對業別",
        status: overdue
          ? overdue.value <= overdue.industryAverage ? "pass" : "fail"
          : "unknown",
        value: overdue?.value ?? null,
        unit: "%",
        periods: overdue ? [overdue.period] : [],
        rule: "同一期公司值 <= Mopsfin 銀行業平均",
        weight: 20,
        context: { industryAverage: overdue?.industryAverage ?? null },
      }),
      criterion({
        code: "loan_loss_coverage_vs_industry",
        label: "放款備抵覆蓋率相對業別",
        status: coverage
          ? coverage.value >= coverage.industryAverage ? "pass" : "fail"
          : "unknown",
        value: coverage?.value ?? null,
        unit: "%",
        periods: coverage ? [coverage.period] : [],
        rule: "同一期公司值 >= Mopsfin 銀行業平均",
        weight: 20,
        context: { industryAverage: coverage?.industryAverage ?? null },
      }),
    );
  }
  const hardFailReasons: string[] = [];
  if (roe && roe.value <= 0) hardFailReasons.push("non_positive_annual_roe");
  if (netProfit && netProfit.value <= 0) {
    hardFailReasons.push("non_positive_ttm_net_income");
  }
  const anyUnknown = criteria.some((item) => item.status === "unknown");
  const score = scoreKnownCriteria(criteria);
  const capitalPass = capitalCriterion.status === "pass";
  const assetQualityPass = sector !== "bank" ||
    criteria
      .filter((item) =>
        item.code === "loan_overdue_ratio_vs_industry" ||
        item.code === "loan_loss_coverage_vs_industry"
      )
      .some((item) => item.status === "pass");
  const status = hardFailReasons.length > 0
    ? "fail"
    : anyUnknown
      ? "unknown"
      : capitalPass && assetQualityPass &&
          (score as number) >= FINANCIAL_SCREEN_THRESHOLDS.qualityScoreMinimum
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "company_quality",
    label: "金融經營品質與韌性",
    criteria,
    status,
    hardFailReasons,
  });
}

function exactChange(
  points: Array<{ period: string; value: number | null; valueStatus: string }>,
  period: string | null,
): { period: string; previousPeriod: string; value: number; previousValue: number; change: number } | null {
  if (!period) return null;
  const previousPeriod = shiftQuarter(period, -4);
  if (!previousPeriod) return null;
  const value = reportedValue(points, period);
  const previousValue = reportedValue(points, previousPeriod);
  return value === null || previousValue === null
    ? null
    : { period, previousPeriod, value, previousValue, change: value - previousValue };
}

function improvementBaseCriteria(
  trend: MonthlyRevenueTrendCompany | null,
  profitability: CompanyMetricsBatchCompany | null,
  throughPeriod: string | null,
  resolution: FinancialScreenMetricCatalogResolution,
  sector: SupportedFinancialSector,
): {
  criteria: ScreenCriterion[];
  revenueBreadthKnown: boolean;
  revenueBreadthPass: boolean;
  roeOrEpsPass: boolean;
} {
  const derived = trend?.derived;
  const revenueComparable = trend?.comparability.status === "comparable";
  const revenueBreadthKnown = Boolean(
    revenueComparable &&
      derived?.latestYoyPercent !== null &&
      derived?.rolling3MonthYoyPercent !== null &&
      derived?.positiveYoyMonthsInWindow !== null &&
      derived?.reportedYoyMonthsInWindow !== null &&
      (derived?.reportedYoyMonthsInWindow ?? 0) >= 6,
  );
  const revenueBreadthPass = revenueBreadthKnown &&
    (derived?.latestYoyPercent as number) > 0 &&
    (derived?.rolling3MonthYoyPercent as number) > 0 &&
    (derived?.positiveYoyMonthsInWindow as number) >= 4;
  const acceleration = revenueComparable
    ? derived?.yoyAccelerationVs3MonthsAgoPp ?? null
    : null;
  const roeMetric = companyMetricByRole(profitability, resolution, "roe");
  const epsMetric = companyMetricByRole(profitability, resolution, "eps");
  const roeChange = exactChange(roeMetric?.points ?? [], throughPeriod);
  const epsChange = exactChange(epsMetric?.points ?? [], throughPeriod);
  const weights = sector === "bank"
    ? { breadth: 20, acceleration: 10, roe: 15, eps: 15 }
    : { breadth: 25, acceleration: 15, roe: 20, eps: 20 };
  const criteria = [
    criterion({
      code: "revenue_breadth",
      label: "六個月營收／淨收益改善廣度",
      status: !revenueBreadthKnown
        ? "unknown"
        : revenueBreadthPass ? "pass" : "fail",
      value: derived?.latestYoyPercent ?? null,
      unit: "%",
      periods: trend?.points.map((point) => point.dataMonth) ?? [],
      rule: "最新與近三月 YoY > 0，六個月至少四月正成長",
      weight: weights.breadth,
    }),
    criterion({
      code: "revenue_acceleration",
      label: "營收／淨收益 YoY 加速",
      status: acceleration === null
        ? "unknown"
        : acceleration > 0 ? "pass" : "fail",
      value: acceleration,
      unit: "percentage_point",
      periods: trend && trend.points.length >= 4
        ? [
            trend.points.at(-4)?.dataMonth as string,
            trend.points.at(-1)?.dataMonth as string,
          ]
        : [],
      rule: "> 0pp vs. 三個月前",
      weight: weights.acceleration,
    }),
    criterion({
      code: "roe_yoy",
      label: "ROE 同期改善",
      status: roeChange
        ? roeChange.change >= 0 ? "pass" : "fail"
        : "unknown",
      value: roeChange ? round(roeChange.change, 2) : null,
      unit: "percentage_point",
      periods: roeChange
        ? [roeChange.previousPeriod, roeChange.period]
        : [],
      rule: ">= 0pp vs. 去年同季",
      weight: weights.roe,
    }),
    criterion({
      code: "eps_yoy",
      label: "EPS 同期改善",
      status: epsChange
        ? epsChange.value > 0 && epsChange.value > epsChange.previousValue
          ? "pass"
          : "fail"
        : "unknown",
      value: epsChange?.value ?? null,
      unit: epsMetric?.unit ?? "source_unit",
      periods: epsChange
        ? [epsChange.previousPeriod, epsChange.period]
        : [],
      rule: "EPS > 0 且高於去年同季",
      weight: weights.eps,
      context: { priorYearEps: epsChange?.previousValue ?? null },
    }),
  ];
  return {
    criteria,
    revenueBreadthKnown,
    revenueBreadthPass,
    roeOrEpsPass: criteria
      .filter((item) => item.code === "roe_yoy" || item.code === "eps_yoy")
      .some((item) => item.status === "pass"),
  };
}

function metricTrendCriterion(options: {
  metric: FinancialInstitutionBatchMetric | null;
  period: string | null;
  code: string;
  label: string;
  rule: string;
  weight: number;
  direction: "non_decreasing" | "non_increasing";
  validity: "positive" | "non_negative";
}): ScreenCriterion {
  const change = exactChange(options.metric?.points ?? [], options.period);
  const valuesValid = change &&
    (options.validity === "positive"
      ? change.value > 0 && change.previousValue > 0
      : change.value >= 0 && change.previousValue >= 0);
  const usable = options.metric?.availability === "available" && valuesValid
    ? change
    : null;
  const pass = usable &&
    (options.direction === "non_decreasing"
      ? usable.change >= 0
      : usable.change <= 0);
  return criterion({
    code: options.code,
    label: options.label,
    status: !usable ? "unknown" : pass ? "pass" : "fail",
    value: usable ? round(usable.change, 2) : null,
    unit: "percentage_point",
    periods: usable ? [usable.previousPeriod, usable.period] : [],
    rule: options.rule,
    weight: options.weight,
    context: {
      latestValue: usable?.value ?? null,
      priorYearValue: usable?.previousValue ?? null,
    },
  });
}

export function buildFinancialFundamentalImprovementPillar(options: {
  sector: SupportedFinancialSector;
  profitability: CompanyMetricsBatchCompany | null;
  institution: FinancialInstitutionBatchCompany | null;
  revenueTrend: MonthlyRevenueTrendCompany | null;
  profitabilityThroughPeriod: string | null;
  resolution: FinancialScreenMetricCatalogResolution;
}): ScreenPillar {
  const { sector, profitability, institution, revenueTrend, profitabilityThroughPeriod, resolution } = options;
  const base = improvementBaseCriteria(
    revenueTrend,
    profitability,
    profitabilityThroughPeriod,
    resolution,
    sector,
  );
  const capitalPeriod = profitabilityThroughPeriod
    ? expectedCapitalPeriod(profitabilityThroughPeriod)
    : null;
  const capitalRole = CORE_INSTITUTION_METRIC_ROLES[sector][0];
  const criteria = [
    ...base.criteria,
    metricTrendCriterion({
      metric: institutionMetricByRole(institution, capitalRole),
      period: capitalPeriod,
      code: "capital_adequacy_yoy",
      label: "資本適足率同期趨勢",
      rule: ">= 0pp vs. 去年同半年度",
      weight: sector === "bank" ? 15 : 20,
      direction: "non_decreasing",
      validity: "positive",
    }),
  ];
  if (sector === "bank") {
    criteria.push(
      metricTrendCriterion({
        metric: institutionMetricByRole(institution, "loan_overdue_ratio"),
        period: profitabilityThroughPeriod,
        code: "loan_overdue_ratio_yoy",
        label: "放款逾放比同期趨勢",
        rule: "<= 0pp vs. 去年同季",
        weight: 10,
        direction: "non_increasing",
        validity: "non_negative",
      }),
      metricTrendCriterion({
        metric: institutionMetricByRole(
          institution,
          "loan_loss_reserve_coverage_ratio",
        ),
        period: profitabilityThroughPeriod,
        code: "loan_loss_coverage_yoy",
        label: "放款備抵覆蓋率同期趨勢",
        rule: ">= 0pp vs. 去年同季",
        weight: 15,
        direction: "non_decreasing",
        validity: "non_negative",
      }),
    );
  }
  const hardFailReasons = base.revenueBreadthKnown && !base.revenueBreadthPass
    ? ["revenue_improvement_breadth_failed"]
    : [];
  const anyUnknown = criteria.some((item) => item.status === "unknown");
  const capitalPass = criteria.find(
    (item) => item.code === "capital_adequacy_yoy",
  )?.status === "pass";
  const assetTrendPass = sector !== "bank" || criteria
    .filter((item) =>
      item.code === "loan_overdue_ratio_yoy" ||
      item.code === "loan_loss_coverage_yoy"
    )
    .some((item) => item.status === "pass");
  const score = scoreKnownCriteria(criteria);
  const status = hardFailReasons.length > 0
    ? "fail"
    : anyUnknown
      ? "unknown"
      : base.revenueBreadthPass &&
          base.roeOrEpsPass &&
          capitalPass &&
          assetTrendPass &&
          (score as number) >= FINANCIAL_SCREEN_THRESHOLDS.improvementScoreMinimum
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "fundamental_improvement",
    label: "金融基本面改善",
    criteria,
    status,
    hardFailReasons,
  });
}

function validPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function percentile(value: number, peers: number[]): number | null {
  if (peers.length < FINANCIAL_SCREEN_THRESHOLDS.valuationPeerMinimum) return null;
  const below = peers.filter((peer) => peer < value - EPSILON).length;
  const equal = peers.filter((peer) => Math.abs(peer - value) <= EPSILON).length;
  return round(((below + equal / 2) / peers.length) * 100, 1);
}

export function financialValuationPeerContext(options: {
  subjectCode: string;
  sector: SupportedFinancialSector;
  valuation: ValuationRow;
  peers: FinancialValuationPeerObservation[];
}): FinancialValuationPeerContext {
  const subtypePeers = options.peers.filter((peer) => peer.sector === options.sector);
  const pePeers = subtypePeers.map((peer) => peer.peRatio).filter(validPositive);
  const pbPeers = subtypePeers
    .map((peer) => peer.priceToBookRatio)
    .filter(validPositive);
  const yieldPeers = subtypePeers
    .map((peer) => peer.dividendYieldPercent)
    .filter((value): value is number =>
      value !== null && Number.isFinite(value) && value >= 0
    );
  const pePercentile = validPositive(options.valuation.peRatio)
    ? percentile(options.valuation.peRatio, pePeers)
    : null;
  const pbPercentile = validPositive(options.valuation.priceToBookRatio)
    ? percentile(options.valuation.priceToBookRatio, pbPeers)
    : null;
  const yieldPercentile =
    options.valuation.dividendYieldPercent !== null &&
      options.valuation.dividendYieldPercent >= 0
      ? percentile(options.valuation.dividendYieldPercent, yieldPeers)
      : null;
  return {
    scope:
      pePercentile === null && pbPercentile === null && yieldPercentile === null
        ? "unavailable"
        : "same_financial_subtype",
    sector: options.sector,
    minimumPeerCount: FINANCIAL_SCREEN_THRESHOLDS.valuationPeerMinimum,
    pePeerCount: pePeers.length,
    pbPeerCount: pbPeers.length,
    yieldPeerCount: yieldPeers.length,
    pePercentile,
    pbPercentile,
    yieldPercentile,
  };
}

export function buildFinancialReasonableValuationPillar(options: {
  valuation: ValuationRow | null;
  annualRoeEvidence: { period: string; value: number } | null;
  peers: FinancialValuationPeerContext | null;
  valuationDate: string;
}): ScreenPillar {
  const { valuation, annualRoeEvidence, peers, valuationDate } = options;
  const pb = valuation && validPositive(valuation.priceToBookRatio)
    ? valuation.priceToBookRatio
    : null;
  const pe = valuation && validPositive(valuation.peRatio)
    ? valuation.peRatio
    : null;
  const yieldPercent = valuation?.dividendYieldPercent ?? null;
  const roeAdjustedPb =
    pb !== null && annualRoeEvidence && annualRoeEvidence.value > 0
      ? pb / (annualRoeEvidence.value / 100)
      : null;
  const pbKnown = pb !== null && peers?.pbPercentile !== null && peers !== null;
  const roeAdjustedKnown = roeAdjustedPb !== null;
  const peKnown = pe !== null && peers?.pePercentile !== null && peers !== null;
  const yieldKnown =
    yieldPercent !== null && peers?.yieldPercentile !== null && peers !== null;
  const pbPass = pbKnown &&
    (peers?.pbPercentile as number) <=
      FINANCIAL_SCREEN_THRESHOLDS.valuationPercentileMaximum;
  const roeAdjustedPass = roeAdjustedKnown &&
    roeAdjustedPb <= FINANCIAL_SCREEN_THRESHOLDS.roeAdjustedPriceToBookMaximum;
  const criteria = [
    criterion({
      code: "pb_subtype_percentile_primary",
      label: "P/B 與同金融子業別百分位",
      status: !pbKnown ? "unknown" : pbPass ? "pass" : "fail",
      value: pb,
      unit: "multiple",
      periods: pb === null ? [] : [valuationDate],
      rule: "0 < PB 且同 subtype percentile <= 70",
      weight: 40,
      context: {
        peerScope: peers?.scope ?? "unavailable",
        peerCount: peers?.pbPeerCount ?? 0,
        percentile: peers?.pbPercentile ?? null,
      },
    }),
    criterion({
      code: "roe_adjusted_pb_primary",
      label: "ROE 調整後 P/B",
      status: !roeAdjustedKnown
        ? "unknown"
        : roeAdjustedPass ? "pass" : "fail",
      value: roeAdjustedPb === null ? null : round(roeAdjustedPb, 2),
      unit: "ratio",
      periods: pb === null
        ? []
        : [annualRoeEvidence?.period ?? valuationDate, valuationDate],
      rule: "PB/(ROE/100) <= 30",
      weight: 30,
      context: {
        priceToBookRatio: pb,
        annualRoePercent: annualRoeEvidence?.value ?? null,
      },
    }),
    criterion({
      code: "pe_support",
      label: "P/E 支持",
      status: !peKnown
        ? "unknown"
        : pe <= FINANCIAL_SCREEN_THRESHOLDS.priceEarningsMaximum &&
            (peers?.pePercentile as number) <=
              FINANCIAL_SCREEN_THRESHOLDS.valuationPercentileMaximum
          ? "pass"
          : "fail",
      value: pe,
      unit: "multiple",
      periods: pe === null ? [] : [valuationDate],
      rule: "0 < PE <= 30 且同 subtype percentile <= 70（supporting）",
      weight: 15,
      mandatory: false,
      context: {
        peerCount: peers?.pePeerCount ?? 0,
        percentile: peers?.pePercentile ?? null,
      },
    }),
    criterion({
      code: "dividend_yield_support",
      label: "殖利率支持",
      status: !yieldKnown
        ? "unknown"
        : yieldPercent >=
              FINANCIAL_SCREEN_THRESHOLDS.dividendYieldSupportMinimumPercent ||
            (peers?.yieldPercentile as number) >= 60
          ? "pass"
          : "fail",
      value: yieldPercent,
      unit: "%",
      periods: yieldPercent === null ? [] : [valuationDate],
      rule: ">= 2% 或同 subtype percentile >= 60（supporting）",
      weight: 15,
      mandatory: false,
      context: {
        peerCount: peers?.yieldPeerCount ?? 0,
        percentile: peers?.yieldPercentile ?? null,
      },
    }),
  ];
  const hardFailReasons: string[] = [];
  if (
    roeAdjustedPb !== null &&
    roeAdjustedPb > FINANCIAL_SCREEN_THRESHOLDS.extremeRoeAdjustedPriceToBook &&
    (peers?.pbPercentile ?? -Infinity) >
      FINANCIAL_SCREEN_THRESHOLDS.extremePriceToBookPercentile
  ) {
    hardFailReasons.push("roe_adjusted_pb_extreme_vs_financial_subtype");
  }
  const status = hardFailReasons.length > 0
    ? "fail"
    : !pbKnown || !roeAdjustedKnown
      ? "unknown"
      : pbPass && roeAdjustedPass
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "reasonable_valuation",
    label: "金融估值合理",
    criteria,
    status,
    hardFailReasons,
  });
}

export function financialAnnualRoeEvidence(
  company: CompanyMetricsBatchCompany | null,
  throughPeriod: string | null,
  resolution: FinancialScreenMetricCatalogResolution,
): { period: string; value: number } | null {
  return annualRoe(company, throughPeriod, resolution);
}

export function financialCoarseScore(
  latestRevenueYoyPercent: number | null,
  cumulativeRevenueYoyPercent: number | null,
  valuation: ValuationRow,
): number {
  let score = 0;
  if (latestRevenueYoyPercent !== null && latestRevenueYoyPercent > 0) score += 30;
  if (
    cumulativeRevenueYoyPercent !== null &&
    cumulativeRevenueYoyPercent > 0
  ) score += 20;
  if (
    validPositive(valuation.priceToBookRatio) &&
    valuation.priceToBookRatio <= FINANCIAL_SCREEN_THRESHOLDS.priceToBookMaximum
  ) score += 25;
  if (
    validPositive(valuation.peRatio) &&
    valuation.peRatio <= FINANCIAL_SCREEN_THRESHOLDS.priceEarningsMaximum
  ) score += 15;
  if (
    valuation.dividendYieldPercent !== null &&
    valuation.dividendYieldPercent >=
      FINANCIAL_SCREEN_THRESHOLDS.dividendYieldSupportMinimumPercent
  ) score += 10;
  return score;
}

export function financialQualityCriterionCodes(
  sector: SupportedFinancialSector,
): string[] {
  return qualityCriteriaDefinitions(sector).map(([code]) => code);
}
