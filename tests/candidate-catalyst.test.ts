import { describe, expect, it, vi } from "vitest";

import type {
  CompanyCatalystSnapshotsCoverageItem,
  CompanyCatalystSnapshotsResult,
  CompanyCatalystSnapshotsSource,
} from "@/lib/catalyst/snapshot-types";
import { CompanyCatalystSnapshotClient } from "@/lib/catalyst/snapshot-client";
import {
  CandidateCatalystClient,
  type CandidateCatalystClientOptions,
} from "@/lib/research/candidate-catalyst-client";
import type {
  TaiwanStockScreenCandidate,
  TaiwanStockScreenResult,
} from "@/lib/screening/types";

const NOW = new Date("2026-08-28T04:00:00.000Z");

function candidate(
  companyCode: string,
  rank: number,
  market: "listed" | "otc",
): TaiwanStockScreenCandidate {
  return {
    rank,
    companyCode,
    companyName: `Company ${companyCode}`,
    shortName: companyCode,
    market,
    industryCode: "24",
    listingDate: "2000-01-01",
    isKy: false,
    bucket: "watchlist",
    overallScore: 72,
    evidenceCompletenessPercent: 100,
    broadEvidence: {
      revenueMonth: "2026-07",
      latestRevenueYoyPercent: 10,
      cumulativeRevenueYoyPercent: 8,
      valuationDate: "2026-08-27",
      peRatio: 18,
      priceToBookRatio: 3,
      dividendYieldPercent: 2,
      closePriceTwd: 100,
      coarseScore: 4,
    },
    pillars: {} as TaiwanStockScreenCandidate["pillars"],
    firstRejectionReasons: ["valuation_not_pass"],
    evidenceGaps: [],
    nextDiligence: ["查核催化劑"],
    asOf: {
      masterReportDate: "2026-08-27",
      revenueThroughMonth: "2026-07",
      valuationDate: "2026-08-27",
      financialThroughPeriod: "2026Q2",
      reactionDate: "2026-08-27",
    },
  };
}

function screenResult(
  candidates: TaiwanStockScreenCandidate[],
): TaiwanStockScreenResult {
  return {
    query: {
      market: "all",
      includeKy: true,
      candidateLimit: 5,
      preset: "balanced_non_financial_v2",
    },
    generatedAt: "2026-08-28T03:59:00.000Z",
    timezone: "Asia/Taipei",
    screenDefinition: {
      id: "taiwan_stock_screen.v2",
      preset: "balanced_non_financial_v2",
    },
    coverage: {
      selectionComplete: true,
      sourceComplete: true,
      deepEvidenceComplete: true,
      reactionEvidenceComplete: true,
      missingCompanyCodes: [],
    },
    workBudget: {
      coarseCompanies: 100,
      deepCompanyLimit: 10,
      deepCompaniesRequested: 10,
      financialMetricCount: 7,
      financialMetricComparisonUnits: 7,
      revenueTrendMonths: 6,
      reactionCompanyLimit: 5,
      reactionCompaniesRequested: candidates.length,
      reactionOfficialMonthUnits: 2,
      reactionOfficialMonthUnitLimit: 48,
      reactionCorporateActionRequests: candidates.length,
    },
    candidates,
    notReactionScored: [
      {
        companyCode: "9999",
        companyName: "Not a returned candidate",
        stage: "reaction_selection",
        reasonCodes: ["candidate_limit"],
      },
    ],
    sources: [
      {
        kind: "company_master",
        sourceName: "TWSE company master",
        sourceUrl: "https://example.test/twse-master",
        retrievedAt: "2026-08-28T03:58:00.000Z",
        market: "listed",
        asOf: "2026-08-27",
        asOfGranularity: "date",
      },
      {
        kind: "company_master",
        sourceName: "TPEx company master",
        sourceUrl: "https://example.test/tpex-master",
        retrievedAt: "2026-08-28T03:58:00.000Z",
        market: "otc",
        asOf: "2026-08-10",
        asOfGranularity: "date",
      },
    ],
    warnings: ["screen warning"],
  } as unknown as TaiwanStockScreenResult;
}

