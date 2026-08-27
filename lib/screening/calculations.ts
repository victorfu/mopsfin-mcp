import type { MasterCompany } from "@/lib/company-master/types";
import type {
  CompanyMetricsBatchCompany,
  CompanyMetricsBatchMetric,
} from "@/lib/mopsfin/batch";
import type { TrendPoint } from "@/lib/mopsfin/types";
import type { CompanyReactionSignals } from "@/lib/reaction/types";
import type { MonthlyRevenueTrendCompany } from "@/lib/revenue/types";
import type { ValuationRow } from "@/lib/valuation/types";

import type {
  ScreenCandidateBucket,
  ScreenCriterion,
  ScreenPillar,
  TaiwanStockScreenCandidate,
} from "./types";

export const SCREEN_METRIC_CODES = [
  "ROE",
  "NetIncome",
  "OperatingCashFlow",
  "DebtRatio",
  "GrossMargin",
  "OperatingMargin",
  "EPS",
] as const;

const EPSILON = 1e-9;

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

export interface ValuationPeerContext {
  scope: "same_industry" | "same_market" | "unavailable";
  peScope: "same_industry" | "same_market" | "unavailable";
  pbScope: "same_industry" | "same_market" | "unavailable";
  yieldScope: "same_industry" | "same_market" | "unavailable";
  pePeerCount: number;
  pbPeerCount: number;
  yieldPeerCount: number;
  pePercentile: number | null;
  pbPercentile: number | null;
  yieldPercentile: number | null;
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
    reasonCodes:
      input.reasonCodes ??
      [
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
  const evidenceGaps = options.criteria
    .filter((item) => item.status === "unknown")
    .map((item) => item.code);
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
    evidenceGaps,
  };
}

function unknownCriteria(
  definitions: Array<Pick<
    CriterionInput,
    "code" | "label" | "unit" | "rule" | "weight" | "mandatory"
  >>,
  reasonCode: string,
): ScreenCriterion[] {
  return definitions.map((definition) =>
    criterion({
      ...definition,
      status: "unknown",
      value: null,
      periods: [],
      reasonCodes: [reasonCode],
    }),
  );
}

export function unknownPillar(
  key: ScreenPillar["key"],
  label: string,
  reasonCode: string,
): ScreenPillar {
  const definitions: Record<
    ScreenPillar["key"],
    Array<Pick<
      CriterionInput,
      "code" | "label" | "unit" | "rule" | "weight" | "mandatory"
    >>
  > = {
    company_quality: [
      { code: "annual_roe", label: "最近完整年度 ROE", unit: "%", rule: ">= 8%", weight: 25 },
      { code: "ttm_net_income", label: "近四季獲利品質", unit: "source_unit", rule: "TTM > 0 且至少三季為正", weight: 25 },
      { code: "ttm_operating_cash_conversion", label: "近四季營業現金轉換", unit: "ratio", rule: "TTM OCF > 0 且 OCF/NI >= 0.8", weight: 30 },
      { code: "debt_ratio", label: "負債比", unit: "%", rule: "<= 70%", weight: 20 },
    ],
    fundamental_improvement: [
      { code: "revenue_breadth", label: "六個月營收改善廣度", unit: "%", rule: "最新與近三月 YoY > 0，六個月至少四月正成長", weight: 30 },
      { code: "revenue_acceleration", label: "營收 YoY 加速", unit: "percentage_point", rule: "> 0pp vs. 三個月前", weight: 20 },
      { code: "operating_margin_yoy", label: "營業利益率年增", unit: "percentage_point", rule: ">= 0.5pp", weight: 20 },
      { code: "gross_margin_yoy", label: "毛利率年增", unit: "percentage_point", rule: ">= 0pp", weight: 10 },
      { code: "eps_yoy", label: "單季 EPS 改善", unit: "source_unit", rule: "EPS > 0 且高於去年同季", weight: 20 },
    ],
    reasonable_valuation: [
      { code: "pe_primary", label: "本益比與同業百分位", unit: "multiple", rule: "0 < PE <= 30 且 percentile <= 70", weight: 45 },
      { code: "roe_adjusted_pb_primary", label: "ROE 調整後股價淨值比", unit: "ratio", rule: "PB/(ROE/100) <= 30 且 PB percentile <= 70", weight: 35 },
      { code: "dividend_yield_support", label: "殖利率支持", unit: "%", rule: ">= 2% 或同業 percentile >= 60", weight: 20, mandatory: false },
    ],
    market_underreaction_proxy: [
      { code: "excess_return_5", label: "5 日超額報酬", unit: "percentage_point", rule: "介於 -8pp 與 +3pp", weight: 15 },
      { code: "excess_return_20", label: "20 日超額報酬", unit: "percentage_point", rule: "介於 -15pp 與 +8pp", weight: 25 },
      { code: "excess_return_60", label: "60 日超額報酬", unit: "percentage_point", rule: "介於 -25pp 與 +15pp", weight: 20 },
      { code: "volume_ratio_5_to_20", label: "5/20 日成交量比", unit: "ratio", rule: "<= 1.5", weight: 15 },
      { code: "distance_below_60d_high", label: "距 60 日高點", unit: "%", rule: "<= 20%", weight: 15 },
      { code: "maximum_drawdown_60", label: "60 日最大回撤", unit: "%", rule: ">= -30%", weight: 10 },
      { code: "turnover_floor", label: "20 日平均成交金額門檻", unit: "TWD", rule: ">= 5,000,000", weight: 0 },
    ],
  };
  return finalizePillar({
    key,
    label,
    criteria: unknownCriteria(definitions[key], reasonCode),
    status: "unknown",
  });
}

