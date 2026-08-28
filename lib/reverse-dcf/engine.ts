import { ReverseDcfError } from "./errors";
import {
  REVERSE_DCF_MODEL_VERSION,
  type ReverseDcfAssumptionEvidence,
  type ReverseDcfEnterpriseValueBridge,
  type ReverseDcfEvaluation,
  type ReverseDcfEvidence,
  type ReverseDcfEvidenceUnit,
  type ReverseDcfForecastPeriod,
  type ReverseDcfFactProvenance,
  type ReverseDcfInput,
  type ReverseDcfInputFactEvidence,
  type ReverseDcfMarketFacts,
  type ReverseDcfModelOutputEvidence,
  type ReverseDcfPresentValue,
  type ReverseDcfResult,
  type ReverseDcfSensitivityCell,
  type ReverseDcfSolution,
  type ReverseDcfSolverPolicy,
  type ReverseDcfTerminalValue,
} from "./types";

type UnknownRecord = Record<string, unknown>;

interface RateOverrides {
  waccPercent: number;
  terminalGrowthPercent: number;
}

interface OperatingPeriod {
  revenueTwd: number;
  revenueGrowthPercent: number;
  operatingMarginPercent: number;
  ebitTwd: number;
  cashTaxesTwd: number;
  reinvestmentTwd: number;
  fcffTwd: number;
}

interface SolvedAtRates {
  solution: ReverseDcfSolution;
  evaluation: ReverseDcfEvaluation;
}

export const REVERSE_DCF_SOLVER_POLICY: ReverseDcfSolverPolicy = Object.freeze({
  algorithm: "deterministic_bisection",
  monotonicSampleIntervals: 64,
  maximumIterations: 256,
  enterpriseValueRelativeTolerance: 1e-12,
  enterpriseValueAbsoluteToleranceTwd: 0.01,
});

const MAX_FORECAST_YEARS = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(
  code: ConstructorParameters<typeof ReverseDcfError>[0],
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ReverseDcfError(code, message, details);
}

function requiredRecord(
  parent: UnknownRecord,
  key: string,
  path: string,
): UnknownRecord {
  const value = parent[key];
  if (value === undefined || value === null) {
    fail("MISSING_REQUIRED_INPUT", `${path} is required.`, { field: path });
  }
  if (!isRecord(value)) {
    fail("INVALID_INPUT", `${path} must be an object.`, { field: path });
  }
  return value;
}

function requiredFiniteNumber(
  parent: UnknownRecord,
  key: string,
  path: string,
): number {
  const value = parent[key];
  if (value === undefined || value === null) {
    fail("MISSING_REQUIRED_INPUT", `${path} is required.`, { field: path });
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_INPUT", `${path} must be a finite number.`, {
      field: path,
      value,
    });
  }
  return value;
}

function requiredString(
  parent: UnknownRecord,
  key: string,
  path: string,
): string {
  const value = parent[key];
  if (value === undefined || value === null) {
    fail("MISSING_REQUIRED_INPUT", `${path} is required.`, { field: path });
  }
  if (typeof value !== "string") {
    fail("INVALID_INPUT", `${path} must be a string.`, { field: path, value });
  }
  return value;
}

function requiredBoolean(
  parent: UnknownRecord,
  key: string,
  path: string,
): boolean {
  const value = parent[key];
  if (value === undefined || value === null) {
    fail("MISSING_REQUIRED_INPUT", `${path} is required.`, { field: path });
  }
  if (typeof value !== "boolean") {
    fail("INVALID_INPUT", `${path} must be boolean.`, { field: path, value });
  }
  return value;
}

function assertPositive(value: number, path: string): void {
  if (value <= 0) {
    fail("INVALID_INPUT", `${path} must be greater than zero.`, {
      field: path,
      value,
    });
  }
}

function assertNonNegative(value: number, path: string): void {
  if (value < 0) {
    fail("INVALID_INPUT", `${path} must be non-negative.`, {
      field: path,
      value,
    });
  }
}

function assertPercentAboveNegativeHundred(
  value: number,
  path: string,
): void {
  if (value <= -100) {
    fail("INVALID_INPUT", `${path} must be greater than -100%.`, {
      field: path,
      value,
    });
  }
}

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function assertFiniteCalculation(
  value: number,
  field: string,
  details: Record<string, unknown> = {},
): number {
  if (!Number.isFinite(value)) {
    fail("NUMERICAL_FAILURE", `${field} produced a non-finite value.`, {
      field,
      ...details,
    });
  }
  return Object.is(value, -0) ? 0 : value;
}

function assertNumericalInvariant(
  id: string,
  value: number,
  tolerance: number,
): void {
  if (!Number.isFinite(value) || Math.abs(value) > tolerance) {
    fail("NUMERICAL_FAILURE", `${id} did not meet its disclosed tolerance.`, {
      checkId: id,
      value,
      tolerance,
    });
  }
}

function validateRates(waccPercent: number, terminalGrowthPercent: number): void {
  if (!Number.isFinite(waccPercent) || waccPercent <= 0) {
    fail("INVALID_INPUT", "waccPercent must be finite and greater than zero.", {
      field: "waccPercent",
      value: waccPercent,
    });
  }
  if (!Number.isFinite(terminalGrowthPercent)) {
    fail("INVALID_INPUT", "terminalGrowthPercent must be finite.", {
      field: "terminalGrowthPercent",
      value: terminalGrowthPercent,
    });
  }
  assertPercentAboveNegativeHundred(
    terminalGrowthPercent,
    "terminalGrowthPercent",
  );
  if (waccPercent <= terminalGrowthPercent) {
    fail(
      "INVALID_INPUT",
      "FCFF perpetuity requires waccPercent greater than terminalGrowthPercent.",
      { waccPercent, terminalGrowthPercent },
    );
  }
}

function validateMarketFacts(record: UnknownRecord): void {
  const positiveFields = [
    "observedPricePerShareTwd",
    "sharesOutstanding",
  ] as const;
  for (const key of positiveFields) {
    assertPositive(
      requiredFiniteNumber(record, key, `marketFacts.${key}`),
      `marketFacts.${key}`,
    );
  }
  const nonNegativeFields = [
    "cashAndCashEquivalentsTwd",
    "nonOperatingAssetsTwd",
    "interestBearingDebtTwd",
    "leaseLiabilitiesTwd",
    "nonControllingInterestsTwd",
    "preferredEquityTwd",
    "pensionDeficitTwd",
    "otherDebtLikeItemsTwd",
  ] as const;
  for (const key of nonNegativeFields) {
    assertNonNegative(
      requiredFiniteNumber(record, key, `marketFacts.${key}`),
      `marketFacts.${key}`,
    );
  }
  const date = requiredString(
    record,
    "observedPriceDate",
    "marketFacts.observedPriceDate",
  );
  if (!isRealIsoDate(date)) {
    fail(
      "INVALID_INPUT",
      "marketFacts.observedPriceDate must be a real YYYY-MM-DD date.",
      { field: "marketFacts.observedPriceDate", value: date },
    );
  }
  const shareCountBasis = requiredString(
    record,
    "shareCountBasis",
    "marketFacts.shareCountBasis",
  );
  if (
    shareCountBasis !== "issued_common_shares" &&
    shareCountBasis !== "diluted_shares"
  ) {
    fail("INVALID_INPUT", "marketFacts.shareCountBasis is unsupported.", {
      field: "marketFacts.shareCountBasis",
      value: shareCountBasis,
    });
  }
}

