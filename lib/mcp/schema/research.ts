import { z } from "zod";

import {
  companyCatalystSnapshotsDataSchema,
} from "./catalysts";
import {
  freshnessEvaluationSchema,
  successResultShape,
} from "./common";
import {
  screenTaiwanStockCandidatesDataSchema,
  screenTaiwanStockCandidatesInputSchema,
} from "./screening";

const candidateCatalystSnapshotTypeSchema = z.enum([
  "forecast_achievement",
  "forecast_material_variance",
  "shareholder_meeting",
  "dividend_decision",
]);

const canonicalSnapshotTypes = [
  "forecast_achievement",
  "forecast_material_variance",
  "shareholder_meeting",
  "dividend_decision",
] as const;

const defaultScreenInput = {
  market: "all" as const,
  include_ky: true,
  candidate_limit: 5,
  preset: "balanced_non_financial_v2" as const,
};

const candidateCatalystSelectionInputSchema = z
  .object({
    snapshot_types: z
      .array(candidateCatalystSnapshotTypeSchema)
      .min(1)
      .max(4)
      .default([...canonicalSnapshotTypes])
      .describe(
        "只對實際 screen candidates 查詢的 current official snapshot families；不得重複，且不接受 caller 另行指定公司、市場、as-of 或 offset",
      ),
    record_preview_limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe(
        "回傳的詳細官方 records 預覽上限；company×family coverage 與 counts 仍按完整 snapshot result 計算，超出時導向 standalone snapshot tool 續查",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.snapshot_types).size !== value.snapshot_types.length) {
      context.addIssue({
        code: "custom",
        path: ["snapshot_types"],
        message: "snapshot_types 不得重複",
      });
    }
  });

export const screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema = z
  .object({
    screen: screenTaiwanStockCandidatesInputSchema
      .default(defaultScreenInput)
      .describe(
        "完整沿用 screen_taiwan_stock_candidates 的固定 balanced_non_financial_v2 查詢；catalyst evidence 不得修改其 candidate membership、rank、score、pillar 或 bucket",
      ),
    catalyst_snapshots: candidateCatalystSelectionInputSchema
      .default({
        snapshot_types: [...canonicalSnapshotTypes],
        record_preview_limit: 50,
      })
      .describe(
        "附加至實際 screen candidates 的 current official snapshot evidence 選項",
      ),
  })
  .strict();

const catalystShape = companyCatalystSnapshotsDataSchema.shape;
const screenShape = screenTaiwanStockCandidatesDataSchema.shape;
const catalystCoverageItemSchema =
  catalystShape.coverage.shape.snapshots.element;
const catalystCompanyResultSchema = catalystShape.companies.element;
const catalystRecordSchema = catalystShape.records.element;
const catalystSourceSchema = catalystShape.sources.element;
const catalystFailureSchema = catalystShape.failures.element;
const screenSourceSchema = screenShape.sources.element;

const candidateCatalystEvidenceSchema = z
  .object({
    companyCode: z
      .string()
      .regex(/^\d{4}$/)
      .describe("實際 screen candidate 的四碼公司股票代號"),
    screenRank: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe("未受 catalyst evidence 影響的原始 screen candidate rank"),
    status: z
      .enum(["complete", "partial", "failed", "unsupported"])
      .describe(
        "此 candidate 的 current snapshot evidence 彙總狀態；不會改變 screen bucket 或 score",
      ),
    identityStatus: z
      .enum([
        "verified_current_master_hint",
        "verified_official_record",
        "unverified",
      ])
      .describe(
        "用來判斷 current snapshot absence 能否歸屬於該公司的 identity 證據",
      ),
    resolvedMarket: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("已確認的目前上市／上櫃市場；identity 未確認時為 null"),
    snapshots: z
      .array(catalystCoverageItemSchema)
      .describe(
        "此 candidate 每個 requested family 的 disclosure、freshness、unsupported 與 failure coverage",
      ),
    summary: catalystCompanyResultSchema
      .nullable()
      .describe(
        "來源結果可組裝時的逐公司 summary；stage-level failure 無法形成來源結果時為 null",
      ),
    records: z
      .array(catalystRecordSchema)
      .describe("本次 record preview 中屬於此 candidate 的官方 records"),
    recordPreviewComplete: z
      .boolean()
      .describe(
        "此 candidate 的詳細 records 是否全數包含於 preview；false 時仍須依 coverage 與 continuation 判讀",
      ),
  })
  .strict();

