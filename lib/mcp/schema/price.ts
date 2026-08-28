import { z } from "zod";

import {
  calendarDateSchema,
  calendarMonthSchema,
  optionalCompanyPageShape,
  sourceCacheObservationSchema,
  successResultShape,
  universePolicySchema,
  warningShape,
} from "./common";

export const stockOhlcInputSchema = z
  .object({
    company_code: z
      .string()
      .regex(/^\d{4}$/)
      .describe(
        "四碼公司股票代號；可查目前上市櫃或已下市櫃代號，服務會依日期探測 TWSE／TPEx 並合併轉板歷史",
      ),
    start_date: calendarDateSchema.describe(
      "查詢起始日期（含）；TWSE 個股月資料自 2010-01-04、TPEx 自 1994-01-01 起支援",
    ),
    end_date: calendarDateSchema.describe(
      "查詢結束日期（含），不得早於 start_date 或晚於台北今日日期",
    ),
    cursor: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "上一頁回傳的 scope-bound 不透明時間游標；續查時 company_code、start_date、end_date 必須完全相同",
      ),
  })
  .strict();

export const dailyMarketOhlcInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe(
        "行情市場：all=上市與上櫃、listed=只取 TWSE 上市、otc=只取 TPEx 上櫃",
      ),
    date: z
      .union([z.literal("latest"), calendarDateSchema])
      .default("latest")
      .describe(
        "latest=最近完成交易日而非盤中即時價；也可指定 YYYY-MM-DD，假日不會退回前一交易日",
      ),
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("要從指定市場日線篩選的四碼公司股票代號"),
      )
      .min(1)
      .max(500)
      .optional()
      .describe(
        "可選公司代號清單，最多 500 家；省略時回傳本次官方 snapshot 中通過辨識規則的公司股票 OHLC，rowset 驗證程度另見 universeCoverageVerified、reconciliation 與 meta.quality",
      ),
    universe_policy: universePolicySchema
      .default("compatible")
      .describe(
        "公司母體政策；compatible 維持 latest 四碼公司 fallback，但各市場與目前 master 的 matchRatio 仍須至少 95%；strict_current_master 只允許 latest 並要求完全吻合",
      ),
    ...optionalCompanyPageShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.company_codes &&
      new Set(value.company_codes).size !== value.company_codes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message: "company_codes 不得包含重複代號",
      });
    }
    if (value.universe_policy === "strict_current_master" && value.date !== "latest") {
      context.addIssue({
        code: "custom",
        path: ["universe_policy"],
        message: "strict_current_master 只支援 date=latest，避免以目前母體驗證歷史資料",
      });
    }
  });

export const stockReactionSignalsInputSchema = z
  .object({
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("目前 TWSE／TPEx 公司母體中的四碼公司股票代號"),
      )
      .min(1)
      .max(50)
      .describe("要比較 reaction signals 的 1 至 50 家公司；按目前市場各自配對官方 price index"),
    as_of: z
      .union([z.literal("latest"), calendarDateSchema])
      .default("latest")
      .describe("latest=各市場最近共同可形成視窗的 benchmark 交易日；YYYY-MM-DD 不得晚於台北今日"),
    horizons: z
      .array(
        z
          .union([z.literal(5), z.literal(20), z.literal(60), z.literal(120)])
          .describe("要計算的 exact benchmark session 報酬視窗"),
      )
      .min(1)
      .max(4)
      .default([5, 20, 60, 120])
      .describe("不重複的 5／20／60／120 交易日視窗子集合；不使用日曆日或前一成交日代填"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(10)
      .describe("希望每頁處理的公司數，預設及上限 10；實際頁面仍受 48 官方月請求 work units 限制"),
    cursor: z
      .string()
      .max(1000)
      .optional()
      .describe("上一頁回傳的 v2 reaction cursor；綁定 query、目前 master、benchmark、公司行動 range contracts/summaries 與整個 requested-company TWSE 權息 detail evidence"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.company_codes).size !== value.company_codes.length) {
      context.addIssue({ code: "custom", path: ["company_codes"], message: "company_codes 不得包含重複代號" });
    }
    if (new Set(value.horizons).size !== value.horizons.length) {
      context.addIssue({ code: "custom", path: ["horizons"], message: "horizons 不得包含重複視窗" });
    }
  });

