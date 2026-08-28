import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completedSessionResolver } from "@/lib/freshness/completed-session-resolver";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { reverseDcfOutputSchema } from "@/lib/mcp/schema/reverse-dcf";
import { runReverseDcfTool } from "@/lib/mcp/tools/reverse-dcf";
import {
  ReverseDcfMcpClient,
  reverseDcfMcpClient,
  type ReverseDcfOrchestrationResult,
  type ReverseDcfPublicQuery,
} from "@/lib/reverse-dcf/mcp-client";
import {
  evaluateReverseDcfAt,
  type ReverseDcfFactProvenance,
  type ReverseDcfInput,
} from "@/lib/reverse-dcf";
import type {
  ValuationModelEvidenceClass,
  ValuationModelFieldId,
  ValuationModelInputField,
  ValuationModelInputsResult,
  ValuationModelUnit,
} from "@/lib/valuation-model/types";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";

const SERVED_AT = "2026-08-28T02:05:00.000Z";
const GENERATED_AT = "2026-08-28T02:00:00.000Z";
const VALUATION_GENERATED_AT = "2026-08-28T01:05:00.000Z";

const VALUES = {
  revenue: 1_000_000_000,
  operatingIncome: 200_000_000,
  fcff: 140_000_000,
  cash: 100_000_000,
  debt: 200_000_000,
  shares: 10_000_000,
} as const;

const BRIDGE = {
  non_operating_assets_twd: 20_000_000,
  non_controlling_interests_twd: 10_000_000,
  preferred_equity_twd: 3_000_000,
  pension_deficit_twd: 5_000_000,
  other_debt_like_items_twd: 7_000_000,
} as const;

function query(): ReverseDcfPublicQuery {
  return {
    company_code: "2330",
    price_source: "latest_completed_close",
    forecast_years: 5,
    wacc_percent: 9,
    terminal_growth_percent: 2,
    solve_for: "revenue_cagr",
    solve_range: { minimum_percent: -10, maximum_percent: 30 },
    enterprise_value_bridge: { ...BRIDGE },
    forward_assumptions: {
      normalized_operating_margin_percent: 20,
      cash_tax_rate_percent: 20,
      sales_to_capital_ratio: 2,
    },
  };
}

function factProvenance(): ReverseDcfFactProvenance[] {
  const sourced = [
    "company.companyCode",
    "company.isFinancial",
    "marketFacts.observedPricePerShareTwd",
    "marketFacts.observedPriceDate",
    "marketFacts.sharesOutstanding",
    "marketFacts.shareCountBasis",
    "marketFacts.cashAndCashEquivalentsTwd",
    "marketFacts.interestBearingDebtTwd",
    "marketFacts.leaseLiabilitiesTwd",
    "operatingFacts.baseRevenueTwd",
  ];
  const caller = [
    "marketFacts.nonOperatingAssetsTwd",
    "marketFacts.nonControllingInterestsTwd",
    "marketFacts.preferredEquityTwd",
    "marketFacts.pensionDeficitTwd",
    "marketFacts.otherDebtLikeItemsTwd",
  ];
  return [
    ...sourced.map((id) => ({
      id,
      evidenceClass: id.includes("observedPrice")
        ? ("OFFICIAL_MARKET_RAW" as const)
        : id.includes("shares") || id === "marketFacts.shareCountBasis"
          ? ("OFFICIAL_MASTER_RAW" as const)
          : id.startsWith("company.")
            ? ("OFFICIAL_MASTER_RAW" as const)
            : ("MOPSFIN_CALC" as const),
      lineageIds: [`calibration:${id}`],
    })),
    ...caller.map((id) => ({
      id,
      evidenceClass: "CALLER_ASSUMPTION" as const,
      lineageIds: [],
    })),
  ];
}

