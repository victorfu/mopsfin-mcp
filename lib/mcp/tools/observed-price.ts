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
  success,
} from "./shared";

export const analyzeObservedPriceTool = defineTool(
  "analyze_observed_price",
  {
    title: "比較 caller 觀察價與官方最近完成收盤價",
    description:
      "分析單一目前上市櫃公司的 caller-supplied 觀察價格，相對於 TWSE／TPEx 官方最近完成交易日 raw_unadjusted 收盤價的絕對與百分比差異。caller 必須明示 observed_price_twd、含 Z 或 UTC offset 的 observed_at，以及 source_label；觀察值不會被冒充成官方、即時或 real-time 行情。工具以 market=all 目前公司 master 核對 identity；listed／otc 來源各自驗證 schema、coverage、reportDate 與 provenance，但不要求兩市場 reportDate 同日，指定代號仍必須跨來源唯一。request start 固定 evaluatedAt 後，由公司所屬市場的官方年度開休市日曆與 exact benchmark session 解析 authoritative expectedAsOf，再只查該日 exact single-stock OHLC。resolver、selected bar 與公開 close date 必須完全一致；unresolved、缺少 exact bar、identity 不符或無有效正數 close 時 fail closed，不會退回可能落後的全市場 latest snapshot 或前一日價格。同日比較須晚於 13:33 Asia/Taipei 的保守 regular-session completion guard。輸出分開 CALLER_SUPPLIED、OFFICIAL_MASTER_RAW、OFFICIAL_MARKET_RAW 與 MOPSFIN_CALC provenance，保留兩市場各自的 master freshness、單股官方價格來源、cache refresh、dependency ledger、官方 history cutoff 與 resolver evidence 的實際／最大 logical source-load budget。價差只是機械比較，不是 fair value、合理進場區、adjusted close、目標價、買賣評級或投資建議；本工具也不是外部盤中 quote provider。",
    inputSchema: analyzeObservedPriceInputSchema,
    outputSchema: analyzeObservedPriceOutputSchema,
    annotations,
  },
  async ({ company_code, observed_price_twd, observed_at, source_label }) => {
    try {
      const { data, completedClose } =
        await observedPriceClient.analyzeObservedPriceWithContext({
          companyCode: company_code,
          observedPriceTwd: observed_price_twd,
          observedAt: observed_at,
          sourceLabel: source_label,
        });
      const metaContract = observedPriceMetaContract(
        data,
        completedClose.resolverEvidence,
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
