import { z } from "zod";

const asOfGranularitySchema = z.enum([
  "instant",
  "date",
  "month",
  "quarter",
  "mixed",
  "none",
]);

const resolvedAsOfSchema = z
  .object({
    granularity: asOfGranularitySchema.describe("resolved as-of 值的時間粒度"),
    from: z.string().nullable().describe("已解析資料涵蓋起點；不適用時為 null"),
    through: z.string().nullable().describe("已解析資料涵蓋終點；不適用時為 null"),
  })
  .strict();

export const resultMetaSchema = z
  .object({
    contractVersion: z.literal("mopsfin.result.v1").describe("共用結果契約版本"),
    asOf: z
      .object({
        selector: z.enum(["latest", "explicit", "range", "snapshot", "none"]).describe("使用者要求的時間選擇模式"),
        resolved: resolvedAsOfSchema.describe("工具實際解析並使用的資料時間"),
        timezone: z.literal("Asia/Taipei").describe("日期解析與 latest 使用的時區"),
        assembledAt: z.string().describe("本服務完成組裝結果的 ISO 8601 時間"),
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

const successResultShape = {
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

const optionalCompanyPageShape = {
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

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必須是 YYYY-MM-DD")
  .describe("西元日曆日期，格式 YYYY-MM-DD；實際交易日仍由官方行情決定");

const calendarMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "資料年月必須是 YYYY-MM")
  .describe("西元年月，格式 YYYY-MM");

const yearMonthSchema = calendarMonthSchema
  .refine((value) => value >= "2013-01", "歷史月營收從 2013-01 起支援")
  .describe("西元資料年月，格式 YYYY-MM；歷史月營收從 2013-01 起支援");

const universePolicySchema = z
  .enum(["compatible", "strict_current_master"])
  .describe(
    "compatible=保留四碼公司代號 fallback 並揭露 reconciliation；strict_current_master=只接受與目前 heuristic-gated 公司母體精確吻合的 latest 資料，但不因此證明官方完整 rowset",
  );

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

const optionalMarketCompanyCodesSchema = z
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

function validateOptionalCompanyCodes(
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

const catalystEventTypeSchema = z.enum([
  "material_information",
  "investor_conference",
]);

const catalystSourceKeySchema = z.enum([
  "twse_material_information_current",
  "tpex_material_information_current",
  "mops_material_information_history",
  "mops_investor_conference_history",
]);

const catalystCurrentSourceKeySchema = z.enum([
  "twse_material_information_current",
  "tpex_material_information_current",
]);

function strictCalendarDateEpoch(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? epoch
    : null;
}

export const companyCatalystEventsInputSchema = z
  .object({
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("要查詢官方事件的四碼台股公司代號"),
      )
      .min(1)
      .max(20)
      .describe(
        "要查詢的 1 至 20 家公司；逐公司向官方 MOPS 歷史頁查詢，單一公司失敗不得抹除其他公司的成功結果",
      ),
    start_date: calendarDateSchema.describe(
      "事件查詢起始日（含），採 Asia/Taipei 日曆日期",
    ),
    end_date: calendarDateSchema.describe(
      "事件查詢結束日（含），不得早於 start_date，且含首尾最多 366 日；可涵蓋官方已公告的未來排定事件",
    ),
    event_types: z
      .array(
        catalystEventTypeSchema.describe(
          "material_information=重大訊息；investor_conference=法人說明會",
        ),
      )
      .min(1)
      .max(2)
      .default(["material_information", "investor_conference"])
      .describe(
        "要取得的官方事件 family；本版本不提供分析師 consensus、預估修正、目標價或事件情緒分數",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "組裝並依事件時間穩定排序後的零起算事件位移；續頁必須沿用完全相同的公司、日期與 event_types",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("本頁最多回傳事件數，預設 50、上限 100"),
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
    if (new Set(value.event_types).size !== value.event_types.length) {
      context.addIssue({
        code: "custom",
        path: ["event_types"],
        message: "event_types 不得包含重複 family",
      });
    }
    const start = strictCalendarDateEpoch(value.start_date);
    const end = strictCalendarDateEpoch(value.end_date);
    if (start === null) {
      context.addIssue({
        code: "custom",
        path: ["start_date"],
        message: "start_date 必須是真實存在的日曆日期",
      });
    }
    if (end === null) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date 必須是真實存在的日曆日期",
      });
    }
    if (start === null || end === null) return;
    if (end < start) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "end_date 不得早於 start_date",
      });
    } else if ((end - start) / 86_400_000 + 1 > 366) {
      context.addIssue({
        code: "custom",
        path: ["end_date"],
        message: "事件查詢範圍含首尾最多 366 日",
      });
    }
    const startDate = new Date(start);
    const endDate = new Date(end);
    const calendarMonthCount =
      (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      endDate.getUTCMonth() -
      startDate.getUTCMonth() +
      1;
    const unitsPerCompanyMonth =
      (value.event_types.includes("material_information") ? 1 : 0) +
      (value.event_types.includes("investor_conference") ? 2 : 0);
    const minimumHistoricalWorkUnits =
      value.company_codes.length * calendarMonthCount * unitsPerCompanyMonth;
    if (minimumHistoricalWorkUnits > 40) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message:
          `歷史 catalyst 查詢至少需要 ${minimumHistoricalWorkUnits} 個工作單位，超過 40；重大訊息每 company×month 一單位，法說會因雙市場查詢為兩單位`,
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

const sourceShape = {
  sourceName: z.string().describe("資料來源名稱"),
  sourceUrl: z.string().url().describe("Mopsfin 官方來源首頁"),
  retrievedAt: z.string().describe("本服務從上游取得或整理資料的 ISO 8601 時間"),
  upstreamRoute: z.string().describe("本次實際使用的固定 Mopsfin 上游 endpoint path"),
  freshnessNote: z.string().describe("官方資料更新頻率與可能時間差"),
};

const warningShape = {
  warnings: z
    .array(z.string())
    .describe("與本次資料直接相關的口徑、適用性、缺值、分頁或申報頻率警示；回答時不可忽略"),
};

const pointSchema = z
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

const seriesSchema = z
  .object({
    label: z.string().describe("公司、產業、金融機構或平均數 series 的顯示名稱"),
    points: z.array(pointSchema).describe("依 periods 對應的時間序列資料點"),
  })
  .strict();

const trendShape = {
  unit: z.string().describe("所有 series 數值的上游標示單位；回答數字時必須一併說明"),
  periods: z.array(z.string()).describe("正規化後的期別順序，通常為 YYYYQn"),
  series: z.array(seriesSchema).describe("公司、產業、金融機構或平均數的正規化序列"),
};

const rangeOutputShape = {
  history: z.enum(["recent_12", "all"]).describe("本次使用的歷史範圍模式"),
  startPeriod: z.string().optional().describe("本次套用的起始期別（含）"),
  endPeriod: z.string().optional().describe("本次套用的結束期別（含）"),
};

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

const latestMarketQueryOutputSchema = z
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

const marketReconciliationSchema = z
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

const catalystEventSchema = z
  .object({
    eventId: z
      .string()
      .describe("由官方事件 identity 組成的穩定識別碼，可用於同次與後續查詢去重"),
    eventType: catalystEventTypeSchema.describe("官方事件 family"),
    companyCode: z.string().describe("事件所屬四碼公司股票代號"),
    companyName: z.string().describe("事件來源列所載公司名稱"),
    market: z.enum(["listed", "otc"]).describe("事件公司所屬上市或上櫃市場"),
    title: z.string().describe("官方重大訊息主旨或法說會摘要標題，不做正負面改寫"),
    description: z
      .string()
      .nullable()
      .describe("官方事件說明；來源未提供或尚未載入明細時為 null"),
    clause: z
      .string()
      .nullable()
      .describe("重大訊息符合條款原文；法說會或來源未提供時為 null"),
    publishedAt: z
      .string()
      .nullable()
      .describe("官方公告發布時間；來源只提供事件日期而沒有發布時間時為 null"),
    factDate: calendarDateSchema
      .nullable()
      .describe("重大訊息所載事實發生日；不適用或官方未提供時為 null"),
    scheduledAt: z
      .string()
      .nullable()
      .describe("官方已公告的法說會等排定時間；不是推估日期，不適用時為 null"),
    effectiveAt: z
      .string()
      .nullable()
      .describe("事件法律或交易生效時間；本來源未提供時為 null，不以公告日代填"),
    timezone: z
      .literal("Asia/Taipei")
      .describe("此事件官方日期時間的正規化時區"),
    status: z
      .enum(["announced", "revised", "cancelled", "scheduled"])
      .describe("只依官方公告文字辨識的事件狀態，不代表投資判斷"),
    statusBasis: z
      .enum(["announcement_publication", "title_prefix", "official_schedule"])
      .describe("status 的官方欄位或保守文字辨識依據"),
    dateConfidence: z
      .literal("confirmed")
      .describe("事件時間直接來自官方公告；不把法定時程或歷史慣例推成確定日期"),
    dateBasis: z
      .enum(["publication", "scheduled_event"])
      .describe("事件主日期是公告發布或官方排定事件，兩者不可混用"),
    datePrecision: z
      .enum(["day", "minute", "second"])
      .describe("官方來源能支持的事件時間精度"),
    isConsensus: z
      .literal(false)
      .describe("固定為 false；單筆官方公司事件不是分析師共識"),
    sourceKey: catalystSourceKeySchema.describe(
      "此事件實際使用的固定官方資料集或歷史查詢識別碼",
    ),
    sourceUrl: z
      .string()
      .url()
      .describe("此事件實際取自的官方 TWSE／TPEx／MOPS URL"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("官方來源出表日；歷史 HTML 沒有獨立出表日時為 null"),
    sourceRecordKey: z
      .string()
      .describe("由官方查詢列 key 組成的穩定原始紀錄識別碼"),
    eventDetails: z
      .object({
        location: z.string().nullable().describe("官方法說會地點；不適用或未提供時為 null"),
        presentationZhFileName: z.string().nullable().describe("官方中文簡報檔名；未提供時為 null"),
        presentationEnFileName: z.string().nullable().describe("官方英文簡報檔名；未提供時為 null"),
        companyIrUrl: z.string().nullable().describe("公司 IR 網址原文；未提供時為 null"),
        videoUrl: z.string().nullable().describe("官方列出的影音網址；未提供時為 null"),
        note: z.string().nullable().describe("官方法說會備註；未提供時為 null"),
      })
      .strict()
      .nullable()
      .describe("法說會專屬官方欄位；重大訊息為 null"),
  })
  .strict();

const catalystSourceSchema = z
  .object({
    eventType: catalystEventTypeSchema.describe("此來源負責的事件 family"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("current snapshot 的上市或上櫃市場；跨市場歷史 MOPS 摘要為 null"),
    exchange: z
      .enum(["TWSE", "TPEx", "MOPS"])
      .describe("發布 current snapshot 的市場機構，或跨市場歷史 MOPS"),
    sourceKey: catalystSourceKeySchema.describe(
      "官方資料集或歷史查詢 route 的固定識別碼",
    ),
    sourceName: z.string().describe("官方資料集或 MOPS 查詢頁名稱"),
    sourceUrl: z.string().url().describe("本次實際查詢的官方來源 URL"),
    retrievedAt: z
      .string()
      .nullable()
      .describe("本服務取得此官方回應的 ISO 8601 時間；沒有單一共同時間時為 null"),
    scope: z
      .enum(["current_official_snapshot", "selected_company_historical_months"])
      .describe("當期官方快照或依 selected company×calendar month 查詢的歷史結果"),
    queryStart: calendarDateSchema.describe("此來源實際查詢範圍起始日（含）"),
    queryEnd: calendarDateSchema.describe("此來源實際查詢範圍終止日（含）"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("官方來源出表日；歷史頁未另提供時為 null"),
    rawRowCount: z.number().int().nonnegative().describe("官方回應解析前的資料列數"),
    acceptedEventCount: z
      .number()
      .int()
      .nonnegative()
      .describe("完成 identity、日期與去重檢查後接受的事件數"),
    snapshotIdentity: z
      .string()
      .describe("由通過 identity 核對的非空／合法空回應組成的來源快照 fingerprint"),
  })
  .strict();

const catalystFailureSchema = z
  .object({
    failureId: z.string().describe("穩定的逐 company×family×month failure 識別碼"),
    companyCode: z.string().describe("此 failure 隔離影響的公司代號"),
    eventType: catalystEventTypeSchema.describe("此 failure 影響的事件 family"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("已解析的公司市場；identity 無法確認時為 null"),
    queryMonth: calendarMonthSchema.describe(
      "此 failure 影響的歷史日曆月份；current snapshot failure 則為擷取當下的台北年月",
    ),
    code: z.string().describe("穩定的錯誤代號"),
    reason: z.string().nullable().describe("更精確的 failure reason；未提供時為 null"),
    message: z.string().describe("此公司與事件 family 的失敗原因"),
    retryable: z.boolean().describe("是否適合稍後以相同條件重試"),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("建議至少等待的毫秒數；未提供時為 null"),
    action: z
      .enum(["fix_input", "change_query", "retry", "restart_pagination", "none"])
      .describe("呼叫端針對此隔離 failure 建議採取的下一步"),
  })
  .strict();

const catalystFamilyCoverageSchema = z
  .object({
    companyCode: z.string().describe("此覆蓋列對應的 requested 公司代號"),
    eventType: catalystEventTypeSchema.describe("此覆蓋列對應的事件 family"),
    status: z
      .enum(["complete", "partial", "failed"])
      .describe("此公司在 requested 日期對此 family 歷史月份的完成狀態"),
    queryStart: calendarDateSchema.describe("此公司 family 查詢起始日（含）"),
    queryEnd: calendarDateSchema.describe("此公司 family 查詢終止日（含）"),
    requestCount: z.number().int().nonnegative().describe("此公司 family 的歷史月份／市場查詢工作單位數"),
    completedRequestCount: z.number().int().nonnegative().describe("成功且 identity 可驗證的歷史月份／市場工作單位數"),
    verifiedEmptyRequestCount: z.number().int().nonnegative().describe("已驗證合法無歷史事件的工作單位數"),
    nonemptyRequestCount: z.number().int().nonnegative().describe("通過 identity 核對且有歷史事件的工作單位數"),
    eventCount: z.number().int().nonnegative().describe("此公司 family 的歷史 accepted event 數；current 補強另見 coverage.currentSnapshots"),
    snapshotIdentity: z.string().describe("此 company×family 歷史月份查詢範圍的快照 fingerprint"),
    failures: z.array(catalystFailureSchema).describe("此 company×family 的逐歷史月份／市場隔離 failures"),
  })
  .strict();

const catalystAggregateFamilyCoverageSchema = z
  .object({
    eventType: catalystEventTypeSchema.describe("此彙總覆蓋列對應的事件 family"),
    scope: z
      .enum(["current_and_selected_company_history", "selected_company_history"])
      .describe("此 family 是否結合 current snapshot 與 selected-company history"),
    status: z.enum(["complete", "partial", "failed"]).describe("此 family 對全部 requested 公司的完成狀態"),
    requestedStart: calendarDateSchema.describe("requested 起始日（含）"),
    requestedEnd: calendarDateSchema.describe("requested 終止日（含）"),
    failedCompanyCodes: z.array(z.string()).describe("此 family 至少一個月份失敗的公司代號"),
  })
  .strict();

const catalystCompanyResultSchema = z
  .object({
    companyCode: z.string().describe("requested 公司代號"),
    status: z.enum(["complete", "partial", "failed"]).describe("此公司所有 requested families 的完成狀態"),
    eventCount: z.number().int().nonnegative().describe("此公司在分頁前的 accepted event 數"),
    failures: z.array(catalystFailureSchema).describe("此公司被隔離的 family×month failures"),
  })
  .strict();

const catalystCurrentSnapshotCoverageSchema = z
  .object({
    sourceKey: catalystCurrentSourceKeySchema.describe(
      "current 重大訊息官方市場來源",
    ),
    eventType: z
      .literal("material_information")
      .describe("current snapshot 固定補強重大訊息 family"),
    market: z.enum(["listed", "otc"]).describe("current snapshot 市場"),
    status: z
      .enum(["complete", "not_applicable", "failed"])
      .describe(
        "complete=快照可綁定 requested range；not_applicable=成功取得但出表日／事件不在範圍；failed=來源失敗",
      ),
    affectedCompanyCodes: z
      .array(z.string())
      .describe("此共享市場快照實際用來補強的 requested 公司代號"),
    sourceReportDate: calendarDateSchema
      .nullable()
      .describe("官方 current snapshot 出表日；無可綁定出表日時為 null"),
    eventCount: z
      .number()
      .int()
      .nonnegative()
      .describe("此 current snapshot 在 requested range 接受的 selected-company 事件數"),
    snapshotIdentity: z
      .string()
      .describe("current source、適用性、affected companies 與事件的 fingerprint"),
    failures: z
      .array(catalystFailureSchema)
      .describe("此 current 市場快照按 affected company 隔離的 failures"),
  })
  .strict();

export const companyCatalystEventsOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        companyCodes: z.array(z.string()).describe("正規化後完整 requested 公司代號"),
        startDate: calendarDateSchema.describe("實際查詢起始日（含）"),
        endDate: calendarDateSchema.describe("實際查詢終止日（含）"),
        eventTypes: z.array(catalystEventTypeSchema).describe("實際查詢的官方事件 families"),
        offset: z.number().int().nonnegative().describe("正規化後的事件分頁位移"),
        limit: z.number().int().positive().describe("正規化後的事件分頁上限"),
      })
      .strict()
      .describe("本頁與續頁必須保持一致的事件查詢範圍"),
    generatedAt: z.string().describe("本服務完成事件組裝的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("官方日期與時間正規化使用的時區"),
    scope: z
      .literal("official_disclosure_events")
      .describe("只回官方公告與公司揭露事件，不含媒體傳聞或研究判斷"),
    isConsensus: z
      .literal(false)
      .describe("固定為 false；公司公告／指引不能冒充分析師 consensus"),
    events: z
      .array(catalystEventSchema)
      .describe("穩定排序後的本頁官方事件；沒有事件不代表負面訊號"),
    failures: z
      .array(catalystFailureSchema)
      .describe("逐公司、逐 family 隔離的查詢失敗；不得當成合法空事件"),
    coverage: z
      .object({
        sourceComplete: z.boolean().describe("所有 requested 官方來源是否均成功且可核對查詢 identity"),
        failureIsolation: z
          .literal("per_company_event_type_calendar_month")
          .describe("所有失敗均按 company×eventType×calendar month 隔離"),
        families: z
          .array(catalystAggregateFamilyCoverageSchema)
          .describe("逐 family 的 current／historical scope 與失敗公司彙總"),
        currentSnapshots: z
          .array(catalystCurrentSnapshotCoverageSchema)
          .describe(
            "近期重大訊息共享市場快照的成功、不適用或失敗覆蓋；不混入逐公司歷史月份計數",
          ),
      })
      .strict()
      .describe("來源完整性、failure isolation 與 family 查詢範圍"),
    familyCoverage: z
      .array(catalystFamilyCoverageSchema)
      .describe("逐 company×family 的歷史月份請求、合法空回應、事件與 failure 覆蓋"),
    companies: z
      .array(catalystCompanyResultSchema)
      .describe(
        "逐 requested 代號彙總來源狀態；complete 且 eventCount=0 只證明該代號範圍查無事件，公司 identity 是否已驗證仍須檢查 meta.quality.selection 與 issues",
      ),
    counts: z
      .object({
        requestedCompanies: z.number().int().nonnegative().describe("requested 公司數"),
        requestedEventTypes: z.number().int().nonnegative().describe("requested event family 數"),
        totalEvents: z.number().int().nonnegative().describe("分頁前 accepted event 總數"),
        returnedEvents: z.number().int().nonnegative().describe("本頁回傳事件數"),
        completeCompanies: z.number().int().nonnegative().describe("所有 requested families 完成的公司數"),
        partialCompanies: z.number().int().nonnegative().describe("部分 requested family 或月份失敗的公司數"),
        failedCompanies: z.number().int().nonnegative().describe("所有 requested families 均失敗的公司數"),
      })
      .strict()
      .describe("requested、事件與逐公司完成狀態計數"),
    workBudget: z
      .object({
        companyCount: z.number().int().nonnegative().describe("requested 公司數"),
        distinctCalendarMonths: z.number().int().nonnegative().describe("requested range 涵蓋的日曆月份數"),
        eventTypeCount: z.number().int().nonnegative().describe("requested event family 數"),
        historicalLogicalUnits: z.number().int().nonnegative().describe("company×family×calendar month 邏輯工作單位"),
        historicalUpstreamRequests: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "執行前按 company×family×month／market 計算的歷史查詢工作單位；retry attempt 不重複計數",
          ),
        currentSnapshotRequests: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "執行前按市場計算的 current snapshot 查詢工作單位；retry attempt 不重複計數",
          ),
        plannedUpstreamRequests: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "上述歷史與 current 查詢工作單位總和；不是包含 retry 或 master hint 的 HTTP attempt 計數",
          ),
        upstreamRequestLimit: z
          .literal(40)
          .describe("單次 tool call 固定 catalyst 查詢工作單位上限"),
      })
      .strict()
      .describe("避免公司、月份與 family 乘積造成無界工作量的透明 budget"),
    pagination: z
      .object({
        offset: z.number().int().nonnegative().describe("本頁事件的零起算位移"),
        limit: z.number().int().positive().describe("本頁事件數上限"),
        returnedRows: z.number().int().nonnegative().describe("本頁實際事件數"),
        totalRows: z.number().int().nonnegative().describe("本次重新組裝後的完整事件數"),
        hasMore: z.boolean().describe("本次重新組裝結果是否還有下一頁"),
        nextOffset: z.number().int().nonnegative().nullable().describe("下一頁 offset；無下一頁時為 null"),
      })
      .strict()
      .describe(
        "事件 offset 分頁；每頁會重新查詢官方來源，並非 point-in-time 快照，續頁前應檢查 meta.asOf.snapshotId 是否改變",
      ),
    sources: z.array(catalystSourceSchema).describe("本次成功且通過 identity 核對的官方事件來源"),
    fingerprint: z
      .string()
      .describe("完整分頁前事件、來源與 failure coverage 的 deterministic fingerprint；續頁不同表示來源已變動"),
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

export const screenTaiwanStockCandidatesInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe(
        "目前公司母體與粗篩來源的市場：all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx",
      ),
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("可選的四碼目前上市櫃公司股票代號"),
      )
      .min(1)
      .max(100)
      .optional()
      .describe(
        "可選且不得重複的 1 至 100 家自訂母體；省略時掃描所選市場目前 heuristic-gated 公司母體",
      ),
    include_ky: z
      .boolean()
      .default(true)
      .describe("是否保留 KY 公司；金融保險業不受此欄位影響，v2 固定排除"),
    candidate_limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(5)
      .describe(
        "最多進入 reaction 階段並回傳完整四柱結果的公司數，預設及上限 5；粗篩後深篩仍固定最多 10 家",
      ),
    preset: z
      .literal("balanced_non_financial_v2")
      .default("balanced_non_financial_v2")
      .describe(
        "固定透明規則版本；v2 第四柱只接受 official actual-result 證據完整的 price-index-compatible reaction，不能用總分抵銷任何四柱 hard gate",
      ),
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
  });

