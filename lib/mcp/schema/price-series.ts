import { z } from "zod";

import {
  calendarDateSchema,
  sourceCacheObservationSchema,
  successResultShape,
  warningShape,
} from "./common";

const priceBasisSchema = z
  .enum([
    "raw_unadjusted",
    "price_index_compatible_corporate_action_adjusted",
  ])
  .describe(
    "價格序列基礎：raw_unadjusted=官方原始未還原權值 OHLC；price_index_compatible_corporate_action_adjusted=以官方 actual-result 公司行動作 backward factor 調整，只移除股數變動機械斷點並保留現金股利價格效果",
  );

function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function inclusiveCalendarMonths(startDate: string, endDate: string): number {
  const [startYear, startMonth] = startDate.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = endDate.slice(0, 7).split("-").map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth + 1;
}

export const stockPriceSeriesInputSchema = z
  .object({
    company_code: z
      .string()
      .regex(/^\d{4}$/)
      .describe(
        "單一四碼台股公司股票代號；可使用目前公司母體或能由官方歷史 bars 唯一推知市場的歷史代號",
      ),
    start_date: calendarDateSchema.describe(
      "含頭的 YYYY-MM-DD 起始日；與 end_date 合計最多 36 個日曆月份",
    ),
    end_date: calendarDateSchema.describe(
      "含尾的 YYYY-MM-DD 結束日，不得早於 start_date 或晚於 Asia/Taipei 今日",
    ),
    price_basis: priceBasisSchema,
    include_event_ledger: z
      .boolean()
      .describe(
        "是否在 adjusted basis 回傳逐筆官方公司行動、factor、prior-close 與 marker reconciliation ledger；raw basis 不會因此查公司行動，ledger 仍為空",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isRealCalendarDate(value.start_date)) {
      context.addIssue({
        code: "custom",
        path: ["start_date"],
        message: "start_date 不是有效日曆日期",
      });
    }
    if (!isRealCalendarDate(value.end_date)) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date 不是有效日曆日期",
      });
    }
    if (value.start_date > value.end_date) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date 不得早於 start_date",
      });
    } else if (
      isRealCalendarDate(value.start_date) &&
      isRealCalendarDate(value.end_date) &&
      inclusiveCalendarMonths(value.start_date, value.end_date) > 36
    ) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "價格序列查詢最多涵蓋 36 個日曆月份",
      });
    }
  });

const marketSchema = z
  .enum(["listed", "otc"])
  .describe("官方資料所屬市場：listed=TWSE 上市、otc=TPEx 上櫃");

const adjustmentUnknownReasonSchema = z
  .enum([
    "corporate_action_coverage_incomplete",
    "corporate_action_factor_unavailable",
    "cash_only_factor_not_one",
    "ambiguous_same_day_corporate_actions",
    "corporate_action_prior_close_missing",
    "corporate_action_prior_close_mismatch",
    "unmatched_official_change_marker",
    "market_transition_or_historical_market_mismatch",
    "corporate_action_market_mismatch",
    "company_identity_name_mismatch",
    "corporate_action_company_code_mismatch",
    "duplicate_raw_bar_date",
  ])
  .describe(
    "使 price-index-compatible factor 無法安全推導的穩定原因；非空時受影響 adjusted OHLC 必須為 null，不能回退 raw",
  );

const missingFieldSchema = z
  .enum([
    "open",
    "high",
    "low",
    "close",
    "volumeShares",
    "turnoverTwd",
    "tradeCount",
    "change",
  ])
  .describe("官方日線中缺失或無法解析的標準化欄位名稱");

const rawOhlcShape = {
  date: calendarDateSchema.describe("此根官方日線的實際交易日期"),
  open: z
    .number()
    .nullable()
    .describe("官方原始未還原權值開盤價；無成交或缺值時為 null"),
  high: z
    .number()
    .nullable()
    .describe("官方原始未還原權值最高價；無成交或缺值時為 null"),
  low: z
    .number()
    .nullable()
    .describe("官方原始未還原權值最低價；無成交或缺值時為 null"),
  close: z
    .number()
    .nullable()
    .describe("官方原始未還原權值收盤價；無成交或缺值時為 null"),
  volumeShares: z
    .number()
    .nullable()
    .describe("官方成交量正規化後的股數；0 保留為 0，缺值才是 null"),
  turnoverTwd: z
    .number()
    .nullable()
    .describe("官方成交金額正規化後的 TWD；0 保留為 0，缺值才是 null"),
  tradeCount: z
    .number()
    .nullable()
    .describe("官方成交筆數；0 保留為 0，缺值才是 null"),
  change: z
    .number()
    .nullable()
    .describe("官方相對前一交易日的原始漲跌價差；無法取得時為 null"),
  changeMarker: z
    .string()
    .nullable()
    .describe("由官方漲跌欄分離的除權息或其他 marker 原文；沒有時為 null"),
  market: marketSchema,
  status: z
    .enum(["traded", "no_trade"])
    .describe("traded=有有效 OHLC；no_trade=官方明列但沒有成交價格"),
  qualityStatus: z
    .enum(["complete", "partial", "official_no_trade"])
    .describe(
      "原始 bar 品質：complete=必要價量完整、partial=至少一欄缺失、official_no_trade=官方明列無成交",
    ),
  missingFields: z
    .array(missingFieldSchema)
    .describe("此根原始日線缺失或無法解析的欄位；不可把缺值改寫為 0"),
};