function source(
  market: "listed" | "otc",
  freshness: "within_expected_window" | "stale",
): CompanyCatalystSnapshotsSource {
  return {
    snapshotType: "shareholder_meeting",
    market,
    exchange: market === "listed" ? "TWSE" : "TPEx",
    sourceKey:
      market === "listed"
        ? "twse_shareholder_meeting_current"
        : "tpex_shareholder_meeting_current",
    sourceName: `${market} meetings`,
    sourceUrl: `https://example.test/${market}-meetings`,
    sourceMode: "current_official_snapshot",
    pointInTimeHistoryAvailable: false,
    isConsensus: false,
    requestedCompanyCodes: market === "listed" ? ["2330", "6488"] : ["6488"],
    status: "verified_empty",
    freshness,
    retrievedAt: "2026-08-28T04:00:00.000Z",
    sourceSnapshotDate: freshness === "stale" ? "2026-08-10" : "2026-08-27",
    sourceSnapshotAgeDays: freshness === "stale" ? 18 : 1,
    rawRowCount: 1,
    eligibleRecordCount: 0,
    duplicateRecordCount: 0,
    selectedRecordCount: 0,
    emptyVerification: "official_blank_sentinel",
    officialDeclaredRowCount: null,
    rowsetCompleteness: "unverified_no_official_declared_count",
    snapshotIdentity: `${market}-snapshot`,
    failureId: null,
  };
}

function coverage(
  companyCode: string,
  market: "listed" | "otc" | null,
): CompanyCatalystSnapshotsCoverageItem {
  const complete = market === "listed";
  return {
    companyCode,
    snapshotType: "shareholder_meeting",
    routedMarkets: complete ? ["listed"] : ["listed", "otc"],
    status: complete ? "complete" : "partial",
    disclosureStatus: complete
      ? "not_disclosed_in_snapshot"
      : "identity_unverified",
    identityStatus: complete ? "verified_current_master_hint" : "unverified",
    resolvedMarket: market,
    freshness: complete ? "within_expected_window" : "stale",
    recordCount: 0,
    sourceKeys: complete
      ? ["twse_shareholder_meeting_current"]
      : [
          "twse_shareholder_meeting_current",
          "tpex_shareholder_meeting_current",
        ],
    failureIds: [],
  };
}

function snapshotResult(
  query: Parameters<
    NonNullable<CandidateCatalystClientOptions["snapshotClient"]>["getCompanyCatalystSnapshots"]
  >[0],
): CompanyCatalystSnapshotsResult {
  const companyMarkets = query.companyMarkets ?? [];
  const isComplete =
    query.companyCodes.length === 1 && query.companyCodes[0] === "2330";
  const rows = [coverage("2330", "listed"), coverage("6488", null)].filter(
    (row) => query.companyCodes.includes(row.companyCode),
  );
  return {
    query: {
      companyCodes: query.companyCodes,
      snapshotTypes: query.snapshotTypes,
      companyMarkets,
      asOf: "latest",
      offset: query.offset,
      limit: query.limit,
    },
    generatedAt: "2026-08-28T04:00:01.000Z",
    timezone: "Asia/Taipei",
    scope: "current_official_company_snapshots",
    isConsensus: false,
    records: [],
    sources: [
      source("listed", "within_expected_window"),
      ...(query.companyCodes.includes("6488") ? [source("otc", "stale")] : []),
    ],
    coverage: {
      sourceComplete: isComplete,
      selection: isComplete ? "complete" : "partial",
      failureIsolation: "per_snapshot_type_market",
      snapshots: rows,
    },
    companies: query.companyCodes.map((companyCode) => {
      const row = rows.find((item) => item.companyCode === companyCode);
      return {
        companyCode,
        status: row?.status === "complete" ? "complete" : "partial",
        identityStatus: row?.identityStatus ?? "unverified",
        resolvedMarket: row?.resolvedMarket ?? null,
        recordCount: 0,
        disclosedSnapshotTypes: [],
        notDisclosedSnapshotTypes:
          row?.disclosureStatus === "not_disclosed_in_snapshot"
            ? ["shareholder_meeting" as const]
            : [],
        staleSnapshotTypes:
          row?.freshness === "stale" ? ["shareholder_meeting" as const] : [],
        unsupportedSnapshotTypes: [],
        failedSnapshotTypes: [],
      };
    }),
    failures: [],
    counts: {
      requestedCompanies: query.companyCodes.length,
      requestedSnapshotTypes: query.snapshotTypes.length,
      totalRecords: 0,
      returnedRecords: 0,
      completeCompanies: query.companyCodes.length === 1 ? 1 : 0,
      partialCompanies: query.companyCodes.length === 1 ? 0 : 1,
      failedCompanies: 0,
      nonemptySources: 0,
      verifiedEmptySources: query.companyCodes.length === 1 ? 1 : 2,
      staleSources: query.companyCodes.includes("6488") ? 1 : 0,
      failedSources: 0,
      unsupportedSources: 0,
    },
    workBudget: {
      companyCount: query.companyCodes.length,
      snapshotTypeCount: query.snapshotTypes.length,
      plannedSourceRoutes: query.companyCodes.includes("6488") ? 2 : 1,
      supportedSourceQueries: query.companyCodes.includes("6488") ? 2 : 1,
      unsupportedSourceRoutes: 0,
      sourceQueryLimit: 8,
    },
    pagination: {
      offset: query.offset,
      limit: query.limit,
      totalRows: 0,
      returnedRows: 0,
      hasMore: false,
      nextOffset: null,
    },
    fingerprint: "snapshot-fingerprint",
    warnings: ["snapshot warning"],
  };
}

