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
  type CompanyMetricsBatchResult,
} from "@/lib/mopsfin/batch";
import { mopsfinClient, type MopsfinClient } from "@/lib/mopsfin/client";
import { MOPSFIN_BASE_URL } from "@/lib/mopsfin/constants";
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
  buildMarketUnderreactionPillar,
  candidateOverallScore,
  classifyCandidate,
  evidenceCompleteness,
  nextDiligenceSteps,
  rejectionReasons,
} from "@/lib/screening/calculations";
import type {
  ScreenCandidateBucket,
  ScreenPillar,
} from "@/lib/screening/types";
import {
  valuationClient,
  type ValuationClient,
} from "@/lib/valuation/client";
import type { ValuationRow } from "@/lib/valuation/types";

import {
  buildFinancialCompanyQualityPillar,
  buildFinancialFundamentalImprovementPillar,
  buildFinancialReasonableValuationPillar,
  financialAnnualRoeEvidence,
  financialCoarseScore,
  financialProfitabilityThroughPeriod,
  financialValuationPeerContext,
  type FinancialValuationPeerObservation,
} from "./calculations";
import { buildFinancialInstitutionCoverageReport } from "./coverage";
import {
  CORE_INSTITUTION_METRIC_ROLES,
  FINANCIAL_SCREEN_DEFINITION,
  TAIWAN_FINANCIAL_SCREEN_DEFINITION,
  TAIWAN_FINANCIAL_SCREEN_PRESET,
} from "./definition";
import {
  financialInstitutionMetricsBatchClient,
  type FinancialInstitutionBatchCompany,
  type FinancialInstitutionBatchResult,
  type FinancialInstitutionMetricsBatchClient,
} from "./institution-batch";
import {
  resolveFinancialScreenMetricRoles,
  resolvedFinancialMetric,
  type FinancialScreenMetricCatalogResolution,
  type FinancialScreenMetricRole,
} from "./metric-roles";
import type {
  FinancialInstitutionMapping,
  FinancialScreenCandidate,
  FinancialScreenCompactCompany,
  FinancialScreenDependencyStatus,
  FinancialScreenSource,
  SupportedFinancialSector,
  TaiwanFinancialScreenQuery,
  TaiwanFinancialScreenResult,
} from "./types";

type CompanyMasterLike = Pick<CompanyMasterClient, "listCompanies">;
type RevenueLike = Pick<
  MonthlyRevenueClient,
  "getMonthlyRevenue" | "getMonthlyRevenueTrend"
>;
type ValuationLike = Pick<ValuationClient, "getDailyMarketValuation">;
type MetricsLike = Pick<CompanyMetricsBatchClient, "getCompanyMetricsBatch">;
type CatalogLike = Pick<MopsfinClient, "getCatalog">;
type InstitutionMetricsLike = Pick<
  FinancialInstitutionMetricsBatchClient,
  "getFinancialInstitutionMetricsBatch"
>;
type ReactionLike = Pick<ReactionClient, "getStockReactionSignals">;

interface FinancialScreenClientDependencies {
  companyMaster?: CompanyMasterLike;
  revenue?: RevenueLike;
  valuation?: ValuationLike;
  metrics?: MetricsLike;
  catalog?: CatalogLike;
  institutionMetrics?: InstitutionMetricsLike;
  reaction?: ReactionLike;
}

type MappedFinancialInstitution = FinancialInstitutionMapping & {
  status: "mapped";
  institutionCode: string;
  institutionName: string;
  sector: SupportedFinancialSector;
};

interface CoarseFinancialCompany {
  company: MasterCompany;
  mapping: MappedFinancialInstitution;
  revenue: MonthlyRevenueRow;
  valuation: ValuationRow;
  score: number;
}

interface DeepFinancialCompany extends CoarseFinancialCompany {
  profitability: CompanyMetricsBatchCompany | null;
  institution: FinancialInstitutionBatchCompany | null;
  revenueTrend: MonthlyRevenueTrendCompany | null;
  profitabilityThroughPeriod: string | null;
  capitalThroughPeriod: string | null;
  assetQualityThroughPeriod: string | null;
  companyQuality: ScreenPillar;
  fundamentalImprovement: ScreenPillar;
  reasonableValuation: ScreenPillar;
}

const PROFITABILITY_ROLES = ["roe", "net_profit", "eps"] as const;
const DEEP_COMPANY_LIMIT = 10 as const;
const REACTION_COMPANY_LIMIT = 5 as const;
const SUMMARY_LIMIT = 25 as const;