const ohlcBarSchema = z
  .object({
    date: calendarDateSchema.describe("此根官方日線代表的實際交易日期"),
    open: z
      .number()
      .nullable()
      .describe("原始未還原權值開盤價；null 表示無成交或官方缺值"),
    high: z
      .number()
      .nullable()
      .describe("原始未還原權值最高價；null 表示無成交或官方缺值"),
    low: z
      .number()
      .nullable()
      .describe("原始未還原權值最低價；null 表示無成交或官方缺值"),
    close: z
      .number()
      .nullable()
      .describe("原始未還原權值收盤價；null 表示無成交或官方缺值"),
    volumeShares: z
      .number()
      .nullable()
      .describe("正規化為股的官方成交量；0 保留為 0，缺值才是 null"),
    turnoverTwd: z
      .number()
      .nullable()
      .describe("正規化為新台幣元的官方成交金額；0 保留為 0，缺值才是 null"),
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
      .describe("從漲跌數值分離的官方符號或除權息等 marker；沒有時為 null"),
    market: z
      .enum(["listed", "otc"])
      .describe("此根日線實際來自 TWSE 上市或 TPEx 上櫃市場"),
    status: z
      .enum(["traded", "no_trade"])
      .describe("traded=有有效 OHLC，no_trade=官方列出日期但沒有成交價格"),
    qualityStatus: z
      .enum(["complete", "partial", "official_no_trade"])
      .describe(
        "complete=必要價量欄位完整；partial=至少一個必要欄位缺失；official_no_trade=官方明列無成交",
      ),
    missingFields: z
      .array(
        z.enum([
          "open",
          "high",
          "low",
          "close",
          "volumeShares",
          "turnoverTwd",
          "tradeCount",
          "change",
        ]),
      )
      .describe("缺失或無法解析的標準化價量欄位；官方無成交時會列出價格欄位"),
  })
  .strict();

const priceUnitNormalizationSchema = z
  .object({
    sourceUnit: z
      .enum(["share", "lot", "TWD", "TWD_thousand", "trade"])
      .describe("官方來源欄位的原始單位"),
    outputUnit: z
      .enum(["share", "TWD", "trade"])
      .describe("MCP 正規化後的輸出單位"),
    multiplier: z
      .union([z.literal(1), z.literal(1000)])
      .describe("由 sourceUnit 轉為 outputUnit 實際套用的倍率"),
  })
  .strict();

const priceSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此官方來源負責的市場"),
    sourceName: z.string().describe("官方 OHLC 資料集或查詢頁名稱"),
    sourceUrl: z.string().url().describe("本次使用的固定 TWSE／TPEx 官方 URL"),
    retrievedAt: z.string().describe("本服務實際取得這份官方回應的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("OHLC 來源的 caller-specific cache provenance"),
    snapshotIdentity: z
      .enum(["verified", "unverified_empty"])
      .optional()
      .describe(
        "verified=回應本身可核對 requested date/month；unverified_empty=官方 no-data response 缺少 title/date，不能把空回應驗證綁定至 requested month；省略只供舊版相容",
      ),
    dataDate: calendarDateSchema
      .optional()
      .describe("單日市場來源實際回傳並核對成功的資料日期"),
    dataMonth: calendarMonthSchema
      .optional()
      .describe(
        "個股歷史 OHLC 回應已驗證綁定的 YYYY-MM；snapshotIdentity=unverified_empty 或單日市場來源時省略",
      ),
    normalization: z
      .object({
        volumeShares: priceUnitNormalizationSchema.describe("成交量由來源單位轉為股的規則"),
        turnoverTwd: priceUnitNormalizationSchema.describe("成交金額由來源單位轉為 TWD 的規則"),
        tradeCount: priceUnitNormalizationSchema.describe("成交筆數的來源與輸出單位規則"),
      })
      .strict()
      .describe("此官方來源價量欄位的單位正規化資訊"),
  })
  .strict();

const priceBasisShape = {
  currency: z.literal("TWD").describe("所有 OHLC 價格的幣別為新台幣"),
  timezone: z.literal("Asia/Taipei").describe("日期與 latest 判斷使用台北時區"),
  interval: z.literal("1d").describe("每根 bar 是一個官方交易日"),
  priceBasis: z
    .literal("raw_unadjusted")
    .describe("官方原始未還原權值價格；不等於 adjusted close"),
};

