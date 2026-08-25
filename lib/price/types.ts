import type { CompanyMarket, CompanyMarketSelection } from "@/lib/company-master/types";

export type OhlcStatus = "traded" | "no_trade";

export interface OhlcBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  market: CompanyMarket;
  status: OhlcStatus;
}

export interface PriceSource {
  market: CompanyMarket;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  dataDate?: string;
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
}

export interface DailyMarketOhlcResult {
  query: DailyMarketOhlcQuery;
  dataDate: string;
  currency: "TWD";
  timezone: "Asia/Taipei";
  interval: "1d";
  priceBasis: "raw_unadjusted";
  classificationMethod: "current_master" | "historical_code_rule";
  coverageComplete: true;
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