function quarterIndex(period: string): number | null {
  const match = /^(\d{4})Q([1-4])$/.exec(period);
  return match ? Number(match[1]) * 4 + Number(match[2]) - 1 : null;
}

function quarterFromIndex(index: number): string {
  const year = Math.floor(index / 4);
  return `${year}Q${(index % 4) + 1}`;
}

export function shiftQuarter(period: string, delta: number): string | null {
  const index = quarterIndex(period);
  return index === null ? null : quarterFromIndex(index + delta);
}

function metricByCode(
  company: CompanyMetricsBatchCompany,
  code: (typeof SCREEN_METRIC_CODES)[number],
): CompanyMetricsBatchMetric | null {
  return company.metrics.find((metric) => metric.metricCode === code) ?? null;
}

function reportedValue(metric: CompanyMetricsBatchMetric | null, period: string): number | null {
  const point = metric?.points.find((candidate) => candidate.period === period);
  return point?.valueStatus === "reported" && point.value !== null ? point.value : null;
}

function reportedPeriods(metric: CompanyMetricsBatchMetric): Set<string> {
  return new Set(
    metric.points
      .filter(
        (point): point is TrendPoint & { value: number } =>
          point.valueStatus === "reported" && point.value !== null && quarterIndex(point.period) !== null,
      )
      .map((point) => point.period),
  );
}

export function financialCommonThroughPeriod(
  company: CompanyMetricsBatchCompany,
): string | null {
  const metrics = SCREEN_METRIC_CODES.map((code) => metricByCode(company, code));
  if (metrics.some((metric) => metric === null)) return null;
  const [first, ...rest] = metrics as CompanyMetricsBatchMetric[];
  const common = [...reportedPeriods(first)].filter((period) =>
    rest.every((metric) => reportedPeriods(metric).has(period)),
  );
  return common.sort((left, right) => (quarterIndex(left) as number) - (quarterIndex(right) as number)).at(-1) ?? null;
}

export function latestAnnualRoe(
  company: CompanyMetricsBatchCompany,
  throughPeriod: string,
): { period: string; value: number } | null {
  const through = quarterIndex(throughPeriod);
  const metric = metricByCode(company, "ROE");
  if (through === null || !metric) return null;
  const throughYear = Math.floor(through / 4);
  const throughQuarter = (through % 4) + 1;
  const expectedAnnualPeriod = `${
    throughQuarter === 4 ? throughYear : throughYear - 1
  }Q4`;
  const value = reportedValue(metric, expectedAnnualPeriod);
  return value === null ? null : { period: expectedAnnualPeriod, value };
}

function exactTrailingPeriods(throughPeriod: string, count: number): string[] | null {
  const through = quarterIndex(throughPeriod);
  if (through === null) return null;
  return Array.from({ length: count }, (_, index) =>
    quarterFromIndex(through - count + index + 1),
  );
}

function exactValues(
  metric: CompanyMetricsBatchMetric | null,
  periods: string[],
): number[] | null {
  const values = periods.map((period) => reportedValue(metric, period));
  return values.every((value) => value !== null) ? (values as number[]) : null;
}

