import { describe, expect, it } from "vitest";

import {
  screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema,
  screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema,
} from "@/lib/mcp/schemas";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import { buildTaiwanStockScreenDefinition } from "@/lib/screening/client";
import {
  SCREEN_METRIC_ROLES,
  type ResolvedScreenFinancialMetric,
} from "@/lib/screening/metric-roles";

function emptyScreenResult() {
  const metricDefinitions: Record<
    (typeof SCREEN_METRIC_ROLES)[number],
    Omit<ResolvedScreenFinancialMetric, "role" | "family" | "resolutionBasis">
  > = {
    roe: { metricCode: "ROE", metricName: "權益報酬率", unit: "%", category: "profitability" },
    net_profit: { metricCode: "NetProfit", metricName: "稅後純益", unit: "仟元", category: "profitability" },
    operating_cashflow: { metricCode: "OperatingCashflow", metricName: "營業活動現金流量", unit: "仟元", category: "cashflow" },
    debt_ratio: { metricCode: "DebtRatio", metricName: "負債佔資產比率", unit: "%", category: "solvency" },
    gross_margin: { metricCode: "GrossMargin", metricName: "毛利率", unit: "%", category: "margin" },
    operating_margin: { metricCode: "OperatingMargin", metricName: "營業利益率", unit: "%", category: "margin" },
    eps: { metricCode: "EPS", metricName: "每股盈餘", unit: "元", category: "per_share" },
  };
  const screenDefinition = buildTaiwanStockScreenDefinition({
    requiredFinancialMetricRoles: [...SCREEN_METRIC_ROLES],
    resolvedFinancialMetrics: SCREEN_METRIC_ROLES.map((role) => ({
      role,
      ...metricDefinitions[role],
      family: "data" as const,
      resolutionBasis: "exact_name" as const,
    })),
    catalogDiscoveredAt: "2026-08-28T00:00:00.000Z",
    catalogSnapshotId: `mopsfin-catalog-${"0".repeat(64)}`,
  });
  return {
    query: {
      market: "all" as const,
      includeKy: true,
      candidateLimit: 5,
      preset: "balanced_non_financial_v2" as const,
    },
    generatedAt: "2026-08-28T04:00:00.000Z",
    timezone: "Asia/Taipei" as const,
    screenDefinition,
    asOf: {
      selector: "latest" as const,
      granularity: "mixed" as const,
      masterReportDates: [],
      revenueMonth: "2026-07",
      valuationDate: "2026-08-27",
      financialThroughPeriods: [],
      reactionDates: [],
    },
    coverage: {
      selectionComplete: true,
      sourceComplete: true,
      deepEvidenceComplete: true,
      reactionEvidenceComplete: true,
      missingCompanyCodes: [],
    },
    funnel: {
      currentMaster: 0,
      explicitlyRequested: null,
      eligibleNonFinancial: 0,
      excludedFinancial: 0,
      excludedKy: 0,
      missingRequestedCodes: [],
      withLatestRevenue: 0,
      withLatestValuation: 0,
      coarseEligible: 0,
      deepSelected: 0,
      deepScored: 0,
      reactionSelected: 0,
      reactionScored: 0,
      returned: 0,
      buckets: {
        research_candidate: 0,
        watchlist: 0,
        insufficient_data: 0,
        deprioritized: 0,
      },
    },
    workBudget: {
      coarseCompanies: 0,
      deepCompanyLimit: 10 as const,
      deepCompaniesRequested: 0,
      financialMetricCount: 7 as const,
      financialMetricComparisonUnits: 0,
      revenueTrendMonths: 6 as const,
      reactionCompanyLimit: 5 as const,
      reactionCompaniesRequested: 0,
      reactionOfficialMonthUnits: 0,
      reactionOfficialMonthUnitLimit: 48 as const,
      reactionCorporateActionRequests: 0,
    },
    candidates: [],
    summaryLimits: {
      maximumPerList: 25 as const,
      notDeepScoredTotal: 0,
      notReactionScoredTotal: 0,
      excludedTotal: 0,
    },
    notDeepScored: [],
    notReactionScored: [],
    excluded: [],
    dependencyStatus: [],
    sources: [],
    warnings: [],
  };
}

