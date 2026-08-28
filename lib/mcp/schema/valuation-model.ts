import { z } from "zod";

import {
  calendarDateSchema,
  periodSchema,
  sourceCacheObservationSchema,
  successResultShape,
} from "./common";

const fieldIdSchema = z
  .enum([
    "ttmRevenue",
    "ttmOperatingIncomeEbitProxy",
    "cashTaxRatePercent",
    "ttmDepreciationAndAmortization",
    "ttmCapitalExpenditure",
    "ttmDeltaNetWorkingCapital",
    "normalizedFcff",
    "cashAndCashEquivalents",
    "interestBearingDebt",
    "netDebt",
    "issuedShares",
    "latestOfficialClose",
    "marketCapitalization",
    "enterpriseValue",
  ])
  .describe("估值模型輸入或 bridge 欄位的穩定識別碼");

const evidenceClassSchema = z
  .enum([
    "MOPSFIN_RAW",
    "MOPSFIN_CALC",
    "OFFICIAL_MASTER_RAW",
    "OFFICIAL_MARKET_RAW",
    "OFFICIAL_CALC",
    "MIXED_OFFICIAL_CALC",
    "UNAVAILABLE",
  ])
  .describe(
    "欄位證據類別；區分 Mopsfin 原值／計算、官方公司母體／市場原值、同來源或跨來源計算，以及不可用資料",
  );

const dataGapReasonSchema = z
  .enum([
    "STATEMENT_UNAVAILABLE",
    "STATEMENT_CONTRACT_MISMATCH",
    "STATEMENT_UNIT_UNAVAILABLE",
    "STATEMENT_UNIT_UNSUPPORTED",
    "STATEMENT_IDENTITY_MISMATCH",
    "STATEMENT_CONSOLIDATION_SCOPE_MISMATCH",
    "ROW_ROLE_MISSING",
    "ROW_ROLE_AMBIGUOUS",
    "ROW_VALUE_INVALID",
    "TTM_COMPONENT_UNAVAILABLE",
    "TTM_PERIOD_MISMATCH",
    "NO_REPORTED_DEBT_COMPONENTS",
    "UNMAPPED_DEBT_LIKE_ROW",
    "COMPANY_PROFILE_VALUE_UNAVAILABLE",
    "VALUATION_VALUE_UNAVAILABLE",
    "SOURCE_DEPENDENCY_FAILED",
    "DERIVED_INPUT_UNAVAILABLE",
    "NOT_APPLICABLE_FINANCIAL_COMPANY",
  ])
  .describe("data_gap 或 not_applicable 的穩定 fail-closed 原因代碼");

const unitSchema = z
  .enum(["TWD", "TWD_per_share", "share", "percent"])
  .describe("欄位正規化單位");

const inputFieldSchema = z
  .object({
    id: fieldIdSchema.describe("此欄位的穩定識別碼，必須與 fields object key 一致"),
    value: z
      .number()
      .finite()
      .nullable()
      .describe("正規化數值；data_gap 或 not_applicable 必須為 null，不以 0 補值"),
    unit: unitSchema.describe("此數值的正規化單位"),
    status: z
      .enum(["reported", "derived", "data_gap", "not_applicable"])
      .describe("來源原值、可重算衍生值、資料缺口或模型不適用"),
    evidenceClass: evidenceClassSchema.describe("此欄位數值的來源／計算證據分類"),
    formula: z
      .string()
      .nullable()
      .describe("衍生值的可重算公式；reported 或不適用時為 null"),
    inputFieldIds: z
      .array(fieldIdSchema)
      .describe("公式直接引用的其他模型欄位識別碼"),
    inputLineageIds: z
      .array(z.string().min(1).describe("此欄位引用的 lineage 識別碼"))
      .describe("來源列或 dependency search attempts 的 lineage references"),
    dataGapReason: dataGapReasonSchema
      .nullable()
      .describe("缺資料／不適用原因；有可用數值時為 null"),
    notes: z
      .array(z.string().min(1).describe("此欄位的口徑、限制或 fail-closed 說明"))
      .describe("欄位層級的可讀口徑與警語"),
  })
  .strict()
  .superRefine((field, context) => {
    const unavailable = field.status === "data_gap" || field.status === "not_applicable";
    if (unavailable) {
      if (field.value !== null) {
        context.addIssue({ code: "custom", path: ["value"], message: "data_gap/not_applicable 的 value 必須為 null" });
      }
      if (field.evidenceClass !== "UNAVAILABLE") {
        context.addIssue({ code: "custom", path: ["evidenceClass"], message: "data_gap/not_applicable 必須標示 UNAVAILABLE" });
      }
      if (field.dataGapReason === null) {
        context.addIssue({ code: "custom", path: ["dataGapReason"], message: "data_gap/not_applicable 必須提供 reason" });
      }
      if (field.status === "data_gap" && field.inputLineageIds.length === 0) {
        context.addIssue({ code: "custom", path: ["inputLineageIds"], message: "data_gap 必須引用至少一個 lineage/search attempt" });
      }
    } else {
      if (field.value === null) {
        context.addIssue({ code: "custom", path: ["value"], message: "reported/derived 必須提供 value" });
      }
      if (field.evidenceClass === "UNAVAILABLE") {
        context.addIssue({ code: "custom", path: ["evidenceClass"], message: "有值欄位不可標示 UNAVAILABLE" });
      }
      if (field.dataGapReason !== null) {
        context.addIssue({ code: "custom", path: ["dataGapReason"], message: "有值欄位的 dataGapReason 必須為 null" });
      }
    }
    if (field.status === "derived" && !field.formula) {
      context.addIssue({ code: "custom", path: ["formula"], message: "derived 欄位必須提供公式" });
    }
    if (field.status === "reported" && field.formula !== null) {
      context.addIssue({ code: "custom", path: ["formula"], message: "reported 欄位的 formula 必須為 null" });
    }
  })
  .describe("單一可追溯估值模型輸入；缺值一律 fail closed，不以零替代");