export const stockOhlcOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCode: z.string().describe("本次查詢的四碼股票代號"),
        startDate: calendarDateSchema.describe("完整 requested range 起始日（含）"),
        endDate: calendarDateSchema.describe("完整 requested range 結束日（含）"),
        cursor: z.string().optional().describe("本頁輸入時使用的續查游標"),
      })
      .strict()
      .describe("正規化後實際執行的個股 OHLC 查詢"),
    companyCode: z.string().describe("本次價格序列的股票代號"),
    observedNames: z
      .array(z.string())
      .describe("目前公司母體與歷史官方回應中觀察到的所有公司簡稱"),
    ...priceBasisShape,
    dataQualityComplete: z
      .boolean()
      .describe("本頁所有 bars 是否都為 complete 或官方明列 official_no_trade"),
    bars: z
      .array(ohlcBarSchema)
      .describe("本頁日期範圍內按日期升冪排列的官方 OHLC；不補週末或休市日"),
    coverage: z
      .object({
        requestedStart: calendarDateSchema.describe("使用者要求的完整起始日期"),
        requestedEnd: calendarDateSchema.describe("使用者要求的完整結束日期"),
        coveredThrough: calendarDateSchema.describe("本頁已完成探測到的日期上界"),
        coverageComplete: z
          .boolean()
          .describe("是否已完整處理 requested range；false 時不可宣稱全區間完整"),
        nextCursor: z
          .string()
          .nullable()
          .describe("下一頁應原樣帶回的 scope-bound 游標；null 表示完整處理完畢"),
      })
      .strict()
      .describe("跨頁時間覆蓋狀態；每頁最多處理 12 個日曆月份"),
    sources: z.array(priceSourceSchema).describe("本頁實際使用的官方市場來源"),
    ...warningShape,
  })
  .strict();

export const dailyMarketOhlcOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        market: z.enum(["all", "listed", "otc"]).describe("本次市場範圍"),
        date: z
          .union([z.literal("latest"), calendarDateSchema])
          .describe("本次 latest 或指定日期條件"),
        companyCodes: z
          .array(z.string())
          .optional()
          .describe("本次實際套用的可選公司代號篩選"),
        universePolicy: z
          .enum(["compatible", "strict_current_master"])
          .describe("本次實際套用的公司母體政策"),
      })
      .strict()
      .describe("正規化後實際執行的單日市場 OHLC 查詢"),
    dataDate: calendarDateSchema.describe("所有回傳 bars 共用且已核對的實際交易日"),
    ...priceBasisShape,
    classificationMethod: z
      .enum(["current_master", "historical_code_rule"])
      .describe(
        "current_master=latest 以目前公司母體辨識；historical_code_rule=歷史日依四碼首碼非 0 且非 -DR 規則辨識",
      ),
    classificationPolicy: z
      .enum([
        "current_master_strict",
        "current_master_with_code_fallback",
        "historical_code_rule",
      ])
      .describe("比舊 classificationMethod 更精確的實際公司分類與 fallback 政策"),
    coverageComplete: z
      .literal(true)
      .describe("要求的市場來源都成功且資料日期一致；否則工具整體報錯"),
    universeCoverageVerified: z
      .boolean()
      .describe(
        "latest 官方公司集合是否與目前 master 完全吻合；compatible 可在 false 時成功，但各市場 matchRatio 仍已通過 95% 防截斷門檻；歷史查詢固定為 false",
      ),
    dataQualityComplete: z
      .boolean()
      .describe("所有回傳 bars 是否都為 complete 或官方明列 official_no_trade"),
    reconciliation: z
      .array(
        z
          .object({
            market: z.enum(["listed", "otc"]).describe("此 reconciliation 代表的市場"),
            masterCount: z.number().int().describe("目前 heuristic-gated 公司 master 的參考公司數；master 本身沒有官方 declared row count"),
            sourceRowCount: z.number().int().describe("官方行情正規化前可辨識的公司代號列數"),
            matchedCount: z.number().int().describe("官方行情與 master 代號吻合數"),
            marketOnlyCodes: z
              .array(z.string())
              .describe("行情出現但目前 master 沒有的可辨識公司代號"),
            masterMissingCodes: z
              .array(z.string())
              .describe("目前 master 存在但行情來源缺少的公司代號"),
            matchRatio: z.number().describe("matchedCount 除以 masterCount 的比率"),
            coverageComplete: z
              .boolean()
              .describe("此市場官方公司集合是否與目前 master 完全吻合"),
          })
          .strict(),
      )
      .describe("latest 行情與目前 company master 的逐市場集合核對結果；歷史查詢為空陣列"),
    selectionComplete: z
      .boolean()
      .describe("指定 company_codes 是否全數出現在該市場交易日"),
    missingCompanyCodes: z
      .array(z.string())
      .describe("指定但未出現在該市場交易日的公司代號"),
    counts: z
      .object({
        listed: z.number().int().describe("本頁回傳的上市公司 bars 數"),
        otc: z.number().int().describe("本頁回傳的上櫃公司 bars 數"),
        returned: z.number().int().describe("本頁 bars 陣列總數；完整總數另見 meta.page.total"),
      })
      .strict()
      .describe("依市場拆分的回傳筆數"),
    bars: z
      .array(
        ohlcBarSchema.extend({
          code: z.string().describe("此根市場日線的四碼公司股票代號"),
          name: z.string().describe("該交易日官方行情顯示的證券簡稱"),
        }),
      )
      .describe("指定交易日完整／company_codes 篩選結果中的本頁公司 OHLC；續頁見 meta.page"),
    sources: z.array(priceSourceSchema).describe("本次實際使用且日期已核對的官方來源"),
    ...warningShape,
  })
  .strict();

