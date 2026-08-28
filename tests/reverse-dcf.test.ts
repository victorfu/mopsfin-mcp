import { describe, expect, it } from "vitest";

import {
  evaluateReverseDcfAt,
  REVERSE_DCF_MODEL_VERSION,
  ReverseDcfError,
  solveReverseDcf,
  type FcffCagrReverseDcfInput,
  type RevenueCagrReverseDcfInput,
  type ReverseDcfErrorCode,
  type ReverseDcfFactProvenance,
  type ReverseDcfInput,
  type ReverseDcfMarketFacts,
  type TerminalMarginReverseDcfInput,
} from "../lib/reverse-dcf";

const COMMON_FACT_IDS = [
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
] as const;

const CALLER_BRIDGE_ASSUMPTIONS = new Set([
  "marketFacts.nonOperatingAssetsTwd",
  "marketFacts.leaseLiabilitiesTwd",
  "marketFacts.nonControllingInterestsTwd",
  "marketFacts.preferredEquityTwd",
  "marketFacts.pensionDeficitTwd",
  "marketFacts.otherDebtLikeItemsTwd",
]);

function factProvenanceFor(
  solveFor: ReverseDcfInput["solveFor"],
): ReverseDcfFactProvenance[] {
  const operatingIds =
    solveFor === "fcff_cagr"
      ? ["operatingFacts.baseFcffTwd"]
      : [
          "operatingFacts.baseRevenueTwd",
          ...(solveFor === "terminal_operating_margin"
            ? ["operatingFacts.baseOperatingMarginPercent"]
            : []),
        ];
  return [...COMMON_FACT_IDS, ...operatingIds].map((id) => ({
    id,
    evidenceClass: CALLER_BRIDGE_ASSUMPTIONS.has(id)
      ? "CALLER_ASSUMPTION"
      : id === "marketFacts.observedPricePerShareTwd"
        ? "OFFICIAL_MARKET_RAW"
        : id === "marketFacts.sharesOutstanding" ||
            id === "marketFacts.shareCountBasis"
          ? "OFFICIAL_MASTER_RAW"
          : "MOPSFIN_CALC",
    lineageIds: CALLER_BRIDGE_ASSUMPTIONS.has(id)
      ? []
      : [`test-lineage:${id}`],
  }));
}

function marketFacts(): ReverseDcfMarketFacts {
  return {
    observedPricePerShareTwd: 100,
    observedPriceDate: "2026-08-28",
    sharesOutstanding: 10_000_000,
    shareCountBasis: "diluted_shares",
    cashAndCashEquivalentsTwd: 100_000_000,
    nonOperatingAssetsTwd: 20_000_000,
    interestBearingDebtTwd: 200_000_000,
    leaseLiabilitiesTwd: 20_000_000,
    nonControllingInterestsTwd: 10_000_000,
    preferredEquityTwd: 3_000_000,
    pensionDeficitTwd: 5_000_000,
    otherDebtLikeItemsTwd: 7_000_000,
  };
}

function revenueInput(
  overrides: Partial<RevenueCagrReverseDcfInput> = {},
): RevenueCagrReverseDcfInput {
  return {
    company: { companyCode: "2330", isFinancial: false },
    currency: "TWD",
    marketFacts: marketFacts(),
    forecastYears: 5,
    waccPercent: 9,
    terminalGrowthPercent: 2,
    solveFor: "revenue_cagr",
    solveRange: { minimumPercent: -10, maximumPercent: 30 },
    operatingFacts: { baseRevenueTwd: 1_000_000_000 },
    operatingAssumptions: {
      marginPolicy: "constant_normalized",
      normalizedOperatingMarginPercent: 20,
      cashTaxRatePercent: 20,
      salesToCapitalRatio: 2,
    },
    factProvenance: factProvenanceFor("revenue_cagr"),
    ...overrides,
  };
}

function fcffInput(
  overrides: Partial<FcffCagrReverseDcfInput> = {},
): FcffCagrReverseDcfInput {
  return {
    company: { companyCode: "2330", isFinancial: false },
    currency: "TWD",
    marketFacts: marketFacts(),
    forecastYears: 5,
    waccPercent: 9,
    terminalGrowthPercent: 2,
    solveFor: "fcff_cagr",
    solveRange: { minimumPercent: -20, maximumPercent: 30 },
    operatingFacts: { baseFcffTwd: 100_000_000 },
    operatingAssumptions: { growthPolicy: "constant_compounded" },
    factProvenance: factProvenanceFor("fcff_cagr"),
    ...overrides,
  };
}

