import { defineTool } from "./definition";
import {
  annotations,
  dailyMarketOhlcInputSchema,
  dailyMarketOhlcOutputSchema,
  dailyMarketValuationInputSchema,
  dailyMarketValuationOutputSchema,
  failure,
  fingerprint,
  paginateByCompany,
  priceClient,
  reactionClient,
  selectorFreshness,
  stockOhlcInputSchema,
  stockOhlcOutputSchema,
  stockReactionSignalsInputSchema,
  stockReactionSignalsOutputSchema,
  success,
  valuationClient,
} from "./shared";

export const getStockOhlcTool = defineTool(
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
            freshnessDetails: selectorFreshness({
              selector: "range",
              observedAsOf: data.coverage.coveredThrough,
              sources: data.sources,
            }),
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

export const getDailyMarketOhlcTool = defineTool(
    "get_daily_market_ohlc",
    {
      title: "查詢單日台股市場 OHLC",
      description:
        "查詢最近完成交易日或指定 YYYY-MM-DD 的上市、上櫃或全部公司股票官方原始 OHLC、成交量（股）、成交金額（TWD）、成交筆數與漲跌價差。market=all 要求 TWSE／TPEx 資料日期一致；latest 不是盤中即時價，指定假日或未來日期不會靜默退回前一日。latest 只是 selector；目前沒有權威交易日 resolver 可獨立算 expectedAsOf，因此 meta freshness 保守為 unknown/FRESHNESS_UNVERIFIED，不因成功取得一個日期就自動宣稱 fresh。company_codes 可選且最多 500 家；部分缺失以 selectionComplete=false 揭露。latest 預設 universe_policy=compatible，會保留四碼公司代號 fallback 並回傳 reconciliation，但各市場與目前 master 的 matchRatio 低於 95% 仍回 INCOMPLETE_COVERAGE；strict_current_master 僅支援 latest 且要求完全吻合。歷史日期只使用可解釋但未經目前母體驗證的代號規則。價格為 TWD、Asia/Taipei、1d、raw_unadjusted；qualityStatus、missingFields、dataQualityComplete 與單位 normalization 不可忽略。",
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
            freshnessDetails: selectorFreshness({
              selector: date === "latest" ? "latest" : "explicit",
              observedAsOf: pageData.dataDate,
              sources: pageData.sources,
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const getStockReactionSignalsTool = defineTool(
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
            freshnessDetails: selectorFreshness({
              selector: as_of === "latest" ? "latest" : "explicit",
              observedAsOf:
                resolvedDates.length === 1 ? resolvedDates[0] ?? null : null,
              sources: [
                ...data.benchmarkSources,
                ...data.stockSources,
                ...data.corporateActionSources,
              ],
            }),
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

export const getDailyMarketValuationTool = defineTool(
    "get_daily_market_valuation",
    {
      title: "查詢台股市場單日估值",
      description:
        "查詢 TWSE／TPEx 官方 latest 或指定 YYYY-MM-DD 的上市、上櫃或全部公司本益比、股價淨值比、殖利率，以及來源可提供的收盤價、每股股利、股利年度與估值參考財報期。指定日採 exact-date，假日不退回前一交易日；上市自 2005-09-02、上櫃與 market=all 自 2007-01-02。latest 只是 selector；目前沒有權威交易日 resolver 可獨立算 expectedAsOf，因此 meta freshness 保守為 unknown/FRESHNESS_UNVERIFIED。latest 預設 universe_policy=compatible 並揭露 reconciliation；strict_current_master 只允許 latest。歷史日採 historical_code_rule，不用今天 master 冒充歷史母體。company_codes 最多 500 家，省略 page_size/cursor 維持完整回傳，提供 page_size 才分頁。核心 PE／PB／殖利率 key 若從 eligible row 消失會視為上游 schema drift 並報錯；官方空白、N/A、不具意義或補強來源未提供的欄位則回 null、valueStatus 與 rawValue，不重算財報分母或股利。回答前應檢查 meta.asOf、meta.quality 與 meta.page。",
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
            freshnessDetails: selectorFreshness({
              selector: date === "latest" ? "latest" : "explicit",
              observedAsOf: pageData.dataDate,
              sources: pageData.sources,
            }),
          },
        );
      } catch (error) {
        return failure(error);
      }
    },
);

export const marketTools = [
  getStockOhlcTool,
  getDailyMarketOhlcTool,
  getStockReactionSignalsTool,
  getDailyMarketValuationTool,
] as const;