function calibratedClose(publicQuery: ReverseDcfPublicQuery): number {
  if (publicQuery.solve_for !== "revenue_cagr") {
    throw new Error("fixture only supports revenue_cagr");
  }
  const calibration: ReverseDcfInput = {
    company: { companyCode: "2330", isFinancial: false },
    currency: "TWD",
    marketFacts: {
      observedPricePerShareTwd: 1,
      observedPriceDate: "2026-08-27",
      sharesOutstanding: VALUES.shares,
      shareCountBasis: "issued_common_shares",
      cashAndCashEquivalentsTwd: VALUES.cash,
      nonOperatingAssetsTwd: BRIDGE.non_operating_assets_twd,
      interestBearingDebtTwd: VALUES.debt,
      leaseLiabilitiesTwd: 0,
      nonControllingInterestsTwd: BRIDGE.non_controlling_interests_twd,
      preferredEquityTwd: BRIDGE.preferred_equity_twd,
      pensionDeficitTwd: BRIDGE.pension_deficit_twd,
      otherDebtLikeItemsTwd: BRIDGE.other_debt_like_items_twd,
    },
    forecastYears: publicQuery.forecast_years,
    waccPercent: publicQuery.wacc_percent,
    terminalGrowthPercent: publicQuery.terminal_growth_percent,
    solveRange: {
      minimumPercent: publicQuery.solve_range.minimum_percent,
      maximumPercent: publicQuery.solve_range.maximum_percent,
    },
    solveFor: "revenue_cagr",
    operatingFacts: { baseRevenueTwd: VALUES.revenue },
    operatingAssumptions: {
      marginPolicy: "constant_normalized",
      normalizedOperatingMarginPercent:
        publicQuery.forward_assumptions.normalized_operating_margin_percent,
      cashTaxRatePercent:
        publicQuery.forward_assumptions.cash_tax_rate_percent,
      salesToCapitalRatio:
        publicQuery.forward_assumptions.sales_to_capital_ratio,
    },
    factProvenance: factProvenance(),
  };
  const modeledEnterpriseValue = evaluateReverseDcfAt(calibration, 8)
    .presentValue.modeledEnterpriseValueTwd;
  const equityValue =
    modeledEnterpriseValue -
    VALUES.debt -
    BRIDGE.non_controlling_interests_twd -
    BRIDGE.preferred_equity_twd -
    BRIDGE.pension_deficit_twd -
    BRIDGE.other_debt_like_items_twd +
    VALUES.cash +
    BRIDGE.non_operating_assets_twd;
  return equityValue / VALUES.shares;
}

function field(
  id: ValuationModelFieldId,
  value: number,
  unit: ValuationModelUnit,
  evidenceClass: Exclude<ValuationModelEvidenceClass, "UNAVAILABLE">,
  inputLineageIds: string[],
  status: "reported" | "derived" = "derived",
  inputFieldIds: ValuationModelFieldId[] = [],
): ValuationModelInputField {
  return {
    id,
    value,
    unit,
    status,
    evidenceClass,
    formula: status === "derived" ? `fixture_formula:${id}` : null,
    inputFieldIds,
    inputLineageIds,
    dataGapReason: null,
    notes: [`fixture ${id}`],
  };
}

