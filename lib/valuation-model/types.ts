import type { CompanyMarket } from "@/lib/company-master/types";
import type {
  AuthoritativeCompletedCloseResult,
  AuthoritativeCompletedCloseSource,
} from "@/lib/completed-close/types";
import type { MopsfinError } from "@/lib/mopsfin/errors";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import type { StatementKind } from "@/lib/mopsfin/client";

export type ValuationModelEvidenceClass =
  | "MOPSFIN_RAW"
  | "MOPSFIN_CALC"
  | "OFFICIAL_MASTER_RAW"
  | "OFFICIAL_MARKET_RAW"
  | "OFFICIAL_CALC"
  | "MIXED_OFFICIAL_CALC"
  | "UNAVAILABLE";

export type ValuationModelFieldStatus =
  | "reported"
  | "derived"
  | "data_gap"
  | "not_applicable";

export type ValuationModelUnit =
  | "TWD"
  | "TWD_per_share"
  | "share"
  | "percent";

export type ValuationModelFieldId =
  | "ttmRevenue"
  | "ttmOperatingIncomeEbitProxy"
  | "cashTaxRatePercent"
  | "ttmDepreciationAndAmortization"
  | "ttmCapitalExpenditure"
  | "ttmDeltaNetWorkingCapital"
  | "normalizedFcff"
  | "cashAndCashEquivalents"
  | "interestBearingDebt"
  | "netDebt"
  | "issuedShares"
  | "latestOfficialClose"
  | "marketCapitalization"
  | "enterpriseValue";

export type ValuationModelDataGapReason =
  | "STATEMENT_UNAVAILABLE"
  | "STATEMENT_CONTRACT_MISMATCH"
  | "STATEMENT_UNIT_UNAVAILABLE"
  | "STATEMENT_UNIT_UNSUPPORTED"
  | "STATEMENT_IDENTITY_MISMATCH"
  | "STATEMENT_CONSOLIDATION_SCOPE_MISMATCH"
  | "ROW_ROLE_MISSING"
  | "ROW_ROLE_AMBIGUOUS"
  | "ROW_VALUE_INVALID"
  | "TTM_COMPONENT_UNAVAILABLE"
  | "TTM_PERIOD_MISMATCH"
  | "NO_REPORTED_DEBT_COMPONENTS"
  | "UNMAPPED_DEBT_LIKE_ROW"
  | "COMPANY_PROFILE_VALUE_UNAVAILABLE"
  | "VALUATION_VALUE_UNAVAILABLE"
  | "SOURCE_DEPENDENCY_FAILED"
  | "DERIVED_INPUT_UNAVAILABLE"
  | "NOT_APPLICABLE_FINANCIAL_COMPANY";

export interface ValuationModelInputField {
  id: ValuationModelFieldId;
  value: number | null;
  unit: ValuationModelUnit;
  status: ValuationModelFieldStatus;
  evidenceClass: ValuationModelEvidenceClass;
  formula: string | null;
  inputFieldIds: ValuationModelFieldId[];
  inputLineageIds: string[];
  dataGapReason: ValuationModelDataGapReason | null;
  notes: string[];
}

interface ValuationModelSourceBase {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  cache?: CacheProvenance;
}

export interface ValuationModelStatementSource
  extends ValuationModelSourceBase {
  stage: "statement";
  upstreamRoute: string;
  statement: StatementKind;
  period: string;
  asOf: string;
  asOfGranularity: "quarter";
  reportName: string;
  rawUnit: string;
  unitSource: "response_html" | "catalog" | "unavailable";
  normalizedUnit: "TWD";
  amountMultiplier: 1000;
  consolidationScope: "consolidated" | "standalone";
}

export interface ValuationModelCompanyMasterSource
  extends ValuationModelSourceBase {
  stage: "company_master";
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  reportDate: string;
  asOf: string;
  asOfGranularity: "date";
}

export interface ValuationModelCompletedCloseSource
  extends ValuationModelSourceBase,
    Omit<AuthoritativeCompletedCloseSource, keyof ValuationModelSourceBase> {
  stage: "latest_official_completed_close";
  asOf: string;
  asOfGranularity: "date";
}

