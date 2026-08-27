import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";

export type CatalystEventType =
  | "material_information"
  | "investor_conference";

export type CatalystEventStatus =
  | "announced"
  | "revised"
  | "cancelled"
  | "scheduled";

export type CatalystDateConfidence = "confirmed";
export type CatalystDateBasis = "publication" | "scheduled_event";
export type CatalystDatePrecision = "day" | "minute" | "second";

export type CatalystSourceKey =
  | "twse_material_information_current"
  | "tpex_material_information_current"
  | "mops_material_information_history"
  | "mops_investor_conference_history";

export interface CatalystEventDetails {
  location: string | null;
  presentationZhFileName: string | null;
  presentationEnFileName: string | null;
  companyIrUrl: string | null;
  videoUrl: string | null;
  note: string | null;
}

/**
 * One public, source-backed company event. Null timestamps are intentional:
 * MOPS historical material-information lists do not expose factDate, while
 * investor-conference lists do not expose the disclosure publication time.
 */
export interface CatalystEvent {
  eventId: string;
  eventType: CatalystEventType;
  companyCode: string;
  companyName: string;
  market: CompanyMarket;
  title: string;
  description: string | null;
  clause: string | null;
  publishedAt: string | null;
  factDate: string | null;
  scheduledAt: string | null;
  effectiveAt: string | null;
  timezone: "Asia/Taipei";
  status: CatalystEventStatus;
  statusBasis: "announcement_publication" | "title_prefix" | "official_schedule";
  dateConfidence: CatalystDateConfidence;
  dateBasis: CatalystDateBasis;
  datePrecision: CatalystDatePrecision;
  isConsensus: false;
  sourceKey: CatalystSourceKey;
  sourceUrl: string;
  sourceReportDate: string | null;
  sourceRecordKey: string;
  eventDetails: CatalystEventDetails | null;
}

export interface CurrentMaterialInformationQuery {
  market: CompanyMarketSelection;
  companyCodes?: string[];
}

export type CatalystSnapshotStatus = "nonempty" | "verified_empty";

export interface CatalystCurrentSource {
  sourceKey:
    | "twse_material_information_current"
    | "tpex_material_information_current";
  eventType: "material_information";
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
  scope: "current_official_snapshot";
  retrievedAt: string;
  reportDate: string | null;
  rawRowCount: number;
  eligibleEventCount: number;
  excludedRowCount: number;
  duplicateRowCount: number;
  returnedEventCount: number;
  snapshotStatus: CatalystSnapshotStatus;
  emptyVerification: "not_applicable" | "official_blank_sentinel";
  officialDeclaredRowCount: null;
  rowsetCompleteness: "unverified_no_official_declared_count";
  snapshotIdentity: string;
}

export interface CurrentMaterialInformationResult {
  query: {
    market: CompanyMarketSelection;
    companyCodes: string[] | null;
  };
  generatedAt: string;
  timezone: "Asia/Taipei";
  scope: "current_official_snapshot";
  isConsensus: false;
  events: CatalystEvent[];
  sources: CatalystCurrentSource[];
  selection: {
    requestedCompanyCodes: string[] | null;
    withEventsCompanyCodes: string[];
    withoutEventsCompanyCodes: string[];
  };
  counts: {
    listed: number;
    otc: number;
    returned: number;
  };
  fingerprint: string;
  warnings: string[];
}

export interface CatalystCompanyMarketHint {
  companyCode: string;
  market: CompanyMarket;
}

export interface CompanyCatalystEventsQuery {
  companyCodes: string[];
  startDate: string;
  endDate: string;
  eventTypes?: CatalystEventType[];
  offset?: number;
  limit?: number;
  /** Current-identity/current-snapshot routing hint; historical IR still probes both markets. */
  companyMarkets?: CatalystCompanyMarketHint[];
}

export interface CatalystSourceFailure {
  failureId: string;
  companyCode: string;
  eventType: CatalystEventType;
  market: CompanyMarket | null;
  queryMonth: string;
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

export interface CatalystFamilyCoverage {
  companyCode: string;
  eventType: CatalystEventType;
  status: "complete" | "partial" | "failed";
  queryStart: string;
  queryEnd: string;
  requestCount: number;
  completedRequestCount: number;
  verifiedEmptyRequestCount: number;
  nonemptyRequestCount: number;
  eventCount: number;
  snapshotIdentity: string;
  failures: CatalystSourceFailure[];
}

export interface CatalystCompanyResult {
  companyCode: string;
  status: "complete" | "partial" | "failed";
  eventCount: number;
  failures: CatalystSourceFailure[];
}

export interface CatalystResultSource {
  eventType: CatalystEventType;
  market: CompanyMarket | null;
  exchange: "TWSE" | "TPEx" | "MOPS";
  sourceKey: CatalystSourceKey;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string | null;
  scope: "current_official_snapshot" | "selected_company_historical_months";
  queryStart: string;
  queryEnd: string;
  sourceReportDate: string | null;
  rawRowCount: number;
  acceptedEventCount: number;
  snapshotIdentity: string;
}

export interface CatalystAggregateFamilyCoverage {
  eventType: CatalystEventType;
  scope: "current_and_selected_company_history" | "selected_company_history";
  status: "complete" | "partial" | "failed";
  requestedStart: string;
  requestedEnd: string;
  failedCompanyCodes: string[];
}

export interface CatalystCurrentSnapshotCoverage {
  sourceKey:
    | "twse_material_information_current"
    | "tpex_material_information_current";
  eventType: "material_information";
  market: CompanyMarket;
  status: "complete" | "not_applicable" | "failed";
  affectedCompanyCodes: string[];
  sourceReportDate: string | null;
  eventCount: number;
  snapshotIdentity: string;
  failures: CatalystSourceFailure[];
}

export interface CatalystWorkBudget {
  companyCount: number;
  distinctCalendarMonths: number;
  eventTypeCount: number;
  historicalLogicalUnits: number;
  historicalUpstreamRequests: number;
  currentSnapshotRequests: number;
  plannedUpstreamRequests: number;
  upstreamRequestLimit: 40;
}

export interface CompanyCatalystEventsResult {
  query: {
    companyCodes: string[];
    startDate: string;
    endDate: string;
    eventTypes: CatalystEventType[];
    offset: number;
    limit: number;
  };
  generatedAt: string;
  timezone: "Asia/Taipei";
  scope: "official_disclosure_events";
  isConsensus: false;
  events: CatalystEvent[];
  sources: CatalystResultSource[];
  coverage: {
    sourceComplete: boolean;
    failureIsolation: "per_company_event_type_calendar_month";
    families: CatalystAggregateFamilyCoverage[];
    currentSnapshots: CatalystCurrentSnapshotCoverage[];
  };
  familyCoverage: CatalystFamilyCoverage[];
  companies: CatalystCompanyResult[];
  failures: CatalystSourceFailure[];
  counts: {
    requestedCompanies: number;
    requestedEventTypes: number;
    totalEvents: number;
    returnedEvents: number;
    completeCompanies: number;
    partialCompanies: number;
    failedCompanies: number;
  };
  workBudget: CatalystWorkBudget;
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
