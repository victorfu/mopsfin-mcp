import type { companyMasterClient } from "@/lib/company-master/client";
import type { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import type { stockPriceSeriesClient } from "@/lib/price-series/client";
import type { StockPriceSeriesBar, StockPriceSeriesBasis } from "@/lib/price-series/types";
import type { BenchmarkClient } from "@/lib/reaction/benchmark-client";

export const TECHNICAL_INDICATORS = ["sma", "rsi", "historical_volatility", "breakout", "volume_ratio"] as const;
export type TechnicalIndicator = typeof TECHNICAL_INDICATORS[number];
export interface StockTechnicalsQuery {
  companyCode: string;
  asOf: string;
  priceBasis: StockPriceSeriesBasis;
  indicators: TechnicalIndicator[];
  smaPeriods: number[];
}
export interface TechnicalDependencies {
  master: Pick<typeof companyMasterClient, "listCompanies">;
  resolver: Pick<typeof completedSessionResolver, "resolve">;
  benchmark: Pick<BenchmarkClient, "getHistory">;
  prices: Pick<typeof stockPriceSeriesClient, "getStockPriceSeries">;
  now: () => Date;
}


export interface IndicatorResult {
  value: number | boolean | null;
  status: "available" | "unavailable";
  reason: string | null;
  unit: string;
  priceBasis: StockPriceSeriesBasis | "raw_shares";
  calculationVersion: string;
  window: { from: string | null; through: string; expectedSessions: number; observedSessions: number };
  details: Record<string, number | string | boolean | null>;
}
export interface TechnicalWindowInput {
  bars: readonly StockPriceSeriesBar[];
  /** Authoritative market sessions, not just dates on which this stock traded. */
  sessions: readonly string[];
  asOf: string;
  priceBasis: StockPriceSeriesBasis;
}

