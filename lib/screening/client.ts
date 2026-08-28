import {
  companyMasterClient,
  type CompanyMasterClient,
} from "@/lib/company-master/client";
import type { MasterCompany } from "@/lib/company-master/types";
import {
  aggregateFreshness,
  evaluateFreshness,
} from "@/lib/freshness/evaluate";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
import {
  companyMetricsBatchClient,
  type CompanyMetricsBatchClient,
  type CompanyMetricsBatchCompany,
} from "@/lib/mopsfin/batch";
import { mopsfinClient, type MopsfinClient } from "@/lib/mopsfin/client";
import { asMopsfinError, MopsfinError } from "@/lib/mopsfin/errors";
import {
  reactionClient,
  type ReactionClient,
} from "@/lib/reaction/client";
import type { StockReactionSignalsResult } from "@/lib/reaction/types";
import {
  monthlyRevenueClient,
  type MonthlyRevenueClient,
} from "@/lib/revenue/client";
import type {
  MonthlyRevenueRow,
  MonthlyRevenueTrendCompany,
  MonthlyRevenueTrendResult,
} from "@/lib/revenue/types";
import {
  valuationClient,
  type ValuationClient,
} from "@/lib/valuation/client";
import type { ValuationRow } from "@/lib/valuation/types";

import {
  buildCompanyQualityPillar,
  buildFundamentalImprovementPillar,
  buildMarketUnderreactionPillar,
  buildReasonableValuationPillar,
  candidateOverallScore,
  classifyCandidate,
  coarseScore,
  compareScreenCandidates,
  evidenceCompleteness,
  financialCommonThroughPeriod,
  latestAnnualRoe,
  nextDiligenceSteps,
  rejectionReasons,
  unknownPillar,
  valuationPeerContext,
} from "./calculations";
import {
  assertScreenMetricBatchContract,
  resolveScreenMetricRoles,
  resolvedMetricCodes,
  SCREEN_METRIC_ROLES,
  throwCatalogContractMismatch,
  type ScreenMetricCatalogResolution,
} from "./metric-roles";
import {
  TAIWAN_STOCK_SCREEN_DEFINITION,
  TAIWAN_STOCK_SCREEN_PRESET,
  type ScreenCompactCompany,
  type ScreenDependencyStatus,
  type ScreenPillar,
  type ScreenSource,
  type TaiwanStockScreenCandidate,
  type TaiwanStockScreenDefinition,
  type TaiwanStockScreenQuery,
  type TaiwanStockScreenResult,
} from "./types";

type CompanyMasterLike = Pick<CompanyMasterClient, "listCompanies">;
type RevenueLike = Pick<
  MonthlyRevenueClient,
  "getMonthlyRevenue" | "getMonthlyRevenueTrend"
>;
type ValuationLike = Pick<ValuationClient, "getDailyMarketValuation">;
type MetricsLike = Pick<CompanyMetricsBatchClient, "getCompanyMetricsBatch">;
type CatalogLike = Pick<MopsfinClient, "getCatalog">;
type ReactionLike = Pick<ReactionClient, "getStockReactionSignals">;

interface ScreenClientDependencies {
  companyMaster?: CompanyMasterLike;
  revenue?: RevenueLike;
  valuation?: ValuationLike;
  metrics?: MetricsLike;
  catalog?: CatalogLike;
  reaction?: ReactionLike;
}

interface CoarseCompany {
  company: MasterCompany;
  revenue: MonthlyRevenueRow;
  valuation: ValuationRow;
  score: number;
}

interface DeepCompany extends CoarseCompany {
  metrics: CompanyMetricsBatchCompany | null;
  revenueTrend: MonthlyRevenueTrendCompany | null;
  financialThroughPeriod: string | null;
  companyQuality: ScreenPillar;
  fundamentalImprovement: ScreenPillar;
  reasonableValuation: ScreenPillar;
}

const DEEP_COMPANY_LIMIT = 10 as const;
const REACTION_COMPANY_LIMIT = 5 as const;
const SUMMARY_LIMIT = 25 as const;

