import { stockPriceSeriesClient } from "@/lib/price-series/client";

import {
  stockPriceSeriesInputSchema,
  stockPriceSeriesOutputSchema,
} from "../schema/price-series";
import { defineTool } from "./definition";
import {
  annotations,
  selectorFreshness,
  success,
} from "./shared";

export const getStockPriceSeriesTool = defineTool(
  "get_stock_price_series",
  {
    title: "查詢台股 raw 或公司行動調整價格序列",
    description:
      "查詢單一四碼台股在含頭含尾 YYYY-MM-DD 範圍內的完整日線序列，最多 36 個日曆月份。price_basis=raw_unadjusted 只收集官方原始未還原權值 OHLC，完全不查公司行動；price_index_compatible_corporate_action_adjusted 則使用 TWSE／TPEx official actual-result 公司行動，以最後一根實際 raw bar 為 factor=1 的 backward anchor，並同時保留 raw 與 adjusted OHLC。現金股利價格效果刻意保留且 cash-only factor=1，因此不是 adjusted close、股息再投資、total return 或 TSR；成交量永遠維持 raw shares。include_event_ledger 只控制 adjusted basis 是否輸出逐事件 factor、prior-close 與 marker reconciliation，不能讓 raw basis觸發公司行動查詢。公司 identity、官方 history coverage、factor、prior close、同日多事件或 change marker 任一證據不足時，受影響 adjusted 值固定為 null，絕不回退 raw。單次呼叫內最多安全收齊 3 個既有 get_stock_ohlc cursor pages，adjusted basis 至多再執行一次公司行動 history dependency；workBudget、coverage、sources 與 fingerprint 揭露完整 lineage。若要自行控制較長 raw 歷史的逐頁讀取，仍使用原有 get_stock_ohlc；本工具不改變其契約。",
    inputSchema: stockPriceSeriesInputSchema,
    outputSchema: stockPriceSeriesOutputSchema,
    annotations,
  },
  async ({
    company_code,
    start_date,
    end_date,
    price_basis,
    include_event_ledger,
  }) => {
      const data = await stockPriceSeriesClient.getStockPriceSeries({
        companyCode: company_code,
        startDate: start_date,
        endDate: end_date,
        priceBasis: price_basis,
        includeEventLedger: include_event_ledger,
      });
      const rawSources = data.sources.filter(
        (source) => source.stage === "raw_price",
      );
      const corporateActionSources = data.sources.filter(
        (source) => source.stage === "corporate_actions",
      );
      const unverifiedRawSources = rawSources.filter(
        (source) => source.snapshotIdentity === "unverified_empty",
      );
      const adjustedRequested =
        data.requestedPriceBasis ===
        "price_index_compatible_corporate_action_adjusted";
      const corporateActionsIncomplete =
        adjustedRequested &&
        data.coverage.corporateActions.status !== "complete";
      const adjustmentUnknown = data.adjustment.status === "unknown";
      const identityUnverified =
        data.identity.status !== "verified_current_master";

      return success(
        `${company_code}：完成 ${data.bars.length} 根日線；priceBasis=${data.requestedPriceBasis}、adjustment=${data.adjustment.status}、dataQualityComplete=${data.dataQualityComplete}。`,
        data,
        {
          selector: "range",
          resolved: {
            granularity: "date",
            from: data.bars[0]?.date ?? null,
            through: data.bars.at(-1)?.date ?? null,
          },
          snapshotId: data.fingerprint,
          source:
            unverifiedRawSources.length > 0 || corporateActionsIncomplete
              ? "partial"
              : "complete",
          universe: identityUnverified ? "unverified" : "verified",
          selection: "complete",
          values: !data.coverage.rawPrice.dataQualityComplete
            ? "partial"
            : adjustmentUnknown
              ? "unknown"
              : "complete",
          freshnessDetails: selectorFreshness({
            selector: "range",
            observedAsOf: data.adjustment.anchorDate,
            sources: data.sources,
          }),
          issues: [
            {
              code: "RAW_UNADJUSTED_OHLC_RETAINED",
              severity: "info",
              scope: "value",
              message:
                "bars 永遠保留官方 raw_unadjusted OHLC；null 不補 0，adjusted 證據不足也不以 raw 代填。",
              refs: {
                companyCodes: [company_code],
                fields: ["bars.open", "bars.high", "bars.low", "bars.close"],
                periods: [start_date, end_date],
                sourceUrls: rawSources.map((source) => source.sourceUrl),
              },
            },
            ...(adjustedRequested
              ? [
                  {
                    code: "PRICE_INDEX_COMPATIBLE_ADJUSTMENT_BASIS",
                    severity: "info" as const,
                    scope: "value" as const,
                    message:
                      "adjusted OHLC 以最後一根 raw bar 向後錨定，只移除可由 official actual-result 重算的股數變動機械斷點；現金股利 factor=1 並保留價格效果，因此不是 adjusted close、股息再投資或 total return。",
                    refs: {
                      companyCodes: [company_code],
                      fields: [
                        "bars.adjusted",
                        "bars.cumulativeFactor",
                        "adjustment.cashDividendTreatment",
                      ],
                      periods: [data.adjustment.anchorDate],
                      sourceUrls: corporateActionSources.map(
                        (source) => source.sourceUrl,
                      ),
                    },
                  },
                  {
                    code: "RAW_VOLUME_NOT_ADJUSTED",
                    severity: "info" as const,
                    scope: "value" as const,
                    message:
                      "成交量固定保留官方 raw shares，不套用價格 adjustment factor；跨股數變動事件比較量能時必須自行考量口徑。",
                    refs: {
                      companyCodes: [company_code],
                      fields: ["bars.volumeShares", "bars.volumeBasis"],
                      periods: [start_date, end_date],
                      sourceUrls: rawSources.map((source) => source.sourceUrl),
                    },
                  },
                ]
              : []),
            ...(unverifiedRawSources.length > 0
              ? [
                  {
                    code: "SOURCE_SNAPSHOT_IDENTITY_UNVERIFIED",
                    severity: "warning" as const,
                    scope: "source" as const,
                    message:
                      "部分官方 no-data response 缺少 title/date，無法把空回應驗證綁定至 requested month。",
                    refs: {
                      companyCodes: [company_code],
                      fields: ["sources.snapshotIdentity", "sources.dataMonth"],
                      periods: [],
                      sourceUrls: unverifiedRawSources.map(
                        (source) => source.sourceUrl,
                      ),
                    },
                  },
                ]
              : []),
            ...(corporateActionsIncomplete
              ? [
                  {
                    code: "CORPORATE_ACTION_HISTORY_INCOMPLETE",
                    severity: "warning" as const,
                    scope: "source" as const,
                    message:
                      "official actual-result 公司行動 history 未完整涵蓋 requested range 或 dependency 無法取得；不可把缺少事件解讀為已證明沒有事件。",
                    refs: {
                      companyCodes: [company_code],
                      fields: [
                        "coverage.corporateActions",
                        "coverageComplete",
                      ],
                      periods: [start_date, end_date],
                      sourceUrls: corporateActionSources.map(
                        (source) => source.sourceUrl,
                      ),
                    },
                  },
                ]
              : []),
            ...(adjustmentUnknown
              ? [
                  {
                    code: "PRICE_SERIES_ADJUSTMENT_UNKNOWN",
                    severity: "warning" as const,
                    scope: "value" as const,
                    message:
                      "至少一根 adjusted OHLC 因 coverage、factor、prior close、identity 或 marker 證據不足而為 null；不得回退 raw 或猜測 factor。",
                    refs: {
                      companyCodes: [company_code],
                      fields: [
                        "bars.adjusted",
                        "bars.cumulativeFactor",
                        "adjustment.unknownReasons",
                      ],
                      periods: data.bars
                        .filter((bar) => bar.adjustmentStatus === "unknown")
                        .map((bar) => bar.date),
                      sourceUrls: corporateActionSources.map(
                        (source) => source.sourceUrl,
                      ),
                    },
                  },
                ]
              : []),
            ...(identityUnverified
              ? [
                  {
                    code: "PRICE_SERIES_IDENTITY_REVIEW_REQUIRED",
                    severity: "warning" as const,
                    scope: "universe" as const,
                    message:
                      "公司未由目前 master 完整驗證，或只能由單一歷史市場 bars 推知 identity；回答時須揭露 identity.status 與 reasons。",
                    refs: {
                      companyCodes: [company_code],
                      fields: ["identity.status", "identity.reasons"],
                      periods: [start_date, end_date],
                      sourceUrls: data.sources
                        .filter((source) => source.stage === "company_master")
                        .map((source) => source.sourceUrl),
                    },
                  },
                ]
              : []),
            ...(!data.coverage.rawPrice.dataQualityComplete
              ? [
                  {
                    code: "RAW_PRICE_DATA_PARTIAL",
                    severity: "warning" as const,
                    scope: "value" as const,
                    message:
                      "至少一根官方 raw OHLC bar 有缺失欄位；請逐列檢查 qualityStatus 與 missingFields，null 不可當成 0。",
                    refs: {
                      companyCodes: [company_code],
                      fields: ["bars.qualityStatus", "bars.missingFields"],
                      periods: data.bars
                        .filter((bar) => bar.qualityStatus === "partial")
                        .map((bar) => bar.date),
                      sourceUrls: rawSources.map((source) => source.sourceUrl),
                    },
                  },
                ]
              : []),
          ],
        },
      );
  },
);

export const priceSeriesTools = [getStockPriceSeriesTool] as const;
