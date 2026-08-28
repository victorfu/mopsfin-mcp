import { z } from "zod";

import {
  calendarDateSchema,
  optionalCompanyPageShape,
  optionalMarketCompanyCodesSchema,
  sourceCacheObservationSchema,
  successResultShape,
  universePolicySchema,
  validateOptionalCompanyCodes,
  warningShape,
  yearMonthSchema,
} from "./common";
import {
  latestMarketQueryOutputSchema,
  marketReconciliationSchema,
} from "./valuation";

export const monthlyRevenueInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe("月營收市場：all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx"),
    data_month: z
      .union([z.literal("latest"), yearMonthSchema])
      .default("latest")
      .describe(
        "latest 會協調 OpenAPI 與 MOPS archive 的最新共同月份；YYYY-MM 會 exact-month 讀取 2013-01 起的修訂後 MOPS archive",
      ),
    company_codes: optionalMarketCompanyCodesSchema,
    universe_policy: universePolicySchema
      .optional()
      .describe(
        "月營收公司母體政策；省略時 latest 使用 strict_current_master、歷史 YYYY-MM 使用 compatible",
      ),
    ...optionalCompanyPageShape,
  })
  .strict()
  .superRefine((value, context) => {
    validateOptionalCompanyCodes(value, context);
    if (value.universe_policy === "strict_current_master" && value.data_month !== "latest") {
      context.addIssue({
        code: "custom",
        path: ["universe_policy"],
        message: "strict_current_master 只支援 data_month=latest，避免以目前母體驗證歷史月營收",
      });
    }
  });

export const monthlyRevenueTrendInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe("月營收趨勢市場：all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx"),
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("要建立月營收趨勢的四碼公司股票代號"),
      )
      .min(1)
      .max(100)
      .describe("要查詢的 1 至 100 家公司；結果按公司分頁但每家公司保留完整月份視窗"),
    end_month: z
      .union([z.literal("latest"), yearMonthSchema])
      .default("latest")
      .describe("趨勢終點；latest 使用各 requested 市場最新共同月份，或指定 exact YYYY-MM"),
    lookback_months: z
      .number()
      .int()
      .min(3)
      .max(24)
      .default(12)
      .describe("含 end_month 的連續月份數，預設 12、最少 3、最多 24；缺月不補值"),
    universe_policy: z
      .literal("compatible")
      .default("compatible")
      .describe("歷史趨勢固定 compatible；目前 master 僅提供 industryCode 輔助，不冒充歷史公司母體"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(20)
      .describe("每頁公司數，預設及上限 20；每家公司都包含完整 3–24 個月 points"),
    cursor: z
      .string()
      .max(1000)
      .optional()
      .describe("上一頁回傳的 query/source-snapshot-bound 公司游標；page_size 必須與第一頁相同"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.company_codes).size !== value.company_codes.length) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message: "company_codes 不得包含重複代號",
      });
    }
    if (value.end_month !== "latest") {
      const [year, month] = value.end_month.split("-").map(Number);
      const endIndex = year * 12 + month - 1;
      const startIndex = endIndex - value.lookback_months + 1;
      if (startIndex < 2013 * 12) {
        context.addIssue({
          code: "custom",
          path: ["lookback_months"],
          message: "趨勢起始月份不得早於 2013-01",
        });
      }
    }
  });

const revenueValueStatusSchema = z
  .enum(["reported", "missing", "invalid_upstream"])
  .describe("reported=官方有效數值；missing=官方空白或未申報；invalid_upstream=非空但無法解析");

const revenueNumericFields = {
  currentMonthRevenueTwd: z.number().nullable().describe("當月營收，已由仟元轉為 TWD"),
  previousMonthRevenueTwd: z.number().nullable().describe("上月營收，已由仟元轉為 TWD"),
  sameMonthLastYearRevenueTwd: z
    .number()
    .nullable()
    .describe("去年同月營收，已由仟元轉為 TWD"),
  momPercent: z.number().nullable().describe("官方當月相較上月營收增減百分比"),
  yoyPercent: z.number().nullable().describe("官方當月相較去年同月營收增減百分比"),
  currentYearCumulativeRevenueTwd: z
    .number()
    .nullable()
    .describe("本年截至 dataMonth 的累計營收，已由仟元轉為 TWD"),
  previousYearCumulativeRevenueTwd: z
    .number()
    .nullable()
    .describe("去年同期累計營收，已由仟元轉為 TWD"),
  cumulativeYoyPercent: z.number().nullable().describe("官方累計營收年增百分比"),
};