const reactionSignalStatusSchema = z
  .enum([
    "available",
    "no_stock_data",
    "stock_data_unavailable",
    "missing_stock_start_close",
    "missing_stock_end_close",
    "incomplete_stock_window",
    "invalid_denominator",
    "not_comparable_corporate_action",
  ])
  .describe("signal 的可計算狀態；no_stock_data 是官方查無資料，stock_data_unavailable 是該公司 OHLC dependency 失敗，not_comparable_corporate_action 表示公司行動 actual-result 證據不足；非 available 時相關值為 null，不能回退 raw 或補 0");

const reactionStockDataFailureSchema = z
  .object({
    code: z.enum([
      "INVALID_ARGUMENT",
      "NOT_FOUND",
      "INCOMPLETE_COVERAGE",
      "UPSTREAM_TIMEOUT",
      "UPSTREAM_RATE_LIMITED",
      "UPSTREAM_BAD_RESPONSE",
    ]).describe("被隔離至此公司的穩定 OHLC dependency 錯誤代號"),
    reason: z.string().nullable().describe("更精確的穩定 failure reason；未提供時為 null"),
    message: z.string().describe("此公司 OHLC dependency 的失敗說明，不代表其他公司也失敗"),
    retryable: z.boolean().describe("是否適合稍後以相同條件重試此公司"),
    retryAfterMs: z.number().int().nonnegative().nullable().describe("建議至少等待的毫秒數；未提供時為 null"),
    action: z.enum(["fix_input", "change_query", "retry", "restart_pagination", "none"]).describe("呼叫端針對此公司 failure 建議採取的下一步"),
  })
  .strict()
  .describe("stockDataStatus=unavailable 時的逐公司 OHLC failure；官方正常回應但無資料時為 null");

const averageWindowSignalSchema = z
  .object({
    windowSessions: z.union([z.literal(5), z.literal(20), z.literal(60)]).describe("平均值的 benchmark session 視窗"),
    startDate: calendarDateSchema.describe("exact session 視窗起始交易日"),
    endDate: calendarDateSchema.describe("exact session 視窗終止交易日"),
    expectedObservationCount: z.number().int().describe("完整視窗應有的觀察數"),
    observationCount: z.number().int().describe("實際取得有效個股欄位值的觀察數"),
    value: z.number().nullable().describe("完整視窗的簡單平均；資料不完整時為 null"),
    status: reactionSignalStatusSchema.describe("此平均值的資料完整性狀態"),
  })
  .strict();

const ratioSignalSchema = z
  .object({
    numeratorWindowSessions: z.union([z.literal(5), z.literal(20)]).describe("分子平均值的 session 視窗"),
    denominatorWindowSessions: z.union([z.literal(20), z.literal(60)]).describe("分母平均值的 session 視窗"),
    value: z.number().nullable().describe("短窗平均除以長窗平均；任一視窗不可用或分母非正時為 null"),
    status: reactionSignalStatusSchema.describe("比值的資料完整性與分母狀態"),
  })
  .strict();

const benchmarkSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此 benchmark 對應的股票市場"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("發布 benchmark 的官方市場機構"),
    benchmarkCode: z.enum(["TAIEX", "TPEX_PRICE_INDEX"]).describe("穩定 benchmark 識別碼"),
    benchmarkName: z.enum(["發行量加權股價指數", "櫃買指數"]).describe("官方價格指數名稱"),
    sourceName: z.string().describe("官方 benchmark 歷史資料集名稱"),
    sourceUrl: z.string().url().describe("本次使用的固定官方市場指數 URL"),
    dataMonth: calendarMonthSchema.describe("此來源請求與核對的 benchmark 月份"),
    retrievedAt: z.string().describe("本服務取得此官方 benchmark 回應的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("benchmark 來源的 caller-specific cache provenance"),
    rowCount: z.number().int().describe("正規化後此來源的 benchmark 交易日數"),
  })
  .strict();