const marketSchema = z
  .enum(["listed", "otc"])
  .describe("目前公司 master 核對後的上市或上櫃市場");
const exchangeSchema = z
  .enum(["TWSE", "TPEx"])
  .describe("公司目前所屬的官方市場機構");

const sourceBaseShape = {
  sourceId: z.string().min(1).describe("本結果內唯一的來源識別碼，供 lineage 引用"),
  sourceName: z.string().min(1).describe("官方資料來源名稱"),
  sourceUrl: z.string().url().describe("本次實際讀取的官方來源 URL"),
  retrievedAt: z.string().min(1).describe("真正取得此 upstream value 的 ISO 8601 時間，不以 servedAt 冒充"),
  cache: sourceCacheObservationSchema
    .optional()
    .describe("可選的 caller-specific cache provenance；不改寫 retrievedAt"),
};

const statementSourceSchema = z
  .object({
    ...sourceBaseShape,
    stage: z.literal("statement").describe("此來源是 Mopsfin 財務報表 dependency"),
    upstreamRoute: z.string().min(1).describe("Mopsfin 實際報表 route"),
    statement: z
      .enum(["balance_sheet", "income_statement", "cash_flow"])
      .describe("報表類型"),
    period: periodSchema.describe("此報表實際解析到的財報季度"),
    asOf: periodSchema.describe("供統一 source cutoff 使用的財報季度"),
    asOfGranularity: z.literal("quarter").describe("財報 cutoff 的時間粒度固定為 quarter"),
    reportName: z.string().min(1).describe("上游報表中用來核對公司 identity 與市場的 report name"),
    rawUnit: z.string().min(1).describe("Mopsfin HTML 或 catalog 明示的原始金額單位"),
    unitSource: z
      .enum(["response_html", "catalog", "unavailable"])
      .describe("原始金額單位的證據來源；unavailable 不得用於已解析報表"),
    normalizedUnit: z.literal("TWD").describe("所有財報金額統一正規化為 TWD"),
    amountMultiplier: z.literal(1000).describe("新台幣仟／千元轉成 TWD 的固定倍率"),
    consolidationScope: z
      .enum(["consolidated", "standalone"])
      .describe("由表頭解析的合併或個體報表範圍"),
  })
  .strict()
  .refine((source) => source.unitSource !== "unavailable", {
    path: ["unitSource"],
    message: "已解析 statement source 不可使用 unavailable 單位證據",
  })
  .describe("一份經 identity、期別、單位與合併範圍核對的 Mopsfin 報表來源");

