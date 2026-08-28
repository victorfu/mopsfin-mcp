import type { CompanyMarket } from "@/lib/company-master/types";
import type {
  CompanyCatalystSnapshotsCompanyResult,
  CompanyCatalystSnapshotsCoverageItem,
  CompanyCatalystSnapshotsIdentityStatus,
  CompanyCatalystSnapshotsMarketHint,
  CompanyCatalystSnapshotsRecord,
  CompanyCatalystSnapshotsResult,
  CompanyCatalystSnapshotsSource,
  CompanyCatalystSnapshotsSourceFailure,
  CompanyCatalystSnapshotsType,
  CompanyCatalystSnapshotsWorkBudget,
} from "@/lib/catalyst/snapshot-types";
import type { FreshnessEvaluation } from "@/lib/freshness/types";
import type {
  ScreenSource,
  TaiwanStockScreenQuery,
  TaiwanStockScreenResult,
} from "@/lib/screening/types";

export const CANDIDATE_CATALYST_SNAPSHOT_TYPES = [
  "forecast_achievement",
  "forecast_material_variance",
  "shareholder_meeting",
  "dividend_decision",
] as const satisfies readonly CompanyCatalystSnapshotsType[];

export const CANDIDATE_CATALYST_COMPANY_LIMIT = 5 as const;
export const CANDIDATE_CATALYST_RECORD_PREVIEW_DEFAULT = 50 as const;
export const CANDIDATE_CATALYST_RECORD_PREVIEW_LIMIT = 100 as const;
export const CANDIDATE_CATALYST_MAXIMUM_COVERAGE_ROWS = 20 as const;

export interface CandidateCatalystSnapshotsSelection {
  snapshotTypes?: CompanyCatalystSnapshotsType[];
  recordPreviewLimit?: number;
}

export interface ScreenTaiwanStockCandidatesWithCatalystSnapshotsQuery {
  screen: TaiwanStockScreenQuery;
  catalystSnapshots?: CandidateCatalystSnapshotsSelection;
}

export interface NormalizedCandidateCatalystSnapshotsSelection {
  snapshotTypes: CompanyCatalystSnapshotsType[];
  recordPreviewLimit: number;
}

export type CandidateCatalystStageStatus =
  | "not_run"
  | "complete"
  | "partial"
  | "failed"
  | "unsupported";

export type CandidateCatalystEvidenceStatus = Exclude<
  CandidateCatalystStageStatus,
  "not_run"
>;

export interface CandidateCatalystEvidence {
  companyCode: string;
  screenRank: number;
  status: CandidateCatalystEvidenceStatus;
  identityStatus: CompanyCatalystSnapshotsIdentityStatus;
  resolvedMarket: CompanyMarket | null;
  snapshots: CompanyCatalystSnapshotsCoverageItem[];
  summary: CompanyCatalystSnapshotsCompanyResult | null;
  records: CompanyCatalystSnapshotsRecord[];
  recordPreviewComplete: boolean;
}

export interface CandidateCatalystContinuation {
  status: "not_required" | "available" | "unavailable";
  standaloneTool: "get_company_catalyst_snapshots";
  fingerprint: string | null;
  nextOffset: number | null;
  query: CompanyCatalystSnapshotsResult["query"] | null;
}

export interface CandidateCatalystStageIntegrity {
  sourceResultAvailable: boolean;
  queriedCodesMatchScreenCandidates: boolean;
  candidateEvidenceOrderMatchesScreen: boolean;
  expectedCoverageRows: number;
  observedCoverageRows: number;
  complete: boolean;
}

export interface CandidateCatalystStageLineage {
  generatedAt: string | null;
  scope: CompanyCatalystSnapshotsResult["scope"] | null;
  fingerprint: string | null;
}

export interface CandidateCatalystStageError {
  code: string;
  reason: string | null;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  action:
    | "fix_input"
    | "change_query"
    | "retry"
    | "restart_pagination"
    | "none";
}

export interface CandidateCatalystStageWorkBudget {
  snapshotCallCount: 0 | 1;
  recordPreviewLimit: number;
  snapshotResult: CompanyCatalystSnapshotsWorkBudget | null;
}

export interface CandidateCatalystSnapshotsStage {
  stageStatus: CandidateCatalystStageStatus;
  queriedCompanyCodes: string[];
  candidateEvidence: CandidateCatalystEvidence[];
  recordPreview: CompanyCatalystSnapshotsRecord[];
  recordPreviewComplete: boolean;
  sources: CompanyCatalystSnapshotsSource[];
  failures: CompanyCatalystSnapshotsSourceFailure[];
  coverage: CompanyCatalystSnapshotsResult["coverage"] | null;
  counts: CompanyCatalystSnapshotsResult["counts"] | null;
  workBudget: CandidateCatalystStageWorkBudget;
  continuation: CandidateCatalystContinuation;
  integrity: CandidateCatalystStageIntegrity;
  lineage: CandidateCatalystStageLineage;
  warnings: string[];
  error: CandidateCatalystStageError | null;
}

export type CandidateCatalystSource =
  | ({ stage: "screen" } & ScreenSource)
  | ({ stage: "catalyst_snapshots" } & CompanyCatalystSnapshotsSource);

export interface CandidateCatalystMarketHintLineage {
  companyCode: string;
  market: CompanyMarket;
  sourceAsOf: string;
  freshness: FreshnessEvaluation;
}

export interface ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult {
  query: {
    screen: TaiwanStockScreenQuery;
    catalystSnapshots: NormalizedCandidateCatalystSnapshotsSelection;
  };
  generatedAt: string;
  timezone: "Asia/Taipei";
  scope: "screen_candidates_with_current_catalyst_snapshot_evidence";
  posture: "research_triage_evidence_only";
  screen: TaiwanStockScreenResult;
  catalystSnapshots: CandidateCatalystSnapshotsStage;
  compositionIntegrity: {
    screenResultPreserved: true;
    candidateOrderPreserved: boolean;
    queriedOnlyScreenCandidates: boolean;
    catalystEvidenceAffectsScreenRanking: false;
    snapshotCallCount: 0 | 1;
  };
  lineage: {
    screen: {
      generatedAt: string;
      screenDefinitionId: TaiwanStockScreenResult["screenDefinition"]["id"];
      preset: TaiwanStockScreenResult["screenDefinition"]["preset"];
    };
    catalystSnapshots: CandidateCatalystStageLineage | null;
    candidateJoin: {
      basis: "ordered_screen_candidates";
      companyCodes: string[];
    };
    marketHints: CandidateCatalystMarketHintLineage[];
  };
  coverage: {
    screen: TaiwanStockScreenResult["coverage"];
    catalystSnapshots: CompanyCatalystSnapshotsResult["coverage"] | null;
    compositionComplete: boolean;
  };
  workBudget: {
    screen: TaiwanStockScreenResult["workBudget"];
    catalystSnapshots: CandidateCatalystStageWorkBudget;
    candidateLimit: typeof CANDIDATE_CATALYST_COMPANY_LIMIT;
    maximumCompanyFamilyCoverageRows: typeof CANDIDATE_CATALYST_MAXIMUM_COVERAGE_ROWS;
  };
  sources: CandidateCatalystSource[];
  warnings: string[];
}

export type CandidateCatalystSnapshotQuery = {
  companyCodes: string[];
  snapshotTypes: CompanyCatalystSnapshotsType[];
  companyMarkets?: CompanyCatalystSnapshotsMarketHint[];
  asOf: "latest";
  offset: number;
  limit: number;
};