const catalystContinuationSchema = z
  .object({
    status: z
      .enum(["not_required", "available", "unavailable"])
      .describe(
        "not_required=預覽完整；available=可用 standalone snapshot tool 續查；unavailable=來源 stage 未形成可續查 snapshot",
      ),
    standaloneTool: z
      .literal("get_company_catalyst_snapshots")
      .describe("需要完整 record pages 時使用的既有唯讀 MCP tool"),
    fingerprint: z
      .string()
      .nullable()
      .describe("續查時必須核對的 current snapshot content fingerprint"),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("standalone tool 下一頁 offset；不需或無法續查時為 null"),
    query: catalystShape.query
      .nullable()
      .describe(
        "已綁定實際 candidates、families、market hints 與下一頁 offset 的 standalone query",
      ),
  })
  .strict();

const candidateCatalystStageIntegritySchema = z
  .object({
    sourceResultAvailable: z
      .boolean()
      .describe("snapshot client 是否形成可驗證的 structured source result"),
    queriedCodesMatchScreenCandidates: z
      .boolean()
      .describe("snapshot query 公司是否精確等於 ordered screen candidates"),
    candidateEvidenceOrderMatchesScreen: z
      .boolean()
      .describe("candidateEvidence 是否保留 screen candidate 順序"),
    expectedCoverageRows: z
      .number()
      .int()
      .nonnegative()
      .max(20)
      .describe("candidate 數乘 requested family 數的預期 coverage rows"),
    observedCoverageRows: z
      .number()
      .int()
      .nonnegative()
      .max(20)
      .describe("實際形成的 company×family coverage rows"),
    complete: z
      .boolean()
      .describe(
        "composition join 結構是否完整；不代表所有來源 fresh、supported 或成功",
      ),
  })
  .strict();

const candidateCatalystStageLineageSchema = z
  .object({
    generatedAt: z
      .string()
      .nullable()
      .describe("snapshot stage 組裝時間；未執行或無結果時為 null"),
    scope: z
      .literal("current_official_company_snapshots")
      .nullable()
      .describe("成功形成來源結果時的既有 snapshot scope"),
    fingerprint: z
      .string()
      .nullable()
      .describe("既有 snapshot client 的 content fingerprint"),
  })
  .strict();

const candidateCatalystStageErrorSchema = z
  .object({
    code: z.string().min(1).describe("snapshot stage 的穩定錯誤 code"),
    reason: z
      .string()
      .nullable()
      .describe("可供程式判斷的細分 failure reason；未提供時為 null"),
    message: z.string().min(1).describe("不含秘密資訊的人類可讀錯誤說明"),
    retryable: z.boolean().describe("此 snapshot evidence stage 是否適合重試"),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("安全且有界的建議重試等待時間；無建議時為 null"),
    action: z
      .enum(["fix_input", "change_query", "retry", "restart_pagination", "none"])
      .describe("caller 對此 evidence failure 應採取的下一步"),
  })
  .strict();

const candidateCatalystStageWorkBudgetSchema = z
  .object({
    snapshotCallCount: z
      .union([z.literal(0), z.literal(1)])
      .describe("最多一次的 batched snapshot client logical call"),
    recordPreviewLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("本次詳細 record preview 上限"),
    snapshotResult: catalystShape.workBudget
      .nullable()
      .describe(
        "來源結果可用時的 family×market route budget；未執行或 stage-level failure 時為 null",
      ),
  })
  .strict();

