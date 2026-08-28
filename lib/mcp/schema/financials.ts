import { z } from "zod";

import {
  companyCodesSchema,
  pageShape,
  periodSchema,
  pointSchema,
  rangeOutputShape,
  rangeShape,
  requestedPeriodSchema,
  seriesSchema,
  sourceShape,
  successResultShape,
  trendShape,
  warningShape,
} from "./common";

export const listCatalogInputSchema = z
  .object({
    kind: z
      .enum([
        "all",
        "metrics",
        "industries",
        "financial_institutions",
        "periods",
      ])
      .default("all")
      .describe("要列出的目錄類型；all 同時回傳指標、產業、金融機構與期間"),
    query: z
      .string()
      .trim()
      .max(50)
      .optional()
      .describe("可選文字篩選，可搜尋代號、中文名稱、分類或 endpoint family"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(200)
      .describe("每一種目錄最多回傳的項目數；counts 仍顯示未截斷的總數"),
  })
  .strict();

export const companyMetricInputSchema = z
  .object({
    metric_code: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("list_catalog 中 family=data 的精確指標代號；不要用中文名稱代替"),
    company_codes: companyCodesSchema,
    basis: z
      .enum(["quarterly", "cumulative_yoy"])
      .default("quarterly")
      .describe("quarterly 是 Mopsfin 單季口徑；cumulative_yoy 是指定季度的累計同比"),
    yoy_quarter: z
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .describe("basis=cumulative_yoy 時必填，指定比較 Q1–Q4 的累計同比"),
    include_industry_average: z
      .boolean()
      .default(false)
      .describe("是否加入公司所屬產業的上市／上櫃公司指標平均；不是市值加權"),
    include_company_average: z
      .boolean()
      .default(false)
      .describe("是否加入本次所選公司的簡單平均；不是市值加權"),
    ...rangeShape,
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
    if (value.basis === "cumulative_yoy" && value.yoy_quarter === undefined) {
      context.addIssue({
        code: "custom",
        path: ["yoy_quarter"],
        message: "cumulative_yoy 必須提供 yoy_quarter",
      });
    }
    if (value.basis !== "cumulative_yoy" && value.yoy_quarter !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["yoy_quarter"],
        message: "只有 cumulative_yoy 可以提供 yoy_quarter",
      });
    }
    if (
      value.start_period !== undefined &&
      value.end_period !== undefined &&
      value.start_period > value.end_period
    ) {
      context.addIssue({
        code: "custom",
        path: ["end_period"],
        message: "end_period 不得早於 start_period",
      });
    }
  });

export const companyMetricsBatchInputSchema = z
  .object({
    company_codes: z
      .array(z.string().regex(/^[0-9A-Za-z]{1,10}$/))
      .min(1)
      .max(100)
      .describe("要批次查詢的 1 至 100 個公司代號；每頁公司都會取得全部 requested metrics"),
    metric_codes: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(8)
      .describe("list_catalog 中 1 至 8 個 family=data 精確指標代號"),
    basis: z
      .enum(["quarterly", "cumulative_yoy"])
      .default("quarterly")
      .describe("沿用單指標工具的單季或指定季度累計同比口徑"),
    yoy_quarter: z.number().int().min(1).max(4).optional().describe("basis=cumulative_yoy 時必填的累計比較季度 Q1–Q4"),
    start_period: periodSchema.optional().describe("可選起始季；必須與 end_period 一起提供"),
    end_period: periodSchema.optional().describe("可選結束季；含首尾且最多 12 季"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(20)
      .describe("每頁公司數，預設及上限 20"),
    cursor: z.string().max(1000).optional().describe("上一頁回傳的 query/catalog-bound 公司游標；不代表跨頁 point-in-time 財務值快照"),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.company_codes.map((code) => code.toLowerCase())).size !== value.company_codes.length) {
      context.addIssue({ code: "custom", path: ["company_codes"], message: "company_codes 不得重複" });
    }
    if (new Set(value.metric_codes).size !== value.metric_codes.length) {
      context.addIssue({ code: "custom", path: ["metric_codes"], message: "metric_codes 不得重複" });
    }
    if (value.basis === "cumulative_yoy" && value.yoy_quarter === undefined) {
      context.addIssue({ code: "custom", path: ["yoy_quarter"], message: "cumulative_yoy 必須提供 yoy_quarter" });
    }
    if (value.basis !== "cumulative_yoy" && value.yoy_quarter !== undefined) {
      context.addIssue({ code: "custom", path: ["yoy_quarter"], message: "只有 cumulative_yoy 可以提供 yoy_quarter" });
    }
    if ((value.start_period === undefined) !== (value.end_period === undefined)) {
      context.addIssue({ code: "custom", path: ["start_period"], message: "start_period 與 end_period 必須同時提供" });
    }
    if (value.start_period && value.end_period) {
      const [startYear, startQuarter] = value.start_period.split("Q").map(Number);
      const [endYear, endQuarter] = value.end_period.split("Q").map(Number);
      const span = endYear * 4 + endQuarter - (startYear * 4 + startQuarter) + 1;
      if (span < 1) {
        context.addIssue({ code: "custom", path: ["end_period"], message: "end_period 不得早於 start_period" });
      } else if (span > 12) {
        context.addIssue({ code: "custom", path: ["end_period"], message: "批次指標範圍最多 12 季" });
      }
    }
  });

