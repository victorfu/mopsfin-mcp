import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";

export const TAIWAN_STOCK_SCREEN_PRESET = "balanced_non_financial_v2" as const;
export const TAIWAN_STOCK_SCREEN_DEFINITION = "taiwan_stock_screen.v2" as const;

export type TaiwanStockScreenPreset = typeof TAIWAN_STOCK_SCREEN_PRESET;
export type ScreenCriterionStatus = "pass" | "fail" | "unknown";
export type ScreenPillarStatus = ScreenCriterionStatus;
export type ScreenCandidateBucket =
  | "research_candidate"
  | "watchlist"
  | "insufficient_data"
  | "deprioritized";

export type ScreenPillarKey =
  | "company_quality"
  | "fundamental_improvement"
  | "reasonable_valuation"
  | "market_underreaction_proxy";

export interface TaiwanStockScreenQuery {
  market: CompanyMarketSelection;
  companyCodes?: string[];
  includeKy: boolean;
  candidateLimit: number;
  preset: TaiwanStockScreenPreset;
}

export interface ScreenCriterion {
  code: string;
  label: string;
  status: ScreenCriterionStatus;
  value: number | null;
  unit: string;
  periods: string[];
  rule: string;
  weight: number;
  mandatory: boolean;
  context: Record<string, number | string | boolean | null>;
  reasonCodes: string[];
}

export interface ScreenPillar {
  key: ScreenPillarKey;
  label: string;
  status: ScreenPillarStatus;
  score: number | null;
  knownWeight: number;
  totalWeight: 100;
  criteria: ScreenCriterion[];
  hardFailReasons: string[];
  evidenceGaps: string[];
}

export interface ScreenBroadEvidence {
  revenueMonth: string;
  latestRevenueYoyPercent: number | null;
  cumulativeRevenueYoyPercent: number | null;
  valuationDate: string;
  peRatio: number | null;
  priceToBookRatio: number | null;
  dividendYieldPercent: number | null;
  closePriceTwd: number | null;
  coarseScore: number;
}

export interface ScreenCandidateAsOf {
  masterReportDate: string;
  revenueThroughMonth: string;
  valuationDate: string;
  financialThroughPeriod: string | null;
  reactionDate: string | null;
}

export interface TaiwanStockScreenCandidate {
  rank: number;
  companyCode: string;
  companyName: string;
  shortName: string;
  market: CompanyMarket;
  industryCode: string;
  listingDate: string;
  isKy: boolean;
  bucket: ScreenCandidateBucket;
  overallScore: number | null;
  evidenceCompletenessPercent: number;
  broadEvidence: ScreenBroadEvidence;
  pillars: {
    companyQuality: ScreenPillar;
    fundamentalImprovement: ScreenPillar;
    reasonableValuation: ScreenPillar;
    marketUnderreactionProxy: ScreenPillar;
  };
  firstRejectionReasons: string[];
  evidenceGaps: string[];
  nextDiligence: string[];
  asOf: ScreenCandidateAsOf;
}

export interface ScreenCompactCompany {
  companyCode: string;
  companyName: string;
  stage:
    | "universe_filter"
    | "coarse_filter"
    | "deep_scoring"
    | "reaction_selection";
  reasonCodes: string[];
}

export interface ScreenSource {
  kind:
    | "company_master"
    | "monthly_revenue_latest"
    | "monthly_revenue_history"
    | "valuation_latest"
    | "company_metrics"
    | "reaction_benchmark"
    | "reaction_stock"
    | "reaction_corporate_action";
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  market: CompanyMarket | null;
  asOf: string;
  asOfGranularity: "date" | "month" | "quarter" | "mixed";
}

export interface ScreenDependencyStatus {
  stage: "coarse" | "deep" | "reaction";
  dependency:
    | "company_master"
    | "latest_monthly_revenue"
    | "latest_valuation"
    | "monthly_revenue_trend"
    | "company_metrics_batch"
    | "stock_reaction_signals";
  status: "complete" | "partial" | "failed" | "not_run";
  affectedCompanyCodes: string[];
  message: string | null;
}

export interface TaiwanStockScreenDefinition {
  id: typeof TAIWAN_STOCK_SCREEN_DEFINITION;
  preset: TaiwanStockScreenPreset;
  posture: "research_triage_not_recommendation";
  latestOnly: true;
  financialCompanies: "excluded";
  scoreCompensationAcrossPillars: false;
  pillarWeights: Record<ScreenPillarKey, 25>;
  stages: Array<{
    stage: "coarse" | "deep" | "reaction";
    maximumCompanies: number | null;
    description: string;
  }>;
  coarseRanking: {
    eligibilityRules: string[];
    scoreComponents: Array<{
      code: string;
      points: number;
      rule: string;
    }>;
    tieBreak: string[];
  };
  evidencePolicies: {
    financialMetricCodes: string[];
    financialAlignment: "exact_common_quarter_no_substitution";
    valuationPeerMinimum: 20;
    valuationPeerFallback: "same_industry_then_same_market";
    reactionHorizons: Array<5 | 20 | 60>;
    reactionPriceBasis: "price_index_compatible_corporate_action_adjusted_vs_price_index";
  };
  decisionPolicy: {
    researchCandidate: string;
    watchlist: string;
    insufficientData: string;
    deprioritized: string;
  };
  limitations: string[];
}

export interface ScreenFunnel {
  currentMaster: number;
  explicitlyRequested: number | null;
  eligibleNonFinancial: number;
  excludedFinancial: number;
  excludedKy: number;
  missingRequestedCodes: string[];
  withLatestRevenue: number;
  withLatestValuation: number;
  coarseEligible: number;
  deepSelected: number;
  deepScored: number;
  reactionSelected: number;
  reactionScored: number;
  returned: number;
  buckets: Record<ScreenCandidateBucket, number>;
}

export interface ScreenWorkBudget {
  coarseCompanies: number;
  deepCompanyLimit: 10;
  deepCompaniesRequested: number;
  financialMetricCount: 7;
  financialMetricComparisonUnits: number;
  revenueTrendMonths: 6;
  reactionCompanyLimit: 5;
  reactionCompaniesRequested: number;
  reactionOfficialMonthUnits: number;
  reactionOfficialMonthUnitLimit: 48;
  reactionCorporateActionRequests: number;
}

export interface TaiwanStockScreenResult {
  query: TaiwanStockScreenQuery;
  generatedAt: string;
  timezone: "Asia/Taipei";
  screenDefinition: TaiwanStockScreenDefinition;
  asOf: {
    selector: "latest";
    granularity: "mixed";
    masterReportDates: string[];
    revenueMonth: string;
    valuationDate: string;
    financialThroughPeriods: string[];
    reactionDates: Array<{ market: CompanyMarket; date: string }>;
  };
  coverage: {
    selectionComplete: boolean;
    sourceComplete: boolean;
    deepEvidenceComplete: boolean;
    reactionEvidenceComplete: boolean;
    missingCompanyCodes: string[];
  };
  funnel: ScreenFunnel;
  workBudget: ScreenWorkBudget;
  candidates: TaiwanStockScreenCandidate[];
  summaryLimits: {
    maximumPerList: 25;
    notDeepScoredTotal: number;
    notReactionScoredTotal: number;
    excludedTotal: number;
  };
  notDeepScored: ScreenCompactCompany[];
  notReactionScored: ScreenCompactCompany[];
  excluded: ScreenCompactCompany[];
  dependencyStatus: ScreenDependencyStatus[];
  sources: ScreenSource[];
  warnings: string[];
}
