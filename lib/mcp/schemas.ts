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
        kind: z.enum([
          "all",
          "metrics",
          "industries",
          "financial_institutions",
          "periods",
        ]),
        query: z.string().optional(),
        limit: z.number().int(),
      })
      .strict(),
    discoveredAt: z.string().describe("本次即時目錄從 Mopsfin 首頁解析的時間"),
    counts: z
      .object({
        metrics: z.number().int().describe("篩選與 limit 前的指標總數"),
        industries: z.number().int().describe("篩選與 limit 前的產業總數"),
        financialInstitutions: z.number().int().describe("篩選與 limit 前的金融機構總數"),
        periods: z.number().int().describe("首頁年度與季度組合出的期間總數"),
      })
      .strict(),
    metrics: z.array(metricDefinitionSchema).describe("符合 kind/query/limit 的指標目錄及逐項 guidance"),
    industries: z.array(
      z
        .object({
          code: z.string().describe("get_industry_data 使用的 industry_code"),
          name: z.string().describe("Mopsfin 產業名稱"),
        })
        .strict(),
    ).describe("符合篩選的即時產業清單"),
    financialInstitutions: z.array(
      z
        .object({
          code: z.string().describe("金融機構工具使用的 institution_code"),
          name: z.string().describe("金融機構名稱"),
          sector: z
            .enum(["holding", "bank", "bills", "unknown"])
            .describe("holding=金控、bank=銀行、bills=票券；需與指標適用性相符"),
        })
        .strict(),
    ),
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
        ...rangeOutputShape,
      })
      .strict()
      .describe("實際執行的金融機構查詢條件"),
    ...trendShape,
    ...warningShape,
  })
  .strict();
