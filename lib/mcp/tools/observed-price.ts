import { observedPriceClient } from "@/lib/observed-price/client";

import {
  analyzeObservedPriceInputSchema,
  analyzeObservedPriceOutputSchema,
} from "../schema/observed-price";
import {
  observedPriceMetaContract,
  observedPriceQualityIssues,
} from "../observed-price-meta-contract";
import { defineTool } from "./definition";
import {
  annotations,
  failure,
  resolveOfficialCompletedSessionFreshness,
  success,
} from "./shared";

export const analyzeObservedPriceTool = defineTool(
  "analyze_observed_price",
  {
    title: "比較 caller 觀察價與官方最近完成收盤價",
    description:
      "分析單一目前上市櫃公司的 caller-supplied 觀察價格，相對於 TWSE／TPEx 官方最近完成交易日 raw_unadjusted 收盤價的絕對與百分比差異。caller 必須明示 observed_price_twd、含 Z 或 UTC offset 的 observed_at，以及 source_label；觀察值不會被冒充成官方、即時或 real-time 行情。工具先以 market=all 目前公司 master 核對 identity；官方價格 dependency 採 compatible current-master reconciliation，逐市場至少 95% match ratio 以拒絕疑似截斷來源，再由外層 master 與官方行情列精確核對指定公司的 code、name、market。非目標公司的母體差異不會阻斷查詢；同日比較須晚於 13:33 Asia/Taipei 的保守 regular-session completion guard，latest baseline freshness 另由公司所屬市場的官方年度開休市日曆與 exact benchmark session 驗證。輸出分開 CALLER_SUPPLIED、OFFICIAL_MASTER_RAW、OFFICIAL_MARKET_RAW 與 MOPSFIN_CALC provenance，保留 listed／otc master、官方價格來源、cache 時序、dependency ledger、官方 history cutoff 與 freshness meta-layer 的實際／最大 logical source-load budget。價差只是機械比較，不是 fair value、合理進場區、adjusted close、目標價、買賣評級或投資建議；本工具也不是外部盤中 quote provider。",
    inputSchema: analyzeObservedPriceInputSchema,
    outputSchema: analyzeObservedPriceOutputSchema,
    annotations,
  },
  async ({ company_code, observed_price_twd, observed_at, source_label }) => {
    try {
      const data = await observedPriceClient.analyzeObservedPrice({
        companyCode: company_code,
        observedPriceTwd: observed_price_twd,
        observedAt: observed_at,
        sourceLabel: source_label,
      });
      const officialFreshness = (
        await resolveOfficialCompletedSessionFreshness({
          market: data.company.market,
          observations: [
            {
              market: data.company.market,
              observedAsOf: data.latestOfficialCloseDate,
              sources: data.sources.filter(
                (source) =>
                  source.stage === "latest_official_completed_close",
              ),
            },
          ],
        })
      )[0];
      if (!officialFreshness?.resolverEvidence) {
        throw new TypeError("completed-session resolver 必須回傳 evidence。");
      }
      const metaContract = observedPriceMetaContract(
        data,
        officialFreshness.resolverEvidence,
      );
      return success(
        `${data.company.code} ${data.company.shortName}：caller 觀察價 ${data.observedPriceTwd} TWD，相對 ${data.latestOfficialCloseDate} 官方完成收盤 ${data.latestOfficialCompletedClose} TWD 為 ${data.changeFromOfficialClosePercent}%；這不是官方即時行情或投資建議。`,
        data,
        {
          selector: "snapshot",
          resolved: { granularity: "mixed", from: null, through: null },
          snapshotId: metaContract.snapshotId,
          source: "partial",
          universe: "unverified",
          selection: "complete",
          values: "complete",
          freshnessDetails: metaContract.freshnessDetails,
          issues: observedPriceQualityIssues(data),
        },
      );
    } catch (error) {
      return failure(error);
    }
  },
);

export const observedPriceTools = [analyzeObservedPriceTool] as const;