function valuationInputs(closePriceTwd: number): ValuationModelInputsResult {
  const statementLineage = ["lineage-statement"];
  const fields = {
    ttmRevenue: field(
      "ttmRevenue",
      VALUES.revenue,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    ttmOperatingIncomeEbitProxy: field(
      "ttmOperatingIncomeEbitProxy",
      VALUES.operatingIncome,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    cashTaxRatePercent: field(
      "cashTaxRatePercent",
      20,
      "percent",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    ttmDepreciationAndAmortization: field(
      "ttmDepreciationAndAmortization",
      80_000_000,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    ttmCapitalExpenditure: field(
      "ttmCapitalExpenditure",
      90_000_000,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    ttmDeltaNetWorkingCapital: field(
      "ttmDeltaNetWorkingCapital",
      50_000_000,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    normalizedFcff: field(
      "normalizedFcff",
      VALUES.fcff,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    cashAndCashEquivalents: field(
      "cashAndCashEquivalents",
      VALUES.cash,
      "TWD",
      "MOPSFIN_RAW",
      statementLineage,
      "reported",
    ),
    interestBearingDebt: field(
      "interestBearingDebt",
      VALUES.debt,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
    ),
    netDebt: field(
      "netDebt",
      VALUES.debt - VALUES.cash,
      "TWD",
      "MOPSFIN_CALC",
      statementLineage,
      "derived",
      ["interestBearingDebt", "cashAndCashEquivalents"],
    ),
    issuedShares: field(
      "issuedShares",
      VALUES.shares,
      "share",
      "OFFICIAL_MASTER_RAW",
      ["lineage-master"],
      "reported",
    ),
    latestOfficialClose: field(
      "latestOfficialClose",
      closePriceTwd,
      "TWD_per_share",
      "OFFICIAL_MARKET_RAW",
      ["lineage-market"],
      "reported",
    ),
    marketCapitalization: field(
      "marketCapitalization",
      closePriceTwd * VALUES.shares,
      "TWD",
      "OFFICIAL_CALC",
      ["lineage-master", "lineage-market"],
      "derived",
      ["issuedShares", "latestOfficialClose"],
    ),
    enterpriseValue: field(
      "enterpriseValue",
      closePriceTwd * VALUES.shares + VALUES.debt - VALUES.cash,
      "TWD",
      "MIXED_OFFICIAL_CALC",
      ["lineage-master", "lineage-market", "lineage-statement"],
      "derived",
      [
        "marketCapitalization",
        "interestBearingDebt",
        "cashAndCashEquivalents",
      ],
    ),
  } satisfies ValuationModelInputsResult["fields"];

  return {
    query: {
      companyCode: "2330",
      financialPeriod: "latest",
      priceDate: "latest_completed_official_session",
    },
    generatedAt: VALUATION_GENERATED_AT,
    timezone: "Asia/Taipei",
    currency: "TWD",
    scope: "normalized_valuation_model_inputs",
    posture: "research_model_input_evidence_only",
    applicability: { status: "applicable", reason: null },
    company: {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      shortName: "台積電",
      market: "listed",
      exchange: "TWSE",
      industryCode: "24",
      isFinancial: false,
    },
    periods: {
      latestReportedPeriod: "2026Q2",
      ttmMethod: "current_ytd_plus_prior_fy_minus_prior_year_ytd",
      currentYtdPeriod: "2026Q2",
      priorFiscalYearPeriod: "2025Q4",
      priorYearYtdPeriod: "2025Q2",
      fiscalYearBasis: "mopsfin_calendar_year_quarters",
      consolidationScope: "consolidated",
    },
    fields,
    lineage: [
      {
        lineageId: "lineage-statement",
        role: "fixture_statement_rows",
        status: "resolved",
        sourceId: "source-statement",
        statement: "income_statement",
        period: "2026Q2",
        rowLabel: "fixture",
        rawValue: "fixture",
        normalizedValue: VALUES.revenue,
        unit: "TWD",
        candidateRowLabels: ["fixture"],
        notes: ["fixture statement lineage"],
      },
      {
        lineageId: "lineage-master",
        role: "issued_common_shares",
        status: "resolved",
        sourceId: "source-master",
        statement: null,
        period: "2026-08-28",
        rowLabel: "issuedCommonShares",
        rawValue: VALUES.shares,
        normalizedValue: VALUES.shares,
        unit: "share",
        candidateRowLabels: ["issuedCommonShares"],
        notes: ["fixture master lineage"],
      },
      {
        lineageId: "lineage-market",
        role: "latest_completed_official_close",
        status: "resolved",
        sourceId: "source-market",
        statement: null,
        period: "2026-08-27",
        rowLabel: "closePriceTwd",
        rawValue: closePriceTwd,
        normalizedValue: closePriceTwd,
        unit: "TWD_per_share",
        candidateRowLabels: ["closePriceTwd"],
        notes: ["fixture official close lineage"],
      },
    ],
    sources: [
      {
        sourceId: "source-statement",
        stage: "statement",
        sourceName: "Mopsfin fixture",
        sourceUrl: "https://mopsfin.twse.com.tw/",
        retrievedAt: "2026-08-28T01:02:00.000Z",
        cache: {
          status: "hit",
          observedAt: "2026-08-28T01:04:30.000Z",
          storedAt: "2026-08-28T01:02:00.000Z",
          ageMs: 150_000,
          ttlMs: 300_000,
        },
        upstreamRoute: "/compare/report",
        statement: "income_statement",
        period: "2026Q2",
        asOf: "2026Q2",
        asOfGranularity: "quarter",
        reportName: "2330 台積電(上市半導體業)",
        rawUnit: "新台幣仟元",
        unitSource: "response_html",
        normalizedUnit: "TWD",
        amountMultiplier: 1000,
        consolidationScope: "consolidated",
      },
      {
        sourceId: "source-master",
        stage: "company_master",
        market: "listed",
        exchange: "TWSE",
        sourceName: "TWSE company master fixture",
        sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
        retrievedAt: "2026-08-28T01:03:00.000Z",
        cache: {
          status: "miss",
          observedAt: "2026-08-28T01:03:00.000Z",
          storedAt: "2026-08-28T01:03:00.000Z",
          ageMs: 0,
          ttlMs: 300_000,
        },
        reportDate: "2026-08-28",
        asOf: "2026-08-28",
        asOfGranularity: "date",
      },
      {
        sourceId: "source-market",
        stage: "market_valuation",
        market: "listed",
        exchange: "TWSE",
        sourceName: "TWSE exact-day valuation fixture",
        sourceUrl: "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d",
        retrievedAt: "2026-08-28T01:04:00.000Z",
        cache: {
          status: "bypass",
          observedAt: "2026-08-28T01:04:00.000Z",
          storedAt: null,
          ageMs: null,
          ttlMs: null,
        },
        dataDate: "2026-08-27",
        asOf: "2026-08-27",
        asOfGranularity: "date",
      },
    ],
    quality: {
      calculationComplete: true,
      dataGapFields: [],
      notApplicableFields: [],
    },
    workBudget: {
      requestedCompanies: 1,
      orchestrationCompanyMasterCalls: 1,
      statementCalls: { actual: 1, maximum: 7, rowsPerCallMaximum: 500 },
      valuationDependencyCalls: {
        actual: 1,
        maximum: 1,
        internalCurrentMasterPolicy: "compatible",
        minimumCurrentMasterMatchRatio: 0.95,
        selectedCompanyIdentityPolicy:
          "outer_market_all_master_plus_official_row_exact",
      },
    },
    warnings: [
      "歷史財報是目前可見版本，不是各 filing date 當時的 point-in-time vintage。",
    ],
  };
}

async function orchestrationFixture(): Promise<ReverseDcfOrchestrationResult> {
  const publicQuery = query();
  const dependency = {
    getValuationModelInputs: vi.fn(async () =>
      valuationInputs(calibratedClose(publicQuery)),
    ),
  };
  const client = new ReverseDcfMcpClient(
    dependency,
    () => new Date(GENERATED_AT),
  );
  return client.runReverseDcf(publicQuery);
}

describe("run_reverse_dcf public MCP tool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SERVED_AT));
    vi.spyOn(completedSessionResolver, "resolve").mockResolvedValue(
      completedSessionEvidenceFixture({ status: "unresolved" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns a schema-valid envelope with source-specific provenance and conservative quality", async () => {
    const fixture = await orchestrationFixture();
    vi.spyOn(reverseDcfMcpClient, "runReverseDcf").mockResolvedValue(fixture);

    const result = await runReverseDcfTool.handler(
      query(),
      {} as Parameters<typeof runReverseDcfTool.handler>[1],
    );
    const envelope = reverseDcfOutputSchema.parse(result.structuredContent);

    expect(runReverseDcfTool.config.outputSchema).toBe(reverseDcfOutputSchema);
    expect(envelope.meta.asOf).toMatchObject({
      selector: "latest",
      resolved: { granularity: "mixed", from: null, through: null },
      servedAt: SERVED_AT,
    });
    expect(envelope.meta.asOf.sourceCutoffs).toHaveLength(
      envelope.sources.length,
    );
    for (const source of envelope.sources) {
      const cutoff = envelope.meta.asOf.sourceCutoffs.find(
        (candidate) =>
          candidate.sourceUrl === source.sourceUrl &&
          candidate.retrievedAt === source.retrievedAt,
      );
      expect(cutoff).toMatchObject({
        sourceUrl: source.sourceUrl,
        resolved: {
          granularity: source.asOfGranularity,
          from: source.asOf,
          through: source.asOf,
        },
        retrievedAt: source.retrievedAt,
        cache: source.cache,
      });
    }

    const freshnessByPolicy = new Map(
      envelope.meta.quality.freshnessDetails.map((detail) => [
        detail.policyId,
        detail.status,
      ]),
    );
    expect(freshnessByPolicy.get("mopsfin.latest-unverified.v1")).toBe(
      "unknown",
    );
    expect(freshnessByPolicy.get("official.completed-session.v1")).toBe(
      "unknown",
    );
    expect(envelope.meta.quality).toMatchObject({
      status: "partial",
      source: "complete",
      universe: "verified",
      selection: "complete",
      values: "complete",
      freshness: "unknown",
    });

    const servedAt = Date.parse(envelope.meta.asOf.servedAt);
    const generatedAt = Date.parse(envelope.generatedAt);
    const valuationGeneratedAt = Date.parse(
      envelope.normalizedInputEvidence.valuationModelGeneratedAt,
    );
    expect(servedAt).toBeGreaterThanOrEqual(generatedAt);
    expect(generatedAt).toBeGreaterThanOrEqual(valuationGeneratedAt);
    for (const source of envelope.sources) {
      expect(valuationGeneratedAt).toBeGreaterThanOrEqual(
        Date.parse(source.retrievedAt),
      );
    }

    expect(envelope.meta.quality.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "MARKET_IMPLIED_NOT_TARGET_PRICE",
        "CALLER_ASSUMPTIONS_EXPLICIT",
        "EV_BRIDGE_CALLER_ASSUMPTIONS",
        "FRESHNESS_UNVERIFIED",
      ]),
    );
  });

  it("converts orchestration failures to the shared structured error envelope", async () => {
    vi.spyOn(reverseDcfMcpClient, "runReverseDcf").mockRejectedValue(
      new MopsfinError("NO_DATA", "fixture normalized inputs are incomplete", {
        reason: "DATA_GAP",
        category: "no_data",
        retryable: false,
        action: "change_query",
        details: { companyCode: "2330", fields: ["ttmRevenue"] },
      }),
    );

    const result = await runReverseDcfTool.handler(
      query(),
      {} as Parameters<typeof runReverseDcfTool.handler>[1],
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "NO_DATA",
          reason: "DATA_GAP",
          category: "no_data",
          retryable: false,
          action: "change_query",
          details: { companyCode: "2330", fields: ["ttmRevenue"] },
        },
      },
    });
    expect(reverseDcfOutputSchema.safeParse(result.structuredContent).success).toBe(
      false,
    );
  });
});