const revenueStatusFields = {
  currentMonthRevenueTwd: revenueValueStatusSchema.describe("當月營收資料狀態"),
  previousMonthRevenueTwd: revenueValueStatusSchema.describe("上月營收資料狀態"),
  sameMonthLastYearRevenueTwd: revenueValueStatusSchema.describe("去年同月營收資料狀態"),
  momPercent: revenueValueStatusSchema.describe("MoM 資料狀態"),
  yoyPercent: revenueValueStatusSchema.describe("YoY 資料狀態"),
  currentYearCumulativeRevenueTwd: revenueValueStatusSchema.describe("本年累計營收資料狀態"),
  previousYearCumulativeRevenueTwd: revenueValueStatusSchema.describe("去年同期累計營收資料狀態"),
  cumulativeYoyPercent: revenueValueStatusSchema.describe("累計 YoY 資料狀態"),
};

const revenueSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此月營收來源負責的市場"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("官方市場機構"),
    sourceName: z.string().describe("官方月營收 OpenAPI 或歷史 MOPS archive 資料集名稱"),
    sourceUrl: z.string().url().describe("本次實際讀取的固定官方 OpenAPI 或 MOPS archive URL"),
    retrievedAt: z.string().describe("本服務取得官方回應的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("月營收來源的 caller-specific cache provenance"),
    rawCount: z.number().int().describe("官方回應的原始資料列數"),
    eligibleRowCount: z.number().int().describe("正規化後可辨識為四碼公司股票的資料列數"),
    dataMonth: yearMonthSchema.describe("此官方月營收來源的資料年月"),
    sourceReportDate: calendarDateSchema.describe("此資料集的出表日期；不是個別公司 filedAt"),
    sourceAmountUnit: z.literal("thousand_TWD").describe("官方原始金額單位為新台幣仟元"),
    outputAmountUnit: z.literal("TWD").describe("MCP 正規化後金額單位為新台幣元"),
    amountMultiplier: z.literal(1000).describe("由仟元轉為 TWD 的固定倍率"),
    integrity: z
      .object({
        format: z
          .enum(["json_array", "rfc4180_csv"])
          .describe("本次來源實際解析的 JSON array 或 RFC 4180 CSV 格式"),
        structure: z
          .literal("verified")
          .describe("必要欄位、列結構與數值欄解析流程已通過"),
        snapshotIdentity: z
          .literal("verified")
          .describe("資料年月、出表日期與 requested archive 月份已核對"),
        eligibleCompanyCodesUnique: z
          .literal("verified")
          .describe("四碼 eligible 公司列在同一市場月份內沒有重複代號"),
        officialDeclaredRowCount: z
          .null()
          .describe("官方來源沒有 declared row count，因此固定為 null"),
        rowsetCompleteness: z
          .literal("unverified_no_official_declared_count")
          .describe("因無官方筆數、footer 或 checksum，不能只靠檔案證明全市場 rowset 完整"),
      })
      .strict()
      .describe("來源檔案已驗證與仍無法驗證的完整性邊界"),
  })
  .strict();

const revenueSourceCoverageSchema = z
  .object({
    status: z
      .enum(["verified", "unverified"])
      .describe("全市場 rowset 是否有外部母體可核對為完整"),
    method: z
      .enum([
        "current_master_exact_match",
        "structure_only_no_official_declared_count",
      ])
      .describe("以目前 master 完全吻合驗證，或僅能做無 declared-count 的結構驗證"),
    complete: z
      .boolean()
      .describe("status=verified 且 rowset 與可用母體完全吻合時才為 true"),
  })
  .strict()
  .describe("來源檔案 rowset 完整性；與公司申報進度 filingCoverage 分開");

