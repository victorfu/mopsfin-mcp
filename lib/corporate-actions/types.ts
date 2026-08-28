import type { CompanyMarket } from "@/lib/company-master/types";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

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
  cache?: CacheProvenance;
}

interface CorporateActionCoverageGapBase {
  market: CompanyMarket;
  family: CorporateActionFamily;
  requestedStart: string;
  uncoveredThrough: string;
  supportedFrom: string;
}

export type CorporateActionCoverageGap =
  | (CorporateActionCoverageGapBase & {
      reason: "before_official_history_start";
    })
  | (CorporateActionCoverageGapBase & {
      reason: "unverified_empty_response";
      queryStart: string;
      queryEnd: string;
      upstreamStatus: string;
    });

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
   * The history fingerprint binds both the full-market range contracts and
   * accepted summaries, including unverified-empty contract evidence, and
   * this normalized selection scope, including selected TWSE combined-event
   * detail evidence.
   */
  companyCodes?: string[];
}

interface CorporateActionRangeContractProbeBase {
  market: CompanyMarket;
  family: CorporateActionFamily;
  queryStart: string;
  queryEnd: string;
  upstreamStatus: string;
  events: CorporateActionEvent[];
}

/**
 * Contract-only view of one official range endpoint. An unverified empty
 * response deliberately has no source evidence because the upstream payload
 * did not echo the requested range and therefore cannot prove no event.
 */
export type CorporateActionRangeContractProbe =
  | (CorporateActionRangeContractProbeBase & {
      status: "nonempty" | "verified_empty";
      responseRangeVerified: true;
      source: CorporateActionSource;
    })
  | (CorporateActionRangeContractProbeBase & {
      status: "unverified_empty";
      responseRangeVerified: false;
      events: [];
      source: null;
    });

export interface CorporateActionDetailContractProbe {
  event: CorporateActionEvent;
  source: CorporateActionSource;
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
  fingerprintBasis: "full_market_range_contracts_and_summaries_plus_selected_scope_and_twse_combined_detail_without_retrieved_at";
  warnings: string[];
}