const companyMasterSourceSchema = z
  .object({
    ...sourceBaseShape,
    stage: z.literal("company_master").describe("此來源是目前上市櫃公司 master dependency"),
    market: marketSchema.describe("此公司 master 來源負責的市場"),
    exchange: exchangeSchema.describe("此公司 master 來源的官方市場機構"),
    reportDate: calendarDateSchema.describe("官方公司 master 的出表日期"),
    asOf: calendarDateSchema.describe("供統一 source cutoff 使用的 master 出表日期"),
    asOfGranularity: z.literal("date").describe("公司 master cutoff 的時間粒度固定為 date"),
  })
  .strict()
  .describe("目前官方上市櫃公司 identity 與 issued shares 的來源");

const marketSourceSchema = z
  .object({
    ...sourceBaseShape,
    stage: z.literal("market_valuation").describe("此來源是 latest 官方估值／收盤價 dependency"),
    market: marketSchema.describe("此行情來源負責的市場"),
    exchange: exchangeSchema.describe("此行情來源的官方市場機構"),
    dataDate: calendarDateSchema.describe("官方估值與收盤價的實際完成交易日"),
    asOf: calendarDateSchema.describe("供統一 source cutoff 使用的完成交易日"),
    asOfGranularity: z.literal("date").describe("市場資料 cutoff 的時間粒度固定為 date"),
  })
  .strict()
  .describe("官方 latest 估值日與 completed-session close 的來源");

const sourceSchema = z
  .discriminatedUnion("stage", [
    statementSourceSchema,
    companyMasterSourceSchema,
    marketSourceSchema,
  ])
  .describe("估值輸入使用的 normalized official source lineage");

const lineageEntrySchema = z
  .object({
    lineageId: z.string().min(1).describe("本結果內唯一的 lineage entry 識別碼"),
    role: z.string().min(1).describe("穩定 row role、來源欄位或 dependency search attempt 名稱"),
    status: z
      .enum(["resolved", "missing", "ambiguous", "invalid"])
      .describe("此 role 解析成功、缺少、歧義或值無效"),
    sourceId: z.string().min(1).nullable().describe("對應 sources[].sourceId；無可用 upstream source 時為 null"),
    statement: z
      .enum(["balance_sheet", "income_statement", "cash_flow"])
      .nullable()
      .describe("此證據所屬報表；公司 master／市場欄位或未解析 dependency 時可為 null"),
    period: z.string().nullable().describe("來源季度、日期、latest attempt 或其他可追查期別"),
    rowLabel: z.string().nullable().describe("實際命中的原始列名／欄位名；未命中時為 null"),
    rawValue: z.union([z.string(), z.number().finite()]).nullable().describe("上游原始字串或數值；未命中時為 null"),
    normalizedValue: z.number().finite().nullable().describe("依明示單位正規化後的數值；不可解析時為 null"),
    unit: unitSchema.describe("normalizedValue 的單位"),
    candidateRowLabels: z
      .array(z.string().describe("resolver 審核過的候選原始列名"))
      .describe("用於說明成功、缺少或歧義的候選列證據"),
    notes: z
      .array(z.string().min(1).describe("此 lineage entry 的解析或 search-attempt 說明"))
      .describe("解析規則、失敗原因與保守限制"),
  })
  .strict()
  .describe("可由欄位 inputLineageIds 追查的單一原始列或 dependency search attempt");

const fieldsShape = Object.fromEntries(
  fieldIdSchema.options.map((id) => [
    id,
    inputFieldSchema.describe(`${id} 的正規化值、公式、狀態與 lineage`),
  ]),
) as Record<(typeof fieldIdSchema.options)[number], typeof inputFieldSchema>;

export const valuationModelInputsInputSchema = z
  .object({
    company_code: z
      .string()
      .regex(/^\d{4}$/)
      .describe("單一四碼台灣上市或上櫃公司股票代號；不確定時先用 find_companies"),
  })
  .strict()
  .describe("取得單一非金融公司 latest 可追溯估值模型輸入的查詢");