const screenCriterionStatusSchema = z.enum(["pass", "fail", "unknown"]);
const screenPillarKeySchema = z.enum([
  "company_quality",
  "fundamental_improvement",
  "reasonable_valuation",
  "market_underreaction_proxy",
]);
const screenCandidateBucketSchema = z.enum([
  "research_candidate",
  "watchlist",
  "insufficient_data",
  "deprioritized",
]);

const screenCriterionSchema = z
  .object({
    code: z.string().describe("穩定且可供程式判斷的 criterion code"),
    label: z.string().describe("criterion 的繁體中文名稱"),
    status: screenCriterionStatusSchema.describe(
      "pass=規則通過、fail=規則有反證、unknown=證據缺失或不可比；unknown 不得當成 0",
    ),
    value: z
      .number()
      .nullable()
      .describe("用於判定的正規化數值；無可比或有效證據時為 null"),
    unit: z.string().describe("value 的單位或 ratio／percentage-point 等口徑"),
    periods: z
      .array(z.string())
      .describe("此 criterion 實際使用的月份、季度或交易日範圍"),
    rule: z.string().describe("可重算的門檻或判定公式"),
    weight: z.number().describe("此 criterion 在所屬 pillar 內的權重"),
    mandatory: z.boolean().describe("缺少此 criterion 是否會使 pillar 變成 unknown"),
    context: z
      .record(
        z.string(),
        z.union([z.number(), z.string(), z.boolean(), z.null()]),
      )
      .describe("判定所需的 peer、前期值、樣本數或其他有限結構化上下文"),
    reasonCodes: z
      .array(z.string())
      .describe("fail、unknown 或其他限制的穩定原因代號"),
  })
  .strict();