export function buildCompanyQualityPillar(
  company: CompanyMetricsBatchCompany | null,
  throughPeriod: string | null,
): ScreenPillar {
  if (!company || !throughPeriod) {
    return unknownPillar("company_quality", "好公司", "financial_common_period_unavailable");
  }
  const ttmPeriods = exactTrailingPeriods(throughPeriod, 4) as string[];
  const roe = latestAnnualRoe(company, throughPeriod);
  const netIncome = exactValues(metricByCode(company, "NetIncome"), ttmPeriods);
  const operatingCashFlow = exactValues(
    metricByCode(company, "OperatingCashFlow"),
    ttmPeriods,
  );
  const debtRatio = reportedValue(metricByCode(company, "DebtRatio"), throughPeriod);
  const ttmNetIncome = netIncome?.reduce((sum, value) => sum + value, 0) ?? null;
  const positiveNetIncomeQuarters = netIncome?.filter((value) => value > 0).length ?? null;
  const ttmOperatingCashFlow =
    operatingCashFlow?.reduce((sum, value) => sum + value, 0) ?? null;
  const cashConversion =
    ttmNetIncome !== null && ttmNetIncome > 0 && ttmOperatingCashFlow !== null
      ? ttmOperatingCashFlow / ttmNetIncome
      : null;

  const criteria = [
    criterion({
      code: "annual_roe",
      label: "最近完整年度 ROE",
      status: roe ? (roe.value >= 8 ? "pass" : "fail") : "unknown",
      value: roe?.value ?? null,
      unit: "%",
      periods: roe ? [roe.period] : [],
      rule: ">= 8%",
      weight: 25,
      context: { hardFailAtOrBelowPercent: 0 },
    }),
    criterion({
      code: "ttm_net_income",
      label: "近四季獲利品質",
      status:
        ttmNetIncome === null || positiveNetIncomeQuarters === null
          ? "unknown"
          : ttmNetIncome > 0 && positiveNetIncomeQuarters >= 3
            ? "pass"
            : "fail",
      value: ttmNetIncome,
      unit: metricByCode(company, "NetIncome")?.unit ?? "source_unit",
      periods: ttmPeriods,
      rule: "TTM > 0 且至少三季為正",
      weight: 25,
      context: { positiveQuarterCount: positiveNetIncomeQuarters },
      reasonCodes: netIncome ? undefined : ["missing_exact_ttm_quarters"],
    }),
    criterion({
      code: "ttm_operating_cash_conversion",
      label: "近四季營業現金轉換",
      status:
        ttmOperatingCashFlow === null || cashConversion === null
          ? "unknown"
          : ttmOperatingCashFlow > 0 && cashConversion >= 0.8
            ? "pass"
            : "fail",
      value: cashConversion === null ? null : round(cashConversion, 3),
      unit: "ratio",
      periods: ttmPeriods,
      rule: "TTM OCF > 0 且 OCF/NI >= 0.8",
      weight: 30,
      context: {
        ttmOperatingCashFlow,
        ttmNetIncome,
      },
      reasonCodes:
        operatingCashFlow && netIncome
          ? undefined
          : ["missing_exact_ttm_quarters"],
    }),
    criterion({
      code: "debt_ratio",
      label: "負債比",
      status: debtRatio === null ? "unknown" : debtRatio <= 70 ? "pass" : "fail",
      value: debtRatio,
      unit: "%",
      periods: debtRatio === null ? [] : [throughPeriod],
      rule: "<= 70%",
      weight: 20,
      context: { hardFailAbovePercent: 85 },
    }),
  ];
  const hardFailReasons: string[] = [];
  if (roe && roe.value <= 0) hardFailReasons.push("non_positive_annual_roe");
  if (ttmNetIncome !== null && ttmNetIncome <= 0) hardFailReasons.push("non_positive_ttm_net_income");
  if (ttmOperatingCashFlow !== null && ttmOperatingCashFlow <= 0) {
    hardFailReasons.push("non_positive_ttm_operating_cash_flow");
  }
  if (debtRatio !== null && debtRatio > 85) hardFailReasons.push("debt_ratio_above_85_percent");
  const mandatoryUnknown = criteria.some(
    (item) => item.mandatory && item.status === "unknown",
  );
  const score = scoreKnownCriteria(criteria);
  const status = hardFailReasons.length > 0
    ? "fail"
    : mandatoryUnknown
      ? "unknown"
      : (score as number) >= 70
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "company_quality",
    label: "好公司",
    criteria,
    status,
    hardFailReasons,
  });
}

function exactYearOverYearChange(
  metric: CompanyMetricsBatchMetric | null,
  throughPeriod: string,
): { value: number; periods: string[] } | null {
  const previous = shiftQuarter(throughPeriod, -4);
  if (!previous) return null;
  const latestValue = reportedValue(metric, throughPeriod);
  const previousValue = reportedValue(metric, previous);
  if (latestValue === null || previousValue === null) return null;
  return { value: latestValue - previousValue, periods: [previous, throughPeriod] };
}