function requiredFactIds(solveFor: ReverseDcfInput["solveFor"]): string[] {
  return [
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
}

function validateFactProvenance(
  root: UnknownRecord,
  solveFor: ReverseDcfInput["solveFor"],
): void {
  const raw = root.factProvenance;
  if (raw === undefined || raw === null) {
    fail("MISSING_REQUIRED_INPUT", "factProvenance is required.", {
      field: "factProvenance",
    });
  }
  if (!Array.isArray(raw)) {
    fail("INVALID_INPUT", "factProvenance must be an array.", {
      field: "factProvenance",
    });
  }
  const expectedIds = new Set(requiredFactIds(solveFor));
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) {
      fail("INVALID_INPUT", "Every factProvenance entry must be an object.", {
        field: `factProvenance.${index}`,
      });
    }
    const id = requiredString(item, "id", `factProvenance.${index}.id`);
    if (!expectedIds.has(id)) {
      fail("INVALID_INPUT", "factProvenance contains an unexpected fact id.", {
        field: `factProvenance.${index}.id`,
        id,
      });
    }
    if (seen.has(id)) {
      fail("INVALID_INPUT", "factProvenance ids must be unique.", { id });
    }
    seen.add(id);
    const evidenceClass = requiredString(
      item,
      "evidenceClass",
      `factProvenance.${index}.evidenceClass`,
    );
    if (
      evidenceClass !== "MOPSFIN_RAW" &&
      evidenceClass !== "MOPSFIN_CALC" &&
      evidenceClass !== "OFFICIAL_MASTER_RAW" &&
      evidenceClass !== "OFFICIAL_MARKET_RAW" &&
      evidenceClass !== "OFFICIAL_CALC" &&
      evidenceClass !== "MIXED_OFFICIAL_CALC" &&
      evidenceClass !== "CALLER_ASSUMPTION" &&
      evidenceClass !== "EXTERNAL_EXPECTATION" &&
      evidenceClass !== "UNAVAILABLE"
    ) {
      fail("INVALID_INPUT", "Unsupported fact evidenceClass.", {
        id,
        evidenceClass,
      });
    }
    if (evidenceClass === "UNAVAILABLE") {
      fail(
        "MISSING_REQUIRED_INPUT",
        "A required reverse-DCF fact is explicitly unavailable.",
        { id, evidenceClass },
      );
    }
    if (!Array.isArray(item.lineageIds)) {
      fail(
        "INVALID_INPUT",
        "Every fact provenance entry must provide a lineageIds array.",
        { id, field: `factProvenance.${index}.lineageIds` },
      );
    }
    if (evidenceClass === "CALLER_ASSUMPTION") {
      if (item.lineageIds.length !== 0) {
        fail(
          "INVALID_INPUT",
          "Caller assumptions must use an empty lineageIds array.",
          { id, field: `factProvenance.${index}.lineageIds` },
        );
      }
    } else if (
      item.lineageIds.length === 0 ||
      item.lineageIds.some(
        (lineageId) => typeof lineageId !== "string" || lineageId.length === 0,
      )
    ) {
      fail(
        "INVALID_INPUT",
        "Every sourced fact must provide at least one non-empty lineage id.",
        { id, field: `factProvenance.${index}.lineageIds` },
      );
    }
  }
  const missing = [...expectedIds].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    fail(
      "MISSING_REQUIRED_INPUT",
      "factProvenance does not cover every required normalized fact.",
      { missingFactIds: missing },
    );
  }
}

function validateSensitivityGrids(root: UnknownRecord): void {
  const raw = root.sensitivityGrids;
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    fail("INVALID_INPUT", "sensitivityGrids must be an object when provided.", {
      field: "sensitivityGrids",
    });
  }
  const waccGrid = raw.waccPercent;
  const growthGrid = raw.terminalGrowthPercent;
  if (!Array.isArray(waccGrid) || waccGrid.length === 0) {
    fail(
      "INVALID_INPUT",
      "sensitivityGrids.waccPercent must be a non-empty caller-provided array.",
      { field: "sensitivityGrids.waccPercent" },
    );
  }
  if (!Array.isArray(growthGrid) || growthGrid.length === 0) {
    fail(
      "INVALID_INPUT",
      "sensitivityGrids.terminalGrowthPercent must be a non-empty caller-provided array.",
      { field: "sensitivityGrids.terminalGrowthPercent" },
    );
  }
  if (waccGrid.length * growthGrid.length > 625) {
    fail("INVALID_INPUT", "Sensitivity grids may contain at most 625 cells.", {
      field: "sensitivityGrids",
      cellCount: waccGrid.length * growthGrid.length,
    });
  }
  for (const [index, value] of waccGrid.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail(
        "INVALID_INPUT",
        "Every sensitivity WACC must be finite and greater than zero.",
        { field: `sensitivityGrids.waccPercent.${index}`, value },
      );
    }
  }
  for (const [index, value] of growthGrid.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(
        "INVALID_INPUT",
        "Every sensitivity terminal growth must be finite.",
        { field: `sensitivityGrids.terminalGrowthPercent.${index}`, value },
      );
    }
    assertPercentAboveNegativeHundred(
      value,
      `sensitivityGrids.terminalGrowthPercent.${index}`,
    );
  }
  for (const wacc of waccGrid as number[]) {
    for (const growth of growthGrid as number[]) {
      if (wacc <= growth) {
        fail(
          "INVALID_INPUT",
          "Every sensitivity cell requires WACC greater than terminal growth.",
          { waccPercent: wacc, terminalGrowthPercent: growth },
        );
      }
    }
  }
}