describe("screen candidates with catalyst snapshots schemas", () => {
  it("defaults both the fixed screen and evidence-only snapshot selection", () => {
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.parse({}),
    ).toEqual({
      screen: {
        market: "all",
        include_ky: true,
        candidate_limit: 5,
        preset: "balanced_non_financial_v2",
      },
      catalyst_snapshots: {
        snapshot_types: [
          "forecast_achievement",
          "forecast_material_variance",
          "shareholder_meeting",
          "dividend_decision",
        ],
        record_preview_limit: 50,
      },
    });
  });

  it("allows bounded screen options and a canonical snapshot-family subset", () => {
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.parse({
        screen: {
          market: "listed",
          company_codes: ["2330"],
          include_ky: false,
          candidate_limit: 1,
          preset: "balanced_non_financial_v2",
        },
        catalyst_snapshots: {
          snapshot_types: ["shareholder_meeting"],
          record_preview_limit: 10,
        },
      }),
    ).toEqual({
      screen: {
        market: "listed",
        company_codes: ["2330"],
        include_ky: false,
        candidate_limit: 1,
        preset: "balanced_non_financial_v2",
      },
      catalyst_snapshots: {
        snapshot_types: ["shareholder_meeting"],
        record_preview_limit: 10,
      },
    });
  });

  it("does not let callers override snapshot companies, market, as-of or offset", () => {
    for (const forbidden of [
      { company_codes: ["2330"] },
      { company_markets: [{ company_code: "2330", market: "listed" }] },
      { as_of: "latest" },
      { offset: 0 },
    ]) {
      expect(
        screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.safeParse({
          catalyst_snapshots: forbidden,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate families, screen overflow, preview overflow and unknown fields", () => {
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.safeParse({
        catalyst_snapshots: {
          snapshot_types: ["shareholder_meeting", "shareholder_meeting"],
        },
      }).success,
    ).toBe(false);
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.safeParse({
        screen: { candidate_limit: 6 },
      }).success,
    ).toBe(false);
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.safeParse({
        catalyst_snapshots: { record_preview_limit: 101 },
      }).success,
    ).toBe(false);
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsInputSchema.safeParse({
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("keeps the composite output contract strict", () => {
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema.safeParse({
        ok: true,
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a no-candidate result only when the snapshot stage is not run", () => {
    const screen = emptyScreenResult();
    const data = {
      query: {
        screen: screen.query,
        catalystSnapshots: {
          snapshotTypes: [
            "forecast_achievement" as const,
            "forecast_material_variance" as const,
            "shareholder_meeting" as const,
            "dividend_decision" as const,
          ],
          recordPreviewLimit: 50,
        },
      },
      generatedAt: "2026-08-28T04:00:01.000Z",
      timezone: "Asia/Taipei" as const,
      scope:
        "screen_candidates_with_current_catalyst_snapshot_evidence" as const,
      posture: "research_triage_evidence_only" as const,
      screen,
      catalystSnapshots: {
        stageStatus: "not_run" as const,
        queriedCompanyCodes: [],
        candidateEvidence: [],
        recordPreview: [],
        recordPreviewComplete: true,
        sources: [],
        failures: [],
        coverage: null,
        counts: null,
        workBudget: {
          snapshotCallCount: 0 as const,
          recordPreviewLimit: 50,
          snapshotResult: null,
        },
        continuation: {
          status: "not_required" as const,
          standaloneTool: "get_company_catalyst_snapshots" as const,
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
        warnings: ["Screen 沒有候選，因此未執行 snapshot stage。"],
        error: null,
      },
      compositionIntegrity: {
        screenResultPreserved: true as const,
        candidateOrderPreserved: true,
        queriedOnlyScreenCandidates: true,
        catalystEvidenceAffectsScreenRanking: false as const,
        snapshotCallCount: 0 as const,
      },
      lineage: {
        screen: {
          generatedAt: screen.generatedAt,
          screenDefinitionId: screen.screenDefinition.id,
          preset: screen.screenDefinition.preset,
        },
        catalystSnapshots: null,
        candidateJoin: {
          basis: "ordered_screen_candidates" as const,
          companyCodes: [],
        },
        marketHints: [],
      },
      coverage: {
        screen: screen.coverage,
        catalystSnapshots: null,
        compositionComplete: true,
      },
      workBudget: {
        screen: screen.workBudget,
        catalystSnapshots: {
          snapshotCallCount: 0 as const,
          recordPreviewLimit: 50,
          snapshotResult: null,
        },
        candidateLimit: 5 as const,
        maximumCompanyFamilyCoverageRows: 20 as const,
      },
      sources: [],
      warnings: ["Evidence-only composite。"],
    };
    const envelope = {
      ok: true as const,
      meta: buildResultMeta(data, { freshness: "not_applicable" }),
      ...data,
    };

    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema.safeParse(
        envelope,
      ).success,
    ).toBe(true);
    expect(
      screenTaiwanStockCandidatesWithCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        catalystSnapshots: {
          ...envelope.catalystSnapshots,
          stageStatus: "complete",
        },
      }).success,
    ).toBe(false);
  });
});
