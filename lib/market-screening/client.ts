import {
  taiwanFinancialScreenClient,
  type TaiwanFinancialScreenClient,
} from "@/lib/financial-screening/client";
import {
  taiwanStockScreenClient,
  type TaiwanStockScreenClient,
} from "@/lib/screening/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { ScreenCandidateBucket } from "@/lib/screening/types";

import {
  TAIWAN_MARKET_SCREEN_DEFINITION,
  TAIWAN_MARKET_SCREEN_PRESET,
  type MarketScreenSegment,
  type MarketScreenShortlistItem,
  type TaiwanMarketScreenQuery,
  type TaiwanMarketScreenResult,
} from "./types";

type NonFinancialScreenLike = Pick<
  TaiwanStockScreenClient,
  "screenTaiwanStockCandidates"
>;
type FinancialScreenLike = Pick<
  TaiwanFinancialScreenClient,
  "screenTaiwanFinancialCandidates"
>;

export interface TaiwanMarketScreenClientDependencies {
  nonFinancialScreen?: NonFinancialScreenLike;
  financialScreen?: FinancialScreenLike;
}

const BUCKET_PRIORITY: Record<ScreenCandidateBucket, number> = {
  research_candidate: 0,
  watchlist: 1,
  insufficient_data: 2,
  deprioritized: 3,
};

const SEGMENT_PRIORITY: Record<MarketScreenSegment, 0 | 1> = {
  non_financial: 0,
  financial: 1,
};

function normalizeQuery(query: TaiwanMarketScreenQuery): TaiwanMarketScreenQuery {
  if (!( ["all", "listed", "otc"] as const).includes(query.market)) {
    throw new MopsfinError("INVALID_ARGUMENT", "market 必須是 all、listed 或 otc。");
  }
  if (query.preset !== TAIWAN_MARKET_SCREEN_PRESET) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `preset 目前只支援 ${TAIWAN_MARKET_SCREEN_PRESET}。`,
    );
  }
  for (const [name, value] of [
    ["non_financial_limit", query.nonFinancialLimit],
    ["financial_limit", query.financialLimit],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        `${name} 必須是 1 至 5 的整數。`,
      );
    }
  }
  if (typeof query.includeKy !== "boolean") {
    throw new MopsfinError("INVALID_ARGUMENT", "include_ky 必須是 boolean。");
  }
  return { ...query };
}

function compareShortlist(
  left: MarketScreenShortlistItem,
  right: MarketScreenShortlistItem,
): number {
  return BUCKET_PRIORITY[left.bucket] - BUCKET_PRIORITY[right.bucket] ||
    left.segmentPriority - right.segmentPriority ||
    left.withinModelRank - right.withinModelRank ||
    left.companyCode.localeCompare(right.companyCode);
}

export class TaiwanMarketScreenClient {
  private readonly nonFinancialScreen: NonFinancialScreenLike;
  private readonly financialScreen: FinancialScreenLike;

  constructor(
    dependencies: TaiwanMarketScreenClientDependencies = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.nonFinancialScreen =
      dependencies.nonFinancialScreen ?? taiwanStockScreenClient;
    this.financialScreen =
      dependencies.financialScreen ?? taiwanFinancialScreenClient;
  }

  async screenTaiwanMarketCandidates(
    rawQuery: TaiwanMarketScreenQuery,
  ): Promise<TaiwanMarketScreenResult> {
    const query = normalizeQuery(rawQuery);
    const [nonFinancial, financial] = await Promise.all([
      this.nonFinancialScreen.screenTaiwanStockCandidates({
        market: query.market,
        includeKy: query.includeKy,
        candidateLimit: query.nonFinancialLimit,
        preset: "balanced_non_financial_v2",
      }),
      this.financialScreen.screenTaiwanFinancialCandidates({
        market: query.market,
        includeKy: query.includeKy,
        candidateLimit: query.financialLimit,
        preset: "balanced_financial_v1",
      }),
    ]);

    const nonFinancialSelected = nonFinancial.candidates
      .slice(0, query.nonFinancialLimit)
      .map((candidate): MarketScreenShortlistItem => ({
        combinedRank: 0,
        segment: "non_financial",
        segmentPriority: SEGMENT_PRIORITY.non_financial,
        segmentQuota: query.nonFinancialLimit,
        companyCode: candidate.companyCode,
        companyName: candidate.shortName,
        market: candidate.market,
        financialSubtype: null,
        modelId: "taiwan_stock_screen.v2",
        modelPreset: "balanced_non_financial_v2",
        withinModelRank: candidate.rank,
        withinModelScore: candidate.overallScore,
        scoreComparisonScope: "within_model_only",
        bucket: candidate.bucket,
      }));
    const financialSelected = financial.candidates
      .slice(0, query.financialLimit)
      .map((candidate): MarketScreenShortlistItem => ({
        combinedRank: 0,
        segment: "financial",
        segmentPriority: SEGMENT_PRIORITY.financial,
        segmentQuota: query.financialLimit,
        companyCode: candidate.companyCode,
        companyName: candidate.shortName,
        market: candidate.market,
        financialSubtype: candidate.financialSubtype,
        modelId: "taiwan_financial_screen.v1",
        modelPreset: "balanced_financial_v1",
        withinModelRank: candidate.rank,
        withinModelScore: candidate.overallScore,
        scoreComparisonScope: "within_model_only",
        bucket: candidate.bucket,
      }));
    const shortlist = [...nonFinancialSelected, ...financialSelected].sort(
      compareShortlist,
    );
    shortlist.forEach((candidate, index) => {
      candidate.combinedRank = index + 1;
    });
    const requested = {
      nonFinancial: query.nonFinancialLimit,
      financial: query.financialLimit,
      total: query.nonFinancialLimit + query.financialLimit,
    };
    const returned = {
      nonFinancial: nonFinancialSelected.length,
      financial: financialSelected.length,
      total: shortlist.length,
    };
    const unfilled = {
      nonFinancial: requested.nonFinancial - returned.nonFinancial,
      financial: requested.financial - returned.financial,
      total: requested.total - returned.total,
    };

    return {
      query,
      generatedAt: this.now().toISOString(),
      timezone: "Asia/Taipei",
      screenDefinition: {
        id: TAIWAN_MARKET_SCREEN_DEFINITION,
        preset: TAIWAN_MARKET_SCREEN_PRESET,
        posture: "research_triage_not_recommendation",
        crossModelScoreComparable: false,
        segmentFailurePolicy: "fail_combined_request",
        mergePolicy: {
          quotaAppliedBeforeMerge: true,
          bucketPriority: [
            "research_candidate",
            "watchlist",
            "insufficient_data",
            "deprioritized",
          ],
          segmentPriority: ["non_financial", "financial"],
          finalTieBreak: "within_model_rank_then_company_code",
          compareRawOverallScoreAcrossModels: false,
          refillUnusedQuotaAcrossSegments: false,
        },
      },
      segments: { nonFinancial, financial },
      shortlist,
      composition: {
        requested,
        returned,
        unfilled,
        nonFinancialResultPreserved: true,
        financialResultPreserved: true,
      },
      warnings: [
        "crossModelScoreComparable=false；合併排序不讀取或比較兩個模型的 raw overallScore。",
        "segment quota 在合併前各自套用；任一 segment 候選不足時不自動補額。",
        "兩個 segments 保留各自完整 bounded screen 結果；合併不消除 top-10 deep／最多 5 家 reaction 的限制。",
        "這是 research triage 組合，不是完整全市場掃描、投資建議或資產配置建議。",
      ],
    };
  }
}

export const taiwanMarketScreenClient = new TaiwanMarketScreenClient();