export function buildTaiwanFinancialScreenDefinition(
  metricResolution: FinancialScreenMetricCatalogResolution,
): TaiwanFinancialScreenResult["screenDefinition"] {
  return {
    id: TAIWAN_FINANCIAL_SCREEN_DEFINITION,
    preset: TAIWAN_FINANCIAL_SCREEN_PRESET,
    posture: "research_triage_not_recommendation",
    latestOnly: true,
    supportedSectors: [...FINANCIAL_SCREEN_DEFINITION.supportedSectors],
    scoreCompensationAcrossPillars: false,
    crossModelScoreComparable: false,
    pillarWeights: { ...FINANCIAL_SCREEN_DEFINITION.pillarWeights },
    stages: [
      {
        stage: "coarse",
        maximumCompanies: null,
        description:
          "以目前金融股母體、exact institution mapping、最新月營收與最新官方估值做低成本初篩。",
      },
      {
        stage: "deep",
        maximumCompanies: DEEP_COMPANY_LIMIT,
        description:
          "依粗篩排序只對前 10 家查六個月營收、ROE／稅後純益／EPS 與子業別核心金融機構指標。",
      },
      {
        stage: "reaction",
        maximumCompanies: REACTION_COMPANY_LIMIT,
        description:
          "依前三柱排序與 candidate_limit，最多對 5 家計算 5／20／60 個 sessions 的 price-index-compatible reaction proxy。",
      },
    ],
    coarseRanking: {
      eligibilityRules: [
        "必須是目前公司母體中的金融公司，且能以股票代號 exact mapping 到受支援金融子業別。",
        "必須有 latest 月營收列，且 latest YoY 或累計 YoY 至少一項可用。",
        "必須有 latest 官方估值列，且金融主要估值 P/B 為正且可用。",
      ],
      scoreComponents: [
        {
          code: "positive_latest_revenue_yoy",
          points: 30,
          rule: "latest revenue YoY > 0",
        },
        {
          code: "positive_cumulative_revenue_yoy",
          points: 20,
          rule: "cumulative revenue YoY > 0",
        },
        {
          code: "reasonable_absolute_pb",
          points: 25,
          rule: "0 < PB <= 5",
        },
        {
          code: "reasonable_absolute_pe",
          points: 15,
          rule: "0 < trailing PE <= 30",
        },
        {
          code: "dividend_yield_support",
          points: 10,
          rule: "dividend yield >= 2%",
        },
      ],
      tieBreak: [
        "coarse_score_desc",
        "latest_revenue_yoy_desc_null_last",
        "company_code_asc",
      ],
    },
    evidencePolicies: {
      profitabilityRoles: [...PROFITABILITY_ROLES],
      coreInstitutionMetricRoles: {
        holding: [...CORE_INSTITUTION_METRIC_ROLES.holding],
        bank: [...CORE_INSTITUTION_METRIC_ROLES.bank],
        bills: [...CORE_INSTITUTION_METRIC_ROLES.bills],
      },
      financialAlignment:
        FINANCIAL_SCREEN_DEFINITION.evidencePolicies.financialAlignment,
      valuationPeerScope: "same_financial_subtype_no_fallback",
      valuationPeerMinimum: 3,
      reactionPriceBasis:
        FINANCIAL_SCREEN_DEFINITION.evidencePolicies.reactionPriceBasis,
      metricResolution,
    },
    decisionPolicy: {
      researchCandidate: "四柱全部 pass 才是 research_candidate。",
      watchlist:
        "經營品質與基本面改善均 pass，但估值或市場反應 fail 且沒有 unknown 時列 watchlist。",
      insufficientData:
        "任一必要柱為 unknown 且沒有品質／改善硬性反證時列 insufficient_data。",
      deprioritized:
        "品質或改善有硬性反證、流動性低於門檻，或其餘完整證據不符條件時列 deprioritized。",
    },
    limitations: [...FINANCIAL_SCREEN_DEFINITION.limitations],
  };
}

function normalizeQuery(
  query: TaiwanFinancialScreenQuery,
): TaiwanFinancialScreenQuery {
  if (!( ["all", "listed", "otc"] as const).includes(query.market)) {
    throw new MopsfinError("INVALID_ARGUMENT", "market 必須是 all、listed 或 otc。");
  }
  if (query.preset !== TAIWAN_FINANCIAL_SCREEN_PRESET) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `preset 目前只支援 ${TAIWAN_FINANCIAL_SCREEN_PRESET}。`,
    );
  }
  if (
    !Number.isInteger(query.candidateLimit) ||
    query.candidateLimit < 1 ||
    query.candidateLimit > REACTION_COMPANY_LIMIT
  ) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "candidate_limit 必須是 1 至 5 的整數。",
    );
  }
  if (typeof query.includeKy !== "boolean") {
    throw new MopsfinError("INVALID_ARGUMENT", "include_ky 必須是 boolean。");
  }
  if (query.companyCodes === undefined) return { ...query };
  const companyCodes = query.companyCodes.map((code) => code.trim());
  if (companyCodes.length < 1 || companyCodes.length > 100) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "company_codes 必須包含 1 至 100 個代號。",
    );
  }
  if (companyCodes.some((code) => !/^\d{4}$/.test(code))) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "company_codes 必須全部是四碼公司股票代號。",
    );
  }
  if (new Set(companyCodes).size !== companyCodes.length) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 不得重複。");
  }
  return { ...query, companyCodes: [...companyCodes].sort() };
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
  else if (!validPositive(valuation.priceToBookRatio)) {
    reasons.push("financial_primary_pb_unavailable");
  }
  return reasons;
}

function errorMessage(error: unknown): string {
  const normalized = asMopsfinError(error);
  return `${normalized.code}: ${normalized.message}`;
}

function dependency(
  value: FinancialScreenDependencyStatus,
): FinancialScreenDependencyStatus {
  return value;
}

function compact(options: {
  company: MasterCompany;
  stage: FinancialScreenCompactCompany["stage"];
  reasonCodes: string[];
  mapping?: FinancialInstitutionMapping | null;
}): FinancialScreenCompactCompany {
  return {
    companyCode: options.company.code,
    companyName: options.company.shortName,
    stage: options.stage,
    mappingStatus: options.mapping?.status ?? null,
    financialSubtype: options.mapping?.sector ?? null,
    reasonCodes: options.reasonCodes,
  };
}

function isMapped(
  mapping: FinancialInstitutionMapping,
): mapping is MappedFinancialInstitution {
  return mapping.status === "mapped" &&
    mapping.institutionCode !== null &&
    mapping.institutionName !== null &&
    mapping.sector !== null;
}

function forceUnknownPillar(
  pillar: ScreenPillar,
  reasonCode: string,
): ScreenPillar {
  return {
    ...pillar,
    status: "unknown",
    score: null,
    knownWeight: 0,
    criteria: pillar.criteria.map((criterion) => ({
      ...criterion,
      status: "unknown",
      value: null,
      periods: [],
      reasonCodes: [reasonCode],
    })),
    hardFailReasons: [],
    evidenceGaps: pillar.criteria.map((criterion) => criterion.code),
  };
}

