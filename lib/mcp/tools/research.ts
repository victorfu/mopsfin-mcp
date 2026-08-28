import type { FreshnessEvaluation } from "@/lib/freshness/types";
import { candidateCatalystClient } from "@/lib/research/candidate-catalyst-client";
import type { ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult } from "@/lib/research/candidate-catalyst-types";

import {
  screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema,
  screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema,
} from "../schemas";
import { defineTool } from "./definition";
import {
  FRESHNESS_POLICIES,
  annotations,
  evaluateFreshness,
  failure,
  fingerprint,
  success,
  taipeiDate,
  type ResultMetaHints,
} from "./shared";

function screenFreshnessDetails(
  data: ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult,
): FreshnessEvaluation[] {
  const expectedScreenDate = taipeiDate(data.screen.generatedAt);
  return data.screen.sources.map((source) => {
    if (source.kind === "company_master") {
      return evaluateFreshness({
        policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
        observedAsOf: source.asOf,
        expectedAsOf: expectedScreenDate,
        sourceUrls: [source.sourceUrl],
      });
    }
    if (source.kind === "monthly_revenue_latest") {
      return evaluateFreshness({
        policy: FRESHNESS_POLICIES.monthlyRevenueLatestCommon,
        observedAsOf: source.asOf,
        expectedAsOf: data.screen.asOf.revenueMonth,
        sourceUrls: [source.sourceUrl],
      });
    }
    if (
      source.kind === "monthly_revenue_history" ||
      source.kind === "reaction_corporate_action"
    ) {
      return evaluateFreshness({
        policy: FRESHNESS_POLICIES.historicalExact,
        observedAsOf: source.asOf,
        expectedAsOf: null,
        sourceUrls: [source.sourceUrl],
      });
    }
    return evaluateFreshness({
      policy:
        source.kind === "company_metrics"
          ? FRESHNESS_POLICIES.mopsfinLatestUnverified
          : FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: source.asOf === "mixed" ? null : source.asOf,
      expectedAsOf: null,
      sourceUrls: [source.sourceUrl],
    });
  });
}

function catalystFreshnessDetails(
  data: ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult,
): FreshnessEvaluation[] {
  const expectedAsOf = taipeiDate(data.generatedAt);
  return data.catalystSnapshots.sources.flatMap((source) => {
    if (source.status === "unsupported") return [];
    if (source.status === "failed") {
      return [
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.unspecified,
          observedAsOf: null,
          expectedAsOf: null,
          sourceUrls: source.sourceUrl ? [source.sourceUrl] : [],
        }),
      ];
    }
    return [
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
        observedAsOf: source.sourceSnapshotDate,
        expectedAsOf,
        sourceUrls: source.sourceUrl ? [source.sourceUrl] : [],
      }),
    ];
  });
}

