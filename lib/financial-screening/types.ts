import type { CompanyMarket } from "@/lib/company-master/types";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import type {
  ScreenCandidateBucket,
  ScreenPillar,
} from "@/lib/screening/types";

import type {
  FinancialScreenMetricCatalogResolution,
  FinancialScreenMetricRole,
} from "./metric-roles";

export type SupportedFinancialSector = "holding" | "bank" | "bills";

export type FinancialInstitutionMappingStatus =
  | "mapped"
  | "institution_not_found"
  | "duplicate_institution_code"
  | "unsupported_institution_sector"
  | "identity_mismatch";

export interface FinancialInstitutionMapping {
  companyCode: string;
  companyName: string;
  companyShortName: string;
  market: CompanyMarket;
  status: FinancialInstitutionMappingStatus;
  institutionCode: string | null;
  institutionName: string | null;
  sector: SupportedFinancialSector | null;
  matchBasis: "exact_company_code" | null;
  identityMatch: "company_name" | "company_short_name" | "mismatch" | null;
  reasonCodes: string[];
  catalogCandidates: Array<{
    code: string;
    name: string;
    sector: SupportedFinancialSector | "unknown";
  }>;
}

export interface FinancialInstitutionCoverageReport {
  mappingContractVersion: "financial_institution_mapping.v1";
  scope: "current_listed_otc_financial_companies";
  catalogDiscoveredAt: string;
  catalogSnapshotId: string;
  snapshotId: string;
  coverageComplete: boolean;
  counts: {
    financialCompanies: number;
    mapped: number;
    institutionNotFound: number;
    duplicateInstitutionCode: number;
    unsupportedInstitutionSector: number;
    identityMismatch: number;
    catalogInstitutions: number;
    catalogOnlyInstitutions: number;
    bySupportedSector: Record<SupportedFinancialSector, number>;
  };
  mappings: FinancialInstitutionMapping[];
  catalogOnlyInstitutions: Array<{
    code: string;
    name: string;
    sector: SupportedFinancialSector | "unknown";
  }>;
  reconciliation: {
    everyFinancialCompanyClassified: boolean;
    oneToOneMappingVerified: boolean;
    countsReconcile: boolean;
  };
  warnings: string[];
}

export interface TaiwanFinancialScreenQuery {
  market: "all" | "listed" | "otc";
  companyCodes?: string[];
  includeKy: boolean;
  candidateLimit: number;
  preset: "balanced_financial_v1";
}

export interface FinancialScreenCompactCompany {
  companyCode: string;
  companyName: string;
  stage:
    | "universe_filter"
    | "mapping"
    | "coarse_filter"
    | "deep_scoring"
    | "reaction_selection";
  mappingStatus: FinancialInstitutionMappingStatus | null;
  financialSubtype: SupportedFinancialSector | null;
  reasonCodes: string[];
}

export interface FinancialScreenCandidate {
  rank: number;
  companyCode: string;
  companyName: string;
  shortName: string;
  market: CompanyMarket;
  listingDate: string;
  isKy: boolean;
  financialSubtype: SupportedFinancialSector;
  institutionCode: string;
  institutionName: string;
  modelId: "taiwan_financial_screen.v1";
  preset: "balanced_financial_v1";
  scoreComparisonScope: "within_financial_model_only";
  bucket: ScreenCandidateBucket;
  overallScore: number | null;
  evidenceCompletenessPercent: number;
  broadEvidence: {
    revenueMonth: string;
    latestRevenueYoyPercent: number | null;
    cumulativeRevenueYoyPercent: number | null;
    valuationDate: string;
    peRatio: number | null;
    priceToBookRatio: number | null;
    dividendYieldPercent: number | null;
    closePriceTwd: number | null;
    coarseScore: number;
  };
  pillars: {
    companyQuality: ScreenPillar;
    fundamentalImprovement: ScreenPillar;
    reasonableValuation: ScreenPillar;
    marketUnderreactionProxy: ScreenPillar;
  };
  firstRejectionReasons: string[];
  evidenceGaps: string[];
  nextDiligence: string[];
  asOf: {
    masterReportDate: string;
    revenueThroughMonth: string;
    valuationDate: string;
    profitabilityThroughPeriod: string | null;
    capitalThroughPeriod: string | null;
    assetQualityThroughPeriod: string | null;
    reactionDate: string | null;
  };
}