const adjustedOhlcSchema = z
  .object({
    open: z
      .number()
      .nullable()
      .describe("原始 open 乘 cumulativeFactor；原始值缺失時維持 null"),
    high: z
      .number()
      .nullable()
      .describe("原始 high 乘 cumulativeFactor；原始值缺失時維持 null"),
    low: z
      .number()
      .nullable()
      .describe("原始 low 乘 cumulativeFactor；原始值缺失時維持 null"),
    close: z
      .number()
      .nullable()
      .describe("原始 close 乘 cumulativeFactor；不是 adjusted close 或 total return"),
  })
  .strict()
  .describe("同一交易日的 price-index-compatible corporate-action-adjusted OHLC");

const stockPriceSeriesBarSchema = z
  .object({
    ...rawOhlcShape,
    cumulativeFactor: z
      .number()
      .positive()
      .nullable()
      .describe(
        "由最後一根 raw bar 向後錨定的累積 price-index-compatible factor；未要求或證據不足時為 null",
      ),
    adjusted: adjustedOhlcSchema
      .nullable()
      .describe(
        "調整後 OHLC；只在該 bar adjustmentStatus=complete 時提供，unknown 時必須為 null 且不得以 raw 代填",
      ),
    adjustmentStatus: z
      .enum(["not_requested", "complete", "unknown"])
      .describe(
        "not_requested=raw basis 未執行、complete=factor 證據完整、unknown=必要證據不足",
      ),
    adjustmentUnknownReasons: z
      .array(adjustmentUnknownReasonSchema)
      .describe("此 bar 無法安全形成 adjusted OHLC 的穩定原因；完整或未要求時為空"),
    volumeBasis: z
      .literal("raw_shares")
      .describe("成交量永遠保留官方 raw shares，不隨價格 factor 調整"),
  })
  .strict()
  .superRefine((bar, context) => {
    if (bar.adjustmentStatus === "not_requested") {
      if (
        bar.cumulativeFactor !== null ||
        bar.adjusted !== null ||
        bar.adjustmentUnknownReasons.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["adjustmentStatus"],
          message:
            "not_requested bar 必須沒有 factor、adjusted OHLC 或 unknown reasons",
        });
      }
    } else if (bar.adjustmentStatus === "complete") {
      if (
        bar.cumulativeFactor === null ||
        bar.adjusted === null ||
        bar.adjustmentUnknownReasons.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["adjustmentStatus"],
          message:
            "complete bar 必須有正 factor 與 adjusted OHLC，且沒有 unknown reasons",
        });
      }
    } else if (
      bar.cumulativeFactor !== null ||
      bar.adjusted !== null ||
      bar.adjustmentUnknownReasons.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["adjustmentStatus"],
        message:
          "unknown bar 必須將 factor 與 adjusted OHLC 保留為 null，並說明至少一個原因",
      });
    }
  })
  .describe(
    "逐交易日同時保留 raw OHLC 與可選 adjusted OHLC；任何 adjustment 不確定都 fail closed",
  );

const priceUnitNormalizationSchema = z
  .object({
    sourceUnit: z
      .enum(["share", "lot", "TWD", "TWD_thousand", "trade"])
      .describe("官方來源欄位原始單位"),
    outputUnit: z
      .enum(["share", "TWD", "trade"])
      .describe("MCP 標準化後輸出單位"),
    multiplier: z
      .union([z.literal(1), z.literal(1000)])
      .describe("由 sourceUnit 轉成 outputUnit 實際套用的倍率"),
  })
  .strict()
  .describe("一個官方價量欄位的單位正規化規則");

