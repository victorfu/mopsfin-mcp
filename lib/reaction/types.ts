import type { CompanyMarket } from "@/lib/company-master/types";
import type { PriceSource } from "@/lib/price/types";

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
  | "missing_stock_start_close"
  | "missing_stock_end_close"
  | "incomplete_stock_window"
  | "invalid_denominator";

export type ExcessReturnStatus = ReactionSignalStatus | "not_comparable";

export type ExcessReturnComparabilityReason =
  | "official_change_marker_within_horizon"
  | "market_transition_or_historical_market_mismatch_within_horizon"
  | "multiple_observed_names";

export interface ReturnReactionSignal {
  horizonSessions: ReactionHorizon;
  startDate: string;
  endDate: string;
  stockReturnPercent: number | null;
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
  status: ReactionSignalStatus;
}

export interface OfficialChangeMarker {
  date: string;
  marker: string;
}

export interface ReactionComparability {
  status: "provisional_raw" | "not_comparable" | "unavailable";
  priceBasis: "raw_unadjusted";
  corporateActionAdjustment: "not_applied";
  corporateActionEvidence: "official_marker_present" | "none_observed";
  marketTransitionDetected: boolean;
  observedMarkets: CompanyMarket[];
  officialChangeMarkers: OfficialChangeMarker[];
  reasons: Array<
    | "raw_prices_not_adjusted"
    | "official_change_marker_present"
    | "market_transition_or_historical_market_mismatch"
    | "multiple_observed_names"
    | "no_stock_data"
  >;
}

export interface CompanyReactionSignals {
  companyCode: string;
  companyName: string;
  market: CompanyMarket;
  benchmarkCode: BenchmarkSource["benchmarkCode"];
  requestedAsOf: "latest" | string;
  resolvedAsOf: string;
  stockDataStatus: "available" | "no_data";
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
  benchmarkBasis: "price_index";
  asOf: {
    requested: "latest" | string;
    resolvedByMarket: Array<{ market: CompanyMarket; date: string }>;
  };
  coverage: {
    selectionComplete: true;
    benchmarkHistoryComplete: true;
    dataQualityComplete: boolean;
    missingCompanyCodes: [];
  };
  pagination: ReactionPagination;
  workBudget: ReactionWorkBudget;
  companies: CompanyReactionSignals[];
  benchmarkSources: BenchmarkSource[];
  stockSources: PriceSource[];
  warnings: string[];
}
