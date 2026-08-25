import type { McpServer } from "@modelcontextprotocol/server";

import { companyMasterClient } from "@/lib/company-master/client";
import { MOPSFIN_SOURCE_URL } from "@/lib/mopsfin/constants";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { asMopsfinError } from "@/lib/mopsfin/errors";
import {
  MOPSFIN_OFFICIAL_GUIDANCE,
  metricGuidance,
} from "@/lib/mopsfin/guidance";
import type { Catalog } from "@/lib/mopsfin/types";
import { priceClient } from "@/lib/price/client";

import {
  companyMetricInputSchema,
  companyMetricOutputSchema,
  dailyMarketOhlcInputSchema,
  dailyMarketOhlcOutputSchema,
  financialInstitutionInputSchema,
  financialInstitutionOutputSchema,
  financialNoteInputSchema,
  financialNoteOutputSchema,
  financialStatementInputSchema,
  financialStatementOutputSchema,
  findCompaniesInputSchema,
  findCompaniesOutputSchema,
  industryDataInputSchema,
  industryDataOutputSchema,
  listCatalogInputSchema,
  listCatalogOutputSchema,
  listCompaniesInputSchema,
  listCompaniesOutputSchema,
  stockOhlcInputSchema,
  stockOhlcOutputSchema,
} from "./schemas";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function source(route: string) {
  return {
    sourceName: "公開資訊觀測站－財務比較 E 點通",
    sourceUrl: MOPSFIN_SOURCE_URL,
    retrievedAt: new Date().toISOString(),
    upstreamRoute: route,
    freshnessNote: "原站每日更新一次，資料可能較最新申報落後約一日。",
  };
}

function success<T extends object>(summary: string, data: T) {
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent: data,
  };
}

function failure(error: unknown) {
  const normalized = asMopsfinError(error);
  const details = normalized.details
    ? ` ${JSON.stringify(normalized.details)}`
    : "";
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `${normalized.code}: ${normalized.message}${details}`,
      },
    ],
  };
}

function includesQuery(values: Array<string | undefined>, query: string): boolean {
  const needle = query.toLocaleLowerCase("zh-TW");
  return values.some((value) =>
    value?.toLocaleLowerCase("zh-TW").includes(needle),
  );
}

function catalogPeriods(catalog: Catalog): string[] {
  return catalog.years.flatMap((year) =>
    catalog.quarters.map((quarter) => `${year}Q${quarter}`),
  );
}

