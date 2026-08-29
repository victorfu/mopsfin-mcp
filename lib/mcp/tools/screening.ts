import { defineTool } from "./definition";
import { buildScreenFreshnessDetails } from "./screen-freshness";
import type { ResultMetaHints } from "./shared";
import {
  FRESHNESS_POLICIES,
  annotations,
  evaluateFreshness,
  fingerprint,
  screenTaiwanStockCandidatesInputSchema,
  screenTaiwanStockCandidatesOutputSchema,
  success,
  taiwanStockScreenClient,
} from "./shared";

export const screenTaiwanStockCandidatesTool = defineTool(
    "screen_taiwan_stock_candidates",
    {
      title: "篩選台股研究候選",
      description:
        "以各官方來源當下可取得的 latest 資料，對目前上市櫃非金融公司執行固定 balanced_non_financial_v2 研究分流：先以最新月營收與估值粗篩，再對前 10 家做六個月營收趨勢及七項季度財務深篩，最後依 candidate_limit 對最多 5 家計算 5／20／60 benchmark-session reaction。七項財務需求以穩定 semantic roles 表達；每次先對即時 list_catalog 的 family=data 正式中文名稱精確解析，已知歷史代號只作 fallback，缺少、重複、名稱／代號衝突或 batch definition 漂移一律以 CATALOG_CONTRACT_MISMATCH fail closed。screenDefinition 會揭露 required roles、當次 resolved code/name/family、解析時間及 catalog content identity；generic metric tools 仍只接受即時 catalog 正式代號。deep batch 在 24 comparison units 內隔離 company-level metric failure；受影響代號以 company_metrics_unavailable 留在 notReactionScored，其他 deepSelected 公司繼續但不從 top-10 外遞補。公司母體 reportDate 超過中央 7 日 freshness window 時，仍保留原始 coarse/deep evidence，但所有必要 pillar fail closed 為 unknown，不能形成 research_candidate。v2 第四柱只使用 TWSE／TPEx official actual-result factor 移除股數變動機械斷點後的 price-index-compatible 報酬與 path；現金股利價格效果保留，因此不是 adjusted close、股息再投資或 total return。公司行動 coverage、factor、prior close、marker reconciliation 或 identity 證據不足時第四柱為 unknown，不猜測、不補 0、也不以 raw 報酬判 pass／fail；unknown 也不等於 0。金融業固定排除；四柱皆為 hard gates，overallScore 不可抵銷 fail 或 unknown。只有完成 reaction 的 candidates 才有 bucket，其餘留在 notReactionScored。各來源是 mixed as-of、不是 point-in-time snapshot；本工具只供 research triage，不是投資建議、完整盡調、錯價證明或可直接回測結果。",
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
        const screenFreshnessDetails = await buildScreenFreshnessDetails(data);
        if (screenFreshnessDetails.length === 0) {
          screenFreshnessDetails.push(
            evaluateFreshness({
              policy: FRESHNESS_POLICIES.unspecified,
              observedAsOf: null,
              expectedAsOf: null,
            }),
          );
        }
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
            freshnessDetails: screenFreshnessDetails,
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
    },
);

export const screeningTools = [
  screenTaiwanStockCandidatesTool,
] as const;