export const monthlyRevenueOutputSchema = z
  .object({
    ...successResultShape,
    query: latestMarketQueryOutputSchema
      .extend({
        dataMonth: z
          .union([z.literal("latest"), yearMonthSchema])
          .describe("本次使用 latest discovery 或 exact YYYY-MM archive 的月份條件"),
      })
      .describe("正規化後實際執行的 latest 或歷史單月營收查詢"),
    dataMonth: yearMonthSchema.describe("所有回傳月營收列共用且已核對的資料年月"),
    currency: z.literal("TWD").describe("所有正規化月營收金額的幣別"),
    amountUnit: z.literal("TWD").describe("所有正規化月營收金額的輸出單位"),
    coverageComplete: z
      .boolean()
      .describe("相容欄位：latest 成功完成必要來源、格式與 snapshot identity 核對時為 true；歷史 archive 因無 declared row count 固定為 false"),
    sourceCoverage: revenueSourceCoverageSchema.describe(
      "全市場 rowset 可驗證程度；不可由 coverageComplete 或單一非空檔案推論完整母體",
    ),
    selectionComplete: z
      .boolean()
      .describe("指定 company_codes 是否全數出現在本次月份的月營收結果"),
    missingCompanyCodes: z
      .array(z.string())
      .describe("指定但未出現在本次月份月營收結果的公司代號"),
    filingCoverage: z
      .object({
        expectedCompanyCount: z.number().int().describe("依目前 master 預期的公司數"),
        reportedCompanyCount: z.number().int().describe("本資料年月已有官方營收列的公司數"),
        missingCompanyCodes: z
          .array(z.string())
          .describe("目前 master 中尚未出現在此資料年月的公司代號"),
        coverageRatio: z.number().min(0).max(1).describe("reported 除以 expected 的申報覆蓋率"),
        complete: z.boolean().describe("latest 時表示目前 master 公司是否已全數出現在此資料年月；歷史月份固定為 false"),
        status: z
          .enum([
            "complete",
            "partial",
            "historical_cross_timepoint_unverified",
          ])
          .describe("latest 的申報覆蓋狀態；歷史月份固定標示為跨時點不可驗證"),
      })
      .strict()
      .describe(
        "月營收相對目前 master 的列覆蓋；latest 可輔助看申報進度，歷史月份只代表跨時點 master 差異，不能視為當時母體",
      ),
    reconciliation: z
      .array(marketReconciliationSchema)
      .describe(
        "官方月營收列與目前 company master 的逐市場輔助核對；歷史月份不代表 point-in-time 公司母體",
      ),
    counts: z
      .object({
        listed: z.number().int().describe("本頁回傳的上市公司月營收列數"),
        otc: z.number().int().describe("本頁回傳的上櫃公司月營收列數"),
        returned: z.number().int().describe("本頁 rows 總數；完整總數另見 meta.page.total"),
      })
      .strict()
      .describe("依市場拆分的回傳筆數"),
    rows: z
      .array(
        z
          .object({
            code: z.string().describe("四碼公司股票代號"),
            name: z.string().describe("官方月營收資料顯示的公司名稱"),
            market: z.enum(["listed", "otc"]).describe("上市或上櫃市場"),
            industryCode: z
              .string()
              .nullable()
              .describe("目前 company master 的產業代號；compatible fallback 無法核對時為 null"),
            sourceIndustryName: z
              .string()
              .nullable()
              .describe("該月份官方月營收列的產業名稱；來源缺值時為 null，勿與目前 master industryCode 混用"),
            sourceReportDate: calendarDateSchema.describe("資料集出表日期；不是個別公司 filedAt"),
            ...revenueNumericFields,
            valueStatus: z
              .object(revenueStatusFields)
              .strict()
              .describe("每個營收與百分比欄位各自的官方缺值或解析狀態"),
            note: z
              .string()
              .nullable()
              .describe("官方月營收備註；沒有或官方空白時為 null"),
          })
          .strict(),
      )
      .describe("latest 或歷史月份官方月營收的本頁列；金額統一為 TWD、保留每欄 valueStatus，續頁見 meta.page"),
    sources: z.array(revenueSourceSchema).describe("本次使用的 TWSE／TPEx 官方月營收來源"),
    ...warningShape,
  })
  .strict();

const revenueTrendValueStatusSchema = z
  .enum([
    "reported",
    "partial",
    "insufficient_data",
    "invalid_upstream",
    "needs_review",
  ])
  .describe(
    "reported=必要值完整；partial=計數涵蓋部分月份；insufficient_data=不足以計算；invalid_upstream=必要官方值無法解析；needs_review=名稱或市場轉換使 identity 不可直接串接",
  );

