import { z } from "zod";

import { RESULT_CONTRACT_VERSION } from "@/lib/server/identity";

export const asOfGranularitySchema = z.enum([
  "instant",
  "date",
  "month",
  "quarter",
  "mixed",
  "none",
]);

export const resolvedAsOfSchema = z
  .object({
    granularity: asOfGranularitySchema.describe("resolved as-of 值的時間粒度"),
    from: z.string().nullable().describe("已解析資料涵蓋起點；不適用時為 null"),
    through: z.string().nullable().describe("已解析資料涵蓋終點；不適用時為 null"),
  })
  .strict();

export const sourceCacheObservationSchema = z
  .object({
    status: z
      .enum(["hit", "miss", "shared", "bypass", "not_applicable", "unknown"])
      .describe("此 caller 觀察到的 in-process cache 狀態"),
    observedAt: z
      .string()
      .nullable()
      .describe("此 caller 觀察 cache 狀態的 ISO 8601 時間；loader 未提供時為 null"),
    storedAt: z
      .string()
      .nullable()
      .describe("目前 cached upstream value 首次儲存時間；未儲存時為 null"),
    ageMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("caller 觀察時的 cache age；不適用或未知時為 null"),
    ttlMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("該來源 cache TTL；不適用或未知時為 null"),
  })
  .strict();

export const freshnessEvaluationSchema = z
  .object({
    status: z.enum([
      "within_expected_window",
      "stale",
      "unknown",
      "not_applicable",
    ]).describe("此 policy/source 的 freshness 判斷"),
    policyId: z.string().min(1).describe("中央 freshness policy 的穩定識別碼"),
    observedAsOf: z.string().nullable().describe("來源實際觀察到的資料日期或期別"),
    expectedAsOf: z.string().nullable().describe("policy 可驗證的預期資料日期或期別；無可靠 resolver 時為 null"),
    lag: z
      .object({
        value: z.number().nonnegative().describe("落後量；0 表示符合 expected as-of"),
        unit: z
          .enum(["calendar_day", "calendar_month", "trading_session", "quarter"])
          .describe("落後量使用的時間單位"),
      })
      .strict()
      .nullable()
      .describe("可由 policy 安全計算的落後量；不可推測時為 null"),
    reasonCode: z.string().min(1).describe("freshness 判斷的穩定原因代碼"),
    reason: z.string().min(1).describe("freshness 判斷說明"),
    sourceUrls: z.array(z.string().url()).describe("此 freshness 判斷涵蓋的官方來源"),
  })
  .strict();