export const valuationModelInputsDataSchema = z
  .object({
    query: z
      .object({
        companyCode: z.string().regex(/^\d{4}$/).describe("實際查詢並由目前 company master 核對的公司代號"),
        financialPeriod: z.literal("latest").describe("財報 selector 固定為 latest，實際季度見 periods 與 sources"),
        priceDate: z.literal("latest_completed_official_session").describe("價格 selector 固定為官方最近完成估值日收盤，不是盤中價"),
      })
      .strict()
      .describe("實際套用的公司、財報與市場價格 selectors"),
    generatedAt: z.string().min(1).describe("本 domain result 組裝完成的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("市場日期與 latest selector 使用的時區"),
    currency: z.literal("TWD").describe("所有金額正規化後的幣別"),
    scope: z.literal("normalized_valuation_model_inputs").describe("本結果只提供已正規化且可追溯的估值模型輸入"),
    posture: z.literal("research_model_input_evidence_only").describe("本工具是研究模型資料層，不輸出評級、目標價或投資建議"),
    applicability: z
      .object({
        status: z.enum(["applicable", "not_applicable"]).describe("一般企業 FCFF／enterprise-value 模型是否適用"),
        reason: z.literal("financial_company_requires_residual_income_or_dividend_model").nullable().describe("金融公司不適用的一致原因；一般企業為 null"),
      })
      .strict()
      .describe("模型適用性；金融業 fail closed，不硬套一般企業 FCFF"),
    company: z
      .object({
        code: z.string().regex(/^\d{4}$/).describe("目前公司 master 的四碼公司代號"),
        name: z.string().min(1).describe("目前公司 master 的公司全名"),
        shortName: z.string().min(1).describe("目前公司 master 的公司簡稱"),
        market: marketSchema.describe("目前公司 master 核對的上市或上櫃市場"),
        exchange: exchangeSchema.describe("目前公司所屬 TWSE 或 TPEx"),
        industryCode: z.string().min(1).describe("目前公司 master 的產業代號"),
        isFinancial: z.boolean().describe("公司是否屬金融保險業；true 時一般企業 FCFF 不適用"),
      })
      .strict()
      .describe("由目前官方公司 master 唯一核對的公司 identity"),
    periods: z
      .object({
        latestReportedPeriod: periodSchema.nullable().describe("三大報表共同解析到的 latest 財報季度；無一致季度時為 null"),
        ttmMethod: z.enum(["fiscal_year", "current_ytd_plus_prior_fy_minus_prior_year_ytd", "unavailable"]).describe("TTM 採 Q4 FY，或 current YTD + prior FY - prior-year YTD；不可安全建立時 unavailable"),
        currentYtdPeriod: periodSchema.nullable().describe("TTM current YTD／FY 的季度"),
        priorFiscalYearPeriod: periodSchema.nullable().describe("非 Q4 TTM bridge 使用的前一年度 Q4；不適用時為 null"),
        priorYearYtdPeriod: periodSchema.nullable().describe("非 Q4 TTM bridge 使用的前一年同期 YTD；不適用時為 null"),
        fiscalYearBasis: z.literal("mopsfin_calendar_year_quarters").describe("目前依 Mopsfin 西元 calendar-year quarter 期別建立 bridge"),
        consolidationScope: z.enum(["consolidated", "standalone"]).nullable().describe("所有必要報表共同的合併範圍；不一致或不可得時為 null"),
      })
      .strict()
      .describe("latest 財報季度、TTM bridge 與合併範圍"),
    fields: z
      .object(fieldsShape)
      .strict()
      .superRefine((fields, context) => {
        for (const [key, field] of Object.entries(fields)) {
          if (field.id !== key) {
            context.addIssue({ code: "custom", path: [key, "id"], message: "field.id 必須與 fields key 一致" });
          }
        }
      })
      .describe("十四個估值模型輸入／bridge 欄位；每欄都含 status、evidence class、公式與 lineage"),
    lineage: z.array(lineageEntrySchema).describe("所有成功解析與失敗 search attempts 的可稽核 lineage ledger"),
    sources: z.array(sourceSchema).describe("公司 master、Mopsfin 報表及官方市場資料的 normalized sources"),
    quality: z
      .object({
        calculationComplete: z.boolean().describe("所有十四個一般企業欄位是否都沒有 data_gap；不代表 freshness 已驗證"),
        dataGapFields: z.array(fieldIdSchema).describe("維持 null、沒有補 0 的 data_gap 欄位"),
        notApplicableFields: z.array(fieldIdSchema).describe("因公司類型而不適用的欄位；金融公司應列出全部欄位"),
      })
      .strict()
      .describe("domain 層的計算完整性、資料缺口與不適用欄位"),
    workBudget: z
      .object({
        requestedCompanies: z.literal(1).describe("每次固定只處理一家公司"),
        orchestrationCompanyMasterCalls: z.literal(1).describe("orchestration 層公司 master 呼叫數"),
        statementCalls: z
          .object({
            actual: z.number().int().min(0).max(7).describe("本次實際 Mopsfin statement calls"),
            maximum: z.literal(7).describe("三大 latest 報表加兩個歷史期別損益／現金流的硬上限"),
            rowsPerCallMaximum: z.literal(500).describe("每次 statement dependency 的最大表格列數"),
          })
          .strict()
          .describe("Mopsfin 財報 dependency 的 bounded 工作量"),
        valuationDependencyCalls: z
          .object({
            actual: z.union([z.literal(0), z.literal(1)]).describe("本次官方 latest 估值／close dependency 呼叫數"),
            maximum: z.literal(1).describe("估值 dependency 的 orchestration 呼叫硬上限"),
            internalCurrentMasterPolicy: z.literal("strict_current_master").describe("latest close 必須依目前 company master 嚴格核對"),
          })
          .strict()
          .describe("官方市場 close dependency 的 bounded 工作量與 identity policy"),
      })
      .strict()
      .describe("本次 normalization orchestration 的明確工作量上限與實際呼叫數"),
    warnings: z.array(z.string().min(1).describe("模型輸入的資料限制、口徑或 dependency 警語")).describe("不可忽略的模型輸入口徑與資料限制"),
  })
  .strict()
  .superRefine((result, context) => {
    const ids = fieldIdSchema.options;
    const dataGap = ids.filter((id) => result.fields[id].status === "data_gap");
    const notApplicable = ids.filter((id) => result.fields[id].status === "not_applicable");
    if (JSON.stringify(result.quality.dataGapFields) !== JSON.stringify(dataGap)) {
      context.addIssue({ code: "custom", path: ["quality", "dataGapFields"], message: "dataGapFields 必須依固定欄位順序精確對應 fields status" });
    }
    if (JSON.stringify(result.quality.notApplicableFields) !== JSON.stringify(notApplicable)) {
      context.addIssue({ code: "custom", path: ["quality", "notApplicableFields"], message: "notApplicableFields 必須依固定欄位順序精確對應 fields status" });
    }
    if (result.quality.calculationComplete !== (dataGap.length === 0 && result.applicability.status === "applicable")) {
      context.addIssue({ code: "custom", path: ["quality", "calculationComplete"], message: "calculationComplete 必須與 applicability 和 dataGapFields 一致" });
    }
    const sourceIds = result.sources.map((source) => source.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({ code: "custom", path: ["sources"], message: "sourceId 不得重複" });
    }
    const lineageIds = result.lineage.map((entry) => entry.lineageId);
    if (new Set(lineageIds).size !== lineageIds.length) {
      context.addIssue({ code: "custom", path: ["lineage"], message: "lineageId 不得重複" });
    }
    const sourceSet = new Set(sourceIds);
    const lineageSet = new Set(lineageIds);
    for (const [index, entry] of result.lineage.entries()) {
      if (entry.sourceId !== null && !sourceSet.has(entry.sourceId)) {
        context.addIssue({ code: "custom", path: ["lineage", index, "sourceId"], message: "lineage sourceId 必須存在於 sources" });
      }
    }
    for (const [fieldId, field] of Object.entries(result.fields)) {
      for (const lineageId of field.inputLineageIds) {
        if (!lineageSet.has(lineageId)) {
          context.addIssue({
            code: "custom",
            path: ["fields", fieldId, "inputLineageIds"],
            message: `inputLineageId ${lineageId} 必須存在於 lineage ledger`,
          });
        }
      }
    }
    if (result.applicability.status === "not_applicable") {
      if (result.applicability.reason === null) {
        context.addIssue({ code: "custom", path: ["applicability", "reason"], message: "not_applicable 必須提供金融業模型原因" });
      }
      if (notApplicable.length !== ids.length) {
        context.addIssue({ code: "custom", path: ["fields"], message: "not_applicable 公司必須讓全部欄位維持 not_applicable" });
      }
    } else {
      if (result.applicability.reason !== null) {
        context.addIssue({ code: "custom", path: ["applicability", "reason"], message: "applicable 公司的 reason 必須為 null" });
      }
      if (notApplicable.length > 0) {
        context.addIssue({ code: "custom", path: ["fields"], message: "applicable 公司不得混入 not_applicable 欄位" });
      }
    }
  })
  .describe("可直接供顯性假設模型使用、但本身不執行估值判斷的 normalized valuation inputs");

export const valuationModelInputsOutputSchema = z
  .object({
    ...successResultShape,
    ...valuationModelInputsDataSchema.shape,
  })
  .strict()
  .describe("get_valuation_model_inputs 的成功結果與共用 MCP metadata");