const companyMasterSourceSchema = z
  .object({
    stage: z
      .literal("company_master")
      .describe("此來源在序列 orchestration 中用於公司 identity 核對"),
    market: marketSchema,
    exchange: z.enum(["TWSE", "TPEx"]).describe("提供公司母體的官方市場機構"),
    sourceName: z.string().describe("官方公司基本資料集名稱"),
    sourceUrl: z.string().url().describe("本次公司母體查詢的固定官方 URL"),
    reportDate: calendarDateSchema.describe("公司母體官方出表日期"),
    retrievedAt: z.string().describe("本服務取得此公司母體回應的 ISO 8601 時間"),
    rawCount: z.number().int().nonnegative().describe("排除 TDR 前的來源原始公司列數"),
    excludedTdrCount: z.number().int().nonnegative().describe("此來源排除的 TDR 筆數"),
    companyCount: z.number().int().nonnegative().describe("排除 TDR 後的公司筆數"),
    minimumExpectedCount: z
      .number()
      .int()
      .nonnegative()
      .describe("偵測明顯截斷回應的最低筆數 heuristic；不是官方 declared count"),
    cache: sourceCacheObservationSchema
      .optional()
      .describe("公司母體來源的 caller-specific cache provenance"),
  })
  .strict()
  .describe("公司 identity 核對實際使用的一份 TWSE／TPEx official master source");

const rawPriceSourceSchema = z
  .object({
    stage: z
      .literal("raw_price")
      .describe("此來源在序列 orchestration 中提供官方 raw OHLC"),
    market: marketSchema,
    sourceName: z.string().describe("官方個股 OHLC 資料集或查詢頁名稱"),
    sourceUrl: z.string().url().describe("本次使用的 TWSE／TPEx 官方 OHLC URL"),
    retrievedAt: z.string().describe("本服務取得此 OHLC 回應的 ISO 8601 時間"),
    snapshotIdentity: z
      .enum(["verified", "unverified_empty"])
      .optional()
      .describe(
        "verified=回應可核對 requested month；unverified_empty=空回應缺 title/date；省略只供既有 dependency 相容",
      ),
    dataDate: calendarDateSchema
      .optional()
      .describe("單日官方來源實際且已核對的資料日期；月資料通常省略"),
    dataMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .describe("個股 OHLC 回應已驗證綁定的 YYYY-MM；unverified empty 時省略"),
    normalization: z
      .object({
        volumeShares: priceUnitNormalizationSchema.describe("成交量轉換為股的規則"),
        turnoverTwd: priceUnitNormalizationSchema.describe("成交金額轉換為 TWD 的規則"),
        tradeCount: priceUnitNormalizationSchema.describe("成交筆數的來源與輸出單位規則"),
      })
      .strict()
      .describe("此 OHLC 來源價量欄位的單位正規化"),
    cache: sourceCacheObservationSchema
      .optional()
      .describe("OHLC 來源的 caller-specific cache provenance"),
  })
  .strict()
  .describe("一份實際用來組合 raw series 的官方 OHLC 月份來源");

const corporateActionFamilySchema = z
  .enum(["ex_right_dividend", "capital_reduction", "par_value_change"])
  .describe("official actual-result 公司行動資料族群");

const corporateActionSourceSchema = z
  .object({
    stage: z
      .literal("corporate_actions")
      .describe("此來源在序列 orchestration 中提供 adjustment evidence"),
    market: marketSchema,
    exchange: z.enum(["TWSE", "TPEx"]).describe("發布公司行動 actual-result 的官方機構"),
    family: corporateActionFamilySchema,
    scope: z
      .enum(["range_summary", "event_detail"])
      .describe("官方區間摘要或選定 combined-event 詳情請求"),
    sourceName: z.string().describe("官方公司行動 actual-result 資料集名稱"),
    sourceUrl: z.string().url().describe("本次實際使用的官方公司行動 URL"),
    retrievedAt: z.string().describe("本服務取得此官方回應的 ISO 8601 時間"),
    supportedFrom: calendarDateSchema.describe("此官方資料族群可驗證歷史的最早日期"),
    queryStart: calendarDateSchema.describe("本次官方公司行動查詢起日"),
    queryEnd: calendarDateSchema.describe("本次官方公司行動查詢迄日"),
    responseStart: calendarDateSchema
      .nullable()
      .describe("官方回應回顯的起日；不提供 range identity 的 detail 為 null"),
    responseEnd: calendarDateSchema
      .nullable()
      .describe("官方回應回顯的迄日；不提供 range identity 的 detail 為 null"),
    rawRowCount: z.number().int().nonnegative().describe("官方回應原始列數"),
    companyEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe("此來源正規化後的普通股公司事件數"),
    officialDeclaredRowCount: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("官方宣告列數；來源未提供時為 null"),
    officialDeclaredRowCountAvailable: z
      .boolean()
      .describe("官方回應是否提供可核對的 declared row count"),
    cache: sourceCacheObservationSchema
      .optional()
      .describe("公司行動來源的 caller-specific cache provenance"),
  })
  .strict()
  .describe("adjustment 與 event ledger 實際使用的 official actual-result 來源");