function validateInput(input: ReverseDcfInput): void {
  if (!isRecord(input)) {
    fail("MISSING_REQUIRED_INPUT", "Reverse DCF input is required.");
  }
  const company = requiredRecord(input, "company", "company");
  const companyCode = requiredString(company, "companyCode", "company.companyCode");
  if (!/^\d{4}$/.test(companyCode)) {
    fail("INVALID_INPUT", "company.companyCode must be a four-digit code.", {
      field: "company.companyCode",
      value: companyCode,
    });
  }
  const isFinancial = requiredBoolean(company, "isFinancial", "company.isFinancial");
  if (isFinancial) {
    fail(
      "NOT_APPLICABLE_FINANCIAL_COMPANY",
      "Standard enterprise-value FCFF reverse DCF is not applicable to a financial company.",
      {
        companyCode,
        alternatives: ["residual_income", "dividend_discount", "excess_return"],
      },
    );
  }
  const currency = requiredString(input, "currency", "currency");
  if (currency !== "TWD") {
    fail("INVALID_INPUT", "Reverse DCF currently requires currency=TWD.", {
      field: "currency",
      value: currency,
    });
  }
  const marketFacts = requiredRecord(input, "marketFacts", "marketFacts");
  validateMarketFacts(marketFacts);

  const forecastYears = requiredFiniteNumber(
    input,
    "forecastYears",
    "forecastYears",
  );
  if (
    !Number.isInteger(forecastYears) ||
    forecastYears <= 0 ||
    forecastYears > MAX_FORECAST_YEARS
  ) {
    fail(
      "INVALID_INPUT",
      `forecastYears must be an integer from 1 to ${MAX_FORECAST_YEARS}.`,
      { field: "forecastYears", value: forecastYears },
    );
  }
  const waccPercent = requiredFiniteNumber(input, "waccPercent", "waccPercent");
  const terminalGrowthPercent = requiredFiniteNumber(
    input,
    "terminalGrowthPercent",
    "terminalGrowthPercent",
  );
  validateRates(waccPercent, terminalGrowthPercent);

  const solveRange = requiredRecord(input, "solveRange", "solveRange");
  const minimumPercent = requiredFiniteNumber(
    solveRange,
    "minimumPercent",
    "solveRange.minimumPercent",
  );
  const maximumPercent = requiredFiniteNumber(
    solveRange,
    "maximumPercent",
    "solveRange.maximumPercent",
  );
  if (minimumPercent >= maximumPercent) {
    fail(
      "INVALID_INPUT",
      "solveRange.minimumPercent must be less than maximumPercent.",
      { minimumPercent, maximumPercent },
    );
  }

  const solveFor = requiredString(input, "solveFor", "solveFor");
  if (
    solveFor !== "revenue_cagr" &&
    solveFor !== "fcff_cagr" &&
    solveFor !== "terminal_operating_margin"
  ) {
    fail("INVALID_INPUT", "solveFor is unsupported.", {
      field: "solveFor",
      value: solveFor,
    });
  }
  const facts = requiredRecord(input, "operatingFacts", "operatingFacts");
  const assumptions = requiredRecord(
    input,
    "operatingAssumptions",
    "operatingAssumptions",
  );

  if (solveFor === "revenue_cagr") {
    assertPercentAboveNegativeHundred(
      minimumPercent,
      "solveRange.minimumPercent",
    );
    const baseRevenue = requiredFiniteNumber(
      facts,
      "baseRevenueTwd",
      "operatingFacts.baseRevenueTwd",
    );
    assertPositive(baseRevenue, "operatingFacts.baseRevenueTwd");
    if (
      requiredString(
        assumptions,
        "marginPolicy",
        "operatingAssumptions.marginPolicy",
      ) !== "constant_normalized"
    ) {
      fail(
        "INVALID_INPUT",
        "Revenue CAGR mode requires marginPolicy=constant_normalized.",
      );
    }
    const normalizedMargin = requiredFiniteNumber(
      assumptions,
      "normalizedOperatingMarginPercent",
      "operatingAssumptions.normalizedOperatingMarginPercent",
    );
    assertNonNegative(
      normalizedMargin,
      "operatingAssumptions.normalizedOperatingMarginPercent",
    );
    validateCashTaxAndSalesToCapital(assumptions);
  } else if (solveFor === "fcff_cagr") {
    assertPercentAboveNegativeHundred(
      minimumPercent,
      "solveRange.minimumPercent",
    );
    const baseFcff = requiredFiniteNumber(
      facts,
      "baseFcffTwd",
      "operatingFacts.baseFcffTwd",
    );
    assertPositive(baseFcff, "operatingFacts.baseFcffTwd");
    if (
      requiredString(
        assumptions,
        "growthPolicy",
        "operatingAssumptions.growthPolicy",
      ) !== "constant_compounded"
    ) {
      fail(
        "INVALID_INPUT",
        "FCFF CAGR mode requires growthPolicy=constant_compounded.",
      );
    }
  } else {
    if (minimumPercent < 0) {
      fail(
        "INVALID_INPUT",
        "terminal_operating_margin solveRange may not imply a negative operating margin.",
        { field: "solveRange.minimumPercent", value: minimumPercent },
      );
    }
    const baseRevenue = requiredFiniteNumber(
      facts,
      "baseRevenueTwd",
      "operatingFacts.baseRevenueTwd",
    );
    assertPositive(baseRevenue, "operatingFacts.baseRevenueTwd");
    const baseMargin = requiredFiniteNumber(
      facts,
      "baseOperatingMarginPercent",
      "operatingFacts.baseOperatingMarginPercent",
    );
    assertNonNegative(
      baseMargin,
      "operatingFacts.baseOperatingMarginPercent",
    );
    const revenueCagr = requiredFiniteNumber(
      assumptions,
      "revenueCagrPercent",
      "operatingAssumptions.revenueCagrPercent",
    );
    assertPercentAboveNegativeHundred(
      revenueCagr,
      "operatingAssumptions.revenueCagrPercent",
    );
    validateCashTaxAndSalesToCapital(assumptions);
    if (
      requiredString(
        assumptions,
        "marginTransition",
        "operatingAssumptions.marginTransition",
      ) !== "linear_from_base_to_terminal"
    ) {
      fail(
        "INVALID_INPUT",
        "Terminal margin mode requires marginTransition=linear_from_base_to_terminal.",
      );
    }
  }
  validateFactProvenance(input, solveFor);
  validateSensitivityGrids(input);
  buildBridge(input.marketFacts);
}

function validateCashTaxAndSalesToCapital(
  assumptions: UnknownRecord,
): void {
  const taxRate = requiredFiniteNumber(
    assumptions,
    "cashTaxRatePercent",
    "operatingAssumptions.cashTaxRatePercent",
  );
  if (taxRate < 0 || taxRate >= 100) {
    fail(
      "INVALID_INPUT",
      "operatingAssumptions.cashTaxRatePercent must be at least 0% and below 100%.",
      { value: taxRate },
    );
  }
  const salesToCapital = requiredFiniteNumber(
    assumptions,
    "salesToCapitalRatio",
    "operatingAssumptions.salesToCapitalRatio",
  );
  assertPositive(
    salesToCapital,
    "operatingAssumptions.salesToCapitalRatio",
  );
}

function buildBridge(
  facts: ReverseDcfMarketFacts,
): ReverseDcfEnterpriseValueBridge {
  const observedEquityValueTwd = assertFiniteCalculation(
    facts.observedPricePerShareTwd * facts.sharesOutstanding,
    "observedEquityValueTwd",
  );
  const debtLikeClaims =
    facts.interestBearingDebtTwd +
    facts.leaseLiabilitiesTwd +
    facts.nonControllingInterestsTwd +
    facts.preferredEquityTwd +
    facts.pensionDeficitTwd +
    facts.otherDebtLikeItemsTwd;
  const targetEnterpriseValueTwd = assertFiniteCalculation(
    observedEquityValueTwd +
      debtLikeClaims -
      facts.cashAndCashEquivalentsTwd -
      facts.nonOperatingAssetsTwd,
    "targetEnterpriseValueTwd",
  );
  if (targetEnterpriseValueTwd <= 0) {
    fail(
      "INVALID_INPUT",
      "The explicit observed-price EV bridge must produce positive enterprise value.",
      { observedEquityValueTwd, targetEnterpriseValueTwd },
    );
  }
  return {
    observedPricePerShareTwd: facts.observedPricePerShareTwd,
    observedPriceDate: facts.observedPriceDate,
    sharesOutstanding: facts.sharesOutstanding,
    shareCountBasis: facts.shareCountBasis,
    observedEquityValueTwd,
    plusInterestBearingDebtTwd: facts.interestBearingDebtTwd,
    plusLeaseLiabilitiesTwd: facts.leaseLiabilitiesTwd,
    plusNonControllingInterestsTwd: facts.nonControllingInterestsTwd,
    plusPreferredEquityTwd: facts.preferredEquityTwd,
    plusPensionDeficitTwd: facts.pensionDeficitTwd,
    plusOtherDebtLikeItemsTwd: facts.otherDebtLikeItemsTwd,
    lessCashAndCashEquivalentsTwd: facts.cashAndCashEquivalentsTwd,
    lessNonOperatingAssetsTwd: facts.nonOperatingAssetsTwd,
    targetEnterpriseValueTwd,
    formula:
      "observed_equity_value_plus_debt_like_claims_minus_cash_and_non_operating_assets",
  };
}