function terminalMarginInput(
  overrides: Partial<TerminalMarginReverseDcfInput> = {},
): TerminalMarginReverseDcfInput {
  return {
    company: { companyCode: "2330", isFinancial: false },
    currency: "TWD",
    marketFacts: marketFacts(),
    forecastYears: 5,
    waccPercent: 9,
    terminalGrowthPercent: 2,
    solveFor: "terminal_operating_margin",
    solveRange: { minimumPercent: 5, maximumPercent: 40 },
    operatingFacts: {
      baseRevenueTwd: 1_000_000_000,
      baseOperatingMarginPercent: 12,
    },
    operatingAssumptions: {
      revenueCagrPercent: 5,
      cashTaxRatePercent: 20,
      salesToCapitalRatio: 2,
      marginTransition: "linear_from_base_to_terminal",
    },
    factProvenance: factProvenanceFor("terminal_operating_margin"),
    ...overrides,
  };
}

function calibratedToKnownSolution<T extends ReverseDcfInput>(
  input: T,
  solvedValuePercent: number,
): T {
  const evaluation = evaluateReverseDcfAt(input, solvedValuePercent);
  const facts = input.marketFacts;
  const debtLikeClaims =
    facts.interestBearingDebtTwd +
    facts.leaseLiabilitiesTwd +
    facts.nonControllingInterestsTwd +
    facts.preferredEquityTwd +
    facts.pensionDeficitTwd +
    facts.otherDebtLikeItemsTwd;
  const requiredEquityValue =
    evaluation.presentValue.modeledEnterpriseValueTwd -
    debtLikeClaims +
    facts.cashAndCashEquivalentsTwd +
    facts.nonOperatingAssetsTwd;
  if (requiredEquityValue <= 0) {
    throw new Error("Test calibration requires a positive observed equity value.");
  }
  return {
    ...input,
    marketFacts: {
      ...facts,
      observedPricePerShareTwd:
        requiredEquityValue / facts.sharesOutstanding,
    },
  };
}

function captureError(
  operation: () => unknown,
  code: ReverseDcfErrorCode,
): ReverseDcfError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ReverseDcfError);
    expect(error).toMatchObject({ code });
    return error as ReverseDcfError;
  }
  throw new Error(`Expected ReverseDcfError ${code}.`);
}

