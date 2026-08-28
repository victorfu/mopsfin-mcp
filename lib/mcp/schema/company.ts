import { z } from "zod";

import {
  optionalCompanyPageShape,
  sourceCacheObservationSchema,
  sourceShape,
  successResultShape,
  warningShape,
} from "./common";

export const findCompaniesInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .describe("公司代號或中英文名稱，例如 2330 或台積電"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(10)
      .describe("最多回傳幾個候選公司，預設 10、上限 20"),
  })
  .strict();

export const listCompaniesInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe(
        "公司母體市場：all=上市與上櫃全部、listed=只取 TWSE 上市（含創新板）、otc=只取 TPEx 上櫃",
      ),
    include_financial: z
      .boolean()
      .default(true)
      .describe(
        "是否保留產業代號 17 的金融保險業公司；預設 true，設為 false 可建立排除金融業的掃描母體",
      ),
    include_ky: z
      .boolean()
      .default(true)
      .describe(
        "是否保留註冊地為 KY 或公司簡稱標示 -KY 的公司；預設 true，設為 false 可排除 KY 公司",
      ),
    ...optionalCompanyPageShape,
  })
  .strict();

export const findCompaniesOutputSchema = z
  .object({
    ...successResultShape,
    ...sourceShape,
    query: z
      .object({
        query: z.string().describe("實際使用的搜尋文字"),
        limit: z.number().int().describe("實際套用的結果筆數上限"),
      })
      .strict()
      .describe("正規化後的查詢條件"),
    companies: z.array(
      z
        .object({
          code: z.string().describe("其他公司工具使用的 company_code"),
          name: z.string().describe("公司名稱"),
          displayName: z.string().describe("Mopsfin 上游需要的完整公司顯示值"),
        })
        .strict(),
    ).describe("符合搜尋文字的公司候選清單"),
    ...warningShape,
  })
  .strict();

const masterCompanySchema = z
  .object({
    code: z
      .string()
      .describe("可直接交給 Mopsfin 公司財務工具使用的四碼公司代號"),
    name: z.string().describe("TWSE／TPEx 官方公司全名"),
    shortName: z.string().describe("TWSE／TPEx 官方公司簡稱"),
    market: z
      .enum(["listed", "otc"])
      .describe("公司市場別：listed=上市、otc=上櫃"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("掛牌交易所或櫃買中心"),
    industryCode: z
      .string()
      .describe("官方產業代號；可用 list_catalog 的 industries 對照即時產業名稱"),
    listingDate: z
      .string()
      .describe("正規化為 YYYY-MM-DD 的上市或上櫃日期"),
    incorporationDate: z
      .string()
      .nullable()
      .describe("目前官方基本資料的成立日期 YYYY-MM-DD；缺失或無效時為 null"),
    paidInCapitalTwd: z
      .number()
      .int()
      .nullable()
      .describe("目前官方實收資本額 TWD；不可用時為 null"),
    issuedCommonShares: z
      .number()
      .int()
      .nullable()
      .describe("目前官方已發行普通股數；不可用時為 null，不代表歷史股數"),
    parValueText: z
      .string()
      .nullable()
      .describe("普通股每股面額官方原文，保留外幣、無面額等語意"),
    financialReportTypeCode: z
      .string()
      .nullable()
      .describe("官方編制財務報表類型原始代碼；不自行推定代碼語意"),
    profileValueStatus: z
      .object({
        incorporationDate: z.enum(["reported", "missing", "invalid_upstream"]).describe("成立日期狀態"),
        paidInCapitalTwd: z.enum(["reported", "missing", "invalid_upstream"]).describe("實收資本額狀態"),
        issuedCommonShares: z.enum(["reported", "missing", "invalid_upstream"]).describe("已發行普通股數狀態"),
        parValueText: z.enum(["reported", "missing", "invalid_upstream"]).describe("每股面額原文狀態"),
        financialReportTypeCode: z.enum(["reported", "missing", "invalid_upstream"]).describe("財報類型原始代碼狀態"),
      })
      .strict()
      .describe("新增公司母體欄位的逐欄可用性與解析狀態"),
    domicileCode: z
      .string()
      .describe("公司註冊地國代碼；TW 表示本國公司，KY 表示開曼群島"),
    isKy: z
      .boolean()
      .describe("是否為註冊地 KY 或官方簡稱標示 -KY 的公司"),
    isFinancial: z
      .boolean()
      .describe("是否屬官方產業代號 17 的金融保險業"),
  })
  .strict();

const companyMasterSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此來源負責的上市或上櫃市場"),
    exchange: z.enum(["TWSE", "TPEx"]).describe("此來源的官方市場機構"),
    sourceName: z.string().describe("官方公司基本資料集名稱"),
    sourceUrl: z.string().url().describe("本次使用的固定官方 OpenAPI URL"),
    reportDate: z
      .string()
      .describe("上游資料列的出表日期，已由民國日期正規化為 YYYY-MM-DD"),
    retrievedAt: z.string().describe("本服務實際取得這份來源快照的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("公司母體來源的 caller-specific cache provenance"),
    rawCount: z.number().int().describe("此官方來源正規化與排除 TDR 前的原始筆數"),
    excludedTdrCount: z
      .number()
      .int()
      .describe("此來源為符合 Mopsfin 公司範圍而排除的 TDR 筆數"),
    companyCount: z
      .number()
      .int()
      .describe("此來源排除 TDR 後、套用使用者篩選前的公司數"),
    minimumExpectedCount: z
      .number()
      .int()
      .describe(
        "此來源用來偵測明顯截斷回應的最低筆數 heuristic；不是官方 declared row count，也不能證明完整 rowset",
      ),
  })
  .strict();

