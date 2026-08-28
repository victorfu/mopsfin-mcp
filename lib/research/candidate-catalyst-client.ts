import {
  companyCatalystSnapshotClient,
  type CompanyCatalystSnapshotsExecutionOptions,
} from "@/lib/catalyst/snapshot-client";
import type {
  CompanyCatalystSnapshotsCompanyResult,
  CompanyCatalystSnapshotsCoverageItem,
  CompanyCatalystSnapshotsResult,
  CompanyCatalystSnapshotsType,
} from "@/lib/catalyst/snapshot-types";
import { evaluateFreshness } from "@/lib/freshness/evaluate";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
import { asMopsfinError, MopsfinError } from "@/lib/mopsfin/errors";
import { taiwanStockScreenClient } from "@/lib/screening/client";
import type {
  TaiwanStockScreenQuery,
  TaiwanStockScreenResult,
} from "@/lib/screening/types";

import {
  CANDIDATE_CATALYST_COMPANY_LIMIT,
  CANDIDATE_CATALYST_MAXIMUM_COVERAGE_ROWS,
  CANDIDATE_CATALYST_RECORD_PREVIEW_DEFAULT,
  CANDIDATE_CATALYST_RECORD_PREVIEW_LIMIT,
  CANDIDATE_CATALYST_SNAPSHOT_TYPES,
  type CandidateCatalystContinuation,
  type CandidateCatalystEvidence,
  type CandidateCatalystEvidenceStatus,
  type CandidateCatalystMarketHintLineage,
  type CandidateCatalystSnapshotQuery,
  type CandidateCatalystSnapshotsSelection,
  type CandidateCatalystSnapshotsStage,
  type CandidateCatalystStageError,
  type CandidateCatalystStageStatus,
  type NormalizedCandidateCatalystSnapshotsSelection,
  type ScreenTaiwanStockCandidatesWithCatalystSnapshotsQuery,
  type ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult,
} from "./candidate-catalyst-types";

interface TaiwanStockScreenLike {
  screenTaiwanStockCandidates(
    query: TaiwanStockScreenQuery,
  ): Promise<TaiwanStockScreenResult>;
}

interface CompanyCatalystSnapshotsLike {
  getCompanyCatalystSnapshots(
    query: CandidateCatalystSnapshotQuery,
    executionOptions?: CompanyCatalystSnapshotsExecutionOptions,
  ): Promise<CompanyCatalystSnapshotsResult>;
}

export interface CandidateCatalystClientOptions {
  screenClient?: TaiwanStockScreenLike;
  snapshotClient?: CompanyCatalystSnapshotsLike;
  now?: () => Date;
}

function invalidArgument(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    reason: "INVALID_CANDIDATE_CATALYST_QUERY",
    category: "input",
    retryable: false,
    action: "fix_input",
    details,
  });
}

function normalizeSelection(
  selection: CandidateCatalystSnapshotsSelection | undefined,
): NormalizedCandidateCatalystSnapshotsSelection {
  const requestedTypes =
    selection?.snapshotTypes ?? [...CANDIDATE_CATALYST_SNAPSHOT_TYPES];
  if (!Array.isArray(requestedTypes) || requestedTypes.length === 0) {
    invalidArgument("catalystSnapshots.snapshotTypes 至少需要一種 snapshot type。");
  }
  if (
    requestedTypes.some(
      (snapshotType) =>
        !CANDIDATE_CATALYST_SNAPSHOT_TYPES.includes(snapshotType),
    )
  ) {
    invalidArgument(
      "catalystSnapshots.snapshotTypes 含不支援的 snapshot type。",
      { snapshotTypes: requestedTypes },
    );
  }
  if (new Set(requestedTypes).size !== requestedTypes.length) {
    invalidArgument("catalystSnapshots.snapshotTypes 不得重複。");
  }
  const requestedSet = new Set<CompanyCatalystSnapshotsType>(requestedTypes);
  const snapshotTypes = CANDIDATE_CATALYST_SNAPSHOT_TYPES.filter(
    (snapshotType) => requestedSet.has(snapshotType),
  );
  const recordPreviewLimit =
    selection?.recordPreviewLimit ??
    CANDIDATE_CATALYST_RECORD_PREVIEW_DEFAULT;
  if (
    !Number.isInteger(recordPreviewLimit) ||
    recordPreviewLimit < 1 ||
    recordPreviewLimit > CANDIDATE_CATALYST_RECORD_PREVIEW_LIMIT
  ) {
    invalidArgument(
      `catalystSnapshots.recordPreviewLimit 必須是 1 至 ${CANDIDATE_CATALYST_RECORD_PREVIEW_LIMIT} 的整數。`,
      { recordPreviewLimit },
    );
  }
  return { snapshotTypes, recordPreviewLimit };
}

function taipeiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function candidateCodes(screen: TaiwanStockScreenResult): string[] {
  const codes = screen.candidates.map((candidate) => candidate.companyCode);
  if (codes.length > CANDIDATE_CATALYST_COMPANY_LIMIT) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Screen 回傳候選數超過 composite catalyst stage 的有界上限。",
      {
        reason: "SCREEN_CANDIDATE_CONTRACT_MISMATCH",
        retryable: false,
        action: "none",
        details: {
          candidateCount: codes.length,
          candidateLimit: CANDIDATE_CATALYST_COMPANY_LIMIT,
        },
      },
    );
  }
  if (new Set(codes).size !== codes.length) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Screen 回傳重複候選代號，無法建立一對一 catalyst evidence。",
      {
        reason: "SCREEN_CANDIDATE_CONTRACT_MISMATCH",
        retryable: false,
        action: "none",
        details: { companyCodes: codes },
      },
    );
  }
  return codes;
}

function marketHints(
  screen: TaiwanStockScreenResult,
  companyCodes: string[],
  evaluationTime: Date,
): {
  hints: CandidateCatalystSnapshotQuery["companyMarkets"];
  lineage: CandidateCatalystMarketHintLineage[];
} {
  const expectedAsOf = taipeiDate(evaluationTime);
  const sourcesByMarket = new Map<
    "listed" | "otc",
    Array<{
      sourceAsOf: string;
      freshness: CandidateCatalystMarketHintLineage["freshness"];
    }>
  >();
  for (const source of screen.sources) {
    if (source.kind !== "company_master" || source.market === null) continue;
    const freshness = evaluateFreshness({
      policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
      observedAsOf: source.asOf,
      expectedAsOf,
      sourceUrls: [source.sourceUrl],
    });
    const entries = sourcesByMarket.get(source.market) ?? [];
    entries.push({
      sourceAsOf: source.asOf,
      freshness,
    });
    sourcesByMarket.set(source.market, entries);
  }

  const candidatesByCode = new Map(
    screen.candidates.map((candidate) => [candidate.companyCode, candidate]),
  );
  const hints: NonNullable<CandidateCatalystSnapshotQuery["companyMarkets"]> = [];
  const lineage: CandidateCatalystMarketHintLineage[] = [];
  for (const companyCode of companyCodes) {
    const candidate = candidatesByCode.get(companyCode);
    if (!candidate) continue;
    const matchingSources = sourcesByMarket.get(candidate.market) ?? [];
    if (
      matchingSources.length !== 1 ||
      matchingSources[0].freshness.status !== "within_expected_window"
    ) {
      continue;
    }
    const evidence = matchingSources[0];
    hints.push({ companyCode, market: candidate.market });
    lineage.push({
      companyCode,
      market: candidate.market,
      sourceAsOf: evidence.sourceAsOf,
      freshness: evidence.freshness,
    });
  }
  return { hints, lineage };
}

function sameValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameMarketHints(
  left: CompanyCatalystSnapshotsResult["query"]["companyMarkets"],
  right: CandidateCatalystSnapshotQuery["companyMarkets"],
): boolean {
  const expected = right ?? [];
  return (
    left.length === expected.length &&
    left.every(
      (hint, index) =>
        hint.companyCode === expected[index]?.companyCode &&
        hint.market === expected[index]?.market,
    )
  );
}