export function buildTaiwanStockScreenDefinition(
  metricResolution: ScreenMetricCatalogResolution,
): TaiwanStockScreenDefinition {
  return {
  id: TAIWAN_STOCK_SCREEN_DEFINITION,
  preset: TAIWAN_STOCK_SCREEN_PRESET,
  posture: "research_triage_not_recommendation",
  latestOnly: true,
  financialCompanies: "excluded",
  scoreCompensationAcrossPillars: false,
  pillarWeights: {
    company_quality: 25,
    fundamental_improvement: 25,
    reasonable_valuation: 25,
    market_underreaction_proxy: 25,
  },
  stages: [
    {
      stage: "coarse",
      maximumCompanies: null,
      description:
        "以目前上市櫃公司母體、最新月營收與最新官方估值做全母體或指定清單的低成本初篩。",
    },
    {
      stage: "deep",
      maximumCompanies: DEEP_COMPANY_LIMIT,
      description:
        "依粗篩排序對前 10 家查六個月營收趨勢與七項季度財務指標；其餘明確標示未做深度評估。",
    },
    {
      stage: "reaction",
      maximumCompanies: REACTION_COMPANY_LIMIT,
      description:
        "依前三柱排序與 candidate_limit，最多對 5 家計算 5／20／60 個 benchmark sessions 的 price-index-compatible corporate-action-aware reaction proxy。",
    },
  ],
  coarseRanking: {
    eligibilityRules: [
      "必須有 latest 月營收官方列，且 latest YoY 或累計 YoY 至少一項可用。",
      "必須有 latest 官方估值列，且 PE 或 PB 至少一項為正且可用。",
    ],
    scoreComponents: [
      { code: "positive_latest_revenue_yoy", points: 30, rule: "latest revenue YoY > 0" },
      { code: "positive_cumulative_revenue_yoy", points: 20, rule: "cumulative revenue YoY > 0" },
      { code: "reasonable_absolute_pe", points: 25, rule: "0 < trailing PE <= 30" },
      { code: "reasonable_absolute_pb", points: 15, rule: "0 < PB <= 5" },
      { code: "dividend_yield_support", points: 10, rule: "dividend yield >= 2%" },
    ],
    tieBreak: [
      "coarse_score_desc",
      "latest_revenue_yoy_desc_null_last",
      "company_code_asc",
    ],
  },
  evidencePolicies: {
    requiredFinancialMetricRoles: [...SCREEN_METRIC_ROLES],
    financialMetricCodes: resolvedMetricCodes(metricResolution),
    resolvedFinancialMetrics: metricResolution.resolvedFinancialMetrics,
    catalogDiscoveredAt: metricResolution.catalogDiscoveredAt,
    catalogSnapshotId: metricResolution.catalogSnapshotId,
    financialAlignment: "exact_common_quarter_no_substitution",
    valuationPeerMinimum: 20,
    valuationPeerFallback: "same_industry_then_same_market",
    reactionHorizons: [5, 20, 60],
    reactionPriceBasis:
      "price_index_compatible_corporate_action_adjusted_vs_price_index",
  },
  decisionPolicy: {
    researchCandidate: "四柱全部 pass 才是 research_candidate。",
    watchlist:
      "好公司與基本面改善均 pass，但估值或市場反應柱 fail 且沒有 unknown 時列 watchlist。",
    insufficientData:
      "任一必要柱為 unknown 且沒有品質／改善硬性反證時列 insufficient_data。",
    deprioritized:
      "品質或改善有硬性反證、流動性低於門檻，或其餘完整證據不符條件時列 deprioritized。",
  },
  limitations: [
    "這是研究候選分流，不是買賣建議、完整盡職調查或已證明的錯價。",
    "使用各官方來源當下可取得的 latest 資料，時間點可能不同，不是 point-in-time snapshot，也不適合直接回測。",
    "個股原始價格保留 raw unadjusted；reaction 只用 TWSE／TPEx actual-result 證據移除股數變動的機械斷點，再與 price index 比較。現金股利價格效果保留，且沒有股息再投資，因此不是 total-return 分析。",
    "不含市場共識、盈餘預估修正、法人持股／籌碼、新聞與催化劑資料。",
    "一般公司指標不適用金融業，因此產業代號 17 固定排除。",
  ],
  };
}

function normalizeQuery(query: TaiwanStockScreenQuery): TaiwanStockScreenQuery {
  if (!(["all", "listed", "otc"] as const).includes(query.market)) {
    throw new MopsfinError("INVALID_ARGUMENT", "market 必須是 all、listed 或 otc。");
  }
  if (query.preset !== TAIWAN_STOCK_SCREEN_PRESET) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `preset 目前只支援 ${TAIWAN_STOCK_SCREEN_PRESET}。`,
    );
  }
  if (!Number.isInteger(query.candidateLimit) || query.candidateLimit < 1 || query.candidateLimit > 5) {
    throw new MopsfinError("INVALID_ARGUMENT", "candidate_limit 必須是 1 至 5 的整數。");
  }
  if (typeof query.includeKy !== "boolean") {
    throw new MopsfinError("INVALID_ARGUMENT", "include_ky 必須是 boolean。");
  }
  if (query.companyCodes === undefined) return { ...query };
  const companyCodes = query.companyCodes.map((code) => code.trim());
  if (companyCodes.length < 1 || companyCodes.length > 100) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 必須包含 1 至 100 個代號。");
  }
  if (companyCodes.some((code) => !/^\d{4}$/.test(code))) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 必須全部是四碼公司股票代號。");
  }
  if (new Set(companyCodes).size !== companyCodes.length) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 不得重複。");
  }
  return { ...query, companyCodes: [...companyCodes].sort() };
}

function errorMessage(error: unknown): string {
  const normalized = asMopsfinError(error);
  return `${normalized.code}: ${normalized.message}`;
}

function dependency(options: ScreenDependencyStatus): ScreenDependencyStatus {
  return options;
}