export function buildFundamentalImprovementPillar(
  company: CompanyMetricsBatchCompany | null,
  trend: MonthlyRevenueTrendCompany | null,
  throughPeriod: string | null,
): ScreenPillar {
  if (!company || !trend || !throughPeriod) {
    return unknownPillar(
      "fundamental_improvement",
      "基本面改善",
      !trend ? "revenue_trend_unavailable" : "financial_common_period_unavailable",
    );
  }
  const derived = trend.derived;
  const revenueComparable = trend.comparability.status === "comparable";
  const breadthKnown = revenueComparable &&
    derived.latestYoyPercent !== null &&
    derived.rolling3MonthYoyPercent !== null &&
    derived.positiveYoyMonthsInWindow !== null &&
    derived.reportedYoyMonthsInWindow !== null &&
    derived.reportedYoyMonthsInWindow >= 6;
  const breadthPass = breadthKnown &&
    (derived.latestYoyPercent as number) > 0 &&
    (derived.rolling3MonthYoyPercent as number) > 0 &&
    (derived.positiveYoyMonthsInWindow as number) >= 4;
  const acceleration = revenueComparable
    ? derived.yoyAccelerationVs3MonthsAgoPp
    : null;
  const operatingMargin = exactYearOverYearChange(
    metricByCode(company, "OperatingMargin"),
    throughPeriod,
  );
  const grossMargin = exactYearOverYearChange(
    metricByCode(company, "GrossMargin"),
    throughPeriod,
  );
  const priorYearPeriod = shiftQuarter(throughPeriod, -4) as string;
  const epsLatest = reportedValue(metricByCode(company, "EPS"), throughPeriod);
  const epsPriorYear = reportedValue(metricByCode(company, "EPS"), priorYearPeriod);
  const epsKnown = epsLatest !== null && epsPriorYear !== null;

  const criteria = [
    criterion({
      code: "revenue_breadth",
      label: "六個月營收改善廣度",
      status: !breadthKnown ? "unknown" : breadthPass ? "pass" : "fail",
      value: derived.latestYoyPercent,
      unit: "%",
      periods: trend.points.map((point) => point.dataMonth),
      rule: "最新與近三月 YoY > 0，六個月至少四月正成長",
      weight: 30,
      context: {
        latestYoyPercent: derived.latestYoyPercent,
        rolling3MonthYoyPercent: derived.rolling3MonthYoyPercent,
        positiveYoyMonths: derived.positiveYoyMonthsInWindow,
        reportedYoyMonths: derived.reportedYoyMonthsInWindow,
        comparability: trend.comparability.status,
      },
      reasonCodes: breadthKnown ? undefined : ["six_month_revenue_evidence_incomplete"],
    }),
    criterion({
      code: "revenue_acceleration",
      label: "營收 YoY 加速",
      status: acceleration === null ? "unknown" : acceleration > 0 ? "pass" : "fail",
      value: acceleration,
      unit: "percentage_point",
      periods: trend.points.length >= 4
        ? [trend.points.at(-4)?.dataMonth as string, trend.points.at(-1)?.dataMonth as string]
        : [],
      rule: "> 0pp vs. 三個月前",
      weight: 20,
    }),
    criterion({
      code: "operating_margin_yoy",
      label: "營業利益率年增",
      status: operatingMargin === null
        ? "unknown"
        : operatingMargin.value >= 0.5
          ? "pass"
          : "fail",
      value: operatingMargin?.value ?? null,
      unit: "percentage_point",
      periods: operatingMargin?.periods ?? [],
      rule: ">= 0.5pp",
      weight: 20,
      reasonCodes: operatingMargin ? undefined : ["missing_exact_year_ago_quarter"],
    }),
    criterion({
      code: "gross_margin_yoy",
      label: "毛利率年增",
      status: grossMargin === null
        ? "unknown"
        : grossMargin.value >= 0
          ? "pass"
          : "fail",
      value: grossMargin?.value ?? null,
      unit: "percentage_point",
      periods: grossMargin?.periods ?? [],
      rule: ">= 0pp",
      weight: 10,
      reasonCodes: grossMargin ? undefined : ["missing_exact_year_ago_quarter"],
    }),
    criterion({
      code: "eps_yoy",
      label: "單季 EPS 改善",
      status: !epsKnown
        ? "unknown"
        : (epsLatest as number) > 0 && (epsLatest as number) > (epsPriorYear as number)
          ? "pass"
          : "fail",
      value: epsLatest,
      unit: metricByCode(company, "EPS")?.unit ?? "source_unit",
      periods: epsKnown ? [priorYearPeriod, throughPeriod] : [],
      rule: "EPS > 0 且高於去年同季",
      weight: 20,
      context: { priorYearEps: epsPriorYear },
      reasonCodes: epsKnown ? undefined : ["missing_exact_year_ago_quarter"],
    }),
  ];
  const anyUnknown = criteria.some((item) => item.status === "unknown");
  const operatingOrEpsPass =
    criteria.find((item) => item.code === "operating_margin_yoy")?.status === "pass" ||
    criteria.find((item) => item.code === "eps_yoy")?.status === "pass";
  const score = scoreKnownCriteria(criteria);
  const hardFailReasons = breadthKnown && !breadthPass
    ? ["revenue_improvement_breadth_failed"]
    : [];
  const status = hardFailReasons.length > 0
    ? "fail"
    : anyUnknown
      ? "unknown"
      : breadthPass && operatingOrEpsPass && (score as number) >= 60
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "fundamental_improvement",
    label: "基本面改善",
    criteria,
    status,
    hardFailReasons,
  });
}