export const resultMetaSchema = z
  .object({
    contractVersion: z.literal(RESULT_CONTRACT_VERSION).describe("共用結果契約版本"),
    asOf: z
      .object({
        selector: z.enum(["latest", "explicit", "range", "snapshot", "none"]).describe("使用者要求的時間選擇模式"),
        resolved: resolvedAsOfSchema.describe("工具實際解析並使用的資料時間"),
        timezone: z.literal("Asia/Taipei").describe("日期解析與 latest 使用的時區"),
        servedAt: z.string().describe("本服務將 MCP 結果組裝並回傳給 caller 的 ISO 8601 時間"),
        assembledAt: z.string().describe("servedAt 的 v1 相容別名"),
        snapshotId: z
          .string()
          .nullable()
          .describe("本次結果或游標可驗證資料範圍的快照識別碼；無狀態工具的具體綁定範圍見 tool description"),
        sourceCutoffs: z.array(
          z
            .object({
              sourceUrl: z.string().url().describe("此 cutoff 對應的官方來源 URL"),
              resolved: resolvedAsOfSchema.describe("此來源實際涵蓋的日期、月份、季度或時間"),
              publishedAt: z.string().nullable().describe("來源出表／發布時間；官方未提供時為 null"),
              retrievedAt: z.string().describe("本服務取得此來源的 ISO 8601 時間"),
              cache: sourceCacheObservationSchema.describe("不改寫 retrievedAt 的 caller-specific cache provenance"),
            })
            .strict(),
        ).describe("逐官方來源的時間界線與擷取時間"),
      })
      .strict()
      .describe("統一 as-of 與資料來源 cutoff"),
    quality: z
      .object({
        status: z
          .enum(["complete", "partial"])
          .describe(
            "本次可用結果的整體品質摘要；必要來源為 partial、selection/value 為 partial/unknown，或 universe 為 compatible/unverified 時固定為 partial",
          ),
        source: z.enum(["complete", "partial"]).describe("所有必要官方來源是否完整"),
        universe: z.enum(["verified", "compatible", "unverified", "not_applicable"]).describe("公司母體是否經 current master 核對"),
        selection: z.enum(["complete", "partial", "unknown", "not_applicable"]).describe("requested selection 是否全部取得"),
        values: z.enum(["complete", "partial", "unknown", "not_applicable"]).describe("回傳值是否完整解析；合法官方缺值仍可為 complete"),
        freshness: z.enum([
          "within_expected_window",
          "stale",
          "unknown",
          "not_applicable",
        ]).describe("相對官方預期更新窗口的新鮮度"),
        freshnessDetails: z
          .array(freshnessEvaluationSchema)
          .min(1)
          .describe("逐 policy/source 的 observed、expected、lag 與保守判斷證據"),
        issues: z.array(
          z
            .object({
              code: z.string().describe("穩定、可供程式判斷的 quality issue code"),
              severity: z.enum(["info", "warning"]).describe("資訊提示或需注意的警告"),
              scope: z.enum(["source", "universe", "selection", "value", "period", "page"]).describe("issue 影響的品質維度"),
              message: z.string().describe("供人類與 LLM 閱讀的 issue 說明"),
              refs: z
                .object({
                  companyCodes: z.array(z.string()).describe("受影響的公司代號"),
                  fields: z.array(z.string()).describe("受影響的欄位名稱"),
                  periods: z.array(z.string()).describe("受影響的日期、月份或季度"),
                  sourceUrls: z.array(z.string().url()).describe("受影響的官方來源 URL"),
                })
                .strict()
                .describe("issue 的精確影響範圍"),
            })
            .strict(),
        ).describe("本次結果的結構化品質問題"),
      })
      .strict()
      .describe("分離來源、母體、selection、值與新鮮度的品質狀態"),
    page: z
      .object({
        mode: z.enum(["none", "offset", "cursor"]).describe("本工具本頁使用的分頁模式"),
        unit: z.enum(["none", "row", "company", "month"]).describe("limit、returned 與 total 的計數單位"),
        limit: z.number().int().nullable().describe("本頁分頁單位上限；未分頁時為 null"),
        returned: z.number().int().nullable().describe("本頁實際完成的分頁單位數；不適用時為 null"),
        total: z.number().int().nullable().describe("已知的完整分頁單位總數；未知或不適用時為 null"),
        next: z
          .union([
            z.object({ kind: z.literal("offset").describe("offset 續頁"), offset: z.number().int().describe("下一頁零起算 offset") }).strict(),
            z.object({ kind: z.literal("cursor").describe("不透明 cursor 續頁"), cursor: z.string().describe("下一頁原樣帶回的 scope-bound cursor") }).strict(),
          ])
          .nullable()
          .describe("下一頁位置；null 表示無下一頁"),
      })
      .strict()
      .describe("所有工具統一的分頁狀態；頁面未完成不等於資料品質 partial"),
  })
  .strict()
  .describe("所有成功工具共用的 as-of、品質與分頁 metadata");

export const successResultShape = {
  ok: z.literal(true).describe("true 表示工具成功並可依 outputSchema 解讀其餘欄位"),
  meta: resultMetaSchema.describe("全部成功工具共用的時間、品質與分頁 metadata"),
};

export const periodSchema = z
  .string()
  .regex(/^\d{4}Q[1-4]$/, "期別必須是 YYYYQ1 至 YYYYQ4")
  .describe("西元年財報期別，格式 YYYYQ1 至 YYYYQ4，例如 2025Q4");

export const requestedPeriodSchema = z.union([
  z.literal("latest"),
  periodSchema,
]).describe("latest 會往前尋找公司實際已申報的最近期別；也可指定 YYYYQn");

export const companyCodesSchema = z
  .array(
    z
      .string()
      .regex(/^[0-9A-Za-z]{1,10}$/)
      .describe("由 find_companies 確認的公司代號，例如 2330"),
  )
  .min(1)
  .max(10)
  .describe("要查詢或比較的公司代號，1 至 10 家；不確定代號時先用 find_companies");

export const rangeShape = {
  history: z
    .enum(["recent_12", "all"])
    .default("recent_12")
    .describe("recent_12 只回最近 12 個可用期別；all 要求上游可取得的完整 IFRSs 歷史"),
  start_period: periodSchema
    .optional()
    .describe("可選起始期別（含）；與 end_period 共同縮小時間範圍"),
  end_period: periodSchema
    .optional()
    .describe("可選結束期別（含）；不得早於 start_period"),
};