const candidateCatalystSnapshotsStageSchema = z
  .object({
    stageStatus: z
      .enum(["not_run", "complete", "partial", "failed", "unsupported"])
      .describe(
        "附加 evidence stage 狀態；failed／unsupported 仍不得刪除或重分類 screen candidates",
      ),
    queriedCompanyCodes: z
      .array(z.string().regex(/^\d{4}$/))
      .max(5)
      .describe("精確等於實際 ordered screen candidates 的 snapshot query 公司"),
    candidateEvidence: z
      .array(candidateCatalystEvidenceSchema)
      .max(5)
      .describe("依原 screen rank 排列、與 screen decisions 完全隔離的逐公司 evidence"),
    recordPreview: z
      .array(catalystRecordSchema)
      .max(100)
      .describe("有界的 current official record 預覽；不是完整 records 的默示宣稱"),
    recordPreviewComplete: z
      .boolean()
      .describe("全部 selected-company records 是否已包含於 preview"),
    sources: z
      .array(catalystSourceSchema)
      .describe("逐 snapshotType×market 的 official source、freshness 與 status"),
    failures: z
      .array(catalystFailureSchema)
      .describe("逐 source route 隔離且列出 affected candidates 的 failures"),
    coverage: catalystShape.coverage
      .nullable()
      .describe(
        "完整 company×family evidence matrix；未執行或無法形成 structured source result 時為 null",
      ),
    counts: catalystShape.counts
      .nullable()
      .describe("來源結果可用時的完整 record、company 與 source 狀態計數"),
    workBudget: candidateCatalystStageWorkBudgetSchema.describe(
      "一次 batched call 與最多八個 family×market routes 的有界工作量",
    ),
    continuation: catalystContinuationSchema.describe(
      "詳細 record preview 截斷時的 standalone-tool handoff",
    ),
    integrity: candidateCatalystStageIntegritySchema.describe(
      "candidate join 與 coverage cardinality 的可驗證完整性",
    ),
    lineage: candidateCatalystStageLineageSchema.describe(
      "snapshot result 的時間、scope 與 content identity",
    ),
    warnings: z
      .array(z.string())
      .describe(
        "current snapshot、absence、stale、unsupported、identity 與 preview 限制",
      ),
    error: candidateCatalystStageErrorSchema
      .nullable()
      .describe(
        "無法形成 structured snapshot result 的 stage-level failure；per-source failures 仍放在 failures",
      ),
  })
  .strict();

const candidateCatalystSourceSchema = z.discriminatedUnion("stage", [
  screenSourceSchema.safeExtend({
    stage: z.literal("screen").describe("此來源屬於原始 screening pipeline"),
  }),
  catalystSourceSchema.safeExtend({
    stage: z
      .literal("catalyst_snapshots")
      .describe("此來源只提供附加 current catalyst evidence"),
  }),
]);