function operatingPeriod(
  priorRevenueTwd: number,
  revenueTwd: number,
  revenueGrowthPercent: number,
  operatingMarginPercent: number,
  cashTaxRatePercent: number,
  salesToCapitalRatio: number,
): OperatingPeriod {
  const ebitTwd = assertFiniteCalculation(
    revenueTwd * (operatingMarginPercent / 100),
    "ebitTwd",
  );
  const cashTaxesTwd = assertFiniteCalculation(
    Math.max(ebitTwd * (cashTaxRatePercent / 100), 0),
    "cashTaxesTwd",
  );
  const reinvestmentTwd = assertFiniteCalculation(
    (revenueTwd - priorRevenueTwd) / salesToCapitalRatio,
    "reinvestmentTwd",
  );
  const fcffTwd = assertFiniteCalculation(
    ebitTwd - cashTaxesTwd - reinvestmentTwd,
    "fcffTwd",
  );
  return {
    revenueTwd,
    revenueGrowthPercent,
    operatingMarginPercent,
    ebitTwd,
    cashTaxesTwd,
    reinvestmentTwd,
    fcffTwd,
  };
}

function presentValueFactor(wacc: number, year: number): number {
  return assertFiniteCalculation(
    1 / Math.pow(1 + wacc, year),
    "presentValueFactor",
    { year },
  );
}

function forecastAt(
  input: ReverseDcfInput,
  solvedDriverPercent: number,
  wacc: number,
): ReverseDcfForecastPeriod[] {
  const forecast: ReverseDcfForecastPeriod[] = [];
  if (
    (input.solveFor === "revenue_cagr" || input.solveFor === "fcff_cagr") &&
    solvedDriverPercent <= -100
  ) {
    fail(
      "INVALID_INPUT",
      `${input.solveFor} evaluation must be greater than -100%.`,
      { solvedDriverPercent },
    );
  }

  if (input.solveFor === "fcff_cagr") {
    const growth = solvedDriverPercent / 100;
    for (let year = 1; year <= input.forecastYears; year += 1) {
      const fcffTwd = assertFiniteCalculation(
        input.operatingFacts.baseFcffTwd * Math.pow(1 + growth, year),
        "forecast.fcffTwd",
        { year, solvedDriverPercent },
      );
      const factor = presentValueFactor(wacc, year);
      forecast.push({
        year,
        revenueTwd: null,
        revenueGrowthPercent: null,
        operatingMarginPercent: null,
        ebitTwd: null,
        cashTaxesTwd: null,
        reinvestmentTwd: null,
        fcffTwd,
        discountPeriodYears: year,
        presentValueFactor: factor,
        presentValueFcffTwd: assertFiniteCalculation(
          fcffTwd * factor,
          "forecast.presentValueFcffTwd",
          { year },
        ),
      });
    }
    return forecast;
  }

  let priorRevenueTwd = input.operatingFacts.baseRevenueTwd;
  const revenueGrowthPercent =
    input.solveFor === "revenue_cagr"
      ? solvedDriverPercent
      : input.operatingAssumptions.revenueCagrPercent;
  const revenueGrowth = revenueGrowthPercent / 100;
  const cashTaxRatePercent = input.operatingAssumptions.cashTaxRatePercent;
  const salesToCapitalRatio = input.operatingAssumptions.salesToCapitalRatio;

  for (let year = 1; year <= input.forecastYears; year += 1) {
    const revenueTwd = assertFiniteCalculation(
      priorRevenueTwd * (1 + revenueGrowth),
      "forecast.revenueTwd",
      { year, revenueGrowthPercent },
    );
    const operatingMarginPercent =
      input.solveFor === "revenue_cagr"
        ? input.operatingAssumptions.normalizedOperatingMarginPercent
        : input.operatingFacts.baseOperatingMarginPercent +
          (solvedDriverPercent -
            input.operatingFacts.baseOperatingMarginPercent) *
            (year / input.forecastYears);
    const period = operatingPeriod(
      priorRevenueTwd,
      revenueTwd,
      revenueGrowthPercent,
      operatingMarginPercent,
      cashTaxRatePercent,
      salesToCapitalRatio,
    );
    const factor = presentValueFactor(wacc, year);
    forecast.push({
      year,
      ...period,
      discountPeriodYears: year,
      presentValueFactor: factor,
      presentValueFcffTwd: assertFiniteCalculation(
        period.fcffTwd * factor,
        "forecast.presentValueFcffTwd",
        { year },
      ),
    });
    priorRevenueTwd = revenueTwd;
  }
  return forecast;
}

function terminalAt(
  input: ReverseDcfInput,
  forecast: ReverseDcfForecastPeriod[],
  wacc: number,
  terminalGrowth: number,
): Omit<
  ReverseDcfTerminalValue,
  "presentValueTerminalPercentOfEnterpriseValue"
> {
  const finalPeriod = forecast.at(-1);
  if (!finalPeriod) {
    fail("NUMERICAL_FAILURE", "Forecast must contain at least one period.");
  }
  let terminalRevenueTwd: number | null = null;
  let terminalOperatingMarginPercent: number | null = null;
  let terminalEbitTwd: number | null = null;
  let terminalCashTaxesTwd: number | null = null;
  let terminalReinvestmentTwd: number | null = null;
  let terminalFcffTwd: number;

  if (input.solveFor === "fcff_cagr") {
    terminalFcffTwd = assertFiniteCalculation(
      finalPeriod.fcffTwd * (1 + terminalGrowth),
      "terminalFcffTwd",
    );
  } else {
    if (finalPeriod.revenueTwd === null || finalPeriod.operatingMarginPercent === null) {
      fail(
        "NUMERICAL_FAILURE",
        "Operating forecast is missing final revenue or margin.",
      );
    }
    const terminalPeriod = operatingPeriod(
      finalPeriod.revenueTwd,
      assertFiniteCalculation(
        finalPeriod.revenueTwd * (1 + terminalGrowth),
        "terminalRevenueTwd",
      ),
      terminalGrowth * 100,
      finalPeriod.operatingMarginPercent,
      input.operatingAssumptions.cashTaxRatePercent,
      input.operatingAssumptions.salesToCapitalRatio,
    );
    terminalRevenueTwd = terminalPeriod.revenueTwd;
    terminalOperatingMarginPercent = terminalPeriod.operatingMarginPercent;
    terminalEbitTwd = terminalPeriod.ebitTwd;
    terminalCashTaxesTwd = terminalPeriod.cashTaxesTwd;
    terminalReinvestmentTwd = terminalPeriod.reinvestmentTwd;
    terminalFcffTwd = terminalPeriod.fcffTwd;
  }

  if (terminalFcffTwd <= 0) {
    fail(
      "TERMINAL_VALUE_NOT_VIABLE",
      "Perpetuity-growth terminal FCFF must be positive under the evaluated assumptions.",
      {
        solveFor: input.solveFor,
        terminalFcffTwd,
        terminalGrowthPercent: terminalGrowth * 100,
      },
    );
  }

  const undiscountedTerminalValueTwd = assertFiniteCalculation(
    terminalFcffTwd / (wacc - terminalGrowth),
    "undiscountedTerminalValueTwd",
  );
  const factor = presentValueFactor(wacc, input.forecastYears);
  const presentValueTerminalTwd = assertFiniteCalculation(
    undiscountedTerminalValueTwd * factor,
    "presentValueTerminalTwd",
  );
  return {
    method: "perpetuity_growth",
    terminalRevenueTwd,
    terminalOperatingMarginPercent,
    terminalEbitTwd,
    terminalCashTaxesTwd,
    terminalReinvestmentTwd,
    terminalFcffTwd,
    waccPercent: wacc * 100,
    terminalGrowthPercent: terminalGrowth * 100,
    undiscountedTerminalValueTwd,
    discountPeriodYears: input.forecastYears,
    presentValueFactor: factor,
    presentValueTerminalTwd,
    formula: "terminal_fcff_divided_by_wacc_minus_terminal_growth",
  };
}

