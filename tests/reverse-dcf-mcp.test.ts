import { describe, expect, it, vi } from "vitest";

import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import {
  reverseDcfDataSchema,
  reverseDcfInputSchema,
  reverseDcfOutputSchema,
} from "@/lib/mcp/schema/reverse-dcf";
import {
  ReverseDcfMcpClient,
  mapReverseDcfEngineError,
  type ReverseDcfPublicQuery,
} from "@/lib/reverse-dcf/mcp-client";
import {
  evaluateReverseDcfAt,
  ReverseDcfError,
  type ReverseDcfFactProvenance,
  type ReverseDcfInput,
} from "@/lib/reverse-dcf";
import type {
  ValuationModelFieldId,
  ValuationModelInputField,
  ValuationModelInputsResult,
  ValuationModelUnit,
} from "@/lib/valuation-model/types";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";

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

function field(
  id: ValuationModelFieldId,
  value: number,
  unit: ValuationModelUnit,
  evidenceClass: Exclude<
    ValuationModelInputField["evidenceClass"],
    "UNAVAILABLE"
  >,
  lineageIds: string[],
  status: "reported" | "derived" = "derived",
): ValuationModelInputField {
  return {
    id,
    value,
    unit,
    status,
    evidenceClass,
    formula: status === "derived" ? `fixture_formula:${id}` : null,
    inputFieldIds: [],
    inputLineageIds: lineageIds,
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
    ),
    enterpriseValue: field(
      "enterpriseValue",
      closePriceTwd * VALUES.shares + VALUES.debt - VALUES.cash,
      "TWD",
      "MIXED_OFFICIAL_CALC",
      ["lineage-master", "lineage-market", "lineage-statement"],
    ),
  } satisfies ValuationModelInputsResult["fields"];
  return {
    query: {
      companyCode: "2330",
      financialPeriod: "latest",
      priceDate: "latest_completed_official_session",
    },
    generatedAt: "2026-08-28T01:05:00.000Z",
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
        reportDate: "2026-08-28",
        asOf: "2026-08-28",
        asOfGranularity: "date",
      },
      {
        sourceId: "source-market",
        stage: "latest_official_completed_close",
        companyCode: "2330",
        market: "listed",
        exchange: "TWSE",
        sourceName: "TWSE exact single-stock OHLC fixture",
        sourceUrl: "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260801&stockNo=2330&response=json",
        retrievedAt: "2026-08-28T01:04:00.000Z",
        snapshotIdentity: "verified",
        dataMonth: "2026-08",
        selectedBarDate: "2026-08-27",
        observedName: "台積電",
        normalization: {
          volumeShares: { sourceUnit: "share", outputUnit: "share", multiplier: 1 },
          turnoverTwd: { sourceUnit: "TWD", outputUnit: "TWD", multiplier: 1 },
          tradeCount: { sourceUnit: "trade", outputUnit: "trade", multiplier: 1 },
        },
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
      statementCalls: { actual: 7, maximum: 7, rowsPerCallMaximum: 500 },
      authoritativeCompletedCloseCalls: {
        actual: 1,
        maximum: 1,
        completedSessionResolver: {
          actualLogicalLoads: 2,
          maximumLogicalLoads: 2,
        },
        exactStockOhlcAttempts: {
          actual: 1,
          maximum: 2,
          cacheRefreshPerformed: false,
        },
      },
    },
    warnings: [
      "歷史財報是目前可見版本，不是各 filing date 當時的 point-in-time vintage。",
    ],
  };
}