function qualityIssues(
  data: ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult,
): NonNullable<ResultMetaHints["issues"]> {
  const candidateCodes = data.screen.candidates.map(
    (candidate) => candidate.companyCode,
  );
  const issues: NonNullable<ResultMetaHints["issues"]> = [
    {
      code: "MASTER_ROWSET_HEURISTIC",
      severity: "warning",
      scope: "universe",
      message:
        "Screen 公司母體通過必要來源與 heuristic gate，但官方沒有 declared row count，不能證明完整 rowset。",
      refs: {
        companyCodes: data.screen.query.companyCodes ?? [],
        fields: [
          "screen.funnel.currentMaster",
          "screen.coverage.selectionComplete",
        ],
        periods: data.screen.asOf.masterReportDates,
        sourceUrls: data.screen.sources
          .filter((source) => source.kind === "company_master")
          .map((source) => source.sourceUrl),
      },
    },
    {
      code: "CATALYST_EVIDENCE_DOES_NOT_AFFECT_SCREEN",
      severity: "info",
      scope: "selection",
      message:
        "Current catalyst snapshots 是 append-only evidence；不會修改 screen candidate、rank、score、pillar、preset 或 bucket。",
      refs: {
        companyCodes: candidateCodes,
        fields: [
          "screen.candidates",
          "catalystSnapshots.candidateEvidence",
          "compositionIntegrity.catalystEvidenceAffectsScreenRanking",
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
        "Screen 與 current catalyst snapshots 使用多個來源日期，不是單一 point-in-time snapshot。",
      refs: {
        companyCodes: candidateCodes,
        fields: ["screen.asOf", "catalystSnapshots.sources"],
        periods: [
          ...data.screen.asOf.masterReportDates,
          data.screen.asOf.revenueMonth,
          data.screen.asOf.valuationDate,
          ...data.catalystSnapshots.sources.flatMap((source) =>
            source.sourceSnapshotDate ? [source.sourceSnapshotDate] : [],
          ),
        ],
        sourceUrls: data.sources.flatMap((source) =>
          source.sourceUrl ? [source.sourceUrl] : [],
        ),
      },
    },
  ];

  if (data.catalystSnapshots.stageStatus === "not_run") {
    issues.push({
      code: "CATALYST_SNAPSHOT_NOT_RUN_NO_CANDIDATES",
      severity: "info",
      scope: "selection",
      message: "Screen 沒有形成 candidates，因此沒有執行 snapshot 上游查詢。",
      refs: {
        companyCodes: [],
        fields: ["screen.candidates", "catalystSnapshots.stageStatus"],
        periods: [],
        sourceUrls: [],
      },
    });
  }

  const failedSources = data.catalystSnapshots.sources.filter(
    (source) => source.status === "failed",
  );
  if (failedSources.length > 0 || data.catalystSnapshots.error !== null) {
    issues.push({
      code: "CATALYST_SNAPSHOT_SOURCE_FAILED",
      severity: "warning",
      scope: "source",
      message:
        "至少一個 catalyst snapshot route 或 orchestration stage 失敗；受影響 absence 必須維持 unknown。",
      refs: {
        companyCodes:
          data.catalystSnapshots.failures.flatMap(
            (item) => item.affectedCompanyCodes,
          ).length > 0
            ? [
                ...new Set(
                  data.catalystSnapshots.failures.flatMap(
                    (item) => item.affectedCompanyCodes,
                  ),
                ),
              ]
            : candidateCodes,
        fields: [
          "catalystSnapshots.failures",
          "catalystSnapshots.error",
          "catalystSnapshots.candidateEvidence",
        ],
        periods: [],
        sourceUrls: failedSources.flatMap((source) =>
          source.sourceUrl ? [source.sourceUrl] : [],
        ),
      },
    });
  }

  const staleSources = data.catalystSnapshots.sources.filter(
    (source) => source.freshness === "stale",
  );
  if (staleSources.length > 0) {
    issues.push({
      code: "CATALYST_SNAPSHOT_SOURCE_STALE",
      severity: "warning",
      scope: "source",
      message:
        "至少一個 current snapshot 超過 freshness window；未找到公司不得解讀為目前未揭露。",
      refs: {
        companyCodes: candidateCodes,
        fields: [
          "catalystSnapshots.sources",
          "catalystSnapshots.coverage.snapshots[].disclosureStatus",
        ],
        periods: staleSources.flatMap((source) =>
          source.sourceSnapshotDate ? [source.sourceSnapshotDate] : [],
        ),
        sourceUrls: staleSources.flatMap((source) =>
          source.sourceUrl ? [source.sourceUrl] : [],
        ),
      },
    });
  }

  const unsupportedSources = data.catalystSnapshots.sources.filter(
    (source) => source.status === "unsupported",
  );
  if (unsupportedSources.length > 0) {
    issues.push({
      code: "CATALYST_SNAPSHOT_ROUTE_UNSUPPORTED",
      severity: "warning",
      scope: "source",
      message:
        "至少一個 requested snapshotType×market 沒有 current official endpoint；unsupported 不等於沒有揭露。",
      refs: {
        companyCodes: candidateCodes,
        fields: [
          "catalystSnapshots.sources",
          "catalystSnapshots.coverage.snapshots[].disclosureStatus",
        ],
        periods: [],
        sourceUrls: [],
      },
    });
  }

  const identityUnverified = data.catalystSnapshots.candidateEvidence
    .filter((candidate) => candidate.identityStatus === "unverified")
    .map((candidate) => candidate.companyCode);
  if (identityUnverified.length > 0) {
    issues.push({
      code: "CATALYST_SNAPSHOT_COMPANY_IDENTITY_UNVERIFIED",
      severity: "warning",
      scope: "universe",
      message:
        "至少一個 candidate 無法確認 current market identity；snapshot absence 不得歸因為該公司未揭露。",
      refs: {
        companyCodes: identityUnverified,
        fields: [
          "catalystSnapshots.candidateEvidence[].identityStatus",
          "catalystSnapshots.coverage.snapshots[].disclosureStatus",
        ],
        periods: [],
        sourceUrls: [],
      },
    });
  }

  for (const dependency of data.screen.dependencyStatus) {
    if (dependency.status !== "partial" && dependency.status !== "failed") {
      continue;
    }
    issues.push({
      code:
        dependency.status === "failed"
          ? "SCREEN_DEPENDENCY_FAILED"
          : "SCREEN_DEPENDENCY_PARTIAL",
      severity: "warning",
      scope: "source",
      message: `${dependency.stage}/${dependency.dependency}: ${dependency.message ?? "dependency 未完整完成。"}`,
      refs: {
        companyCodes: dependency.affectedCompanyCodes,
        fields: ["screen.dependencyStatus", "screen.coverage"],
        periods: [],
        sourceUrls: data.screen.sources.map((source) => source.sourceUrl),
      },
    });
  }
  return issues;
}

function compositeSnapshotId(
  data: ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult,
): string {
  return fingerprint({
    screen: {
      query: data.screen.query,
      asOf: data.screen.asOf,
      definition: data.screen.screenDefinition,
      funnel: data.screen.funnel,
      candidates: data.screen.candidates,
      dependencies: data.screen.dependencyStatus,
    },
    catalystSnapshots: {
      query: data.query.catalystSnapshots,
      stageStatus: data.catalystSnapshots.stageStatus,
      fingerprint: data.catalystSnapshots.lineage.fingerprint,
      coverage: data.catalystSnapshots.coverage,
      failures: data.catalystSnapshots.failures,
      error: data.catalystSnapshots.error,
    },
  });
}

export const screenTaiwanStockCandidatesWithCatalystSnapshotsTool = defineTool(
  "screen_taiwan_stock_candidates_with_catalyst_snapshots",
  {
    title: "篩選台股候選並附當期官方催化快照",
    description:
      "先完整執行既有 balanced_non_financial_v2／taiwan_stock_screen.v2 四柱篩選，再只對實際形成的 ordered screen.candidates（最多 5 家、包含任何 bucket）執行一次 batched current official catalyst snapshot 查詢；不查 notDeepScored、notReactionScored、excluded 或其他未形成 candidate 的公司。Snapshot families 可選公司財測達成、官方重大差異名單、股東會與股利決議；公司財測是發行人揭露，不是分析師 consensus，current snapshots 也不是 point-in-time 歷史 vintage。Catalyst evidence 固定 affectsScreenScore=false，只是 append-only 下一輪研究證據，不會修改 candidate membership、rank、score、pillar、preset 或 bucket，也不是第五柱、情緒／impact score、目標價或投資建議。只有 identity 已確認且來源 fresh、schema-valid 時，未找到公司才可解讀為 not_disclosed_in_snapshot；stale、source failure、unsupported 與 identity_unverified 會分開保留。Screen 成功但 catalyst stage 失敗時仍回 partial evidence pack 與完整 screen；沒有 candidates 時不呼叫 snapshot 上游。詳細 records 預覽有界，截斷時依 continuation 改用既有 get_company_catalyst_snapshots 續查。",
    inputSchema:
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema,
    outputSchema:
      screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema,
    annotations,
  },
  async ({ screen, catalyst_snapshots }) => {
    try {
      const data =
        await candidateCatalystClient.screenTaiwanStockCandidatesWithCatalystSnapshots(
          {
            screen: {
              market: screen.market,
              ...(screen.company_codes
                ? { companyCodes: screen.company_codes }
                : {}),
              includeKy: screen.include_ky,
              candidateLimit: screen.candidate_limit,
              preset: screen.preset,
            },
            catalystSnapshots: {
              snapshotTypes: catalyst_snapshots.snapshot_types,
              recordPreviewLimit: catalyst_snapshots.record_preview_limit,
            },
          },
        );
      const freshnessDetails = [
        ...screenFreshnessDetails(data),
        ...catalystFreshnessDetails(data),
      ];
      if (freshnessDetails.length === 0) {
        freshnessDetails.push(
          evaluateFreshness({
            policy: FRESHNESS_POLICIES.unspecified,
            observedAsOf: null,
            expectedAsOf: null,
          }),
        );
      }
      const stageIncomplete =
        data.catalystSnapshots.stageStatus !== "complete" &&
        data.catalystSnapshots.stageStatus !== "not_run";
      return success(
        `候選篩選與 current catalyst evidence 完成：screen candidates ${data.screen.candidates.length} 家，snapshot stage=${data.catalystSnapshots.stageStatus}，records preview ${data.catalystSnapshots.recordPreview.length} 筆；catalyst 不影響原始分數或 bucket。`,
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
          snapshotId: compositeSnapshotId(data),
          source:
            data.screen.coverage.sourceComplete && !stageIncomplete
              ? "complete"
              : "partial",
          universe: "unverified",
          selection:
            data.screen.coverage.selectionComplete && !stageIncomplete
              ? "complete"
              : "partial",
          values:
            data.screen.coverage.deepEvidenceComplete &&
            data.screen.coverage.reactionEvidenceComplete &&
            !stageIncomplete
              ? "complete"
              : "partial",
          freshnessDetails,
          issues: qualityIssues(data),
        },
      );
    } catch (error) {
      return failure(error);
    }
  },
);

export const researchTools = [
  screenTaiwanStockCandidatesWithCatalystSnapshotsTool,
] as const;