export function registerMopsfinTools(server: McpServer): void {
  server.registerTool(
    "find_companies",
    {
      title: "搜尋台灣公司",
      description:
        "以公司代號或中英文名稱搜尋 Mopsfin 公司清單，回傳可供其他工具使用的正式 company_codes、公司名稱與上游顯示值。當使用者只提供公司名稱、簡稱、股票代號不確定，或其他工具回傳 NOT_FOUND 時，應先呼叫本工具；不要臆測公司代號，也不要把金融機構工具的 institution_code 當成股票代號。資料範圍包括上市、上櫃、興櫃、公開發行及部分未公開發行金融業，但不含 TDR 發行公司。搜尋無結果時可縮短名稱或改用已知代號重試；找到公司只表示它存在於 Mopsfin 清單，不保證每個指標、附註或季度都有資料。",
      inputSchema: findCompaniesInputSchema,
      outputSchema: findCompaniesOutputSchema,
      annotations,
    },
    async ({ query, limit }) => {
      try {
        const companies = await mopsfinClient.findCompanies(query, limit);
        const data = {
          ...source("/suggestCompany"),
          query: { query, limit },
          companies,
          warnings:
            companies.length === 0
              ? ["找不到符合的公司；可縮短名稱或改用公司代號。"]
              : [],
        };
        return success(`找到 ${companies.length} 家符合「${query}」的公司。`, data);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_stock_ohlc",
    {
      title: "查詢單一台股歷史日線 OHLC",
      description:
        "查詢單一四碼公司股票在指定起訖日期內的官方原始日線開高低收。服務按月份讀取 TWSE／TPEx，支援目前上市櫃、已下市櫃與上櫃轉上市歷史；轉板月份會合併兩市場並拒絕同日衝突。TWSE 個股月資料自 2010-01-04、TPEx 自 1994-01-01 起支援。每頁最多處理 12 個日曆月份，coverage.coverageComplete=false 時必須以完全相同的 company_code、start_date、end_date 帶回 nextCursor 繼續，不能把單頁誤稱完整區間。價格固定為 TWD、Asia/Taipei、1d、raw_unadjusted，不含 adjusted close、成交量或成交金額；無成交列以 null OHLC 與 no_trade 表示，不補週末、休市或停牌日期。",
      inputSchema: stockOhlcInputSchema,
      outputSchema: stockOhlcOutputSchema,
      annotations,
    },
    async ({ company_code, start_date, end_date, cursor }) => {
      try {
        const data = await priceClient.getStockOhlc({
          companyCode: company_code,
          startDate: start_date,
          endDate: end_date,
          ...(cursor ? { cursor } : {}),
        });
        return success(
          `${company_code}：本頁 ${data.bars.length} 根日線，已覆蓋至 ${data.coverage.coveredThrough}，coverageComplete=${data.coverage.coverageComplete}。`,
          data,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_daily_market_ohlc",
    {
      title: "查詢單日台股市場 OHLC",
      description:
        "查詢最近完成交易日或指定 YYYY-MM-DD 的上市、上櫃或全部公司股票官方原始 OHLC。market=listed 只取 TWSE、market=otc 只取 TPEx、market=all 要求兩市場資料日期一致；latest 不是盤中即時價，指定假日或未來日期不會靜默退回前一日。company_codes 可選且最多 500 家，省略時回完整市場；指定代號部分缺失時以 selectionComplete=false、missingCompanyCodes 與 warnings 揭露，全部缺失則回 NO_DATA。latest 以目前 company master 過濾公司股票；歷史日期以四碼首碼非 0 且非 -DR 規則排除 ETF、ETN、TDR 等非公司商品。價格固定為 TWD、Asia/Taipei、1d、raw_unadjusted，不含 adjusted close、成交量或成交金額。",
      inputSchema: dailyMarketOhlcInputSchema,
      outputSchema: dailyMarketOhlcOutputSchema,
      annotations,
    },
    async ({ market, date, company_codes }) => {
      try {
        const data = await priceClient.getDailyMarketOhlc({
          market,
          date,
          ...(company_codes ? { companyCodes: company_codes } : {}),
        });
        return success(
          `${data.dataDate} ${market} 市場：回傳 ${data.counts.returned} 家公司 OHLC，coverageComplete=true、selectionComplete=${data.selectionComplete}。`,
          data,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_companies",
    {
      title: "列出上市櫃公司完整母體",
      description:
        "從 TWSE 上市公司基本資料與 TPEx 上櫃股票基本資料官方 OpenAPI 建立可供 Mopsfin 財務查詢使用的完整公司母體。market=listed 只回上市公司且包含創新板，market=otc 只回上櫃公司，market=all 同時取得兩個市場；任何必要來源失敗、同一來源出表日期不一致或筆數低於完整性基準時整體報錯，不會把部分結果當成完整市場。公司基本資料來源不包含 ETF、ETN、權證或特別股，上市來源中的 TDR 會固定排除，因為 Mopsfin 不涵蓋 TDR。include_financial 與 include_ky 可進一步排除金融保險業或 KY 公司。回傳不分頁的完整 companies、各市場出表日期、來源筆數、排除筆數、snapshotId 與 coverageComplete；公司存在於母體不保證每個 Mopsfin 指標或期別都有資料。",
      inputSchema: listCompaniesInputSchema,
      outputSchema: listCompaniesOutputSchema,
      annotations,
    },
    async ({ market, include_financial, include_ky }) => {
      try {
        const data = await companyMasterClient.listCompanies({
          market,
          includeFinancial: include_financial,
          includeKy: include_ky,
        });
        const marketLabel =
          market === "listed" ? "上市" : market === "otc" ? "上櫃" : "上市及上櫃";
        return success(
          `${marketLabel}公司母體共 ${data.counts.returned} 家（上市 ${data.counts.listed}、上櫃 ${data.counts.otc}），coverageComplete=true。`,
          data,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_catalog",
    {
      title: "列出 Mopsfin 即時資料目錄",
      description:
        "即時解析 Mopsfin 首頁，列出可用指標代號、endpoint family、產業、金融機構與可選期間，並為每個指標提供官方語意、公式、值的口徑、適用業別與注意事項。未知 metric_code、industry_codes、institution_codes、可用期間，或需要正確解釋某項指標時，必須先呼叫本工具。回傳的 officialGuidance 說明 IFRSs 資料範圍、不同市場申報季度、報表／附註可用性、單季與累計口徑及平均數算法。目錄只在單一執行個體記憶體快取五分鐘，財務數據不快取。",
      inputSchema: listCatalogInputSchema,
      outputSchema: listCatalogOutputSchema,
      annotations,
    },
    async ({ kind, query, limit }) => {
      try {
        const catalog = await mopsfinClient.getCatalog();
        const filter = query?.trim() ?? "";
        const allPeriods = catalogPeriods(catalog);
        const metrics =
          kind === "all" || kind === "metrics"
            ? catalog.metrics
                .filter(
                  (item) =>
                    !filter ||
                    includesQuery(
                      [item.code, item.name, item.category, item.family],
                      filter,
                    ),
                )
                .slice(0, limit)
                .map((metric) => ({
                  ...metric,
                  guidance: metricGuidance(metric),
                }))
            : [];
        const industries =
          kind === "all" || kind === "industries"
            ? catalog.industries
                .filter(
                  (item) =>
                    !filter || includesQuery([item.code, item.name], filter),
                )
                .slice(0, limit)
            : [];
        const financialInstitutions =
          kind === "all" || kind === "financial_institutions"
            ? catalog.financialInstitutions
                .filter(
                  (item) =>
                    !filter ||
                    includesQuery([item.code, item.name, item.sector], filter),
                )
                .slice(0, limit)
            : [];
        const periods =
          kind === "all" || kind === "periods"
            ? allPeriods
                .filter((period) => !filter || period.includes(filter))
                .slice(0, limit)
            : [];
        const warnings =
          catalog.metrics.length < 53
            ? [
                `目前只解析到 ${catalog.metrics.length} 個指標，少於已知基準 53；Mopsfin 首頁結構可能已變更。`,
              ]
            : [];
        const data = {
          ...source("/"),
          query: { kind, ...(filter ? { query: filter } : {}), limit },
          discoveredAt: catalog.discoveredAt,
          counts: {
            metrics: catalog.metrics.length,
            industries: catalog.industries.length,
            financialInstitutions: catalog.financialInstitutions.length,
            periods: allPeriods.length,
          },
          metrics,
          industries,
          financialInstitutions,
          periods,
          officialGuidance: MOPSFIN_OFFICIAL_GUIDANCE,
          warnings,
        };
        return success(
          `Mopsfin 目錄共有 ${catalog.metrics.length} 個指標、${catalog.industries.length} 個產業與 ${catalog.financialInstitutions.length} 家金融機構。`,
          data,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_company_metric",
    {
      title: "查詢公司財務指標",
      description:
        "查詢公司財務趨勢、財務結構、償債／經營／獲利／成長能力及現金流指標。metric_code 必須取自 list_catalog 中 family=data；一次比較 1–10 家公司。預設 basis=quarterly，代表 Mopsfin 單季口徑：上市櫃 Q4 通常由全年累計減 Q3，興櫃／公開發行 Q2 通常為半年累計、Q4 通常由全年累計減 Q2。basis=cumulative_yoy 代表指定季度的累計同比，必須提供 yoy_quarter。預設回最近 12 個可用期別；缺值可能是不適用、未申報或沒有該季度，不可視為 0。使用數值前應讀取 unit、query、warnings，並可用 list_catalog 取得該指標公式與適用限制。",
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
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