function percentile(value: number, peers: number[]): number | null {
  if (peers.length === 0) return null;
  const below = peers.filter((peer) => peer < value - EPSILON).length;
  const equal = peers.filter((peer) => Math.abs(peer - value) <= EPSILON).length;
  return round(((below + equal / 2) / peers.length) * 100, 1);
}

function validPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function valuationPeerContext(
  subject: MasterCompany,
  subjectValuation: ValuationRow,
  eligibleCompanies: MasterCompany[],
  valuationRows: ValuationRow[],
): ValuationPeerContext {
  const companyByCode = new Map(eligibleCompanies.map((company) => [company.code, company]));
  const rowsWithIdentity = valuationRows.flatMap((row) => {
    const company = companyByCode.get(row.code);
    return company ? [{ row, company }] : [];
  });
  const industryRows = rowsWithIdentity.filter(
    ({ company }) => company.industryCode === subject.industryCode,
  );
  const marketRows = rowsWithIdentity.filter(
    ({ company }) => company.market === subject.market,
  );
  const industryPe = industryRows.map(({ row }) => row.peRatio).filter(validPositive);
  const industryPb = industryRows
    .map(({ row }) => row.priceToBookRatio)
    .filter(validPositive);
  const industryYield = industryRows
    .map(({ row }) => row.dividendYieldPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const marketPe = marketRows.map(({ row }) => row.peRatio).filter(validPositive);
  const marketPb = marketRows.map(({ row }) => row.priceToBookRatio).filter(validPositive);
  const marketYield = marketRows
    .map(({ row }) => row.dividendYieldPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
  const pePeers = industryPe.length >= 20 ? industryPe : marketPe.length >= 20 ? marketPe : [];
  const pbPeers = industryPb.length >= 20 ? industryPb : marketPb.length >= 20 ? marketPb : [];
  const yieldPeers = industryYield.length >= 20
    ? industryYield
    : marketYield.length >= 20
      ? marketYield
      : [];
  const peUsesIndustry = industryPe.length >= 20;
  const pbUsesIndustry = industryPb.length >= 20;
  const yieldUsesIndustry = industryYield.length >= 20;
  const scope = pePeers.length === 0 && pbPeers.length === 0 && yieldPeers.length === 0
    ? "unavailable"
    : peUsesIndustry && pbUsesIndustry && yieldUsesIndustry
      ? "same_industry"
      : "same_market";
  return {
    scope,
    peScope: pePeers.length === 0 ? "unavailable" : peUsesIndustry ? "same_industry" : "same_market",
    pbScope: pbPeers.length === 0 ? "unavailable" : pbUsesIndustry ? "same_industry" : "same_market",
    yieldScope: yieldPeers.length === 0
      ? "unavailable"
      : yieldUsesIndustry
        ? "same_industry"
        : "same_market",
    pePeerCount: pePeers.length,
    pbPeerCount: pbPeers.length,
    yieldPeerCount: yieldPeers.length,
    pePercentile: validPositive(subjectValuation.peRatio)
      ? percentile(subjectValuation.peRatio, pePeers)
      : null,
    pbPercentile: validPositive(subjectValuation.priceToBookRatio)
      ? percentile(subjectValuation.priceToBookRatio, pbPeers)
      : null,
    yieldPercentile:
      subjectValuation.dividendYieldPercent !== null &&
      subjectValuation.dividendYieldPercent >= 0
        ? percentile(subjectValuation.dividendYieldPercent, yieldPeers)
        : null,
  };
}

export function buildReasonableValuationPillar(
  valuation: ValuationRow | null,
  annualRoe: { period: string; value: number } | null,
  peers: ValuationPeerContext | null,
  valuationDate: string,
): ScreenPillar {
  if (!valuation || !peers) {
    return unknownPillar("reasonable_valuation", "估值合理", "valuation_evidence_unavailable");
  }
  const pe = validPositive(valuation.peRatio) ? valuation.peRatio : null;
  const pb = validPositive(valuation.priceToBookRatio)
    ? valuation.priceToBookRatio
    : null;
  const yieldPercent = valuation.dividendYieldPercent;
  const roeAdjustedPb =
    pb !== null && annualRoe && annualRoe.value > 0
      ? pb / (annualRoe.value / 100)
      : null;
  const peKnown = pe !== null && peers.pePercentile !== null;
  const pbKnown = roeAdjustedPb !== null && peers.pbPercentile !== null;
  const yieldKnown = yieldPercent !== null && peers.yieldPercentile !== null;
  const pePass = peKnown && pe <= 30 && (peers.pePercentile as number) <= 70;
  const pbPass = pbKnown && roeAdjustedPb <= 30 && (peers.pbPercentile as number) <= 70;
  const yieldPass =
    yieldKnown &&
    (yieldPercent >= 2 || (peers.yieldPercentile as number) >= 60);
  const criteria = [
    criterion({
      code: "pe_primary",
      label: "本益比與同業百分位",
      status: !peKnown ? "unknown" : pePass ? "pass" : "fail",
      value: pe,
      unit: "multiple",
      periods: pe === null ? [] : [valuationDate],
      rule: "0 < PE <= 30 且 percentile <= 70",
      weight: 45,
      context: {
        peerScope: peers.peScope,
        peerCount: peers.pePeerCount,
        percentile: peers.pePercentile,
      },
      reasonCodes: peKnown ? undefined : [pe === null ? "pe_not_meaningful" : "pe_peer_sample_insufficient"],
    }),
    criterion({
      code: "roe_adjusted_pb_primary",
      label: "ROE 調整後股價淨值比",
      status: !pbKnown ? "unknown" : pbPass ? "pass" : "fail",
      value: roeAdjustedPb === null ? null : round(roeAdjustedPb, 2),
      unit: "ratio",
      periods: pb === null ? [] : [annualRoe?.period ?? valuationDate, valuationDate],
      rule: "PB/(ROE/100) <= 30 且 PB percentile <= 70",
      weight: 35,
      context: {
        priceToBookRatio: pb,
        annualRoePercent: annualRoe?.value ?? null,
        peerScope: peers.pbScope,
        peerCount: peers.pbPeerCount,
        pbPercentile: peers.pbPercentile,
      },
      reasonCodes: pbKnown
        ? undefined
        : [pb === null ? "pb_not_meaningful" : annualRoe === null ? "annual_roe_unavailable" : "pb_peer_sample_insufficient"],
    }),
    criterion({
      code: "dividend_yield_support",
      label: "殖利率支持",
      status: !yieldKnown ? "unknown" : yieldPass ? "pass" : "fail",
      value: yieldPercent,
      unit: "%",
      periods: yieldPercent === null ? [] : [valuationDate],
      rule: ">= 2% 或同業 percentile >= 60（支持條件，不可單獨使估值柱通過）",
      weight: 20,
      mandatory: false,
      context: {
        peerScope: peers.yieldScope,
        peerCount: peers.yieldPeerCount,
        peerPercentile: peers.yieldPercentile,
      },
      reasonCodes: yieldKnown
        ? undefined
        : [yieldPercent === null ? "dividend_yield_unavailable" : "yield_peer_sample_insufficient"],
    }),
  ];
  const hardFailReasons: string[] = [];
  if (peKnown && pe > 50 && (peers.pePercentile as number) > 90) {
    hardFailReasons.push("pe_extreme_vs_peers");
  }
  if (
    pbKnown &&
    roeAdjustedPb > 50 &&
    (peers.pbPercentile as number) > 90
  ) {
    hardFailReasons.push("roe_adjusted_pb_extreme_vs_peers");
  }
  const anyPrimaryKnown = peKnown || pbKnown;
  const status = hardFailReasons.length > 0
    ? "fail"
    : !anyPrimaryKnown
      ? "unknown"
      : pePass || pbPass
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "reasonable_valuation",
    label: "估值合理",
    criteria,
    status,
    hardFailReasons,
  });
}

