import type { CompanyMarket } from "@/lib/company-master/types";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

export type CompanyCatalystSnapshotsType =
  | "forecast_achievement"
  | "forecast_material_variance"
  | "shareholder_meeting"
  | "dividend_decision";

export type CompanyCatalystSnapshotsSourceKey =
  | "twse_forecast_achievement_current"
  | "tpex_forecast_achievement_current"
  | "twse_forecast_material_variance_current"
  | "tpex_forecast_material_variance_current"
  | "twse_shareholder_meeting_current"
  | "tpex_shareholder_meeting_current"
  | "twse_dividend_decision_current"
  | "tpex_dividend_decision_current_unsupported";

export type CompanyCatalystSnapshotsFreshness =
  | "within_expected_window"
  | "stale"
  | "not_applicable";

export type CompanyCatalystSnapshotsSourceStatus =
  | "nonempty"
  | "verified_empty"
  | "failed"
  | "unsupported";

export type CompanyCatalystSnapshotsCoverageStatus =
  | "complete"
  | "partial"
  | "failed"
  | "unsupported";

export type CompanyCatalystSnapshotsDisclosureStatus =
  | "disclosed"
  | "not_disclosed_in_snapshot"
  | "unknown_stale_snapshot"
  | "unknown_source_failure"
  | "unsupported"
  | "identity_unverified";

export type CompanyCatalystSnapshotsIdentityStatus =
  | "verified_current_master_hint"
  | "verified_official_record"
  | "unverified";

export interface CompanyCatalystSnapshotsMarketHint {
  companyCode: string;
  market: CompanyMarket;
}

export interface CompanyCatalystSnapshotsQuery {
  companyCodes: string[];
  snapshotTypes?: CompanyCatalystSnapshotsType[];
  companyMarkets?: CompanyCatalystSnapshotsMarketHint[];
  asOf?: "latest";
  offset?: number;
  limit?: number;
}

export interface CompanyCatalystSnapshotsNumberRange {
  raw: string;
  lower: number;
  upper: number;
  unit: "source_not_declared";
}

export interface CompanyCatalystSnapshotsForecastAchievementDetails {
  kind: "forecast_achievement";
  fiscalYear: number;
  fiscalYearRaw: string;
  quarter: 1 | 2 | 3 | 4;
  forecastSequence: string;
  coveragePeriod: string;
  actualCumulative: number;
  actualCumulativeRaw: string;
  valueUnit: "source_not_declared";
  forecastCumulative: CompanyCatalystSnapshotsNumberRange;
}

export interface CompanyCatalystSnapshotsForecastVarianceDetails {
  kind: "forecast_material_variance";
  fiscalYear: number;
  fiscalYearRaw: string;
  quarter: 1 | 2 | 3 | 4;
  forecastSequence: string;
  coveragePeriod: string;
  actualQuarter: number;
  actualQuarterRaw: string;
  actualCumulative: number;
  actualCumulativeRaw: string;
  valueUnit: "source_not_declared";
  forecastQuarter: CompanyCatalystSnapshotsNumberRange;
  forecastCumulative: CompanyCatalystSnapshotsNumberRange;
  selectionBasis: "official_dataset_membership";
  officialSelectionRule: "quarter_difference_at_least_10_percent_or_cumulative_difference_at_least_20_percent";
  thresholdDetail: null;
}

export interface CompanyCatalystSnapshotsShareholderMeetingDetails {
  kind: "shareholder_meeting";
  companyAddress: string | null;
  meetingType: string;
  meetingDate: string;
  meetingLocation: string;
  directorSupervisorElection: string;
  electronicVoting: string;
  contactPhone: string | null;
  stockTransferAgent: string | null;
  stockTransferAgentPhone: string | null;
}

export interface CompanyCatalystSnapshotsDividendDecisionDetails {
  kind: "dividend_decision";
  decisionStage: string;
  dividendYear: number;
  dividendYearRaw: string;
  periodType: string;
  periodRaw: string;
  periodStart: string | null;
  periodEnd: string | null;
  sequence: string;
  boardDecisionDate: string | null;
  shareholderMeetingDate: string | null;
  cashDividend: {
    earningsPerShare: number | null;
    legalReservePerShare: number | null;
    capitalReservePerShare: number | null;
    totalAmount: number | null;
  };
  stockDividend: {
    earningsPerShare: number | null;
    legalReservePerShare: number | null;
    capitalReservePerShare: number | null;
    totalShares: number | null;
  };
  charterExcerpt: string | null;
  note: string | null;
}

export type CompanyCatalystSnapshotsDetails =
  | CompanyCatalystSnapshotsForecastAchievementDetails
  | CompanyCatalystSnapshotsForecastVarianceDetails
  | CompanyCatalystSnapshotsShareholderMeetingDetails
  | CompanyCatalystSnapshotsDividendDecisionDetails;