function stageStatus(
  result: CompanyCatalystSnapshotsResult,
): CandidateCatalystStageStatus {
  const supportedSources = result.sources.filter(
    (source) => source.status !== "unsupported",
  );
  if (
    result.sources.length > 0 &&
    result.sources.every((source) => source.status === "unsupported")
  ) {
    return "unsupported";
  }
  if (
    supportedSources.length === 0 ||
    supportedSources.every((source) => source.status === "failed")
  ) {
    return "failed";
  }
  return result.coverage.sourceComplete &&
    result.coverage.selection === "complete" &&
    result.failures.length === 0
    ? "complete"
    : "partial";
}

function evidenceStatus(
  snapshots: CompanyCatalystSnapshotsCoverageItem[],
  summary: CompanyCatalystSnapshotsCompanyResult | undefined,
): CandidateCatalystEvidenceStatus {
  if (
    snapshots.length > 0 &&
    snapshots.every((snapshot) => snapshot.status === "unsupported")
  ) {
    return "unsupported";
  }
  if (
    snapshots.length === 0 ||
    snapshots.every((snapshot) => snapshot.status === "failed")
  ) {
    return "failed";
  }
  return summary?.status ?? "failed";
}

function continuation(
  result: CompanyCatalystSnapshotsResult,
): CandidateCatalystContinuation {
  if (!result.pagination.hasMore || result.pagination.nextOffset === null) {
    return {
      status: "not_required",
      standaloneTool: "get_company_catalyst_snapshots",
      fingerprint: result.fingerprint,
      nextOffset: null,
      query: null,
    };
  }
  return {
    status: "available",
    standaloneTool: "get_company_catalyst_snapshots",
    fingerprint: result.fingerprint,
    nextOffset: result.pagination.nextOffset,
    query: {
      ...result.query,
      offset: result.pagination.nextOffset,
    },
  };
}

function projectCandidateEvidence(
  screen: TaiwanStockScreenResult,
  result: CompanyCatalystSnapshotsResult,
): CandidateCatalystEvidence[] {
  return screen.candidates.map((candidate) => {
    const snapshots = result.coverage.snapshots.filter(
      (snapshot) => snapshot.companyCode === candidate.companyCode,
    );
    const summary = result.companies.find(
      (company) => company.companyCode === candidate.companyCode,
    );
    const records = result.records.filter(
      (record) => record.companyCode === candidate.companyCode,
    );
    return {
      companyCode: candidate.companyCode,
      screenRank: candidate.rank,
      status: evidenceStatus(snapshots, summary),
      identityStatus: summary?.identityStatus ?? "unverified",
      resolvedMarket: summary?.resolvedMarket ?? null,
      snapshots,
      summary: summary ?? null,
      records,
      recordPreviewComplete:
        summary !== undefined && records.length === summary.recordCount,
    };
  });
}

function noRunStage(
  selection: NormalizedCandidateCatalystSnapshotsSelection,
): CandidateCatalystSnapshotsStage {
  return {
    stageStatus: "not_run",
    queriedCompanyCodes: [],
    candidateEvidence: [],
    recordPreview: [],
    recordPreviewComplete: true,
    sources: [],
    failures: [],
    coverage: null,
    counts: null,
    workBudget: {
      snapshotCallCount: 0,
      recordPreviewLimit: selection.recordPreviewLimit,
      snapshotResult: null,
    },
    continuation: {
      status: "not_required",
      standaloneTool: "get_company_catalyst_snapshots",
      fingerprint: null,
      nextOffset: null,
      query: null,
    },
    integrity: {
      sourceResultAvailable: false,
      queriedCodesMatchScreenCandidates: true,
      candidateEvidenceOrderMatchesScreen: true,
      expectedCoverageRows: 0,
      observedCoverageRows: 0,
      complete: true,
    },
    lineage: { generatedAt: null, scope: null, fingerprint: null },
    warnings: ["Screen 沒有回傳候選公司，因此未執行 catalyst snapshot stage。"],
    error: null,
  };
}