export const financialStatementInputSchema = z
  .object({
    statement: z
      .enum(["balance_sheet", "income_statement", "cash_flow"])
      .describe("balance_sheet=期末資產負債表；income_statement=累計綜合損益表；cash_flow=累計現金流量表"),
    company_codes: companyCodesSchema,
    period: requestedPeriodSchema.default("latest"),
    ...pageShape,
  })
  .strict();

export const financialNoteInputSchema = z
  .object({
    note: z
      .enum([
        "consolidated_subsidiaries",
        "loans_to_others",
        "endorsements_guarantees",
        "investees",
        "mainland_china_investments",
      ])
      .describe("附註種類：合併子公司、資金貸與、背書保證、被投資公司或大陸投資"),
    company_codes: companyCodesSchema,
    period: requestedPeriodSchema.default("latest"),
    ...pageShape,
  })
  .strict();

export const industryDataInputSchema = z
  .object({
    mode: z
      .enum(["statistics", "trend"])
      .describe("statistics=指定期別各產業累計統計；trend=所選產業跨期趨勢"),
    measure: z
      .enum(["revenue", "net_profit"])
      .default("revenue")
      .describe("要查詢的產業衡量值：revenue=營業收入，net_profit=稅後純益"),
    industry_codes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(20)
          .describe("由 list_catalog 取得的精確產業代號"),
      )
      .max(50)
      .default([])
      .describe("產業代號清單；trend 至少一個，statistics 空陣列代表上游支援的全部產業"),
    period: requestedPeriodSchema.default("latest"),
    ...rangeShape,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "trend" && value.industry_codes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["industry_codes"],
        message: "trend 至少需要一個 industry_codes",
      });
    }
  });

export const financialInstitutionInputSchema = z
  .object({
    metric_code: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("list_catalog 中 family=fin 或 adequacy 的精確金融指標代號"),
    institution_codes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(30)
          .describe("由 list_catalog 取得的金融機構代號，不一定等於股票代號"),
      )
      .min(1)
      .max(10)
      .describe("要比較的金融機構代號，1 至 10 家；需與指標適用的金控／銀行／票券業相符"),
    include_industry_average: z
      .boolean()
      .default(false)
      .describe(
        "是否加入該指標相應金融業別的產業平均 series，例如銀行業資本適足性；不是市值加權，且平均母體由 Mopsfin 決定",
      ),
    include_institution_average: z
      .boolean()
      .default(false)
      .describe(
        "是否加入本次 institution_codes 所選金融機構的簡單平均 series；不是市值加權，只有一家時仍可能由上游回傳平均 series",
      ),
    ...rangeShape,
  })
  .strict();

const metricDefinitionSchema = z
  .object({
    code: z.string().describe("呼叫資料工具時使用的精確 metric_code"),
    name: z.string().describe("Mopsfin 官方指標或報表名稱"),
    unit: z.string().describe("Mopsfin 標示的指標單位"),
    category: z.string().describe("首頁中的官方資料分類"),
    family: z
      .enum(["data", "report", "bcode", "xb", "fin", "adequacy"])
      .describe("決定使用哪個 MCP 工具／Mopsfin endpoint 的路由族群"),
    guidance: z
      .object({
        meaning: z.string().describe("指標代表的財務意義"),
        calculation: z
          .string()
          .nullable()
          .describe("官方公式；null 表示此項是原始報表／附註或官方未提供可簡化公式"),
        valueBasis: z.string().describe("單季、累計、期末或附註等數值口徑"),
        applicability: z.string().describe("適用或不適用的公司業別與申報條件"),
        caveats: z.array(z.string()).describe("使用與比較此指標時必須保留的限制"),
      })
      .strict()
      .describe("供 LLM 正確解釋這個指標的官方語意與限制"),
  })
  .strict();