function evaluateValidated(
  input: ReverseDcfInput,
  solvedDriverPercent: number,
  rates: RateOverrides,
  bridge: ReverseDcfEnterpriseValueBridge,
): ReverseDcfEvaluation {
  if (!Number.isFinite(solvedDriverPercent)) {
    fail("INVALID_INPUT", "solvedDriverPercent must be finite.", {
      solvedDriverPercent,
    });
  }
  validateRates(rates.waccPercent, rates.terminalGrowthPercent);
  const wacc = rates.waccPercent / 100;
  const terminalGrowth = rates.terminalGrowthPercent / 100;
  const forecast = forecastAt(input, solvedDriverPercent, wacc);
  const terminalWithoutShare = terminalAt(
    input,
    forecast,
    wacc,
    terminalGrowth,
  );
  const explicitForecastTwd = assertFiniteCalculation(
    forecast.reduce((sum, period) => sum + period.presentValueFcffTwd, 0),
    "explicitForecastTwd",
  );
  const modeledEnterpriseValueTwd = assertFiniteCalculation(
    explicitForecastTwd + terminalWithoutShare.presentValueTerminalTwd,
    "modeledEnterpriseValueTwd",
  );
  const terminal: ReverseDcfTerminalValue = {
    ...terminalWithoutShare,
    presentValueTerminalPercentOfEnterpriseValue:
      modeledEnterpriseValueTwd === 0
        ? null
        : assertFiniteCalculation(
            (terminalWithoutShare.presentValueTerminalTwd /
              modeledEnterpriseValueTwd) *
              100,
            "presentValueTerminalPercentOfEnterpriseValue",
          ),
  };
  const presentValue: ReverseDcfPresentValue = {
    explicitForecastTwd,
    terminalValueTwd: terminal.presentValueTerminalTwd,
    modeledEnterpriseValueTwd,
    targetEnterpriseValueTwd: bridge.targetEnterpriseValueTwd,
    residualTwd: assertFiniteCalculation(
      modeledEnterpriseValueTwd - bridge.targetEnterpriseValueTwd,
      "residualTwd",
    ),
  };
  return { solvedDriverPercent, forecast, terminal, presentValue };
}

export function evaluateReverseDcfAt(
  input: ReverseDcfInput,
  solvedDriverPercent: number,
  rateOverrides?: Partial<RateOverrides>,
): ReverseDcfEvaluation {
  validateInput(input);
  const bridge = buildBridge(input.marketFacts);
  return evaluateValidated(
    input,
    solvedDriverPercent,
    {
      waccPercent: rateOverrides?.waccPercent ?? input.waccPercent,
      terminalGrowthPercent:
        rateOverrides?.terminalGrowthPercent ?? input.terminalGrowthPercent,
    },
    bridge,
  );
}

function enterpriseValueTolerance(targetEnterpriseValueTwd: number): number {
  return Math.max(
    REVERSE_DCF_SOLVER_POLICY.enterpriseValueAbsoluteToleranceTwd,
    Math.abs(targetEnterpriseValueTwd) *
      REVERSE_DCF_SOLVER_POLICY.enterpriseValueRelativeTolerance,
  );
}

function monotonicDirection(
  input: ReverseDcfInput,
  rates: RateOverrides,
  bridge: ReverseDcfEnterpriseValueBridge,
): "increasing" | "decreasing" {
  const expectedDirection = analyticMonotonicDirection(input, rates);
  const { minimumPercent, maximumPercent } = input.solveRange;
  const interval =
    (maximumPercent - minimumPercent) /
    REVERSE_DCF_SOLVER_POLICY.monotonicSampleIntervals;
  const values: number[] = [];
  for (
    let index = 0;
    index <= REVERSE_DCF_SOLVER_POLICY.monotonicSampleIntervals;
    index += 1
  ) {
    const solveValue =
      index === REVERSE_DCF_SOLVER_POLICY.monotonicSampleIntervals
        ? maximumPercent
        : minimumPercent + interval * index;
    values.push(
      evaluateValidated(input, solveValue, rates, bridge).presentValue
        .modeledEnterpriseValueTwd,
    );
  }
  const scale = Math.max(1, ...values.map((value) => Math.abs(value)));
  const tolerance = Math.max(0.01, scale * 1e-12);
  for (let index = 1; index < values.length; index += 1) {
    const delta = (values[index] as number) - (values[index - 1] as number);
    if (Math.abs(delta) <= tolerance) continue;
    const observedDirection = delta > 0 ? "increasing" : "decreasing";
    if (observedDirection !== expectedDirection) {
      fail(
        "NON_MONOTONIC_SOLVE_RANGE",
        "Sampled enterprise value conflicts with the analytic monotonic direction.",
        {
          solveFor: input.solveFor,
          solveRange: input.solveRange,
          expectedDirection,
          observedDirection,
          reversalAtSampleIndex: index,
          previousEnterpriseValueTwd: values[index - 1],
          enterpriseValueTwd: values[index],
        },
      );
    }
  }
  if (
    Math.abs((values.at(-1) as number) - (values[0] as number)) <=
    enterpriseValueTolerance(bridge.targetEnterpriseValueTwd)
  ) {
    fail(
      "UNIDENTIFIABLE_SOLVE_RANGE",
      "The caller-provided solve range does not change enterprise value enough to identify the solved driver.",
      { solveFor: input.solveFor, solveRange: input.solveRange },
    );
  }
  return expectedDirection;
}

function analyticMonotonicDirection(
  input: ReverseDcfInput,
  rates: RateOverrides,
): "increasing" | "decreasing" {
  if (input.solveFor === "fcff_cagr") return "increasing";
  if (input.solveFor === "terminal_operating_margin") return "increasing";
  const afterTaxMargin =
    (input.operatingAssumptions.normalizedOperatingMarginPercent / 100) *
    (1 - input.operatingAssumptions.cashTaxRatePercent / 100);
  const wacc = rates.waccPercent / 100;
  const capitalCharge =
    wacc /
    (input.operatingAssumptions.salesToCapitalRatio * (1 + wacc));
  const coefficient = afterTaxMargin - capitalCharge;
  const coefficientTolerance =
    Math.max(1, Math.abs(afterTaxMargin), Math.abs(capitalCharge)) * 1e-12;
  if (Math.abs(coefficient) <= coefficientTolerance) {
    fail(
      "UNIDENTIFIABLE_SOLVE_RANGE",
      "Revenue CAGR is not identifiable because after-tax margin equals the WACC-adjusted reinvestment charge.",
      {
        afterTaxMargin,
        capitalCharge,
        directionalCoefficient: coefficient,
        formula:
          "after_tax_margin - wacc / (sales_to_capital * (1 + wacc))",
      },
    );
  }
  return coefficient > 0 ? "increasing" : "decreasing";
}

function modeFormula(input: ReverseDcfInput): ReverseDcfSolution["modeFormula"] {
  if (input.solveFor === "revenue_cagr") {
    return "constant_revenue_cagr_with_constant_normalized_margin_cash_tax_and_delta_revenue_over_sales_to_capital";
  }
  if (input.solveFor === "fcff_cagr") {
    return "constant_compounded_fcff_cagr";
  }
  return "caller_revenue_cagr_with_linear_margin_transition_cash_tax_and_delta_revenue_over_sales_to_capital";
}

