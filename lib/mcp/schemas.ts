import { z } from "zod";

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
  })
  .strict();

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必須是 YYYY-MM-DD")
  .describe("西元日曆日期，格式 YYYY-MM-DD；實際交易日仍由官方行情決定");

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
        "可選公司代號清單，最多 500 家；省略時回傳指定日期與市場的完整公司股票 OHLC",
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
    if (value.basis === "cumulative_yoy" && value.yoy_quarter === undefined) {
      context.addIssue({
        code: "custom",
        path: ["yoy_quarter"],
        message: "cumulative_yoy 必須提供 yoy_quarter",
      });
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
  })
  .strict();

export const listCompaniesOutputSchema = z
  .object({
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
      .describe("由市場別與各來源出表日期組成的可重現快照識別碼"),
    coverageComplete: z
      .literal(true)
      .describe(
        "true 表示要求的市場來源皆成功取得且通過日期與筆數完整性檢查；任一必要來源失敗時工具會整體報錯",
      ),
    sources: z
      .array(companyMasterSourceSchema)
      .describe("本次完整使用的 TWSE／TPEx 官方來源與各自日期、筆數"),
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
        listed: z.number().int().describe("最終回傳的上市公司數"),
        otc: z.number().int().describe("最終回傳的上櫃公司數"),
        returned: z.number().int().describe("companies 完整陣列的最終公司總數"),
      })
      .strict()
      .describe("原始、排除與最終回傳筆數，可用來確認掃描母體完整性"),
    companies: z
      .array(masterCompanySchema)
      .describe(
        "符合市場與篩選條件的完整公司清單，不分頁；每個 code 可再依 get_company_metric 的每批 1–10 家限制分批查詢",
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
    market: z
      .enum(["listed", "otc"])
      .describe("此根日線實際來自 TWSE 上市或 TPEx 上櫃市場"),
    status: z
      .enum(["traded", "no_trade"])
      .describe("traded=有有效 OHLC，no_trade=官方列出日期但沒有成交價格"),
  })
  .strict();

const priceSourceSchema = z
  .object({
    market: z.enum(["listed", "otc"]).describe("此官方來源負責的市場"),
    sourceName: z.string().describe("官方 OHLC 資料集或查詢頁名稱"),
    sourceUrl: z.string().url().describe("本次使用的固定 TWSE／TPEx 官方 URL"),
    retrievedAt: z.string().describe("本服務實際取得這份官方回應的 ISO 8601 時間"),
    dataDate: calendarDateSchema
      .optional()
      .describe("單日市場來源實際回傳並核對成功的資料日期"),
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
    coverageComplete: z
      .literal(true)
      .describe("要求的市場來源都成功且資料日期一致；否則工具整體報錯"),
    selectionComplete: z
      .boolean()
      .describe("指定 company_codes 是否全數出現在該市場交易日"),
    missingCompanyCodes: z
      .array(z.string())
      .describe("指定但未出現在該市場交易日的公司代號"),
    counts: z
      .object({
        listed: z.number().int().describe("最終回傳的上市公司 bars 數"),
        otc: z.number().int().describe("最終回傳的上櫃公司 bars 數"),
        returned: z.number().int().describe("最終完整 bars 陣列總數"),
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
      .describe("指定交易日的完整或經 company_codes 篩選後的公司 OHLC"),
    sources: z.array(priceSourceSchema).describe("本次實際使用且日期已核對的官方來源"),
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
        ...rangeOutputShape,
      })
      .strict()
      .describe("本次實際執行並正規化的查詢條件"),
    ...trendShape,
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
