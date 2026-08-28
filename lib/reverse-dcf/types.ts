export const REVERSE_DCF_MODEL_VERSION = "reverse_dcf.fcff.v1" as const;

export type ReverseDcfSolveFor =
  | "revenue_cagr"
  | "fcff_cagr"
  | "terminal_operating_margin";

export interface ReverseDcfCompanyInput {
  companyCode: string;
  isFinancial: boolean;
}

/**
 * Every bridge item is required. Callers may provide zero only when zero is an
 * explicit normalized fact, never as an engine default.
 */
export interface ReverseDcfMarketFacts {
  observedPricePerShareTwd: number;
  observedPriceDate: string;
  sharesOutstanding: number;
  shareCountBasis: "issued_common_shares" | "diluted_shares";
  cashAndCashEquivalentsTwd: number;
  nonOperatingAssetsTwd: number;
  interestBearingDebtTwd: number;
  leaseLiabilitiesTwd: number;
  nonControllingInterestsTwd: number;
  preferredEquityTwd: number;
  pensionDeficitTwd: number;
  otherDebtLikeItemsTwd: number;
}

export interface ReverseDcfSolveRange {
  minimumPercent: number;
  maximumPercent: number;
}

export interface ReverseDcfSensitivityGrids {
  waccPercent: number[];
  terminalGrowthPercent: number[];
}

export type ReverseDcfEvidenceClass =
  | "MOPSFIN_RAW"
  | "MOPSFIN_CALC"
  | "OFFICIAL_MASTER_RAW"
  | "OFFICIAL_MARKET_RAW"
  | "OFFICIAL_CALC"
  | "MIXED_OFFICIAL_CALC"
  | "CALLER_ASSUMPTION"
  | "MODEL_OUTPUT"
  | "EXTERNAL_EXPECTATION"
  | "UNAVAILABLE";

export interface ReverseDcfFactProvenance {
  id: string;
  evidenceClass:
    | "MOPSFIN_RAW"
    | "MOPSFIN_CALC"
    | "OFFICIAL_MASTER_RAW"
    | "OFFICIAL_MARKET_RAW"
    | "OFFICIAL_CALC"
    | "MIXED_OFFICIAL_CALC"
    | "CALLER_ASSUMPTION"
    | "EXTERNAL_EXPECTATION"
    | "UNAVAILABLE";
  lineageIds: string[];
}

interface ReverseDcfCommonInput {
  company: ReverseDcfCompanyInput;
  currency: "TWD";
  marketFacts: ReverseDcfMarketFacts;
  forecastYears: number;
  waccPercent: number;
  terminalGrowthPercent: number;
  solveRange: ReverseDcfSolveRange;
  factProvenance: ReverseDcfFactProvenance[];
  sensitivityGrids?: ReverseDcfSensitivityGrids;
}

export interface RevenueCagrReverseDcfInput extends ReverseDcfCommonInput {
  solveFor: "revenue_cagr";
  operatingFacts: {
    baseRevenueTwd: number;
  };
  operatingAssumptions: {
    marginPolicy: "constant_normalized";
    normalizedOperatingMarginPercent: number;
    cashTaxRatePercent: number;
    salesToCapitalRatio: number;
  };
}

export interface FcffCagrReverseDcfInput extends ReverseDcfCommonInput {
  solveFor: "fcff_cagr";
  operatingFacts: {
    baseFcffTwd: number;
  };
  operatingAssumptions: {
    growthPolicy: "constant_compounded";
  };
}

export interface TerminalMarginReverseDcfInput extends ReverseDcfCommonInput {
  solveFor: "terminal_operating_margin";
  operatingFacts: {
    baseRevenueTwd: number;
    baseOperatingMarginPercent: number;
  };
  operatingAssumptions: {
    revenueCagrPercent: number;
    cashTaxRatePercent: number;
    salesToCapitalRatio: number;
    marginTransition: "linear_from_base_to_terminal";
  };
}

export type ReverseDcfInput =
  | RevenueCagrReverseDcfInput
  | FcffCagrReverseDcfInput
  | TerminalMarginReverseDcfInput;

