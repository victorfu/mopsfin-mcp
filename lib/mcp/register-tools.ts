import type { McpServer } from "@modelcontextprotocol/server";

import { MOPSFIN_SOURCE_URL } from "@/lib/mopsfin/constants";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { asMopsfinError } from "@/lib/mopsfin/errors";
import type { Catalog } from "@/lib/mopsfin/types";

import {
  companyMetricInputSchema,
  companyMetricOutputSchema,
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
        "以公司代號或名稱搜尋 Mopsfin 公司清單。請在其他公司工具前使用，以確認可查詢的 company_codes。",
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
    "list_catalog",
    {
      title: "列出 Mopsfin 即時資料目錄",
      description:
        "即時解析 Mopsfin 首頁，列出可用指標代號、endpoint family、產業、金融機構及可選期間。未知 metric_code、industry_codes 或 institution_codes 時先呼叫本工具。目錄只在單一執行個體記憶體快取五分鐘。",
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
        "查詢一般公司財務趨勢、財務比率、成長率與現金流指標。metric_code 必須是 list_catalog 中 family=data 的代號；一次最多比較十家公司。未指定範圍時只回最近 12 季。cumulative_yoy 必須指定 yoy_quarter。",
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
        "查詢資產負債表、綜合損益表或現金流量表。period 預設 latest，服務會由上一個完成季度往前探測，並拒絕 Mopsfin 靜默回傳的錯誤季度。表格以 offset/limit 分頁。",
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
        "查詢五類財報附註：合併子公司、資金貸與、背書保證、被投資公司及大陸投資。支援 latest 或 YYYYQn，並將 HTML rowspan/colspan 展開成完整二維表格。",
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
        "查詢 Mopsfin 產業統計或產業趨勢，可選營收或稅後純益。statistics 使用 period；trend 使用 history/start_period/end_period，且至少指定一個產業代號。",
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
        "查詢六項金融業資產品質或三項資本適足率。metric_code 必須是 list_catalog 中 family=fin 或 adequacy 的代號；institution_codes 最多十家。",
      inputSchema: financialInstitutionInputSchema,
      outputSchema: financialInstitutionOutputSchema,
      annotations,
    },
    async (input) => {
      try {
        const data = await mopsfinClient.getFinancialInstitutionMetric({
          metricCode: input.metric_code,
          institutionCodes: input.institution_codes,
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