function reactionReturnSignal(
  reaction: CompanyReactionSignals,
  horizon: 5 | 20 | 60,
): CompanyReactionSignals["returns"][number] | null {
  return reaction.returns.find((item) => item.horizonSessions === horizon) ?? null;
}

export function buildMarketUnderreactionPillar(
  reaction: CompanyReactionSignals | null,
): ScreenPillar {
  if (!reaction || reaction.comparability.status !== "provisional_raw") {
    return unknownPillar(
      "market_underreaction_proxy",
      "市場尚未充分反應（proxy）",
      reaction ? "raw_price_path_not_comparable" : "reaction_evidence_unavailable",
    );
  }
  const return5 = reactionReturnSignal(reaction, 5);
  const return20 = reactionReturnSignal(reaction, 20);
  const return60 = reactionReturnSignal(reaction, 60);
  const excessValue = (
    signal: CompanyReactionSignals["returns"][number] | null,
  ) => signal?.excessReturnStatus === "available"
    ? signal.excessReturnPercentagePoints
    : null;
  const excess5 = excessValue(return5);
  const excess20 = excessValue(return20);
  const excess60 = excessValue(return60);
  const volumeRatio =
    reaction.liquidity.volume5To20Ratio.status === "available"
      ? reaction.liquidity.volume5To20Ratio.value
      : null;
  const turnover20 =
    reaction.liquidity.averageTurnover20SessionsTwd.status === "available"
      ? reaction.liquidity.averageTurnover20SessionsTwd.value
      : null;
  const distance = reaction.pricePath.status === "available"
    ? reaction.pricePath.distanceBelowWindowHighPercent
    : null;
  const drawdown = reaction.pricePath.status === "available"
    ? reaction.pricePath.maximumDrawdownPercent
    : null;
  const rangeStatus = (value: number | null, minimum: number, maximum: number) =>
    value === null ? "unknown" as const : value >= minimum && value <= maximum ? "pass" as const : "fail" as const;
  const criteria = [
    criterion({
      code: "excess_return_5",
      label: "5 日超額報酬",
      status: rangeStatus(excess5, -8, 3),
      value: excess5,
      unit: "percentage_point",
      periods: return5 ? [return5.startDate, return5.endDate] : [],
      rule: "介於 -8pp 與 +3pp",
      weight: 15,
      context: {
        stockReturnPercent: return5?.stockReturnPercent ?? null,
        benchmarkReturnPercent: return5?.benchmarkReturnPercent ?? null,
        hardFailAbovePercentagePoints: 10,
      },
    }),
    criterion({
      code: "excess_return_20",
      label: "20 日超額報酬",
      status: rangeStatus(excess20, -15, 8),
      value: excess20,
      unit: "percentage_point",
      periods: return20 ? [return20.startDate, return20.endDate] : [],
      rule: "介於 -15pp 與 +8pp",
      weight: 25,
      context: {
        stockReturnPercent: return20?.stockReturnPercent ?? null,
        benchmarkReturnPercent: return20?.benchmarkReturnPercent ?? null,
        hardFailAbovePercentagePoints: 15,
      },
    }),
    criterion({
      code: "excess_return_60",
      label: "60 日超額報酬",
      status: rangeStatus(excess60, -25, 15),
      value: excess60,
      unit: "percentage_point",
      periods: return60 ? [return60.startDate, return60.endDate] : [],
      rule: "介於 -25pp 與 +15pp",
      weight: 20,
      context: {
        stockReturnPercent: return60?.stockReturnPercent ?? null,
        benchmarkReturnPercent: return60?.benchmarkReturnPercent ?? null,
        hardFailAbovePercentagePoints: 25,
      },
    }),
    criterion({
      code: "volume_ratio_5_to_20",
      label: "5/20 日成交量比",
      status: volumeRatio === null ? "unknown" : volumeRatio <= 1.5 ? "pass" : "fail",
      value: volumeRatio,
      unit: "ratio",
      periods: [
        reaction.liquidity.averageVolume20SessionsShares.startDate,
        reaction.liquidity.averageVolume20SessionsShares.endDate,
      ],
      rule: "<= 1.5",
      weight: 15,
      context: {
        averageVolume5SessionsShares:
          reaction.liquidity.averageVolume5SessionsShares.value,
        averageVolume20SessionsShares:
          reaction.liquidity.averageVolume20SessionsShares.value,
      },
    }),
    criterion({
      code: "distance_below_60d_high",
      label: "距 60 日高點",
      status: distance === null ? "unknown" : distance <= 20 ? "pass" : "fail",
      value: distance,
      unit: "%",
      periods: [reaction.pricePath.startDate, reaction.pricePath.endDate],
      rule: "<= 20%",
      weight: 15,
      context: {
        adversePathAbovePercent: 30,
        adversePathAlsoRequiresNegativeExcess20: true,
      },
    }),
    criterion({
      code: "maximum_drawdown_60",
      label: "60 日最大回撤",
      status: drawdown === null ? "unknown" : drawdown >= -30 ? "pass" : "fail",
      value: drawdown,
      unit: "%",
      periods: [reaction.pricePath.startDate, reaction.pricePath.endDate],
      rule: ">= -30%",
      weight: 10,
    }),
    criterion({
      code: "turnover_floor",
      label: "20 日平均成交金額門檻",
      status: turnover20 === null ? "unknown" : turnover20 >= 5_000_000 ? "pass" : "fail",
      value: turnover20,
      unit: "TWD",
      periods: [
        reaction.liquidity.averageTurnover20SessionsTwd.startDate,
        reaction.liquidity.averageTurnover20SessionsTwd.endDate,
      ],
      rule: ">= 5,000,000",
      weight: 0,
    }),
  ];
  const hardFailReasons: string[] = [];
  if ((excess5 ?? -Infinity) > 10 || (excess20 ?? -Infinity) > 15 || (excess60 ?? -Infinity) > 25) {
    hardFailReasons.push("price_reaction_already_extended");
  }
  if (distance !== null && excess20 !== null && distance > 30 && excess20 < 0) {
    hardFailReasons.push("adverse_price_path");
  }
  if (turnover20 !== null && turnover20 < 5_000_000) {
    hardFailReasons.push("liquidity_below_floor");
  }
  const anyUnknown = criteria.some((item) => item.status === "unknown");
  const score = scoreKnownCriteria(criteria);
  const status = hardFailReasons.length > 0
    ? "fail"
    : anyUnknown
      ? "unknown"
      : (score as number) >= 65
        ? "pass"
        : "fail";
  return finalizePillar({
    key: "market_underreaction_proxy",
    label: "市場尚未充分反應（proxy）",
    criteria,
    status,
    hardFailReasons,
  });
}