function preReactionComparator(
  left: DeepFinancialCompany,
  right: DeepFinancialCompany,
): number {
  const priority = (pillar: ScreenPillar) =>
    pillar.status === "pass" ? 0 : pillar.status === "fail" ? 1 : 2;
  for (
    const key of [
      "companyQuality",
      "fundamentalImprovement",
      "reasonableValuation",
    ] as const
  ) {
    const difference = priority(left[key]) - priority(right[key]);
    if (difference !== 0) return difference;
  }
  const knownAverage = (company: DeepFinancialCompany) => {
    const scores = [
      company.companyQuality.score,
      company.fundamentalImprovement.score,
      company.reasonableValuation.score,
    ].filter((value): value is number => value !== null);
    return scores.length === 0
      ? -Infinity
      : scores.reduce((sum, value) => sum + value, 0) / scores.length;
  };
  const leftAverage = knownAverage(left);
  const rightAverage = knownAverage(right);
  if (leftAverage !== rightAverage) return rightAverage - leftAverage;
  if (left.score !== right.score) return right.score - left.score;
  return left.company.code.localeCompare(right.company.code);
}

const BUCKET_PRIORITY: Record<ScreenCandidateBucket, number> = {
  research_candidate: 0,
  watchlist: 1,
  insufficient_data: 2,
  deprioritized: 3,
};

function compareCandidates(
  left: FinancialScreenCandidate,
  right: FinancialScreenCandidate,
): number {
  const bucketDifference =
    BUCKET_PRIORITY[left.bucket] - BUCKET_PRIORITY[right.bucket];
  if (bucketDifference !== 0) return bucketDifference;
  const leftScore = left.overallScore ?? -Infinity;
  const rightScore = right.overallScore ?? -Infinity;
  if (leftScore !== rightScore) return rightScore - leftScore;
  if (left.evidenceCompletenessPercent !== right.evidenceCompletenessPercent) {
    return right.evidenceCompletenessPercent - left.evidenceCompletenessPercent;
  }
  return left.companyCode.localeCompare(right.companyCode);
}

function uniqueSources(sources: FinancialScreenSource[]): FinancialScreenSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const identity = [
      source.kind,
      source.sourceUrl,
      source.retrievedAt,
      source.market ?? "all",
      source.asOf,
    ].join("|");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function sourceCompleteness(statuses: FinancialScreenDependencyStatus[]): boolean {
  return statuses
    .filter((status) => status.status !== "not_run")
    .every((status) => status.status === "complete");
}

function masterReportDate(
  company: MasterCompany,
  sources: Awaited<ReturnType<CompanyMasterLike["listCompanies"]>>["sources"],
): string {
  return sources.find((source) => source.market === company.market)?.reportDate ??
    "unknown";
}

function candidateEvidenceGaps(
  pillars: FinancialScreenCandidate["pillars"],
): string[] {
  return [
    ...new Set(
      Object.values(pillars).flatMap((pillar) => pillar.evidenceGaps),
    ),
  ];
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

function lastCriterionPeriod(
  pillar: ScreenPillar,
  criterionCodes: string[],
): string | null {
  const periods = pillar.criteria
    .filter((criterion) => criterionCodes.includes(criterion.code))
    .flatMap((criterion) => criterion.periods)
    .sort();
  return periods.at(-1) ?? null;
}

function institutionRolesFor(
  mappings: MappedFinancialInstitution[],
): FinancialScreenMetricRole[] {
  const sectors = new Set(mappings.map((mapping) => mapping.sector));
  return (["holding", "bank", "bills"] as const).flatMap((sector) =>
    sectors.has(sector) ? [...CORE_INSTITUTION_METRIC_ROLES[sector]] : [],
  );
}

function financialCatalogContractMismatch(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason: "FINANCIAL_CATALOG_CONTRACT_MISMATCH",
    retryable: false,
    action: "none",
    details,
  });
}

function assertProfitabilityBatchContract(
  result: CompanyMetricsBatchResult,
  resolution: FinancialScreenMetricCatalogResolution,
): void {
  const expected = PROFITABILITY_ROLES.map((role) =>
    resolvedFinancialMetric(resolution, role),
  );
  const requestedCodes = [...result.query.metricCodes].sort();
  const expectedCodes = expected.map((metric) => metric.metricCode).sort();
  const definitionsByCode = new Map(
    result.metricDefinitions.map((definition) => [definition.code, definition]),
  );
  const issues: Array<Record<string, unknown>> = [];
  if (JSON.stringify(requestedCodes) !== JSON.stringify(expectedCodes)) {
    issues.push({
      kind: "profitability_batch_query_mismatch",
      requestedCodes,
      expectedCodes,
    });
  }
  for (const metric of expected) {
    const definition = definitionsByCode.get(metric.metricCode);
    if (
      !definition ||
      definition.name !== metric.metricName ||
      definition.unit !== metric.unit ||
      definition.category !== metric.category
    ) {
      issues.push({
        kind: "profitability_metric_definition_mismatch",
        role: metric.role,
        expected: {
          code: metric.metricCode,
          name: metric.metricName,
          unit: metric.unit,
          category: metric.category,
        },
        actual: definition ?? null,
      });
    }
  }
  if (issues.length > 0) {
    financialCatalogContractMismatch(
      "fulfilled profitability batch 不符合本次金融 screening catalog resolution。",
      {
        catalogSnapshotId: resolution.catalogSnapshotId,
        issues,
      },
    );
  }
}

