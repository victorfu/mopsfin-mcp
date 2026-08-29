import { defineTool } from "./definition";
import {
  MOPSFIN_OFFICIAL_GUIDANCE,
  MOPSFIN_SOURCE_URL,
  FRESHNESS_POLICIES,
  annotations,
  catalogPeriods,
  evaluateFreshness,
  includesQuery,
  listCatalogInputSchema,
  listCatalogOutputSchema,
  metricGuidance,
  mopsfinClient,
  source,
  success,
} from "./shared";

export const listCatalogTool = defineTool(
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
          ...source(
            "/",
            catalog.retrievedAt ?? catalog.discoveredAt,
            catalog.cache,
          ),
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
          {
            selector: "snapshot",
            freshnessDetails: [
              evaluateFreshness({
                policy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
                observedAsOf: catalog.discoveredAt,
                expectedAsOf: null,
                sourceUrls: [MOPSFIN_SOURCE_URL],
              }),
            ],
          },
        );
    },
);

export const catalogTools = [
  listCatalogTool,
] as const;
