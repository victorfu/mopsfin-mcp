import type {
  FinancialScreenCandidate,
  TaiwanFinancialScreenResult,
} from "@/lib/financial-screening/types";
import type {
  TaiwanStockScreenCandidate,
  TaiwanStockScreenResult,
} from "@/lib/screening/types";

export const TAIWAN_MARKET_SCREEN_PRESET = "balanced_market_v1" as const;
export const TAIWAN_MARKET_SCREEN_DEFINITION = "taiwan_market_screen.v1" as const;

export type MarketScreenSegment = "non_financial" | "financial";

export interface TaiwanMarketScreenQuery {
  market: "all" | "listed" | "otc";
  includeKy: boolean;
  nonFinancialLimit: number;
  financialLimit: number;
  preset: typeof TAIWAN_MARKET_SCREEN_PRESET;
}

export interface MarketScreenShortlistItem {
  combinedRank: number;
  segment: MarketScreenSegment;
  segmentPriority: 0 | 1;
  segmentQuota: number;
  companyCode: string;
  companyName: string;
  market: "listed" | "otc";
  financialSubtype: FinancialScreenCandidate["financialSubtype"] | null;
  modelId: "taiwan_stock_screen.v2" | "taiwan_financial_screen.v1";
  modelPreset: "balanced_non_financial_v2" | "balanced_financial_v1";
  withinModelRank: number;
  withinModelScore: number | null;
  scoreComparisonScope: "within_model_only";
  bucket: TaiwanStockScreenCandidate["bucket"];
}

export interface TaiwanMarketScreenResult {
  query: TaiwanMarketScreenQuery;
  generatedAt: string;
  timezone: "Asia/Taipei";
  screenDefinition: {
    id: typeof TAIWAN_MARKET_SCREEN_DEFINITION;
    preset: typeof TAIWAN_MARKET_SCREEN_PRESET;
    posture: "research_triage_not_recommendation";
    crossModelScoreComparable: false;
    segmentFailurePolicy: "fail_combined_request";
    mergePolicy: {
      quotaAppliedBeforeMerge: true;
      bucketPriority: Array<
        "research_candidate" | "watchlist" | "insufficient_data" | "deprioritized"
      >;
      segmentPriority: ["non_financial", "financial"];
      finalTieBreak: "within_model_rank_then_company_code";
      compareRawOverallScoreAcrossModels: false;
      refillUnusedQuotaAcrossSegments: false;
    };
  };
  segments: {
    nonFinancial: TaiwanStockScreenResult;
    financial: TaiwanFinancialScreenResult;
  };
  shortlist: MarketScreenShortlistItem[];
  composition: {
    requested: {
      nonFinancial: number;
      financial: number;
      total: number;
    };
    returned: {
      nonFinancial: number;
      financial: number;
      total: number;
    };
    unfilled: {
      nonFinancial: number;
      financial: number;
      total: number;
    };
    nonFinancialResultPreserved: true;
    financialResultPreserved: true;
  };
  warnings: string[];
}
