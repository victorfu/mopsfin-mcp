import { defineTool } from "./definition";
import {
  FRESHNESS_POLICIES,
  annotations,
  failure,
  fingerprint,
  monthlyRevenueClient,
  monthlyRevenueInputSchema,
  monthlyRevenueOutputSchema,
  monthlyRevenueTrendInputSchema,
  monthlyRevenueTrendOutputSchema,
  paginateByCompany,
  selectorFreshness,
  success,
} from "./shared";

export const getMonthlyRevenueTool = defineTool(
    "get_monthly_revenue",
    {
      title: "查詢台股單月營收",
      description:
        "查詢上市、上櫃或全部公司在 latest 或 2013-01 起指定 YYYY-MM 的官方單月營收、月增率、年增率與累計營收年增率。latest 以 TWSE／TPEx OpenAPI 發現月份，再與同月或前一月 MOPS archive 核對共同有效月份；若同月不同出表日僅少量重疊公司數值不同，視為官方修訂、採較新 snapshot 並 warning，同出表日或大範圍衝突則報錯。meta freshness 的 within_expected_window 只證明本次 selected month 等於兩市場協調出的 latest common official month，不代表每家公司已完成法定申報；仍須讀 filingCoverage。explicit month 採 exact archive，不退回其他月份。歷史 archive 是目前可取得的修訂後檔案，不是 point-in-time vintage，current master 的 industryCode／reconciliation 只能輔助，應以該月 sourceIndustryName 辨識歷史產業。官方金額原始單位為仟元，本工具固定乘以 1,000 輸出 TWD；每欄 valueStatus 區分 reported、missing、invalid_upstream，null 不可當 0。latest 省略 universe_policy 時使用 strict_current_master，歷史月份使用 compatible 且不允許 strict。coverageComplete 是相容欄位：latest 成功完成必要來源、格式與 snapshot identity 核對時為 true，歷史 archive 因無 declared row count 固定為 false；另以 sourceCoverage 說明 rowset 是否能由目前 master 核對，filingCoverage 則只讓 latest 輔助判讀申報進度，歷史值固定是跨時點不可驗證。company_codes 最多 500 家，sourceReportDate 是資料集出表日，不是個別公司 filedAt；省略 page_size/cursor 維持完整回傳。",
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
            freshnessDetails: selectorFreshness({
              selector: data_month === "latest" ? "latest" : "explicit",
              observedAsOf: pageData.dataMonth,
              expectedAsOf:
                data_month === "latest" ? pageData.dataMonth : null,
              latestPolicy: FRESHNESS_POLICIES.monthlyRevenueLatestCommon,
              sources: pageData.sources,
            }),
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

export const getMonthlyRevenueTrendTool = defineTool(
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
            freshnessDetails: selectorFreshness({
              selector: end_month === "latest" ? "latest" : "explicit",
              observedAsOf: pageData.endMonth,
              expectedAsOf:
                end_month === "latest" ? pageData.endMonth : null,
              latestPolicy: FRESHNESS_POLICIES.monthlyRevenueLatestCommon,
              sources: pageData.sources,
            }),
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

export const revenueTools = [
  getMonthlyRevenueTool,
  getMonthlyRevenueTrendTool,
] as const;