function assertInstitutionBatchContract(
  result: FinancialInstitutionBatchResult,
  resolution: FinancialScreenMetricCatalogResolution,
  expectedRoles: FinancialScreenMetricRole[],
): void {
  const expected = expectedRoles.map((role) =>
    resolvedFinancialMetric(resolution, role),
  );
  const actualByRole = new Map(
    result.metricDefinitions.map((definition) => [definition.role, definition]),
  );
  const issues: Array<Record<string, unknown>> = [];
  if (result.catalogSnapshotId !== resolution.catalogSnapshotId) {
    issues.push({
      kind: "institution_batch_catalog_snapshot_mismatch",
      expectedCatalogSnapshotId: resolution.catalogSnapshotId,
      actualCatalogSnapshotId: result.catalogSnapshotId,
    });
  }
  const actualRoles = [...result.query.metricRoles].sort();
  const sortedExpectedRoles = [...expectedRoles].sort();
  if (JSON.stringify(actualRoles) !== JSON.stringify(sortedExpectedRoles)) {
    issues.push({
      kind: "institution_batch_query_mismatch",
      expectedRoles: sortedExpectedRoles,
      actualRoles,
    });
  }
  for (const metric of expected) {
    const definition = actualByRole.get(metric.role);
    if (
      !definition ||
      definition.metricCode !== metric.metricCode ||
      definition.metricName !== metric.metricName ||
      definition.unit !== metric.unit ||
      definition.family !== metric.family
    ) {
      issues.push({
        kind: "institution_metric_definition_mismatch",
        role: metric.role,
        expected: metric,
        actual: definition ?? null,
      });
    }
  }
  if (issues.length > 0) {
    financialCatalogContractMismatch(
      "fulfilled financial-institution batch 不符合本次金融 screening catalog resolution。",
      {
        catalogSnapshotId: resolution.catalogSnapshotId,
        issues,
      },
    );
  }
}

function throwIfCatalogRace(error: unknown): void {
  const normalized = asMopsfinError(error);
  if (normalized.code === "NOT_FOUND") {
    financialCatalogContractMismatch(
      "金融 screening catalog resolution 與批次查詢期間的即時目錄不一致。",
      {
        upstreamCode: normalized.code,
        upstreamReason: normalized.reason,
        upstreamMessage: normalized.message,
      },
    );
  }
}

export class TaiwanFinancialScreenClient {
  private readonly companyMaster: CompanyMasterLike;
  private readonly revenue: RevenueLike;
  private readonly valuation: ValuationLike;
  private readonly metrics: MetricsLike;
  private readonly catalog: CatalogLike;
  private readonly institutionMetrics: InstitutionMetricsLike;
  private readonly reaction: ReactionLike;

  constructor(
    dependencies: FinancialScreenClientDependencies = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.companyMaster = dependencies.companyMaster ?? companyMasterClient;
    this.revenue = dependencies.revenue ?? monthlyRevenueClient;
    this.valuation = dependencies.valuation ?? valuationClient;
    this.metrics = dependencies.metrics ?? companyMetricsBatchClient;
    this.catalog = dependencies.catalog ?? mopsfinClient;
    this.institutionMetrics =
      dependencies.institutionMetrics ?? financialInstitutionMetricsBatchClient;
    this.reaction = dependencies.reaction ?? reactionClient;
  }

