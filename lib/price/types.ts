import type { CompanyMarket, CompanyMarketSelection } from "@/lib/company-master/types";

export type OhlcStatus = "traded" | "no_trade";
export type OhlcQualityStatus = "complete" | "partial" | "official_no_trade";
export type OhlcMissingField =
  | "open"
  | "high"
  | "low"
  | "close"
  | "volumeShares"
  | "turnoverTwd"
  | "tradeCount"
  | "change";

export interface OhlcBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volumeShares: number | null;
  turnoverTwd: number | null;
  tradeCount: number | null;
  change: number | null;
  changeMarker: string | null;
  market: CompanyMarket;
  status: OhlcStatus;
  qualityStatus: OhlcQualityStatus;
  missingFields: OhlcMissingField[];
}

export interface PriceUnitNormalization {
  sourceUnit: "share" | "lot" | "TWD" | "TWD_thousand" | "trade";
  outputUnit: "share" | "TWD" | "trade";
  multiplier: 1 | 1000;
}

export interface PriceSource {
  market: CompanyMarket;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  /**
   * Whether the upstream response itself exposed enough identity metadata to
   * bind it to the requested date/month. Older injected test doubles may omit
   * this field, but production PriceClient sources always set it.
   */
  snapshotIdentity?: "verified" | "unverified_empty";
  dataDate?: string;
  dataMonth?: string;
  normalization: {
    volumeShares: PriceUnitNormalization;
    turnoverTwd: PriceUnitNormalization;
    tradeCount: PriceUnitNormalization;
  };
}

export interface StockOhlcQuery {
  companyCode: string;
  startDate: string;
  endDate: string;
  cursor?: string;
}

export interface StockOhlcResult {
  query: StockOhlcQuery;
  companyCode: string;
  observedNames: string[];
  currency: "TWD";
  timezone: "Asia/Taipei";
  interval: "1d";
  priceBasis: "raw_unadjusted";
  dataQualityComplete: boolean;
  bars: OhlcBar[];
  coverage: {
    requestedStart: string;
    requestedEnd: string;
    coveredThrough: string;
    coverageComplete: boolean;
    nextCursor: string | null;
  };
  sources: PriceSource[];
  warnings: string[];
}

export interface DailyMarketOhlcQuery {
  market: CompanyMarketSelection;
  date: "latest" | string;
  companyCodes?: string[];
  universePolicy?: "compatible" | "strict_current_master";
}

export interface DailyMarketReconciliation {
  market: CompanyMarket;
  masterCount: number;
  sourceRowCount: number;
  matchedCount: number;
  marketOnlyCodes: string[];
  masterMissingCodes: string[];
  matchRatio: number;
  coverageComplete: boolean;
}

export interface DailyMarketOhlcResult {
  query: Omit<DailyMarketOhlcQuery, "universePolicy"> & {
    universePolicy: "compatible" | "strict_current_master";
  };
  dataDate: string;
  currency: "TWD";
  timezone: "Asia/Taipei";
  interval: "1d";
  priceBasis: "raw_unadjusted";
  classificationMethod: "current_master" | "historical_code_rule";
  classificationPolicy:
    | "current_master_strict"
    | "current_master_with_code_fallback"
    | "historical_code_rule";
  coverageComplete: true;
  universeCoverageVerified: boolean;
  dataQualityComplete: boolean;
  reconciliation: DailyMarketReconciliation[];
  selectionComplete: boolean;
  missingCompanyCodes: string[];
  counts: {
    listed: number;
    otc: number;
    returned: number;
  };
  bars: Array<OhlcBar & { code: string; name: string }>;
  sources: PriceSource[];
  warnings: string[];
}