const stockPriceSeriesSourceSchema = z
  .discriminatedUnion("stage", [
    companyMasterSourceSchema,
    rawPriceSourceSchema,
    corporateActionSourceSchema,
  ])
  .describe("依 stage 區分的公司母體、raw price 或公司行動官方 lineage");

const corporateActionEventSchema = z
  .object({
    companyCode: z.string().describe("官方公司行動事件的四碼公司股票代號"),
    name: z.string().describe("官方公司行動事件顯示的公司簡稱"),
    market: marketSchema,
    effectiveDate: calendarDateSchema.describe("公司行動實際生效交易日"),
    kind: z
      .enum([
        "cash_dividend",
        "stock_rights",
        "rights_and_dividend",
        "capital_reduction",
        "par_value_change",
      ])
      .describe("正規化後的 actual-result 公司行動種類"),
    priorCloseTwd: z
      .number()
      .nullable()
      .describe("官方提供的事件前收盤價 TWD；未提供時為 null"),
    referencePriceTwd: z
      .number()
      .nullable()
      .describe("官方 actual-result 參考價 TWD；不適用或缺值時為 null"),
    cashDividendPerShareTwd: z
      .number()
      .nullable()
      .describe("每股現金股利 TWD；非現金股利或缺值時為 null"),
    priceIndexAdjustmentFactor: z
      .number()
      .positive()
      .nullable()
      .describe("依官方 actual-result 欄位推導的 price-index-compatible factor；不足時為 null"),
    shareCountChanged: z.boolean().describe("此事件是否改變每股股數口徑"),
    adjustmentStatus: z
      .enum(["available", "unavailable"])
      .describe("官方 actual-result 是否足以形成可用 factor"),
    adjustmentReason: z
      .enum([
        "cash_only_price_index_factor_is_one",
        "official_reference_price_divided_by_prior_close",
        "official_reference_price_divided_by_prior_close_less_cash_dividend",
        "missing_required_official_value",
        "twse_combined_event_detail_not_requested",
        "twse_combined_event_detail_failed",
      ])
      .describe("factor 公式或無法形成 factor 的穩定證據原因"),
    sourceFamily: corporateActionFamilySchema,
    sourceUrl: z.string().url().describe("此事件的 TWSE／TPEx official actual-result URL"),
    rawType: z.string().describe("官方原始事件類型文字，供稽核正規化"),
  })
  .strict()
  .describe("一筆用於調整判斷的官方 actual-result 公司行動事件");

const corporateActionCoverageGapBaseShape = {
  market: marketSchema,
  family: corporateActionFamilySchema,
  requestedStart: calendarDateSchema.describe("整體 requested 公司行動起日"),
  uncoveredThrough: calendarDateSchema.describe("此缺口尚未覆蓋到的日期上界"),
  supportedFrom: calendarDateSchema.describe("該官方 family 可驗證的最早日期"),
};

const corporateActionCoverageGapSchema = z
  .discriminatedUnion("reason", [
    z
      .object({
        ...corporateActionCoverageGapBaseShape,
        reason: z
          .literal("before_official_history_start")
          .describe("requested range 早於官方可驗證歷史起點"),
      })
      .strict(),
    z
      .object({
        ...corporateActionCoverageGapBaseShape,
        reason: z
          .literal("unverified_empty_response")
          .describe("官方空回應缺少足以綁定 requested range 的 identity"),
        queryStart: calendarDateSchema.describe("發生 unverified empty 的官方請求起日"),
        queryEnd: calendarDateSchema.describe("發生 unverified empty 的官方請求迄日"),
        upstreamStatus: z.string().describe("官方空回應的原始 status 文字"),
      })
      .strict(),
  ])
  .describe("使 official actual-result 公司行動歷史不完整的一段可稽核缺口");

