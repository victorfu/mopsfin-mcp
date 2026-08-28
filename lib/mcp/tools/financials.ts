import { defineTool } from "./definition";
import type { ResultMetaHints } from "./shared";
import {
  MOPSFIN_SOURCE_URL,
  FRESHNESS_POLICIES,
  annotations,
  companyMetricInputSchema,
  companyMetricOutputSchema,
  companyMetricsBatchClient,
  companyMetricsBatchInputSchema,
  companyMetricsBatchOutputSchema,
  failure,
  financialInstitutionInputSchema,
  financialInstitutionOutputSchema,
  financialNoteInputSchema,
  financialNoteOutputSchema,
  financialStatementInputSchema,
  financialStatementOutputSchema,
  fingerprint,
  industryDataInputSchema,
  industryDataOutputSchema,
  mopsfinClient,
  paginateByCompany,
  resolvedQuarterRange,
  selectorFreshness,
  success,
} from "./shared";

export const getCompanyMetricTool = defineTool(
    "get_company_metric",
    {
      title: "查詢公司財務指標",
      description:
        "查詢公司財務趨勢、財務結構、償債／經營／獲利／成長能力及現金流指標。metric_code 必須取自 list_catalog 中 family=data；一次比較 1–10 家公司。每個公司 series 會回傳獨立 companyCode、companyName、displayName 與 seriesType，避免依 label 猜身份；逐點 valueStatus 區分 reported、missing、invalid_upstream，null 不可視為 0。coverage 會揭露 requested／returned／missing／no-valid-data 公司、逐公司缺期與所有公司共同有值的 commonThroughPeriod；selectionComplete=false 代表至少一家公司缺 series 或本次範圍完全沒有 reported 值。預設 basis=quarterly；basis=cumulative_yoy 必須提供 yoy_quarter。可選產業平均與所選公司簡單平均，兩者都不是市值加權；使用前應讀取 unit、query、coverage、warnings 與 list_catalog guidance。",
      inputSchema: companyMetricInputSchema,
      outputSchema: companyMetricOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const data = await mopsfinClient.getCompanyMetric({
          metricCode: input.metric_code,
          companyCodes: input.company_codes,
          basis: input.basis,
          yoyQuarter: input.yoy_quarter,
          includeIndustryAverage: input.include_industry_average,
          includeCompanyAverage: input.include_company_average,
          range: {
            history: input.history,
            startPeriod: input.start_period,
            endPeriod: input.end_period,
          },
        });
        return success(
          `${data.query.metricName}：${data.series.length} 組 series、${data.periods.length} 個期別，單位 ${data.unit || "未標示"}。`,
          data,
          {
            selector: "range",
            resolved: resolvedQuarterRange(data.periods),
            selection: data.coverage.selectionComplete ? "complete" : "partial",
            values: data.series.some((series) =>
              series.points.some((point) => point.valueStatus === "invalid_upstream"),
            )
              ? "partial"
              : "complete",
            freshnessDetails: selectorFreshness({
              selector:
                input.start_period || input.end_period ? "range" : "latest",
              observedAsOf: data.periods.at(-1) ?? null,
              latestPolicy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              sources: [data],
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const getCompanyMetricsBatchTool = defineTool(
    "get_company_metrics_batch",
    {
      title: "批次查詢多家公司多項財務指標",
      description:
        "以單一呼叫取得 1–100 家公司、1–8 個 list_catalog family=data 指標；每個成功解析 identity 的公司頁面都保留全部 requested metrics，不按指標拆頁。預設每家公司每項指標最多回自己的最近 12 期，也可指定最多 12 季的成對 start_period/end_period。basis 與 yoy_quarter 語意沿用 get_company_metric；本工具不提供產業平均或所選公司平均。每頁最多 20 家、comparison 與有界二分 failure isolation 合計最多 24 個上游工作單位。單一公司 identity 或 company×metric failure 會以 evaluationStatus、availability=unavailable、failure、failures 與 coverage 隔離，其他成功公司／指標仍回傳；合法 no_data 與 unavailable 明確分開，兩者都不能當成 0。failureIsolationComplete=false 或 failures[].attribution=chunk 表示共享 request 或隔離預算使錯誤不能精確歸因至單一公司。Partial success 仍保留按 requested companies 計算的 meta.page.next。無狀態 cursor 只綁 query 與 catalog 定義，各頁財務值於該頁即時取得，不是跨頁 point-in-time 快照；回答前應檢查 failures、coverage、workBudget、meta.quality 與 meta.page.next。",
      inputSchema: companyMetricsBatchInputSchema,
      outputSchema: companyMetricsBatchOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const companyCodes = [...input.company_codes];
        const metricCodes = [...input.metric_codes];
        const catalog = await mopsfinClient.getCatalog();
        const cursorScopeId = fingerprint({
          metrics: metricCodes.map((code) =>
            catalog.metrics.find((metric) => metric.code === code),
          ),
          years: catalog.years,
          quarters: catalog.quarters,
        });
        const paginated = paginateByCompany({
          tool: "get_company_metrics_batch",
          query: {
            company_codes: companyCodes,
            metric_codes: metricCodes,
            basis: input.basis,
            yoy_quarter: input.yoy_quarter,
            start_period: input.start_period,
            end_period: input.end_period,
          },
          snapshotId: cursorScopeId,
          items: companyCodes,
          pageSize: input.page_size,
          cursor: input.cursor,
          maximumPageSize: 20,
        });
        const data = await companyMetricsBatchClient.getCompanyMetricsBatch({
          companyCodes: paginated.items,
          metricCodes,
          basis: input.basis,
          yoyQuarter: input.yoy_quarter,
          startPeriod: input.start_period,
          endPeriod: input.end_period,
        });
        const returnedPeriods = data.companies.flatMap((company) =>
          company.metrics.flatMap((metric) => metric.periods),
        );
        const identityFailures = data.failures.filter(
          (item) => item.stage === "identity",
        );
        const metricFailures = data.failures.filter(
          (item) => item.stage === "metric",
        );
        const chunkFailures = metricFailures.filter(
          (item) => item.attribution === "chunk",
        );
        const metricValuesPartial =
          metricFailures.length > 0 ||
          data.companies.some((company) =>
            company.metrics.some(
              (metric) =>
                metric.availability === "unavailable" ||
                metric.coverage.invalidPoints > 0,
            ),
          );
        const sourceUrls = [
          ...new Set([
            ...data.sources.map((item) => item.sourceUrl),
            ...(data.failures.length > 0 ? [MOPSFIN_SOURCE_URL] : []),
          ]),
        ];
        const qualityIssues: NonNullable<ResultMetaHints["issues"]> = [
          {
            code: "STATELESS_PAGE_VALUES_NOT_PINNED",
            severity: "info",
            scope: "page",
            message:
              "無狀態 cursor 固定 query 與 catalog；各頁 Mopsfin 財務值在該頁查詢時取得，不保證跨頁 point-in-time 一致。",
            refs: {
              companyCodes: data.coverage.requestedCompanyCodes,
              fields: data.metricDefinitions.map((metric) => metric.code),
              periods: [...new Set(returnedPeriods)].sort(),
              sourceUrls,
            },
          },
          ...(identityFailures.length > 0
            ? [
                {
                  code: "BATCH_COMPANY_IDENTITY_FAILED",
                  severity: "warning" as const,
                  scope: "selection" as const,
                  message:
                    "部分 requested 公司 identity 解析失敗；其他公司仍已處理，失敗公司不會被補成名稱、no_data 或 0。",
                  refs: {
                    companyCodes: [
                      ...new Set(
                        identityFailures.map((item) => item.companyCode),
                      ),
                    ],
                    fields: [
                      "failures",
                      "coverage.identityFailedCompanyCodes",
                      "companies",
                    ],
                    periods: [],
                    sourceUrls,
                  },
                },
              ]
            : []),
          ...(metricFailures.length > 0
            ? [
                {
                  code: "BATCH_COMPANY_METRIC_FAILED",
                  severity: "warning" as const,
                  scope: "source" as const,
                  message:
                    "部分 company×metric 查詢 unavailable；成功值仍保留，失敗項目必須依 availability 與 failure 重試或降級。",
                  refs: {
                    companyCodes: [
                      ...new Set(
                        metricFailures.map((item) => item.companyCode),
                      ),
                    ],
                    fields: [
                      ...new Set(
                        metricFailures.flatMap((item) =>
                          item.metricCode ? [item.metricCode] : [],
                        ),
                      ),
                    ],
                    periods: [],
                    sourceUrls,
                  },
                },
              ]
            : []),
          ...(!data.coverage.failureIsolationComplete
            ? [
                {
                  code: "BATCH_FAILURE_ISOLATION_INCOMPLETE",
                  severity: "warning" as const,
                  scope: "source" as const,
                  message:
                    "部分 metric failure 只能歸因到共享 company chunk，不能據此判定每一家都是錯誤來源。",
                  refs: {
                    companyCodes: [
                      ...new Set(
                        chunkFailures.map((item) => item.companyCode),
                      ),
                    ],
                    fields: [
                      "failures[].attribution",
                      "coverage.failureIsolationComplete",
                      "workBudget.isolationRetryUnits",
                    ],
                    periods: [],
                    sourceUrls,
                  },
                },
              ]
            : []),
        ];
        return success(
          `本頁處理 ${data.coverage.requestedCompanyCodes.length} 家 requested 公司、${data.metricDefinitions.length} 項財務指標；${data.companies.length} 家完成 identity、${data.coverage.unavailableCompanyCodes.length} 家含 unavailable 結果，selectionComplete=${data.coverage.selectionComplete}。`,
          data,
          {
            page: paginated.page,
            snapshotId: cursorScopeId,
            source: data.coverage.sourceComplete ? "complete" : "partial",
            universe: "not_applicable",
            selection: data.coverage.selectionComplete ? "complete" : "partial",
            values: metricValuesPartial ? "partial" : "complete",
            resolved: resolvedQuarterRange(returnedPeriods),
            freshnessDetails: selectorFreshness({
              selector:
                input.start_period || input.end_period ? "range" : "latest",
              observedAsOf: returnedPeriods.sort().at(-1) ?? null,
              latestPolicy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              sources: data.sources,
            }),
            issues: qualityIssues,
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const getFinancialStatementTool = defineTool(
    "get_financial_statement",
    {
      title: "查詢三大財務報表",
      description:
        "查詢格式化的資產負債表、綜合損益表或現金流量表。資產負債表是指定期末存量；綜合損益表與現金流量表是各季累計金額，不是單季金額。period 預設 latest，服務會由上一個完成季度往前最多探測 12 季，並拒絕 Mopsfin 靜默回傳的錯誤季度。不同市場的申報頻率不同，因此 latest 可能不是最近曆季。表格以 offset/limit 分頁，回答前應確認 pagination 是否還有 nextOffset，並保留 unit 與 period。",
      inputSchema: financialStatementInputSchema,
      outputSchema: financialStatementOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const data = await mopsfinClient.getFinancialStatement({
          statement: input.statement,
          companyCodes: input.company_codes,
          period: input.period,
          page: { offset: input.offset, limit: input.limit },
        });
        return success(
          `${data.period} ${input.statement}：回傳 ${data.pagination.returnedRows}/${data.pagination.totalRows} 列。`,
          data,
          {
            selector: input.period === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "quarter",
              from: data.period,
              through: data.period,
            },
            freshnessDetails: selectorFreshness({
              selector: input.period === "latest" ? "latest" : "explicit",
              observedAsOf: data.period,
              latestPolicy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              sources: [data],
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const getFinancialNoteTool = defineTool(
    "get_financial_note",
    {
      title: "查詢財報附註",
      description:
        "查詢五類格式化財報附註：列入合併財報的子公司、資金貸與、背書保證、被投資公司與大陸投資。支援 latest 或 YYYYQn；服務會核對實際回應期別，並把 HTML rowspan/colspan 展開為可供 LLM 逐列解讀的完整二維表格。上市／上櫃／興櫃及部分金融機構通常申報附註；公開發行公司與部分未公開發行金融業可能僅自願申報，因此 NO_DATA 不代表公司不存在。回答前應確認 pagination.nextOffset，避免只讀到第一頁。",
      inputSchema: financialNoteInputSchema,
      outputSchema: financialNoteOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const data = await mopsfinClient.getFinancialNote({
          note: input.note,
          companyCodes: input.company_codes,
          period: input.period,
          page: { offset: input.offset, limit: input.limit },
        });
        return success(
          `${data.period} ${input.note}：回傳 ${data.pagination.returnedRows}/${data.pagination.totalRows} 列。`,
          data,
          {
            selector: input.period === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "quarter",
              from: data.period,
              through: data.period,
            },
            freshnessDetails: selectorFreshness({
              selector: input.period === "latest" ? "latest" : "explicit",
              observedAsOf: data.period,
              latestPolicy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              sources: [data],
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const getIndustryDataTool = defineTool(
    "get_industry_data",
    {
      title: "查詢產業統計與趨勢",
      description:
        "查詢 Mopsfin 產業統計或產業趨勢，measure 可選營業收入或稅後純益。statistics 是指定季度的產業累計金額，使用 period；trend 用來比較一個以上產業的時間序列，使用 history/start_period/end_period，且至少指定一個即時 catalog 的 industry_codes。產業分類與成分可能調整，不能把產業平均當成單一公司的表現；回答時應明確標示統計／趨勢模式、單位、期別及回傳 warnings。",
      inputSchema: industryDataInputSchema,
      outputSchema: industryDataOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const data = await mopsfinClient.getIndustryData({
          mode: input.mode,
          measure: input.measure,
          industryCodes: input.industry_codes,
          period: input.period,
          range: {
            history: input.history,
            startPeriod: input.start_period,
            endPeriod: input.end_period,
          },
        });
        return success(
          `${input.mode}：${data.series.length} 組 series、${data.periods.length} 個期別。`,
          data,
          {
            selector:
              input.mode === "statistics"
                ? input.period === "latest"
                  ? "latest"
                  : "explicit"
                : "range",
            resolved: resolvedQuarterRange(data.periods),
            values: data.series.some((series) =>
              series.points.some((point) => point.valueStatus === "invalid_upstream"),
            )
              ? "partial"
              : "complete",
            freshnessDetails: selectorFreshness({
              selector:
                input.mode === "statistics"
                  ? input.period === "latest"
                    ? "latest"
                    : "explicit"
                  : input.start_period || input.end_period
                    ? "range"
                    : "latest",
              observedAsOf: data.periods.at(-1) ?? null,
              latestPolicy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              sources: [data],
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const getFinancialInstitutionMetricTool = defineTool(
    "get_financial_institution_metric",
    {
      title: "查詢金融機構指標",
      description:
        "查詢六項金融業資產品質或三項資本適足率。metric_code 必須取自 list_catalog 中 family=fin 或 adequacy，institution_codes 一次 1–10 家。include_industry_average 可加入該指標相應金融業別的 Mopsfin 產業平均；include_institution_average 可加入本次所選機構的簡單平均，兩者都不是市值加權。資產品質指標只適用銀行業，資料來自財報附註「資產品質」；資本適足率依指標只適用金控、銀行或票券業，而且通常只有 Q2、Q4 申報。部分公開發行金融機構依法不需申報，因此 NO_DATA 或 null 不可視為 0。使用前應讀取 list_catalog 的公式、applicability 與本工具 warnings，並依 series.label 區分個別機構、所選機構平均與產業平均。",
      inputSchema: financialInstitutionInputSchema,
      outputSchema: financialInstitutionOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const data = await mopsfinClient.getFinancialInstitutionMetric({
          metricCode: input.metric_code,
          institutionCodes: input.institution_codes,
          includeIndustryAverage: input.include_industry_average,
          includeInstitutionAverage: input.include_institution_average,
          range: {
            history: input.history,
            startPeriod: input.start_period,
            endPeriod: input.end_period,
          },
        });
        return success(
          `${data.query.metricName}：${data.series.length} 組 series、${data.periods.length} 個期別。`,
          data,
          {
            selector: "range",
            resolved: resolvedQuarterRange(data.periods),
            values: data.series.some((series) =>
              series.points.some((point) => point.valueStatus === "invalid_upstream"),
            )
              ? "partial"
              : "complete",
            freshnessDetails: selectorFreshness({
              selector:
                input.start_period || input.end_period ? "range" : "latest",
              observedAsOf: data.periods.at(-1) ?? null,
              latestPolicy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              sources: [data],
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const financialsTools = [
  getCompanyMetricTool,
  getCompanyMetricsBatchTool,
  getFinancialStatementTool,
  getFinancialNoteTool,
  getIndustryDataTool,
  getFinancialInstitutionMetricTool,
] as const;
