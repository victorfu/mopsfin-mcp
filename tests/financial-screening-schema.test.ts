import { describe, expect, it } from "vitest";

import type { TaiwanFinancialScreenResult } from "@/lib/financial-screening/types";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import {
  screenTaiwanFinancialCandidatesDataSchema,
  screenTaiwanFinancialCandidatesInputSchema,
  screenTaiwanFinancialCandidatesOutputSchema,
} from "@/lib/mcp/schema/financial-screening";

function emptyFinancialScreenResult(): TaiwanFinancialScreenResult {
  return {
    query: {
      market: "all",
      includeKy: true,
      candidateLimit: 5,
      preset: "balanced_financial_v1",
    },
    generatedAt: "2026-08-30T04:00:00.000Z",
    timezone: "Asia/Taipei",
    screenDefinition: {
      id: "taiwan_financial_screen.v1",
      preset: "balanced_financial_v1",
      posture: "research_triage_not_recommendation",
      latestOnly: true,
      supportedSectors: ["holding", "bank", "bills"],
      scoreCompensationAcrossPillars: false,
      crossModelScoreComparable: false,
      pillarWeights: {
        company_quality: 25,
        fundamental_improvement: 25,
        reasonable_valuation: 25,
        market_underreaction_proxy: 25,
      },
      stages: [],
      coarseRanking: {
        eligibilityRules: [],
        scoreComponents: [],
        tieBreak: [],
      },
      evidencePolicies: {
        profitabilityRoles: [],
        coreInstitutionMetricRoles: {
          holding: [],
          bank: [],
          bills: [],
        },
        financialAlignment:
          "profitability_exact_quarter_capital_expected_semiannual_asset_quality_exact_quarter",
        valuationPeerScope: "same_financial_subtype_no_fallback",
        valuationPeerMinimum: 3,
        reactionPriceBasis:
          "price_index_compatible_corporate_action_adjusted_vs_price_index",
        metricResolution: {
          requiredMetricRoles: [],
          resolvedMetrics: [],
          catalogDiscoveredAt: "2026-08-30T00:00:00.000Z",
          catalogSnapshotId: `mopsfin-financial-catalog-${"0".repeat(64)}`,
        },
      },
      decisionPolicy: {
        researchCandidate: "all four pillars pass",
        watchlist: "no pillar fails and at least one pillar is unknown",
        insufficientData: "mandatory evidence is unavailable",
        deprioritized: "at least one pillar fails",
      },
      limitations: [],
    },
    asOf: {
      selector: "latest",
      granularity: "mixed",
      masterReportDates: [],
      revenueMonth: "2026-07",
      valuationDate: "2026-08-29",
      profitabilityThroughPeriods: [],
      capitalThroughPeriods: [],
      assetQualityThroughPeriods: [],
      reactionDates: [],
    },
    coverage: {
      selectionComplete: true,
      sourceComplete: true,
      mappingComplete: true,
      deepEvidenceComplete: true,
      reactionEvidenceComplete: true,
      missingCompanyCodes: [],
    },
    funnel: {
      currentMaster: 0,
      explicitlyRequested: null,
      selectedFinancial: 0,
      mappedSupported: 0,
      excludedNonFinancial: 0,
      excludedKy: 0,
      institutionNotFound: 0,
      mappingUnsafe: 0,
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
      deepCompanyLimit: 10,
      deepCompaniesRequested: 0,
      profitabilityMetricCount: 3,
      profitabilityComparisonUnits: 0,
      institutionComparisonUnits: 0,
      institutionIsolationUnits: 0,
      revenueTrendMonths: 6,
      reactionCompanyLimit: 5,
      reactionCompaniesRequested: 0,
      reactionOfficialMonthUnits: 0,
      reactionOfficialMonthUnitLimit: 48,
      reactionCorporateActionRequests: 0,
    },
    candidates: [],
    summaryLimits: {
      maximumPerList: 25,
      notDeepScoredTotal: 0,
      notReactionScoredTotal: 0,
      excludedTotal: 0,
    },
    notDeepScored: [],
    notReactionScored: [],
    excluded: [],
    dependencyStatus: [],
    mappingCoverage: {
      scope: "current_listed_otc_financial_companies",
      catalogDiscoveredAt: "2026-08-30T00:00:00.000Z",
      coverageComplete: true,
      counts: {
        financialCompanies: 0,
        mapped: 0,
        institutionNotFound: 0,
        duplicateInstitutionCode: 0,
        unsupportedInstitutionSector: 0,
        identityMismatch: 0,
        bySupportedSector: { holding: 0, bank: 0, bills: 0 },
      },
      mappings: [],
      warnings: [],
    },
    sources: [],
    warnings: [],
  };
}

describe("financial candidate screening schemas", () => {
  it("defaults the fixed bounded financial screen input", () => {
    expect(screenTaiwanFinancialCandidatesInputSchema.parse({})).toEqual({
      market: "all",
      include_ky: true,
      candidate_limit: 5,
      preset: "balanced_financial_v1",
    });
  });

  it("rejects unknown input fields and duplicate company codes", () => {
    expect(
      screenTaiwanFinancialCandidatesInputSchema.safeParse({ extra: true })
        .success,
    ).toBe(false);
    expect(
      screenTaiwanFinancialCandidatesInputSchema.safeParse({
        company_codes: ["2881", "2881"],
      }).success,
    ).toBe(false);
  });

  it("accepts a minimal complete domain result and its success envelope", () => {
    const data = emptyFinancialScreenResult();

    expect(screenTaiwanFinancialCandidatesDataSchema.safeParse(data).success).toBe(
      true,
    );
    expect(
      Object.hasOwn(screenTaiwanFinancialCandidatesDataSchema.shape, "ok"),
    ).toBe(false);
    expect(
      screenTaiwanFinancialCandidatesOutputSchema.safeParse({
        ok: true,
        meta: buildResultMeta(data as unknown as Record<string, unknown>, {
          selector: "latest",
          resolved: { granularity: "mixed", from: null, through: null },
          freshness: "not_applicable",
        }),
        ...data,
      }).success,
    ).toBe(true);
  });

  it("keeps nested financial result objects strict", () => {
    const data = emptyFinancialScreenResult();
    const invalid = {
      ...data,
      coverage: { ...data.coverage, unexpected: true },
    };

    expect(
      screenTaiwanFinancialCandidatesDataSchema.safeParse(invalid).success,
    ).toBe(false);
  });
});
