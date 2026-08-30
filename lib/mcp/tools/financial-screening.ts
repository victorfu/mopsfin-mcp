import { taiwanFinancialScreenClient } from "@/lib/financial-screening/client";
import {
  screenTaiwanFinancialCandidatesInputSchema,
  screenTaiwanFinancialCandidatesOutputSchema,
} from "@/lib/mcp/schema/financial-screening";

import { defineTool } from "./definition";
import {
  FRESHNESS_POLICIES,
  annotations,
  evaluateFreshness,
  fingerprint,
  success,
} from "./shared";

export const screenTaiwanFinancialCandidatesTool = defineTool(
  "screen_taiwan_financial_candidates",
  {
    title: "篩選台灣金融股研究候選",
    description:
      "以各官方來源當下可取得的 latest 資料執行固定 balanced_financial_v1 研究分流。只接受目前上市櫃產業代號 17 中，股票四碼代號與 Mopsfin financial institution catalog 唯一 exact-code 對應、名稱 identity 一致且 subtype 為 holding、bank 或 bills 的公司；unmapped、duplicate、identity mismatch、保險、證券或 unknown subtype 明示排除，不 fuzzy mapping。粗篩以 latest 月營收／淨收益 proxy 與 P/B-led 估值排序，前 10 家才做金融 deep，最多 5 家查 5／20／60 日 reaction。金融品質依 subtype 使用年度 ROE、TTM 稅後淨利、相應資本適足率，銀行另使用逾放比與備抵覆蓋率；公司值採同 metric 同一期 Mopsfin 業別平均及 exact YoY research rules，不宣稱法定門檻。資本適足只按 expected Q2／Q4，Q1／Q3 缺值不補 0。估值只用同 subtype peers，P/B 與 ROE-adjusted P/B 是 primary，PE／殖利率不能補償缺證。NO_DATA、只有產業平均或 institution series 缺失均為 unknown/null。overallScore 只供 balanced_financial_v1 模型內排序，cross-model 不得和 balanced_non_financial_v2 raw score 比較。本工具是 bounded research triage，不是完整金融母體深篩、point-in-time 回測、法定資本判定或錯價證明，也不是投資建議。",
    inputSchema: screenTaiwanFinancialCandidatesInputSchema,
    outputSchema: screenTaiwanFinancialCandidatesOutputSchema,
    annotations,
  },
  async ({
    market,
    company_codes,
    include_ky,
    candidate_limit,
    preset,
  }) => {
    const data = await taiwanFinancialScreenClient.screenTaiwanFinancialCandidates({
      market,
      ...(company_codes ? { companyCodes: company_codes } : {}),
      includeKy: include_ky,
      candidateLimit: candidate_limit,
      preset,
    });
    const snapshotId = fingerprint({
      query: data.query,
      screenDefinition: data.screenDefinition,
      asOf: data.asOf,
      funnel: data.funnel,
      mappingCoverage: data.mappingCoverage,
      candidates: data.candidates,
      sources: data.sources,
    });
    const incompleteDependencies = data.dependencyStatus.filter(
      (item) => item.status === "partial" || item.status === "failed",
    );
    return success(
      `金融股 latest-only 篩選完成：mapped ${data.funnel.mappedSupported} 家、粗篩 ${data.funnel.coarseEligible} 家、deep ${data.funnel.deepSelected} 家、reaction ${data.funnel.reactionScored} 家；回傳 ${data.funnel.returned} 家，其中 research_candidate ${data.funnel.buckets.research_candidate} 家。`,
      data,
      {
        selector: "latest",
        resolved: { granularity: "mixed", from: null, through: null },
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
        freshnessDetails: [
          evaluateFreshness({
            policy: FRESHNESS_POLICIES.unspecified,
            observedAsOf: null,
            expectedAsOf: null,
            sourceUrls: data.sources.map((source) => source.sourceUrl),
          }),
        ],
        issues: [
          {
            code: "MASTER_ROWSET_HEURISTIC",
            severity: "warning",
            scope: "universe",
            message:
              "目前上市櫃公司母體只通過 heuristic gate；官方沒有 declared row count，不能證明完整 rowset。",
            refs: {
              companyCodes: data.query.companyCodes ?? [],
              fields: ["funnel.currentMaster", "coverage"],
              periods: data.asOf.masterReportDates,
              sourceUrls: data.sources
                .filter((source) => source.kind === "company_master")
                .map((source) => source.sourceUrl),
            },
          },
          ...(!data.coverage.mappingComplete
            ? [{
                code: "FINANCIAL_MAPPING_PARTIAL",
                severity: "warning" as const,
                scope: "selection" as const,
                message:
                  "部分金融股無法 exact-code 唯一對應到 supported institution subtype；未模糊配對或當成負面評分。",
                refs: {
                  companyCodes: data.mappingCoverage.mappings
                    .filter((mapping) => mapping.status !== "mapped")
                    .map((mapping) => mapping.companyCode),
                  fields: ["mappingCoverage", "excluded"],
                  periods: [],
                  sourceUrls: data.sources
                    .filter((source) => source.kind === "catalog")
                    .map((source) => source.sourceUrl),
                },
              }]
            : []),
          {
            code: "BOUNDED_FINANCIAL_SCREEN_FUNNEL",
            severity: "info",
            scope: "selection",
            message:
              "粗篩後只對前 10 家做 deep，最多對 candidate_limit（上限 5）做 reaction；未評估公司不是負面判定。",
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
            code: "FINANCIAL_CROSS_MODEL_SCORE_NOT_COMPARABLE",
            severity: "info",
            scope: "value",
            message:
              "balanced_financial_v1 overallScore 只可在金融模型內排序，不得與 balanced_non_financial_v2 raw score 比較。",
            refs: {
              companyCodes: data.candidates.map((candidate) => candidate.companyCode),
              fields: [
                "screenDefinition.crossModelScoreComparable",
                "candidates[].scoreComparisonScope",
                "candidates[].overallScore",
              ],
              periods: [],
              sourceUrls: [],
            },
          },
          {
            code: "SCREEN_MIXED_AS_OF",
            severity: "info",
            scope: "period",
            message:
              "公司母體、月營收、獲利、資本適足、資產品質、估值與 reaction 的截止點不同，不是單一 point-in-time snapshot。",
            refs: {
              companyCodes: data.candidates.map((candidate) => candidate.companyCode),
              fields: ["asOf", "candidates[].asOf", "sources"],
              periods: [
                ...data.asOf.masterReportDates,
                data.asOf.revenueMonth,
                data.asOf.valuationDate,
                ...data.asOf.profitabilityThroughPeriods,
                ...data.asOf.capitalThroughPeriods,
                ...data.asOf.assetQualityThroughPeriods,
              ],
              sourceUrls: data.sources.map((source) => source.sourceUrl),
            },
          },
          ...incompleteDependencies.map((item) => ({
            code:
              item.status === "failed"
                ? "SCREEN_DEPENDENCY_FAILED"
                : "SCREEN_DEPENDENCY_PARTIAL",
            severity: "warning" as const,
            scope: "source" as const,
            message: `${item.stage}/${item.dependency}: ${item.message ?? "dependency 未完整完成。"}`,
            refs: {
              companyCodes: item.affectedCompanyCodes,
              fields: ["dependencyStatus", "coverage"],
              periods: [],
              sourceUrls: data.sources.map((source) => source.sourceUrl),
            },
          })),
        ],
      },
    );
  },
);

export const financialScreeningTools = [
  screenTaiwanFinancialCandidatesTool,
] as const;