function revenueQuery(): ReverseDcfPublicQuery {
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

function fcffQuery(): ReverseDcfPublicQuery {
  return {
    company_code: "2330",
    price_source: "latest_completed_close",
    forecast_years: 5,
    wacc_percent: 9,
    terminal_growth_percent: 2,
    solve_for: "fcff_cagr",
    solve_range: { minimum_percent: -20, maximum_percent: 30 },
    enterprise_value_bridge: { ...BRIDGE },
    forward_assumptions: {},
  };
}

function marginQuery(): ReverseDcfPublicQuery {
  return {
    company_code: "2330",
    price_source: "latest_completed_close",
    forecast_years: 5,
    wacc_percent: 9,
    terminal_growth_percent: 2,
    solve_for: "terminal_operating_margin",
    solve_range: { minimum_percent: 5, maximum_percent: 40 },
    enterprise_value_bridge: { ...BRIDGE },
    forward_assumptions: {
      revenue_cagr_percent: 5,
      cash_tax_rate_percent: 20,
      sales_to_capital_ratio: 2,
    },
  };
}

function provenance(solveFor: ReverseDcfInput["solveFor"]): ReverseDcfFactProvenance[] {
  const ids = [
    "company.companyCode",
    "company.isFinancial",
    "marketFacts.observedPricePerShareTwd",
    "marketFacts.observedPriceDate",
    "marketFacts.sharesOutstanding",
    "marketFacts.shareCountBasis",
    "marketFacts.cashAndCashEquivalentsTwd",
    "marketFacts.nonOperatingAssetsTwd",
    "marketFacts.interestBearingDebtTwd",
    "marketFacts.leaseLiabilitiesTwd",
    "marketFacts.nonControllingInterestsTwd",
    "marketFacts.preferredEquityTwd",
    "marketFacts.pensionDeficitTwd",
    "marketFacts.otherDebtLikeItemsTwd",
    solveFor === "fcff_cagr"
      ? "operatingFacts.baseFcffTwd"
      : "operatingFacts.baseRevenueTwd",
    ...(solveFor === "terminal_operating_margin"
      ? ["operatingFacts.baseOperatingMarginPercent"]
      : []),
  ];
  const callerIds = new Set([
    "marketFacts.nonOperatingAssetsTwd",
    "marketFacts.nonControllingInterestsTwd",
    "marketFacts.preferredEquityTwd",
    "marketFacts.pensionDeficitTwd",
    "marketFacts.otherDebtLikeItemsTwd",
  ]);
  return ids.map((id) => ({
    id,
    evidenceClass: callerIds.has(id)
      ? "CALLER_ASSUMPTION"
      : id.includes("observedPrice")
        ? "OFFICIAL_MARKET_RAW"
        : id.includes("shares") || id === "marketFacts.shareCountBasis"
          ? "OFFICIAL_MASTER_RAW"
          : "MOPSFIN_CALC",
    lineageIds: callerIds.has(id) ? [] : [`calibration:${id}`],
  }));
}

function calibrationInput(query: ReverseDcfPublicQuery): ReverseDcfInput {
  const common = {
    company: { companyCode: "2330", isFinancial: false },
    currency: "TWD" as const,
    marketFacts: {
      observedPricePerShareTwd: 100,
      observedPriceDate: "2026-08-27",
      sharesOutstanding: VALUES.shares,
      shareCountBasis: "issued_common_shares" as const,
      cashAndCashEquivalentsTwd: VALUES.cash,
      nonOperatingAssetsTwd: BRIDGE.non_operating_assets_twd,
      interestBearingDebtTwd: VALUES.debt,
      leaseLiabilitiesTwd: 0,
      nonControllingInterestsTwd: BRIDGE.non_controlling_interests_twd,
      preferredEquityTwd: BRIDGE.preferred_equity_twd,
      pensionDeficitTwd: BRIDGE.pension_deficit_twd,
      otherDebtLikeItemsTwd: BRIDGE.other_debt_like_items_twd,
    },
    forecastYears: query.forecast_years,
    waccPercent: query.wacc_percent,
    terminalGrowthPercent: query.terminal_growth_percent,
    solveRange: {
      minimumPercent: query.solve_range.minimum_percent,
      maximumPercent: query.solve_range.maximum_percent,
    },
    factProvenance: provenance(query.solve_for),
  };
  if (query.solve_for === "fcff_cagr") {
    return {
      ...common,
      solveFor: "fcff_cagr",
      operatingFacts: { baseFcffTwd: VALUES.fcff },
      operatingAssumptions: { growthPolicy: "constant_compounded" },
    };
  }
  if (query.solve_for === "revenue_cagr") {
    return {
      ...common,
      solveFor: "revenue_cagr",
      operatingFacts: { baseRevenueTwd: VALUES.revenue },
      operatingAssumptions: {
        marginPolicy: "constant_normalized",
        normalizedOperatingMarginPercent:
          query.forward_assumptions.normalized_operating_margin_percent,
        cashTaxRatePercent: query.forward_assumptions.cash_tax_rate_percent,
        salesToCapitalRatio: query.forward_assumptions.sales_to_capital_ratio,
      },
    };
  }
  return {
    ...common,
    solveFor: "terminal_operating_margin",
    operatingFacts: {
      baseRevenueTwd: VALUES.revenue,
      baseOperatingMarginPercent:
        (VALUES.operatingIncome / VALUES.revenue) * 100,
    },
    operatingAssumptions: {
      revenueCagrPercent: query.forward_assumptions.revenue_cagr_percent,
      cashTaxRatePercent: query.forward_assumptions.cash_tax_rate_percent,
      salesToCapitalRatio: query.forward_assumptions.sales_to_capital_ratio,
      marginTransition: "linear_from_base_to_terminal",
    },
  };
}

function calibratedClose(query: ReverseDcfPublicQuery, solvedValue: number): number {
  const input = calibrationInput(query);
  const modeledEnterpriseValue = evaluateReverseDcfAt(input, solvedValue)
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

function completedCloseContext(
  close: number,
  date = "2026-08-27",
): AuthoritativeCompletedCloseResult {
  const resolverEvidence = completedSessionEvidenceFixture({
    expectedAsOf: date,
  });
  resolverEvidence.evaluatedAt = "2026-08-28T01:00:00.000Z";
  for (const resolution of resolverEvidence.marketResolutions) {
    for (const source of resolution.sources) {
      source.retrievedAt = "2026-08-28T01:01:00.000Z";
      source.cache = {
        status: "miss",
        observedAt: "2026-08-28T01:01:00.000Z",
        storedAt: "2026-08-28T01:01:00.000Z",
        ageMs: 0,
        ttlMs: 300_000,
      };
    }
  }
  const bar = {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volumeShares: 1_000,
    turnoverTwd: close * 1_000,
    tradeCount: 10,
    change: 0,
    changeMarker: null,
    market: "listed" as const,
    status: "traded" as const,
    qualityStatus: "complete" as const,
    missingFields: [],
  };
  return {
    query: {
      companyCode: "2330",
      market: "listed",
      evaluatedAt: resolverEvidence.evaluatedAt,
    },
    company: {
      code: "2330",
      shortName: "台積電",
      market: "listed",
      exchange: "TWSE",
    },
    expectedAsOf: date,
    selectedBarDate: date,
    close,
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    bar,
    source: {
      companyCode: "2330",
      market: "listed",
      exchange: "TWSE",
      sourceName: "TWSE exact single-stock OHLC fixture",
      sourceUrl: `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${date.slice(0, 7).replace("-", "")}01&stockNo=2330&response=json`,
      retrievedAt: "2026-08-28T01:04:00.000Z",
      snapshotIdentity: "verified",
      dataMonth: date.slice(0, 7),
      normalization: {
        volumeShares: { sourceUnit: "share", outputUnit: "share", multiplier: 1 },
        turnoverTwd: { sourceUnit: "TWD", outputUnit: "TWD", multiplier: 1 },
        tradeCount: { sourceUnit: "trade", outputUnit: "trade", multiplier: 1 },
      },
      observedName: "台積電",
      selectedBarDate: date,
    },
    resolverEvidence,
    cacheRefresh: { attempted: false, initialCacheStatus: "miss" },
    workBudget: {
      scope: "authoritative_completed_close_routing",
      completedSessionResolver: resolverEvidence.workBudget,
      exactStockOhlcAttempts: {
        actual: 1,
        maximum: 2,
        cacheRefreshPerformed: false,
      },
    },
  };
}

function clientWith(inputs: ValuationModelInputsResult) {
  const closeSource = inputs.sources.find(
    (source) => source.stage === "latest_official_completed_close",
  );
  const completedClose = completedCloseContext(
    inputs.fields.latestOfficialClose.value ?? 1,
    closeSource?.selectedBarDate,
  );
  const dependency = {
    getValuationModelInputsWithContext: vi.fn(async () => ({
      data: inputs,
      completedClose,
      completedCloseError: null,
    })),
  };
  return {
    client: new ReverseDcfMcpClient(
      dependency,
      () => new Date("2026-08-28T02:00:00.000Z"),
    ),
    dependency,
  };
}

const INVALID_APPLICABILITY_CASES: Array<
  [string, (inputs: ValuationModelInputsResult) => void]
> = [
  [
    "applicable with a non-null financial-model reason",
    (inputs) => {
      inputs.applicability = {
        status: "applicable",
        reason:
          "financial_company_requires_residual_income_or_dividend_model",
      };
      inputs.company.isFinancial = false;
    },
  ],
  [
    "not_applicable for a non-financial company",
    (inputs) => {
      inputs.applicability = {
        status: "not_applicable",
        reason:
          "financial_company_requires_residual_income_or_dividend_model",
      };
      inputs.company.isFinancial = false;
    },
  ],
  [
    "applicable for a financial company",
    (inputs) => {
      inputs.applicability = { status: "applicable", reason: null };
      inputs.company.isFinancial = true;
    },
  ],
];

async function captureMopsfinError(
  operation: () => Promise<unknown>,
): Promise<MopsfinError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MopsfinError);
    return error as MopsfinError;
  }
  throw new Error("Expected MopsfinError");
}