const officialGuidanceSchema = z
  .object({
    sourceScope: z.array(z.string()).describe("官方資料涵蓋與排除範圍"),
    filingCadence: z
      .array(
        z
          .object({
            companyType: z.string().describe("市場別或公司類型"),
            availableQuarters: z.array(z.string()).describe("通常可申報的季度"),
            note: z.string().describe("申報頻率解釋"),
          })
          .strict(),
      )
      .describe("不同市場別的通常申報季度；實際仍依公司法規義務而異"),
    reportAvailability: z.array(z.string()).describe("四大報表與財報附註的申報可用性"),
    updateCadence: z.string().describe("Mopsfin 官方資料庫更新頻率"),
    valueBasis: z
      .array(
        z
          .object({
            dataType: z.string().describe("資料或查詢模式"),
            basis: z.string().describe("該資料的單季、累計或期末口徑"),
          })
          .strict(),
      )
      .describe("不同資料類型的數值口徑"),
    averages: z
      .array(
        z
          .object({
            name: z.string().describe("平均數名稱"),
            method: z.string().describe("官方平均數計算母體與方法"),
          })
          .strict(),
      )
      .describe("所選公司平均與產業平均的算法"),
    interpretationNotes: z.array(z.string()).describe("跨公司、跨業別與缺值解讀注意事項"),
  })
  .strict()
  .describe("Mopsfin 官方使用說明的機器可讀摘要；LLM 回答資料問題前應遵守");

export const listCatalogOutputSchema = z
  .object({
    ...successResultShape,
    ...sourceShape,
    query: z
      .object({
        kind: z
          .enum([
            "all",
            "metrics",
            "industries",
            "financial_institutions",
            "periods",
          ])
          .describe("本次實際列出的目錄類型"),
        query: z.string().optional().describe("本次實際套用的文字篩選"),
        limit: z.number().int().describe("本次每種目錄套用的項目數上限"),
      })
      .strict()
      .describe("本次實際執行的目錄查詢條件"),
    discoveredAt: z.string().describe("本次即時目錄從 Mopsfin 首頁解析的時間"),
    counts: z
      .object({
        metrics: z.number().int().describe("篩選與 limit 前的指標總數"),
        industries: z.number().int().describe("篩選與 limit 前的產業總數"),
        financialInstitutions: z.number().int().describe("篩選與 limit 前的金融機構總數"),
        periods: z.number().int().describe("首頁年度與季度組合出的期間總數"),
      })
      .strict()
      .describe("未套用 query 與 limit 前的即時目錄總數"),
    metrics: z.array(metricDefinitionSchema).describe("符合 kind/query/limit 的指標目錄及逐項 guidance"),
    industries: z.array(
      z
        .object({
          code: z.string().describe("get_industry_data 使用的 industry_code"),
          name: z.string().describe("Mopsfin 產業名稱"),
        })
        .strict(),
    ).describe("符合篩選的即時產業清單"),
    financialInstitutions: z
      .array(
        z
          .object({
            code: z.string().describe("金融機構工具使用的 institution_code"),
            name: z.string().describe("金融機構名稱"),
            sector: z
              .enum(["holding", "bank", "bills", "unknown"])
              .describe("holding=金控、bank=銀行、bills=票券；需與指標適用性相符"),
          })
          .strict(),
      )
      .describe("符合篩選的即時金控、銀行與票券業機構清單"),
    periods: z.array(periodSchema).describe("首頁目前提供選擇的期別組合；不保證每家公司都有每一期"),
    officialGuidance: officialGuidanceSchema,
    ...warningShape,
  })
  .strict();