const corporateActionEventSchema = z
  .object({
    companyCode: z.string().describe("公司行動對應的四碼公司股票代號"),
    name: z.string().describe("官方 actual-result 列中的公司名稱"),
    market: z.enum(["listed", "otc"]).describe("公司行動所屬市場"),
    effectiveDate: calendarDateSchema.describe("公司行動實際生效交易日"),
    kind: z
      .enum([
        "cash_dividend",
        "stock_rights",
        "rights_and_dividend",
        "capital_reduction",
        "par_value_change",
      ])
      .describe("由 TWSE／TPEx actual-result 正規化的公司行動種類"),
    priorCloseTwd: z.number().nullable().describe("官方 actual-result 前收盤價 TWD；來源缺值時為 null"),
    referencePriceTwd: z.number().nullable().describe("官方 actual-result 參考價 TWD；來源缺值時為 null"),
    cashDividendPerShareTwd: z.number().nullable().describe("官方每股現金股利 TWD；非現金事件或來源缺值時為 null"),
    priceIndexAdjustmentFactor: z
      .number()
      .positive()
      .nullable()
      .describe("由官方 actual-result 可重算的 price-index-compatible factor；證據不足時為 null，現金股利效果不由此消除"),
    shareCountChanged: z.boolean().describe("事件是否改變每股股數口徑；為 true 時未調整成交股數不可直接跨事件比較"),
    adjustmentStatus: z.enum(["available", "unavailable"]).describe("actual-result 是否足以形成可靠 factor"),
    adjustmentReason: z
      .enum([
        "cash_only_price_index_factor_is_one",
        "official_reference_price_divided_by_prior_close",
        "official_reference_price_divided_by_prior_close_less_cash_dividend",
        "missing_required_official_value",
        "twse_combined_event_detail_not_requested",
        "twse_combined_event_detail_failed",
      ])
      .describe("factor 可用或不可用的穩定公式／證據原因"),
    sourceFamily: z
      .enum(["ex_right_dividend", "capital_reduction", "par_value_change"])
      .describe("提供此 actual-result 的官方公司行動資料族群"),
    sourceUrl: z.string().url().describe("此事件實際來源的 TWSE／TPEx official actual-result URL"),
    rawType: z.string().describe("官方原始事件類型文字，供稽核正規化結果"),
  })
  .strict();

const corporateActionSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("官方公司行動來源市場"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("發布 actual-result 的官方機構"),
    family: z
      .enum(["ex_right_dividend", "capital_reduction", "par_value_change"])
      .describe("官方公司行動資料族群"),
    scope: z.enum(["range_summary", "event_detail"]).describe("區間摘要或特定 combined-event 詳情請求"),
    sourceName: z.string().describe("官方 actual-result 資料集名稱"),
    sourceUrl: z.string().url().describe("本次實際請求的官方 URL"),
    retrievedAt: z.string().describe("本服務取得官方回應的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("公司行動來源的 caller-specific cache provenance"),
    supportedFrom: calendarDateSchema.describe("此官方資料族群可驗證的最早日期"),
    queryStart: calendarDateSchema.describe("本次 actual-result 查詢起日"),
    queryEnd: calendarDateSchema.describe("本次 actual-result 查詢迄日"),
    responseStart: calendarDateSchema.nullable().describe("官方回應回顯的查詢起日；不提供 range identity 的 event detail 為 null"),
    responseEnd: calendarDateSchema.nullable().describe("官方回應回顯的查詢迄日；不提供 range identity 的 event detail 為 null"),
    rawRowCount: z.number().int().nonnegative().describe("官方回應原始資料列數"),
    companyEventCount: z.number().int().nonnegative().describe("此來源正規化後的普通股公司事件數；range summary 為全市場、event detail 為單一事件"),
    officialDeclaredRowCount: z.number().int().nonnegative().nullable().describe("官方宣告列數；未提供時為 null"),
    officialDeclaredRowCountAvailable: z.boolean().describe("官方回應是否提供可核對的 declared row count"),
  })
  .strict();