export function coarseScore(
  latestRevenueYoyPercent: number | null,
  cumulativeRevenueYoyPercent: number | null,
  valuation: ValuationRow,
): number {
  let score = 0;
  if (latestRevenueYoyPercent !== null && latestRevenueYoyPercent > 0) score += 30;
  if (cumulativeRevenueYoyPercent !== null && cumulativeRevenueYoyPercent > 0) score += 20;
  if (validPositive(valuation.peRatio) && valuation.peRatio <= 30) score += 25;
  if (validPositive(valuation.priceToBookRatio) && valuation.priceToBookRatio <= 5) score += 15;
  if (valuation.dividendYieldPercent !== null && valuation.dividendYieldPercent >= 2) score += 10;
  return score;
}

export function classifyCandidate(
  pillars: TaiwanStockScreenCandidate["pillars"],
): ScreenCandidateBucket {
  const values = Object.values(pillars);
  if (
    pillars.companyQuality.hardFailReasons.length > 0 ||
    pillars.fundamentalImprovement.hardFailReasons.length > 0 ||
    pillars.marketUnderreactionProxy.hardFailReasons.includes("liquidity_below_floor")
  ) {
    return "deprioritized";
  }
  if (values.every((pillar) => pillar.status === "pass")) return "research_candidate";
  if (values.some((pillar) => pillar.status === "unknown")) return "insufficient_data";
  if (
    pillars.companyQuality.status === "pass" &&
    pillars.fundamentalImprovement.status === "pass" &&
    (pillars.reasonableValuation.status === "fail" ||
      pillars.marketUnderreactionProxy.status === "fail")
  ) {
    return "watchlist";
  }
  return "deprioritized";
}

