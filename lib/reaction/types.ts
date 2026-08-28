import type { CompanyMarket } from "@/lib/company-master/types";
import type {
  CorporateActionEvent,
  CorporateActionSource,
} from "@/lib/corporate-actions/types";
import type { PriceSource } from "@/lib/price/types";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import type {
  MopsfinErrorAction,
  MopsfinErrorCode,
} from "@/lib/mopsfin/errors";

export type ReactionHorizon = 5 | 20 | 60 | 120;

export interface StockReactionSignalsQuery {
  companyCodes: string[];
  asOf: "latest" | string;
  horizons: ReactionHorizon[];
  pageSize?: number;
  cursor?: string;
}

export interface BenchmarkBar {
  date: string;
  close: number;
}

export interface BenchmarkSource {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  benchmarkCode: "TAIEX" | "TPEX_PRICE_INDEX";
  benchmarkName: "發行量加權股價指數" | "櫃買指數";
  sourceName: string;
  sourceUrl: string;
  dataMonth: string;
  retrievedAt: string;
  rowCount: number;
  cache?: CacheProvenance;
}

export interface BenchmarkHistory {
  market: CompanyMarket;
  benchmarkCode: BenchmarkSource["benchmarkCode"];
  benchmarkName: BenchmarkSource["benchmarkName"];
  priceBasis: "price_index";
  bars: BenchmarkBar[];
  sources: BenchmarkSource[];
}

export type ReactionSignalStatus =
  | "available"
  | "no_stock_data"
  | "stock_data_unavailable"
  | "missing_stock_start_close"
  | "missing_stock_end_close"
  | "incomplete_stock_window"
  | "invalid_denominator"
  | "not_comparable_corporate_action";

export type ExcessReturnStatus = ReactionSignalStatus | "not_comparable";

export type ReactionStockDataStatus = "available" | "no_data" | "unavailable";

export interface ReactionStockDataFailure {
  code: MopsfinErrorCode;
  reason: string | null;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  action: MopsfinErrorAction;
}

export type ExcessReturnComparabilityReason =
  | "corporate_action_coverage_incomplete"
  | "corporate_action_adjustment_unavailable"
  | "corporate_action_prior_close_mismatch"
  | "unmatched_official_change_marker_within_horizon"
  | "market_transition_or_historical_market_mismatch_within_horizon"
  | "multiple_observed_names";

export interface ReturnReactionSignal {
  horizonSessions: ReactionHorizon;
  startDate: string;
  endDate: string;
  /** Raw exchange close-to-close return retained for audit only. */
  stockReturnPercent: number | null;
  /**
   * Close-to-close return after neutralizing share-count mechanics so it is
   * comparable with the official price index. Cash-dividend price effects
   * remain; this is not a total-shareholder-return series.
   */
  priceIndexCompatibleStockReturnPercent: number | null;
  corporateActionAdjustmentFactor: number | null;
  benchmarkReturnPercent: number;
  excessReturnPercentagePoints: number | null;
  status: ReactionSignalStatus;
  excessReturnStatus: ExcessReturnStatus;
  excessReturnReasons: ExcessReturnComparabilityReason[];
}

export interface AverageWindowSignal {
  windowSessions: 5 | 20 | 60;
  startDate: string;
  endDate: string;
  expectedObservationCount: number;
  observationCount: number;
  value: number | null;
  status: ReactionSignalStatus;
}

export interface RatioSignal {
  numeratorWindowSessions: 5 | 20;
  denominatorWindowSessions: 20 | 60;
  value: number | null;
  status: ReactionSignalStatus;
}

export interface PricePathSignal {
  horizonSessions: ReactionHorizon;
  startDate: string;
  endDate: string;
  expectedObservationCount: number;
  observationCount: number;
  maximumDrawdownPercent: number | null;
  distanceBelowWindowHighPercent: number | null;
  priceBasis: "price_index_compatible_corporate_action_adjusted";
  status: ReactionSignalStatus;
}

export interface OfficialChangeMarker {
  date: string;
  marker: string;
}

export interface ReactionComparability {
  status: "price_index_compatible" | "not_comparable" | "unavailable";
  rawPriceBasis: "raw_unadjusted";
  returnBasis: "price_index_compatible_corporate_action_adjusted";
  corporateActionAdjustment: "applied" | "not_required" | "incomplete";
  corporateActionEvidence:
    | "official_history_verified_no_event"
    | "official_history_verified_events"
    | "official_history_incomplete";
  corporateActionCoverageComplete: boolean;
  marketTransitionDetected: boolean;
  observedMarkets: CompanyMarket[];
  corporateActions: CorporateActionEvent[];
  officialChangeMarkers: OfficialChangeMarker[];
  unmatchedOfficialChangeMarkers: OfficialChangeMarker[];
  reasons: Array<
    | "corporate_action_coverage_incomplete"
    | "corporate_action_adjustment_unavailable"
    | "corporate_action_prior_close_mismatch"
    | "unmatched_official_change_marker_present"
    | "market_transition_or_historical_market_mismatch"
    | "multiple_observed_names"
    | "no_stock_data"
    | "stock_data_unavailable"
  >;
}

export interface CompanyReactionSignals {
  companyCode: string;
  companyName: string;
  market: CompanyMarket;
  benchmarkCode: BenchmarkSource["benchmarkCode"];
  requestedAsOf: "latest" | string;
  resolvedAsOf: string;
  stockDataStatus: ReactionStockDataStatus;
  stockDataFailure: ReactionStockDataFailure | null;
  returns: ReturnReactionSignal[];
  liquidity: {
    averageVolume5SessionsShares: AverageWindowSignal;
    averageVolume20SessionsShares: AverageWindowSignal;
    volume5To20Ratio: RatioSignal;
    averageTurnover20SessionsTwd: AverageWindowSignal;
    averageTurnover60SessionsTwd: AverageWindowSignal;
    turnover20To60Ratio: RatioSignal;
  };
  pricePath: PricePathSignal;
  comparability: ReactionComparability;
  dataQualityComplete: boolean;
  warnings: string[];
}

export interface ReactionWorkBudget {
  limit: 48;
  consumed: number;
  benchmarkUnits: number;
  stockUnits: number;
  unitDefinition: "one_official_market_month_request";
  corporateActionRequests: number;
  corporateActionRequestDefinition: "one_official_range_or_detail_request";
}

export interface ReactionPagination {
  snapshotId: string;
  requestedCompanyCount: number;
  requestedPageSize: number;
  pageStartIndex: number;
  returnedCompanyCount: number;
  nextCompanyIndex: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface StockReactionSignalsResult {
  query: {
    companyCodes: string[];
    asOf: "latest" | string;
    horizons: ReactionHorizon[];
    pageSize: number;
  };
  timezone: "Asia/Taipei";
  currency: "TWD";
  priceBasis: "raw_unadjusted";
  returnBasis: "price_index_compatible_corporate_action_adjusted";
  benchmarkBasis: "price_index";
  asOf: {
    requested: "latest" | string;
    resolvedByMarket: Array<{ market: CompanyMarket; date: string }>;
  };
  coverage: {
    selectionComplete: true;
    benchmarkHistoryComplete: true;
    corporateActionHistoryComplete: boolean;
    dataQualityComplete: boolean;
    missingCompanyCodes: [];
  };
  pagination: ReactionPagination;
  workBudget: ReactionWorkBudget;
  companies: CompanyReactionSignals[];
  benchmarkSources: BenchmarkSource[];
  stockSources: PriceSource[];
  corporateActionSources: CorporateActionSource[];
  warnings: string[];
}