const revenueTrendPointSchema = z
  .object({
    dataMonth: yearMonthSchema.describe("此趨勢點代表的資料年月"),
    name: z
      .string()
      .nullable()
      .describe("該月官方列的公司名稱；整月無公司列時為 null"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("該月官方列實際所在市場；整月無公司列時為 null"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("該月官方資料集出表日；整月無公司列時為 null，不是個別公司 filedAt"),
    sourceIndustryName: z
      .string()
      .nullable()
      .describe("該月份官方營收列的產業名稱；缺列或來源缺值時為 null"),
    currentMonthRevenueTwd: z
      .number()
      .nullable()
      .describe("該月營收 TWD；缺列、官方缺值或無效值時為 null"),
    sameMonthLastYearRevenueTwd: z
      .number()
      .nullable()
      .describe("去年同月營收 TWD；缺列、官方缺值或無效值時為 null"),
    momPercent: z
      .number()
      .nullable()
      .describe("官方月增率百分比；沒有可用官方值時為 null"),
    yoyPercent: z
      .number()
      .nullable()
      .describe("官方年增率百分比；沒有可用官方值時為 null"),
    valueStatus: z
      .object({
        currentMonthRevenueTwd: revenueValueStatusSchema.describe("當月營收值狀態"),
        sameMonthLastYearRevenueTwd: revenueValueStatusSchema.describe("去年同月營收值狀態"),
        momPercent: revenueValueStatusSchema.describe("官方 MoM 值狀態"),
        yoyPercent: revenueValueStatusSchema.describe("官方 YoY 值狀態"),
      })
      .strict()
      .describe("趨勢點四個數值欄位各自的官方缺值或解析狀態"),
  })
  .strict();

const revenueTrendDerivedSchema = z
  .object({
    latestYoyPercent: z
      .number()
      .nullable()
      .describe("endMonth 官方 YoY 百分比；缺值或無效時為 null"),
    rolling3MonthYoyPercent: z
      .number()
      .nullable()
      .describe("100 ×（最近 3 月營收合計 ÷ 對應去年同月營收合計 − 1）；必要值不完整時為 null"),
    rolling6MonthYoyPercent: z
      .number()
      .nullable()
      .describe("100 ×（最近 6 月營收合計 ÷ 對應去年同月營收合計 − 1）；必要值不完整時為 null"),
    yoyAccelerationVs3MonthsAgoPp: z
      .number()
      .nullable()
      .describe("最新官方 YoY 減三個月前官方 YoY，單位 percentage points；任一值不可用時為 null"),
    positiveYoyMonthsInWindow: z
      .number()
      .int()
      .nullable()
      .describe("requested 視窗內官方 YoY 為正且 reported 的月份數"),
    reportedYoyMonthsInWindow: z
      .number()
      .int()
      .nullable()
      .describe("requested 視窗內官方 YoY 為 reported 的月份數，供判斷正成長計數分母"),
    consecutivePositiveYoyMonths: z
      .number()
      .int()
      .nullable()
      .describe("從 endMonth 往前連續 reported 且 YoY 大於 0 的月份數；缺月會中止"),
    valueStatus: z
      .object({
        latestYoyPercent: revenueTrendValueStatusSchema.describe("最新 YoY 衍生欄位狀態"),
        rolling3MonthYoyPercent: revenueTrendValueStatusSchema.describe("3 月 rolling YoY 狀態"),
        rolling6MonthYoyPercent: revenueTrendValueStatusSchema.describe("6 月 rolling YoY 狀態"),
        yoyAccelerationVs3MonthsAgoPp: revenueTrendValueStatusSchema.describe("YoY 加速度狀態"),
        positiveYoyMonthsInWindow: revenueTrendValueStatusSchema.describe("正 YoY 月數狀態"),
        reportedYoyMonthsInWindow: revenueTrendValueStatusSchema.describe("已申報 YoY 月數狀態"),
        consecutivePositiveYoyMonths: revenueTrendValueStatusSchema.describe("連續正 YoY 月數狀態"),
      })
      .strict()
      .describe("七個透明衍生欄位各自的完整性狀態；不可只讀裸數值"),
  })
  .strict();

const revenueIdentityTransitionReasonSchema = z
  .enum(["observed_name_transition", "observed_market_transition"])
  .describe("同一代號在相鄰有資料月份觀察到名稱或市場轉換；來源未提供原因，可能是改名、轉板或代號重用");

const revenueTrendComparabilitySchema = z
  .object({
    status: z
      .enum(["comparable", "needs_review"])
      .describe("相鄰有資料月份 identity 是否穩定；needs_review 時 derived 全為 null"),
    reasons: z
      .array(revenueIdentityTransitionReasonSchema)
      .describe("整個 requested 視窗觀察到的 identity 轉換原因集合"),
    transitions: z
      .array(
        z
          .object({
            dataMonth: yearMonthSchema.describe("轉換首次出現在此有資料月份"),
            fromName: z.string().describe("上一個有資料月份的官方公司名稱"),
            toName: z.string().describe("此月份的官方公司名稱"),
            fromMarket: z.enum(["listed", "otc"]).describe("上一個有資料月份的官方市場"),
            toMarket: z.enum(["listed", "otc"]).describe("此月份的官方市場"),
            reasons: z
              .array(revenueIdentityTransitionReasonSchema)
              .describe("此相鄰觀察轉換觸發的名稱／市場原因"),
          })
          .strict(),
      )
      .describe("依月份升冪列出的相鄰有資料月份 identity 轉換"),
  })
  .strict()
  .describe("同一四碼代號能否直接跨月計算趨勢的可比性防線");

export const monthlyRevenueTrendOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        market: z.enum(["all", "listed", "otc"]).describe("本次實際查詢的市場範圍"),
        companyCodes: z.array(z.string()).describe("本次完整 requested 公司代號；輸入不得重複，並保留 caller 順序"),
        endMonth: z.union([z.literal("latest"), yearMonthSchema]).describe("使用者要求的趨勢終點 selector"),
        lookbackMonths: z.number().int().describe("包含終點的連續 requested 月份數"),
        universePolicy: z.literal("compatible").describe("歷史趨勢固定使用 compatible 公司母體政策"),
      })
      .strict()
      .describe("正規化後實際執行的月營收趨勢條件"),
    startMonth: yearMonthSchema.describe("實際趨勢視窗起始月份（含）"),
    endMonth: yearMonthSchema.describe("latest 解析後或 explicit 指定的實際趨勢終止月份（含）"),
    currency: z.literal("TWD").describe("月營收金額幣別"),
    amountUnit: z.literal("TWD").describe("月營收金額輸出單位；官方仟元已乘以 1,000"),
    coverageComplete: z
      .boolean()
      .describe("所有歷史月份來源的完整 rowset 是否可證明；archive 無 declared row count，因此目前固定為 false"),
    sourceCoverage: revenueSourceCoverageSchema.describe(
      "整個月份視窗的來源 rowset 可驗證程度",
    ),
    selectionComplete: z.boolean().describe("requested 公司是否都在整個趨勢視窗至少出現一列"),
    missingCompanyCodes: z.array(z.string()).describe("整個趨勢視窗皆無官方營收列的 requested 公司代號"),
    counts: z
      .object({
        requestedCompanies: z.number().int().describe("完整 requested 公司數，不受本頁切分影響"),
        returnedCompanies: z.number().int().describe("本頁實際回傳的公司結果數"),
        requestedMonths: z.number().int().describe("每家公司 points 的連續月份數"),
      })
      .strict()
      .describe("公司與月份維度的回傳筆數"),
    companies: z
      .array(
        z
          .object({
            code: z.string().describe("四碼公司股票代號"),
            name: z.string().describe("視窗內最後一筆官方營收列的公司名稱"),
            market: z.enum(["listed", "otc"]).describe("視窗內最後一筆官方營收列的市場"),
            industryCode: z.string().nullable().describe("目前 company master 的產業代號；查無時為 null，不代表歷史產業"),
            sourceIndustryName: z.string().nullable().describe("視窗內最後一筆官方營收列的產業名稱；缺值時為 null"),
            observedNames: z.array(z.string()).describe("視窗內觀察到的所有官方公司名稱，供辨識改名或代號重用"),
            observedMarkets: z.array(z.enum(["listed", "otc"])).describe("視窗內觀察到的所有官方市場，供辨識轉板"),
            comparability: revenueTrendComparabilitySchema.describe(
              "名稱／市場轉換的逐月證據；needs_review 時不得使用 derived",
            ),
            missingMonths: z.array(yearMonthSchema).describe("此公司在 requested 視窗內完全沒有官方列的月份"),
            points: z.array(revenueTrendPointSchema).describe("依月份升冪排列且不補值的完整連續趨勢點"),
            derived: revenueTrendDerivedSchema.describe("由 points 按明示公式可重算的趨勢摘要；不是主觀分數"),
          })
          .strict(),
      )
      .describe("按公司組織的月營收趨勢；本頁每家公司均包含完整月份視窗"),
    sources: z.array(revenueSourceSchema).describe("本次各月份與市場實際使用的官方月營收來源"),
    ...warningShape,
  })
  .strict();