function stageError(error: unknown): CandidateCatalystStageError {
  const normalized = asMopsfinError(error);
  return {
    code: normalized.code,
    reason: normalized.reason ?? "CATALYST_ORCHESTRATION_FAILED",
    message: normalized.message,
    retryable: normalized.retryable ?? false,
    retryAfterMs: normalized.retryAfterMs ?? null,
    action: normalized.action ?? (normalized.retryable ? "retry" : "none"),
  };
}

function failedStage(
  screen: TaiwanStockScreenResult,
  companyCodes: string[],
  selection: NormalizedCandidateCatalystSnapshotsSelection,
  snapshotCallCount: 0 | 1,
  error: unknown,
): CandidateCatalystSnapshotsStage {
  const normalizedError = stageError(error);
  return {
    stageStatus: "failed",
    queriedCompanyCodes: snapshotCallCount === 1 ? companyCodes : [],
    candidateEvidence: screen.candidates.map((candidate) => ({
      companyCode: candidate.companyCode,
      screenRank: candidate.rank,
      status: "failed",
      identityStatus: "unverified",
      resolvedMarket: null,
      snapshots: [],
      summary: null,
      records: [],
      recordPreviewComplete: false,
    })),
    recordPreview: [],
    recordPreviewComplete: false,
    sources: [],
    failures: [],
    coverage: null,
    counts: null,
    workBudget: {
      snapshotCallCount,
      recordPreviewLimit: selection.recordPreviewLimit,
      snapshotResult: null,
    },
    continuation: {
      status: "unavailable",
      standaloneTool: "get_company_catalyst_snapshots",
      fingerprint: null,
      nextOffset: null,
      query: null,
    },
    integrity: {
      sourceResultAvailable: false,
      queriedCodesMatchScreenCandidates: snapshotCallCount === 1,
      candidateEvidenceOrderMatchesScreen: true,
      expectedCoverageRows: companyCodes.length * selection.snapshotTypes.length,
      observedCoverageRows: 0,
      complete: false,
    },
    lineage: { generatedAt: null, scope: null, fingerprint: null },
    warnings: [
      "Catalyst snapshot orchestration 未完成；screen 結果仍原樣保留，所有 catalyst evidence 視為 unavailable。",
    ],
    error: normalizedError,
  };
}