export type ReverseDcfErrorCode =
  | "INVALID_INPUT"
  | "MISSING_REQUIRED_INPUT"
  | "NOT_APPLICABLE_FINANCIAL_COMPANY"
  | "UNIDENTIFIABLE_SOLVE_RANGE"
  | "NON_MONOTONIC_SOLVE_RANGE"
  | "NO_FEASIBLE_SOLUTION"
  | "TERMINAL_VALUE_NOT_VIABLE"
  | "NUMERICAL_FAILURE";

export interface ReverseDcfForecastPeriod {
  year: number;
  revenueTwd: number | null;
  revenueGrowthPercent: number | null;
  operatingMarginPercent: number | null;
  ebitTwd: number | null;
  cashTaxesTwd: number | null;
  reinvestmentTwd: number | null;
  fcffTwd: number;
  discountPeriodYears: number;
  presentValueFactor: number;
  presentValueFcffTwd: number;
}

export interface ReverseDcfTerminalValue {
  method: "perpetuity_growth";
  terminalRevenueTwd: number | null;
  terminalOperatingMarginPercent: number | null;
  terminalEbitTwd: number | null;
  terminalCashTaxesTwd: number | null;
  terminalReinvestmentTwd: number | null;
  terminalFcffTwd: number;
  waccPercent: number;
  terminalGrowthPercent: number;
  undiscountedTerminalValueTwd: number;
  discountPeriodYears: number;
  presentValueFactor: number;
  presentValueTerminalTwd: number;
  presentValueTerminalPercentOfEnterpriseValue: number | null;
  formula: "terminal_fcff_divided_by_wacc_minus_terminal_growth";
}

export interface ReverseDcfEnterpriseValueBridge {
  observedPricePerShareTwd: number;
  observedPriceDate: string;
  sharesOutstanding: number;
  shareCountBasis: ReverseDcfMarketFacts["shareCountBasis"];
  observedEquityValueTwd: number;
  plusInterestBearingDebtTwd: number;
  plusLeaseLiabilitiesTwd: number;
  plusNonControllingInterestsTwd: number;
  plusPreferredEquityTwd: number;
  plusPensionDeficitTwd: number;
  plusOtherDebtLikeItemsTwd: number;
  lessCashAndCashEquivalentsTwd: number;
  lessNonOperatingAssetsTwd: number;
  targetEnterpriseValueTwd: number;
  formula:
    "observed_equity_value_plus_debt_like_claims_minus_cash_and_non_operating_assets";
}

export interface ReverseDcfPresentValue {
  explicitForecastTwd: number;
  terminalValueTwd: number;
  modeledEnterpriseValueTwd: number;
  targetEnterpriseValueTwd: number;
  residualTwd: number;
}

export interface ReverseDcfSolverPolicy {
  algorithm: "deterministic_bisection";
  monotonicSampleIntervals: 64;
  maximumIterations: 256;
  enterpriseValueRelativeTolerance: 1e-12;
  enterpriseValueAbsoluteToleranceTwd: 0.01;
}

export interface ReverseDcfSolution {
  solveFor: ReverseDcfSolveFor;
  solvedValuePercent: number;
  solveRange: ReverseDcfSolveRange;
  monotonicDirection: "increasing" | "decreasing";
  iterations: number;
  converged: true;
  lowerEndpointModeledEnterpriseValueTwd: number;
  upperEndpointModeledEnterpriseValueTwd: number;
  targetEnterpriseValueTwd: number;
  residualTwd: number;
  modeFormula:
    | "constant_revenue_cagr_with_constant_normalized_margin_cash_tax_and_delta_revenue_over_sales_to_capital"
    | "constant_compounded_fcff_cagr"
    | "caller_revenue_cagr_with_linear_margin_transition_cash_tax_and_delta_revenue_over_sales_to_capital";
  solverPolicy: ReverseDcfSolverPolicy;
}

export type ReverseDcfEvidenceValue = number | string | boolean;

export type ReverseDcfEvidenceUnit =
  | "TWD"
  | "TWD_per_share"
  | "share"
  | "percent"
  | "ratio"
  | "year"
  | "date"
  | "category"
  | "boolean";