export interface FinancialScreenDependencyStatus {
  stage: "coarse" | "deep" | "reaction";
  dependency:
    | "company_master"
    | "catalog_mapping"
    | "latest_monthly_revenue"
    | "latest_valuation"
    | "monthly_revenue_trend"
    | "profitability_metrics_batch"
    | "financial_institution_metrics_batch"
    | "stock_reaction_signals";
  status: "complete" | "partial" | "failed" | "not_run";
  affectedCompanyCodes: string[];
  message: string | null;
}

export interface FinancialScreenSource {
  kind:
    | "company_master"
    | "catalog"
    | "monthly_revenue_latest"
    | "monthly_revenue_history"
    | "valuation_latest"
    | "profitability_metrics"
    | "financial_institution_metrics"
    | "reaction_benchmark"
    | "reaction_stock"
    | "reaction_corporate_action";
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  cache?: CacheProvenance;
  market: CompanyMarket | null;
  asOf: string;
  asOfGranularity: "date" | "month" | "quarter" | "mixed";
}

export interface TaiwanFinancialScreenResult {
  query: TaiwanFinancialScreenQuery;
  generatedAt: string;
  timezone: "Asia/Taipei";
  screenDefinition: {
    id: "taiwan_financial_screen.v1";
    preset: "balanced_financial_v1";
    posture: "research_triage_not_recommendation";
    latestOnly: true;
    supportedSectors: SupportedFinancialSector[];
    scoreCompensationAcrossPillars: false;
    crossModelScoreComparable: false;
    pillarWeights: Record<ScreenPillar["key"], 25>;
    stages: Array<{
      stage: "coarse" | "deep" | "reaction";
      maximumCompanies: number | null;
      description: string;
    }>;
    coarseRanking: {
      eligibilityRules: string[];
      scoreComponents: Array<{ code: string; points: number; rule: string }>;
      tieBreak: string[];
    };
    evidencePolicies: {
      profitabilityRoles: FinancialScreenMetricRole[];
      coreInstitutionMetricRoles: Record<
        SupportedFinancialSector,
        FinancialScreenMetricRole[]
      >;
      financialAlignment: string;
      valuationPeerScope: "same_financial_subtype_no_fallback";
      valuationPeerMinimum: 3;
      reactionPriceBasis: string;
      metricResolution: FinancialScreenMetricCatalogResolution;
    };
    decisionPolicy: {
      researchCandidate: string;
      watchlist: string;
      insufficientData: string;
      deprioritized: string;
    };
    limitations: string[];
  };
  asOf: {
    selector: "latest";
    granularity: "mixed";
    masterReportDates: string[];
    revenueMonth: string;
    valuationDate: string;
    profitabilityThroughPeriods: string[];
    capitalThroughPeriods: string[];
    assetQualityThroughPeriods: string[];
    reactionDates: Array<{ market: CompanyMarket; date: string }>;
  };
  coverage: {
    selectionComplete: boolean;
    sourceComplete: boolean;
    mappingComplete: boolean;
    deepEvidenceComplete: boolean;
    reactionEvidenceComplete: boolean;
    missingCompanyCodes: string[];
  };
  funnel: {
    currentMaster: number;
    explicitlyRequested: number | null;
    selectedFinancial: number;
    mappedSupported: number;
    excludedNonFinancial: number;
    excludedKy: number;
    institutionNotFound: number;
    mappingUnsafe: number;
    coarseEligible: number;
    deepSelected: number;
    deepScored: number;
    reactionSelected: number;
    reactionScored: number;
    returned: number;
    buckets: Record<ScreenCandidateBucket, number>;
  };
  workBudget: {
    coarseCompanies: number;
    deepCompanyLimit: 10;
    deepCompaniesRequested: number;
    profitabilityMetricCount: 3;
    profitabilityComparisonUnits: number;
    institutionComparisonUnits: number;
    institutionIsolationUnits: number;
    revenueTrendMonths: 6;
    reactionCompanyLimit: 5;
    reactionCompaniesRequested: number;
    reactionOfficialMonthUnits: number;
    reactionOfficialMonthUnitLimit: 48;
    reactionCorporateActionRequests: number;
  };
  candidates: FinancialScreenCandidate[];
  summaryLimits: {
    maximumPerList: 25;
    notDeepScoredTotal: number;
    notReactionScoredTotal: number;
    excludedTotal: number;
  };
  notDeepScored: FinancialScreenCompactCompany[];
  notReactionScored: FinancialScreenCompactCompany[];
  excluded: FinancialScreenCompactCompany[];
  dependencyStatus: FinancialScreenDependencyStatus[];
  mappingCoverage: FinancialInstitutionCoverageReport;
  sources: FinancialScreenSource[];
  warnings: string[];
}