function successfulStage(
  screen: TaiwanStockScreenResult,
  companyCodes: string[],
  selection: NormalizedCandidateCatalystSnapshotsSelection,
  expectedQuery: CandidateCatalystSnapshotQuery,
  result: CompanyCatalystSnapshotsResult,
): CandidateCatalystSnapshotsStage {
  if (!sameValues(result.query.companyCodes, companyCodes)) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Catalyst snapshot result 的公司順序與本次 screen candidates 不一致。",
      {
        reason: "CATALYST_COMPOSITION_CONTRACT_MISMATCH",
        retryable: false,
        action: "none",
      },
    );
  }
  if (!sameValues(result.query.snapshotTypes, selection.snapshotTypes)) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Catalyst snapshot result 的 snapshot types 與 composite query 不一致。",
      {
        reason: "CATALYST_COMPOSITION_CONTRACT_MISMATCH",
        retryable: false,
        action: "none",
      },
    );
  }
  if (
    !sameMarketHints(result.query.companyMarkets, expectedQuery.companyMarkets) ||
    result.query.asOf !== expectedQuery.asOf ||
    result.query.offset !== expectedQuery.offset ||
    result.query.limit !== expectedQuery.limit
  ) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Catalyst snapshot result 的 normalized query 與 composite request 不一致。",
      {
        reason: "CATALYST_COMPOSITION_CONTRACT_MISMATCH",
        retryable: false,
        action: "none",
      },
    );
  }

  const candidateEvidence = projectCandidateEvidence(screen, result);
  const expectedCoverageRows = companyCodes.length * selection.snapshotTypes.length;
  const observedCoverageRows = result.coverage.snapshots.length;
  const expectedCoverageKeys = new Set(
    companyCodes.flatMap((companyCode) =>
      selection.snapshotTypes.map(
        (snapshotType) => `${companyCode}|${snapshotType}`,
      ),
    ),
  );
  const observedCoverageKeys = result.coverage.snapshots.map(
    (snapshot) => `${snapshot.companyCode}|${snapshot.snapshotType}`,
  );
  const candidateEvidenceOrderMatchesScreen = sameValues(
    candidateEvidence.map((candidate) => candidate.companyCode),
    companyCodes,
  );
  const integrityComplete =
    expectedCoverageRows === observedCoverageRows &&
    new Set(observedCoverageKeys).size === observedCoverageKeys.length &&
    observedCoverageKeys.every((key) => expectedCoverageKeys.has(key)) &&
    candidateEvidenceOrderMatchesScreen;
  if (!integrityComplete) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Catalyst snapshot result 缺少預期的 company × snapshot-type coverage。",
      {
        reason: "CATALYST_COMPOSITION_CONTRACT_MISMATCH",
        retryable: false,
        action: "none",
        details: { expectedCoverageRows, observedCoverageRows },
      },
    );
  }

  return {
    stageStatus: stageStatus(result),
    queriedCompanyCodes: [...companyCodes],
    candidateEvidence,
    recordPreview: result.records,
    recordPreviewComplete: !result.pagination.hasMore,
    sources: result.sources,
    failures: result.failures,
    coverage: result.coverage,
    counts: result.counts,
    workBudget: {
      snapshotCallCount: 1,
      recordPreviewLimit: selection.recordPreviewLimit,
      snapshotResult: result.workBudget,
    },
    continuation: continuation(result),
    integrity: {
      sourceResultAvailable: true,
      queriedCodesMatchScreenCandidates: true,
      candidateEvidenceOrderMatchesScreen,
      expectedCoverageRows,
      observedCoverageRows,
      complete: integrityComplete,
    },
    lineage: {
      generatedAt: result.generatedAt,
      scope: result.scope,
      fingerprint: result.fingerprint,
    },
    warnings: result.warnings,
    error: null,
  };
}

function compositeWarnings(stage: CandidateCatalystSnapshotsStage): string[] {
  const warnings = [
    "Catalyst snapshots 只補充 screen candidates 的 current official evidence；不會改變 screen rank、score、pillars 或 bucket。",
    "本結果只供 research triage，不是投資建議；current snapshots 也不是 point-in-time 歷史證據。",
  ];
  if (stage.stageStatus === "partial") {
    warnings.push(
      "Catalyst snapshot stage 僅部分完成；請依 coverage、sources 與 failures 判讀 unknown 範圍。",
    );
  } else if (stage.stageStatus === "failed") {
    warnings.push(
      "Catalyst snapshot stage 失敗；screen 結果仍有效，但 catalyst absence 不得解讀成沒有揭露。",
    );
  } else if (stage.stageStatus === "unsupported") {
    warnings.push(
      "所選 catalyst snapshot routes 目前皆不受官方 current endpoint 支援。",
    );
  }
  return warnings;
}

export class CandidateCatalystClient {
  private readonly screenClient: TaiwanStockScreenLike;
  private readonly snapshotClient: CompanyCatalystSnapshotsLike;
  private readonly now: () => Date;

  constructor(options: CandidateCatalystClientOptions = {}) {
    this.screenClient = options.screenClient ?? taiwanStockScreenClient;
    this.snapshotClient = options.snapshotClient ?? companyCatalystSnapshotClient;
    this.now = options.now ?? (() => new Date());
  }