interface ReverseDcfEvidenceBase {
  id: string;
  value: ReverseDcfEvidenceValue;
  unit: ReverseDcfEvidenceUnit;
  formula: string | null;
  evidenceClass: ReverseDcfEvidenceClass;
  lineageIds: string[];
}

export interface ReverseDcfInputFactEvidence extends ReverseDcfEvidenceBase {
  evidenceClass:
    | "MOPSFIN_RAW"
    | "MOPSFIN_CALC"
    | "OFFICIAL_MASTER_RAW"
    | "OFFICIAL_MARKET_RAW"
    | "OFFICIAL_CALC"
    | "MIXED_OFFICIAL_CALC"
    | "EXTERNAL_EXPECTATION";
  formula: null;
}

export interface ReverseDcfAssumptionEvidence extends ReverseDcfEvidenceBase {
  evidenceClass: "CALLER_ASSUMPTION";
  formula: null;
  lineageIds: [];
}

export interface ReverseDcfModelOutputEvidence extends ReverseDcfEvidenceBase {
  evidenceClass: "MODEL_OUTPUT";
  formula: string;
  lineageIds: [];
}

export interface ReverseDcfEvidence {
  inputFacts: ReverseDcfInputFactEvidence[];
  assumptions: ReverseDcfAssumptionEvidence[];
  modelOutputs: ReverseDcfModelOutputEvidence[];
}

export type ReverseDcfSensitivityFailureCode =
  | "NO_FEASIBLE_SOLUTION"
  | "NON_MONOTONIC_SOLVE_RANGE"
  | "UNIDENTIFIABLE_SOLVE_RANGE"
  | "TERMINAL_VALUE_NOT_VIABLE";

export type ReverseDcfSensitivityCell =
  | {
      waccPercent: number;
      terminalGrowthPercent: number;
      status: "solved";
      solvedValuePercent: number;
      modeledEnterpriseValueTwd: number;
      residualTwd: number;
      errorCode: null;
    }
  | {
      waccPercent: number;
      terminalGrowthPercent: number;
      status:
        | "no_feasible_solution"
        | "non_monotonic_solve_range"
        | "unidentifiable_solve_range"
        | "terminal_value_not_viable";
      solvedValuePercent: null;
      modeledEnterpriseValueTwd: null;
      residualTwd: null;
      errorCode: ReverseDcfSensitivityFailureCode;
    };

export interface ReverseDcfCheck {
  id:
    | "non_financial_fcff_scope"
    | "wacc_above_terminal_growth"
    | "enterprise_to_equity_bridge_tie_out"
    | "terminal_value_discounted_at_forecast_horizon"
    | "market_enterprise_value_solve_tie_out"
    | "solve_range_monotonic";
  status: "pass";
  value: number | boolean | string;
  tolerance: number | null;
}

export interface ReverseDcfEvaluation {
  solvedDriverPercent: number;
  forecast: ReverseDcfForecastPeriod[];
  terminal: ReverseDcfTerminalValue;
  presentValue: ReverseDcfPresentValue;
}

export interface ReverseDcfResult {
  modelVersion: typeof REVERSE_DCF_MODEL_VERSION;
  modelType: "market_implied_reverse_dcf";
  cashFlowBasis: "fcff";
  discountRateBasis: "wacc";
  discountConvention: "year_end";
  currency: "TWD";
  posture: "research_model_output_not_investment_advice";
  company: ReverseDcfCompanyInput;
  solution: ReverseDcfSolution;
  forecast: ReverseDcfForecastPeriod[];
  terminal: ReverseDcfTerminalValue;
  bridge: ReverseDcfEnterpriseValueBridge;
  presentValue: ReverseDcfPresentValue;
  evidence: ReverseDcfEvidence;
  sensitivities: ReverseDcfSensitivityCell[];
  checks: ReverseDcfCheck[];
  limitations: [
    "market_implied_result_depends_on_caller_provided_facts_and_assumptions",
    "not_consensus_not_target_price_not_investment_advice",
    "fcff_discounted_only_at_wacc_and_bridged_from_enterprise_to_equity_value",
  ];
}
