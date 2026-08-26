import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";
import type {
  MarketReconciliation,
  OfficialMarketSource,
  UniversePolicy,
} from "@/lib/market-data/types";

export type RevenueValueStatus = "reported" | "missing" | "invalid_upstream";
/** Runtime validation narrows this string to `latest` or a calendar `YYYY-MM`. */
export type RevenueMonthSelector = string;

export type RevenueSourceCoverageMethod =
  | "current_master_exact_match"
  | "structure_only_no_official_declared_count";

export interface RevenueSourceCoverage {
  status: "verified" | "unverified";
  method: RevenueSourceCoverageMethod;
  complete: boolean;
}

export interface RevenueSourceIntegrity {
  format: "json_array" | "rfc4180_csv";
  structure: "verified";
  snapshotIdentity: "verified";
  eligibleCompanyCodesUnique: "verified";
  officialDeclaredRowCount: null;
  rowsetCompleteness: "unverified_no_official_declared_count";
}

export interface MonthlyRevenueQuery {
  market: CompanyMarketSelection;
  dataMonth: RevenueMonthSelector;
  companyCodes?: string[];
  universePolicy: UniversePolicy;
}

export interface MonthlyRevenueRow {
  code: string;
  name: string;
  market: CompanyMarket;
  industryCode: string | null;
  sourceIndustryName: string | null;
  sourceReportDate: string;
  currentMonthRevenueTwd: number | null;
  previousMonthRevenueTwd: number | null;
  sameMonthLastYearRevenueTwd: number | null;
  momPercent: number | null;
  yoyPercent: number | null;
  currentYearCumulativeRevenueTwd: number | null;
  previousYearCumulativeRevenueTwd: number | null;
  cumulativeYoyPercent: number | null;
  note: string | null;
  valueStatus: {
    currentMonthRevenueTwd: RevenueValueStatus;
    previousMonthRevenueTwd: RevenueValueStatus;
    sameMonthLastYearRevenueTwd: RevenueValueStatus;
    momPercent: RevenueValueStatus;
    yoyPercent: RevenueValueStatus;
    currentYearCumulativeRevenueTwd: RevenueValueStatus;
    previousYearCumulativeRevenueTwd: RevenueValueStatus;
    cumulativeYoyPercent: RevenueValueStatus;
  };
}

export interface MonthlyRevenueSource extends OfficialMarketSource {
  dataMonth: string;
  sourceReportDate: string;
  sourceAmountUnit: "thousand_TWD";
  outputAmountUnit: "TWD";
  amountMultiplier: 1000;
  integrity: RevenueSourceIntegrity;
}

export interface MonthlyRevenueResult {
  query: MonthlyRevenueQuery;
  dataMonth: string;
  currency: "TWD";
  amountUnit: "TWD";
  coverageComplete: boolean;
  sourceCoverage: RevenueSourceCoverage;
  selectionComplete: boolean;
  missingCompanyCodes: string[];
  filingCoverage: {
    expectedCompanyCount: number;
    reportedCompanyCount: number;
    missingCompanyCodes: string[];
    coverageRatio: number;
    complete: boolean;
    status:
      | "complete"
      | "partial"
      | "historical_cross_timepoint_unverified";
  };
  reconciliation: MarketReconciliation[];
  counts: {
    listed: number;
    otc: number;
    returned: number;
  };
  rows: MonthlyRevenueRow[];
  sources: MonthlyRevenueSource[];
  warnings: string[];
}

export interface MonthlyRevenueTrendQuery {
  market: CompanyMarketSelection;
  companyCodes: string[];
  endMonth: RevenueMonthSelector;
  lookbackMonths: number;
  universePolicy: UniversePolicy;
}

export interface MonthlyRevenueTrendPoint {
  dataMonth: string;
  name: string | null;
  market: CompanyMarket | null;
  sourceReportDate: string | null;
  sourceIndustryName: string | null;
  currentMonthRevenueTwd: number | null;
  sameMonthLastYearRevenueTwd: number | null;
  momPercent: number | null;
  yoyPercent: number | null;
  valueStatus: {
    currentMonthRevenueTwd: RevenueValueStatus;
    sameMonthLastYearRevenueTwd: RevenueValueStatus;
    momPercent: RevenueValueStatus;
    yoyPercent: RevenueValueStatus;
  };
}

export type RevenueTrendValueStatus =
  | "reported"
  | "partial"
  | "insufficient_data"
  | "invalid_upstream"
  | "needs_review";

export interface MonthlyRevenueTrendDerivedValues {
  latestYoyPercent: number | null;
  rolling3MonthYoyPercent: number | null;
  rolling6MonthYoyPercent: number | null;
  yoyAccelerationVs3MonthsAgoPp: number | null;
  positiveYoyMonthsInWindow: number | null;
  reportedYoyMonthsInWindow: number | null;
  consecutivePositiveYoyMonths: number | null;
  valueStatus: {
    latestYoyPercent: RevenueTrendValueStatus;
    rolling3MonthYoyPercent: RevenueTrendValueStatus;
    rolling6MonthYoyPercent: RevenueTrendValueStatus;
    yoyAccelerationVs3MonthsAgoPp: RevenueTrendValueStatus;
    positiveYoyMonthsInWindow: RevenueTrendValueStatus;
    reportedYoyMonthsInWindow: RevenueTrendValueStatus;
    consecutivePositiveYoyMonths: RevenueTrendValueStatus;
  };
}

export type RevenueIdentityTransitionReason =
  | "observed_name_transition"
  | "observed_market_transition";

export interface MonthlyRevenueIdentityTransition {
  dataMonth: string;
  fromName: string;
  toName: string;
  fromMarket: CompanyMarket;
  toMarket: CompanyMarket;
  reasons: RevenueIdentityTransitionReason[];
}

export interface MonthlyRevenueTrendComparability {
  status: "comparable" | "needs_review";
  reasons: RevenueIdentityTransitionReason[];
  transitions: MonthlyRevenueIdentityTransition[];
}

export interface MonthlyRevenueTrendCompany {
  code: string;
  name: string;
  market: CompanyMarket;
  industryCode: string | null;
  sourceIndustryName: string | null;
  observedNames: string[];
  observedMarkets: CompanyMarket[];
  comparability: MonthlyRevenueTrendComparability;
  missingMonths: string[];
  points: MonthlyRevenueTrendPoint[];
  derived: MonthlyRevenueTrendDerivedValues;
}

export interface MonthlyRevenueTrendResult {
  query: MonthlyRevenueTrendQuery;
  startMonth: string;
  endMonth: string;
  currency: "TWD";
  amountUnit: "TWD";
  coverageComplete: boolean;
  sourceCoverage: RevenueSourceCoverage;
  selectionComplete: boolean;
  missingCompanyCodes: string[];
  counts: {
    requestedCompanies: number;
    returnedCompanies: number;
    requestedMonths: number;
  };
  companies: MonthlyRevenueTrendCompany[];
  sources: MonthlyRevenueSource[];
  warnings: string[];
}

export type { MarketReconciliation, UniversePolicy };