const screenPillarSchema = z
  .object({
    key: screenPillarKeySchema.describe("四柱的穩定機器鍵"),
    label: z.string().describe("四柱的人類可讀名稱"),
    status: screenCriterionStatusSchema.describe(
      "此柱的 hard-gate 結論；unknown 與 fail 都不能由其他柱總分補償",
    ),
    score: z
      .number()
      .nullable()
      .describe("只依已知 criteria 計算的 0–100 輔助排序分數；無已知權重時為 null"),
    knownWeight: z.number().describe("本柱具有可判讀證據的 criterion 權重合計"),
    totalWeight: z.literal(100).describe("本柱規則的固定總權重"),
    criteria: z.array(screenCriterionSchema).describe("此柱的透明逐條判定與證據"),
    hardFailReasons: z
      .array(z.string())
      .describe("使本柱直接 fail 的硬性反證原因代號"),
    evidenceGaps: z
      .array(z.string())
      .describe("使本柱不完整或 unknown 的證據缺口"),
  })
  .strict();

const screenCompactCompanySchema = z
  .object({
    companyCode: z.string().describe("公司股票代號"),
    companyName: z.string().describe("公司簡稱"),
    stage: z
      .enum([
        "universe_filter",
        "coarse_filter",
        "deep_scoring",
        "reaction_selection",
      ])
      .describe("此公司被排除或未繼續處理的漏斗階段"),
    reasonCodes: z
      .array(z.string())
      .describe(
        "被排除、未深篩或未 reaction 評估的穩定原因代號；company_metrics_unavailable 表示 deep batch item failure，不能當成投資條件 fail",
      ),
  })
  .strict();