export const stockReactionSignalsOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCodes: z.array(z.string()).describe("完整 requested 公司代號，順序同 caller 且決定續頁位置"),
        asOf: z.union([z.literal("latest"), calendarDateSchema]).describe("使用者要求的 as-of selector"),
        horizons: z.array(z.union([z.literal(5), z.literal(20), z.literal(60), z.literal(120)])).describe("已排序的 exact benchmark session 報酬視窗"),
        pageSize: z.number().int().describe("本查詢釘住的 requested 公司頁面上限"),
      })
      .strict()
      .describe("正規化後且由 cursor 綁定的 reaction 查詢條件"),
    timezone: z.literal("Asia/Taipei").describe("日期與 latest 解析時區"),
    currency: z.literal("TWD").describe("成交金額與個股價格幣別"),
    priceBasis: z.literal("raw_unadjusted").describe("保留供稽核的官方原始未還原權值收盤價口徑"),
    returnBasis: z
      .literal("price_index_compatible_corporate_action_adjusted")
      .describe("excess return 使用 official actual-result factor 移除股數變動機械斷點；現金股利價格效果保留，非 adjusted close 或 total return"),
    benchmarkBasis: z.literal("price_index").describe("benchmark 使用價格指數，不含股息再投資"),
    asOf: z
      .object({
        requested: z.union([z.literal("latest"), calendarDateSchema]).describe("使用者要求的 as-of selector"),
        resolvedByMarket: z
          .array(
            z
              .object({
                market: z.enum(["listed", "otc"]).describe("此 resolved date 對應的市場"),
                date: calendarDateSchema.describe("該市場 exact benchmark session 終點"),
              })
              .strict(),
          )
          .describe("依 requested 公司市場分別解析的 benchmark as-of；latest 可能不同日"),
      })
      .strict()
      .describe("requested 與實際 benchmark as-of 的明確映射"),
    coverage: z
      .object({
        selectionComplete: z.literal(true).describe("所有 requested 公司都已由目前 company master 唯一解析"),
        benchmarkHistoryComplete: z.literal(true).describe("每個 requested 市場都有足以形成最長視窗的 benchmark history"),
        corporateActionHistoryComplete: z.boolean().describe("每個 requested 市場的 official actual-result 歷史是否完整涵蓋 evidence 視窗，且整個 requested company scope 的 events 是否都有可用 adjustment factor"),
        dataQualityComplete: z.boolean().describe("本頁所有 exact-session signals、公司行動 adjustment 與 comparability 是否完整"),
        missingCompanyCodes: z.array(z.string()).length(0).describe("成功時固定空陣列；找不到任何代號會整個工具報 NOT_FOUND"),
      })
      .strict()
      .describe("selection、benchmark 與本頁個股 signal 品質"),
    pagination: z
      .object({
        snapshotId: z
          .string()
          .describe("跨頁固定的 query/current-master/benchmark/corporate-action scope 指紋；不包含尚未查詢公司的個股 OHLC 值"),
        requestedCompanyCount: z.number().int().describe("完整 requested 公司數"),
        requestedPageSize: z.number().int().describe("query 綁定的 requested page size"),
        pageStartIndex: z.number().int().describe("本頁第一家公司在 caller 順序中的零起算位置"),
        returnedCompanyCount: z.number().int().describe("本頁實際完成的公司數"),
        nextCompanyIndex: z.number().int().describe("下一頁起始公司位置；無下一頁時等於 requestedCompanyCount"),
        hasMore: z.boolean().describe("是否仍有公司受 page size 或 work budget 留待續頁"),
        nextCursor: z.string().nullable().describe("下一頁不透明 cursor；null 表示全部 requested 公司已完成"),
      })
      .strict()
      .describe("保留 caller 公司順序且受 48 work units 限制的 reaction 分頁"),
    workBudget: z
      .object({
        limit: z.literal(48).describe("每頁固定 48 個官方市場月份請求單位上限"),
        consumed: z.number().int().describe("本頁 benchmarkUnits 加 stockUnits"),
        benchmarkUnits: z.number().int().describe("benchmark 市場 × 月份請求單位"),
        stockUnits: z.number().int().describe("個股市場 × 月份請求單位，含必要轉板探測"),
        unitDefinition: z.literal("one_official_market_month_request").describe("一單位等於一個官方市場的一個月份請求"),
        corporateActionRequests: z.number().int().nonnegative().describe("本頁載入的 official actual-result 區間／詳情來源請求數；另列、不併入 48 個市場月份 consumed"),
        corporateActionRequestDefinition: z.literal("one_official_range_or_detail_request").describe("一筆公司行動 request 等於一個官方區間摘要或事件詳情請求"),
      })
      .strict()
      .describe("限制單頁上游請求量的透明工作預算"),
    companies: z
      .array(
        z
          .object({
            companyCode: z.string().describe("目前 company master 唯一解析的公司代號"),
            companyName: z.string().describe("目前 company master 公司簡稱"),
            market: z.enum(["listed", "otc"]).describe("目前 company master 市場"),
            benchmarkCode: z.enum(["TAIEX", "TPEX_PRICE_INDEX"]).describe("依目前市場配對的官方價格指數"),
            requestedAsOf: z.union([z.literal("latest"), calendarDateSchema]).describe("本公司沿用的 requested as-of"),
            resolvedAsOf: calendarDateSchema.describe("本公司 benchmark exact session 終點"),
            stockDataStatus: z.enum(["available", "no_data", "unavailable"]).describe("available=OHLC dependency 完成、no_data=官方正常回應但查無資料、unavailable=此公司 dependency 失敗且已隔離"),
            stockDataFailure: reactionStockDataFailureSchema
              .nullable()
              .describe("unavailable 的結構化逐公司 failure；available／no_data 時為 null"),
            returns: z
              .array(
                z
                  .object({
                    horizonSessions: z.union([z.literal(5), z.literal(20), z.literal(60), z.literal(120)]).describe("此報酬的 exact benchmark session 數"),
                    startDate: calendarDateSchema.describe("此 horizon 的 exact benchmark 起始交易日"),
                    endDate: calendarDateSchema.describe("此 horizon 的 exact benchmark 終止交易日"),
                    stockReturnPercent: z.number().nullable().describe("raw unadjusted 個股收盤價報酬百分比，只供稽核；資料不足時為 null"),
                    priceIndexCompatibleStockReturnPercent: z
                      .number()
                      .nullable()
                      .describe("套用 official actual-result factor、只移除股數變動機械斷點後的個股報酬；現金股利價格效果保留，證據不足時為 null，非 total return"),
                    corporateActionAdjustmentFactor: z
                      .number()
                      .positive()
                      .nullable()
                      .describe("此 horizon 由 official actual-result 事件連乘的 adjustment factor；不需要調整時為 1，證據不足時為 null"),
                    benchmarkReturnPercent: z.number().describe("官方 price index 同一 exact session 起訖的報酬百分比"),
                    excessReturnPercentagePoints: z.number().nullable().describe("price-index-compatible 個股報酬減 benchmark 報酬的 percentage points；證據不足或不可比時為 null"),
                    status: reactionSignalStatusSchema.describe("raw 個股 anchor／報酬資料可用狀態；公司行動 adjustment 與 excess 是否可比較須另看 excessReturnStatus 及 excessReturnReasons"),
                    excessReturnStatus: z.union([reactionSignalStatusSchema, z.literal("not_comparable")]).describe("excess return 的獨立狀態；not_comparable 時不得使用 raw 差值或猜測 factor"),
                    excessReturnReasons: z
                      .array(
                        z.enum([
                          "corporate_action_coverage_incomplete",
                          "corporate_action_adjustment_unavailable",
                          "corporate_action_prior_close_mismatch",
                          "unmatched_official_change_marker_within_horizon",
                          "market_transition_or_historical_market_mismatch_within_horizon",
                          "multiple_observed_names",
                        ]),
                      )
                      .describe("使該 horizon price-index-compatible excess return 不可比較的穩定證據原因"),
                  })
                  .strict(),
              )
              .describe("逐 requested horizon 的 raw stock、price-index benchmark 與可比 excess returns"),
            liquidity: z
              .object({
                averageVolume5SessionsShares: averageWindowSignalSchema.describe("最近 5 benchmark sessions 平均成交股數"),
                averageVolume20SessionsShares: averageWindowSignalSchema.describe("最近 20 benchmark sessions 平均成交股數"),
                volume5To20Ratio: ratioSignalSchema.describe("5-session 平均成交股數除以 20-session 平均成交股數"),
                averageTurnover20SessionsTwd: averageWindowSignalSchema.describe("最近 20 benchmark sessions 平均成交金額 TWD"),
                averageTurnover60SessionsTwd: averageWindowSignalSchema.describe("最近 60 benchmark sessions 平均成交金額 TWD"),
                turnover20To60Ratio: ratioSignalSchema.describe("20-session 平均成交金額除以 60-session 平均成交金額"),
              })
              .strict()
              .describe("量能與成交金額的透明代理訊號；不是流動性評分"),
            pricePath: z
              .object({
                horizonSessions: z.union([z.literal(5), z.literal(20), z.literal(60), z.literal(120)]).describe("使用 requested 最長 horizon 的價格路徑視窗"),
                startDate: calendarDateSchema.describe("價格路徑 exact benchmark 起始交易日"),
                endDate: calendarDateSchema.describe("價格路徑 exact benchmark 終止交易日"),
                expectedObservationCount: z.number().int().describe("含起訖完整路徑應有的 session 觀察數"),
                observationCount: z.number().int().describe("實際取得完整個股收盤價的觀察數"),
                maximumDrawdownPercent: z.number().max(0).nullable().describe("視窗內由先前高點到後續低點的最大回撤百分比，值小於等於 0；資料不完整時為 null"),
                distanceBelowWindowHighPercent: z.number().min(0).nullable().describe("終點收盤價低於視窗高點的百分比，值大於等於 0；資料不完整時為 null"),
                priceBasis: z
                  .literal("price_index_compatible_corporate_action_adjusted")
                  .describe("路徑使用 official actual-result factor 移除股數變動機械斷點；不是 raw path、adjusted close 或 total return"),
                status: reactionSignalStatusSchema.describe("價格路徑計算的資料完整性狀態"),
              })
              .strict()
              .describe("最長 requested horizon 的 price-index-compatible 價格路徑代理"),
            comparability: z
              .object({
                status: z.enum(["price_index_compatible", "not_comparable", "unavailable"]).describe("公司層 adjustment 可比性；只有 price_index_compatible 可用於 excess return 與 screening，證據不足為 not_comparable／unavailable"),
                rawPriceBasis: z.literal("raw_unadjusted").describe("保留供稽核的原始個股價格口徑"),
                returnBasis: z.literal("price_index_compatible_corporate_action_adjusted").describe("以 official actual-result factor 移除股數變動機械斷點的報酬口徑；保留現金股利價格效果且非 total return"),
                corporateActionAdjustment: z.enum(["applied", "not_required", "incomplete"]).describe("視窗內 adjustment 已套用、官方完整證明不需要，或證據不完整"),
                corporateActionEvidence: z.enum(["official_history_verified_no_event", "official_history_verified_events", "official_history_incomplete"]).describe("官方 actual-result 公司行動歷史覆蓋與事件證據摘要"),
                corporateActionCoverageComplete: z.boolean().describe("官方 actual-result 歷史是否完整涵蓋本公司最長 requested 視窗"),
                marketTransitionDetected: z.boolean().describe("requested 視窗是否觀察到跨市場或歷史市場與目前 master 不符"),
                observedMarkets: z.array(z.enum(["listed", "otc"])).describe("requested 視窗個股 OHLC 實際來源市場"),
                corporateActions: z.array(corporateActionEventSchema).describe("本公司 requested 視窗內實際匹配的 official actual-result events；不從 marker 猜測"),
                officialChangeMarkers: z
                  .array(
                    z
                      .object({
                        date: calendarDateSchema.describe("官方 change marker 所在交易日"),
                        marker: z.string().describe("官方漲跌欄分離出的公司行動或其他 marker 原文"),
                      })
                      .strict(),
                  )
                  .describe("視窗內非單純正負號的官方 change markers"),
                unmatchedOfficialChangeMarkers: z
                  .array(
                    z
                      .object({
                        date: calendarDateSchema.describe("無法和 actual-result event 核對的 marker 日期"),
                        marker: z.string().describe("無法核對的官方 marker 原文"),
                      })
                      .strict(),
                  )
                  .describe("無匹配 actual-result event 的 markers；非空時 adjustment 證據不足"),
                reasons: z
                  .array(
                    z.enum([
                      "corporate_action_coverage_incomplete",
                      "corporate_action_adjustment_unavailable",
                      "corporate_action_prior_close_mismatch",
                      "unmatched_official_change_marker_present",
                      "market_transition_or_historical_market_mismatch",
                      "multiple_observed_names",
                      "no_stock_data",
                      "stock_data_unavailable",
                    ]),
                  )
                  .describe("公司層 adjustment、identity 與市場可比性限制；空陣列才表示 price_index_compatible"),
              })
              .strict()
              .describe("official actual-result 公司行動、轉板與 identity 對 excess return 的限制"),
            dataQualityComplete: z.boolean().describe("本公司所有 signal available 且 comparability=price_index_compatible；不足時不得把 raw 結果當成完整"),
            warnings: z.array(z.string()).describe("此公司資料缺口或不可比原因的人類可讀提示"),
          })
          .strict()
          .superRefine((company, context) => {
            if (
              (company.stockDataStatus === "unavailable") !==
              (company.stockDataFailure !== null)
            ) {
              context.addIssue({
                code: "custom",
                path: ["stockDataFailure"],
                message:
                  "stockDataFailure 必須且只能在 stockDataStatus=unavailable 時提供。",
              });
            }
          }),
      )
      .describe("本頁按 caller 順序回傳的公司 reaction signals；只有 actual-result 證據完整才提供 price-index-compatible excess，不含主觀分數或錯價結論"),
    benchmarkSources: z.array(benchmarkSourceSchema).describe("本頁載入並 fingerprint 的 TAIEX／TPEx 官方價格指數月份來源"),
    stockSources: z.array(priceSourceSchema).describe("本頁各公司實際使用的官方 raw OHLC 月份來源"),
    corporateActionSources: z.array(corporateActionSourceSchema).describe("本頁載入並納入 source cutoffs 的 TWSE／TPEx official actual-result 來源；cursor fingerprint 同時綁定 full-market range contracts/summaries（含無法形成 source 的 unverified-empty contract evidence）、排序後 selected-company scope 與 selected TWSE combined-event detail 的成功／失敗正規化證據，retrievedAt 不參與 fingerprint"),
    ...warningShape,
  })
  .strict();