  async screenTaiwanStockCandidatesWithCatalystSnapshots(
    query: ScreenTaiwanStockCandidatesWithCatalystSnapshotsQuery,
  ): Promise<ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult> {
    const selection = normalizeSelection(query.catalystSnapshots);
    const screen = await this.screenClient.screenTaiwanStockCandidates(
      query.screen,
    );
    const evaluationTime = this.now();
    const codes = candidateCodes(screen);
    if (codes.length === 0) {
      return this.composeResult(
        screen,
        selection,
        noRunStage(selection),
        evaluationTime,
        [],
      );
    }

    let snapshotCallCount: 0 | 1 = 0;
    let hintLineage: CandidateCatalystMarketHintLineage[] = [];
    try {
      const hintEvidence = marketHints(screen, codes, evaluationTime);
      hintLineage = hintEvidence.lineage;
      const snapshotQuery: CandidateCatalystSnapshotQuery = {
        companyCodes: [...codes],
        snapshotTypes: [...selection.snapshotTypes],
        ...(hintEvidence.hints && hintEvidence.hints.length > 0
          ? { companyMarkets: hintEvidence.hints }
          : {}),
        asOf: "latest",
        offset: 0,
        limit: selection.recordPreviewLimit,
      };
      snapshotCallCount = 1;
      const snapshotResult =
        await this.snapshotClient.getCompanyCatalystSnapshots(snapshotQuery, {
          allSourcesFailureMode: "return_partial",
        });
      const stage = successfulStage(
        screen,
        codes,
        selection,
        snapshotQuery,
        snapshotResult,
      );
      return this.composeResult(
        screen,
        selection,
        stage,
        evaluationTime,
        hintLineage,
      );
    } catch (error) {
      const stage = failedStage(
        screen,
        codes,
        selection,
        snapshotCallCount,
        error,
      );
      return this.composeResult(
        screen,
        selection,
        stage,
        evaluationTime,
        hintLineage,
      );
    }
  }

  private composeResult(
    screen: TaiwanStockScreenResult,
    selection: NormalizedCandidateCatalystSnapshotsSelection,
    stage: CandidateCatalystSnapshotsStage,
    evaluationTime: Date,
    hintLineage: CandidateCatalystMarketHintLineage[],
  ): ScreenTaiwanStockCandidatesWithCatalystSnapshotsResult {
    const screenCodes = screen.candidates.map(
      (candidate) => candidate.companyCode,
    );
    const evidenceCodes = stage.candidateEvidence.map(
      (candidate) => candidate.companyCode,
    );
    const candidateOrderPreserved = sameValues(screenCodes, evidenceCodes);
    const queriedOnlyScreenCandidates =
      stage.workBudget.snapshotCallCount === 0 ||
      sameValues(stage.queriedCompanyCodes, screenCodes);
    const compositionComplete =
      stage.stageStatus === "complete" || stage.stageStatus === "not_run";
    return {
      query: {
        screen: screen.query,
        catalystSnapshots: selection,
      },
      generatedAt: evaluationTime.toISOString(),
      timezone: "Asia/Taipei",
      scope: "screen_candidates_with_current_catalyst_snapshot_evidence",
      posture: "research_triage_evidence_only",
      screen,
      catalystSnapshots: stage,
      compositionIntegrity: {
        screenResultPreserved: true,
        candidateOrderPreserved,
        queriedOnlyScreenCandidates,
        catalystEvidenceAffectsScreenRanking: false,
        snapshotCallCount: stage.workBudget.snapshotCallCount,
      },
      lineage: {
        screen: {
          generatedAt: screen.generatedAt,
          screenDefinitionId: screen.screenDefinition.id,
          preset: screen.screenDefinition.preset,
        },
        catalystSnapshots:
          screenCodes.length === 0 ? null : stage.lineage,
        candidateJoin: {
          basis: "ordered_screen_candidates",
          companyCodes: screenCodes,
        },
        marketHints: hintLineage,
      },
      coverage: {
        screen: screen.coverage,
        catalystSnapshots: stage.coverage,
        compositionComplete,
      },
      workBudget: {
        screen: screen.workBudget,
        catalystSnapshots: stage.workBudget,
        candidateLimit: CANDIDATE_CATALYST_COMPANY_LIMIT,
        maximumCompanyFamilyCoverageRows:
          CANDIDATE_CATALYST_MAXIMUM_COVERAGE_ROWS,
      },
      sources: [
        ...screen.sources.map((source) => ({ ...source, stage: "screen" as const })),
        ...stage.sources.map((source) => ({
          ...source,
          stage: "catalyst_snapshots" as const,
        })),
      ],
      warnings: compositeWarnings(stage),
    };
  }
}

export const candidateCatalystClient = new CandidateCatalystClient();