export const companyMetricOutputSchema = z
  .object({
    ...successResultShape,
    ...sourceShape,
    query: z
      .object({
        metricCode: z.string().describe("實際查詢的 Mopsfin 指標代號"),
        metricName: z.string().describe("指標中文名稱"),
        companyCodes: z.array(z.string()).describe("已解析並實際查詢的公司代號"),
        companies: z.array(z.string()).describe("已解析的 Mopsfin 公司顯示名稱"),
        basis: z
          .enum(["quarterly", "cumulative_yoy"])
          .describe("本次數值採用的單季或指定季度累計同比口徑"),
        yoyQuarter: z.number().int().optional().describe("累計同比所指定的季度 Q1–Q4"),
        includeIndustryAverage: z
          .boolean()
          .describe("本次是否要求 Mopsfin 產業平均 series"),
        includeCompanyAverage: z
          .boolean()
          .describe("本次是否要求所選公司的簡單平均 series"),
        ...rangeOutputShape,
      })
      .strict()
      .describe("本次實際執行並正規化的查詢條件"),
    unit: trendShape.unit,
    periods: trendShape.periods,
    series: z
      .array(
        z.discriminatedUnion("seriesType", [
          seriesSchema.extend({
            seriesType: z
              .literal("company")
              .describe("此序列是一家受查公司的財務指標"),
            companyCode: z
              .string()
              .describe("此 company series 一對一綁定的公司代號"),
            companyName: z.string().describe("此 company series 的公司名稱"),
            displayName: z
              .string()
              .describe("送往 Mopsfin 並完成 identity 核對的正式公司顯示名稱"),
          }),
          seriesSchema.extend({
            seriesType: z
              .enum(["industry_average", "selection_average", "other"])
              .describe("此序列是產業平均、所選公司平均或其他非公司上游序列"),
          }),
        ]),
      )
      .describe(
        "已標示公司 identity 或平均數角色的財務指標序列；company 必含完整 identity，非公司序列不得冒用公司 identity 欄位",
      ),
    coverage: z
      .object({
        selectionComplete: z
          .boolean()
          .describe(
            "每個 requested company code 是否都唯一對應到公司 series，且本次範圍至少有一個 reported 值",
          ),
        requestedCompanyCodes: z
          .array(z.string())
          .describe("使用者要求並完成公司解析的公司代號"),
        returnedCompanyCodes: z
          .array(z.string())
          .describe("成功唯一對應到公司 series 的代號"),
        missingCompanyCodes: z
          .array(z.string())
          .describe("沒有對應公司 series 的 requested company codes"),
        noValidDataCompanyCodes: z
          .array(z.string())
          .describe(
            "本次 periods 中沒有任何 reported 數值的 requested 公司代號；包含缺少 series 的公司",
          ),
        commonThroughPeriod: periodSchema
          .nullable()
          .describe("所有 requested 公司在同一期都有 reported 數值的最新期別；不存在時為 null"),
        companies: z
          .array(
            z
              .object({
                companyCode: z.string().describe("此 coverage 列代表的公司代號"),
                seriesReturned: z
                  .boolean()
                  .describe("上游是否回傳並唯一對應此公司的 series"),
                nonNullPoints: z.number().int().describe("reported 數值點數"),
                missingPoints: z
                  .number()
                  .int()
                  .describe("本次 periods 中所有非 reported 點數，包含缺列、missing 與 invalid_upstream"),
                invalidPoints: z
                  .number()
                  .int()
                  .describe("missingPoints 中明確屬 invalid_upstream 的點數子集"),
                firstReportedPeriod: periodSchema
                  .nullable()
                  .describe("本次範圍第一個 reported 期別；沒有時為 null"),
                latestReportedPeriod: periodSchema
                  .nullable()
                  .describe("本次範圍最新 reported 期別；沒有時為 null"),
                missingPeriods: z
                  .array(periodSchema)
                  .describe("本次 periods 中 valueStatus 非 reported 的期別"),
              })
              .strict(),
          )
          .describe("依 requested company 排列的逐公司資料覆蓋統計"),
      })
      .strict()
      .describe("公司 selection identity 與實際有效數值覆蓋情況"),
    ...warningShape,
  })
  .strict();

const batchMetricCoverageSchema = z
  .object({
    seriesReturned: z.boolean().describe("上游是否回傳並唯一對應此公司 series"),
    nonNullPoints: z.number().int().describe("reported 數值點數"),
    missingPoints: z.number().int().describe("非 reported 的期別點數"),
    invalidPoints: z.number().int().describe("其中 invalid_upstream 點數"),
    firstReportedPeriod: periodSchema.nullable().describe("第一個 reported 期別；沒有時為 null"),
    latestReportedPeriod: periodSchema.nullable().describe("最新 reported 期別；沒有時為 null"),
    missingPeriods: z.array(periodSchema).describe("valueStatus 非 reported 的期別"),
  })
  .strict();