const screenSourceSchema = z
  .object({
    kind: z
      .enum([
        "company_master",
        "monthly_revenue_latest",
        "monthly_revenue_history",
        "valuation_latest",
        "company_metrics",
        "reaction_benchmark",
        "reaction_stock",
        "reaction_corporate_action",
      ])
      .describe("來源在篩選 pipeline 中提供的資料角色"),
    sourceName: z.string().describe("官方資料來源名稱"),
    sourceUrl: z.string().url().describe("實際官方來源 URL"),
    retrievedAt: z.string().describe("本服務取得或使用來源的 ISO 8601 時間"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("來源所屬市場；跨市場 Mopsfin 指標來源為 null"),
    asOf: z.string().describe("此來源實際使用的日期、月份、季度或 mixed 標記"),
    asOfGranularity: z
      .enum(["date", "month", "quarter", "mixed"])
      .describe("asOf 的時間粒度"),
  })
  .strict();

const screenDependencyStatusSchema = z
  .object({
    stage: z.enum(["coarse", "deep", "reaction"]).describe("依賴所屬 pipeline 階段"),
    dependency: z
      .enum([
        "company_master",
        "latest_monthly_revenue",
        "latest_valuation",
        "monthly_revenue_trend",
        "company_metrics_batch",
        "stock_reaction_signals",
      ])
      .describe("實際呼叫或規劃的底層即時資料依賴"),
    status: z
      .enum(["complete", "partial", "failed", "not_run"])
      .describe("本次依賴的完成狀態；failed／not_run 不會被補成 0 分"),
    affectedCompanyCodes: z
      .array(z.string())
      .describe("受此依賴不完整或失敗影響的公司代號"),
    message: z
      .string()
      .nullable()
      .describe("依賴完整時為 null，否則說明可重試、覆蓋或資料限制"),
  })
  .strict();

export const screenTaiwanStockCandidatesOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        market: z.enum(["all", "listed", "otc"]).describe("實際掃描的目前市場母體"),
        companyCodes: z
          .array(z.string())
          .optional()
          .describe("正規化並排序後的自訂公司代號母體；省略代表掃描所選市場"),
        includeKy: z.boolean().describe("本次是否保留 KY 公司"),
        candidateLimit: z.number().int().describe("最多進入 reaction 並回傳的公司數"),
        preset: z
          .literal("balanced_non_financial_v2")
          .describe("本次使用的固定透明規則版本"),
      })
      .strict()
      .describe("正規化後實際執行的 latest-only 篩選條件"),
    generatedAt: z.string().describe("本服務完成組裝篩選結果的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("latest 與交易日期使用的時區"),
    screenDefinition: z
      .object({
        id: z.literal("taiwan_stock_screen.v2").describe("使用 corporate-action-aware reaction 的穩定篩選定義版本"),
        preset: z
          .literal("balanced_non_financial_v2")
          .describe("四柱規則 preset"),
        posture: z
          .literal("research_triage_not_recommendation")
          .describe("結果只供研究候選分流，不是投資建議"),
        latestOnly: z.literal(true).describe("此版本只允許各來源 latest 資料"),
        financialCompanies: z.literal("excluded").describe("金融保險業固定排除"),
        scoreCompensationAcrossPillars: z
          .literal(false)
          .describe("總分不得抵銷任何 pillar 的 fail 或 unknown"),
        pillarWeights: z
          .object({
            company_quality: z.literal(25).describe("好公司柱的總分權重"),
            fundamental_improvement: z.literal(25).describe("基本面改善柱的總分權重"),
            reasonable_valuation: z.literal(25).describe("估值合理柱的總分權重"),
            market_underreaction_proxy: z
              .literal(25)
              .describe("市場尚未充分反應 proxy 柱的總分權重"),
          })
          .strict()
          .describe("四柱各 25% 的排序權重；不改變 hard gates"),
        stages: z
          .array(
            z
              .object({
                stage: z.enum(["coarse", "deep", "reaction"]).describe("pipeline 階段"),
                maximumCompanies: z
                  .number()
                  .int()
                  .nullable()
                  .describe("該階段最多公司數；全母體 coarse 為 null"),
                description: z.string().describe("階段資料來源、範圍與限制"),
              })
              .strict(),
          )
          .describe("全母體粗篩、前 10 家深篩及最多 5 家 reaction 的固定流程"),
        coarseRanking: z
          .object({
            eligibilityRules: z
              .array(z.string())
              .describe("進入粗篩排序前必須具備的 latest 月營收與估值證據"),
            scoreComponents: z
              .array(
                z
                  .object({
                    code: z.string().describe("粗篩加分條件的穩定代號"),
                    points: z.number().describe("條件成立時加入 coarseScore 的固定分數"),
                    rule: z.string().describe("可重算的粗篩條件"),
                  })
                  .strict(),
              )
              .describe("合計最高 100 分的固定粗篩加分規則"),
            tieBreak: z
              .array(z.string())
              .describe("粗篩同分時依序套用的 deterministic 排序鍵"),
          })
          .strict()
          .describe("決定哪些公司進入 top-10 深篩的完整透明粗篩規則"),
        evidencePolicies: z
          .object({
            financialMetricCodes: z
              .array(z.string())
              .describe("深篩固定要求的七項 Mopsfin metric codes"),
            financialAlignment: z
              .literal("exact_common_quarter_no_substitution")
              .describe("七項財務指標必須對齊同一季度，缺值不以鄰季代填"),
            valuationPeerMinimum: z
              .literal(20)
              .describe("每一估值欄位形成 percentile 所需的最少有效 peer 數"),
            valuationPeerFallback: z
              .literal("same_industry_then_same_market")
              .describe("同產業有效樣本不足 20 時退回同市場非金融母體"),
            reactionHorizons: z
              .array(z.union([z.literal(5), z.literal(20), z.literal(60)]))
              .describe("第四柱固定使用的 benchmark session horizons"),
            reactionPriceBasis: z
              .literal("price_index_compatible_corporate_action_adjusted_vs_price_index")
              .describe("第四柱只使用 official actual-result factor 移除股數變動機械斷點後的個股報酬與 price index；現金股利效果保留，非 total return"),
          })
          .strict()
          .describe("深度財務、估值同業與 reaction 的固定證據政策"),
        decisionPolicy: z
          .object({
            researchCandidate: z.string().describe("research_candidate 的四柱通過政策"),
            watchlist: z.string().describe("watchlist 的 gate 與反證政策"),
            insufficientData: z.string().describe("insufficient_data 的缺證政策"),
            deprioritized: z.string().describe("deprioritized 的硬性反證政策"),
          })
          .strict()
          .describe("四個研究分流 bucket 的 precedence 與 hard-gate 語意"),
        limitations: z
          .array(z.string())
          .describe("來源、時間點、金融業、raw price 與缺少市場預期資料等限制"),
      })
      .strict()
      .describe("可供重算與解釋的固定篩選方法"),
    asOf: z
      .object({
        selector: z.literal("latest").describe("所有 dependency 均要求 latest"),
        granularity: z.literal("mixed").describe("來源同時包含日期、月份與季度"),
        masterReportDates: z.array(z.string()).describe("目前公司母體各市場官方出表日期"),
        revenueMonth: z.string().describe("粗篩最新月營收資料年月"),
        valuationDate: z.string().describe("粗篩與估值柱使用的官方估值日"),
        financialThroughPeriods: z
          .array(z.string())
          .describe("深篩公司七項財務指標可共同對齊的最新季度集合"),
        reactionDates: z
          .array(
            z
              .object({
                market: z.enum(["listed", "otc"]).describe("reaction benchmark 市場"),
                date: z.string().describe("該市場 reaction exact-session 終點日期"),
              })
              .strict(),
          )
          .describe("各市場實際解析的 reaction 日期"),
      })
      .strict()
      .describe("不同來源的 mixed as-of，不代表單一 point-in-time snapshot"),
    coverage: z
      .object({
        selectionComplete: z.boolean().describe("requested 公司母體是否全部完成 identity 選取"),
        sourceComplete: z.boolean().describe("所有實際執行 dependency 是否均為 complete"),
        deepEvidenceComplete: z.boolean().describe("全部深篩公司前三柱是否都可判讀"),
        reactionEvidenceComplete: z.boolean().describe("reaction 入選公司是否全部形成可判讀第四柱"),
        missingCompanyCodes: z.array(z.string()).describe("requested 但未取得的公司代號"),
      })
      .strict()
      .describe("selection、來源、深篩與 reaction 證據完整性"),
    funnel: z
      .object({
        currentMaster: z.number().int().describe("所選市場目前公司母體公司數"),
        explicitlyRequested: z
          .number()
          .int()
          .nullable()
          .describe("自訂 company_codes 數量；全市場掃描為 null"),
        eligibleNonFinancial: z.number().int().describe("排除金融與查詢指定 KY 政策後的公司數"),
        excludedFinancial: z.number().int().describe("固定排除的金融保險業公司數"),
        excludedKy: z.number().int().describe("依 include_ky=false 排除的 KY 公司數"),
        missingRequestedCodes: z.array(z.string()).describe("requested 但不在目前母體的公司代號"),
        withLatestRevenue: z.number().int().describe("有 latest 月營收列的 eligible 公司數"),
        withLatestValuation: z.number().int().describe("有 latest 估值列的 eligible 公司數"),
        coarseEligible: z.number().int().describe("通過粗篩必要資料 gate 的公司數"),
        deepSelected: z.number().int().describe("依粗篩排序進入深篩的公司數，上限 10"),
        deepScored: z.number().int().describe("已取得營收趨勢且七項財務可對齊共同季度的公司數"),
        reactionSelected: z.number().int().describe("依前三柱與 candidate_limit 進入 reaction 的公司數"),
        reactionScored: z.number().int().describe("實際形成完整四柱 candidate 列的公司數"),
        returned: z.number().int().describe("本次 candidates 回傳公司數"),
        buckets: z
          .object({
            research_candidate: z.number().int().describe("四柱全部 pass 的研究候選數"),
            watchlist: z.number().int().describe("品質與改善通過但估值或反應尚待 trigger 的數量"),
            insufficient_data: z.number().int().describe("至少一柱證據不足的數量"),
            deprioritized: z.number().int().describe("存在硬性反證或完整證據不符規則的數量"),
          })
          .strict()
          .describe("實際回傳 candidates 的研究分流數量"),
      })
      .strict()
      .describe("從目前母體到粗篩、深篩、reaction 與結果 bucket 的完整漏斗計數"),
    workBudget: z
      .object({
        coarseCompanies: z.number().int().describe("本次粗篩處理的 eligible 公司數"),
        deepCompanyLimit: z.literal(10).describe("固定深篩公司數上限"),
        deepCompaniesRequested: z.number().int().describe("本次要求深篩的公司數"),
        financialMetricCount: z.literal(7).describe("每家深篩要求的固定季度財務指標數"),
        financialMetricComparisonUnits: z.number().int().describe("每十家公司乘每個指標計算的 Mopsfin comparison units"),
        revenueTrendMonths: z.literal(6).describe("深篩月營收趨勢固定月份數"),
        reactionCompanyLimit: z.literal(5).describe("固定 reaction 公司數上限"),
        reactionCompaniesRequested: z.number().int().describe("本次要求 reaction 的公司數"),
        reactionOfficialMonthUnits: z.number().int().describe("本次 reaction 實際消耗的官方市場月份 units"),
        reactionOfficialMonthUnitLimit: z.literal(48).describe("reaction dependency 的官方月份 unit 上限"),
        reactionCorporateActionRequests: z.number().int().nonnegative().describe("本次 reaction 另行載入的 official actual-result 公司行動區間／詳情 requests"),
      })
      .strict()
      .describe("52 秒 request deadline 下的 bounded coarse／deep／reaction 工作量"),
    candidates: z
      .array(
        z
          .object({
            rank: z.number().int().describe("本次已完成四柱候選中的一日起算排序"),
            companyCode: z.string().describe("公司股票代號"),
            companyName: z.string().describe("公司正式名稱"),
            shortName: z.string().describe("公司簡稱"),
            market: z.enum(["listed", "otc"]).describe("目前上市或上櫃市場"),
            industryCode: z.string().describe("目前 company master 產業代號"),
            listingDate: z.string().describe("目前 company master 上市櫃日期"),
            isKy: z.boolean().describe("目前公司是否為 KY 公司"),
            bucket: screenCandidateBucketSchema.describe("四柱 hard-gate 後的研究分流"),
            overallScore: z
              .number()
              .nullable()
              .describe("四柱皆有 score 時的等權重排序分數；不能抵銷 fail／unknown"),
            evidenceCompletenessPercent: z.number().describe("四柱已知 criterion 權重占全部權重的百分比"),
            broadEvidence: z
              .object({
                revenueMonth: z.string().describe("粗篩月營收月份"),
                latestRevenueYoyPercent: z.number().nullable().describe("最新官方月營收 YoY 百分比"),
                cumulativeRevenueYoyPercent: z.number().nullable().describe("最新官方累計營收 YoY 百分比"),
                valuationDate: z.string().describe("粗篩估值資料日"),
                peRatio: z.number().nullable().describe("官方 trailing 本益比"),
                priceToBookRatio: z.number().nullable().describe("官方股價淨值比"),
                dividendYieldPercent: z.number().nullable().describe("官方殖利率百分比"),
                closePriceTwd: z.number().nullable().describe("估值來源可提供的收盤價 TWD"),
                coarseScore: z.number().describe("最新營收成長與估值形成的 deterministic 粗篩分數"),
              })
              .strict()
              .describe("用於全母體低成本排序的最新營收與估值證據"),
            pillars: z
              .object({
                companyQuality: screenPillarSchema.describe("好公司柱"),
                fundamentalImprovement: screenPillarSchema.describe("基本面改善柱"),
                reasonableValuation: screenPillarSchema.describe("估值合理柱"),
                marketUnderreactionProxy: screenPillarSchema.describe("市場尚未充分反應的 corporate-action-aware、price-index-compatible proxy 柱；actual-result 證據不足時為 unknown"),
              })
              .strict()
              .describe("好公司、基本面改善、估值合理與市場反應 proxy 四柱"),
            firstRejectionReasons: z.array(z.string()).describe("最先阻止 research_candidate 的 hard gate 或證據原因"),
            evidenceGaps: z.array(z.string()).describe("需透過後續研究補齊的資料缺口"),
            nextDiligence: z.array(z.string()).describe("針對本公司建議的下一步人工研究，不是買賣行動"),
            asOf: z
              .object({
                masterReportDate: z.string().describe("此公司目前 master 的官方出表日期"),
                revenueThroughMonth: z.string().describe("此公司月營收證據終點月份"),
                valuationDate: z.string().describe("此公司估值證據日期"),
                financialThroughPeriod: z.string().nullable().describe("七項財務指標共同對齊季度"),
                reactionDate: z.string().nullable().describe("reaction exact-session 終點；未完成時為 null"),
              })
              .strict()
              .describe("此候選各類證據的 mixed as-of"),
          })
          .strict(),
      )
      .describe("最多 candidate_limit 家已完成 reaction 並組成四柱的研究候選列"),
    summaryLimits: z
      .object({
        maximumPerList: z.literal(25).describe("三個摘要清單各自的固定回傳筆數上限"),
        notDeepScoredTotal: z.number().int().describe("粗篩合格但受 top-10 限制未深篩的完整數量"),
        notReactionScoredTotal: z.number().int().describe("已深篩但未形成 reaction 第四柱的完整數量"),
        excludedTotal: z.number().int().describe("母體與粗篩排除公司的完整數量"),
      })
      .strict()
      .describe("bounded 摘要清單的上限與未截斷總數"),
    notDeepScored: z.array(screenCompactCompanySchema).describe("粗篩合格但未進入 top-10 深篩的公司摘要"),
    notReactionScored: z
      .array(screenCompactCompanySchema)
      .describe("已進 deepSelected 但因 evidence unavailable、前三柱 unknown、reaction dependency 或 bounded limit 而未形成第四柱的公司摘要"),
    excluded: z.array(screenCompactCompanySchema).describe("因金融、KY policy 或粗篩必要資料而排除的公司摘要"),
    dependencyStatus: z.array(screenDependencyStatusSchema).describe("各 pipeline 即時 dependency 的完成與影響範圍"),
    sources: z.array(screenSourceSchema).describe("本次實際使用且去重後的官方來源與各自 as-of"),
    ...warningShape,
  })
  .strict();