const normalizedScreenQuerySchema = screenShape.query;
const normalizedCatalystSelectionSchema = z
  .object({
    snapshotTypes: z
      .array(candidateCatalystSnapshotTypeSchema)
      .min(1)
      .max(4)
      .describe("按 canonical family 順序的實際 snapshot types"),
    recordPreviewLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("正規化後的詳細 record preview 上限"),
  })
  .strict();

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export const screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        screen: normalizedScreenQuerySchema.describe(
          "實際執行且與 nested screen.query 相同的 normalized screen query",
        ),
        catalystSnapshots: normalizedCatalystSelectionSchema.describe(
          "只控制 evidence family 與 preview 大小、不能覆寫 candidate selection 的 normalized options",
        ),
      })
      .strict()
      .describe(
        "先執行原始 screening、再只對其實際 candidates 附加 current catalyst snapshot evidence 的正規化查詢",
      ),
    generatedAt: z
      .string()
      .describe("完成 screen 與附加 evidence composition 的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("所有 latest 與 snapshot 日期的時區"),
    scope: z
      .literal("screen_candidates_with_current_catalyst_snapshot_evidence")
      .describe("固定先 screen、再附加 current official evidence 的 composite scope"),
    posture: z
      .literal("research_triage_evidence_only")
      .describe("只供下一輪研究分流，不是建議、第五柱或 catalyst scoring"),
    screen: screenTaiwanStockCandidatesDataSchema.describe(
      "原樣保留的完整 screen result；catalyst stage 不得修改任何 decision field",
    ),
    catalystSnapshots: candidateCatalystSnapshotsStageSchema.describe(
      "只對實際 screen candidates 執行的 current official snapshot evidence stage",
    ),
    compositionIntegrity: z
      .object({
        screenResultPreserved: z
          .literal(true)
          .describe("screen result 在 catalyst stage 前後內容 fingerprint 完全相同"),
        candidateOrderPreserved: z
          .boolean()
          .describe("candidate evidence 是否保留原始 screen candidate 順序"),
        queriedOnlyScreenCandidates: z
          .boolean()
          .describe("snapshot query 是否只含實際回傳 candidates"),
        catalystEvidenceAffectsScreenRanking: z
          .literal(false)
          .describe("附加 evidence 絕不修改 rank、score、pillar、preset 或 bucket"),
        snapshotCallCount: z
          .union([z.literal(0), z.literal(1)])
          .describe("沒有 candidates 時為 0，否則最多一次 batched snapshot call"),
      })
      .strict()
      .describe(
        "證明附加 catalyst evidence 未改寫 screen result、candidate 順序或 ranking 的組合完整性",
      ),
    lineage: z
      .object({
        screen: z
          .object({
            generatedAt: z.string().describe("原始 screen result 組裝時間"),
            screenDefinitionId: z
              .literal("taiwan_stock_screen.v2")
              .describe("未被 composite 改寫的 screen definition"),
            preset: z
              .literal("balanced_non_financial_v2")
              .describe("未被 catalyst evidence 改寫的固定 preset"),
          })
          .strict()
          .describe(
            "未被 composite 改寫的原始 screen generation、definition 與 preset lineage",
          ),
        catalystSnapshots: candidateCatalystStageLineageSchema
          .nullable()
          .describe("snapshot stage 未執行時為 null，否則保留來源 result lineage"),
        candidateJoin: z
          .object({
            basis: z
              .literal("ordered_screen_candidates")
              .describe("只依 screen.candidates 有序清單進行 evidence join"),
            companyCodes: z
              .array(z.string().regex(/^\d{4}$/))
              .max(5)
              .describe("與 screen.candidates 同序的 join keys"),
          })
          .strict()
          .describe(
            "依 ordered screen candidates 建立且不得加入額外公司的 evidence join lineage",
          ),
        marketHints: z
          .array(
            z
              .object({
                companyCode: z.string().regex(/^\d{4}$/).describe("取得 fresh market hint 的 candidate"),
                market: z.enum(["listed", "otc"]).describe("fresh screen master 所載市場"),
                sourceAsOf: z.string().describe("該 market master source 的 report date"),
                freshness: freshnessEvaluationSchema.describe(
                  "中央七日 current-snapshot policy 的 fresh identity-hint 證據",
                ),
              })
              .strict(),
          )
          .max(5)
          .describe(
            "只列 freshness=within_expected_window 的逐 candidate current-market hints；stale／unknown market 不得傳入 snapshot client",
          ),
      })
      .strict()
      .describe(
        "原始 screen、snapshot result、candidate join 與 fresh market hints 的可追溯 lineage",
      ),
    coverage: z
      .object({
        screen: screenShape.coverage.describe("原始 screen evidence coverage"),
        catalystSnapshots: catalystShape.coverage
          .nullable()
          .describe("snapshot stage 未執行或未形成 structured result 時為 null"),
        compositionComplete: z
          .boolean()
          .describe(
            "screen preservation、candidate join 與 company×family matrix 是否完成；不把 unsupported／stale 當成 absence",
          ),
      })
      .strict()
      .describe(
        "分別保留 screening 與 catalyst snapshot evidence 的 coverage，並揭露 composite 是否完整",
      ),
    workBudget: z
      .object({
        screen: screenShape.workBudget.describe("原始 bounded screen 工作量"),
        catalystSnapshots: candidateCatalystStageWorkBudgetSchema.describe(
          "附加 evidence 的單次 batched call 與 route 工作量",
        ),
        candidateLimit: z.literal(5).describe("可進入 snapshot stage 的固定最大公司數"),
        maximumCompanyFamilyCoverageRows: z
          .literal(20)
          .describe("最多 5 家乘 4 個 snapshot families 的 coverage matrix 上限"),
      })
      .strict()
      .describe(
        "原始 bounded screening 工作量與最多一次 batched catalyst snapshot call 的合併預算",
      ),
    sources: z
      .array(candidateCatalystSourceSchema)
      .describe(
        "screen sources 在前、snapshot sources 在後的 normalized lineage；failed／unsupported 仍保留，供 quality refs 與 source cutoffs 使用",
      ),
    warnings: z
      .array(z.string())
      .describe(
        "screen 限制與 evidence-only、absence、stale、unsupported、identity、record preview 警示",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: "custom", path, message });
    const screenCodes = value.screen.candidates.map(
      (candidate) => candidate.companyCode,
    );
    const evidenceCodes = value.catalystSnapshots.candidateEvidence.map(
      (candidate) => candidate.companyCode,
    );
    const snapshotTypes = value.query.catalystSnapshots.snapshotTypes;
    const canonicalTypes = canonicalSnapshotTypes.filter((snapshotType) =>
      snapshotTypes.includes(snapshotType),
    );

    if (!sameJson(value.query.screen, value.screen.query)) {
      issue(["query", "screen"], "query.screen 必須與 nested screen.query 完全一致");
    }
    if (!sameStrings(snapshotTypes, canonicalTypes)) {
      issue(
        ["query", "catalystSnapshots", "snapshotTypes"],
        "snapshotTypes 必須唯一並依固定 canonical family 順序排列",
      );
    }
    if (screenCodes.length > 5 || new Set(screenCodes).size !== screenCodes.length) {
      issue(["screen", "candidates"], "screen candidates 必須唯一且最多 5 家");
    }
    if (
      !sameStrings(value.catalystSnapshots.queriedCompanyCodes, screenCodes) ||
      !sameStrings(value.lineage.candidateJoin.companyCodes, screenCodes)
    ) {
      issue(
        ["catalystSnapshots", "queriedCompanyCodes"],
        "snapshot query 與 candidateJoin 必須精確等於 ordered screen candidates",
      );
    }
    if (!sameStrings(evidenceCodes, screenCodes)) {
      issue(
        ["catalystSnapshots", "candidateEvidence"],
        "candidateEvidence 必須恰好涵蓋並保留 screen candidate 順序",
      );
    }
    value.catalystSnapshots.candidateEvidence.forEach((evidence, index) => {
      const candidate = value.screen.candidates[index];
      if (!candidate || evidence.screenRank !== candidate.rank) {
        issue(
          ["catalystSnapshots", "candidateEvidence", index, "screenRank"],
          "screenRank 必須等於未修改的 screen candidate rank",
        );
      }
      if (
        evidence.snapshots.some(
          (snapshot) =>
            snapshot.companyCode !== evidence.companyCode ||
            !snapshotTypes.includes(snapshot.snapshotType),
        )
      ) {
        issue(
          ["catalystSnapshots", "candidateEvidence", index, "snapshots"],
          "逐公司 snapshots 只能包含同公司與 requested families",
        );
      }
      if (
        evidence.summary !== null &&
        evidence.summary.companyCode !== evidence.companyCode
      ) {
        issue(
          ["catalystSnapshots", "candidateEvidence", index, "summary"],
          "summary 必須屬於同一 candidate",
        );
      }
      if (
        evidence.records.some(
          (record) => record.companyCode !== evidence.companyCode,
        )
      ) {
        issue(
          ["catalystSnapshots", "candidateEvidence", index, "records"],
          "逐公司 record preview 不能包含其他 candidates",
        );
      }
    });

    const expectedCoverageRows = screenCodes.length * snapshotTypes.length;
    const observedCoverageRows =
      value.catalystSnapshots.coverage?.snapshots.length ?? 0;
    if (
      value.catalystSnapshots.integrity.expectedCoverageRows !==
        expectedCoverageRows ||
      value.catalystSnapshots.integrity.observedCoverageRows !==
        observedCoverageRows
    ) {
      issue(
        ["catalystSnapshots", "integrity"],
        "integrity coverage counts 必須由 candidates×families 與實際 matrix 導出",
      );
    }

    const hasCandidates = screenCodes.length > 0;
    if (!hasCandidates) {
      if (
        value.catalystSnapshots.stageStatus !== "not_run" ||
        value.catalystSnapshots.workBudget.snapshotCallCount !== 0 ||
        value.catalystSnapshots.sources.length > 0 ||
        value.catalystSnapshots.failures.length > 0 ||
        value.catalystSnapshots.coverage !== null ||
        value.catalystSnapshots.counts !== null ||
        value.catalystSnapshots.error !== null ||
        value.catalystSnapshots.continuation.status !== "not_required"
      ) {
        issue(
          ["catalystSnapshots"],
          "沒有 screen candidates 時 snapshot stage 必須 not_run、零呼叫且沒有虛構來源結果",
        );
      }
    } else if (
      value.catalystSnapshots.stageStatus === "not_run" ||
      value.catalystSnapshots.workBudget.snapshotCallCount !== 1
    ) {
      issue(
        ["catalystSnapshots", "stageStatus"],
        "有 screen candidates 時必須執行一次 batched snapshot stage",
      );
    }

    const sourceResultAvailable =
      value.catalystSnapshots.coverage !== null &&
      value.catalystSnapshots.counts !== null &&
      value.catalystSnapshots.workBudget.snapshotResult !== null;
    if (
      value.catalystSnapshots.integrity.sourceResultAvailable !==
      sourceResultAvailable
    ) {
      issue(
        ["catalystSnapshots", "integrity", "sourceResultAvailable"],
        "sourceResultAvailable 必須與 coverage、counts 及 snapshotResult 一致",
      );
    }
    if (
      value.compositionIntegrity.snapshotCallCount !==
        value.catalystSnapshots.workBudget.snapshotCallCount ||
      !sameJson(
        value.workBudget.catalystSnapshots,
        value.catalystSnapshots.workBudget,
      )
    ) {
      issue(
        ["workBudget", "catalystSnapshots"],
        "top-level 與 stage snapshot work budget／call count 必須一致",
      );
    }
    if (!sameJson(value.workBudget.screen, value.screen.workBudget)) {
      issue(["workBudget", "screen"], "top-level screen work budget 不得改寫");
    }
    if (
      !sameJson(value.coverage.screen, value.screen.coverage) ||
      !sameJson(
        value.coverage.catalystSnapshots,
        value.catalystSnapshots.coverage,
      )
    ) {
      issue(["coverage"], "top-level coverage 必須精確引用兩個 stages");
    }
    if (
      value.lineage.screen.generatedAt !== value.screen.generatedAt ||
      value.lineage.screen.screenDefinitionId !== value.screen.screenDefinition.id ||
      value.lineage.screen.preset !== value.screen.screenDefinition.preset ||
      !sameJson(
        value.lineage.catalystSnapshots,
        hasCandidates ? value.catalystSnapshots.lineage : null,
      )
    ) {
      issue(["lineage"], "lineage 必須由未修改的 screen 與 snapshot stage 導出");
    }
    if (
      value.compositionIntegrity.candidateOrderPreserved !==
        sameStrings(evidenceCodes, screenCodes) ||
      value.compositionIntegrity.queriedOnlyScreenCandidates !==
        sameStrings(value.catalystSnapshots.queriedCompanyCodes, screenCodes)
    ) {
      issue(
        ["compositionIntegrity"],
        "composition integrity flags 必須由實際 candidate join 導出",
      );
    }

    const expectedSources = [
      ...value.screen.sources.map((source) => ({ ...source, stage: "screen" as const })),
      ...value.catalystSnapshots.sources.map((source) => ({
        ...source,
        stage: "catalyst_snapshots" as const,
      })),
    ];
    if (!sameJson(value.sources, expectedSources)) {
      issue(
        ["sources"],
        "top-level sources 必須依 screen 在前、snapshot 在後完整保留來源 lineage",
      );
    }

    const marketHintCodes = value.lineage.marketHints.map(
      (hint) => hint.companyCode,
    );
    if (
      new Set(marketHintCodes).size !== marketHintCodes.length ||
      value.lineage.marketHints.some((hint) => {
        const candidate = value.screen.candidates.find(
          (item) => item.companyCode === hint.companyCode,
        );
        return !candidate ||
          candidate.market !== hint.market ||
          hint.freshness.status !== "within_expected_window" ||
          hint.freshness.observedAsOf !== hint.sourceAsOf;
      })
    ) {
      issue(
        ["lineage", "marketHints"],
        "market hints 只能來自對應 candidate 的 fresh current-master source evidence",
      );
    }

    if (value.catalystSnapshots.continuation.status === "available") {
      const continuation = value.catalystSnapshots.continuation;
      if (
        continuation.fingerprint === null ||
        continuation.nextOffset === null ||
        continuation.query === null ||
        value.catalystSnapshots.recordPreviewComplete ||
        continuation.query.offset !== continuation.nextOffset ||
        !sameStrings(continuation.query.companyCodes, screenCodes) ||
        !sameStrings(continuation.query.snapshotTypes, snapshotTypes)
      ) {
        issue(
          ["catalystSnapshots", "continuation"],
          "available continuation 必須綁定相同 candidates／families、fingerprint 與 next offset",
        );
      }
    } else if (value.catalystSnapshots.continuation.nextOffset !== null) {
      issue(
        ["catalystSnapshots", "continuation", "nextOffset"],
        "只有 available continuation 可提供 nextOffset",
      );
    }

    const previewRecordIds = value.catalystSnapshots.recordPreview.map(
      (record) => record.recordId,
    );
    const evidenceRecordIds = value.catalystSnapshots.candidateEvidence.flatMap(
      (evidence) => evidence.records.map((record) => record.recordId),
    );
    if (!sameStringSet(previewRecordIds, evidenceRecordIds)) {
      issue(
        ["catalystSnapshots", "recordPreview"],
        "逐公司 records 必須恰好 partition 全域 record preview",
      );
    }

    if (sourceResultAvailable) {
      const summaries = value.catalystSnapshots.candidateEvidence.flatMap(
        (evidence) => (evidence.summary === null ? [] : [evidence.summary]),
      );
      const continuation = value.catalystSnapshots.continuation;
      const reconstructed = companyCatalystSnapshotsDataSchema.safeParse({
        query: {
          companyCodes: screenCodes,
          snapshotTypes,
          companyMarkets: value.lineage.marketHints.map((hint) => ({
            companyCode: hint.companyCode,
            market: hint.market,
          })),
          asOf: "latest",
          offset: 0,
          limit: value.query.catalystSnapshots.recordPreviewLimit,
        },
        generatedAt: value.catalystSnapshots.lineage.generatedAt,
        timezone: "Asia/Taipei",
        scope: value.catalystSnapshots.lineage.scope,
        isConsensus: false,
        records: value.catalystSnapshots.recordPreview,
        sources: value.catalystSnapshots.sources,
        coverage: value.catalystSnapshots.coverage,
        companies: summaries,
        failures: value.catalystSnapshots.failures,
        counts: value.catalystSnapshots.counts,
        workBudget: value.catalystSnapshots.workBudget.snapshotResult,
        pagination: {
          offset: 0,
          limit: value.query.catalystSnapshots.recordPreviewLimit,
          totalRows: value.catalystSnapshots.counts?.totalRecords ?? 0,
          returnedRows: value.catalystSnapshots.recordPreview.length,
          hasMore: continuation.status === "available",
          nextOffset:
            continuation.status === "available"
              ? continuation.nextOffset
              : null,
        },
        fingerprint: value.catalystSnapshots.lineage.fingerprint,
        warnings: value.catalystSnapshots.warnings,
      });
      if (!reconstructed.success) {
        reconstructed.error.issues.forEach((childIssue) =>
          issue(
            [
              "catalystSnapshots",
              ...childIssue.path.map((segment) =>
                typeof segment === "symbol" ? String(segment) : segment,
              ),
            ],
            `nested snapshot contract: ${childIssue.message}`,
          ),
        );
      }
    }
  });