const batchFailureDetailShape = {
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
    .describe("逐公司 identity 或逐公司指標失敗的穩定錯誤代號"),
  reason: z
    .string()
    .nullable()
    .describe("更精確的穩定 failure reason；上游未提供時為 null"),
  message: z.string().describe("此失敗的可讀說明，不代表其他公司也失敗"),
  retryable: z.boolean().describe("是否適合以相同公司與指標條件稍後重試"),
  retryAfterMs: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("建議至少等待的毫秒數；上游未指定時為 null"),
  action: z
    .enum(["fix_input", "change_query", "retry", "restart_pagination", "none"])
    .describe("呼叫端針對此公司 failure 建議採取的下一步"),
};

const batchFailureDetailSchema = z
  .object(batchFailureDetailShape)
  .strict()
  .describe("availability=unavailable 時的結構化逐項失敗；不是合法 no_data");

const batchFailureSchema = z
  .discriminatedUnion("stage", [
    z
      .object({
        companyCode: z.string().describe("identity 解析失敗的 requested 公司代號"),
        stage: z.literal("identity").describe("失敗發生於公司 identity 解析"),
        metricCode: z.null().describe("identity 尚未完成，因此沒有對應指標代號"),
        attribution: z
          .literal("company")
          .describe("identity lookup 逐公司執行，可精確歸因至此公司"),
        ...batchFailureDetailShape,
      })
      .strict(),
    z
      .object({
        companyCode: z.string().describe("指標查詢受失敗影響的 requested 公司代號"),
        stage: z.literal("metric").describe("失敗發生於 Mopsfin 公司指標查詢"),
        metricCode: z.string().describe("此次 unavailable 對應的精確指標代號"),
        attribution: z
          .enum(["company", "chunk"])
          .describe(
            "company=二分隔離後可精確歸因；chunk=共享 request 或隔離預算耗盡，不能證明單一公司肇因",
          ),
        ...batchFailureDetailShape,
      })
      .strict(),
  ])
  .describe("未阻斷本頁其他公司或指標的結構化 item failure");