const corporateActionCoverageSchema = z
  .object({
    status: z.enum(["complete", "partial"]).describe("公司行動 range coverage 摘要"),
    coverageComplete: z.boolean().describe("官方 history 是否完整涵蓋 requested range"),
    requestedStart: calendarDateSchema.describe("公司行動 history requested 起日"),
    requestedEnd: calendarDateSchema.describe("公司行動 history requested 迄日"),
    gaps: z
      .array(corporateActionCoverageGapSchema)
      .describe("官方可驗證歷史起點或 unverified empty 造成的 coverage 缺口"),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (
      coverage.coverageComplete !== (coverage.status === "complete") ||
      coverage.coverageComplete !== (coverage.gaps.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverageComplete"],
        message: "公司行動 coverage status、coverageComplete 與 gaps 必須一致",
      });
    }
  })
  .describe("官方 actual-result 公司行動歷史對 requested range 的覆蓋證據");

const dependencyFailureSchema = z
  .object({
    code: z
      .enum([
        "INVALID_ARGUMENT",
        "NOT_FOUND",
        "NO_DATA",
        "INCOMPLETE_COVERAGE",
        "UPSTREAM_TIMEOUT",
        "UPSTREAM_RATE_LIMITED",
        "UPSTREAM_BAD_RESPONSE",
      ])
      .describe("被隔離的公司行動 dependency 穩定錯誤代號"),
    reason: z.string().nullable().describe("更精確的穩定 failure reason；未提供時為 null"),
    message: z.string().describe("公司行動 dependency 失敗說明；raw series 仍保留"),
    retryable: z.boolean().describe("是否適合以相同條件稍後重試"),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("建議至少等待的毫秒數；沒有建議時為 null"),
    action: z
      .enum(["fix_input", "change_query", "retry", "restart_pagination", "none"])
      .describe("呼叫端針對此 dependency failure 建議採取的下一步"),
  })
  .strict()
  .describe("adjusted basis 隔離公司行動失敗時的結構化證據");

const priorCloseCheckSchema = z
  .object({
    status: z
      .enum([
        "matched",
        "official_prior_close_missing",
        "raw_prior_close_missing",
        "mismatch",
      ])
      .describe("官方 prior close 與 raw series 前一有效收盤價的核對結果"),
    officialPriorCloseTwd: z
      .number()
      .nullable()
      .describe("官方事件提供的前收盤價 TWD；缺值時為 null"),
    observedPriorCloseDate: calendarDateSchema
      .nullable()
      .describe("raw series 找到的前一有效收盤交易日；沒有時為 null"),
    observedPriorCloseTwd: z
      .number()
      .nullable()
      .describe("raw series 前一有效收盤價 TWD；沒有時為 null"),
    toleranceTwd: z
      .number()
      .nonnegative()
      .nullable()
      .describe("prior-close 比對使用的 TWD 容許差；官方值缺失時為 null"),
  })
  .strict()
  .describe("一筆公司行動 factor 的官方與 raw prior-close reconciliation");

const eventLedgerEntrySchema = z
  .object({
    event: corporateActionEventSchema,
    status: z
      .enum(["applied", "unknown"])
      .describe("applied=事件 factor 可安全使用；unknown=必要證據不足"),
    factor: z
      .number()
      .positive()
      .nullable()
      .describe("實際納入 backward cumulative factor 的事件 factor；unknown 時為 null"),
    priorCloseCheck: priorCloseCheckSchema,
    markerReconciliation: z
      .object({
        status: z
          .enum(["matched", "not_present"])
          .describe("事件生效日是否存在對應官方 change marker"),
        marker: z.string().nullable().describe("匹配的官方 marker 原文；沒有時為 null"),
      })
      .strict()
      .describe("公司行動事件與 raw OHLC change marker 的核對"),
    unknownReasons: z
      .array(adjustmentUnknownReasonSchema)
      .describe("此事件未能安全套用 factor 的原因；applied 時為空"),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.markerReconciliation.status === "matched" &&
      entry.markerReconciliation.marker === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["markerReconciliation", "marker"],
        message: "matched marker reconciliation 必須提供 marker",
      });
    }
    if (
      entry.markerReconciliation.status === "not_present" &&
      entry.markerReconciliation.marker !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["markerReconciliation", "marker"],
        message: "not_present marker reconciliation 的 marker 必須為 null",
      });
    }
    if (
      entry.status === "applied" &&
      (entry.factor === null || entry.unknownReasons.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "applied ledger entry 必須有正 factor 且沒有 unknown reasons",
      });
    }
    if (
      entry.status === "unknown" &&
      (entry.factor !== null || entry.unknownReasons.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "unknown ledger entry 的 factor 必須為 null 且至少說明一個原因",
      });
    }
  })
  .describe("逐事件 factor、prior close 與 marker 的可稽核 adjustment ledger entry");

