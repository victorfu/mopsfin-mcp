import type { CompanyMarket } from "@/lib/company-master/types";

export type CorporateActionFamily =
  | "ex_right_dividend"
  | "capital_reduction"
  | "par_value_change";

export type CorporateActionKind =
  | "cash_dividend"
  | "stock_rights"
  | "rights_and_dividend"
  | "capital_reduction"
  | "par_value_change";

export type CorporateActionAdjustmentStatus = "available" | "unavailable";

export type CorporateActionAdjustmentReason =
  | "cash_only_price_index_factor_is_one"
  | "official_reference_price_divided_by_prior_close"
  | "official_reference_price_divided_by_prior_close_less_cash_dividend"
  | "missing_required_official_value"
  | "twse_combined_event_detail_not_requested"
  | "twse_combined_event_detail_failed";

export interface CorporateActionEvent {
  companyCode: string;
  name: string;
  market: CompanyMarket;
  effectiveDate: string;
  kind: CorporateActionKind;
  priorCloseTwd: number | null;
  referencePriceTwd: number | null;
  cashDividendPerShareTwd: number | null;
  priceIndexAdjustmentFactor: number | null;
  shareCountChanged: boolean;
  adjustmentStatus: CorporateActionAdjustmentStatus;
  adjustmentReason: CorporateActionAdjustmentReason;
  sourceFamily: CorporateActionFamily;
  sourceUrl: string;
  rawType: string;
}

export interface CorporateActionSource {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  family: CorporateActionFamily;
  scope: "range_summary" | "event_detail";
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  supportedFrom: string;
  queryStart: string;
  queryEnd: string;
  responseStart: string | null;
  responseEnd: string | null;
  rawRowCount: number;
  companyEventCount: number;
  officialDeclaredRowCount: number | null;
  officialDeclaredRowCountAvailable: boolean;
}

export interface CorporateActionCoverageGap {
  market: CompanyMarket;
  family: CorporateActionFamily;
  requestedStart: string;
  uncoveredThrough: string;
  supportedFrom: string;
  reason: "before_official_history_start";
}

export interface CorporateActionCoverage {
  status: "complete" | "partial";
  coverageComplete: boolean;
  requestedStart: string;
  requestedEnd: string;
  gaps: CorporateActionCoverageGap[];
}

export interface CorporateActionHistoryOptions {
  /**
   * Limits returned events and TWSE combined right/dividend detail requests.
   * The history fingerprint binds both the full-market range summaries and
   * this normalized selection scope, including selected TWSE combined-event
   * detail evidence.
   */
  companyCodes?: string[];
}

export interface CorporateActionHistory {
  market: CompanyMarket;
  requestedStart: string;
  requestedEnd: string;
  filteredCompanyCodes: string[] | null;
  events: CorporateActionEvent[];
  sources: CorporateActionSource[];
  /** Includes failed selected TWSE combined-event detail attempts. */
  requestCount: number;
  coverage: CorporateActionCoverage;
  fingerprint: string;
  fingerprintBasis: "full_market_range_summary_plus_selected_scope_and_twse_combined_detail_without_retrieved_at";
  warnings: string[];
}
