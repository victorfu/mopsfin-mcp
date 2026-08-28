import { z } from "zod";

import {
  calendarDateSchema,
  optionalCompanyPageShape,
  optionalMarketCompanyCodesSchema,
  periodSchema,
  sourceCacheObservationSchema,
  successResultShape,
  universePolicySchema,
  validateOptionalCompanyCodes,
  warningShape,
} from "./common";

export const dailyMarketValuationInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe("估值市場：all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx"),
    date: z
      .union([z.literal("latest"), calendarDateSchema])
      .default("latest")
      .describe("latest=官方最近完成估值日；YYYY-MM-DD 採 exact-date，假日不退回前一交易日"),
    company_codes: optionalMarketCompanyCodesSchema,
    universe_policy: universePolicySchema
      .default("compatible")
      .describe(
        "估值公司母體政策；預設 compatible，保留合法無當日估值公司造成的 master 差異並揭露 reconciliation，但各市場 matchRatio 仍須至少 95%；strict_current_master 只允許 latest 且要求完全吻合",
      ),
    ...optionalCompanyPageShape,
  })
  .strict()
  .superRefine((value, context) => {
    validateOptionalCompanyCodes(value, context);
    if (value.universe_policy === "strict_current_master" && value.date !== "latest") {
      context.addIssue({
        code: "custom",
        path: ["universe_policy"],
        message: "strict_current_master 只支援 date=latest，避免以目前母體驗證歷史估值",
      });
    }
  });

export const latestMarketQueryOutputSchema = z
  .object({
    market: z.enum(["all", "listed", "otc"]).describe("本次實際查詢的市場範圍"),
    companyCodes: z
      .array(z.string())
      .optional()
      .describe("本次實際套用的可選公司代號篩選"),
    universePolicy: z
      .enum(["compatible", "strict_current_master"])
      .describe("本次實際套用的公司母體政策"),
  })
  .strict();

export const marketReconciliationSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此核對結果代表的上市或上櫃市場"),
    masterCount: z.number().int().describe("目前 heuristic-gated 公司 master 的參考公司數；master 本身沒有官方 declared row count"),
    sourceRowCount: z.number().int().describe("官方來源可辨識的公司代號列數"),
    matchedCount: z.number().int().describe("官方來源與 master 代號吻合數"),
    marketOnlyCodes: z
      .array(z.string())
      .describe("官方來源出現但目前 master 沒有的可辨識公司代號"),
    masterMissingCodes: z
      .array(z.string())
      .describe("目前 master 存在但官方來源沒有的公司代號"),
    matchRatio: z.number().min(0).max(1).describe("matchedCount 除以 masterCount 的比率"),
    coverageComplete: z
      .boolean()
      .describe("此市場官方公司集合是否與目前 master 完全吻合"),
  })
  .strict();

const valuationSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此估值來源負責的市場"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("官方市場機構"),
    sourceName: z.string().describe("本次實際使用的官方 latest discovery 或 exact-day 估值資料集名稱"),
    sourceUrl: z.string().url().describe("本次使用的官方 OpenAPI 或指定日估值 endpoint URL"),
    retrievedAt: z.string().describe("本服務取得官方回應的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("估值來源的 caller-specific cache provenance"),
    dataDate: calendarDateSchema.describe("此官方來源的實際估值資料日期"),
    rawCount: z.number().int().describe("官方回應的原始資料列數"),
    eligibleRowCount: z.number().int().describe("正規化後可辨識為四碼公司股票的資料列數"),
  })
  .strict();

const valuationValueStatusSchema = z
  .enum(["reported", "missing_or_not_meaningful", "not_provided_by_source", "invalid_upstream"])
  .describe(
    "reported=官方有效值；missing_or_not_meaningful=空白、- 或 N/A；not_provided_by_source=該市場來源沒有此欄；invalid_upstream=非空但無法解析",
  );

const coreValuationValueStatusSchema = z
  .enum(["reported", "missing_or_not_meaningful", "invalid_upstream"])
  .describe(
    "核心 PE／PB／殖利率欄位一定存在：reported=官方有效值；missing_or_not_meaningful=空白、- 或 N/A；invalid_upstream=非空但無法解析",
  );