function compact(
  company: MasterCompany,
  stage: ScreenCompactCompany["stage"],
  reasonCodes: string[],
): ScreenCompactCompany {
  return {
    companyCode: company.code,
    companyName: company.shortName,
    stage,
    reasonCodes,
  };
}

function validPositive(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0;
}

function coarseEligibilityReasons(
  revenue: MonthlyRevenueRow | undefined,
  valuation: ValuationRow | undefined,
): string[] {
  const reasons: string[] = [];
  if (!revenue) reasons.push("latest_revenue_row_missing");
  else if (revenue.yoyPercent === null && revenue.cumulativeYoyPercent === null) {
    reasons.push("latest_revenue_growth_unavailable");
  }
  if (!valuation) reasons.push("latest_valuation_row_missing");
  else if (!validPositive(valuation.peRatio) && !validPositive(valuation.priceToBookRatio)) {
    reasons.push("primary_valuation_unavailable");
  }
  return reasons;
}

function preReactionComparator(left: DeepCompany, right: DeepCompany): number {
  const statusPriority = (pillar: ScreenPillar) =>
    pillar.status === "pass" ? 0 : pillar.status === "fail" ? 1 : 2;
  for (const key of ["companyQuality", "fundamentalImprovement", "reasonableValuation"] as const) {
    const difference = statusPriority(left[key]) - statusPriority(right[key]);
    if (difference !== 0) return difference;
  }
  const leftScores = [left.companyQuality.score, left.fundamentalImprovement.score, left.reasonableValuation.score]
    .filter((value): value is number => value !== null);
  const rightScores = [right.companyQuality.score, right.fundamentalImprovement.score, right.reasonableValuation.score]
    .filter((value): value is number => value !== null);
  const leftAverage = leftScores.length
    ? leftScores.reduce((sum, value) => sum + value, 0) / leftScores.length
    : -Infinity;
  const rightAverage = rightScores.length
    ? rightScores.reduce((sum, value) => sum + value, 0) / rightScores.length
    : -Infinity;
  if (leftAverage !== rightAverage) return rightAverage - leftAverage;
  if (left.score !== right.score) return right.score - left.score;
  return left.company.code.localeCompare(right.company.code);
}