export const companyMetricsBatchOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCodes: z.array(z.string()).describe("本頁實際查詢的公司代號"),
        metricCodes: z.array(z.string()).describe("本頁每家公司完整查詢的指標代號"),
        basis: z.enum(["quarterly", "cumulative_yoy"]).describe("本次單季或累計同比口徑"),
        yoyQuarter: z.number().int().optional().describe("累計同比指定季度"),
        history: z.literal("recent_12").describe("批次工具固定最多最近 12 期"),
        startPeriod: periodSchema.optional().describe("實際套用的起始季"),
        endPeriod: periodSchema.optional().describe("實際套用的結束季"),
      })
      .strict()
      .describe("本頁實際執行的批次指標條件"),
    retrievedAt: z.string().describe("批次結果組裝完成的 ISO 8601 時間"),
    snapshotId: z.string().describe("本頁指標與期間內容的快照識別碼"),
    metricDefinitions: z.array(
      z
        .object({
          code: z.string().describe("精確 metric code"),
          name: z.string().describe("Mopsfin 指標名稱"),
          unit: z.string().describe("Mopsfin 指標單位"),
          category: z.string().describe("Mopsfin 指標分類"),
        })
        .strict(),
    ).describe("本次全部指標的目錄定義"),
    companies: z.array(
      z
        .object({
          companyCode: z.string().describe("此結果綁定的公司代號"),
          companyName: z.string().describe("解析後公司名稱"),
          displayName: z.string().describe("送往 Mopsfin 並核對的完整顯示值"),
          evaluationStatus: z
            .enum(["complete", "partial", "unavailable"])
            .describe(
              "complete=全部指標 available；partial=混合 available/no_data/unavailable；unavailable=全部指標均無法評估",
            ),
          metrics: z.array(
            z
              .object({
                metricCode: z.string().describe("此序列的精確指標代號"),
                metricName: z.string().describe("此序列的指標名稱"),
                unit: z.string().describe("此序列的官方單位"),
                availability: z
                  .enum(["available", "no_data", "unavailable"])
                  .describe(
                    "available=至少一個 reported 值；no_data=查詢成功但沒有 reported 值；unavailable=identity/upstream failure，不能當成 0 或 no_data",
                  ),
                periods: z.array(periodSchema).describe("此公司指標的正規化期別"),
                points: z.array(pointSchema).describe("逐期數值與 value status"),
                coverage: batchMetricCoverageSchema.describe("此公司此指標的期別覆蓋"),
                failure: batchFailureDetailSchema
                  .nullable()
                  .describe(
                    "availability=unavailable 時的錯誤；available/no_data 時為 null",
                  ),
              })
              .strict(),
          ).describe("此公司在本頁要求的全部指標"),
        })
        .strict(),
    ).describe("按公司組織的批次財務指標結果"),
    failures: z
      .array(batchFailureSchema)
      .describe(
        "逐公司 identity 或 company×metric failure；空陣列代表沒有 isolated failure，合法 no_data 不列入",
      ),
    coverage: z
      .object({
        selectionComplete: z.boolean().describe("本頁每家公司每項指標是否都有可辨識 series 與至少一個 reported 值"),
        requestedCompanyCodes: z.array(z.string()).describe("本頁 requested 公司代號"),
        returnedCompanyCodes: z.array(z.string()).describe("所有 requested metrics 都有 series 的公司代號"),
        missingCompanyCodes: z.array(z.string()).describe("至少一項 requested metric 缺 series 的公司代號"),
        noValidDataCompanyCodes: z.array(z.string()).describe("全部 requested metrics 都沒有 reported 值的公司代號"),
        unavailableCompanyCodes: z
          .array(z.string())
          .describe(
            "至少一項 identity 或指標因 failure 而 unavailable 的公司代號；不得解讀成合法 no_data",
          ),
        sourceComplete: z
          .boolean()
          .describe(
            "本頁是否沒有 incomplete-coverage、timeout、rate-limit 或 bad-response source failure；identity NOT_FOUND 只降低 selection，不會假裝成來源故障",
          ),
        failureIsolationComplete: z
          .boolean()
          .describe(
            "所有 metric failure 是否都精確隔離到單一公司；false 時必須檢查 failures[].attribution=chunk",
          ),
        identityFailedCompanyCodes: z
          .array(z.string())
          .describe("逐公司 identity 解析失敗且未建立 companies[] 結果的代號"),
        metrics: z.array(
          z
            .object({
              metricCode: z.string().describe("此 coverage 的指標代號"),
              returnedCompanyCodes: z.array(z.string()).describe("此指標有 series 的公司代號"),
              missingCompanyCodes: z.array(z.string()).describe("此指標缺 series 的公司代號"),
              noValidDataCompanyCodes: z.array(z.string()).describe("此指標沒有任何 reported 值的公司代號"),
              unavailableCompanyCodes: z
                .array(z.string())
                .describe("此指標因 identity 或 upstream failure 而 unavailable 的公司代號"),
            })
            .strict(),
        ).describe("依指標拆分的公司 selection 與有效值覆蓋"),
      })
      .strict()
      .describe("本頁公司與指標的完整覆蓋狀態"),
    workBudget: z
      .object({
        comparisonPlanUnits: z
          .number()
          .int()
          .describe("依 requested 公司 chunks 與指標數計算的原始 comparison plan units"),
        comparisonExecutedUnits: z
          .number()
          .int()
          .describe("本頁實際執行的 comparison units，包含有界 failure isolation retry"),
        isolationRetryUnits: z
          .number()
          .int()
          .describe("為二分隔離 company-specific metric failure 額外使用的 units"),
        comparisonUnitLimit: z.literal(24).describe("本頁 comparison 與 isolation 合計上限"),
        identityLookupUpperBound: z
          .number()
          .int()
          .describe("本頁最多進行的逐公司 identity logical lookups；cache hit 可降低 HTTP 次數"),
        unitDefinition: z
          .literal("one_metric_by_up_to_ten_companies_request")
          .describe("一個 unit 等於一項指標乘最多十家公司的一次 Mopsfin request"),
      })
      .strict()
      .describe("本頁原始 plan、實際執行與 failure isolation 工作量"),
    sources: z.array(z.object(sourceShape).strict()).describe("本頁實際使用的 Mopsfin 來源呼叫"),
    ...warningShape,
  })
  .strict();

const tableSchema = z
  .object({
    title: z.string().describe("由上游表格標題或報表名稱正規化的表格名稱"),
    headers: z
      .array(z.array(z.string()))
      .describe("展開 rowspan/colspan 後的完整多層二維表頭；每個內層陣列是一列"),
    rows: z
      .array(z.array(z.string()))
      .describe("與 headers 欄位順序對應的表格資料列；保留上游文字與缺值符號"),
  })
  .strict();