export type ValuationModelSource =
  | ValuationModelStatementSource
  | ValuationModelCompanyMasterSource
  | ValuationModelCompletedCloseSource;

export type ValuationModelLineageStatus =
  | "resolved"
  | "missing"
  | "ambiguous"
  | "invalid";

export interface ValuationModelLineageEntry {
  lineageId: string;
  role: string;
  status: ValuationModelLineageStatus;
  sourceId: string | null;
  statement: StatementKind | null;
  period: string | null;
  rowLabel: string | null;
  rawValue: string | number | null;
  normalizedValue: number | null;
  unit: ValuationModelUnit;
  candidateRowLabels: string[];
  notes: string[];
}

export interface ValuationModelPeriods {
  latestReportedPeriod: string | null;
  ttmMethod:
    | "fiscal_year"
    | "current_ytd_plus_prior_fy_minus_prior_year_ytd"
    | "unavailable";
  currentYtdPeriod: string | null;
  priorFiscalYearPeriod: string | null;
  priorYearYtdPeriod: string | null;
  fiscalYearBasis: "mopsfin_calendar_year_quarters";
  consolidationScope: "consolidated" | "standalone" | null;
}

export interface ValuationModelInputFields {
  ttmRevenue: ValuationModelInputField;
  ttmOperatingIncomeEbitProxy: ValuationModelInputField;
  cashTaxRatePercent: ValuationModelInputField;
  ttmDepreciationAndAmortization: ValuationModelInputField;
  ttmCapitalExpenditure: ValuationModelInputField;
  ttmDeltaNetWorkingCapital: ValuationModelInputField;
  normalizedFcff: ValuationModelInputField;
  cashAndCashEquivalents: ValuationModelInputField;
  interestBearingDebt: ValuationModelInputField;
  netDebt: ValuationModelInputField;
  issuedShares: ValuationModelInputField;
  latestOfficialClose: ValuationModelInputField;
  marketCapitalization: ValuationModelInputField;
  enterpriseValue: ValuationModelInputField;
}

export interface ValuationModelInputsQuery {
  companyCode: string;
}

export interface ValuationModelInputsResult {
  query: {
    companyCode: string;
    financialPeriod: "latest";
    priceDate: "latest_completed_official_session";
  };
  generatedAt: string;
  timezone: "Asia/Taipei";
  currency: "TWD";
  scope: "normalized_valuation_model_inputs";
  posture: "research_model_input_evidence_only";
  applicability: {
    status: "applicable" | "not_applicable";
    reason: "financial_company_requires_residual_income_or_dividend_model" | null;
  };
  company: {
    code: string;
    name: string;
    shortName: string;
    market: CompanyMarket;
    exchange: "TWSE" | "TPEx";
    industryCode: string;
    isFinancial: boolean;
  };
  periods: ValuationModelPeriods;
  fields: ValuationModelInputFields;
  lineage: ValuationModelLineageEntry[];
  sources: ValuationModelSource[];
  quality: {
    calculationComplete: boolean;
    dataGapFields: ValuationModelFieldId[];
    notApplicableFields: ValuationModelFieldId[];
  };
  workBudget: {
    requestedCompanies: 1;
    orchestrationCompanyMasterCalls: 1;
    statementCalls: {
      actual: number;
      maximum: 7;
      rowsPerCallMaximum: 500;
    };
    authoritativeCompletedCloseCalls: {
      actual: 0 | 1;
      maximum: 1;
      completedSessionResolver: {
        actualLogicalLoads: number | null;
        maximumLogicalLoads: number;
      };
      exactStockOhlcAttempts: {
        actual: 0 | 1 | 2 | null;
        maximum: 2;
        cacheRefreshPerformed: boolean | null;
      };
    };
  };
  warnings: string[];
}

export interface ValuationModelInputsExecution {
  data: ValuationModelInputsResult;
  completedClose: AuthoritativeCompletedCloseResult | null;
  completedCloseError: MopsfinError | null;
}
