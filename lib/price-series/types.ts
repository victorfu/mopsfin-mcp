import type {
  CompanyMarket,
  CompanyMasterSource,
} from "@/lib/company-master/types";
import type {
  CorporateActionCoverage,
  CorporateActionSource,
} from "@/lib/corporate-actions/types";
import type {
  CorporateActionEventLedgerEntry,
  PriceIndexAdjustedOhlc,
  PriceIndexAdjustmentUnknownReason,
} from "@/lib/corporate-actions/adjustment-engine";
import type {
  OhlcBar,
  PriceSource,
} from "@/lib/price/types";
import type {
  MopsfinErrorAction,
  MopsfinErrorCode,
} from "@/lib/mopsfin/errors";

export type StockPriceSeriesBasis =
  | "raw_unadjusted"
  | "price_index_compatible_corporate_action_adjusted";

export interface StockPriceSeriesQuery {
  companyCode: string;
  startDate: string;
  endDate: string;
  priceBasis: StockPriceSeriesBasis;
  includeEventLedger: boolean;
}

export type StockPriceSeriesIdentityStatus =
  | "verified_current_master"
  | "inferred_from_historical_bars"
  | "unverified";

export interface StockPriceSeriesIdentity {
  status: StockPriceSeriesIdentityStatus;
  companyCode: string;
  companyName: string | null;
  resolvedMarket: CompanyMarket | null;
  currentMasterMarket: CompanyMarket | null;
  currentMasterName: string | null;
  masterSnapshotId: string;
  observedNames: string[];
  observedMarkets: CompanyMarket[];
  reasons: Array<
    | "not_in_current_master"
    | "multiple_historical_markets"
    | "current_market_differs_from_latest_historical_market"
    | "multiple_observed_names"
  >;
}

export interface StockPriceSeriesDependencyFailure {
  code: MopsfinErrorCode;
  reason: string | null;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  action: MopsfinErrorAction;
}

export interface StockPriceSeriesBar extends OhlcBar {
  cumulativeFactor: number | null;
  adjusted: PriceIndexAdjustedOhlc | null;
  adjustmentStatus: "not_requested" | "complete" | "unknown";
  adjustmentUnknownReasons: PriceIndexAdjustmentUnknownReason[];
  volumeBasis: "raw_shares";
}

export interface StockPriceSeriesAdjustment {
  status: "not_requested" | "complete" | "unknown";
  adjustmentDirection: "backward" | "not_applicable";
  anchorDate: string;
  factorAtWindowStart: number | null;
  cashDividendTreatment: "retained" | "not_applicable";
  isAdjustedClose: false;
  isTotalReturn: false;
  volumeAdjusted: false;
  volumeBasis: "raw_shares";
  unknownReasons: PriceIndexAdjustmentUnknownReason[];
  officialChangeMarkers: Array<{ date: string; marker: string }>;
  unmatchedOfficialChangeMarkers: Array<{ date: string; marker: string }>;
  marketTransitionDetected: boolean;
}

export interface StockPriceSeriesCoverage {
  requestedStart: string;
  requestedEnd: string;
  rawPrice: {
    status: "complete";
    coverageComplete: true;
    coveredThrough: string;
    pageCount: number;
    barCount: number;
    dataQualityComplete: boolean;
  };
  corporateActions: {
    status: "not_requested" | "complete" | "partial" | "unavailable";
    coverage: CorporateActionCoverage | null;
    failure: StockPriceSeriesDependencyFailure | null;
  };
  adjustment: {
    status: "not_requested" | "complete" | "unknown";
    completeBarCount: number;
    unknownBarCount: number;
  };
}

export type StockPriceSeriesSource =
  | (CompanyMasterSource & { stage: "company_master" })
  | (PriceSource & { stage: "raw_price" })
  | (CorporateActionSource & { stage: "corporate_actions" });

export interface StockPriceSeriesWorkBudget {
  orchestrationCompanyMasterCalls: 1;
  rawPriceDependencyMasterLookupPolicy:
    "dependency_managed_per_cursor_page_not_counted_as_orchestration_call";
  rawPricePageLimit: 3;
  rawPricePageCount: number;
  rawPricePageUnitDefinition: "one_get_stock_ohlc_cursor_page";
  corporateActionHistoryCalls: 0 | 1;
  corporateActionOfficialRequestCount: number | null;
  corporateActionRequestUnitDefinition:
    "one_official_range_or_selected_event_detail_request";
}

export interface StockPriceSeriesResult {
  query: StockPriceSeriesQuery;
  generatedAt: string;
  timezone: "Asia/Taipei";
  currency: "TWD";
  interval: "1d";
  requestedPriceBasis: StockPriceSeriesBasis;
  rawPriceBasis: "raw_unadjusted";
  adjustedPriceBasis:
    | "price_index_compatible_corporate_action_adjusted"
    | null;
  coverageComplete: boolean;
  dataQualityComplete: boolean;
  identity: StockPriceSeriesIdentity;
  adjustment: StockPriceSeriesAdjustment;
  bars: StockPriceSeriesBar[];
  eventLedgerIncluded: boolean;
  eventLedger: CorporateActionEventLedgerEntry[];
  coverage: StockPriceSeriesCoverage;
  sources: StockPriceSeriesSource[];
  workBudget: StockPriceSeriesWorkBudget;
  fingerprint: string;
  fingerprintBasis:
    "query_identity_raw_bars_without_retrieved_at_or_cache_plus_corporate_action_history_and_adjustment_evidence";
  warnings: string[];
}