export const listCompaniesOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        market: z
          .enum(["all", "listed", "otc"])
          .describe("本次實際取得的市場範圍"),
        includeFinancial: z
          .boolean()
          .describe("本次是否保留金融保險業公司"),
        includeKy: z.boolean().describe("本次是否保留 KY 公司"),
      })
      .strict()
      .describe("正規化後實際套用的公司母體條件"),
    generatedAt: z.string().describe("本服務組合並篩選回傳結果的 ISO 8601 時間"),
    snapshotId: z
      .string()
      .describe(
        "由市場別與各來源出表日期組成的來源日期標籤，不是內容 hash；cursor 綁定的內容快照識別請使用 meta.asOf.snapshotId",
      ),
    coverageVerification: z
      .object({
        status: z
          .literal("heuristic")
          .describe("母體覆蓋驗證等級；目前只能標示為 heuristic"),
        method: z
          .literal("required_sources_schema_single_report_date_minimum_count")
          .describe(
            "已驗證必要來源、schema、單一出表日期、唯一代號與最低筆數門檻",
          ),
        officialDeclaredRowCountAvailable: z
          .literal(false)
          .describe("官方來源是否提供可核對的 declared row count；目前固定為 false"),
      })
      .strict()
      .describe(
        "公司母體 rowset 的驗證方式與限制；通過 heuristic gate 不等於已由官方總筆數證明完整",
      ),
    coverageComplete: z
      .literal(true)
      .describe(
        "向後相容成功旗標：true 僅表示必要來源、必要欄位、單一出表日期、唯一代號與最低筆數 heuristic gate 均通過；官方沒有 declared row count，不能據此宣稱完整 rowset；任一必要來源失敗時工具會整體報錯",
      ),
    sources: z
      .array(companyMasterSourceSchema)
      .describe("本次使用的 TWSE／TPEx 官方來源、日期、實際筆數與最低筆數 heuristic"),
    counts: z
      .object({
        raw: z.number().int().describe("官方來源合計原始筆數，可能包含隨後排除的 TDR"),
        excludedTdr: z.number().int().describe("為符合 Mopsfin 範圍而排除的 TDR 總數"),
        eligible: z
          .number()
          .int()
          .describe("排除 TDR 後、套用金融與 KY 篩選前的上市櫃公司總數"),
        excludedFinancial: z
          .number()
          .int()
          .describe("因 include_financial=false 實際排除的金融保險業公司數"),
        excludedKy: z
          .number()
          .int()
          .describe("因 include_ky=false 在前述篩選後實際排除的 KY 公司數"),
        listed: z.number().int().describe("本頁回傳的上市公司數；未啟用分頁時即為本次 accepted snapshot 的全部結果"),
        otc: z.number().int().describe("本頁回傳的上櫃公司數；未啟用分頁時即為本次 accepted snapshot 的全部結果"),
        returned: z.number().int().describe("本頁 companies 陣列公司總數；完整總數另見 meta.page.total"),
      })
      .strict()
      .describe("原始、排除與最終回傳筆數；可稽核本次結果，但不能取代官方 declared row count"),
    profileCoverage: z
      .record(
        z.enum([
          "incorporationDate",
          "paidInCapitalTwd",
          "issuedCommonShares",
          "parValueText",
          "financialReportTypeCode",
        ]),
        z
          .object({
            reported: z.number().int().describe("此欄位 reported 的公司數"),
            missing: z.number().int().describe("此欄位官方缺值的公司數"),
            invalid: z.number().int().describe("此欄位無法解析的公司數"),
          })
          .strict(),
      )
      .describe("套用市場／金融／KY 篩選後、分頁前完整 current snapshot 的 profile 欄位覆蓋統計"),
    companies: z
      .array(masterCompanySchema)
      .describe(
        "未啟用分頁時為本次 heuristic-gated snapshot 中符合條件的公司清單；啟用 page_size/cursor 時只含本頁公司，總數與續頁見 meta.page",
      ),
    ...warningShape,
  })
  .strict();