function uniqueSources(sources: ScreenSource[]): ScreenSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = [
      source.kind,
      source.sourceUrl,
      source.retrievedAt,
      source.market ?? "all",
      source.asOf,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateEvidenceGaps(
  pillars: TaiwanStockScreenCandidate["pillars"],
): string[] {
  return [...new Set(Object.values(pillars).flatMap((pillar) => pillar.evidenceGaps))];
}

function masterReportDate(
  company: MasterCompany,
  sources: Awaited<ReturnType<CompanyMasterLike["listCompanies"]>>["sources"],
): string {
  return sources.find((source) => source.market === company.market)?.reportDate ?? "unknown";
}

function sourceCompleteness(statuses: ScreenDependencyStatus[]): boolean {
  return statuses
    .filter((status) => status.status !== "not_run")
    .every((status) => status.status === "complete");
}

function taipeiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export class TaiwanStockScreenClient {
  private readonly companyMaster: CompanyMasterLike;
  private readonly revenue: RevenueLike;
  private readonly valuation: ValuationLike;
  private readonly metrics: MetricsLike;
  private readonly catalog: CatalogLike;
  private readonly reaction: ReactionLike;

  constructor(
    dependencies: ScreenClientDependencies = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.companyMaster = dependencies.companyMaster ?? companyMasterClient;
    this.revenue = dependencies.revenue ?? monthlyRevenueClient;
    this.valuation = dependencies.valuation ?? valuationClient;
    this.metrics = dependencies.metrics ?? companyMetricsBatchClient;
    this.catalog = dependencies.catalog ?? mopsfinClient;
    this.reaction = dependencies.reaction ?? reactionClient;
  }

  async screenTaiwanStockCandidates(
    rawQuery: TaiwanStockScreenQuery,
  ): Promise<TaiwanStockScreenResult> {
    const query = normalizeQuery(rawQuery);
    const evaluationTime = this.now();
    const [master, latestRevenue, latestValuation, catalog] = await Promise.all([
      this.companyMaster.listCompanies({
        market: query.market,
        includeFinancial: true,
        includeKy: true,
      }),
      this.revenue.getMonthlyRevenue({
        market: query.market,
        dataMonth: "latest",
        ...(query.companyCodes ? { companyCodes: query.companyCodes } : {}),
        universePolicy: "compatible",
      }),
      this.valuation.getDailyMarketValuation({
        market: query.market,
        date: "latest",
        universePolicy: "compatible",
      }),
      this.catalog.getCatalog(),
    ]);
    const metricResolution = resolveScreenMetricRoles(catalog);
    const screenDefinition = buildTaiwanStockScreenDefinition(metricResolution);
    const metricCodes = resolvedMetricCodes(metricResolution);
    const masterFreshness = aggregateFreshness(
      master.sources.map((source) =>
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
          observedAsOf: source.reportDate,
          expectedAsOf: taipeiDate(evaluationTime),
          sourceUrls: [source.sourceUrl],
        }),
      ),
    );
    const masterStale = masterFreshness === "stale";

    const masterByCode = new Map(master.companies.map((company) => [company.code, company]));
    const missingRequestedCodes = (query.companyCodes ?? []).filter(
      (code) => !masterByCode.has(code),
    );
    if (missingRequestedCodes.length > 0) {
      throw new MopsfinError(
        "NOT_FOUND",
        "部分 company_codes 不在所選市場的目前 TWSE／TPEx 公司母體。",
        { details: { missingCompanyCodes: missingRequestedCodes } },
      );
    }

    const selectedBase = query.companyCodes
      ? query.companyCodes.map((code) => masterByCode.get(code) as MasterCompany)
      : master.companies;
    const peerEligibleCompanies = master.companies.filter(
      (company) =>
        !company.isFinancial && (query.includeKy || !company.isKy),
    );
    const financialCompanies = selectedBase.filter((company) => company.isFinancial);
    const nonFinancial = selectedBase.filter((company) => !company.isFinancial);
    const kyCompanies = query.includeKy
      ? []
      : nonFinancial.filter((company) => company.isKy);
    const eligibleCompanies = nonFinancial.filter(
      (company) => query.includeKy || !company.isKy,
    );
    const revenueByCode = new Map(latestRevenue.rows.map((row) => [row.code, row]));
    const valuationByCode = new Map(latestValuation.rows.map((row) => [row.code, row]));
    const coarseExcluded: ScreenCompactCompany[] = [];
    const coarseCompanies: CoarseCompany[] = [];
    for (const company of eligibleCompanies) {
      const revenue = revenueByCode.get(company.code);
      const valuation = valuationByCode.get(company.code);
      const reasons = coarseEligibilityReasons(revenue, valuation);
      if (reasons.length > 0) {
        coarseExcluded.push(compact(company, "coarse_filter", reasons));
        continue;
      }
      const revenueRow = revenue as MonthlyRevenueRow;
      const valuationRow = valuation as ValuationRow;
      coarseCompanies.push({
        company,
        revenue: revenueRow,
        valuation: valuationRow,
        score: coarseScore(
          revenueRow.yoyPercent,
          revenueRow.cumulativeYoyPercent,
          valuationRow,
        ),
      });
    }
    coarseCompanies.sort((left, right) =>
      right.score - left.score ||
      (right.revenue.yoyPercent ?? -Infinity) - (left.revenue.yoyPercent ?? -Infinity) ||
      left.company.code.localeCompare(right.company.code),
    );
    const deepSelected = coarseCompanies.slice(0, DEEP_COMPANY_LIMIT);
    const deepCodes = deepSelected.map(({ company }) => company.code);
    const dependencyStatus: ScreenDependencyStatus[] = [
      dependency({
        stage: "coarse",
        dependency: "company_master",
        status: "partial",
        affectedCompanyCodes: masterStale
          ? eligibleCompanies.map((company) => company.code)
          : [],
        message: masterStale
          ? "目前公司母體 reportDate 已超過 7 日 freshness window；仍保留來源證據，但所有 screen pillars fail closed 為 unknown。"
          : "必要來源與 heuristic gate 均通過，但官方沒有 declared row count，不能證明完整 rowset。",
      }),
      dependency({
        stage: "coarse",
        dependency: "latest_monthly_revenue",
        status:
          latestRevenue.coverageComplete &&
          latestRevenue.sourceCoverage.status === "verified" &&
          latestRevenue.selectionComplete
            ? "complete"
            : "partial",
        affectedCompanyCodes: latestRevenue.missingCompanyCodes,
        message:
          latestRevenue.coverageComplete &&
          latestRevenue.sourceCoverage.status === "verified" &&
          latestRevenue.selectionComplete
            ? null
            : "官方來源未提供 declared row count，或 requested selection 存在缺列；細節見 sources 與 warnings。",
      }),
      dependency({
        stage: "coarse",
        dependency: "latest_valuation",
        status:
          latestValuation.coverageComplete &&
          latestValuation.universeCoverageVerified &&
          latestValuation.selectionComplete
            ? "complete"
            : "partial",
        affectedCompanyCodes: latestValuation.missingCompanyCodes,
        message:
          latestValuation.coverageComplete && latestValuation.universeCoverageVerified
            ? null
            : "估值來源可用，但目前公司母體核對並非完全 verified；細節見 reconciliation。",
      }),
    ];

    let revenueTrendResult: MonthlyRevenueTrendResult | null = null;
    let metricsResult: Awaited<ReturnType<MetricsLike["getCompanyMetricsBatch"]>> | null = null;
    if (deepCodes.length > 0) {
      const [trendSettled, metricsSettled] = await Promise.allSettled([
        this.revenue.getMonthlyRevenueTrend({
          market: query.market,
          companyCodes: deepCodes,
          endMonth: "latest",
          lookbackMonths: 6,
          universePolicy: "compatible",
        }),
        this.metrics.getCompanyMetricsBatch({
          companyCodes: deepCodes,
          metricCodes,
          basis: "quarterly",
        }),
      ]);
      if (trendSettled.status === "fulfilled") {
        revenueTrendResult = trendSettled.value;
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "monthly_revenue_trend",
            status:
              trendSettled.value.selectionComplete && trendSettled.value.coverageComplete
                ? "complete"
                : "partial",
            affectedCompanyCodes: trendSettled.value.missingCompanyCodes,
            message: trendSettled.value.coverageComplete
              ? null
              : "歷史 MOPS CSV 是修訂後資料且沒有 declared row count；不等於發布當時 vintage。",
          }),
        );
      } else {
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "monthly_revenue_trend",
            status: "failed",
            affectedCompanyCodes: deepCodes,
            message: errorMessage(trendSettled.reason),
          }),
        );
      }
      if (metricsSettled.status === "fulfilled") {
        assertScreenMetricBatchContract(metricResolution, metricsSettled.value);
        metricsResult = metricsSettled.value;
        const affectedCompanyCodes = [
          ...new Set([
            ...metricsSettled.value.coverage.missingCompanyCodes,
            ...metricsSettled.value.coverage.noValidDataCompanyCodes,
            ...metricsSettled.value.coverage.unavailableCompanyCodes,
          ]),
        ];
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "company_metrics_batch",
            status: metricsSettled.value.coverage.selectionComplete
              ? "complete"
              : "partial",
            affectedCompanyCodes,
            message: metricsSettled.value.coverage.selectionComplete
              ? null
              : metricsSettled.value.failures.length > 0
                ? metricsSettled.value.coverage.failureIsolationComplete
                  ? "部分公司 identity 或財務指標 unavailable；失敗已逐公司隔離，其他公司仍繼續深篩。"
                  : "部分財務錯誤只能歸因到共享 metric×chunk request；受影響公司維持 unknown，其他成功資料仍保留。"
                : "部分公司或指標沒有可用的 reported series。",
          }),
        );
      } else {
        const metricError = asMopsfinError(metricsSettled.reason);
        if (
          metricError.code === "NOT_FOUND" &&
          metricError.reason === "CATALOG_METRIC_NOT_FOUND"
        ) {
          throwCatalogContractMismatch(metricResolution, [
            {
              kind: "batch_catalog_race_or_metric_missing",
              requestedMetricCodes: metricCodes,
              upstreamCode: metricError.code,
              upstreamMessage: metricError.message,
            },
          ]);
        }
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "company_metrics_batch",
            status: "failed",
            affectedCompanyCodes: deepCodes,
            message: errorMessage(metricsSettled.reason),
          }),
        );
      }
    } else {
      dependencyStatus.push(
        dependency({
          stage: "deep",
          dependency: "monthly_revenue_trend",
          status: "not_run",
          affectedCompanyCodes: [],
          message: "粗篩沒有可進入深度評估的公司。",
        }),
        dependency({
          stage: "deep",
          dependency: "company_metrics_batch",
          status: "not_run",
          affectedCompanyCodes: [],
          message: "粗篩沒有可進入深度評估的公司。",
        }),
      );
    }

    const trendByCode = new Map(
      (revenueTrendResult?.companies ?? []).map((company) => [company.code, company]),
    );
    const metricsByCode = new Map(
      (metricsResult?.companies ?? []).map((company) => [company.companyCode, company]),
    );
    const deepCompanies: DeepCompany[] = deepSelected.map((coarse) => {
      const metrics = metricsByCode.get(coarse.company.code) ?? null;
      const revenueTrend = trendByCode.get(coarse.company.code) ?? null;
      const financialThroughPeriod = metrics
        ? financialCommonThroughPeriod(metrics, metricResolution)
        : null;
      const computedCompanyQuality = buildCompanyQualityPillar(
        metrics,
        financialThroughPeriod,
        metricResolution,
      );
      const computedFundamentalImprovement = buildFundamentalImprovementPillar(
        metrics,
        revenueTrend,
        financialThroughPeriod,
        metricResolution,
      );
      const annualRoe = metrics && financialThroughPeriod
        ? latestAnnualRoe(metrics, financialThroughPeriod, metricResolution)
        : null;
      const peerContext = valuationPeerContext(
        coarse.company,
        coarse.valuation,
        peerEligibleCompanies,
        latestValuation.rows,
      );
      const computedReasonableValuation = buildReasonableValuationPillar(
        coarse.valuation,
        annualRoe,
        peerContext,
        latestValuation.dataDate,
      );
      const companyQuality = masterStale
        ? unknownPillar(
            "company_quality",
            "好公司",
            "source_stale_company_master",
          )
        : computedCompanyQuality;
      const fundamentalImprovement = masterStale
        ? unknownPillar(
            "fundamental_improvement",
            "基本面改善",
            "source_stale_company_master",
          )
        : computedFundamentalImprovement;
      const reasonableValuation = masterStale
        ? unknownPillar(
            "reasonable_valuation",
            "估值合理",
            "source_stale_company_master",
          )
        : computedReasonableValuation;
      return {
        ...coarse,
        metrics,
        revenueTrend,
        financialThroughPeriod,
        companyQuality,
        fundamentalImprovement,
        reasonableValuation,
      };
    });
    deepCompanies.sort(preReactionComparator);
    const eligibleForReaction = deepCompanies.filter(
      (company) =>
        company.companyQuality.status !== "unknown" &&
        company.fundamentalImprovement.status !== "unknown",
    );
    const reactionSelected = eligibleForReaction.slice(
      0,
      Math.min(query.candidateLimit, REACTION_COMPANY_LIMIT),
    );
    let reactionResult: StockReactionSignalsResult | null = null;
    if (reactionSelected.length > 0) {
      try {
        reactionResult = await this.reaction.getStockReactionSignals({
          companyCodes: reactionSelected.map(({ company }) => company.code),
          asOf: "latest",
          horizons: [5, 20, 60],
          pageSize: reactionSelected.length,
        });
        const affectedReactionCodes = reactionSelected
          .map(({ company }) => company.code)
          .filter((code) => {
            const reaction = reactionResult?.companies.find(
              (company) => company.companyCode === code,
            );
            return (
              !reaction ||
              !reaction.dataQualityComplete ||
              reaction.comparability.status !== "price_index_compatible"
            );
          });
        dependencyStatus.push(
          dependency({
            stage: "reaction",
            dependency: "stock_reaction_signals",
            status:
              !reactionResult.pagination.hasMore &&
              reactionResult.coverage.dataQualityComplete &&
              reactionResult.coverage.corporateActionHistoryComplete
                ? "complete"
                : "partial",
            affectedCompanyCodes: affectedReactionCodes,
            message: reactionResult.pagination.hasMore
              ? "48 work-unit 上限使部分公司未在本次 screen 完成；不自動跨頁。"
              : reactionResult.coverage.dataQualityComplete &&
                  reactionResult.coverage.corporateActionHistoryComplete
                ? null
                : "部分 exact-session OHLC 或公司行動調整證據缺值／不可比較；受影響公司維持 unknown。",
          }),
        );
      } catch (error) {
        dependencyStatus.push(
          dependency({
            stage: "reaction",
            dependency: "stock_reaction_signals",
            status: "failed",
            affectedCompanyCodes: reactionSelected.map(({ company }) => company.code),
            message: errorMessage(error),
          }),
        );
      }
    } else {
      dependencyStatus.push(
        dependency({
          stage: "reaction",
          dependency: "stock_reaction_signals",
          status: "not_run",
          affectedCompanyCodes: [],
          message:
            deepCompanies.length === 0
              ? "沒有完成粗篩與深度評估的公司。"
              : "沒有品質與改善證據均可判讀的公司可進入 reaction 階段。",
        }),
      );
    }

    const deepByCode = new Map(
      deepCompanies.map((company) => [company.company.code, company]),
    );
    const reactionByCode = new Map(
      (reactionResult?.companies ?? []).map((company) => [company.companyCode, company]),
    );
    const metricUnavailableCodes = new Set(
      metricsResult?.coverage.unavailableCompanyCodes ?? [],
    );
    const candidates = (reactionResult?.companies ?? []).flatMap(
      (reaction): TaiwanStockScreenCandidate[] => {
        const deep = deepByCode.get(reaction.companyCode);
        if (!deep) return [];
        const marketUnderreactionProxy = buildMarketUnderreactionPillar(reaction);
        const pillars: TaiwanStockScreenCandidate["pillars"] = {
          companyQuality: deep.companyQuality,
          fundamentalImprovement: deep.fundamentalImprovement,
          reasonableValuation: deep.reasonableValuation,
          marketUnderreactionProxy,
        };
        const candidate: TaiwanStockScreenCandidate = {
          rank: 0,
          companyCode: deep.company.code,
          companyName: deep.company.name,
          shortName: deep.company.shortName,
          market: deep.company.market,
          industryCode: deep.company.industryCode,
          listingDate: deep.company.listingDate,
          isKy: deep.company.isKy,
          bucket: classifyCandidate(pillars),
          overallScore: candidateOverallScore(pillars),
          evidenceCompletenessPercent: evidenceCompleteness(pillars),
          broadEvidence: {
            revenueMonth: latestRevenue.dataMonth,
            latestRevenueYoyPercent: deep.revenue.yoyPercent,
            cumulativeRevenueYoyPercent: deep.revenue.cumulativeYoyPercent,
            valuationDate: latestValuation.dataDate,
            peRatio: deep.valuation.peRatio,
            priceToBookRatio: deep.valuation.priceToBookRatio,
            dividendYieldPercent: deep.valuation.dividendYieldPercent,
            closePriceTwd: deep.valuation.closePriceTwd,
            coarseScore: deep.score,
          },
          pillars,
          firstRejectionReasons: rejectionReasons(pillars),
          evidenceGaps: candidateEvidenceGaps(pillars),
          nextDiligence: nextDiligenceSteps(pillars),
          asOf: {
            masterReportDate: masterReportDate(deep.company, master.sources),
            revenueThroughMonth: latestRevenue.dataMonth,
            valuationDate: latestValuation.dataDate,
            financialThroughPeriod: deep.financialThroughPeriod,
            reactionDate: reaction.resolvedAsOf,
          },
        };
        return [candidate];
      },
    );
    candidates.sort(compareScreenCandidates);
    candidates.forEach((candidate, index) => {
      candidate.rank = index + 1;
    });

    const selectedReactionCodes = new Set(
      reactionSelected.map(({ company }) => company.code),
    );
    const completedReactionCodes = new Set(reactionByCode.keys());
    const notReactionScored = deepCompanies.flatMap((deep): ScreenCompactCompany[] => {
      if (completedReactionCodes.has(deep.company.code)) return [];
      const reasons: string[] = [];
      if (metricUnavailableCodes.has(deep.company.code)) {
        reasons.push("company_metrics_unavailable");
      }
      if (deep.companyQuality.status === "unknown") reasons.push("company_quality_unknown");
      if (deep.fundamentalImprovement.status === "unknown") reasons.push("fundamental_improvement_unknown");
      if (selectedReactionCodes.has(deep.company.code)) reasons.push("reaction_dependency_not_completed");
      else if (reasons.length === 0) reasons.push("bounded_reaction_limit");
      return [compact(deep.company, "reaction_selection", reasons)];
    });
    const notDeepScored = coarseCompanies
      .slice(DEEP_COMPANY_LIMIT)
      .map(({ company }) => compact(company, "deep_scoring", ["bounded_deep_limit"]));
    const policyExcluded = [
      ...financialCompanies.map((company) =>
        compact(company, "universe_filter", ["financial_company_not_supported"]),
      ),
      ...kyCompanies.map((company) =>
        compact(company, "universe_filter", ["ky_company_excluded_by_query"]),
      ),
    ];
    const allExcluded = [...policyExcluded, ...coarseExcluded];
    const financialThroughPeriods = [
      ...new Set(
        deepCompanies.flatMap((company) =>
          company.financialThroughPeriod ? [company.financialThroughPeriod] : [],
        ),
      ),
    ].sort();
    const reactionDates = reactionResult?.asOf.resolvedByMarket ?? [];
    const sources: ScreenSource[] = [
      ...master.sources.map(
        (source): ScreenSource => ({
          kind: "company_master",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.reportDate,
          asOfGranularity: "date",
        }),
      ),
      ...latestRevenue.sources.map(
        (source): ScreenSource => ({
          kind: "monthly_revenue_latest",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.dataMonth,
          asOfGranularity: "month",
        }),
      ),
      ...latestValuation.sources.map(
        (source): ScreenSource => ({
          kind: "valuation_latest",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.dataDate,
          asOfGranularity: "date",
        }),
      ),
      ...(revenueTrendResult?.sources ?? []).map(
        (source): ScreenSource => ({
          kind: "monthly_revenue_history",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.dataMonth,
          asOfGranularity: "month",
        }),
      ),
      ...(metricsResult?.sources ?? []).map(
        (source): ScreenSource => ({
          kind: "company_metrics",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: null,
          asOf:
            financialThroughPeriods.length === 1
              ? (financialThroughPeriods[0] as string)
              : "mixed",
          asOfGranularity:
            financialThroughPeriods.length === 1 ? "quarter" : "mixed",
        }),
      ),
      ...(reactionResult?.benchmarkSources ?? []).map(
        (source): ScreenSource => ({
          kind: "reaction_benchmark",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.dataMonth,
          asOfGranularity: "month",
        }),
      ),
      ...(reactionResult?.stockSources ?? []).map(
        (source): ScreenSource => ({
          kind: "reaction_stock",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.dataDate ?? source.dataMonth ?? "mixed",
          asOfGranularity: source.dataDate
            ? "date"
            : source.dataMonth
              ? "month"
              : "mixed",
        }),
      ),
      ...(reactionResult?.corporateActionSources ?? []).map(
        (source): ScreenSource => ({
          kind: "reaction_corporate_action",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: source.market,
          asOf: source.queryEnd,
          asOfGranularity: "date",
        }),
      ),
    ];
    const reactionScored = candidates.length;
    const bucketCounts = {
      research_candidate: candidates.filter((candidate) => candidate.bucket === "research_candidate").length,
      watchlist: candidates.filter((candidate) => candidate.bucket === "watchlist").length,
      insufficient_data: candidates.filter((candidate) => candidate.bucket === "insufficient_data").length,
      deprioritized: candidates.filter((candidate) => candidate.bucket === "deprioritized").length,
    };
    const deepEvidenceComplete = deepCompanies.length === 0 || deepCompanies.every(
      (company) =>
        company.companyQuality.status !== "unknown" &&
        company.fundamentalImprovement.status !== "unknown" &&
        company.reasonableValuation.status !== "unknown",
    );
    const reactionEvidenceComplete = reactionSelected.length === 0 ||
      (reactionScored === reactionSelected.length &&
        candidates.every(
          (candidate) => candidate.pillars.marketUnderreactionProxy.status !== "unknown",
        ));
    const warnings = [
      ...screenDefinition.limitations,
      "四柱是決策 gate；overallScore 只協助排序，不能抵銷任一柱的 fail 或 unknown。",
      "估值百分位採當次 accepted latest rowset 的 deterministic mid-rank；同產業有效樣本不足 20 筆時退回同市場，仍不是歷史估值分位。",
      "粗篩只用最新月營收成長與官方 trailing PE／PB／殖利率；不等於完整基本面評估。",
    ];
    if (notDeepScored.length > SUMMARY_LIMIT || notReactionScored.length > SUMMARY_LIMIT || allExcluded.length > SUMMARY_LIMIT) {
      warnings.push(
        `notDeepScored、notReactionScored 與 excluded 各最多回傳 ${SUMMARY_LIMIT} 筆摘要；完整數量見 summaryLimits 與 funnel。`,
      );
    }
    const failedDependencies = dependencyStatus.filter((item) => item.status === "failed");
    if (failedDependencies.length > 0) {
      warnings.push(
        "部分非粗篩 dependency 失敗；受影響公司沒有被當成已完成評估或自動遞補排名，請依 dependencyStatus 重試。",
      );
    }
    if ((metricsResult?.failures.length ?? 0) > 0) {
      warnings.push(
        "深篩財務資料的逐公司失敗已保留為 unknown／notReactionScored；沒有轉成 0、投資條件 fail，或阻斷其他公司的評估。",
      );
    }
    if (masterStale) {
      warnings.push(
        "公司母體 freshness=stale；本次仍保留 coarse/deep 原始證據，但所有四柱判定均不得形成 research_candidate，受影響公司以 source_stale_company_master 維持 unknown。",
      );
    }

    return {
      query,
      generatedAt: evaluationTime.toISOString(),
      timezone: "Asia/Taipei",
      screenDefinition,
      asOf: {
        selector: "latest",
        granularity: "mixed",
        masterReportDates: [...new Set(master.sources.map((source) => source.reportDate))].sort(),
        revenueMonth: latestRevenue.dataMonth,
        valuationDate: latestValuation.dataDate,
        financialThroughPeriods,
        reactionDates,
      },
      coverage: {
        selectionComplete: true,
        sourceComplete: sourceCompleteness(dependencyStatus),
        deepEvidenceComplete,
        reactionEvidenceComplete,
        missingCompanyCodes: [],
      },
      funnel: {
        currentMaster: master.companies.length,
        explicitlyRequested: query.companyCodes?.length ?? null,
        eligibleNonFinancial: eligibleCompanies.length,
        excludedFinancial: financialCompanies.length,
        excludedKy: kyCompanies.length,
        missingRequestedCodes: [],
        withLatestRevenue: eligibleCompanies.filter((company) => revenueByCode.has(company.code)).length,
        withLatestValuation: eligibleCompanies.filter((company) => valuationByCode.has(company.code)).length,
        coarseEligible: coarseCompanies.length,
        deepSelected: deepSelected.length,
        deepScored: deepCompanies.filter(
          (company) =>
            company.revenueTrend !== null &&
            company.financialThroughPeriod !== null,
        ).length,
        reactionSelected: reactionSelected.length,
        reactionScored,
        returned: candidates.length,
        buckets: bucketCounts,
      },
      workBudget: {
        coarseCompanies: eligibleCompanies.length,
        deepCompanyLimit: DEEP_COMPANY_LIMIT,
        deepCompaniesRequested: deepCodes.length,
        financialMetricCount: SCREEN_METRIC_ROLES.length,
        financialMetricComparisonUnits:
          deepCodes.length === 0
            ? 0
            : Math.ceil(deepCodes.length / 10) * SCREEN_METRIC_ROLES.length,
        revenueTrendMonths: 6,
        reactionCompanyLimit: REACTION_COMPANY_LIMIT,
        reactionCompaniesRequested: reactionSelected.length,
        reactionOfficialMonthUnits: reactionResult?.workBudget.consumed ?? 0,
        reactionOfficialMonthUnitLimit: 48,
        reactionCorporateActionRequests:
          reactionResult?.workBudget.corporateActionRequests ?? 0,
      },
      candidates,
      summaryLimits: {
        maximumPerList: SUMMARY_LIMIT,
        notDeepScoredTotal: notDeepScored.length,
        notReactionScoredTotal: notReactionScored.length,
        excludedTotal: allExcluded.length,
      },
      notDeepScored: notDeepScored.slice(0, SUMMARY_LIMIT),
      notReactionScored: notReactionScored.slice(0, SUMMARY_LIMIT),
      excluded: allExcluded.slice(0, SUMMARY_LIMIT),
      dependencyStatus,
      sources: uniqueSources(sources),
      warnings,
    };
  }
}

export const taiwanStockScreenClient = new TaiwanStockScreenClient();