export const dailyMarketValuationOutputSchema = z
  .object({
    ...successResultShape,
    query: latestMarketQueryOutputSchema
      .extend({
        date: z
          .union([z.literal("latest"), calendarDateSchema])
          .describe("本次 latest 或指定 YYYY-MM-DD 條件"),
      })
      .describe("正規化後實際執行的 latest／歷史單日市場估值查詢"),
    dataDate: calendarDateSchema.describe("所有回傳估值列共用且已核對的官方資料日期"),
    currency: z.literal("TWD").describe("估值所依據股價及股利的幣別為新台幣"),
    classificationPolicy: z
      .enum(["current_master_strict", "current_master_with_code_fallback", "historical_code_rule"])
      .describe("latest 使用目前 master；歷史日使用官方四碼公司列規則"),
    coverageComplete: z
      .boolean()
      .describe("必要市場來源、資料日期與結構是否完整；false 不代表所有估值欄位都有值"),
    universeCoverageVerified: z
      .boolean()
      .describe(
        "官方估值公司集合是否與目前 heuristic-gated master 完全吻合；compatible 可在 false 時成功並以 reconciliation 揭露差異，且不能因此證明官方完整 rowset",
      ),
    selectionComplete: z
      .boolean()
      .describe("指定 company_codes 是否全數出現在正規化估值結果"),
    missingCompanyCodes: z
      .array(z.string())
      .describe("指定但未出現在本次 exact-day 估值結果的公司代號"),
    reconciliation: z
      .array(marketReconciliationSchema)
      .describe("官方估值資料與目前 company master 的逐市場集合核對"),
    counts: z
      .object({
        raw: z.number().int().describe("所有必要官方來源原始列數"),
        returned: z.number().int().describe("本頁 rows 回傳公司數；完整總數另見 meta.page.total"),
        withPe: z.number().int().describe("peRatio 為 reported 的公司數"),
        withPb: z.number().int().describe("priceToBookRatio 為 reported 的公司數"),
        withDividendYield: z
          .number()
          .int()
          .describe("dividendYieldPercent 為 reported 的公司數"),
        withClosePrice: z.number().int().describe("closePriceTwd 為 reported 的公司數"),
        withDividendPerShare: z.number().int().describe("dividendPerShareTwd 為 reported 的公司數"),
        withDividendFiscalYear: z.number().int().describe("dividendFiscalYear 為 reported 的公司數"),
        withReferenceFiscalPeriod: z.number().int().describe("referenceFiscalPeriod 為 reported 的公司數"),
      })
      .strict()
      .describe("原始、回傳與各估值欄位有效筆數"),
    rows: z
      .array(
        z
          .object({
            code: z.string().describe("四碼公司股票代號"),
            name: z.string().describe("官方估值資料顯示的公司簡稱"),
            market: z.enum(["listed", "otc"]).describe("上市或上櫃市場"),
            peRatio: z.number().nullable().describe("官方本益比；無可用值時為 null"),
            priceToBookRatio: z
              .number()
              .nullable()
              .describe("官方股價淨值比；無可用值時為 null"),
            dividendYieldPercent: z
              .number()
              .nullable()
              .describe("官方殖利率百分比；無可用值時為 null，0 是有效零值"),
            closePriceTwd: z.number().nullable().describe("TWSE 日估值來源提供的收盤價 TWD；來源未提供時為 null"),
            dividendPerShareTwd: z.number().nullable().describe("TPEx 日估值來源提供的每股股利 TWD；來源未提供時為 null"),
            dividendFiscalYear: z.number().int().nullable().describe("官方股利年度，已正規化為西元年；來源未提供時為 null"),
            referenceFiscalPeriod: periodSchema.nullable().describe("估值參考財報期，統一為 YYYYQn；來源未提供時為 null"),
            valueStatus: z
              .object({
                peRatio: coreValuationValueStatusSchema.describe("本益比資料狀態"),
                priceToBookRatio: coreValuationValueStatusSchema.describe("股價淨值比資料狀態"),
                dividendYieldPercent: coreValuationValueStatusSchema.describe("殖利率資料狀態"),
                closePriceTwd: valuationValueStatusSchema.describe("收盤價資料狀態"),
                dividendPerShareTwd: valuationValueStatusSchema.describe("每股股利資料狀態"),
                dividendFiscalYear: valuationValueStatusSchema.describe("股利年度資料狀態"),
                referenceFiscalPeriod: valuationValueStatusSchema.describe("估值參考財報期資料狀態"),
              })
              .strict()
              .describe("全部估值與補充欄位各自的官方可用性或解析狀態"),
            rawValue: z
              .object({
                peRatio: z.string().nullable().describe("本益比官方原始文字；key 不存在時為 null"),
                priceToBookRatio: z.string().nullable().describe("股價淨值比官方原始文字；key 不存在時為 null"),
                dividendYieldPercent: z.string().nullable().describe("殖利率官方原始文字；key 不存在時為 null"),
                closePriceTwd: z.string().nullable().describe("收盤價官方原始文字；key 不存在時為 null"),
                dividendPerShareTwd: z.string().nullable().describe("每股股利官方原始文字；key 不存在時為 null"),
                dividendFiscalYear: z.string().nullable().describe("股利年度官方原始文字；key 不存在時為 null"),
                referenceFiscalPeriod: z.string().nullable().describe("參考財報期官方原始文字；key 不存在時為 null"),
              })
              .strict()
              .describe("七個欄位的官方 raw marker，供區分 N/A、空白與來源未提供"),
          })
          .strict(),
      )
      .describe("本次 latest-resolved 或 exact-day 官方估值的本頁列；不得把 null 或 N/A 改寫為 0，續頁見 meta.page"),
    sources: z.array(valuationSourceSchema).describe("本次使用的 TWSE／TPEx 官方估值來源"),
    ...warningShape,
  })
  .strict();