export interface CompanyCatalystSnapshotsRecord {
  recordId: string;
  snapshotType: CompanyCatalystSnapshotsType;
  companyCode: string;
  companyName: string;
  market: CompanyMarket;
  sourceMode: "current_official_snapshot";
  sourceSnapshotDate: string;
  freshness: Exclude<CompanyCatalystSnapshotsFreshness, "not_applicable">;
  sourceSnapshotAgeDays: number;
  pointInTimeHistoryAvailable: false;
  firstKnownAt: null;
  isConsensus: false;
  upcomingEligible: boolean;
  sourceKey: Exclude<
    CompanyCatalystSnapshotsSourceKey,
    "tpex_dividend_decision_current_unsupported"
  >;
  sourceUrl: string;
  sourceRecordKey: string;
  details: CompanyCatalystSnapshotsDetails;
}

export interface CompanyCatalystSnapshotsSourceFailure {
  failureId: string;
  snapshotType: CompanyCatalystSnapshotsType;
  market: CompanyMarket;
  sourceKey: CompanyCatalystSnapshotsSourceKey;
  affectedCompanyCodes: string[];
  code: string;
  message: string;
  reason: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
  action:
    | "fix_input"
    | "change_query"
    | "retry"
    | "restart_pagination"
    | "none";
}

export interface CompanyCatalystSnapshotsSource {
  snapshotType: CompanyCatalystSnapshotsType;
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceKey: CompanyCatalystSnapshotsSourceKey;
  sourceName: string;
  sourceUrl: string | null;
  sourceMode: "current_official_snapshot";
  pointInTimeHistoryAvailable: false;
  isConsensus: false;
  requestedCompanyCodes: string[];
  status: CompanyCatalystSnapshotsSourceStatus;
  freshness: CompanyCatalystSnapshotsFreshness;
  retrievedAt: string | null;
  sourceSnapshotDate: string | null;
  sourceSnapshotAgeDays: number | null;
  rawRowCount: number;
  eligibleRecordCount: number;
  duplicateRecordCount: number;
  selectedRecordCount: number;
  emptyVerification: "not_applicable" | "official_blank_sentinel";
  officialDeclaredRowCount: null;
  rowsetCompleteness:
    | "unverified_no_official_declared_count"
    | "not_applicable";
  snapshotIdentity: string | null;
  failureId: string | null;
  cache?: CacheProvenance;
}

export interface CompanyCatalystSnapshotsCoverageItem {
  companyCode: string;
  snapshotType: CompanyCatalystSnapshotsType;
  routedMarkets: CompanyMarket[];
  status: CompanyCatalystSnapshotsCoverageStatus;
  disclosureStatus: CompanyCatalystSnapshotsDisclosureStatus;
  identityStatus: CompanyCatalystSnapshotsIdentityStatus;
  resolvedMarket: CompanyMarket | null;
  freshness: CompanyCatalystSnapshotsFreshness;
  recordCount: number;
  sourceKeys: CompanyCatalystSnapshotsSourceKey[];
  failureIds: string[];
}

export interface CompanyCatalystSnapshotsCompanyResult {
  companyCode: string;
  status: "complete" | "partial" | "failed";
  identityStatus: CompanyCatalystSnapshotsIdentityStatus;
  resolvedMarket: CompanyMarket | null;
  recordCount: number;
  disclosedSnapshotTypes: CompanyCatalystSnapshotsType[];
  notDisclosedSnapshotTypes: CompanyCatalystSnapshotsType[];
  staleSnapshotTypes: CompanyCatalystSnapshotsType[];
  unsupportedSnapshotTypes: CompanyCatalystSnapshotsType[];
  failedSnapshotTypes: CompanyCatalystSnapshotsType[];
}

export interface CompanyCatalystSnapshotsWorkBudget {
  companyCount: number;
  snapshotTypeCount: number;
  plannedSourceRoutes: number;
  supportedSourceQueries: number;
  unsupportedSourceRoutes: number;
  sourceQueryLimit: 8;
}

export interface CompanyCatalystSnapshotsResult {
  query: {
    companyCodes: string[];
    snapshotTypes: CompanyCatalystSnapshotsType[];
    companyMarkets: CompanyCatalystSnapshotsMarketHint[];
    asOf: "latest";
    offset: number;
    limit: number;
  };
  generatedAt: string;
  timezone: "Asia/Taipei";
  scope: "current_official_company_snapshots";
  isConsensus: false;
  records: CompanyCatalystSnapshotsRecord[];
  sources: CompanyCatalystSnapshotsSource[];
  coverage: {
    sourceComplete: boolean;
    selection: "complete" | "partial";
    failureIsolation: "per_snapshot_type_market";
    snapshots: CompanyCatalystSnapshotsCoverageItem[];
  };
  companies: CompanyCatalystSnapshotsCompanyResult[];
  failures: CompanyCatalystSnapshotsSourceFailure[];
  counts: {
    requestedCompanies: number;
    requestedSnapshotTypes: number;
    totalRecords: number;
    returnedRecords: number;
    completeCompanies: number;
    partialCompanies: number;
    failedCompanies: number;
    nonemptySources: number;
    verifiedEmptySources: number;
    staleSources: number;
    failedSources: number;
    unsupportedSources: number;
  };
  workBudget: CompanyCatalystSnapshotsWorkBudget;
  pagination: {
    offset: number;
    limit: number;
    totalRows: number;
    returnedRows: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  fingerprint: string;
  warnings: string[];
}