export function candidateOverallScore(
  pillars: TaiwanStockScreenCandidate["pillars"],
): number | null {
  const values = Object.values(pillars);
  if (values.some((pillar) => pillar.score === null || pillar.status === "unknown")) {
    return null;
  }
  return round(
    values.reduce((sum, pillar) => sum + (pillar.score as number), 0) / values.length,
    1,
  );
}

export function evidenceCompleteness(
  pillars: TaiwanStockScreenCandidate["pillars"],
): number {
  return round(
    Object.values(pillars).reduce((sum, pillar) => sum + pillar.knownWeight, 0) / 4,
    1,
  );
}

const BUCKET_PRIORITY: Record<ScreenCandidateBucket, number> = {
  research_candidate: 0,
  watchlist: 1,
  insufficient_data: 2,
  deprioritized: 3,
};

export function compareScreenCandidates(
  left: TaiwanStockScreenCandidate,
  right: TaiwanStockScreenCandidate,
): number {
  const bucketDifference = BUCKET_PRIORITY[left.bucket] - BUCKET_PRIORITY[right.bucket];
  if (bucketDifference !== 0) return bucketDifference;
  const leftScore = left.overallScore ?? -Infinity;
  const rightScore = right.overallScore ?? -Infinity;
  if (leftScore !== rightScore) return rightScore - leftScore;
  if (left.evidenceCompletenessPercent !== right.evidenceCompletenessPercent) {
    return right.evidenceCompletenessPercent - left.evidenceCompletenessPercent;
  }
  return left.companyCode.localeCompare(right.companyCode);
}

export function rejectionReasons(
  pillars: TaiwanStockScreenCandidate["pillars"],
): string[] {
  const hardFails = Object.values(pillars).flatMap((pillar) => pillar.hardFailReasons);
  if (hardFails.length > 0) return [...new Set(hardFails)].slice(0, 3);
  return Object.values(pillars)
    .flatMap((pillar) =>
      pillar.criteria
        .filter((item) => item.status === "fail")
        .map((item) => `${pillar.key}:${item.code}`),
    )
    .slice(0, 3);
}

export function nextDiligenceSteps(
  pillars: TaiwanStockScreenCandidate["pillars"],
): string[] {
  const steps: string[] = [];
  const gaps = Object.values(pillars).flatMap((pillar) => pillar.evidenceGaps);
  if (gaps.length > 0) steps.push("補齊或人工核對 unknown 的財務、營收、估值或價量證據。");
  if (pillars.reasonableValuation.status !== "pass") {
    steps.push("以正常化盈餘、forward estimates 與產業週期重新檢驗估值，避免把低 PE 誤判為便宜。");
  }
  if (pillars.marketUnderreactionProxy.status !== "pass") {
    steps.push("核對除權息、分割等公司行動後的 adjusted return，並確認近期價格反應是否已反映事件。");
  }
  steps.push("閱讀最新財報、法說與重大訊息，確認改善的原因、可持續性及反證條件。");
  steps.push("補做市場預期、分析師修正與未來催化劑研究；本 screen 沒有 consensus 或新聞資料。");
  return [...new Set(steps)].slice(0, 5);
}