  async screenTaiwanFinancialCandidates(
    rawQuery: TaiwanFinancialScreenQuery,
  ): Promise<TaiwanFinancialScreenResult> {
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
    const metricResolution = resolveFinancialScreenMetricRoles(catalog);
    const screenDefinition = buildTaiwanFinancialScreenDefinition(metricResolution);
    const mappingCoverage = buildFinancialInstitutionCoverageReport(
      master.companies,
      catalog,
    );
    const masterByCode = new Map(
      master.companies.map((company) => [company.code, company]),
    );
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
    const nonFinancialCompanies = selectedBase.filter(
      (company) => !company.isFinancial,
    );
    const selectedFinancial = selectedBase.filter(
      (company) => company.isFinancial,
    );
    const kyCompanies = query.includeKy
      ? []
      : selectedFinancial.filter((company) => company.isKy);
    const eligibleFinancial = selectedFinancial.filter(
      (company) => query.includeKy || !company.isKy,
    );
    const mappingByCode = new Map(
      mappingCoverage.mappings.map((mapping) => [mapping.companyCode, mapping]),
    );
    const selectedMappings = eligibleFinancial.map(
      (company) => mappingByCode.get(company.code) as FinancialInstitutionMapping,
    );
    const mappedMappings = selectedMappings.filter(isMapped);
    const unmappedMappings = selectedMappings.filter(
      (mapping) => mapping.status === "institution_not_found",
    );
    const unsafeMappings = selectedMappings.filter(
      (mapping) =>
        mapping.status !== "mapped" && mapping.status !== "institution_not_found",
    );
    const mappedCompanyByCode = new Map(
      eligibleFinancial.map((company) => [company.code, company]),
    );
    const mappedCompanies = mappedMappings.map(
      (mapping) => mappedCompanyByCode.get(mapping.companyCode) as MasterCompany,
    );

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
    const revenueByCode = new Map(
      latestRevenue.rows.map((row) => [row.code, row]),
    );
    const valuationByCode = new Map(
      latestValuation.rows.map((row) => [row.code, row]),
    );
    const coarseExcluded: FinancialScreenCompactCompany[] = [];
    const coarseCompanies: CoarseFinancialCompany[] = [];
    for (const mapping of mappedMappings) {
      const company = mappedCompanyByCode.get(mapping.companyCode) as MasterCompany;
      const revenue = revenueByCode.get(company.code);
      const valuation = valuationByCode.get(company.code);
      const reasons = coarseEligibilityReasons(revenue, valuation);
      if (reasons.length > 0) {
        coarseExcluded.push(
          compact({
            company,
            stage: "coarse_filter",
            reasonCodes: reasons,
            mapping,
          }),
        );
        continue;
      }
      const revenueRow = revenue as MonthlyRevenueRow;
      const valuationRow = valuation as ValuationRow;
      coarseCompanies.push({
        company,
        mapping,
        revenue: revenueRow,
        valuation: valuationRow,
        score: financialCoarseScore(
          revenueRow.yoyPercent,
          revenueRow.cumulativeYoyPercent,
          valuationRow,
        ),
      });
    }
    coarseCompanies.sort(
      (left, right) =>
        right.score - left.score ||
        (right.revenue.yoyPercent ?? -Infinity) -
          (left.revenue.yoyPercent ?? -Infinity) ||
        left.company.code.localeCompare(right.company.code),
    );
    const deepSelected = coarseCompanies.slice(0, DEEP_COMPANY_LIMIT);
    const deepCodes = deepSelected.map(({ company }) => company.code);
    const deepMappings = deepSelected.map(({ mapping }) => mapping);
    const profitabilityMetricCodes = PROFITABILITY_ROLES.map(
      (role) => resolvedFinancialMetric(metricResolution, role).metricCode,
    );
    const institutionMetricRoles = institutionRolesFor(deepMappings);
    const selectedMappingIssues = [...unmappedMappings, ...unsafeMappings];
    const dependencyStatus: FinancialScreenDependencyStatus[] = [
      dependency({
        stage: "coarse",
        dependency: "company_master",
        status: "partial",
        affectedCompanyCodes: masterStale
          ? mappedCompanies.map((company) => company.code)
          : [],
        message: masterStale
          ? "目前公司母體 reportDate 已超過 7 日 freshness window；金融四柱 fail closed 為 unknown。"
          : "必要來源與 heuristic gate 均通過，但官方沒有 declared row count，不能證明完整 rowset。",
      }),
      dependency({
        stage: "coarse",
        dependency: "catalog_mapping",
        status: selectedMappingIssues.length === 0 ? "complete" : "partial",
        affectedCompanyCodes: selectedMappingIssues.map(
          (mapping) => mapping.companyCode,
        ),
        message:
          selectedMappingIssues.length === 0
            ? null
            : "部分金融股無法以股票代號 exact mapping 並獨立核對名稱與受支援子業別；未使用名稱或模糊 fallback。",
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
        affectedCompanyCodes: latestRevenue.missingCompanyCodes.filter((code) =>
          mappedCompanyByCode.has(code),
        ),
        message:
          latestRevenue.coverageComplete && latestRevenue.selectionComplete
            ? null
            : "月營收來源或 requested selection 並非完全 verified；缺列公司不進入粗篩。",
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
        affectedCompanyCodes: latestValuation.missingCompanyCodes.filter((code) =>
          mappedCompanyByCode.has(code),
        ),
        message:
          latestValuation.coverageComplete &&
            latestValuation.universeCoverageVerified &&
            latestValuation.selectionComplete
            ? null
            : "估值來源或目前公司母體 reconciliation 並非完全 verified；缺列公司不進入粗篩。",
      }),
    ];

    let revenueTrendResult: MonthlyRevenueTrendResult | null = null;
    let profitabilityResult: Awaited<
      ReturnType<MetricsLike["getCompanyMetricsBatch"]>
    > | null = null;
    let institutionResult: FinancialInstitutionBatchResult | null = null;
    if (deepCodes.length > 0) {
      const [trendSettled, profitabilitySettled, institutionSettled] =
        await Promise.allSettled([
          this.revenue.getMonthlyRevenueTrend({
            market: query.market,
            companyCodes: deepCodes,
            endMonth: "latest",
            lookbackMonths: 6,
            universePolicy: "compatible",
          }),
          this.metrics.getCompanyMetricsBatch({
            companyCodes: deepCodes,
            metricCodes: profitabilityMetricCodes,
            basis: "quarterly",
          }),
          this.institutionMetrics.getFinancialInstitutionMetricsBatch({
            mappings: deepMappings,
            metricRoles: institutionMetricRoles,
            resolution: metricResolution,
          }),
        ]);

      if (trendSettled.status === "fulfilled") {
        revenueTrendResult = trendSettled.value;
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "monthly_revenue_trend",
            status:
              trendSettled.value.selectionComplete &&
              trendSettled.value.coverageComplete
                ? "complete"
                : "partial",
            affectedCompanyCodes: trendSettled.value.missingCompanyCodes,
            message:
              trendSettled.value.selectionComplete &&
                trendSettled.value.coverageComplete
                ? null
                : "部分六個月營收趨勢缺列或來源 coverage 不完整；缺少證據維持 unknown。",
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

      if (profitabilitySettled.status === "fulfilled") {
        assertProfitabilityBatchContract(
          profitabilitySettled.value,
          metricResolution,
        );
        profitabilityResult = profitabilitySettled.value;
        const affectedCompanyCodes = [
          ...new Set([
            ...profitabilitySettled.value.coverage.missingCompanyCodes,
            ...profitabilitySettled.value.coverage.noValidDataCompanyCodes,
            ...profitabilitySettled.value.coverage.unavailableCompanyCodes,
          ]),
        ];
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "profitability_metrics_batch",
            status: profitabilitySettled.value.coverage.selectionComplete
              ? "complete"
              : "partial",
            affectedCompanyCodes,
            message:
              profitabilitySettled.value.coverage.selectionComplete
                ? null
                : "部分 ROE／稅後純益／EPS evidence unavailable；缺值保留 unknown，不轉成 0 或 fail。",
          }),
        );
      } else {
        throwIfCatalogRace(profitabilitySettled.reason);
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "profitability_metrics_batch",
            status: "failed",
            affectedCompanyCodes: deepCodes,
            message: errorMessage(profitabilitySettled.reason),
          }),
        );
      }

      if (institutionSettled.status === "fulfilled") {
        assertInstitutionBatchContract(
          institutionSettled.value,
          metricResolution,
          institutionMetricRoles,
        );
        institutionResult = institutionSettled.value;
        const affectedCompanyCodes = [
          ...new Set([
            ...institutionSettled.value.coverage.unavailableCompanyCodes,
            ...institutionSettled.value.coverage.noValidDataCompanyCodes,
          ]),
        ];
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "financial_institution_metrics_batch",
            status: institutionSettled.value.coverage.selectionComplete
              ? "complete"
              : "partial",
            affectedCompanyCodes,
            message:
              institutionSettled.value.coverage.selectionComplete
                ? null
                : institutionSettled.value.coverage.failureIsolationComplete
                  ? "部分子業別核心金融指標 unavailable；失敗已隔離且缺值維持 unknown。"
                  : "部分金融指標錯誤只能歸因到共享 metric×chunk；受影響公司維持 unknown。",
          }),
        );
      } else {
        throwIfCatalogRace(institutionSettled.reason);
        dependencyStatus.push(
          dependency({
            stage: "deep",
            dependency: "financial_institution_metrics_batch",
            status: "failed",
            affectedCompanyCodes: deepCodes,
            message: errorMessage(institutionSettled.reason),
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
          message: "粗篩沒有可進入深度評估的 mapped 金融公司。",
        }),
        dependency({
          stage: "deep",
          dependency: "profitability_metrics_batch",
          status: "not_run",
          affectedCompanyCodes: [],
          message: "粗篩沒有可進入深度評估的 mapped 金融公司。",
        }),
        dependency({
          stage: "deep",
          dependency: "financial_institution_metrics_batch",
          status: "not_run",
          affectedCompanyCodes: [],
          message: "粗篩沒有可進入深度評估的 mapped 金融公司。",
        }),
      );
    }

    const trendByCode = new Map(
      (revenueTrendResult?.companies ?? []).map((company) => [
        company.code,
        company,
      ]),
    );
    const profitabilityByCode = new Map(
      (profitabilityResult?.companies ?? []).map((company) => [
        company.companyCode,
        company,
      ]),
    );
    const institutionByCode = new Map(
      (institutionResult?.companies ?? []).map((company) => [
        company.companyCode,
        company,
      ]),
    );
    const peerObservations: FinancialValuationPeerObservation[] =
      mappingCoverage.mappings.flatMap((mapping) => {
        if (!isMapped(mapping)) return [];
        const company = masterByCode.get(mapping.companyCode);
        const valuation = valuationByCode.get(mapping.companyCode);
        if (!company || !valuation || (!query.includeKy && company.isKy)) return [];
        return [
          {
            companyCode: mapping.companyCode,
            sector: mapping.sector,
            peRatio: valuation.peRatio,
            priceToBookRatio: valuation.priceToBookRatio,
            dividendYieldPercent: valuation.dividendYieldPercent,
          },
        ];
      });
    const deepCompanies: DeepFinancialCompany[] = deepSelected.map((coarse) => {
      const profitability = profitabilityByCode.get(coarse.company.code) ?? null;
      const institution = institutionByCode.get(coarse.company.code) ?? null;
      const revenueTrend = trendByCode.get(coarse.company.code) ?? null;
      const profitabilityThroughPeriod =
        financialProfitabilityThroughPeriod(profitability, metricResolution);
      const computedCompanyQuality = buildFinancialCompanyQualityPillar({
        sector: coarse.mapping.sector,
        profitability,
        institution,
        profitabilityThroughPeriod,
        resolution: metricResolution,
      });
      const computedFundamentalImprovement =
        buildFinancialFundamentalImprovementPillar({
          sector: coarse.mapping.sector,
          profitability,
          institution,
          revenueTrend,
          profitabilityThroughPeriod,
          resolution: metricResolution,
        });
      const annualRoeEvidence = financialAnnualRoeEvidence(
        profitability,
        profitabilityThroughPeriod,
        metricResolution,
      );
      const peerContext = financialValuationPeerContext({
        subjectCode: coarse.company.code,
        sector: coarse.mapping.sector,
        valuation: coarse.valuation,
        peers: peerObservations,
      });
      const computedReasonableValuation =
        buildFinancialReasonableValuationPillar({
          valuation: coarse.valuation,
          annualRoeEvidence,
          peers: peerContext,
          valuationDate: latestValuation.dataDate,
        });
      const companyQuality = masterStale
        ? forceUnknownPillar(
            computedCompanyQuality,
            "source_stale_company_master",
          )
        : computedCompanyQuality;
      const fundamentalImprovement = masterStale
        ? forceUnknownPillar(
            computedFundamentalImprovement,
            "source_stale_company_master",
          )
        : computedFundamentalImprovement;
      const reasonableValuation = masterStale
        ? forceUnknownPillar(
            computedReasonableValuation,
            "source_stale_company_master",
          )
        : computedReasonableValuation;
      const capitalThroughPeriod = lastCriterionPeriod(companyQuality, [
        "capital_adequacy_vs_industry",
        "bank_capital_adequacy_vs_industry",
      ]);
      const assetQualityThroughPeriod =
        coarse.mapping.sector === "bank"
          ? lastCriterionPeriod(companyQuality, [
              "loan_overdue_ratio_vs_industry",
              "loan_loss_coverage_vs_industry",
            ])
          : null;
      return {
        ...coarse,
        profitability,
        institution,
        revenueTrend,
        profitabilityThroughPeriod,
        capitalThroughPeriod,
        assetQualityThroughPeriod,
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
        const affectedCompanyCodes = reactionSelected
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
            affectedCompanyCodes,
            message:
              affectedCompanyCodes.length === 0
                ? null
                : "部分 exact-session OHLC 或公司行動證據缺值／不可比較；第四柱維持 unknown。",
          }),
        );
      } catch (error) {
        dependencyStatus.push(
          dependency({
            stage: "reaction",
            dependency: "stock_reaction_signals",
            status: "failed",
            affectedCompanyCodes: reactionSelected.map(
              ({ company }) => company.code,
            ),
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
              : "沒有經營品質與基本面改善均可判讀的公司可進入 reaction 階段。",
        }),
      );
    }

    const deepByCode = new Map(
      deepCompanies.map((company) => [company.company.code, company]),
    );
    const reactionByCode = new Map(
      (reactionResult?.companies ?? []).map((company) => [
        company.companyCode,
        company,
      ]),
    );
    const candidates = (reactionResult?.companies ?? []).flatMap(
      (reaction): FinancialScreenCandidate[] => {
        const deep = deepByCode.get(reaction.companyCode);
        if (!deep) return [];
        const marketUnderreactionProxy = buildMarketUnderreactionPillar(reaction);
        const pillars: FinancialScreenCandidate["pillars"] = {
          companyQuality: deep.companyQuality,
          fundamentalImprovement: deep.fundamentalImprovement,
          reasonableValuation: deep.reasonableValuation,
          marketUnderreactionProxy,
        };
        return [
          {
            rank: 0,
            companyCode: deep.company.code,
            companyName: deep.company.name,
            shortName: deep.company.shortName,
            market: deep.company.market,
            listingDate: deep.company.listingDate,
            isKy: deep.company.isKy,
            financialSubtype: deep.mapping.sector,
            institutionCode: deep.mapping.institutionCode,
            institutionName: deep.mapping.institutionName,
            modelId: TAIWAN_FINANCIAL_SCREEN_DEFINITION,
            preset: TAIWAN_FINANCIAL_SCREEN_PRESET,
            scoreComparisonScope: "within_financial_model_only",
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
              profitabilityThroughPeriod: deep.profitabilityThroughPeriod,
              capitalThroughPeriod: deep.capitalThroughPeriod,
              assetQualityThroughPeriod: deep.assetQualityThroughPeriod,
              reactionDate: reaction.resolvedAsOf,
            },
          },
        ];
      },
    );
    candidates.sort(compareCandidates);
    candidates.forEach((candidate, index) => {
      candidate.rank = index + 1;
    });

    const profitabilityUnavailableCodes = new Set(
      profitabilityResult?.coverage.unavailableCompanyCodes ?? [],
    );
    const institutionUnavailableCodes = new Set(
      institutionResult?.coverage.unavailableCompanyCodes ?? [],
    );
    const selectedReactionCodes = new Set(
      reactionSelected.map(({ company }) => company.code),
    );
    const completedReactionCodes = new Set(reactionByCode.keys());
    const notReactionScored = deepCompanies.flatMap(
      (deep): FinancialScreenCompactCompany[] => {
        if (completedReactionCodes.has(deep.company.code)) return [];
        const reasons: string[] = [];
        if (!deep.revenueTrend) reasons.push("monthly_revenue_trend_unavailable");
        if (profitabilityUnavailableCodes.has(deep.company.code)) {
          reasons.push("profitability_metrics_unavailable");
        }
        if (institutionUnavailableCodes.has(deep.company.code)) {
          reasons.push("financial_institution_metrics_unavailable");
        }
        if (deep.companyQuality.status === "unknown") {
          reasons.push("company_quality_unknown");
        }
        if (deep.fundamentalImprovement.status === "unknown") {
          reasons.push("fundamental_improvement_unknown");
        }
        if (selectedReactionCodes.has(deep.company.code)) {
          reasons.push("reaction_dependency_not_completed");
        } else if (reasons.length === 0) {
          reasons.push("bounded_reaction_limit");
        }
        return [
          compact({
            company: deep.company,
            stage: "reaction_selection",
            reasonCodes: reasons,
            mapping: deep.mapping,
          }),
        ];
      },
    );
    const notDeepScored = coarseCompanies
      .slice(DEEP_COMPANY_LIMIT)
      .map(({ company, mapping }) =>
        compact({
          company,
          stage: "deep_scoring",
          reasonCodes: ["bounded_deep_limit"],
          mapping,
        }),
      );
    const policyExcluded: FinancialScreenCompactCompany[] = [
      ...nonFinancialCompanies.map((company) =>
        compact({
          company,
          stage: "universe_filter",
          reasonCodes: ["non_financial_company_not_supported"],
        }),
      ),
      ...kyCompanies.map((company) =>
        compact({
          company,
          stage: "universe_filter",
          reasonCodes: ["ky_company_excluded_by_query"],
          mapping: mappingByCode.get(company.code) ?? null,
        }),
      ),
      ...selectedMappingIssues.map((mapping) =>
        compact({
          company: mappedCompanyByCode.get(mapping.companyCode) as MasterCompany,
          stage: "mapping",
          reasonCodes: mapping.reasonCodes,
          mapping,
        }),
      ),
    ];
    const allExcluded = [...policyExcluded, ...coarseExcluded];
    const profitabilityThroughPeriods = [
      ...new Set(
        deepCompanies.flatMap((company) =>
          company.profitabilityThroughPeriod
            ? [company.profitabilityThroughPeriod]
            : [],
        ),
      ),
    ].sort();
    const capitalThroughPeriods = [
      ...new Set(
        deepCompanies.flatMap((company) =>
          company.capitalThroughPeriod ? [company.capitalThroughPeriod] : [],
        ),
      ),
    ].sort();
    const assetQualityThroughPeriods = [
      ...new Set(
        deepCompanies.flatMap((company) =>
          company.assetQualityThroughPeriod
            ? [company.assetQualityThroughPeriod]
            : [],
        ),
      ),
    ].sort();
    const reactionDates = reactionResult?.asOf.resolvedByMarket ?? [];
    const sources: FinancialScreenSource[] = [
      ...master.sources.map(
        (source): FinancialScreenSource => ({
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
      {
        kind: "catalog",
        sourceName: "Mopsfin 即時目錄",
        sourceUrl: MOPSFIN_BASE_URL,
        retrievedAt: catalog.retrievedAt ?? catalog.discoveredAt,
        ...(catalog.cache ? { cache: catalog.cache } : {}),
        market: null,
        asOf: catalog.discoveredAt,
        asOfGranularity: "mixed",
      },
      ...latestRevenue.sources.map(
        (source): FinancialScreenSource => ({
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
        (source): FinancialScreenSource => ({
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
        (source): FinancialScreenSource => ({
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
      ...(profitabilityResult?.sources ?? []).map(
        (source): FinancialScreenSource => ({
          kind: "profitability_metrics",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: null,
          asOf:
            profitabilityThroughPeriods.length === 1
              ? (profitabilityThroughPeriods[0] as string)
              : "mixed",
          asOfGranularity:
            profitabilityThroughPeriods.length === 1 ? "quarter" : "mixed",
        }),
      ),
      ...(institutionResult?.sources ?? []).map(
        (source): FinancialScreenSource => ({
          kind: "financial_institution_metrics",
          sourceName: source.sourceName,
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          ...(source.cache ? { cache: source.cache } : {}),
          market: null,
          asOf:
            capitalThroughPeriods.length === 1 &&
              assetQualityThroughPeriods.length <= 1
              ? (capitalThroughPeriods[0] as string)
              : "mixed",
          asOfGranularity: "mixed",
        }),
      ),
      ...(reactionResult?.benchmarkSources ?? []).map(
        (source): FinancialScreenSource => ({
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
        (source): FinancialScreenSource => ({
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
        (source): FinancialScreenSource => ({
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

    const bucketCounts: Record<ScreenCandidateBucket, number> = {
      research_candidate: candidates.filter(
        (candidate) => candidate.bucket === "research_candidate",
      ).length,
      watchlist: candidates.filter(
        (candidate) => candidate.bucket === "watchlist",
      ).length,
      insufficient_data: candidates.filter(
        (candidate) => candidate.bucket === "insufficient_data",
      ).length,
      deprioritized: candidates.filter(
        (candidate) => candidate.bucket === "deprioritized",
      ).length,
    };
    const deepScored = deepCompanies.filter(
      (company) =>
        company.companyQuality.status !== "unknown" &&
        company.fundamentalImprovement.status !== "unknown" &&
        company.reasonableValuation.status !== "unknown",
    ).length;
    const deepEvidenceComplete =
      deepCompanies.length === 0 ||
      deepCompanies.every(
        (company) =>
          company.companyQuality.status !== "unknown" &&
          company.fundamentalImprovement.status !== "unknown" &&
          company.reasonableValuation.status !== "unknown",
      );
    const reactionEvidenceComplete =
      reactionSelected.length === 0 ||
      (candidates.length === reactionSelected.length &&
        candidates.every(
          (candidate) =>
            candidate.pillars.marketUnderreactionProxy.status !== "unknown",
        ));
    const warnings = [
      ...screenDefinition.limitations,
      "四柱是決策 gate；overallScore 只協助金融模型內排序，不能抵銷任一柱的 fail 或 unknown，也不得與非金融模型 raw score 比較。",
      "金融估值百分位只使用本次 exact mapped 的同金融子業別有效 rowset；不足 3 筆時維持 unknown，不退回全金融或全市場。",
      "粗篩只用最新月營收成長與官方 trailing PB／PE／殖利率；不等於完整金融基本面評估。",
    ];
    if (
      notDeepScored.length > SUMMARY_LIMIT ||
      notReactionScored.length > SUMMARY_LIMIT ||
      allExcluded.length > SUMMARY_LIMIT
    ) {
      warnings.push(
        `notDeepScored、notReactionScored 與 excluded 各最多回傳 ${SUMMARY_LIMIT} 筆摘要；完整數量見 summaryLimits 與 funnel。`,
      );
    }
    if (dependencyStatus.some((status) => status.status === "failed")) {
      warnings.push(
        "部分 deep／reaction dependency 失敗；受影響證據維持 unknown，沒有轉成 0、fail 或自動遞補排名。",
      );
    }
    if (
      (profitabilityResult?.failures.length ?? 0) > 0 ||
      (institutionResult?.failures.length ?? 0) > 0
    ) {
      warnings.push(
        "批次財務失敗依可歸因範圍保留為 unknown；其他公司的成功 evidence 不受影響。",
      );
    }
    if (masterStale) {
      warnings.push(
        "公司母體 freshness=stale；粗篩證據保留，但金融四柱以 source_stale_company_master fail closed 為 unknown。",
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
        masterReportDates: [
          ...new Set(master.sources.map((source) => source.reportDate)),
        ].sort(),
        revenueMonth: latestRevenue.dataMonth,
        valuationDate: latestValuation.dataDate,
        profitabilityThroughPeriods,
        capitalThroughPeriods,
        assetQualityThroughPeriods,
        reactionDates,
      },
      coverage: {
        selectionComplete: true,
        sourceComplete: sourceCompleteness(dependencyStatus),
        mappingComplete: selectedMappingIssues.length === 0,
        deepEvidenceComplete,
        reactionEvidenceComplete,
        missingCompanyCodes: [],
      },
      funnel: {
        currentMaster: master.companies.length,
        explicitlyRequested: query.companyCodes?.length ?? null,
        selectedFinancial: eligibleFinancial.length,
        mappedSupported: mappedMappings.length,
        excludedNonFinancial: nonFinancialCompanies.length,
        excludedKy: kyCompanies.length,
        institutionNotFound: unmappedMappings.length,
        mappingUnsafe: unsafeMappings.length,
        coarseEligible: coarseCompanies.length,
        deepSelected: deepSelected.length,
        deepScored,
        reactionSelected: reactionSelected.length,
        reactionScored: candidates.length,
        returned: candidates.length,
        buckets: bucketCounts,
      },
      workBudget: {
        coarseCompanies: mappedCompanies.length,
        deepCompanyLimit: DEEP_COMPANY_LIMIT,
        deepCompaniesRequested: deepCodes.length,
        profitabilityMetricCount: PROFITABILITY_ROLES.length,
        profitabilityComparisonUnits:
          deepCodes.length === 0
            ? 0
            : Math.ceil(deepCodes.length / 10) * PROFITABILITY_ROLES.length,
        institutionComparisonUnits:
          institutionResult?.workBudget.comparisonPlanUnits ?? 0,
        institutionIsolationUnits:
          institutionResult?.workBudget.isolationRetryUnits ?? 0,
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
      mappingCoverage,
      sources: uniqueSources(sources),
      warnings,
    };
  }
}

export const taiwanFinancialScreenClient = new TaiwanFinancialScreenClient();