function solvedResult(
  input: ReverseDcfInput,
  rates: RateOverrides,
  bridge: ReverseDcfEnterpriseValueBridge,
): SolvedAtRates {
  const direction = monotonicDirection(input, rates, bridge);
  const lowerEndpoint = evaluateValidated(
    input,
    input.solveRange.minimumPercent,
    rates,
    bridge,
  );
  const upperEndpoint = evaluateValidated(
    input,
    input.solveRange.maximumPercent,
    rates,
    bridge,
  );
  const target = bridge.targetEnterpriseValueTwd;
  const evTolerance = enterpriseValueTolerance(target);
  const lowerResidual = lowerEndpoint.presentValue.residualTwd;
  const upperResidual = upperEndpoint.presentValue.residualTwd;

  let evaluation: ReverseDcfEvaluation;
  let iterations = 0;
  let converged = false;
  if (Math.abs(lowerResidual) <= evTolerance) {
    evaluation = lowerEndpoint;
    converged = true;
  } else if (Math.abs(upperResidual) <= evTolerance) {
    evaluation = upperEndpoint;
    converged = true;
  } else {
    if (
      (lowerResidual < 0 && upperResidual < 0) ||
      (lowerResidual > 0 && upperResidual > 0)
    ) {
      fail(
        "NO_FEASIBLE_SOLUTION",
        "Caller-provided solveRange does not bracket the observed-price enterprise value.",
        {
          solveFor: input.solveFor,
          solveRange: input.solveRange,
          targetEnterpriseValueTwd: target,
          lowerEndpointModeledEnterpriseValueTwd:
            lowerEndpoint.presentValue.modeledEnterpriseValueTwd,
          upperEndpointModeledEnterpriseValueTwd:
            upperEndpoint.presentValue.modeledEnterpriseValueTwd,
        },
      );
    }
    let lowValue = input.solveRange.minimumPercent;
    let highValue = input.solveRange.maximumPercent;
    let lowResidualMutable = lowerResidual;
    let highResidualMutable = upperResidual;
    evaluation = lowerEndpoint;
    for (
      iterations = 1;
      iterations <= REVERSE_DCF_SOLVER_POLICY.maximumIterations;
      iterations += 1
    ) {
      const midpoint = (lowValue + highValue) / 2;
      if (midpoint === lowValue || midpoint === highValue) {
        fail(
          "NUMERICAL_FAILURE",
          "Deterministic bisection stagnated before meeting the enterprise-value residual tolerance.",
          {
            solveFor: input.solveFor,
            iterations,
            lowValuePercent: lowValue,
            highValuePercent: highValue,
            lowResidualTwd: lowResidualMutable,
            highResidualTwd: highResidualMutable,
            enterpriseValueToleranceTwd: evTolerance,
            solverPolicy: REVERSE_DCF_SOLVER_POLICY,
          },
        );
      }
      const midpointEvaluation = evaluateValidated(
        input,
        midpoint,
        rates,
        bridge,
      );
      const midpointResidual = midpointEvaluation.presentValue.residualTwd;
      evaluation = midpointEvaluation;
      if (Math.abs(midpointResidual) <= evTolerance) {
        converged = true;
        break;
      }
      if (
        (midpointResidual < 0 && lowResidualMutable < 0) ||
        (midpointResidual > 0 && lowResidualMutable > 0)
      ) {
        lowValue = midpoint;
        lowResidualMutable = midpointResidual;
      } else {
        highValue = midpoint;
        highResidualMutable = midpointResidual;
      }
    }
    if (!converged) {
      fail(
        "NUMERICAL_FAILURE",
        "Deterministic bisection exhausted its disclosed maximum iterations before meeting the enterprise-value residual tolerance.",
        {
          solveFor: input.solveFor,
          iterations: REVERSE_DCF_SOLVER_POLICY.maximumIterations,
          residualTwd: evaluation.presentValue.residualTwd,
          enterpriseValueToleranceTwd: evTolerance,
          solverPolicy: REVERSE_DCF_SOLVER_POLICY,
        },
      );
    }
  }

  if (!converged || Math.abs(evaluation.presentValue.residualTwd) > evTolerance) {
    fail(
      "NUMERICAL_FAILURE",
      "Reverse DCF solver did not meet the enterprise-value residual tolerance.",
      {
        solveFor: input.solveFor,
        iterations,
        residualTwd: evaluation.presentValue.residualTwd,
        enterpriseValueToleranceTwd: evTolerance,
        solverPolicy: REVERSE_DCF_SOLVER_POLICY,
      },
    );
  }

  const solution: ReverseDcfSolution = {
    solveFor: input.solveFor,
    solvedValuePercent: Object.is(evaluation.solvedDriverPercent, -0)
      ? 0
      : evaluation.solvedDriverPercent,
    solveRange: { ...input.solveRange },
    monotonicDirection: direction,
    iterations,
    converged: true,
    lowerEndpointModeledEnterpriseValueTwd:
      lowerEndpoint.presentValue.modeledEnterpriseValueTwd,
    upperEndpointModeledEnterpriseValueTwd:
      upperEndpoint.presentValue.modeledEnterpriseValueTwd,
    targetEnterpriseValueTwd: target,
    residualTwd: evaluation.presentValue.residualTwd,
    modeFormula: modeFormula(input),
    solverPolicy: { ...REVERSE_DCF_SOLVER_POLICY },
  };
  return { solution, evaluation };
}

function fact(
  id: string,
  value: number | string | boolean,
  unit: ReverseDcfEvidenceUnit,
  provenance: ReverseDcfFactProvenance,
): ReverseDcfInputFactEvidence {
  if (
    provenance.evidenceClass === "UNAVAILABLE" ||
    provenance.evidenceClass === "CALLER_ASSUMPTION"
  ) {
    fail("MISSING_REQUIRED_INPUT", "Required sourced fact provenance is unavailable.", {
      id,
      evidenceClass: provenance.evidenceClass,
    });
  }
  return {
    id,
    value,
    unit,
    evidenceClass: provenance.evidenceClass,
    lineageIds: [...provenance.lineageIds],
    formula: null,
  };
}

function normalizedInputEvidence(
  id: string,
  value: number | string | boolean,
  unit: ReverseDcfEvidenceUnit,
  provenance: ReverseDcfFactProvenance,
): ReverseDcfInputFactEvidence | ReverseDcfAssumptionEvidence {
  if (provenance.evidenceClass === "CALLER_ASSUMPTION") {
    return assumption(id, value, unit);
  }
  return fact(id, value, unit, provenance);
}

function assumption(
  id: string,
  value: number | string | boolean,
  unit: ReverseDcfEvidenceUnit,
): ReverseDcfAssumptionEvidence {
  return {
    id,
    value,
    unit,
    evidenceClass: "CALLER_ASSUMPTION",
    lineageIds: [],
    formula: null,
  };
}

function modelOutput(
  id: string,
  value: number | string | boolean,
  unit: ReverseDcfEvidenceUnit,
  formula: string,
): ReverseDcfModelOutputEvidence {
  return {
    id,
    value,
    unit,
    evidenceClass: "MODEL_OUTPUT",
    lineageIds: [],
    formula,
  };
}