interface JsonSchemaNode {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
}

function missingDescriptions(
  schema: JsonSchemaNode | undefined,
  path: string,
): string[] {
  if (!schema) return [`${path}:missing-schema`];
  const missing: string[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const propertyPath = `${path}.${name}`;
    if (!property.description?.trim()) missing.push(propertyPath);
    missing.push(...missingDescriptionsInChildren(property, propertyPath));
  }
  return missing;
}

function missingDescriptionsInChildren(
  schema: JsonSchemaNode,
  path: string,
): string[] {
  const missing = missingDescriptions(schema, path);
  if (schema.items) {
    missing.push(...missingDescriptions(schema.items, `${path}[]`));
    missing.push(...missingDescriptionsInCompositions(schema.items, `${path}[]`));
  }
  missing.push(...missingDescriptionsInCompositions(schema, path));
  return missing;
}

function missingDescriptionsInCompositions(
  schema: JsonSchemaNode,
  path: string,
): string[] {
  return [schema.anyOf, schema.oneOf, schema.allOf]
    .flatMap((composition) => composition ?? [])
    .flatMap((child, index) => [
      ...missingDescriptions(child, `${path}.variant${index}`),
      ...missingDescriptionsInChildren(child, `${path}.variant${index}`),
    ]);
}

describe("ReverseDcfMcpClient", () => {
  it("uses the same 2026-08-28 exact close 2420 context without resolving or fetching another price", async () => {
    const inputs = valuationInputs(2_420);
    const closeSource = inputs.sources.find(
      (source) => source.stage === "latest_official_completed_close",
    );
    if (!closeSource) throw new Error("fixture completed-close source missing");
    closeSource.selectedBarDate = "2026-08-28";
    closeSource.asOf = "2026-08-28";
    inputs.lineage.find(
      (entry) => entry.role === "latest_completed_official_close",
    )!.period = "2026-08-28";
    const completedClose = completedCloseContext(2_420, "2026-08-28");
    const dependency = {
      getValuationModelInputsWithContext: vi.fn(async () => ({
        data: inputs,
        completedClose,
        completedCloseError: null,
      })),
    };
    const client = new ReverseDcfMcpClient(
      dependency,
      () => new Date("2026-08-28T02:00:00.000Z"),
    );
    const publicQuery = fcffQuery();
    publicQuery.solve_range = { minimum_percent: -99, maximum_percent: 500 };

    const execution = await client.runReverseDcfWithContext(publicQuery);

    expect(dependency.getValuationModelInputsWithContext).toHaveBeenCalledTimes(1);
    expect(execution.completedClose).toBe(completedClose);
    expect(execution.data.model.bridge.observedPricePerShareTwd).toBe(2_420);
    expect(
      execution.data.model.evidence.inputFacts.find(
        (fact) => fact.id === "marketFacts.observedPriceDate",
      )?.value,
    ).toBe("2026-08-28");
  });

  it.each([
    ["revenue CAGR", revenueQuery(), 8],
    ["FCFF CAGR", fcffQuery(), 6],
    ["terminal operating margin", marginQuery(), 24],
  ] as const)("orchestrates %s with traceable normalized evidence", async (_label, query, solvedValue) => {
    const close = calibratedClose(query, solvedValue);
    const { client, dependency } = clientWith(valuationInputs(close));

    const result = await client.runReverseDcf(query);

    expect(dependency.getValuationModelInputsWithContext).toHaveBeenCalledWith({
      companyCode: "2330",
    });
    expect(result.model.solution.solveFor).toBe(query.solve_for);
    expect(result.model.solution.solvedValuePercent).toBeCloseTo(solvedValue, 7);
    expect(result.model.bridge.plusInterestBearingDebtTwd).toBe(VALUES.debt);
    expect(result.model.bridge.plusLeaseLiabilitiesTwd).toBe(0);
    expect(result.workBudget.sensitivityCells).toEqual({
      requested: 0,
      maximum: 25,
    });
    const mappingIds = new Set(
      result.normalizedInputEvidence.factMappings.map(
        (mapping) => mapping.mappingId,
      ),
    );
    expect(
      result.model.evidence.inputFacts.every((fact) =>
        fact.lineageIds.every((lineageId) => mappingIds.has(lineageId)),
      ),
    ).toBe(true);
    expect(reverseDcfDataSchema.safeParse(result)).toMatchObject({
      success: true,
    });
  });

  it("keeps aggregate debt lease roles from being double counted and preserves evidence classes", async () => {
    const query = revenueQuery();
    const { client } = clientWith(valuationInputs(calibratedClose(query, 8)));

    const result = await client.runReverseDcf(query);

    const lease = result.normalizedInputEvidence.factMappings.find(
      (mapping) => mapping.engineFactId === "marketFacts.leaseLiabilitiesTwd",
    );
    expect(lease).toMatchObject({
      evidenceClass: "MOPSFIN_CALC",
      origin: "aggregate_debt_bridge_normalization",
      originFieldIds: ["interestBearingDebt"],
    });
    expect(lease?.transformation).toContain("already included");
    expect(lease?.upstreamLineageIds).toEqual(["lineage-statement"]);
    expect(result.model.evidence.inputFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "marketFacts.observedPricePerShareTwd",
          evidenceClass: "OFFICIAL_MARKET_RAW",
        }),
        expect.objectContaining({
          id: "marketFacts.sharesOutstanding",
          evidenceClass: "OFFICIAL_MASTER_RAW",
        }),
        expect.objectContaining({
          id: "marketFacts.interestBearingDebtTwd",
          evidenceClass: "MOPSFIN_CALC",
        }),
      ]),
    );
    const bridgeAssumptions = new Set(
      result.model.evidence.assumptions.map((item) => item.id),
    );
    for (const id of [
      "marketFacts.nonOperatingAssetsTwd",
      "marketFacts.nonControllingInterestsTwd",
      "marketFacts.preferredEquityTwd",
      "marketFacts.pensionDeficitTwd",
      "marketFacts.otherDebtLikeItemsTwd",
    ]) {
      expect(bridgeAssumptions.has(id)).toBe(true);
    }
  });

  it("fails closed with DATA_GAP and never zero-fills a required normalized valuation-model field", async () => {
    const query = revenueQuery();
    const inputs = valuationInputs(calibratedClose(query, 8));
    inputs.fields.ttmRevenue = {
      ...inputs.fields.ttmRevenue,
      value: null,
      status: "data_gap",
      evidenceClass: "UNAVAILABLE",
      formula: null,
      dataGapReason: "TTM_COMPONENT_UNAVAILABLE",
    };
    const { client } = clientWith(inputs);

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(query),
    );

    expect(error).toMatchObject({
      code: "NO_DATA",
      reason: "DATA_GAP",
      action: "change_query",
    });
    expect(error.details).toMatchObject({
      companyCode: "2330",
      fields: [
        {
          id: "ttmRevenue",
          status: "data_gap",
          dataGapReason: "TTM_COMPONENT_UNAVAILABLE",
        },
      ],
    });
  });

  it("preserves a retryable completed-close failure instead of relabeling it as a data gap", async () => {
    const inputs = valuationInputs(100);
    const completedCloseError = new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "completed-session marker is temporarily unavailable",
      {
        reason: "COMPLETED_SESSION_UNRESOLVED",
        category: "upstream",
        retryable: true,
        action: "retry",
      },
    );
    const client = new ReverseDcfMcpClient({
      getValuationModelInputsWithContext: vi.fn(async () => ({
        data: inputs,
        completedClose: null,
        completedCloseError,
      })),
    });

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(fcffQuery()),
    );

    expect(error).toBe(completedCloseError);
    expect(error).toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_SESSION_UNRESOLVED",
      retryable: true,
      action: "retry",
    });
  });

  it("rejects a sourced but non-viable FCFF base without relabeling it as a data gap", async () => {
    const inputs = valuationInputs(100);
    inputs.fields.normalizedFcff.value = 0;
    const { client } = clientWith(inputs);

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(fcffQuery()),
    );

    expect(error).toMatchObject({
      code: "NO_DATA",
      reason: "MODEL_BASE_NOT_VIABLE",
      category: "no_data",
      retryable: false,
      action: "change_query",
      details: {
        fieldId: "normalizedFcff",
        value: 0,
        viabilityRule: "positive",
      },
    });
  });

  it("enforces normalized valuation-model field and source semantic contracts before running the model", async () => {
    const query = revenueQuery();
    const inputs = valuationInputs(calibratedClose(query, 8));
    inputs.fields.issuedShares.unit = "TWD";
    const { client } = clientWith(inputs);

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(query),
    );

    expect(error).toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "VALUATION_INPUT_CONTRACT_MISMATCH",
      category: "upstream",
      retryable: true,
      action: "retry",
    });
    expect(error.details).toMatchObject({
      companyCode: "2330",
      fieldId: "issuedShares",
      expected: {
        unit: "share",
        evidenceClass: "OFFICIAL_MASTER_RAW",
        sourceStage: "company_master",
      },
    });
  });

  it("requires strict provenance time ordering before model execution", async () => {
    const query = revenueQuery();
    const inputs = valuationInputs(calibratedClose(query, 8));
    inputs.sources[0] = {
      ...inputs.sources[0],
      retrievedAt: "2026-08-28T01:06:00.000Z",
    } as (typeof inputs.sources)[number];
    const { client } = clientWith(inputs);

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(query),
    );

    expect(error).toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "VALUATION_INPUT_CONTRACT_MISMATCH",
      action: "retry",
    });
  });

  it("rejects financial companies with stable NOT_APPLICABLE semantics", async () => {
    const inputs = valuationInputs(100);
    inputs.company.isFinancial = true;
    inputs.applicability = {
      status: "not_applicable",
      reason: "financial_company_requires_residual_income_or_dividend_model",
    };
    const { client } = clientWith(inputs);

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(revenueQuery()),
    );

    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "NOT_APPLICABLE_FINANCIAL_COMPANY",
      category: "input",
      retryable: false,
      action: "change_query",
    });
  });

  it.each(INVALID_APPLICABILITY_CASES)(
    "rejects invalid applicability contract: %s",
    async (_label, mutate) => {
      const inputs = valuationInputs(100);
      mutate(inputs);
      const { client } = clientWith(inputs);

      const error = await captureMopsfinError(() =>
        client.runReverseDcf(revenueQuery()),
      );

      expect(error).toMatchObject({
        code: "UPSTREAM_BAD_RESPONSE",
        reason: "VALUATION_INPUT_CONTRACT_MISMATCH",
        category: "upstream",
        retryable: true,
        action: "retry",
      });
      expect(error.details).toMatchObject({
        companyCode: "2330",
        isFinancial: inputs.company.isFinancial,
        applicability: inputs.applicability,
      });
    },
  );

  it("bounds sensitivity orchestration, keeps Cartesian order and discloses double-count guards", async () => {
    const query = revenueQuery();
    query.sensitivity_grids = {
      wacc_percent: [8, 10],
      terminal_growth_percent: [1, 2],
    };
    const { client } = clientWith(valuationInputs(calibratedClose(query, 8)));

    const result = await client.runReverseDcf(query);

    expect(result.workBudget).toMatchObject({
      reverseDcfEngineOrchestrations: { actual: 1, maximum: 1 },
      sensitivityCells: { requested: 4, maximum: 25 },
      solveAttempts: { actual: 5, maximum: 26 },
      modelEvaluationUpperBound: {
        perSolveAttempt: 323,
        forRequestedWork: 1615,
        maximum: 8398,
      },
    });
    expect(
      result.model.sensitivities.map((cell) => [
        cell.waccPercent,
        cell.terminalGrowthPercent,
      ]),
    ).toEqual([
      [8, 1],
      [8, 2],
      [10, 1],
      [10, 2],
    ]);
    expect(result.warnings.some((warning) => warning.includes("other_debt_like_items_twd"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("non_operating_assets_twd"))).toBe(true);
    expect(reverseDcfDataSchema.safeParse(result).success).toBe(true);

    const reordered = structuredClone(result);
    [reordered.model.sensitivities[0], reordered.model.sensitivities[1]] = [
      reordered.model.sensitivities[1] as (typeof reordered.model.sensitivities)[number],
      reordered.model.sensitivities[0] as (typeof reordered.model.sensitivities)[number],
    ];
    expect(reverseDcfDataSchema.safeParse(reordered).success).toBe(false);
  });

  it("maps model no-solution errors to caller INVALID_ARGUMENT without impersonating upstream", async () => {
    const query = revenueQuery();
    query.solve_range = { minimum_percent: 0, maximum_percent: 0.1 };
    const { client } = clientWith(valuationInputs(10_000));

    const error = await captureMopsfinError(() =>
      client.runReverseDcf(query),
    );

    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "NO_FEASIBLE_SOLUTION",
      category: "input",
      retryable: false,
      action: "change_query",
    });
    expect(error.details).toMatchObject({
      reverseDcfErrorCode: "NO_FEASIBLE_SOLUTION",
    });
  });

  it("keeps internal-contract and numerical failures out of caller input taxonomy", () => {
    expect(
      mapReverseDcfEngineError(
        new ReverseDcfError("MISSING_REQUIRED_INPUT", "missing fixture", {
          field: "operatingFacts.baseRevenueTwd",
        }),
      ),
    ).toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "ADAPTER_CONTRACT_MISMATCH",
      category: "upstream",
      retryable: false,
      action: "none",
    });
    expect(
      mapReverseDcfEngineError(
        new ReverseDcfError("NUMERICAL_FAILURE", "overflow fixture"),
      ),
    ).toMatchObject({
      code: "NO_DATA",
      reason: "MODEL_NUMERICAL_FAILURE",
      category: "no_data",
      retryable: false,
      action: "change_query",
    });
  });
});