const paginationSchema = z
  .object({
    offset: z.number().int().describe("本頁第一列在所有表格資料列中的零起算位移"),
    limit: z.number().int().describe("本頁要求的列數上限"),
    returnedRows: z.number().int().describe("本頁實際回傳列數"),
    totalRows: z.number().int().describe("所有表格合計的資料列總數"),
    nextOffset: z
      .number()
      .int()
      .nullable()
      .describe("下一頁應使用的 offset；null 表示已讀完。LLM 應在需要完整表格時繼續分頁"),
  })
  .strict();

export const financialStatementOutputSchema = z
  .object({
    ...successResultShape,
    ...sourceShape,
    query: z
      .object({
        statement: z
          .enum(["balance_sheet", "income_statement", "cash_flow"])
          .describe("實際查詢的報表種類"),
        companyCodes: z.array(z.string()).describe("實際查詢的公司代號"),
        companies: z.array(z.string()).describe("解析後的公司顯示名稱"),
        period: periodSchema.describe("latest 探測後或使用者指定且核對成功的實際報表期別"),
      })
      .strict()
      .describe("實際執行的財報查詢條件"),
    unit: z.string().describe("Mopsfin 報表金額單位；常見為新台幣仟元，回答時必須保留"),
    period: periodSchema.describe("已核對上游回應後的實際期別"),
    reportNames: z.array(z.string()).describe("上游回應內辨識出的報表名稱"),
    tables: z.array(tableSchema).describe("本頁正規化並展開合併儲存格後的表格"),
    pagination: paginationSchema.describe("跨多張表格的整體分頁資訊"),
    ...warningShape,
  })
  .strict();

export const financialNoteOutputSchema = financialStatementOutputSchema.extend({
  query: z
    .object({
      note: z
        .enum([
          "consolidated_subsidiaries",
          "loans_to_others",
          "endorsements_guarantees",
          "investees",
          "mainland_china_investments",
        ])
        .describe("實際查詢的財報附註種類"),
      companyCodes: z.array(z.string()).describe("實際查詢的公司代號"),
      companies: z.array(z.string()).describe("解析後的公司顯示名稱"),
      period: periodSchema.describe("latest 探測後或使用者指定且核對成功的實際附註期別"),
    })
    .strict()
    .describe("實際執行的附註查詢條件"),
}).strict();

export const industryDataOutputSchema = z
  .object({
    ...successResultShape,
    ...sourceShape,
    query: z
      .object({
        mode: z.enum(["statistics", "trend"]).describe("實際查詢的產業統計或趨勢模式"),
        measure: z.enum(["revenue", "net_profit"]).describe("實際查詢的營業收入或稅後純益"),
        industryCodes: z.array(z.string()).describe("實際查詢的產業代號"),
        industries: z.array(z.string()).optional().describe("代號解析後的產業名稱"),
        period: periodSchema.optional().describe("statistics 實際核對成功的期別"),
        history: z.enum(["recent_12", "all"]).optional().describe("trend 的歷史範圍模式"),
        startPeriod: z.string().optional().describe("trend 的起始期別（含）"),
        endPeriod: z.string().optional().describe("trend 的結束期別（含）"),
      })
      .strict()
      .describe("實際執行的產業查詢條件"),
    ...trendShape,
    ...warningShape,
  })
  .strict();

export const financialInstitutionOutputSchema = z
  .object({
    ...successResultShape,
    ...sourceShape,
    query: z
      .object({
        metricCode: z.string().describe("實際查詢的金融指標代號"),
        metricName: z.string().describe("金融指標中文名稱"),
        institutionCodes: z.array(z.string()).describe("實際查詢的金融機構代號"),
        institutions: z.array(z.string()).describe("代號解析後的金融機構名稱"),
        includeIndustryAverage: z
          .boolean()
          .describe("本次是否要求 Mopsfin 加入相應金融業別的產業平均 series"),
        includeInstitutionAverage: z
          .boolean()
          .describe("本次是否要求 Mopsfin 加入所選金融機構的簡單平均 series"),
        ...rangeOutputShape,
      })
      .strict()
      .describe("實際執行的金融機構查詢條件"),
    ...trendShape,
    ...warningShape,
  })
  .strict();