const officialChangeMarkerSchema = z
  .object({
    date: calendarDateSchema.describe("官方 change marker 所在交易日"),
    marker: z.string().describe("官方漲跌欄分離出的 marker 原文"),
  })
  .strict()
  .describe("raw OHLC 中觀察到的一筆官方價格變動 marker");

export const stockPriceSeriesOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCode: z.string().regex(/^\d{4}$/).describe("正規化後的四碼公司股票代號"),
        startDate: calendarDateSchema.describe("正規化後的含頭 requested 起日"),
        endDate: calendarDateSchema.describe("正規化後的含尾 requested 迄日"),
        priceBasis: priceBasisSchema,
        includeEventLedger: z.boolean().describe("正規化後是否要求回傳 event ledger"),
      })
      .strict()
      .describe("實際執行且納入 fingerprint 的完整價格序列 query"),
    generatedAt: z.string().describe("本服務組合本次序列結果的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("日期、today 與官方交易日採用的時區"),
    currency: z.literal("TWD").describe("raw 與 adjusted OHLC 的價格幣別"),
    interval: z.literal("1d").describe("每根 bar 代表一個官方交易日"),
    requestedPriceBasis: priceBasisSchema,
    rawPriceBasis: z
      .literal("raw_unadjusted")
      .describe("bars 永遠保留的官方原始未還原權值 OHLC 基礎"),
    adjustedPriceBasis: z
      .literal("price_index_compatible_corporate_action_adjusted")
      .nullable()
      .describe("有執行 adjustment 時的衍生價格基礎；raw basis 時為 null"),
    coverageComplete: z
      .boolean()
      .describe("raw range 與 requested adjustment evidence 是否完整；raw basis 成功時為 true"),
    dataQualityComplete: z
      .boolean()
      .describe("raw bar 欄位完整且 requested adjustment 全部可安全形成時為 true"),
    identity: z
      .object({
        status: z
          .enum([
            "verified_current_master",
            "inferred_from_historical_bars",
            "unverified",
          ])
          .describe("公司 identity 由目前 master 驗證、由單一歷史市場推知或仍無法驗證"),
        companyCode: z.string().regex(/^\d{4}$/).describe("本序列的四碼公司股票代號"),
        companyName: z.string().nullable().describe("目前 master 或歷史來源解析的公司簡稱"),
        resolvedMarket: marketSchema.nullable().describe("可供公司行動查詢的唯一市場；無法確認時為 null"),
        currentMasterMarket: marketSchema.nullable().describe("目前公司母體市場；不在目前母體時為 null"),
        currentMasterName: z.string().nullable().describe("目前公司母體簡稱；不在目前母體時為 null"),
        masterSnapshotId: z.string().describe("本次 identity 核對所用公司母體 snapshot ID"),
        observedNames: z.array(z.string()).describe("raw OHLC 歷史來源觀察到的公司簡稱"),
        observedMarkets: z.array(marketSchema).describe("raw OHLC 歷史 bars 實際觀察到的市場"),
        reasons: z
          .array(
            z.enum([
              "not_in_current_master",
              "multiple_historical_markets",
              "current_market_differs_from_latest_historical_market",
              "multiple_observed_names",
            ]),
          )
          .describe("identity、轉板或歷史名稱需人工核對的穩定原因"),
      })
      .strict()
      .describe("目前 master 與歷史 raw bars 的公司 identity reconciliation"),
    adjustment: z
      .object({
        status: z
          .enum(["not_requested", "complete", "unknown"])
          .describe("整體 adjustment 未要求、證據完整或至少一處不確定"),
        adjustmentDirection: z
          .enum(["backward", "not_applicable"])
          .describe("adjusted basis 固定由最後一根 raw bar 向後錨定；raw basis 不適用"),
        anchorDate: calendarDateSchema.describe("backward factor=1 的最後一根實際 raw bar 日期"),
        factorAtWindowStart: z
          .number()
          .positive()
          .nullable()
          .describe("requested 起點的累積 factor；未要求或起點證據不足時為 null"),
        cashDividendTreatment: z
          .enum(["retained", "not_applicable"])
          .describe("adjusted basis 保留現金股利價格效果且 cash-only factor=1；raw basis 不適用"),
        isAdjustedClose: z.literal(false).describe("固定 false：此序列不是 adjusted close"),
        isTotalReturn: z.literal(false).describe("固定 false：未做股息再投資，也不是 total return"),
        volumeAdjusted: z.literal(false).describe("固定 false：成交量不套用價格 adjustment factor"),
        volumeBasis: z.literal("raw_shares").describe("所有 bars 的成交量固定是官方 raw shares"),
        unknownReasons: z
          .array(adjustmentUnknownReasonSchema)
          .describe("使整體 adjustment 不能完整形成的穩定原因；完整或未要求時為空"),
        officialChangeMarkers: z
          .array(officialChangeMarkerSchema)
          .describe("requested window 內 raw OHLC 觀察到的官方 change markers"),
        unmatchedOfficialChangeMarkers: z
          .array(officialChangeMarkerSchema)
          .describe("無法和 official actual-result event 核對的 markers；非空時 adjustment unknown"),
        marketTransitionDetected: z.boolean().describe("raw bars 是否跨市場或與 resolved current market 不同"),
      })
      .strict()
      .describe("整體 backward price-index-compatible adjustment 口徑與證據狀態"),
    bars: z
      .array(stockPriceSeriesBarSchema)
      .min(1)
      .describe("requested range 內按日期升冪的 raw 與可選 adjusted 日線；不補休市日"),
    eventLedgerIncluded: z
      .boolean()
      .describe("是否依 query 允許輸出 eventLedger；raw basis 即使為 true 也不查公司行動"),
    eventLedger: z
      .array(eventLedgerEntrySchema)
      .describe("可選逐公司行動 adjustment ledger；未要求或 raw basis 時固定為空"),
    coverage: z
      .object({
        requestedStart: calendarDateSchema.describe("完整 requested range 起日"),
        requestedEnd: calendarDateSchema.describe("完整 requested range 迄日"),
        rawPrice: z
          .object({
            status: z.literal("complete").describe("成功結果的 raw OHLC range 必須完整"),
            coverageComplete: z.literal(true).describe("raw OHLC 已完整處理 requested range"),
            coveredThrough: calendarDateSchema.describe("raw dependency 已安全處理到的日期上界"),
            pageCount: z.number().int().min(1).max(3).describe("內部實際收取的 get_stock_ohlc cursor pages 數"),
            barCount: z.number().int().positive().describe("跨內部 pages 去重後的 raw bar 總數"),
            dataQualityComplete: z.boolean().describe("所有 raw bars 是否完整或官方明列 no-trade"),
          })
          .strict()
          .describe("raw OHLC 的完整 range、內部分頁與欄位品質"),
        corporateActions: z
          .object({
            status: z
              .enum(["not_requested", "complete", "partial", "unavailable"])
              .describe("公司行動 history 未要求、完整、部分覆蓋或 dependency 失敗"),
            coverage: corporateActionCoverageSchema
              .nullable()
              .describe("成功取得公司行動 history 時的 range coverage；未查或失敗時為 null"),
            failure: dependencyFailureSchema
              .nullable()
              .describe("被隔離的公司行動 dependency failure；正常取得或未要求時為 null"),
          })
          .strict()
          .describe("adjusted basis 所需 official actual-result 公司行動 coverage"),
        adjustment: z
          .object({
            status: z
              .enum(["not_requested", "complete", "unknown"])
              .describe("逐 bar adjustment coverage 的總體狀態"),
            completeBarCount: z.number().int().nonnegative().describe("adjustmentStatus=complete 的 bars 數"),
            unknownBarCount: z.number().int().nonnegative().describe("adjustmentStatus=unknown 的 bars 數"),
          })
          .strict()
          .describe("已安全形成與 fail-closed unknown adjusted bars 的數量"),
      })
      .strict()
      .describe("raw price、公司行動與 adjustment 分層 coverage"),
    sources: z
      .array(stockPriceSeriesSourceSchema)
      .describe("按 company_master、raw_price、corporate_actions stage 列出的完整官方 lineage"),
    workBudget: z
      .object({
        orchestrationCompanyMasterCalls: z.literal(1).describe("序列 orchestration 固定執行一次公司母體查詢"),
        rawPriceDependencyMasterLookupPolicy: z
          .literal("dependency_managed_per_cursor_page_not_counted_as_orchestration_call")
          .describe("既有 get_stock_ohlc 每頁自行管理的 master lookup 不重複算成 orchestration call"),
        rawPricePageLimit: z.literal(3).describe("單次工具最多安全收取 3 個 get_stock_ohlc cursor pages"),
        rawPricePageCount: z.number().int().min(1).max(3).describe("本次實際完成的 raw OHLC cursor page 數"),
        rawPricePageUnitDefinition: z
          .literal("one_get_stock_ohlc_cursor_page")
          .describe("一個 raw price page unit 等於一頁既有 get_stock_ohlc dependency"),
        corporateActionHistoryCalls: z.union([z.literal(0), z.literal(1)]).describe("本次調用公司行動 history dependency 的次數"),
        corporateActionOfficialRequestCount: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe("成功 history 回傳的官方 range/detail request 數；dependency 失敗且未知時為 null"),
        corporateActionRequestUnitDefinition: z
          .literal("one_official_range_or_selected_event_detail_request")
          .describe("一單位等於一個官方 range 或選定事件 detail 請求"),
      })
      .strict()
      .describe("單次價格序列 orchestration 的透明上游工作量界線"),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("query、identity、raw bars、來源證據、公司行動與 adjustment 的穩定 SHA-256 指紋"),
    fingerprintBasis: z
      .literal(
        "query_identity_raw_bars_without_retrieved_at_or_cache_plus_corporate_action_history_and_adjustment_evidence",
      )
      .describe("fingerprint 排除 retrievedAt/cache caller state 並納入公司行動與 adjustment evidence 的固定基礎"),
    ...warningShape,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.requestedPriceBasis !== result.query.priceBasis ||
      result.eventLedgerIncluded !== result.query.includeEventLedger
    ) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "requested basis 與 event-ledger echo 必須和 normalized query 一致",
      });
    }
    if (!result.eventLedgerIncluded && result.eventLedger.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["eventLedger"],
        message: "未要求 event ledger 時 eventLedger 必須為空",
      });
    }
    if (
      result.coverage.rawPrice.barCount !== result.bars.length ||
      result.coverage.rawPrice.pageCount !== result.workBudget.rawPricePageCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "rawPrice"],
        message: "raw bar/page counts 必須和 bars 與 workBudget 一致",
      });
    }
    const completeBars = result.bars.filter(
      (bar) => bar.adjustmentStatus === "complete",
    ).length;
    const unknownBars = result.bars.filter(
      (bar) => bar.adjustmentStatus === "unknown",
    ).length;
    if (
      completeBars !== result.coverage.adjustment.completeBarCount ||
      unknownBars !== result.coverage.adjustment.unknownBarCount ||
      result.coverage.adjustment.status !== result.adjustment.status
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "adjustment"],
        message: "adjustment status 與 bar counts 必須和 bars／adjustment 一致",
      });
    }
    if (result.requestedPriceBasis === "raw_unadjusted") {
      const rawStateValid =
        result.adjustedPriceBasis === null &&
        result.coverageComplete &&
        result.adjustment.status === "not_requested" &&
        result.adjustment.adjustmentDirection === "not_applicable" &&
        result.adjustment.factorAtWindowStart === null &&
        result.adjustment.cashDividendTreatment === "not_applicable" &&
        result.adjustment.unknownReasons.length === 0 &&
        result.coverage.corporateActions.status === "not_requested" &&
        result.coverage.corporateActions.coverage === null &&
        result.coverage.corporateActions.failure === null &&
        result.coverage.adjustment.status === "not_requested" &&
        result.coverage.adjustment.completeBarCount === 0 &&
        result.coverage.adjustment.unknownBarCount === 0 &&
        result.workBudget.corporateActionHistoryCalls === 0 &&
        result.workBudget.corporateActionOfficialRequestCount === 0 &&
        result.eventLedger.length === 0 &&
        result.bars.every((bar) => bar.adjustmentStatus === "not_requested");
      if (!rawStateValid) {
        context.addIssue({
          code: "custom",
          path: ["requestedPriceBasis"],
          message: "raw basis 不得查公司行動或暴露任何 adjusted 值",
        });
      }
    } else {
      const adjustedStateValid =
        result.adjustedPriceBasis ===
          "price_index_compatible_corporate_action_adjusted" &&
        result.adjustment.status !== "not_requested" &&
        result.adjustment.adjustmentDirection === "backward" &&
        result.adjustment.cashDividendTreatment === "retained" &&
        result.coverage.corporateActions.status !== "not_requested" &&
        result.coverage.adjustment.status !== "not_requested" &&
        result.bars.every((bar) => bar.adjustmentStatus !== "not_requested");
      if (!adjustedStateValid) {
        context.addIssue({
          code: "custom",
          path: ["requestedPriceBasis"],
          message: "adjusted basis 必須完整揭露 backward adjustment 與公司行動狀態",
        });
      }
    }
  })
  .describe(
    "單一台股在完整 requested range 的 raw 或 price-index-compatible corporate-action-adjusted 日線序列成功結果",
  );