export const pageShape = {
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("跨所有表格資料列的零起算分頁位移；用回傳的 pagination.nextOffset 讀下一頁"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("本次最多回傳的資料列數，預設 100、上限 500"),
};

export const optionalCompanyPageShape = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("可選公司分頁大小；省略 page_size 與 cursor 時維持完整回傳"),
  cursor: z
    .string()
    .max(1000)
    .optional()
    .describe("上一頁回傳的 query/snapshot-bound 公司游標；續頁可省略 page_size"),
};

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必須是 YYYY-MM-DD")
  .describe("西元日曆日期，格式 YYYY-MM-DD；實際交易日仍由官方行情決定");

export const calendarMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "資料年月必須是 YYYY-MM")
  .describe("西元年月，格式 YYYY-MM");

export const yearMonthSchema = calendarMonthSchema
  .refine((value) => value >= "2013-01", "歷史月營收從 2013-01 起支援")
  .describe("西元資料年月，格式 YYYY-MM；歷史月營收從 2013-01 起支援");

export const universePolicySchema = z
  .enum(["compatible", "strict_current_master"])
  .describe(
    "compatible=保留四碼公司代號 fallback 並揭露 reconciliation；strict_current_master=只接受與目前 heuristic-gated 公司母體精確吻合的 latest 資料，但不因此證明官方完整 rowset",
  );

export const optionalMarketCompanyCodesSchema = z
  .array(
    z
      .string()
      .regex(/^\d{4}$/)
      .describe("要從指定官方市場資料篩選的四碼公司股票代號"),
  )
  .min(1)
  .max(500)
  .optional()
  .describe(
    "可選且不得重複的公司代號清單，1 至 500 家；省略時回傳本次 accepted source snapshot 的全部 eligible rows，不能據此忽略 coverage、reconciliation 或來源完整性限制",
  );

export function validateOptionalCompanyCodes(
  value: { company_codes?: string[] },
  context: z.RefinementCtx,
): void {
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
}

export const sourceShape = {
  sourceName: z.string().describe("資料來源名稱"),
  sourceUrl: z.string().url().describe("Mopsfin 官方來源首頁"),
  retrievedAt: z.string().describe("本服務從上游取得或整理資料的 ISO 8601 時間"),
  cache: sourceCacheObservationSchema
    .optional()
    .describe("此 caller 對 Mopsfin upstream response 的 cache provenance；舊來源可省略"),
  upstreamRoute: z.string().describe("本次實際使用的固定 Mopsfin 上游 endpoint path"),
  freshnessNote: z.string().describe("官方資料更新頻率與可能時間差"),
};

export const warningShape = {
  warnings: z
    .array(z.string())
    .describe("與本次資料直接相關的口徑、適用性、缺值、分頁或申報頻率警示；回答時不可忽略"),
};

export const pointSchema = z
  .object({
    period: z.string().describe("此資料點代表的財報期別或上游類別標籤"),
    value: z
      .number()
      .nullable()
      .describe("正規化後的數值；null 表示缺值、不適用或未申報，不可當成 0"),
    valueStatus: z
      .enum(["reported", "missing", "invalid_upstream"])
      .describe(
        "reported=有效官方數值；missing=官方空白、不適用或未申報；invalid_upstream=非空但無法解析的上游值",
      ),
    status: z.string().optional().describe("上游提供的資料狀態或原始缺值標記"),
  })
  .strict();

export const seriesSchema = z
  .object({
    label: z.string().describe("公司、產業、金融機構或平均數 series 的顯示名稱"),
    points: z.array(pointSchema).describe("依 periods 對應的時間序列資料點"),
  })
  .strict();

export const trendShape = {
  unit: z.string().describe("所有 series 數值的上游標示單位；回答數字時必須一併說明"),
  periods: z.array(z.string()).describe("正規化後的期別順序，通常為 YYYYQn"),
  series: z.array(seriesSchema).describe("公司、產業、金融機構或平均數的正規化序列"),
};

export const rangeOutputShape = {
  history: z.enum(["recent_12", "all"]).describe("本次使用的歷史範圍模式"),
  startPeriod: z.string().optional().describe("本次套用的起始期別（含）"),
  endPeriod: z.string().optional().describe("本次套用的結束期別（含）"),
};