describe("CandidateCatalystClient", () => {
  it("queries exactly the ordered screen candidates once and only passes fresh market hints", async () => {
    const screen = screenResult([
      candidate("2330", 1, "listed"),
      candidate("6488", 2, "otc"),
    ]);
    const before = structuredClone(screen);
    const screenClient = {
      screenTaiwanStockCandidates: vi.fn(async () => screen),
    };
    const snapshotClient = {
      getCompanyCatalystSnapshots: vi.fn(async (query) => snapshotResult(query)),
    };
    const client = new CandidateCatalystClient({
      screenClient,
      snapshotClient,
      now: () => NOW,
    });

    const result = await client.screenTaiwanStockCandidatesWithCatalystSnapshots({
      screen: screen.query,
      catalystSnapshots: {
        snapshotTypes: ["shareholder_meeting"],
        recordPreviewLimit: 5,
      },
    });

    expect(snapshotClient.getCompanyCatalystSnapshots).toHaveBeenCalledTimes(1);
    expect(snapshotClient.getCompanyCatalystSnapshots).toHaveBeenCalledWith(
      {
        companyCodes: ["2330", "6488"],
        snapshotTypes: ["shareholder_meeting"],
        companyMarkets: [{ companyCode: "2330", market: "listed" }],
        asOf: "latest",
        offset: 0,
        limit: 5,
      },
      { allSourcesFailureMode: "return_partial" },
    );
    expect(result.screen).toBe(screen);
    expect(screen).toEqual(before);
    expect(result.catalystSnapshots.stageStatus).toBe("partial");
    expect(
      result.catalystSnapshots.candidateEvidence.map((item) => item.companyCode),
    ).toEqual(["2330", "6488"]);
    expect(result.lineage.marketHints.map((hint) => hint.companyCode)).toEqual([
      "2330",
    ]);
    expect(result.compositionIntegrity).toEqual({
      screenResultPreserved: true,
      candidateOrderPreserved: true,
      queriedOnlyScreenCandidates: true,
      catalystEvidenceAffectsScreenRanking: false,
      snapshotCallCount: 1,
    });
    expect(result.sources.map((item) => item.stage)).toEqual([
      "screen",
      "screen",
      "catalyst_snapshots",
      "catalyst_snapshots",
    ]);
  });

  it("does not call the snapshot client when the screen returns no candidates", async () => {
    const screen = screenResult([]);
    const snapshotClient = {
      getCompanyCatalystSnapshots: vi.fn(),
    };
    const client = new CandidateCatalystClient({
      screenClient: {
        screenTaiwanStockCandidates: vi.fn(async () => screen),
      },
      snapshotClient,
      now: () => NOW,
    });

    const result = await client.screenTaiwanStockCandidatesWithCatalystSnapshots({
      screen: screen.query,
    });

    expect(snapshotClient.getCompanyCatalystSnapshots).not.toHaveBeenCalled();
    expect(result.screen).toBe(screen);
    expect(result.catalystSnapshots).toMatchObject({
      stageStatus: "not_run",
      queriedCompanyCodes: [],
      candidateEvidence: [],
      recordPreviewComplete: true,
      workBudget: { snapshotCallCount: 0 },
    });
    expect(result.coverage.compositionComplete).toBe(true);
  });

  it("marks a fully covered source result complete without changing the candidate", async () => {
    const screen = screenResult([candidate("2330", 1, "listed")]);
    const client = new CandidateCatalystClient({
      screenClient: {
        screenTaiwanStockCandidates: vi.fn(async () => screen),
      },
      snapshotClient: {
        getCompanyCatalystSnapshots: vi.fn(async (query) =>
          snapshotResult(query),
        ),
      },
      now: () => NOW,
    });

    const result = await client.screenTaiwanStockCandidatesWithCatalystSnapshots({
      screen: screen.query,
      catalystSnapshots: { snapshotTypes: ["shareholder_meeting"] },
    });

    expect(result.catalystSnapshots.stageStatus).toBe("complete");
    expect(result.catalystSnapshots.candidateEvidence[0]).toMatchObject({
      companyCode: "2330",
      screenRank: 1,
      status: "complete",
    });
    expect(result.screen.candidates[0]).toBe(screen.candidates[0]);
    expect(result.coverage.compositionComplete).toBe(true);
  });

  it("distinguishes an officially unsupported route from source failure", async () => {
    const screen = screenResult([candidate("6488", 1, "otc")]);
    const otcMaster = screen.sources.find(
      (item) => item.kind === "company_master" && item.market === "otc",
    );
    if (!otcMaster) throw new Error("Missing OTC master fixture.");
    otcMaster.asOf = "2026-08-27";
    const loader = { get: vi.fn() };
    const snapshotClient = new CompanyCatalystSnapshotClient(
      fetch,
      () => NOW,
      { jsonLoader: loader },
    );
    const client = new CandidateCatalystClient({
      screenClient: {
        screenTaiwanStockCandidates: vi.fn(async () => screen),
      },
      snapshotClient,
      now: () => NOW,
    });

    const result = await client.screenTaiwanStockCandidatesWithCatalystSnapshots({
      screen: screen.query,
      catalystSnapshots: { snapshotTypes: ["dividend_decision"] },
    });

    expect(loader.get).not.toHaveBeenCalled();
    expect(result.catalystSnapshots).toMatchObject({
      stageStatus: "unsupported",
      error: null,
      candidateEvidence: [
        {
          companyCode: "6488",
          status: "unsupported",
          snapshots: [
            {
              snapshotType: "dividend_decision",
              disclosureStatus: "unsupported",
            },
          ],
        },
      ],
    });
    expect(result.coverage.compositionComplete).toBe(false);
  });

  it("keeps a structured all-source failure as failed evidence instead of throwing away the screen", async () => {
    const screen = screenResult([candidate("2330", 1, "listed")]);
    const snapshotClient = {
      getCompanyCatalystSnapshots: vi.fn(async (query) => {
        const result = snapshotResult(query);
        const failureId = "all-source-failure";
        return {
          ...result,
          sources: result.sources.map((item) => ({
            ...item,
            status: "failed" as const,
            freshness: "not_applicable" as const,
            failureId,
          })),
          coverage: {
            ...result.coverage,
            sourceComplete: false,
            selection: "partial" as const,
            snapshots: result.coverage.snapshots.map((item) => ({
              ...item,
              status: "failed" as const,
              disclosureStatus: "unknown_source_failure" as const,
              freshness: "not_applicable" as const,
              failureIds: [failureId],
            })),
          },
          companies: result.companies.map((item) => ({
            ...item,
            status: "failed" as const,
            failedSnapshotTypes: ["shareholder_meeting" as const],
          })),
          failures: [
            {
              failureId,
              snapshotType: "shareholder_meeting" as const,
              market: "listed" as const,
              sourceKey: "twse_shareholder_meeting_current" as const,
              affectedCompanyCodes: ["2330"],
              code: "UPSTREAM_BAD_RESPONSE",
              message: "source failed",
              reason: "UPSTREAM_UNEXPECTED_ERROR",
              retryable: true,
              retryAfterMs: null,
              action: "retry" as const,
            },
          ],
          counts: {
            ...result.counts,
            completeCompanies: 0,
            failedCompanies: 1,
            verifiedEmptySources: 0,
            failedSources: 1,
          },
        } satisfies CompanyCatalystSnapshotsResult;
      }),
    };
    const client = new CandidateCatalystClient({
      screenClient: {
        screenTaiwanStockCandidates: vi.fn(async () => screen),
      },
      snapshotClient,
      now: () => NOW,
    });

    const result = await client.screenTaiwanStockCandidatesWithCatalystSnapshots({
      screen: screen.query,
      catalystSnapshots: { snapshotTypes: ["shareholder_meeting"] },
    });

    expect(result.screen).toBe(screen);
    expect(result.catalystSnapshots).toMatchObject({
      stageStatus: "failed",
      error: null,
      failures: [{ failureId: "all-source-failure" }],
      integrity: { sourceResultAvailable: true, complete: true },
      workBudget: { snapshotCallCount: 1 },
    });
    expect(result.catalystSnapshots.candidateEvidence[0]).toMatchObject({
      status: "failed",
      snapshots: [{ disclosureStatus: "unknown_source_failure" }],
    });
  });

  it("preserves the screen and returns an explicit failed stage after an unexpected orchestration error", async () => {
    const screen = screenResult([candidate("2330", 1, "listed")]);
    const snapshotClient = {
      getCompanyCatalystSnapshots: vi.fn(async () => {
        throw new Error("unexpected orchestration failure");
      }),
    };
    const client = new CandidateCatalystClient({
      screenClient: {
        screenTaiwanStockCandidates: vi.fn(async () => screen),
      },
      snapshotClient,
      now: () => NOW,
    });

    const result = await client.screenTaiwanStockCandidatesWithCatalystSnapshots({
      screen: screen.query,
      catalystSnapshots: { snapshotTypes: ["shareholder_meeting"] },
    });

    expect(result.screen).toBe(screen);
    expect(result.screen.candidates[0]).toMatchObject({
      rank: 1,
      overallScore: 72,
      bucket: "watchlist",
    });
    expect(result.catalystSnapshots).toMatchObject({
      stageStatus: "failed",
      queriedCompanyCodes: ["2330"],
      candidateEvidence: [
        {
          companyCode: "2330",
          screenRank: 1,
          status: "failed",
          records: [],
          snapshots: [],
        },
      ],
      workBudget: { snapshotCallCount: 1, snapshotResult: null },
      continuation: { status: "unavailable" },
      error: {
        code: "UPSTREAM_BAD_RESPONSE",
        reason: "CATALYST_ORCHESTRATION_FAILED",
      },
    });
    expect(result.coverage.compositionComplete).toBe(false);
  });

  it("rejects invalid preview limits before starting the screen", async () => {
    const screenClient = {
      screenTaiwanStockCandidates: vi.fn(),
    };
    const client = new CandidateCatalystClient({
      screenClient,
      snapshotClient: { getCompanyCatalystSnapshots: vi.fn() },
    });

    await expect(
      client.screenTaiwanStockCandidatesWithCatalystSnapshots({
        screen: screenResult([]).query,
        catalystSnapshots: { recordPreviewLimit: 101 },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "INVALID_CANDIDATE_CATALYST_QUERY",
    });
    expect(screenClient.screenTaiwanStockCandidates).not.toHaveBeenCalled();
  });
});