function buildEvidence(
  input: ReverseDcfInput,
  bridge: ReverseDcfEnterpriseValueBridge,
  solution: ReverseDcfSolution,
  evaluation: ReverseDcfEvaluation,
): ReverseDcfEvidence {
  const provenance = new Map(
    input.factProvenance.map((item) => [item.id, item] as const),
  );
  const provenanceFor = (id: string): ReverseDcfFactProvenance => {
    const item = provenance.get(id);
    if (!item) {
      fail("MISSING_REQUIRED_INPUT", "Required fact provenance is missing.", {
        id,
      });
    }
    return item;
  };
  const normalizedInputs: Array<
    ReverseDcfInputFactEvidence | ReverseDcfAssumptionEvidence
  > = [
    normalizedInputEvidence(
      "company.companyCode",
      input.company.companyCode,
      "category",
      provenanceFor("company.companyCode"),
    ),
    normalizedInputEvidence(
      "company.isFinancial",
      input.company.isFinancial,
      "boolean",
      provenanceFor("company.isFinancial"),
    ),
    normalizedInputEvidence(
      "marketFacts.observedPricePerShareTwd",
      input.marketFacts.observedPricePerShareTwd,
      "TWD_per_share",
      provenanceFor("marketFacts.observedPricePerShareTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.observedPriceDate",
      input.marketFacts.observedPriceDate,
      "date",
      provenanceFor("marketFacts.observedPriceDate"),
    ),
    normalizedInputEvidence(
      "marketFacts.sharesOutstanding",
      input.marketFacts.sharesOutstanding,
      "share",
      provenanceFor("marketFacts.sharesOutstanding"),
    ),
    normalizedInputEvidence(
      "marketFacts.shareCountBasis",
      input.marketFacts.shareCountBasis,
      "category",
      provenanceFor("marketFacts.shareCountBasis"),
    ),
    normalizedInputEvidence(
      "marketFacts.cashAndCashEquivalentsTwd",
      input.marketFacts.cashAndCashEquivalentsTwd,
      "TWD",
      provenanceFor("marketFacts.cashAndCashEquivalentsTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.nonOperatingAssetsTwd",
      input.marketFacts.nonOperatingAssetsTwd,
      "TWD",
      provenanceFor("marketFacts.nonOperatingAssetsTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.interestBearingDebtTwd",
      input.marketFacts.interestBearingDebtTwd,
      "TWD",
      provenanceFor("marketFacts.interestBearingDebtTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.leaseLiabilitiesTwd",
      input.marketFacts.leaseLiabilitiesTwd,
      "TWD",
      provenanceFor("marketFacts.leaseLiabilitiesTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.nonControllingInterestsTwd",
      input.marketFacts.nonControllingInterestsTwd,
      "TWD",
      provenanceFor("marketFacts.nonControllingInterestsTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.preferredEquityTwd",
      input.marketFacts.preferredEquityTwd,
      "TWD",
      provenanceFor("marketFacts.preferredEquityTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.pensionDeficitTwd",
      input.marketFacts.pensionDeficitTwd,
      "TWD",
      provenanceFor("marketFacts.pensionDeficitTwd"),
    ),
    normalizedInputEvidence(
      "marketFacts.otherDebtLikeItemsTwd",
      input.marketFacts.otherDebtLikeItemsTwd,
      "TWD",
      provenanceFor("marketFacts.otherDebtLikeItemsTwd"),
    ),
  ];
  if (input.solveFor === "fcff_cagr") {
    normalizedInputs.push(
      normalizedInputEvidence(
        "operatingFacts.baseFcffTwd",
        input.operatingFacts.baseFcffTwd,
        "TWD",
        provenanceFor("operatingFacts.baseFcffTwd"),
      ),
    );
  } else {
    normalizedInputs.push(
      normalizedInputEvidence(
        "operatingFacts.baseRevenueTwd",
        input.operatingFacts.baseRevenueTwd,
        "TWD",
        provenanceFor("operatingFacts.baseRevenueTwd"),
      ),
    );
    if (input.solveFor === "terminal_operating_margin") {
      normalizedInputs.push(
        normalizedInputEvidence(
          "operatingFacts.baseOperatingMarginPercent",
          input.operatingFacts.baseOperatingMarginPercent,
          "percent",
          provenanceFor("operatingFacts.baseOperatingMarginPercent"),
        ),
      );
    }
  }

  const inputFacts = normalizedInputs.filter(
    (item): item is ReverseDcfInputFactEvidence =>
      item.evidenceClass !== "CALLER_ASSUMPTION",
  );
  const assumptions: ReverseDcfAssumptionEvidence[] = [
    ...normalizedInputs.filter(
      (item): item is ReverseDcfAssumptionEvidence =>
        item.evidenceClass === "CALLER_ASSUMPTION",
    ),
    assumption("forecastYears", input.forecastYears, "year"),
    assumption("waccPercent", input.waccPercent, "percent"),
    assumption(
      "terminalGrowthPercent",
      input.terminalGrowthPercent,
      "percent",
    ),
    assumption("solveFor", input.solveFor, "category"),
    assumption(
      "solveRange.minimumPercent",
      input.solveRange.minimumPercent,
      "percent",
    ),
    assumption(
      "solveRange.maximumPercent",
      input.solveRange.maximumPercent,
      "percent",
    ),
    assumption("discountConvention", "year_end", "category"),
    assumption("terminalValueMethod", "perpetuity_growth", "category"),
  ];
  if (input.solveFor === "revenue_cagr") {
    assumptions.push(
      assumption(
        "operatingAssumptions.marginPolicy",
        input.operatingAssumptions.marginPolicy,
        "category",
      ),
      assumption(
        "operatingAssumptions.normalizedOperatingMarginPercent",
        input.operatingAssumptions.normalizedOperatingMarginPercent,
        "percent",
      ),
      assumption(
        "operatingAssumptions.cashTaxRatePercent",
        input.operatingAssumptions.cashTaxRatePercent,
        "percent",
      ),
      assumption(
        "operatingAssumptions.salesToCapitalRatio",
        input.operatingAssumptions.salesToCapitalRatio,
        "ratio",
      ),
    );
  } else if (input.solveFor === "fcff_cagr") {
    assumptions.push(
      assumption(
        "operatingAssumptions.growthPolicy",
        input.operatingAssumptions.growthPolicy,
        "category",
      ),
    );
  } else {
    assumptions.push(
      assumption(
        "operatingAssumptions.revenueCagrPercent",
        input.operatingAssumptions.revenueCagrPercent,
        "percent",
      ),
      assumption(
        "operatingAssumptions.cashTaxRatePercent",
        input.operatingAssumptions.cashTaxRatePercent,
        "percent",
      ),
      assumption(
        "operatingAssumptions.salesToCapitalRatio",
        input.operatingAssumptions.salesToCapitalRatio,
        "ratio",
      ),
      assumption(
        "operatingAssumptions.marginTransition",
        input.operatingAssumptions.marginTransition,
        "category",
      ),
    );
  }
  if (input.sensitivityGrids) {
    input.sensitivityGrids.waccPercent.forEach((value, index) =>
      assumptions.push(
        assumption(`sensitivityGrids.waccPercent.${index}`, value, "percent"),
      ),
    );
    input.sensitivityGrids.terminalGrowthPercent.forEach((value, index) =>
      assumptions.push(
        assumption(
          `sensitivityGrids.terminalGrowthPercent.${index}`,
          value,
          "percent",
        ),
      ),
    );
  }

  const modelOutputs: ReverseDcfModelOutputEvidence[] = [
    modelOutput(
      "bridge.observedEquityValueTwd",
      bridge.observedEquityValueTwd,
      "TWD",
      "observedPricePerShareTwd * sharesOutstanding",
    ),
    modelOutput(
      "bridge.targetEnterpriseValueTwd",
      bridge.targetEnterpriseValueTwd,
      "TWD",
      bridge.formula,
    ),
    modelOutput(
      "solution.solvedValuePercent",
      solution.solvedValuePercent,
      "percent",
      "bisection(modeledEnterpriseValueTwd - targetEnterpriseValueTwd = 0)",
    ),
    modelOutput(
      "presentValue.explicitForecastTwd",
      evaluation.presentValue.explicitForecastTwd,
      "TWD",
      "sum(fcff_t / (1 + wacc)^t)",
    ),
    modelOutput(
      "terminal.terminalFcffTwd",
      evaluation.terminal.terminalFcffTwd,
      "TWD",
      input.solveFor === "fcff_cagr"
        ? "finalForecastFcffTwd * (1 + terminalGrowth)"
        : "terminalRevenueTwd * terminalOperatingMargin * (1 - cashTaxRate_on_positive_ebit) - deltaRevenueTwd / salesToCapitalRatio",
    ),
    modelOutput(
      "terminal.undiscountedTerminalValueTwd",
      evaluation.terminal.undiscountedTerminalValueTwd,
      "TWD",
      "terminalFcffTwd / (wacc - terminalGrowth)",
    ),
    modelOutput(
      "terminal.presentValueTerminalTwd",
      evaluation.terminal.presentValueTerminalTwd,
      "TWD",
      "undiscountedTerminalValueTwd / (1 + wacc)^forecastYears",
    ),
    modelOutput(
      "presentValue.modeledEnterpriseValueTwd",
      evaluation.presentValue.modeledEnterpriseValueTwd,
      "TWD",
      "explicitForecastTwd + presentValueTerminalTwd",
    ),
    modelOutput(
      "presentValue.residualTwd",
      evaluation.presentValue.residualTwd,
      "TWD",
      "modeledEnterpriseValueTwd - targetEnterpriseValueTwd",
    ),
  ];
  return { inputFacts, assumptions, modelOutputs };
}

function buildSensitivities(
  input: ReverseDcfInput,
  bridge: ReverseDcfEnterpriseValueBridge,
): ReverseDcfSensitivityCell[] {
  if (!input.sensitivityGrids) return [];
  const cells: ReverseDcfSensitivityCell[] = [];
  for (const waccPercent of input.sensitivityGrids.waccPercent) {
    for (const terminalGrowthPercent of input.sensitivityGrids
      .terminalGrowthPercent) {
      try {
        const solved = solvedResult(
          input,
          { waccPercent, terminalGrowthPercent },
          bridge,
        );
        cells.push({
          waccPercent,
          terminalGrowthPercent,
          status: "solved",
          solvedValuePercent: solved.solution.solvedValuePercent,
          modeledEnterpriseValueTwd:
            solved.evaluation.presentValue.modeledEnterpriseValueTwd,
          residualTwd: solved.evaluation.presentValue.residualTwd,
          errorCode: null,
        });
      } catch (error) {
        if (
          error instanceof ReverseDcfError &&
          (error.code === "NO_FEASIBLE_SOLUTION" ||
            error.code === "NON_MONOTONIC_SOLVE_RANGE" ||
            error.code === "UNIDENTIFIABLE_SOLVE_RANGE" ||
            error.code === "TERMINAL_VALUE_NOT_VIABLE")
        ) {
          cells.push({
            waccPercent,
            terminalGrowthPercent,
            status:
              error.code === "NO_FEASIBLE_SOLUTION"
                ? "no_feasible_solution"
                : error.code === "NON_MONOTONIC_SOLVE_RANGE"
                  ? "non_monotonic_solve_range"
                  : error.code === "UNIDENTIFIABLE_SOLVE_RANGE"
                    ? "unidentifiable_solve_range"
                    : "terminal_value_not_viable",
            solvedValuePercent: null,
            modeledEnterpriseValueTwd: null,
            residualTwd: null,
            errorCode: error.code,
          });
          continue;
        }
        throw error;
      }
    }
  }
  return cells;
}

export function solveReverseDcf(input: ReverseDcfInput): ReverseDcfResult {
  validateInput(input);
  const bridge = buildBridge(input.marketFacts);
  const solved = solvedResult(
    input,
    {
      waccPercent: input.waccPercent,
      terminalGrowthPercent: input.terminalGrowthPercent,
    },
    bridge,
  );
  const evTolerance = enterpriseValueTolerance(bridge.targetEnterpriseValueTwd);
  const expectedTerminalFactor = presentValueFactor(
    input.waccPercent / 100,
    input.forecastYears,
  );
  const bridgeTieOutTolerance = 0.01;
  const bridgeTieOutResidual = assertFiniteCalculation(
    bridge.targetEnterpriseValueTwd -
      (bridge.observedEquityValueTwd +
        bridge.plusInterestBearingDebtTwd +
        bridge.plusLeaseLiabilitiesTwd +
        bridge.plusNonControllingInterestsTwd +
        bridge.plusPreferredEquityTwd +
        bridge.plusPensionDeficitTwd +
        bridge.plusOtherDebtLikeItemsTwd -
        bridge.lessCashAndCashEquivalentsTwd -
        bridge.lessNonOperatingAssetsTwd),
    "enterprise_to_equity_bridge_tie_out",
  );
  const terminalDiscountResidual = assertFiniteCalculation(
    solved.evaluation.terminal.presentValueFactor - expectedTerminalFactor,
    "terminal_value_discounted_at_forecast_horizon",
  );
  assertNumericalInvariant(
    "enterprise_to_equity_bridge_tie_out",
    bridgeTieOutResidual,
    bridgeTieOutTolerance,
  );
  assertNumericalInvariant(
    "terminal_value_discounted_at_forecast_horizon",
    terminalDiscountResidual,
    Number.EPSILON,
  );
  assertNumericalInvariant(
    "market_enterprise_value_solve_tie_out",
    solved.evaluation.presentValue.residualTwd,
    evTolerance,
  );
  return {
    modelVersion: REVERSE_DCF_MODEL_VERSION,
    modelType: "market_implied_reverse_dcf",
    cashFlowBasis: "fcff",
    discountRateBasis: "wacc",
    discountConvention: "year_end",
    currency: "TWD",
    posture: "research_model_output_not_investment_advice",
    company: { ...input.company },
    solution: solved.solution,
    forecast: solved.evaluation.forecast,
    terminal: solved.evaluation.terminal,
    bridge,
    presentValue: solved.evaluation.presentValue,
    evidence: buildEvidence(
      input,
      bridge,
      solved.solution,
      solved.evaluation,
    ),
    sensitivities: buildSensitivities(input, bridge),
    checks: [
      {
        id: "non_financial_fcff_scope",
        status: "pass",
        value: !input.company.isFinancial,
        tolerance: null,
      },
      {
        id: "wacc_above_terminal_growth",
        status: "pass",
        value: input.waccPercent - input.terminalGrowthPercent,
        tolerance: 0,
      },
      {
        id: "enterprise_to_equity_bridge_tie_out",
        status: "pass",
        value: bridgeTieOutResidual,
        tolerance: bridgeTieOutTolerance,
      },
      {
        id: "terminal_value_discounted_at_forecast_horizon",
        status: "pass",
        value: terminalDiscountResidual,
        tolerance: Number.EPSILON,
      },
      {
        id: "market_enterprise_value_solve_tie_out",
        status: "pass",
        value: solved.evaluation.presentValue.residualTwd,
        tolerance: evTolerance,
      },
      {
        id: "solve_range_monotonic",
        status: "pass",
        value: solved.solution.monotonicDirection,
        tolerance: null,
      },
    ],
    limitations: [
      "market_implied_result_depends_on_caller_provided_facts_and_assumptions",
      "not_consensus_not_target_price_not_investment_advice",
      "fcff_discounted_only_at_wacc_and_bridged_from_enterprise_to_equity_value",
    ],
  };
}
