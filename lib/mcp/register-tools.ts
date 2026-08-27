import type { McpServer } from "@modelcontextprotocol/server";

import { catalystClient } from "@/lib/catalyst/client";
import { companyMasterClient } from "@/lib/company-master/client";
import { MOPSFIN_SOURCE_URL } from "@/lib/mopsfin/constants";
import { companyMetricsBatchClient } from "@/lib/mopsfin/batch";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { asMopsfinError } from "@/lib/mopsfin/errors";
import {
  MOPSFIN_OFFICIAL_GUIDANCE,
  metricGuidance,
} from "@/lib/mopsfin/guidance";
import type { Catalog } from "@/lib/mopsfin/types";
import { priceClient } from "@/lib/price/client";
import { recordMcpToolError } from "@/lib/observability/telemetry";
import { reactionClient } from "@/lib/reaction/client";
import { monthlyRevenueClient } from "@/lib/revenue/client";
import { taiwanStockScreenClient } from "@/lib/screening/client";
import { valuationClient } from "@/lib/valuation/client";
import {
  buildResultMeta,
  structuredError,
  type ResultMetaHints,
} from "./result-contract";
import { fingerprint, paginateByCompany } from "./cursor";

import {
  companyCatalystEventsInputSchema,
  companyCatalystEventsOutputSchema,
  companyMetricInputSchema,
  companyMetricOutputSchema,
  companyMetricsBatchInputSchema,
  companyMetricsBatchOutputSchema,
  dailyMarketOhlcInputSchema,
  dailyMarketOhlcOutputSchema,
  dailyMarketValuationInputSchema,
  dailyMarketValuationOutputSchema,
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
  monthlyRevenueInputSchema,
  monthlyRevenueOutputSchema,
  monthlyRevenueTrendInputSchema,
  monthlyRevenueTrendOutputSchema,
  screenTaiwanStockCandidatesInputSchema,
  screenTaiwanStockCandidatesOutputSchema,
  stockReactionSignalsInputSchema,
  stockReactionSignalsOutputSchema,
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

function success<T extends object>(summary: string, data: T, hints: ResultMetaHints = {}) {
  const structuredContent = {
    ok: true as const,
    meta: buildResultMeta(data as Record<string, unknown>, hints),
    ...data,
  };
  return {
    content: [{ type: "text" as const, text: summary }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const normalized = asMopsfinError(error);
  recordMcpToolError(normalized);
  const structuredContent = structuredError(normalized);
  const details = Object.keys(structuredContent.error.details as object).length
    ? ` ${JSON.stringify(structuredContent.error.details)}`
    : "";
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `${normalized.code}: ${normalized.message}${details}`,
      },
    ],
    structuredContent,
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

function resolvedQuarterRange(periods: string[]) {
  const ordered = [...periods].sort();
  return {
    granularity: "quarter" as const,
    from: ordered[0] ?? null,
    through: ordered.at(-1) ?? null,
  };
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
        "查詢單一四碼公司股票在指定起訖日期內的官方原始日線開高低收、成交量（股）、成交金額（TWD）、成交筆數與漲跌價差。服務按月份讀取 TWSE／TPEx，支援目前上市櫃、已下市櫃與上櫃轉上市歷史；轉板月份會合併兩市場並拒絕同日衝突。TWSE 個股月資料自 2010-01-04、TPEx 自 1994-01-01 起支援。每頁最多處理 12 個日曆月份，coverage.coverageComplete=false 時必須以完全相同的 company_code、start_date、end_date 帶回 nextCursor 繼續。官方 no-data response 若缺少 title/date，source.snapshotIdentity=unverified_empty、dataMonth 省略，meta.quality.source=partial 並帶 SOURCE_SNAPSHOT_IDENTITY_UNVERIFIED，不得把該空回應宣稱為已核對 requested month。價格固定為 TWD、Asia/Taipei、1d、raw_unadjusted，不含 adjusted close；每根 bar 的 qualityStatus、missingFields 與頂層 dataQualityComplete 揭露欄位完整性，無成交列以 null OHLC 與 official_no_trade 表示，不補週末、休市或停牌日期。",
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
        const unverifiedSources = data.sources.filter(
          (item) => item.snapshotIdentity === "unverified_empty",
        );
        return success(
          `${company_code}：本頁 ${data.bars.length} 根日線，已覆蓋至 ${data.coverage.coveredThrough}，coverageComplete=${data.coverage.coverageComplete}。`,
          data,
          {
            source: unverifiedSources.length > 0 ? "partial" : "complete",
            issues:
              unverifiedSources.length > 0
                ? [
                    {
                      code: "SOURCE_SNAPSHOT_IDENTITY_UNVERIFIED",
                      severity: "warning",
                      scope: "source",
                      message:
                        "部分官方 no-data response 未提供 title/date，無法把空回應驗證綁定至 requested month。",
                      refs: {
                        companyCodes: [company_code],
                        fields: ["sources.snapshotIdentity", "sources.dataMonth"],
                        periods: [],
                        sourceUrls: unverifiedSources.map((item) => item.sourceUrl),
                      },
                    },
                  ]
                : [],
          },
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
        "查詢最近完成交易日或指定 YYYY-MM-DD 的上市、上櫃或全部公司股票官方原始 OHLC、成交量（股）、成交金額（TWD）、成交筆數與漲跌價差。market=all 要求 TWSE／TPEx 資料日期一致；latest 不是盤中即時價，指定假日或未來日期不會靜默退回前一日。company_codes 可選且最多 500 家；部分缺失以 selectionComplete=false 揭露。latest 預設 universe_policy=compatible，會保留四碼公司代號 fallback 並回傳 reconciliation，但各市場與目前 master 的 matchRatio 低於 95% 仍回 INCOMPLETE_COVERAGE；strict_current_master 僅支援 latest 且要求完全吻合。歷史日期只使用可解釋但未經目前母體驗證的代號規則。價格為 TWD、Asia/Taipei、1d、raw_unadjusted；qualityStatus、missingFields、dataQualityComplete 與單位 normalization 不可忽略。",
      inputSchema: dailyMarketOhlcInputSchema,
      outputSchema: dailyMarketOhlcOutputSchema,
      annotations,
    },
    async ({ market, date, company_codes, universe_policy, page_size, cursor }) => {
      try {
        const data = await priceClient.getDailyMarketOhlc({
          market,
          date,
          universePolicy: universe_policy,
          ...(company_codes ? { companyCodes: company_codes } : {}),
        });
        const snapshotId = fingerprint({
          dataDate: data.dataDate,
          sources: data.sources.map((item) => ({
            market: item.market,
            sourceUrl: item.sourceUrl,
            dataDate: item.dataDate,
          })),
          bars: data.bars,
        });
        const paginated = paginateByCompany({
          tool: "get_daily_market_ohlc",
          query: {
            market,
            date,
            company_codes: company_codes ? [...company_codes].sort() : undefined,
            universe_policy,
          },
          snapshotId,
          items: data.bars,
          pageSize: page_size,
          cursor,
          maximumPageSize: 500,
          legacyUnpaged: true,
        });
        const pageData = paginated.page.mode === "none"
          ? data
          : {
              ...data,
              bars: paginated.items,
              counts: {
                listed: paginated.items.filter((bar) => bar.market === "listed").length,
                otc: paginated.items.filter((bar) => bar.market === "otc").length,
                returned: paginated.items.length,
              },
            };
        return success(
          `${pageData.dataDate} ${market} 市場：本頁回傳 ${pageData.counts.returned} 家公司價量資料，coverageComplete=true、universeCoverageVerified=${pageData.universeCoverageVerified}、selectionComplete=${pageData.selectionComplete}。`,
          pageData,
          {
            page: paginated.page,
            snapshotId,
            freshness: date === "latest" ? "within_expected_window" : "not_applicable",
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_stock_reaction_signals",
    {
      title: "比較台股與市場 benchmark 的 reaction signals",
      description:
        "比較 1–50 家目前上市櫃公司與 TAIEX／櫃買 price index 在 5／20／60／120 個 exact benchmark sessions 的 reaction signals。stockReturnPercent 保留 raw_unadjusted close-to-close 稽核值；excessReturnPercentagePoints 只使用 TWSE／TPEx official actual-result 公司行動資料可重算的 factor，移除股數變動造成的機械價格斷點。現金股利價格效果刻意保留，因此 returnBasis=price_index_compatible_corporate_action_adjusted 不是 adjusted close、股息再投資或 total return（也不是 total shareholder return）。公司行動 coverage、factor、prior close 或 marker reconciliation 任一不足，相關 return／path／share-volume signal 回 null、not_comparable 或 unknown 語意，絕不猜測、補 0 或退回 raw 差值。個別公司 OHLC 的 MopsfinError 會隔離成 stockDataStatus=unavailable 與結構化 stockDataFailure，所有該公司 stock-derived signals 為 stock_data_unavailable；官方正常查無資料則另以 no_data／no_stock_data 表示，兩者不混用，其他公司繼續。轉板、歷史市場不符與多個 observed names 仍不可比。每頁最多 10 家且受 48 個官方市場月份 units 限制；公司行動 range/detail requests 另列於 workBudget。v2 cursor 與 snapshotId 綁定 query、目前 master、benchmark 及公司行動 fingerprint，尚未查詢公司的個股 OHLC 仍非 point-in-time snapshot。這些是研究代理，不是錯價證明或投資建議；回答前須檢查 returnBasis、stockDataStatus、stockDataFailure、comparability、corporateActionHistoryComplete、status、meta.quality 與 meta.page。",
      inputSchema: stockReactionSignalsInputSchema,
      outputSchema: stockReactionSignalsOutputSchema,
      annotations,
    },
    async ({ company_codes, as_of, horizons, page_size, cursor }) => {
      try {
        const data = await reactionClient.getStockReactionSignals({
          companyCodes: company_codes,
          asOf: as_of,
          horizons,
          pageSize: page_size,
          ...(cursor ? { cursor } : {}),
        });
        const resolvedDates = data.asOf.resolvedByMarket
          .map((item) => item.date)
          .sort();
        const notComparableCodes = data.companies
          .filter((company) => company.comparability.status !== "price_index_compatible")
          .map((company) => company.companyCode);
        const incompleteCorporateActionCodes = data.companies
          .filter(
            (company) =>
              !company.comparability.corporateActionCoverageComplete ||
              company.comparability.reasons.includes(
                "corporate_action_adjustment_unavailable",
              ),
          )
          .map((company) => company.companyCode);
        const unavailableStockCodes = data.companies
          .filter((company) => company.stockDataStatus === "unavailable")
          .map((company) => company.companyCode);
        const valuesComplete =
          data.coverage.dataQualityComplete &&
          data.coverage.corporateActionHistoryComplete &&
          notComparableCodes.length === 0;
        const unverifiedStockSources = data.stockSources.filter(
          (item) => item.snapshotIdentity === "unverified_empty",
        );
        const page = {
          mode: "cursor" as const,
          unit: "company" as const,
          limit: data.pagination.requestedPageSize,
          returned: data.pagination.returnedCompanyCount,
          total: data.pagination.requestedCompanyCount,
          next: data.pagination.nextCursor
            ? { kind: "cursor" as const, cursor: data.pagination.nextCursor }
            : null,
        };
        return success(
          `本頁完成 ${data.pagination.returnedCompanyCount}/${data.pagination.requestedCompanyCount} 家 reaction signals；dataQualityComplete=${data.coverage.dataQualityComplete}，仍須逐家公司檢查 comparability。`,
          data,
          {
            selector: as_of === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "date",
              from: resolvedDates[0] ?? null,
              through: resolvedDates.at(-1) ?? null,
            },
            page,
            snapshotId: data.pagination.snapshotId,
            source:
              unverifiedStockSources.length > 0 ||
              !data.coverage.corporateActionHistoryComplete ||
              unavailableStockCodes.length > 0
                ? "partial"
                : "complete",
            universe: "verified",
            selection: "complete",
            values: valuesComplete ? "complete" : "partial",
            freshness: as_of === "latest" ? "within_expected_window" : "not_applicable",
            issues: [
              {
                code: "PRICE_INDEX_COMPATIBLE_RETURN_BASIS",
                severity: "info",
                scope: "value",
                message: "excess return 只使用 official actual-result factor 移除股數變動機械斷點；現金股利價格效果保留，結果不是 adjusted close 或 total shareholder return。",
                refs: {
                  companyCodes: data.companies.map((company) => company.companyCode),
                  fields: [
                    "returnBasis",
                    "returns.priceIndexCompatibleStockReturnPercent",
                    "returns.corporateActionAdjustmentFactor",
                    "pricePath.priceBasis",
                    "comparability",
                  ],
                  periods: resolvedDates,
                  sourceUrls: data.corporateActionSources.map(
                    (item) => item.sourceUrl,
                  ),
                },
              },
              ...(!data.coverage.corporateActionHistoryComplete
                ? [
                    {
                      code: "CORPORATE_ACTION_HISTORY_INCOMPLETE",
                      severity: "warning" as const,
                      scope: "source" as const,
                      message:
                        "至少一個 requested 市場的 official actual-result 歷史未完整涵蓋視窗，或 requested-company event 缺少可用 adjustment factor；受影響 signals 保持 null／not_comparable，不使用 raw fallback。",
                      refs: {
                        companyCodes: incompleteCorporateActionCodes,
                        fields: [
                          "coverage.corporateActionHistoryComplete",
                          "comparability.corporateActionCoverageComplete",
                          "comparability.corporateActions.adjustmentStatus",
                          "corporateActionSources",
                        ],
                        periods: resolvedDates,
                        sourceUrls: data.corporateActionSources.map(
                          (item) => item.sourceUrl,
                        ),
                      },
                    },
                  ]
                : []),
              ...(unavailableStockCodes.length > 0
                ? [
                    {
                      code: "STOCK_DATA_UPSTREAM_UNAVAILABLE",
                      severity: "warning" as const,
                      scope: "source" as const,
                      message:
                        "部分公司的官方 OHLC dependency 失敗並已逐公司隔離；該公司 signals 保持 stock_data_unavailable，其他公司不受阻斷。",
                      refs: {
                        companyCodes: unavailableStockCodes,
                        fields: ["stockDataStatus", "stockDataFailure"],
                        periods: resolvedDates,
                        sourceUrls: data.stockSources.map(
                          (item) => item.sourceUrl,
                        ),
                      },
                    },
                  ]
                : []),
              ...(unverifiedStockSources.length > 0
                ? [
                    {
                      code: "SOURCE_SNAPSHOT_IDENTITY_UNVERIFIED",
                      severity: "warning" as const,
                      scope: "source" as const,
                      message:
                        "部分個股官方 no-data response 未提供 title/date，無法把空回應驗證綁定至 requested month。",
                      refs: {
                        companyCodes: data.companies.map(
                          (company) => company.companyCode,
                        ),
                        fields: [
                          "stockSources.snapshotIdentity",
                          "stockSources.dataMonth",
                        ],
                        periods: resolvedDates,
                        sourceUrls: unverifiedStockSources.map(
                          (item) => item.sourceUrl,
                        ),
                      },
                    },
                  ]
                : []),
              {
                code: "STATELESS_PAGE_VALUES_NOT_PINNED",
                severity: "info",
                scope: "page",
                message: "無狀態 v2 cursor 固定 query、目前 master、benchmark、full-market 公司行動 range contracts/summaries 與整個 requested-company TWSE 權息 detail evidence；各頁個股 OHLC 仍於該頁即時取得，不保證跨頁 point-in-time 一致。",
                refs: {
                  companyCodes: data.companies.map((company) => company.companyCode),
                  fields: ["companies", "stockSources", "corporateActionSources"],
                  periods: resolvedDates,
                  sourceUrls: [
                    ...data.stockSources.map((item) => item.sourceUrl),
                    ...data.corporateActionSources.map((item) => item.sourceUrl),
                  ],
                },
              },
              ...(notComparableCodes.length > 0
                ? [
                    {
                      code: "REACTION_EXCESS_NOT_COMPARABLE",
                      severity: "warning" as const,
                      scope: "value" as const,
                      message: "部分公司因 official actual-result coverage／factor／marker 核對、轉板或 identity 證據不足，不能使用 price-index-compatible excess return。",
                      refs: {
                        companyCodes: notComparableCodes,
                        fields: ["excessReturnPercentagePoints"],
                        periods: resolvedDates,
                        sourceUrls: data.corporateActionSources.map(
                          (item) => item.sourceUrl,
                        ),
                      },
                    },
                  ]
                : []),
            ],
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_company_catalyst_events",
    {
      title: "查詢公司官方催化事件",
      description:
        "查詢 1–20 家台股公司在明確 YYYY-MM-DD 起訖範圍內的官方重大訊息與法人說明會事件；含首尾最多 366 日，且公司×月份×event family 加上 recent snapshot 的 catalyst 查詢工作單位合計上限為 40，retry attempt 不重複計數。工具只以目前上市櫃 master 驗證 current identity、縮小近期重大訊息 snapshot 市場；歷史法說固定查上市與上櫃兩個 TYPEK，以免 current market hint 漏掉轉板前事件，不能把目前 master 冒充歷史母體。若代號不在目前 master 且範圍內也沒有官方事件列，meta.quality.selection=partial，不能宣稱該公司 identity 已驗證。重大訊息使用 MOPS 歷史查詢並在近期範圍以 TWSE／TPEx current OpenAPI 補強，法說會使用 MOPS 歷史日曆；只回官方已發布或已排定證據。publishedAt、factDate、scheduledAt、effectiveAt 分開，confirmed 不等於正面催化；沒有公司財測、分析師 EPS／營收 consensus、預估修正、目標價、情緒或 impact score，也不做買賣建議。合法無事件只在官方空結果可驗證時成立；上游、security block 或 parser failure 會按 company×eventType×month 隔離至 failures，不能當成空值。offset 分頁每頁重新查詢並組裝來源，不是 point-in-time snapshot；續頁必須沿用相同 query，並檢查 fingerprint 與 meta.asOf.snapshotId 是否改變。",
      inputSchema: companyCatalystEventsInputSchema,
      outputSchema: companyCatalystEventsOutputSchema,
      annotations,
    },
    async ({
      company_codes,
      start_date,
      end_date,
      event_types,
      offset,
      limit,
    }) => {
      try {
        let marketHintWarning: string | null = null;
        let marketHintIssueCode:
          | "CATALYST_MARKET_HINT_PARTIAL"
          | "CATALYST_MARKET_HINT_UNAVAILABLE"
          | null = null;
        let marketHintMissingCodes: string[] = [];
        let companyMarkets:
          | Array<{ companyCode: string; market: "listed" | "otc" }>
          | undefined;
        try {
          const master = await companyMasterClient.listCompanies({
            market: "all",
            includeFinancial: true,
            includeKy: true,
          });
          const requestedCodes = new Set(company_codes);
          companyMarkets = master.companies
            .filter((company) => requestedCodes.has(company.code))
            .map((company) => ({
              companyCode: company.code,
              market: company.market,
            }));
          const matchedCodes = new Set(
            companyMarkets.map((company) => company.companyCode),
          );
          marketHintMissingCodes = company_codes.filter(
            (code) => !matchedCodes.has(code),
          );
          if (marketHintMissingCodes.length > 0) {
            marketHintIssueCode = "CATALYST_MARKET_HINT_PARTIAL";
            marketHintWarning = `目前公司 master 找不到 ${marketHintMissingCodes.join(", ")}；近期重大訊息補強會對未匹配代號安全探測兩市場，且目前 master 不會被冒充為歷史 identity。歷史法說無論 hint 都固定查兩市場。`;
          }
        } catch (marketHintError) {
          const normalized = asMopsfinError(marketHintError);
          marketHintIssueCode = "CATALYST_MARKET_HINT_UNAVAILABLE";
          marketHintMissingCodes = [...company_codes];
          marketHintWarning = `目前公司 master identity／近期重大訊息市場提示不可用（${normalized.code}）；current snapshot 會安全探測兩市場。歷史法說無論 hint 都固定查兩市場。`;
        }
        const data = await catalystClient.getCompanyCatalystEvents({
          companyCodes: company_codes,
          startDate: start_date,
          endDate: end_date,
          eventTypes: event_types,
          offset,
          limit,
          ...(companyMarkets && companyMarkets.length > 0
            ? { companyMarkets }
            : {}),
        });
        const outputData = marketHintWarning
          ? { ...data, warnings: [...data.warnings, marketHintWarning] }
          : data;
        const affectedCompanyCodes = [
          ...new Set(data.failures.map((item) => item.companyCode)),
        ];
        const officiallyIdentifiedCodes = new Set(
          data.companies
            .filter((company) => company.eventCount > 0)
            .map((company) => company.companyCode),
        );
        const unverifiedIdentityCodes = marketHintMissingCodes.filter(
          (code) => !officiallyIdentifiedCodes.has(code),
        );
        const sourceUrls = [
          ...new Set(data.sources.map((item) => item.sourceUrl)),
        ];
        const issues: NonNullable<ResultMetaHints["issues"]> = [
          ...(data.failures.length > 0
            ? [
                {
                  code: "CATALYST_COMPANY_FAMILY_FAILED",
                  severity: "warning" as const,
                  scope: "source" as const,
                  message:
                    "部分 company×eventType×month 官方查詢失敗；其他成功事件仍保留，失敗不可解讀為無事件。",
                  refs: {
                    companyCodes: affectedCompanyCodes,
                    fields: ["failures", "familyCoverage", "companies"],
                    periods: [...new Set(data.failures.map((item) => item.queryMonth))],
                    sourceUrls,
                  },
                },
              ]
            : []),
          ...(data.pagination.hasMore || data.pagination.offset > 0
            ? [
                {
                  code: "CATALYST_OFFSET_PAGE_NOT_PINNED",
                  severity: "info" as const,
                  scope: "page" as const,
                  message:
                    "offset 續頁會重新查詢官方來源；不是跨頁 point-in-time snapshot，fingerprint 改變時應由 offset=0 重查。",
                  refs: {
                    companyCodes: data.query.companyCodes,
                    fields: ["pagination", "fingerprint"],
                    periods: [data.query.startDate, data.query.endDate],
                    sourceUrls,
                  },
                },
              ]
            : []),
          {
            code: "OFFICIAL_DISCLOSURE_NOT_CONSENSUS",
            severity: "info" as const,
            scope: "value" as const,
            message:
              "官方公告與公司排定事件不是分析師 consensus，也不代表正面、負面或市場尚未反應。",
            refs: {
              companyCodes: data.query.companyCodes,
              fields: ["isConsensus", "events", "warnings"],
              periods: [data.query.startDate, data.query.endDate],
              sourceUrls,
            },
          },
          ...(marketHintWarning && marketHintIssueCode
            ? [
                {
                  code: marketHintIssueCode,
                  severity: "info" as const,
                  scope: "universe" as const,
                  message: marketHintWarning,
                  refs: {
                    companyCodes: data.query.companyCodes,
                    fields: ["workBudget", "sources[].market"],
                    periods: [data.query.startDate, data.query.endDate],
                    sourceUrls: [],
                  },
                },
              ]
            : []),
          ...(unverifiedIdentityCodes.length > 0
            ? [
                {
                  code: "CATALYST_COMPANY_IDENTITY_UNVERIFIED",
                  severity: "warning" as const,
                  scope: "selection" as const,
                  message:
                    "部分代號不在目前公司 master，且 requested 範圍沒有可確認公司名稱／市場的官方事件列；合法空事件回應不能另外證明公司 identity。",
                  refs: {
                    companyCodes: unverifiedIdentityCodes,
                    fields: ["companies", "events", "meta.quality.selection"],
                    periods: [data.query.startDate, data.query.endDate],
                    sourceUrls,
                  },
                },
              ]
            : []),
        ];
        return success(
          `官方事件查詢完成：${data.counts.requestedCompanies} 家公司、${data.counts.totalEvents} 筆事件，本頁回傳 ${data.counts.returnedEvents} 筆；${data.failures.length} 個月份查詢 failure 已隔離。`,
          outputData,
          {
            selector: "range",
            resolved: {
              granularity: "date",
              from: data.query.startDate,
              through: data.query.endDate,
            },
            page: {
              mode: "offset",
              unit: "row",
              limit: data.pagination.limit,
              returned: data.pagination.returnedRows,
              total: data.pagination.totalRows,
              next:
                data.pagination.nextOffset === null
                  ? null
                  : {
                      kind: "offset",
                      offset: data.pagination.nextOffset,
                    },
            },
            snapshotId: data.fingerprint,
            source: data.coverage.sourceComplete ? "complete" : "partial",
            universe: "not_applicable",
            selection:
              data.companies.length === data.query.companyCodes.length &&
              data.failures.length === 0 &&
              unverifiedIdentityCodes.length === 0
                ? "complete"
                : "partial",
            values: data.failures.length === 0 ? "complete" : "partial",
            freshness: "unknown",
            issues,
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "screen_taiwan_stock_candidates",
    {
      title: "篩選台股研究候選",
      description:
        "以各官方來源當下可取得的 latest 資料，對目前上市櫃非金融公司執行固定 balanced_non_financial_v2 研究分流：先以最新月營收與估值粗篩，再對前 10 家做六個月營收趨勢及七項季度財務深篩，最後依 candidate_limit 對最多 5 家計算 5／20／60 benchmark-session reaction。deep batch 在 24 comparison units 內隔離 metric failure；受影響代號以 company_metrics_unavailable 留在 notReactionScored，其他 deepSelected 公司繼續但不從 top-10 外遞補。v2 第四柱只使用 TWSE／TPEx official actual-result factor 移除股數變動機械斷點後的 price-index-compatible 報酬與 path；現金股利價格效果保留，因此不是 adjusted close、股息再投資或 total return。公司行動 coverage、factor、prior close、marker reconciliation 或 identity 證據不足時第四柱為 unknown，不猜測、不補 0、也不以 raw 報酬判 pass／fail；unknown 也不等於 0。金融業固定排除；四柱皆為 hard gates，overallScore 不可抵銷 fail 或 unknown。只有完成 reaction 的 candidates 才有 bucket，其餘留在 notReactionScored。各來源是 mixed as-of、不是 point-in-time snapshot；本工具只供 research triage，不是投資建議、完整盡調、錯價證明或可直接回測結果。",
      inputSchema: screenTaiwanStockCandidatesInputSchema,
      outputSchema: screenTaiwanStockCandidatesOutputSchema,
      annotations,
    },
    async ({
      market,
      company_codes,
      include_ky,
      candidate_limit,
      preset,
    }) => {
      try {
        const data = await taiwanStockScreenClient.screenTaiwanStockCandidates({
          market,
          ...(company_codes ? { companyCodes: company_codes } : {}),
          includeKy: include_ky,
          candidateLimit: candidate_limit,
          preset,
        });
        const snapshotId = fingerprint({
          query: data.query,
          asOf: data.asOf,
          funnel: data.funnel,
          candidates: data.candidates,
          sources: data.sources,
        });
        const incompleteDependencies = data.dependencyStatus.filter(
          (item) => item.status === "partial" || item.status === "failed",
        );
        const dependencyIssues: NonNullable<ResultMetaHints["issues"]> =
          incompleteDependencies.map((item) => ({
            code:
              item.status === "failed"
                ? "SCREEN_DEPENDENCY_FAILED"
                : "SCREEN_DEPENDENCY_PARTIAL",
            severity: "warning",
            scope: "source",
            message: `${item.stage}/${item.dependency}: ${item.message ?? "dependency 未完整完成。"}`,
            refs: {
              companyCodes: item.affectedCompanyCodes,
              fields: ["dependencyStatus", "coverage"],
              periods: [],
              sourceUrls: data.sources.map((item) => item.sourceUrl),
            },
          }));
        return success(
          `台股 latest-only 篩選完成：粗篩 ${data.funnel.coarseEligible} 家、深篩 ${data.funnel.deepSelected} 家、reaction ${data.funnel.reactionScored} 家；回傳 ${data.funnel.returned} 家四柱評估結果，其中 research_candidate ${data.funnel.buckets.research_candidate} 家。`,
          data,
          {
            selector: "latest",
            resolved: {
              granularity: "mixed",
              from: null,
              through: null,
            },
            page: {
              mode: "none",
              unit: "none",
              limit: null,
              returned: null,
              total: null,
              next: null,
            },
            snapshotId,
            source: data.coverage.sourceComplete ? "complete" : "partial",
            universe: "unverified",
            selection: data.coverage.selectionComplete ? "complete" : "partial",
            values:
              data.coverage.deepEvidenceComplete &&
              data.coverage.reactionEvidenceComplete
                ? "complete"
                : "partial",
            freshness: "unknown",
            issues: [
              {
                code: "MASTER_ROWSET_HEURISTIC",
                severity: "warning",
                scope: "universe",
                message:
                  "目前公司母體通過必要來源與 heuristic gate，但官方沒有 declared row count，不能證明完整 rowset。",
                refs: {
                  companyCodes: data.query.companyCodes ?? [],
                  fields: ["funnel.currentMaster", "coverage.selectionComplete"],
                  periods: data.asOf.masterReportDates,
                  sourceUrls: data.sources
                    .filter((item) => item.kind === "company_master")
                    .map((item) => item.sourceUrl),
                },
              },
              {
                code: "SCREEN_MIXED_AS_OF",
                severity: "info",
                scope: "period",
                message:
                  "公司母體、月營收、估值、季度財報與 reaction 日期不同，不是單一 point-in-time snapshot。",
                refs: {
                  companyCodes: data.candidates.map((item) => item.companyCode),
                  fields: ["asOf", "candidates[].asOf", "sources"],
                  periods: [
                    ...data.asOf.masterReportDates,
                    data.asOf.revenueMonth,
                    data.asOf.valuationDate,
                    ...data.asOf.financialThroughPeriods,
                    ...data.asOf.reactionDates.map((item) => item.date),
                  ],
                  sourceUrls: data.sources.map((item) => item.sourceUrl),
                },
              },
              {
                code: "BOUNDED_SCREEN_FUNNEL",
                severity: "info",
                scope: "selection",
                message:
                  "coarse 後只對前 10 家做 deep，並只對 candidate_limit（最多 5 家）做 reaction；未評估公司另列摘要，不等於負面判定。",
                refs: {
                  companyCodes: [
                    ...data.notDeepScored,
                    ...data.notReactionScored,
                  ].map((item) => item.companyCode),
                  fields: [
                    "workBudget.deepCompanyLimit",
                    "workBudget.reactionCompanyLimit",
                    "notDeepScored",
                    "notReactionScored",
                  ],
                  periods: [],
                  sourceUrls: [],
                },
              },
              {
                code: "CORPORATE_ACTION_AWARE_REACTION_PROXY",
                severity: "info",
                scope: "value",
                message:
                  "第四柱只使用 official actual-result 證據完整的 price-index-compatible 個股報酬；現金股利價格效果保留，仍不是 adjusted close、total shareholder return 或錯價證明。",
                refs: {
                  companyCodes: data.candidates.map((item) => item.companyCode),
                  fields: [
                    "pillars.marketUnderreactionProxy",
                    "overallScore",
                  ],
                  periods: data.asOf.reactionDates.map((item) => item.date),
                  sourceUrls: data.sources
                    .filter(
                      (item) =>
                        item.kind === "reaction_benchmark" ||
                        item.kind === "reaction_stock" ||
                        item.kind === "reaction_corporate_action",
                    )
                    .map((item) => item.sourceUrl),
                },
              },
              ...dependencyIssues,
            ],
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_daily_market_valuation",
    {
      title: "查詢台股市場單日估值",
      description:
        "查詢 TWSE／TPEx 官方 latest 或指定 YYYY-MM-DD 的上市、上櫃或全部公司本益比、股價淨值比、殖利率，以及來源可提供的收盤價、每股股利、股利年度與估值參考財報期。指定日採 exact-date，假日不退回前一交易日；上市自 2005-09-02、上櫃與 market=all 自 2007-01-02。latest 預設 universe_policy=compatible 並揭露 reconciliation；strict_current_master 只允許 latest。歷史日採 historical_code_rule，不用今天 master 冒充歷史母體。company_codes 最多 500 家，省略 page_size/cursor 維持完整回傳，提供 page_size 才分頁。核心 PE／PB／殖利率 key 若從 eligible row 消失會視為上游 schema drift 並報錯；官方空白、N/A、不具意義或補強來源未提供的欄位則回 null、valueStatus 與 rawValue，不重算財報分母或股利。回答前應檢查 meta.asOf、meta.quality 與 meta.page。",
      inputSchema: dailyMarketValuationInputSchema,
      outputSchema: dailyMarketValuationOutputSchema,
      annotations,
    },
    async ({ market, date, company_codes, universe_policy, page_size, cursor }) => {
      try {
        const data = await valuationClient.getDailyMarketValuation({
          market,
          date,
          universePolicy: universe_policy,
          ...(company_codes ? { companyCodes: company_codes } : {}),
        });
        const snapshotId = fingerprint({
          dataDate: data.dataDate,
          sources: data.sources.map((item) => ({
            market: item.market,
            sourceUrl: item.sourceUrl,
            dataDate: item.dataDate,
            rawCount: item.rawCount,
            eligibleRowCount: item.eligibleRowCount,
          })),
          rows: data.rows,
        });
        const paginated = paginateByCompany({
          tool: "get_daily_market_valuation",
          query: {
            market,
            date,
            company_codes: company_codes ? [...company_codes].sort() : undefined,
            universe_policy,
          },
          snapshotId,
          items: data.rows,
          pageSize: page_size,
          cursor,
          maximumPageSize: 500,
          legacyUnpaged: true,
        });
        const pageRows = paginated.items;
        const valuesComplete = pageRows.every((row) =>
          Object.values(row.valueStatus).every(
            (status) => status !== "invalid_upstream",
          ),
        );
        const pageData = paginated.page.mode === "none"
          ? data
          : {
              ...data,
              rows: pageRows,
              counts: {
                ...data.counts,
                returned: pageRows.length,
                withPe: pageRows.filter((row) => row.valueStatus.peRatio === "reported").length,
                withPb: pageRows.filter((row) => row.valueStatus.priceToBookRatio === "reported").length,
                withDividendYield: pageRows.filter((row) => row.valueStatus.dividendYieldPercent === "reported").length,
                withClosePrice: pageRows.filter((row) => row.valueStatus.closePriceTwd === "reported").length,
                withDividendPerShare: pageRows.filter((row) => row.valueStatus.dividendPerShareTwd === "reported").length,
                withDividendFiscalYear: pageRows.filter((row) => row.valueStatus.dividendFiscalYear === "reported").length,
                withReferenceFiscalPeriod: pageRows.filter((row) => row.valueStatus.referenceFiscalPeriod === "reported").length,
              },
            };
        return success(
          `${pageData.dataDate} ${market} 市場：本頁回傳 ${pageData.counts.returned} 家公司估值，universeCoverageVerified=${pageData.universeCoverageVerified}、selectionComplete=${pageData.selectionComplete}。`,
          pageData,
          {
            page: paginated.page,
            snapshotId,
            values: valuesComplete ? "complete" : "partial",
            freshness: date === "latest" ? "within_expected_window" : "not_applicable",
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_monthly_revenue",
    {
      title: "查詢台股單月營收",
      description:
        "查詢上市、上櫃或全部公司在 latest 或 2013-01 起指定 YYYY-MM 的官方單月營收、月增率、年增率與累計營收年增率。latest 以 TWSE／TPEx OpenAPI 發現月份，再與同月或前一月 MOPS archive 核對共同有效月份；若同月不同出表日僅少量重疊公司數值不同，視為官方修訂、採較新 snapshot 並 warning，同出表日或大範圍衝突則報錯。explicit month 採 exact archive，不退回其他月份。歷史 archive 是目前可取得的修訂後檔案，不是 point-in-time vintage，current master 的 industryCode／reconciliation 只能輔助，應以該月 sourceIndustryName 辨識歷史產業。官方金額原始單位為仟元，本工具固定乘以 1,000 輸出 TWD；每欄 valueStatus 區分 reported、missing、invalid_upstream，null 不可當 0。latest 省略 universe_policy 時使用 strict_current_master，歷史月份使用 compatible 且不允許 strict。coverageComplete 是相容欄位：latest 成功完成必要來源、格式與 snapshot identity 核對時為 true，歷史 archive 因無 declared row count 固定為 false；另以 sourceCoverage 說明 rowset 是否能由目前 master 核對，filingCoverage 則只讓 latest 輔助判讀申報進度，歷史值固定是跨時點不可驗證。company_codes 最多 500 家，sourceReportDate 是資料集出表日，不是個別公司 filedAt；省略 page_size/cursor 維持完整回傳。",
      inputSchema: monthlyRevenueInputSchema,
      outputSchema: monthlyRevenueOutputSchema,
      annotations,
    },
    async ({ market, data_month, company_codes, universe_policy, page_size, cursor }) => {
      try {
        const resolvedUniversePolicy =
          universe_policy ??
          (data_month === "latest" ? "strict_current_master" : "compatible");
        const data = await monthlyRevenueClient.getMonthlyRevenue({
          market,
          dataMonth: data_month,
          universePolicy: resolvedUniversePolicy,
          ...(company_codes ? { companyCodes: company_codes } : {}),
        });
        const snapshotId = fingerprint({
          dataMonth: data.dataMonth,
          sources: data.sources.map((item) => ({
            market: item.market,
            sourceUrl: item.sourceUrl,
            dataMonth: item.dataMonth,
            sourceReportDate: item.sourceReportDate,
            rawCount: item.rawCount,
            eligibleRowCount: item.eligibleRowCount,
          })),
          rows: data.rows,
        });
        const paginated = paginateByCompany({
          tool: "get_monthly_revenue",
          query: {
            market,
            data_month,
            company_codes: company_codes ? [...company_codes].sort() : undefined,
            universe_policy: resolvedUniversePolicy,
          },
          snapshotId,
          items: data.rows,
          pageSize: page_size,
          cursor,
          maximumPageSize: 500,
          legacyUnpaged: true,
        });
        const pageRows = paginated.items;
        const valuesComplete = pageRows.every((row) =>
          Object.values(row.valueStatus).every(
            (status) => status !== "invalid_upstream",
          ),
        );
        const pageData = paginated.page.mode === "none"
          ? data
          : {
              ...data,
              rows: pageRows,
              counts: {
                listed: pageRows.filter((row) => row.market === "listed").length,
                otc: pageRows.filter((row) => row.market === "otc").length,
                returned: pageRows.length,
              },
            };
        return success(
          `${pageData.dataMonth} ${market} 市場：本頁回傳 ${pageData.counts.returned} 家公司月營收，申報覆蓋 ${pageData.filingCoverage.reportedCompanyCount}/${pageData.filingCoverage.expectedCompanyCount}、selectionComplete=${pageData.selectionComplete}。`,
          pageData,
          {
            selector: data_month === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "month",
              from: pageData.dataMonth,
              through: pageData.dataMonth,
            },
            page: paginated.page,
            snapshotId,
            source: data.sourceCoverage.complete ? "complete" : "partial",
            universe:
              data_month !== "latest"
                ? "unverified"
                : data.reconciliation.every((item) => item.coverageComplete)
                  ? "verified"
                  : "compatible",
            selection: data.selectionComplete ? "complete" : "partial",
            values: valuesComplete ? "complete" : "partial",
            freshness: data_month === "latest" ? "within_expected_window" : "not_applicable",
            issues: [
              ...(!data.sourceCoverage.complete
                ? [
                    {
                      code: "SOURCE_ROWSET_UNVERIFIED",
                      severity: "warning" as const,
                      scope: "source" as const,
                      message: "官方月營收來源沒有 declared row count，且本次 rowset 未能以目前 master 完全核對。",
                      refs: {
                        companyCodes: [],
                        fields: ["sourceCoverage", "sources.integrity"],
                        periods: [pageData.dataMonth],
                        sourceUrls: data.sources.map((item) => item.sourceUrl),
                      },
                    },
                  ]
                : []),
              ...(!data.filingCoverage.complete
                ? [
                    {
                    code: "FILING_COVERAGE_PARTIAL",
                    severity: "info" as const,
                    scope: "period" as const,
                    message:
                      data_month === "latest"
                        ? "目前 master 尚有公司未出現在 latest 月營收資料；可能仍在申報窗口或不適用。"
                        : "歷史月份與目前 master 不同時點，filingCoverage 不代表當時漏申報。",
                    refs: {
                      companyCodes: data.filingCoverage.missingCompanyCodes,
                      fields: ["filingCoverage"],
                      periods: [pageData.dataMonth],
                      sourceUrls: data.sources.map((item) => item.sourceUrl),
                    },
                    },
                  ]
                : []),
            ],
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_monthly_revenue_trend",
    {
      title: "查詢台股歷史月營收趨勢",
      description:
        "查詢 1–100 家上市櫃公司、連續 3–24 個月的官方月營收序列，支援 latest 或 2013-01 起 exact YYYY-MM 終點。每個月份保留當月營收、去年同月營收、官方 MoM／YoY、公司 name／market、sourceIndustryName、sourceReportDate 與逐欄 valueStatus；缺月明確回 null，不補值。每家公司另提供可由 points 重算的最新 YoY、rolling 3／6 月營收 YoY、相較三個月前 YoY 加速度、正 YoY 月數、已申報 YoY 月數與連續正 YoY 月數；若相鄰有資料月份觀察到名稱或市場轉換，comparability=needs_review，所有 derived 回 null，避免把改名、轉板或代號重用直接串成同一公司。歷史 archive 是目前可取得的修訂後檔案，不是 point-in-time vintage，且無 declared row count，所以 coverageComplete=false、sourceCoverage=unverified；industryCode 是目前 master 輔助欄位，歷史產業應讀 sourceIndustryName。每頁最多 20 家且保留 caller 公司順序，不拆散單一公司的完整月份視窗；這些透明趨勢不是主觀基本面改善分數，回答前應檢查 comparability、公式、缺月、meta.quality 與 meta.page。",
      inputSchema: monthlyRevenueTrendInputSchema,
      outputSchema: monthlyRevenueTrendOutputSchema,
      annotations,
    },
    async ({ market, company_codes, end_month, lookback_months, universe_policy, page_size, cursor }) => {
      try {
        const companyCodes = [...company_codes];
        const data = await monthlyRevenueClient.getMonthlyRevenueTrend({
          market,
          companyCodes,
          endMonth: end_month,
          lookbackMonths: lookback_months,
          universePolicy: universe_policy,
        });
        const snapshotId = fingerprint({
          startMonth: data.startMonth,
          endMonth: data.endMonth,
          sources: data.sources.map((item) => ({
            market: item.market,
            sourceUrl: item.sourceUrl,
            dataMonth: item.dataMonth,
            sourceReportDate: item.sourceReportDate,
            rawCount: item.rawCount,
            eligibleRowCount: item.eligibleRowCount,
          })),
          companies: data.companies,
        });
        const paginated = paginateByCompany({
          tool: "get_monthly_revenue_trend",
          query: {
            market,
            company_codes: companyCodes,
            end_month,
            lookback_months,
            universe_policy,
          },
          snapshotId,
          items: data.companies,
          pageSize: page_size,
          cursor,
          maximumPageSize: 20,
        });
        const pageCompanies = paginated.items;
        const valuesComplete = pageCompanies.every(
          (company) =>
            company.comparability.status === "comparable" &&
            company.missingMonths.length === 0 &&
            company.points.every((point) =>
              Object.values(point.valueStatus).every(
                (status) => status !== "invalid_upstream",
              ),
            ),
        );
        const pageData = {
          ...data,
          companies: pageCompanies,
          counts: {
            ...data.counts,
            returnedCompanies: pageCompanies.length,
          },
        };
        return success(
          `${pageData.startMonth} 至 ${pageData.endMonth}：本頁回傳 ${pageCompanies.length} 家公司的 ${pageData.counts.requestedMonths} 個月營收趨勢。`,
          pageData,
          {
            selector: end_month === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "month",
              from: pageData.startMonth,
              through: pageData.endMonth,
            },
            page: paginated.page,
            snapshotId,
            source: data.sourceCoverage.complete ? "complete" : "partial",
            universe: "unverified",
            selection: data.selectionComplete ? "complete" : "partial",
            values: valuesComplete ? "complete" : "partial",
            freshness: end_month === "latest" ? "within_expected_window" : "not_applicable",
            issues: [
              {
                code: "SOURCE_ROWSET_UNVERIFIED",
                severity: "warning",
                scope: "source",
                message: "歷史 MOPS archive 沒有 declared row count、footer 或 checksum；格式與 snapshot identity 可驗證，但完整 rowset 不可證明。",
                refs: {
                  companyCodes: pageCompanies.map((company) => company.code),
                  fields: ["sourceCoverage", "sources.integrity"],
                  periods: [pageData.startMonth, pageData.endMonth],
                  sourceUrls: data.sources.map((item) => item.sourceUrl),
                },
              },
              ...pageCompanies
                .filter((company) => company.comparability.status === "needs_review")
                .map((company) => ({
                  code: "REVENUE_IDENTITY_TRANSITION",
                  severity: "warning" as const,
                  scope: "value" as const,
                  message: "公司代號在 requested 視窗觀察到名稱或市場轉換；derived 已停用並等待 identity 核對。",
                  refs: {
                    companyCodes: [company.code],
                    fields: ["comparability", "derived"],
                    periods: company.comparability.transitions.map(
                      (transition) => transition.dataMonth,
                    ),
                    sourceUrls: [],
                  },
                })),
            ],
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_companies",
    {
      title: "列出上市櫃公司目前母體",
      description:
        "從 TWSE 上市公司基本資料與 TPEx 上櫃股票基本資料官方 OpenAPI 建立可供財務與市場工具使用的目前公司母體。market=listed 只回上市公司且包含創新板，market=otc 只回上櫃公司，market=all 同時取得兩市場；任何必要來源失敗、同一來源出表日期不一致或筆數低於安全門檻時整體報錯。官方來源沒有 declared row count，因此 coverageVerification.status=heuristic；coverageComplete=true 僅代表必要來源、schema、單一出表日期、唯一代號與最低筆數 gate 通過，不可宣稱官方完整 rowset。來源不包含 ETF、ETN、權證或特別股，上市 TDR 固定排除；include_financial 與 include_ky 可排除金融保險業或 KY 公司。公司列另提供成立日期、實收資本額 TWD、已發行普通股數、面額原文、財報類型 raw code 與逐欄 profileValueStatus；這些是目前 snapshot，不可當歷史股數或直接推算歷史市值。省略 page_size/cursor 時維持整個本次 accepted snapshot 的 companies 回傳；提供 page_size 後以內容快照綁定 cursor。頂層 snapshotId 只是 market＋reportDate 的來源日期標籤，meta.asOf.snapshotId 才是 cursor 使用的內容 fingerprint；meta.asOf.resolved 取自官方 reportDate，不使用 generatedAt 冒充資料日期。各市場出表日期、來源／排除筆數、minimumExpectedCount、profileCoverage、coverageVerification 與 warnings 都是答案的一部分；公司存在於母體不保證每個財務指標或期別有資料。",
      inputSchema: listCompaniesInputSchema,
      outputSchema: listCompaniesOutputSchema,
      annotations,
    },
    async ({ market, include_financial, include_ky, page_size, cursor }) => {
      try {
        const data = await companyMasterClient.listCompanies({
          market,
          includeFinancial: include_financial,
          includeKy: include_ky,
        });
        const snapshotId = fingerprint({
          masterSnapshotId: data.snapshotId,
          companies: data.companies,
          profileCoverage: data.profileCoverage,
        });
        const paginated = paginateByCompany({
          tool: "list_companies",
          query: { market, include_financial, include_ky },
          snapshotId,
          items: data.companies,
          pageSize: page_size,
          cursor,
          maximumPageSize: 500,
          legacyUnpaged: true,
        });
        const pageCompanies = paginated.items;
        const pageData = paginated.page.mode === "none"
          ? data
          : {
              ...data,
              companies: pageCompanies,
              counts: {
                ...data.counts,
                listed: pageCompanies.filter((company) => company.market === "listed").length,
                otc: pageCompanies.filter((company) => company.market === "otc").length,
                returned: pageCompanies.length,
              },
            };
        const marketLabel =
          market === "listed" ? "上市" : market === "otc" ? "上櫃" : "上市及上櫃";
        return success(
          `${marketLabel}公司母體本頁 ${pageData.counts.returned} 家（上市 ${pageData.counts.listed}、上櫃 ${pageData.counts.otc}）；已通過 heuristic coverage gate，但官方未提供 declared row count。`,
          pageData,
          {
            selector: "snapshot",
            resolved: {
              granularity: "date",
              from:
                data.sources
                  .map((item) => item.reportDate)
                  .sort()[0] ?? null,
              through:
                data.sources
                  .map((item) => item.reportDate)
                  .sort()
                  .at(-1) ?? null,
            },
            page: paginated.page,
            snapshotId,
            universe: "unverified",
            issues: [
              {
                code: "MASTER_ROWSET_HEURISTIC",
                severity: "warning",
                scope: "universe",
                message:
                  "官方公司基本資料來源沒有 declared row count；本次只通過必要來源、schema、單一出表日期、唯一代號與最低筆數 heuristic gate，不能證明完整 rowset。",
                refs: {
                  companyCodes: [],
                  fields: ["coverageVerification", "coverageComplete", "sources.minimumExpectedCount"],
                  periods: data.sources.map((item) => item.reportDate),
                  sourceUrls: data.sources.map((item) => item.sourceUrl),
                },
              },
            ],
          },
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
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
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
            issues: qualityIssues,
          },
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
          {
            selector: input.period === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "quarter",
              from: data.period,
              through: data.period,
            },
          },
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
          {
            selector: input.period === "latest" ? "latest" : "explicit",
            resolved: {
              granularity: "quarter",
              from: data.period,
              through: data.period,
            },
          },
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
          },
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
          {
            selector: "range",
            resolved: resolvedQuarterRange(data.periods),
            values: data.series.some((series) =>
              series.points.some((point) => point.valueStatus === "invalid_upstream"),
            )
              ? "partial"
              : "complete",
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
