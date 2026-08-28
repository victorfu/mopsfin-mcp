import { defineTool } from "./definition";
import {
  MOPSFIN_SOURCE_URL,
  FRESHNESS_POLICIES,
  annotations,
  companyMasterClient,
  evaluateFreshness,
  failure,
  findCompaniesInputSchema,
  findCompaniesOutputSchema,
  fingerprint,
  listCompaniesInputSchema,
  listCompaniesOutputSchema,
  mopsfinClient,
  paginateByCompany,
  source,
  success,
  taipeiDate,
} from "./shared";

export const findCompaniesTool = defineTool(
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
        const result = await mopsfinClient.findCompaniesWithSource(query, limit);
        const companies = result.companies;
        const data = {
          ...source("/suggestCompany", result.retrievedAt, result.cache),
          query: { query, limit },
          companies,
          warnings:
            companies.length === 0
              ? ["找不到符合的公司；可縮短名稱或改用公司代號。"]
              : [],
        };
        return success(`找到 ${companies.length} 家符合「${query}」的公司。`, data, {
          freshnessDetails: [
            evaluateFreshness({
              policy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
              observedAsOf: null,
              expectedAsOf: null,
              sourceUrls: [MOPSFIN_SOURCE_URL],
            }),
          ],
        });
      } catch (error) {
        return failure(error);
      }
    },
);

export const listCompaniesTool = defineTool(
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
            freshnessDetails: data.sources.map((item) =>
              evaluateFreshness({
                policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
                observedAsOf: item.reportDate,
                expectedAsOf: taipeiDate(data.generatedAt),
                sourceUrls: [item.sourceUrl],
              }),
            ),
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

export const companiesTools = [
  findCompaniesTool,
  listCompaniesTool,
] as const;