describe("reverse DCF MCP schemas", () => {
  it("accepts all three mode-specific explicit assumption contracts", () => {
    expect(reverseDcfInputSchema.safeParse(revenueQuery()).success).toBe(true);
    expect(reverseDcfInputSchema.safeParse(fcffQuery()).success).toBe(true);
    expect(reverseDcfInputSchema.safeParse(marginQuery()).success).toBe(true);
  });

  it("rejects hidden assumptions, invalid rates, bounds, ranges and oversized grids", () => {
    const missingBridge = revenueQuery();
    const { preferred_equity_twd: _removed, ...partialBridge } =
      missingBridge.enterprise_value_bridge;
    const wrongModeAssumptions = {
      ...fcffQuery(),
      forward_assumptions: { cash_tax_rate_percent: 20 },
    };
    const invalidRate = {
      ...revenueQuery(),
      wacc_percent: 2,
      terminal_growth_percent: 2,
    };
    const invalidYears = { ...revenueQuery(), forecast_years: 21 };
    const invalidRange = {
      ...marginQuery(),
      solve_range: { minimum_percent: 40, maximum_percent: 5 },
    };
    const oversizedGrid = {
      ...revenueQuery(),
      sensitivity_grids: {
        wacc_percent: [8, 9, 10, 11, 12, 13],
        terminal_growth_percent: [1, 2],
      },
    };
    const duplicateGrid = {
      ...revenueQuery(),
      sensitivity_grids: {
        wacc_percent: [8, 8],
        terminal_growth_percent: [1, 2],
      },
    };

    expect(
      reverseDcfInputSchema.safeParse({
        ...missingBridge,
        enterprise_value_bridge: partialBridge,
      }).success,
    ).toBe(false);
    expect(reverseDcfInputSchema.safeParse(wrongModeAssumptions).success).toBe(
      false,
    );
    expect(reverseDcfInputSchema.safeParse(invalidRate).success).toBe(false);
    expect(reverseDcfInputSchema.safeParse(invalidYears).success).toBe(false);
    expect(reverseDcfInputSchema.safeParse(invalidRange).success).toBe(false);
    expect(reverseDcfInputSchema.safeParse(oversizedGrid).success).toBe(false);
    expect(reverseDcfInputSchema.safeParse(duplicateGrid).success).toBe(false);
    expect(
      reverseDcfInputSchema.safeParse({ ...revenueQuery(), unexpected: true })
        .success,
    ).toBe(false);
  });

  it("keeps cross-field refinements on the advertised success-envelope schema", async () => {
    const query = revenueQuery();
    query.sensitivity_grids = {
      wacc_percent: [query.wacc_percent],
      terminal_growth_percent: [query.terminal_growth_percent],
    };
    const { client } = clientWith(valuationInputs(calibratedClose(query, 8)));
    const result = await client.runReverseDcf(query);
    const validPayload = {
      ok: true as const,
      meta: buildResultMeta(
        result,
        {
          selector: "latest",
          resolved: { granularity: "mixed", from: null, through: null },
        },
        result.generatedAt,
      ),
      ...result,
    };
    const dataOnly = (payload: typeof validPayload) => {
      const { ok: _ok, meta: _meta, ...data } = payload;
      return data;
    };

    expect(reverseDcfOutputSchema.safeParse(validPayload).success).toBe(true);

    const tamperedBridge = structuredClone(validPayload);
    tamperedBridge.model.bridge.plusInterestBearingDebtTwd += 1;
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedBridge)).success).toBe(false);
    expect(reverseDcfOutputSchema.safeParse(tamperedBridge).success).toBe(false);

    const tamperedSources = structuredClone(validPayload);
    tamperedSources.sources = tamperedSources.sources.slice(1);
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedSources)).success).toBe(false);
    expect(reverseDcfOutputSchema.safeParse(tamperedSources).success).toBe(false);

    const impossibleTime = structuredClone(validPayload);
    impossibleTime.generatedAt = "2026-08-27T00:00:00.000Z";
    expect(reverseDcfDataSchema.safeParse(dataOnly(impossibleTime)).success).toBe(false);
    expect(reverseDcfOutputSchema.safeParse(impossibleTime).success).toBe(false);

    const tamperedPresentValue = structuredClone(validPayload);
    tamperedPresentValue.model.presentValue.explicitForecastTwd += 1_000;
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedPresentValue)).success).toBe(
      false,
    );
    expect(reverseDcfOutputSchema.safeParse(tamperedPresentValue).success).toBe(
      false,
    );

    const tamperedForecast = structuredClone(validPayload);
    tamperedForecast.model.forecast[0]!.year = 2;
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedForecast)).success).toBe(false);
    expect(reverseDcfOutputSchema.safeParse(tamperedForecast).success).toBe(
      false,
    );

    const tamperedAssumption = structuredClone(validPayload);
    const waccEvidence = tamperedAssumption.model.evidence.assumptions.find(
      (item) => item.id === "waccPercent",
    );
    expect(waccEvidence).toBeDefined();
    waccEvidence!.value = 99;
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedAssumption)).success).toBe(
      false,
    );
    expect(reverseDcfOutputSchema.safeParse(tamperedAssumption).success).toBe(
      false,
    );

    const tamperedAssumptionUnit = structuredClone(validPayload);
    const waccUnitEvidence =
      tamperedAssumptionUnit.model.evidence.assumptions.find(
        (item) => item.id === "waccPercent",
      );
    expect(waccUnitEvidence).toBeDefined();
    waccUnitEvidence!.unit = "TWD";
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedAssumptionUnit)).success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedAssumptionUnit).success,
    ).toBe(false);

    const tamperedModelOutputValue = structuredClone(validPayload);
    const modeledEvEvidence =
      tamperedModelOutputValue.model.evidence.modelOutputs.find(
        (item) => item.id === "presentValue.modeledEnterpriseValueTwd",
      );
    expect(modeledEvEvidence).toBeDefined();
    modeledEvEvidence!.value = (modeledEvEvidence!.value as number) + 1_000;
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedModelOutputValue))
        .success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedModelOutputValue).success,
    ).toBe(false);

    const tamperedModelOutputUnit = structuredClone(validPayload);
    const modeledEvUnitEvidence =
      tamperedModelOutputUnit.model.evidence.modelOutputs.find(
        (item) => item.id === "presentValue.modeledEnterpriseValueTwd",
      );
    expect(modeledEvUnitEvidence).toBeDefined();
    modeledEvUnitEvidence!.unit = "percent";
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedModelOutputUnit)).success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedModelOutputUnit).success,
    ).toBe(false);

    const tamperedModelOutputFormula = structuredClone(validPayload);
    const modeledEvFormulaEvidence =
      tamperedModelOutputFormula.model.evidence.modelOutputs.find(
        (item) => item.id === "presentValue.modeledEnterpriseValueTwd",
      );
    expect(modeledEvFormulaEvidence).toBeDefined();
    modeledEvFormulaEvidence!.formula = "forged_formula";
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedModelOutputFormula))
        .success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedModelOutputFormula).success,
    ).toBe(false);

    expect(validPayload.model.sensitivities[0]?.status).toBe("solved");
    const tamperedSensitivityBracket = structuredClone(validPayload);
    tamperedSensitivityBracket.model.sensitivities[0]!.solvedValuePercent =
      query.solve_range.maximum_percent + 1;
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedSensitivityBracket))
        .success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedSensitivityBracket).success,
    ).toBe(false);

    const tamperedSensitivityEv = structuredClone(validPayload);
    tamperedSensitivityEv.model.sensitivities[0]!.modeledEnterpriseValueTwd =
      (tamperedSensitivityEv.model.sensitivities[0]!
        .modeledEnterpriseValueTwd as number) + 1_000;
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedSensitivityEv)).success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedSensitivityEv).success,
    ).toBe(false);

    const tamperedSensitivityResidual = structuredClone(validPayload);
    tamperedSensitivityResidual.model.sensitivities[0]!.residualTwd =
      (tamperedSensitivityResidual.model.sensitivities[0]!
        .residualTwd as number) + 1_000;
    expect(
      reverseDcfDataSchema.safeParse(dataOnly(tamperedSensitivityResidual))
        .success,
    ).toBe(false);
    expect(
      reverseDcfOutputSchema.safeParse(tamperedSensitivityResidual).success,
    ).toBe(false);

    const tamperedCheck = structuredClone(validPayload);
    tamperedCheck.model.checks[0]!.value = false;
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedCheck)).success).toBe(false);
    expect(reverseDcfOutputSchema.safeParse(tamperedCheck).success).toBe(false);

    const tamperedInputFact = structuredClone(validPayload);
    const observedPriceFact = tamperedInputFact.model.evidence.inputFacts.find(
      (item) => item.id === "marketFacts.observedPricePerShareTwd",
    );
    expect(observedPriceFact).toBeDefined();
    observedPriceFact!.value =
      (observedPriceFact!.value as number) + 1;
    expect(reverseDcfDataSchema.safeParse(dataOnly(tamperedInputFact)).success).toBe(
      false,
    );
    expect(reverseDcfOutputSchema.safeParse(tamperedInputFact).success).toBe(
      false,
    );

    const prematureServedAt = structuredClone(validPayload);
    prematureServedAt.meta.asOf.servedAt = "2026-08-28T01:59:59.999Z";
    expect(reverseDcfDataSchema.safeParse(dataOnly(prematureServedAt)).success).toBe(true);
    expect(reverseDcfOutputSchema.safeParse(prematureServedAt).success).toBe(
      false,
    );
  });

  it("describes every nested input and output property advertised by tools/list", () => {
    const inputJson = reverseDcfInputSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
      reused: "inline",
    }) as JsonSchemaNode;
    const outputJson = reverseDcfOutputSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
      reused: "inline",
    }) as JsonSchemaNode;

    expect(inputJson.properties).toBeDefined();
    expect(Object.keys(inputJson.properties ?? {}).sort()).toEqual(
      [
        "company_code",
        "enterprise_value_bridge",
        "forecast_years",
        "forward_assumptions",
        "price_source",
        "sensitivity_grids",
        "solve_for",
        "solve_range",
        "terminal_growth_percent",
        "wacc_percent",
      ].sort(),
    );

    expect([
      ...missingDescriptions(inputJson, "input"),
      ...missingDescriptions(outputJson, "output"),
    ]).toEqual([]);
  });
});
