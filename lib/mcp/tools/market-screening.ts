import { taiwanMarketScreenClient } from "@/lib/market-screening/client";
import {
  screenTaiwanMarketCandidatesInputSchema,
  screenTaiwanMarketCandidatesOutputSchema,
} from "@/lib/mcp/schema/market-screening";

import { defineTool } from "./definition";
import {
  FRESHNESS_POLICIES,
  annotations,
  evaluateFreshness,
  fingerprint,
  success,
} from "./shared";

export const screenTaiwanMarketCandidatesTool = defineTool(
  "screen_taiwan_market_candidates",
  {
    title: "組合非金融與金融台股研究候選",
    description:
      "執行固定 balanced_market_v1 雙模型研究分流：在同一次 request 中分別原封不動執行 balanced_non_financial_v2 與 balanced_financial_v1，並完整保留 segments.nonFinancial、segments.financial 的 candidates、funnel、來源、warnings、model identity、bucket、within-model rank 與 evidence。caller 分別設定 non_financial_limit 與 financial_limit（各 1–5，預設 4／1）；quota 在 merge 前獨立套用，任一 segment 候選不足時不自動補額，也不以另一 segment 的較差或額外候選填滿。輸出固定 crossModelScoreComparable=false；combined shortlist 只依 bucket priority、固定 non-financial-before-financial segment priority、withinModelRank 與 company code 排序，絕不讀取、正規化或比較跨模型 raw overallScore。任一 segment execution 失敗時整個組合 request fail closed，不回傳看似完整的單邊結果。兩個底層 screen 仍各自受 top-10 deep／最多 5 家 reaction 限制；這不是完整全市場掃描或 point-in-time snapshot，也不是投資建議或資產配置建議。",
    inputSchema: screenTaiwanMarketCandidatesInputSchema,
    outputSchema: screenTaiwanMarketCandidatesOutputSchema,
    annotations,
  },
  async ({
    market,
    include_ky,
    non_financial_limit,
    financial_limit,
    preset,
  }) => {
    const data = await taiwanMarketScreenClient.screenTaiwanMarketCandidates({
      market,
      includeKy: include_ky,
      nonFinancialLimit: non_financial_limit,
      financialLimit: financial_limit,
      preset,
    });
    const sourceUrls = [
      ...data.segments.nonFinancial.sources.map((source) => source.sourceUrl),
      ...data.segments.financial.sources.map((source) => source.sourceUrl),
    ];
    const snapshotId = fingerprint({
      query: data.query,
      screenDefinition: data.screenDefinition,
      nonFinancial: {
        asOf: data.segments.nonFinancial.asOf,
        funnel: data.segments.nonFinancial.funnel,
        candidates: data.segments.nonFinancial.candidates,
        sources: data.segments.nonFinancial.sources,
      },
      financial: {
        asOf: data.segments.financial.asOf,
        funnel: data.segments.financial.funnel,
        mappingCoverage: data.segments.financial.mappingCoverage,
        candidates: data.segments.financial.candidates,
        sources: data.segments.financial.sources,
      },
      shortlist: data.shortlist,
      composition: data.composition,
    });
    const sourceComplete =
      data.segments.nonFinancial.coverage.sourceComplete &&
      data.segments.financial.coverage.sourceComplete;
    const valuesComplete =
      data.segments.nonFinancial.coverage.deepEvidenceComplete &&
      data.segments.nonFinancial.coverage.reactionEvidenceComplete &&
      data.segments.financial.coverage.deepEvidenceComplete &&
      data.segments.financial.coverage.reactionEvidenceComplete;
    return success(
      `台股雙模型候選組合完成：非金融 ${data.composition.returned.nonFinancial}/${data.composition.requested.nonFinancial}、金融 ${data.composition.returned.financial}/${data.composition.requested.financial}，合計 ${data.composition.returned.total}/${data.composition.requested.total}；未補額 ${data.composition.unfilled.total}。`,
      data,
      {
        selector: "latest",
        resolved: { granularity: "mixed", from: null, through: null },
        page: {
          mode: "none",
          unit: "none",
          limit: null,
          returned: null,
          total: null,
          next: null,
        },
        snapshotId,
        source: sourceComplete ? "complete" : "partial",
        universe: "unverified",
        selection: "complete",
        values: valuesComplete ? "complete" : "partial",
        freshnessDetails: [
          evaluateFreshness({
            policy: FRESHNESS_POLICIES.unspecified,
            observedAsOf: null,
            expectedAsOf: null,
            sourceUrls,
          }),
        ],
        issues: [
          {
            code: "CROSS_MODEL_SCORE_NOT_COMPARABLE",
            severity: "info",
            scope: "value",
            message:
              "crossModelScoreComparable=false；combined order 不讀取或比較兩模型 raw overallScore。",
            refs: {
              companyCodes: data.shortlist.map((item) => item.companyCode),
              fields: [
                "screenDefinition.crossModelScoreComparable",
                "screenDefinition.mergePolicy",
                "shortlist[].withinModelScore",
              ],
              periods: [],
              sourceUrls: [],
            },
          },
          {
            code: "SEGMENT_QUOTA_NO_REFILL",
            severity: "info",
            scope: "selection",
            message:
              "segment quotas 在 merge 前各自套用；未使用 quota 不自動補額。",
            refs: {
              companyCodes: data.shortlist.map((item) => item.companyCode),
              fields: ["query", "composition", "shortlist"],
              periods: [],
              sourceUrls: [],
            },
          },
          {
            code: "BOUNDED_DUAL_MODEL_SCREEN",
            severity: "warning",
            scope: "selection",
            message:
              "兩個 segment 仍各自只做 top-10 deep／最多 5 家 reaction；組合結果不是完整全市場深篩。",
            refs: {
              companyCodes: data.shortlist.map((item) => item.companyCode),
              fields: [
                "segments.nonFinancial.workBudget",
                "segments.financial.workBudget",
              ],
              periods: [],
              sourceUrls,
            },
          },
        ],
      },
    );
  },
);

export const marketScreeningTools = [screenTaiwanMarketCandidatesTool] as const;