describe("pure reverse DCF engine", () => {
  it("solves market-implied revenue CAGR and exposes a recomputable FCFF model", () => {
    const input = calibratedToKnownSolution(revenueInput(), 8);

    const result = solveReverseDcf(input);

    expect(result.modelVersion).toBe(REVERSE_DCF_MODEL_VERSION);
    expect(result.solution.solveFor).toBe("revenue_cagr");
    expect(result.solution.solvedValuePercent).toBeCloseTo(8, 8);
    expect(result.solution.monotonicDirection).toBe("increasing");
    expect(result.presentValue.modeledEnterpriseValueTwd).toBeCloseTo(
      result.presentValue.targetEnterpriseValueTwd,
      2,
    );
    expect(result.forecast).toHaveLength(5);
    expect(result.forecast[0]?.revenueTwd).toBeCloseTo(1_080_000_000, 0);
    expect(result.forecast[0]?.fcffTwd).toBeCloseTo(132_800_000, 0);
    expect(result.sensitivities).toEqual([]);
    expect(result.posture).toBe(
      "research_model_output_not_investment_advice",
    );
    expect(new Set(result.evidence.inputFacts.map((item) => item.evidenceClass)))
      .toEqual(
        new Set([
          "MOPSFIN_CALC",
          "OFFICIAL_MARKET_RAW",
          "OFFICIAL_MASTER_RAW",
        ]),
      );
    expect(
      result.evidence.assumptions
        .filter((item) => item.id.startsWith("marketFacts."))
        .map((item) => item.id),
    ).toEqual([
      "marketFacts.nonOperatingAssetsTwd",
      "marketFacts.leaseLiabilitiesTwd",
      "marketFacts.nonControllingInterestsTwd",
      "marketFacts.preferredEquityTwd",
      "marketFacts.pensionDeficitTwd",
      "marketFacts.otherDebtLikeItemsTwd",
    ]);
    expect(
      result.evidence.assumptions.every(
        (item) => item.evidenceClass === "CALLER_ASSUMPTION",
      ),
    ).toBe(true);
    expect(
      result.evidence.modelOutputs.every(
        (item) => item.evidenceClass === "MODEL_OUTPUT",
      ),
    ).toBe(true);
  });

  it("solves market-implied FCFF CAGR with FCFF discounted only at WACC", () => {
    const input = calibratedToKnownSolution(fcffInput(), 6);

    const result = solveReverseDcf(input);

    expect(result.solution.solvedValuePercent).toBeCloseTo(6, 8);
    expect(result.solution.monotonicDirection).toBe("increasing");
    expect(result.cashFlowBasis).toBe("fcff");
    expect(result.discountRateBasis).toBe("wacc");
    expect(result.forecast[0]?.fcffTwd).toBeCloseTo(106_000_000, 0);
    expect(result.terminal.terminalFcffTwd).toBeCloseTo(
      (result.forecast.at(-1)?.fcffTwd ?? 0) * 1.02,
      5,
    );
  });

  it("does not claim convergence from solve-value width when a large-EV residual is still material", () => {
    const input = calibratedToKnownSolution(
      fcffInput({
        forecastYears: 100,
        solveRange: { minimumPercent: -20, maximumPercent: 30 },
        operatingFacts: { baseFcffTwd: 1e20 },
      }),
      6.1234567890123,
    );

    const result = solveReverseDcf(input);
    const enterpriseValueTolerance = Math.max(
      0.01,
      Math.abs(result.bridge.targetEnterpriseValueTwd) * 1e-12,
    );
    const iterationsAtDisclosedSolveValueWidth = Math.ceil(
      Math.log2(
        (input.solveRange.maximumPercent - input.solveRange.minimumPercent) /
          1e-10,
      ),
    );

    expect(result.solution.converged).toBe(true);
    expect(Math.abs(result.solution.residualTwd)).toBeLessThanOrEqual(
      enterpriseValueTolerance,
    );
    expect(result.solution.iterations).toBeGreaterThan(
      iterationsAtDisclosedSolveValueWidth,
    );
    expect(
      result.checks.find(
        (check) => check.id === "market_enterprise_value_solve_tie_out",
      ),
    ).toMatchObject({
      status: "pass",
      value: result.solution.residualTwd,
      tolerance: enterpriseValueTolerance,
    });
  });

  it("solves terminal operating margin with caller-provided revenue CAGR", () => {
    const input = calibratedToKnownSolution(terminalMarginInput(), 18);

    const result = solveReverseDcf(input);

    expect(result.solution.solvedValuePercent).toBeCloseTo(18, 8);
    expect(result.solution.monotonicDirection).toBe("increasing");
    result.forecast.forEach((period, index) => {
      expect(period.operatingMarginPercent).toBeCloseTo(
        [13.2, 14.4, 15.6, 16.8, 18][index] as number,
        9,
      );
    });
    expect(result.terminal.terminalOperatingMarginPercent).toBeCloseTo(18, 9);
  });

  it("recomputes operating terminal FCFF at terminal growth rather than forecast growth", () => {
    const input = revenueInput();
    const evaluation = evaluateReverseDcfAt(input, 8);
    const final = evaluation.forecast.at(-1);
    expect(final?.revenueTwd).not.toBeNull();
    const finalRevenue = final?.revenueTwd ?? 0;
    const terminalRevenue = finalRevenue * 1.02;
    const expectedEbit = terminalRevenue * 0.2;
    const expectedCashTaxes = expectedEbit * 0.2;
    const expectedReinvestment = (terminalRevenue - finalRevenue) / 2;
    const expectedTerminalFcff =
      expectedEbit - expectedCashTaxes - expectedReinvestment;

    expect(evaluation.terminal.terminalRevenueTwd).toBeCloseTo(
      terminalRevenue,
      5,
    );
    expect(evaluation.terminal.terminalFcffTwd).toBeCloseTo(
      expectedTerminalFcff,
      5,
    );
    expect(evaluation.terminal.terminalFcffTwd).not.toBeCloseTo(
      (final?.fcffTwd ?? 0) * 1.02,
      2,
    );
    expect(evaluation.terminal.presentValueTerminalTwd).toBeCloseTo(
      (expectedTerminalFcff / (0.09 - 0.02)) / Math.pow(1.09, 5),
      5,
    );
  });

  it("recomputes terminal-margin mode terminal FCFF using g and the solved margin", () => {
    const evaluation = evaluateReverseDcfAt(terminalMarginInput(), 18);
    const finalRevenue = evaluation.forecast.at(-1)?.revenueTwd ?? 0;
    const expectedTerminalRevenue = finalRevenue * 1.02;
    const expectedTerminalFcff =
      expectedTerminalRevenue * 0.18 * 0.8 -
      (expectedTerminalRevenue - finalRevenue) / 2;

    expect(evaluation.terminal.terminalOperatingMarginPercent).toBe(18);
    expect(evaluation.terminal.terminalFcffTwd).toBeCloseTo(
      expectedTerminalFcff,
      5,
    );
  });

  it("supports analytically decreasing revenue-CAGR value functions", () => {
    const lowMarginInput = revenueInput({
      operatingAssumptions: {
        marginPolicy: "constant_normalized",
        normalizedOperatingMarginPercent: 5,
        cashTaxRatePercent: 20,
        salesToCapitalRatio: 2,
      },
    });
    const input = calibratedToKnownSolution(lowMarginInput, 8);

    const lower = evaluateReverseDcfAt(input, 0);
    const higher = evaluateReverseDcfAt(input, 10);
    const result = solveReverseDcf(input);

    expect(lower.presentValue.modeledEnterpriseValueTwd).toBeGreaterThan(
      higher.presentValue.modeledEnterpriseValueTwd,
    );
    expect(result.solution.monotonicDirection).toBe("decreasing");
    expect(result.solution.solvedValuePercent).toBeCloseTo(8, 7);
  });

  it("fails closed when revenue CAGR is mathematically unidentifiable", () => {
    const wacc = 0.09;
    const taxRate = 0.2;
    const salesToCapital = 2;
    const unidentifiableMarginPercent =
      (wacc / (salesToCapital * (1 + wacc)) / (1 - taxRate)) * 100;
    const input = revenueInput({
      operatingAssumptions: {
        marginPolicy: "constant_normalized",
        normalizedOperatingMarginPercent: unidentifiableMarginPercent,
        cashTaxRatePercent: taxRate * 100,
        salesToCapitalRatio: salesToCapital,
      },
    });

    const error = captureError(
      () => solveReverseDcf(input),
      "UNIDENTIFIABLE_SOLVE_RANGE",
    );
    expect(error.details).toMatchObject({
      formula:
        "after_tax_margin - wacc / (sales_to_capital * (1 + wacc))",
    });
  });

  it("fails closed when the solve range does not bracket market EV", () => {
    const input = fcffInput({
      marketFacts: {
        ...marketFacts(),
        observedPricePerShareTwd: 10_000,
      },
    });

    captureError(() => solveReverseDcf(input), "NO_FEASIBLE_SOLUTION");
  });

  it("fails closed when floating-point stagnation cannot meet the EV residual tolerance", () => {
    const input = revenueInput({
      marketFacts: {
        observedPricePerShareTwd: 1,
        observedPriceDate: "2026-08-28",
        sharesOutstanding: 1,
        shareCountBasis: "diluted_shares",
        cashAndCashEquivalentsTwd: 0,
        nonOperatingAssetsTwd: 0,
        interestBearingDebtTwd: 0,
        leaseLiabilitiesTwd: 0,
        nonControllingInterestsTwd: 0,
        preferredEquityTwd: 0,
        pensionDeficitTwd: 0,
        otherDebtLikeItemsTwd: 0,
      },
      forecastYears: 100,
      solveRange: { minimumPercent: 0, maximumPercent: 30 },
      operatingFacts: { baseRevenueTwd: 1e20 },
      operatingAssumptions: {
        marginPolicy: "constant_normalized",
        normalizedOperatingMarginPercent: 5,
        cashTaxRatePercent: 20,
        salesToCapitalRatio: 2,
      },
    });

    const error = captureError(() => solveReverseDcf(input), "NUMERICAL_FAILURE");
    expect(error.message).toContain("stagnated");
    expect(error.details).toMatchObject({
      solveFor: "revenue_cagr",
      enterpriseValueToleranceTwd: 0.01,
    });
  });

  it("rejects WACC at or below terminal growth", () => {
    const input = fcffInput({ waccPercent: 2, terminalGrowthPercent: 2 });

    captureError(() => solveReverseDcf(input), "INVALID_INPUT");
  });

  it("rejects financial companies at the applicability boundary", () => {
    const input = fcffInput({
      company: { companyCode: "2881", isFinancial: true },
    });

    const error = captureError(
      () => solveReverseDcf(input),
      "NOT_APPLICABLE_FINANCIAL_COMPANY",
    );
    expect(error.details.alternatives).toEqual([
      "residual_income",
      "dividend_discount",
      "excess_return",
    ]);
  });

  it("requires every EV bridge item and never silently defaults missing claims", () => {
    const input = fcffInput() as unknown as {
      marketFacts: Record<string, unknown>;
    };
    delete input.marketFacts.nonControllingInterestsTwd;

    const error = captureError(
      () => solveReverseDcf(input as unknown as ReverseDcfInput),
      "MISSING_REQUIRED_INPUT",
    );
    expect(error.details).toMatchObject({
      field: "marketFacts.nonControllingInterestsTwd",
    });
  });

  it("fails closed when required provenance is unavailable", () => {
    const provenance = factProvenanceFor("fcff_cagr");
    const missingClaim = provenance.find(
      (item) => item.id === "marketFacts.preferredEquityTwd",
    );
    if (!missingClaim) throw new Error("Missing test provenance fixture.");
    missingClaim.evidenceClass = "UNAVAILABLE";
    const input = fcffInput({ factProvenance: provenance });

    const error = captureError(
      () => solveReverseDcf(input),
      "MISSING_REQUIRED_INPUT",
    );
    expect(error.details).toMatchObject({
      id: "marketFacts.preferredEquityTwd",
      evidenceClass: "UNAVAILABLE",
    });
  });

  it("has the expected WACC, terminal-growth, and margin directionality", () => {
    const fcff = fcffInput();
    const lowerWacc = evaluateReverseDcfAt(fcff, 6, { waccPercent: 8 });
    const higherWacc = evaluateReverseDcfAt(fcff, 6, { waccPercent: 10 });
    const lowerGrowth = evaluateReverseDcfAt(fcff, 6, {
      terminalGrowthPercent: 1,
    });
    const higherGrowth = evaluateReverseDcfAt(fcff, 6, {
      terminalGrowthPercent: 3,
    });
    const margins = terminalMarginInput();
    const lowerMargin = evaluateReverseDcfAt(margins, 15);
    const higherMargin = evaluateReverseDcfAt(margins, 20);

    expect(lowerWacc.presentValue.modeledEnterpriseValueTwd).toBeGreaterThan(
      higherWacc.presentValue.modeledEnterpriseValueTwd,
    );
    expect(higherGrowth.presentValue.modeledEnterpriseValueTwd).toBeGreaterThan(
      lowerGrowth.presentValue.modeledEnterpriseValueTwd,
    );
    expect(higherMargin.presentValue.modeledEnterpriseValueTwd).toBeGreaterThan(
      lowerMargin.presentValue.modeledEnterpriseValueTwd,
    );
  });

  it("re-solves every requested sensitivity cell and isolates infeasible cells", () => {
    const base = calibratedToKnownSolution(fcffInput(), 6);
    const input: FcffCagrReverseDcfInput = {
      ...base,
      sensitivityGrids: {
        waccPercent: [9, 40],
        terminalGrowthPercent: [2],
      },
    };

    const result = solveReverseDcf(input);

    expect(result.sensitivities).toHaveLength(2);
    expect(result.sensitivities[0]).toMatchObject({
      waccPercent: 9,
      terminalGrowthPercent: 2,
      status: "solved",
      errorCode: null,
    });
    expect(result.sensitivities[0]?.solvedValuePercent).toBeCloseTo(6, 8);
    expect(result.sensitivities[1]).toEqual({
      waccPercent: 40,
      terminalGrowthPercent: 2,
      status: "no_feasible_solution",
      solvedValuePercent: null,
      modeledEnterpriseValueTwd: null,
      residualTwd: null,
      errorCode: "NO_FEASIBLE_SOLUTION",
    });
  });

  it("is byte-for-byte reproducible for the same normalized input", () => {
    const input = calibratedToKnownSolution(terminalMarginInput(), 18);

    expect(solveReverseDcf(input)).toEqual(solveReverseDcf(input));
  });
});
