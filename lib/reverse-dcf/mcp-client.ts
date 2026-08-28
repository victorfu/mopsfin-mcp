import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { valuationModelInputsClient } from "@/lib/valuation-model/client";
import type {
  ValuationModelEvidenceClass,
  ValuationModelFieldId,
  ValuationModelInputField,
  ValuationModelInputsExecution,
  ValuationModelInputsQuery,
  ValuationModelInputsResult,
  ValuationModelLineageEntry,
  ValuationModelCompletedCloseSource,
  ValuationModelSource,
} from "@/lib/valuation-model/types";

import {
  REVERSE_DCF_SOLVER_POLICY,
  ReverseDcfError,
  solveReverseDcf,
} from "./index";
import type {
  ReverseDcfFactProvenance,
  ReverseDcfInput,
  ReverseDcfResult,
  ReverseDcfSensitivityGrids,
  ReverseDcfSolveFor,
  ReverseDcfSolveRange,
} from "./types";

export interface ReverseDcfValuationInputsLike {
  getValuationModelInputsWithContext(
    query: ValuationModelInputsQuery,
  ): Promise<ValuationModelInputsExecution>;
}

export interface ReverseDcfCallerBridgeAssumptions {
  non_operating_assets_twd: number;
  non_controlling_interests_twd: number;
  preferred_equity_twd: number;
  pension_deficit_twd: number;
  other_debt_like_items_twd: number;
}

export interface ReverseDcfPublicSensitivityGrids {
  wacc_percent: number[];
  terminal_growth_percent: number[];
}

interface ReverseDcfPublicQueryCommon {
  company_code: string;
  price_source: "latest_completed_close";
  forecast_years: number;
  wacc_percent: number;
  terminal_growth_percent: number;
  solve_range: {
    minimum_percent: number;
    maximum_percent: number;
  };
  enterprise_value_bridge: ReverseDcfCallerBridgeAssumptions;
  sensitivity_grids?: ReverseDcfPublicSensitivityGrids;
}

export interface RevenueCagrPublicQuery extends ReverseDcfPublicQueryCommon {
  solve_for: "revenue_cagr";
  forward_assumptions: {
    normalized_operating_margin_percent: number;
    cash_tax_rate_percent: number;
    sales_to_capital_ratio: number;
  };
}

export interface FcffCagrPublicQuery extends ReverseDcfPublicQueryCommon {
  solve_for: "fcff_cagr";
  forward_assumptions: Record<string, never>;
}

export interface TerminalOperatingMarginPublicQuery
  extends ReverseDcfPublicQueryCommon {
  solve_for: "terminal_operating_margin";
  forward_assumptions: {
    revenue_cagr_percent: number;
    cash_tax_rate_percent: number;
    sales_to_capital_ratio: number;
  };
}

export type ReverseDcfPublicQuery =
  | RevenueCagrPublicQuery
  | FcffCagrPublicQuery
  | TerminalOperatingMarginPublicQuery;

export interface ReverseDcfFactMapping {
  mappingId: string;
  engineFactId: string;
  evidenceClass: Exclude<ValuationModelEvidenceClass, "UNAVAILABLE">;
  origin:
    | "valuation_model_field"
    | "valuation_model_company_identity"
    | "valuation_model_source_date"
    | "aggregate_debt_bridge_normalization";
  originFieldIds: ValuationModelFieldId[];
  upstreamLineageIds: string[];
  sourceIds: string[];
  transformation: string | null;
  notes: string[];
}

export interface ReverseDcfOrchestrationResult {
  query: ReverseDcfPublicQuery;
  generatedAt: string;
  timezone: "Asia/Taipei";
  currency: "TWD";
  scope: "market_implied_reverse_dcf";
  posture: "research_model_output_not_investment_advice";
  company: ValuationModelInputsResult["company"];
  model: ReverseDcfResult;
  normalizedInputEvidence: {
    valuationModelGeneratedAt: string;
    usedFieldIds: ValuationModelFieldId[];
    fields: ValuationModelInputsResult["fields"];
    periods: ValuationModelInputsResult["periods"];
    factMappings: ReverseDcfFactMapping[];
    lineageLedger: ValuationModelLineageEntry[];
    sourceLedger: ValuationModelSource[];
  };
  sources: ValuationModelSource[];
  workBudget: {
    valuationModelInputCalls: { actual: 1; maximum: 1 };
    valuationModelInputs: ValuationModelInputsResult["workBudget"];
    reverseDcfEngineOrchestrations: { actual: 1; maximum: 1 };
    sensitivityCells: { requested: number; maximum: 25 };
    solveAttempts: { actual: number; maximum: 26 };
    modelEvaluationUpperBound: {
      perSolveAttempt: number;
      forRequestedWork: number;
      maximum: number;
    };
  };
  warnings: string[];
}

export interface ReverseDcfExecution {
  data: ReverseDcfOrchestrationResult;
  completedClose: AuthoritativeCompletedCloseResult;
}

const COMMON_FIELD_IDS = [
  "cashAndCashEquivalents",
  "interestBearingDebt",
  "issuedShares",
  "latestOfficialClose",
] as const satisfies readonly ValuationModelFieldId[];

interface RequiredFieldContract {
  unit: ValuationModelInputField["unit"];
  status: "reported" | "derived";
  evidenceClass: Exclude<ValuationModelEvidenceClass, "UNAVAILABLE">;
  sourceStage: ValuationModelSource["stage"];
  viability: "positive" | "non_negative";
}

const REQUIRED_FIELD_CONTRACTS = {
  ttmRevenue: {
    unit: "TWD",
    status: "derived",
    evidenceClass: "MOPSFIN_CALC",
    sourceStage: "statement",
    viability: "positive",
  },
  ttmOperatingIncomeEbitProxy: {
    unit: "TWD",
    status: "derived",
    evidenceClass: "MOPSFIN_CALC",
    sourceStage: "statement",
    viability: "non_negative",
  },
  normalizedFcff: {
    unit: "TWD",
    status: "derived",
    evidenceClass: "MOPSFIN_CALC",
    sourceStage: "statement",
    viability: "positive",
  },
  cashAndCashEquivalents: {
    unit: "TWD",
    status: "reported",
    evidenceClass: "MOPSFIN_RAW",
    sourceStage: "statement",
    viability: "non_negative",
  },
  interestBearingDebt: {
    unit: "TWD",
    status: "derived",
    evidenceClass: "MOPSFIN_CALC",
    sourceStage: "statement",
    viability: "non_negative",
  },
  issuedShares: {
    unit: "share",
    status: "reported",
    evidenceClass: "OFFICIAL_MASTER_RAW",
    sourceStage: "company_master",
    viability: "positive",
  },
  latestOfficialClose: {
    unit: "TWD_per_share",
    status: "reported",
    evidenceClass: "OFFICIAL_MARKET_RAW",
    sourceStage: "latest_official_completed_close",
    viability: "positive",
  },
} as const satisfies Partial<
  Record<ValuationModelFieldId, RequiredFieldContract>
>;

type RequiredFieldId = keyof typeof REQUIRED_FIELD_CONTRACTS;

const MAX_SOLVE_ATTEMPTS = 26;
const STRICT_ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MODEL_EVALUATIONS_PER_SOLVE_ATTEMPT_UPPER_BOUND =
  REVERSE_DCF_SOLVER_POLICY.monotonicSampleIntervals +
  1 +
  2 +
  REVERSE_DCF_SOLVER_POLICY.maximumIterations;
const MODEL_EVALUATIONS_MAXIMUM =
  MODEL_EVALUATIONS_PER_SOLVE_ATTEMPT_UPPER_BOUND * MAX_SOLVE_ATTEMPTS;

function failInput(
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    reason,
    category: "input",
    retryable: false,
    action: "fix_input",
    details,
  });
}

function failDataGap(
  companyCode: string,
  fields: ValuationModelInputField[],
  message = "Reverse DCF 所需的 normalized valuation inputs 不完整。",
): never {
  throw new MopsfinError("NO_DATA", message, {
    reason: "DATA_GAP",
    category: "no_data",
    retryable: false,
    action: "change_query",
    details: {
      companyCode,
      fields: fields.map((field) => ({
        id: field.id,
        status: field.status,
        dataGapReason: field.dataGapReason,
      })),
    },
  });
}

function failContract(
  companyCode: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason: "VALUATION_INPUT_CONTRACT_MISMATCH",
    category: "upstream",
    retryable: true,
    action: "retry",
    details: { companyCode, ...details },
  });
}

function failModelBase(
  companyCode: string,
  field: ValuationModelInputField,
  rule: RequiredFieldContract["viability"],
): never {
  throw new MopsfinError(
    "NO_DATA",
    `Reverse DCF 的 sourced base ${field.id} 不符合 ${rule} viability gate。`,
    {
      reason: "MODEL_BASE_NOT_VIABLE",
      category: "no_data",
      retryable: false,
      action: "change_query",
      details: {
        companyCode,
        fieldId: field.id,
        value: field.value,
        unit: field.unit,
        viabilityRule: rule,
      },
    },
  );
}

function assertPublicBounds(query: ReverseDcfPublicQuery): void {
  if (!/^\d{4}$/.test(query.company_code)) {
    failInput("INVALID_COMPANY_CODE", "company_code 必須是四碼公司股票代號。", {
      companyCode: query.company_code,
    });
  }
  if (query.price_source !== "latest_completed_close") {
    failInput(
      "UNSUPPORTED_PRICE_SOURCE",
      "price_source 目前只支援 latest_completed_close。",
      { priceSource: query.price_source },
    );
  }
  if (
    !Number.isInteger(query.forecast_years) ||
    query.forecast_years < 1 ||
    query.forecast_years > 20
  ) {
    failInput("INVALID_FORECAST_YEARS", "forecast_years 必須是 1 至 20 的整數。", {
      forecastYears: query.forecast_years,
    });
  }
  const finiteNumbers: Array<[string, number]> = [
    ["wacc_percent", query.wacc_percent],
    ["terminal_growth_percent", query.terminal_growth_percent],
    ["solve_range.minimum_percent", query.solve_range.minimum_percent],
    ["solve_range.maximum_percent", query.solve_range.maximum_percent],
    ...Object.entries(query.enterprise_value_bridge),
  ];
  if (finiteNumbers.some(([, value]) => !Number.isFinite(value))) {
    failInput("INVALID_INPUT", "所有數值輸入都必須是有限數。", {
      invalidFields: finiteNumbers
        .filter(([, value]) => !Number.isFinite(value))
        .map(([field]) => field),
    });
  }
  if (query.wacc_percent <= query.terminal_growth_percent) {
    failInput(
      "INVALID_INPUT",
      "wacc_percent 必須大於 terminal_growth_percent。",
      {
        waccPercent: query.wacc_percent,
        terminalGrowthPercent: query.terminal_growth_percent,
      },
    );
  }
  if (query.solve_range.minimum_percent >= query.solve_range.maximum_percent) {
    failInput(
      "INVALID_INPUT",
      "solve_range.minimum_percent 必須小於 maximum_percent。",
      { solveRange: query.solve_range },
    );
  }
  const negativeBridgeFields = Object.entries(
    query.enterprise_value_bridge,
  ).filter(([, value]) => value < 0);
  if (negativeBridgeFields.length > 0) {
    failInput(
      "INVALID_INPUT",
      "enterprise_value_bridge 的顯性 caller assumptions 不得為負數。",
      { fields: negativeBridgeFields.map(([field]) => field) },
    );
  }
  const grids = query.sensitivity_grids;
  if (grids) {
    const waccCount = grids.wacc_percent.length;
    const growthCount = grids.terminal_growth_percent.length;
    if (
      waccCount < 1 ||
      growthCount < 1 ||
      waccCount > 5 ||
      growthCount > 5 ||
      waccCount * growthCount > 25
    ) {
      failInput(
        "INVALID_SENSITIVITY_GRID",
        "sensitivity_grids 每軸必須有 1 至 5 個值，且最多 25 cells。",
        { waccCount, growthCount, cells: waccCount * growthCount },
      );
    }
    if (
      new Set(grids.wacc_percent).size !== grids.wacc_percent.length ||
      new Set(grids.terminal_growth_percent).size !==
        grids.terminal_growth_percent.length
    ) {
      failInput(
        "INVALID_SENSITIVITY_GRID",
        "sensitivity_grids 每一軸不得包含重複值。",
      );
    }
    const invalidCells = grids.wacc_percent.flatMap((wacc, waccIndex) =>
      grids.terminal_growth_percent.flatMap((growth, growthIndex) =>
        !Number.isFinite(wacc) ||
        !Number.isFinite(growth) ||
        wacc <= 0 ||
        growth <= -100 ||
        wacc <= growth
          ? [{ waccIndex, growthIndex, wacc, growth }]
          : [],
      ),
    );
    if (invalidCells.length > 0) {
      failInput(
        "INVALID_SENSITIVITY_GRID",
        "每個 sensitivity cell 都必須使用有限數，且滿足 WACC > 0、growth > -100% 與 WACC > growth。",
        { invalidCells },
      );
    }
  }
}

function assertValuationInputIdentity(
  query: ReverseDcfPublicQuery,
  inputs: ValuationModelInputsResult,
): void {
  if (
    inputs.query.companyCode !== query.company_code ||
    inputs.company.code !== query.company_code ||
    inputs.query.financialPeriod !== "latest" ||
    inputs.query.priceDate !== "latest_completed_official_session"
  ) {
    failContract(
      query.company_code,
      "Reverse DCF query 與 normalized valuation-model input company／selector identity 不一致。",
      { inputQuery: inputs.query, company: inputs.company },
    );
  }
  const applicableNonFinancial =
    inputs.applicability.status === "applicable" &&
    inputs.applicability.reason === null &&
    inputs.company.isFinancial === false;
  const notApplicableFinancial =
    inputs.applicability.status === "not_applicable" &&
    inputs.applicability.reason ===
      "financial_company_requires_residual_income_or_dividend_model" &&
    inputs.company.isFinancial === true;
  if (!applicableNonFinancial && !notApplicableFinancial) {
    failContract(
      query.company_code,
      "normalized valuation-model input applicability status、reason 與 company.isFinancial 組合不合法。",
      {
        applicability: inputs.applicability,
        isFinancial: inputs.company.isFinancial,
        allowedCombinations: [
          {
            status: "applicable",
            reason: null,
            isFinancial: false,
          },
          {
            status: "not_applicable",
            reason:
              "financial_company_requires_residual_income_or_dividend_model",
            isFinancial: true,
          },
        ],
      },
    );
  }
  if (notApplicableFinancial) return;
  const valuationGeneratedAtMs = Date.parse(inputs.generatedAt);
  const invalidSourceTime = inputs.sources.find(
    (source) =>
      !STRICT_ISO_INSTANT.test(source.retrievedAt) ||
      !Number.isFinite(Date.parse(source.retrievedAt)) ||
      Date.parse(source.retrievedAt) > valuationGeneratedAtMs,
  );
  if (
    !STRICT_ISO_INSTANT.test(inputs.generatedAt) ||
    !Number.isFinite(valuationGeneratedAtMs) ||
    invalidSourceTime
  ) {
    failContract(
      query.company_code,
      "normalized valuation-model input provenance 必須滿足 strict ISO 與 source retrievedAt <= valuation generatedAt。",
      {
        valuationModelGeneratedAt: inputs.generatedAt,
        invalidSourceTime: invalidSourceTime
          ? {
              sourceId: invalidSourceTime.sourceId,
              retrievedAt: invalidSourceTime.retrievedAt,
            }
          : null,
      },
    );
  }
  const sourceIds = inputs.sources.map((source) => source.sourceId);
  const lineageIds = inputs.lineage.map((entry) => entry.lineageId);
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(lineageIds).size !== lineageIds.length
  ) {
    failContract(
      query.company_code,
      "normalized valuation-model input sourceId／lineageId 必須唯一。",
      { sourceIds, lineageIds },
    );
  }
  const sourceSet = new Set(sourceIds);
  const danglingLineage = inputs.lineage.filter(
    (entry) => entry.sourceId !== null && !sourceSet.has(entry.sourceId),
  );
  if (danglingLineage.length > 0) {
    failContract(
      query.company_code,
      "normalized valuation-model input lineage 引用了不存在的 sourceId。",
      { lineageIds: danglingLineage.map((entry) => entry.lineageId) },
    );
  }
  const companyMasterSources = inputs.sources.filter(
    (source) => source.stage === "company_master",
  );
  if (
    companyMasterSources.length !== 1 ||
    companyMasterSources[0]?.market !== inputs.company.market ||
    companyMasterSources[0]?.exchange !== inputs.company.exchange
  ) {
    failContract(
      query.company_code,
      "Reverse DCF 必須剛好有一個與 company market／exchange 一致的 current-master source。",
      {
        companyMarket: inputs.company.market,
        companyExchange: inputs.company.exchange,
        companyMasterSources,
      },
    );
  }
}

function assertCompletedCloseContext(
  inputs: ValuationModelInputsResult,
  completedClose: AuthoritativeCompletedCloseResult,
): void {
  const sourceIds = new Set(
    sourceIdsForLineage(
      inputs,
      inputs.fields.latestOfficialClose.inputLineageIds,
    ),
  );
  const completedSources = inputs.sources.filter(
    (source): source is ValuationModelCompletedCloseSource =>
      source.stage === "latest_official_completed_close" &&
      sourceIds.has(source.sourceId),
  );
  const source = completedSources[0];
  const budget = inputs.workBudget.authoritativeCompletedCloseCalls;
  if (
    completedSources.length !== 1 ||
    !source ||
    completedClose.company.code !== inputs.company.code ||
    completedClose.company.market !== inputs.company.market ||
    completedClose.company.exchange !== inputs.company.exchange ||
    completedClose.expectedAsOf !== completedClose.selectedBarDate ||
    completedClose.selectedBarDate !== source.selectedBarDate ||
    completedClose.selectedBarDate !== source.asOf ||
    completedClose.source.companyCode !== inputs.company.code ||
    source.companyCode !== inputs.company.code ||
    completedClose.source.sourceUrl !== source.sourceUrl ||
    completedClose.source.retrievedAt !== source.retrievedAt ||
    completedClose.source.dataMonth !== source.dataMonth ||
    completedClose.source.observedName !== source.observedName ||
    completedClose.source.snapshotIdentity !== source.snapshotIdentity ||
    JSON.stringify(completedClose.source.cache ?? null) !==
      JSON.stringify(source.cache ?? null) ||
    JSON.stringify(completedClose.source.normalization) !==
      JSON.stringify(source.normalization) ||
    completedClose.close !== inputs.fields.latestOfficialClose.value ||
    completedClose.close !== completedClose.bar.close ||
    completedClose.resolverEvidence.status !== "resolved" ||
    completedClose.resolverEvidence.expectedAsOf !==
      completedClose.expectedAsOf ||
    completedClose.resolverEvidence.evaluatedAt !==
      completedClose.query.evaluatedAt ||
    budget.actual !== 1 ||
    budget.completedSessionResolver.actualLogicalLoads !==
      completedClose.workBudget.completedSessionResolver.actualTotal ||
    budget.completedSessionResolver.maximumLogicalLoads !==
      completedClose.workBudget.completedSessionResolver.maximumTotal ||
    budget.exactStockOhlcAttempts.actual !==
      completedClose.workBudget.exactStockOhlcAttempts.actual ||
    budget.exactStockOhlcAttempts.cacheRefreshPerformed !==
      completedClose.workBudget.exactStockOhlcAttempts.cacheRefreshPerformed
  ) {
    failContract(
      inputs.company.code,
      "Reverse DCF 的 valuation input 與 authoritative completed-close execution context 不一致。",
      {
        expectedAsOf: completedClose.expectedAsOf,
        selectedBarDate: completedClose.selectedBarDate,
        sourceDates: completedSources.map((candidate) =>
          candidate.selectedBarDate
        ),
      },
    );
  }
}

function fieldOrGap<FieldId extends RequiredFieldId>(
  inputs: ValuationModelInputsResult,
  fieldId: FieldId,
): ValuationModelInputField & { value: number } {
  const field = inputs.fields[fieldId];
  if (
    (field.status !== "reported" && field.status !== "derived") ||
    field.value === null ||
    !Number.isFinite(field.value) ||
    field.evidenceClass === "UNAVAILABLE"
  ) {
    failDataGap(inputs.company.code, [field]);
  }
  const contract = REQUIRED_FIELD_CONTRACTS[fieldId];
  if (
    field.id !== fieldId ||
    field.unit !== contract.unit ||
    field.status !== contract.status ||
    field.evidenceClass !== contract.evidenceClass ||
    field.inputLineageIds.length === 0 ||
    new Set(field.inputLineageIds).size !== field.inputLineageIds.length
  ) {
    failContract(
      inputs.company.code,
      `normalized valuation-model field ${fieldId} 不符合 Reverse DCF semantic contract。`,
      {
        fieldId,
        observed: {
          id: field.id,
          unit: field.unit,
          status: field.status,
          evidenceClass: field.evidenceClass,
          inputLineageIds: field.inputLineageIds,
        },
        expected: contract,
      },
    );
  }
  const lineageById = new Map(
    inputs.lineage.map((entry) => [entry.lineageId, entry] as const),
  );
  const sourceById = new Map(
    inputs.sources.map((source) => [source.sourceId, source] as const),
  );
  const referenced = field.inputLineageIds.map((lineageId) =>
    lineageById.get(lineageId),
  );
  const invalidLineage = referenced.some((entry) => {
    if (!entry || entry.status !== "resolved" || entry.sourceId === null) {
      return true;
    }
    const source = sourceById.get(entry.sourceId);
    if (!source || source.stage !== contract.sourceStage) return true;
    if (
      source.stage === "company_master" ||
      source.stage === "latest_official_completed_close"
    ) {
      return (
        source.market !== inputs.company.market ||
        source.exchange !== inputs.company.exchange
      );
    }
    return false;
  });
  if (invalidLineage) {
    failContract(
      inputs.company.code,
      `normalized valuation-model field ${fieldId} 必須只引用 resolved 且 stage／market／exchange 相符的 lineage sources。`,
      {
        fieldId,
        expectedSourceStage: contract.sourceStage,
        lineageIds: field.inputLineageIds,
      },
    );
  }
  if (
    (contract.viability === "positive" && field.value <= 0) ||
    (contract.viability === "non_negative" && field.value < 0)
  ) {
    failModelBase(inputs.company.code, field, contract.viability);
  }
  return field as ValuationModelInputField & { value: number };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sourceIdsForLineage(
  inputs: ValuationModelInputsResult,
  lineageIds: string[],
): string[] {
  const wanted = new Set(lineageIds);
  return unique(
    inputs.lineage.flatMap((entry) =>
      wanted.has(entry.lineageId) && entry.sourceId ? [entry.sourceId] : [],
    ),
  );
}

function mappingId(engineFactId: string): string {
  return `reverse_dcf_input:${engineFactId}`;
}

function fieldMapping(
  inputs: ValuationModelInputsResult,
  engineFactId: string,
  field: ValuationModelInputField & { value: number },
  options: {
    originFieldIds?: ValuationModelFieldId[];
    transformation?: string | null;
    notes?: string[];
  } = {},
): ReverseDcfFactMapping {
  return {
    mappingId: mappingId(engineFactId),
    engineFactId,
    evidenceClass: field.evidenceClass as Exclude<
      ValuationModelEvidenceClass,
      "UNAVAILABLE"
    >,
    origin: "valuation_model_field",
    originFieldIds: options.originFieldIds ?? [field.id],
    upstreamLineageIds: [...field.inputLineageIds],
    sourceIds: sourceIdsForLineage(inputs, field.inputLineageIds),
    transformation: options.transformation ?? null,
    notes: options.notes ?? [],
  };
}

function fieldFact(
  mapping: ReverseDcfFactMapping,
): ReverseDcfFactProvenance {
  return {
    id: mapping.engineFactId,
    evidenceClass: mapping.evidenceClass,
    lineageIds: [mapping.mappingId],
  };
}

function callerFact(id: string): ReverseDcfFactProvenance {
  return { id, evidenceClass: "CALLER_ASSUMPTION", lineageIds: [] };
}

function companyIdentityMappings(
  inputs: ValuationModelInputsResult,
): ReverseDcfFactMapping[] {
  const companySources = inputs.sources.filter(
    (source) =>
      source.stage === "company_master" &&
      source.market === inputs.company.market &&
      source.exchange === inputs.company.exchange,
  );
  if (companySources.length === 0) {
    failDataGap(
      inputs.company.code,
      [inputs.fields.issuedShares],
      "Reverse DCF 缺少公司 identity 的 current-master source evidence。",
    );
  }
  return ["company.companyCode", "company.isFinancial"].map(
    (engineFactId) => ({
      mappingId: mappingId(engineFactId),
      engineFactId,
      evidenceClass: "OFFICIAL_MASTER_RAW" as const,
      origin: "valuation_model_company_identity" as const,
      originFieldIds: [],
      upstreamLineageIds: [],
      sourceIds: companySources.map((source) => source.sourceId),
      transformation: null,
      notes: [
        "公司代號、市場與金融業分類沿用 normalized valuation-model current company master identity。",
      ],
    }),
  );
}

function marketDateMapping(
  inputs: ValuationModelInputsResult,
  close: ValuationModelInputField & { value: number },
): { date: string; mapping: ReverseDcfFactMapping } {
  const closeSourceIds = new Set(
    sourceIdsForLineage(inputs, close.inputLineageIds),
  );
  const marketSources = inputs.sources.filter(
    (source): source is ValuationModelCompletedCloseSource =>
      source.stage === "latest_official_completed_close" &&
      source.market === inputs.company.market &&
      closeSourceIds.has(source.sourceId),
  );
  const dates = unique(marketSources.map((source) => source.selectedBarDate));
  if (dates.length !== 1) {
    failDataGap(
      inputs.company.code,
      [close],
      "Reverse DCF 無法由 latestOfficialClose lineage 唯一解析完成交易日。",
    );
  }
  return {
    date: dates[0] as string,
    mapping: {
      mappingId: mappingId("marketFacts.observedPriceDate"),
      engineFactId: "marketFacts.observedPriceDate",
      evidenceClass: "OFFICIAL_MARKET_RAW",
      origin: "valuation_model_source_date",
      originFieldIds: ["latestOfficialClose"],
      upstreamLineageIds: [...close.inputLineageIds],
      sourceIds: marketSources.map((source) => source.sourceId),
      transformation:
        "latest_official_completed_close source selectedBarDate",
      notes: [
        "authoritative resolver expectedAsOf 與 exact single-stock selected bar date；不是全市場 latest 或盤中 quote time。",
      ],
    },
  };
}

function leaseNormalizationMapping(
  inputs: ValuationModelInputsResult,
  debt: ValuationModelInputField & { value: number },
): ReverseDcfFactMapping {
  return {
    mappingId: mappingId("marketFacts.leaseLiabilitiesTwd"),
    engineFactId: "marketFacts.leaseLiabilitiesTwd",
    evidenceClass: "MOPSFIN_CALC",
    origin: "aggregate_debt_bridge_normalization",
    originFieldIds: ["interestBearingDebt"],
    upstreamLineageIds: [...debt.inputLineageIds],
    sourceIds: sourceIdsForLineage(inputs, debt.inputLineageIds),
    transformation:
      "0 because exact lease-liability roles are already included in aggregate interestBearingDebt",
    notes: [
      "此 0 是 aggregate bridge normalization，不代表租賃負債為 0；不得再加一次造成 double count。",
    ],
  };
}

function sensitivityGrids(
  grids: ReverseDcfPublicSensitivityGrids | undefined,
): ReverseDcfSensitivityGrids | undefined {
  return grids
    ? {
        waccPercent: [...grids.wacc_percent],
        terminalGrowthPercent: [...grids.terminal_growth_percent],
      }
    : undefined;
}

function solveRange(query: ReverseDcfPublicQuery): ReverseDcfSolveRange {
  return {
    minimumPercent: query.solve_range.minimum_percent,
    maximumPercent: query.solve_range.maximum_percent,
  };
}

function callerBridgeFacts(query: ReverseDcfPublicQuery) {
  const bridge = query.enterprise_value_bridge;
  return {
    nonOperatingAssetsTwd: bridge.non_operating_assets_twd,
    nonControllingInterestsTwd: bridge.non_controlling_interests_twd,
    preferredEquityTwd: bridge.preferred_equity_twd,
    pensionDeficitTwd: bridge.pension_deficit_twd,
    otherDebtLikeItemsTwd: bridge.other_debt_like_items_twd,
  };
}

function commonCallerProvenance(): ReverseDcfFactProvenance[] {
  return [
    "marketFacts.nonOperatingAssetsTwd",
    "marketFacts.nonControllingInterestsTwd",
    "marketFacts.preferredEquityTwd",
    "marketFacts.pensionDeficitTwd",
    "marketFacts.otherDebtLikeItemsTwd",
  ].map(callerFact);
}

function engineInput(
  query: ReverseDcfPublicQuery,
  inputs: ValuationModelInputsResult,
): {
  input: ReverseDcfInput;
  mappings: ReverseDcfFactMapping[];
  usedFieldIds: ValuationModelFieldId[];
} {
  const cash = fieldOrGap(inputs, "cashAndCashEquivalents");
  const debt = fieldOrGap(inputs, "interestBearingDebt");
  const shares = fieldOrGap(inputs, "issuedShares");
  const close = fieldOrGap(inputs, "latestOfficialClose");
  const identityMappings = companyIdentityMappings(inputs);
  const priceDate = marketDateMapping(inputs, close);
  const mappings: ReverseDcfFactMapping[] = [
    ...identityMappings,
    fieldMapping(inputs, "marketFacts.observedPricePerShareTwd", close),
    priceDate.mapping,
    fieldMapping(inputs, "marketFacts.sharesOutstanding", shares),
    fieldMapping(inputs, "marketFacts.shareCountBasis", shares, {
      transformation: "constant issued_common_shares basis from issuedShares",
      notes: ["不是 fully diluted shares。"],
    }),
    fieldMapping(inputs, "marketFacts.cashAndCashEquivalentsTwd", cash),
    fieldMapping(inputs, "marketFacts.interestBearingDebtTwd", debt),
    leaseNormalizationMapping(inputs, debt),
  ];
  const provenance: ReverseDcfFactProvenance[] = [
    ...mappings.map(fieldFact),
    ...commonCallerProvenance(),
  ];
  const common = {
    company: {
      companyCode: inputs.company.code,
      isFinancial: inputs.company.isFinancial,
    },
    currency: "TWD" as const,
    marketFacts: {
      observedPricePerShareTwd: close.value,
      observedPriceDate: priceDate.date,
      sharesOutstanding: shares.value,
      shareCountBasis: "issued_common_shares" as const,
      cashAndCashEquivalentsTwd: cash.value,
      interestBearingDebtTwd: debt.value,
      leaseLiabilitiesTwd: 0,
      ...callerBridgeFacts(query),
    },
    forecastYears: query.forecast_years,
    waccPercent: query.wacc_percent,
    terminalGrowthPercent: query.terminal_growth_percent,
    solveRange: solveRange(query),
    factProvenance: provenance,
    ...(query.sensitivity_grids
      ? { sensitivityGrids: sensitivityGrids(query.sensitivity_grids) }
      : {}),
  };

  if (query.solve_for === "fcff_cagr") {
    const baseFcff = fieldOrGap(inputs, "normalizedFcff");
    const mapping = fieldMapping(
      inputs,
      "operatingFacts.baseFcffTwd",
      baseFcff,
    );
    mappings.push(mapping);
    provenance.push(fieldFact(mapping));
    return {
      input: {
        ...common,
        solveFor: "fcff_cagr",
        operatingFacts: { baseFcffTwd: baseFcff.value },
        operatingAssumptions: { growthPolicy: "constant_compounded" },
      },
      mappings,
      usedFieldIds: [...COMMON_FIELD_IDS, "normalizedFcff"],
    };
  }

  const revenue = fieldOrGap(inputs, "ttmRevenue");
  const revenueMapping = fieldMapping(
    inputs,
    "operatingFacts.baseRevenueTwd",
    revenue,
  );
  mappings.push(revenueMapping);
  provenance.push(fieldFact(revenueMapping));
  if (query.solve_for === "revenue_cagr") {
    return {
      input: {
        ...common,
        solveFor: "revenue_cagr",
        operatingFacts: { baseRevenueTwd: revenue.value },
        operatingAssumptions: {
          marginPolicy: "constant_normalized",
          normalizedOperatingMarginPercent:
            query.forward_assumptions.normalized_operating_margin_percent,
          cashTaxRatePercent:
            query.forward_assumptions.cash_tax_rate_percent,
          salesToCapitalRatio:
            query.forward_assumptions.sales_to_capital_ratio,
        },
      },
      mappings,
      usedFieldIds: [...COMMON_FIELD_IDS, "ttmRevenue"],
    };
  }

  const operatingIncome = fieldOrGap(inputs, "ttmOperatingIncomeEbitProxy");
  const baseMargin = (operatingIncome.value / revenue.value) * 100;
  const marginMapping: ReverseDcfFactMapping = {
    mappingId: mappingId("operatingFacts.baseOperatingMarginPercent"),
    engineFactId: "operatingFacts.baseOperatingMarginPercent",
    evidenceClass: "MOPSFIN_CALC",
    origin: "valuation_model_field",
    originFieldIds: ["ttmOperatingIncomeEbitProxy", "ttmRevenue"],
    upstreamLineageIds: unique([
      ...operatingIncome.inputLineageIds,
      ...revenue.inputLineageIds,
    ]),
    sourceIds: unique([
      ...sourceIdsForLineage(inputs, operatingIncome.inputLineageIds),
      ...sourceIdsForLineage(inputs, revenue.inputLineageIds),
    ]),
    transformation: "ttmOperatingIncomeEbitProxy / ttmRevenue * 100",
    notes: ["歷史 TTM operating-margin base；不是 forecast terminal margin。"],
  };
  mappings.push(marginMapping);
  provenance.push(fieldFact(marginMapping));
  return {
    input: {
      ...common,
      solveFor: "terminal_operating_margin",
      operatingFacts: {
        baseRevenueTwd: revenue.value,
        baseOperatingMarginPercent: baseMargin,
      },
      operatingAssumptions: {
        revenueCagrPercent: query.forward_assumptions.revenue_cagr_percent,
        cashTaxRatePercent: query.forward_assumptions.cash_tax_rate_percent,
        salesToCapitalRatio:
          query.forward_assumptions.sales_to_capital_ratio,
        marginTransition: "linear_from_base_to_terminal",
      },
    },
    mappings,
    usedFieldIds: [
      ...COMMON_FIELD_IDS,
      "ttmRevenue",
      "ttmOperatingIncomeEbitProxy",
    ],
  };
}

export function mapReverseDcfEngineError(error: ReverseDcfError): MopsfinError {
  if (error.code === "MISSING_REQUIRED_INPUT") {
    return new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      "Reverse DCF adapter 未能建立 engine 要求的完整 normalized contract。",
      {
        reason: "ADAPTER_CONTRACT_MISMATCH",
        category: "upstream",
        retryable: false,
        action: "none",
        details: {
          reverseDcfErrorCode: error.code,
          ...error.details,
        },
        cause: error,
      },
    );
  }
  if (error.code === "NUMERICAL_FAILURE") {
    return new MopsfinError("NO_DATA", error.message, {
      reason: "MODEL_NUMERICAL_FAILURE",
      category: "no_data",
      retryable: false,
      action: "change_query",
      details: {
        reverseDcfErrorCode: error.code,
        ...error.details,
      },
      cause: error,
    });
  }
  const changeQueryCodes = new Set([
    "NOT_APPLICABLE_FINANCIAL_COMPANY",
    "UNIDENTIFIABLE_SOLVE_RANGE",
    "NON_MONOTONIC_SOLVE_RANGE",
    "NO_FEASIBLE_SOLUTION",
    "TERMINAL_VALUE_NOT_VIABLE",
  ]);
  return new MopsfinError("INVALID_ARGUMENT", error.message, {
    reason: error.code,
    category: "input",
    retryable: false,
    action: changeQueryCodes.has(error.code) ? "change_query" : "fix_input",
    details: {
      reverseDcfErrorCode: error.code,
      ...error.details,
    },
    cause: error,
  });
}

function stableWarnings(inputs: ValuationModelInputsResult): string[] {
  return unique([
    ...inputs.warnings,
    "price_source=latest_completed_close 使用 request-start authoritative resolver expectedAsOf 同日的官方 exact 單股 OHLC 收盤價；不使用或回退全市場 latest，也不是盤中即時行情。",
    "股數基礎為 current-master issued common shares，不是 fully diluted shares。",
    "interestBearingDebt 已彙總 exact debt 與 lease-liability roles；engine 的 leaseLiabilitiesTwd 固定為 0 只為避免 EV bridge 重複計入，不代表租賃負債為零。",
    "caller 的 other_debt_like_items_twd 必須排除已包含在 normalized aggregate interestBearingDebt 的借款、公司債與 exact lease-liability roles，否則會重複加回 debt-like claims。",
    "caller 的 non_operating_assets_twd 必須排除已包含在 cashAndCashEquivalents 的現金及約當現金，否則 EV bridge 會重複扣除；0 也必須是 caller 的顯性判斷。",
    "所有 forward、WACC、terminal growth、solve range、sensitivity 與非營運／其他 claims bridge 值均為 caller 明示假設；模型不提供隱藏預設。",
    "market-implied reverse DCF 是可重算研究模型輸出，不是共識預估、目標價、買賣評級或投資建議。",
  ]);
}

export class ReverseDcfMcpClient {
  constructor(
    private readonly valuationInputs: ReverseDcfValuationInputsLike =
      valuationModelInputsClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runReverseDcf(
    query: ReverseDcfPublicQuery,
  ): Promise<ReverseDcfOrchestrationResult> {
    return (await this.runReverseDcfWithContext(query)).data;
  }

  async runReverseDcfWithContext(
    query: ReverseDcfPublicQuery,
  ): Promise<ReverseDcfExecution> {
    assertPublicBounds(query);
    const valuationExecution =
      await this.valuationInputs.getValuationModelInputsWithContext({
        companyCode: query.company_code,
      });
    const {
      data: inputs,
      completedClose,
      completedCloseError,
    } = valuationExecution;
    assertValuationInputIdentity(query, inputs);
    if (
      inputs.applicability.status === "not_applicable" ||
      inputs.company.isFinancial
    ) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "金融公司不適用一般企業 enterprise-value FCFF reverse DCF。",
        {
          reason: "NOT_APPLICABLE_FINANCIAL_COMPANY",
          category: "input",
          retryable: false,
          action: "change_query",
          details: {
            companyCode: inputs.company.code,
            modelAlternatives: [
              "residual_income",
              "dividend_discount",
              "excess_return",
            ],
          },
        },
      );
    }
    if (completedClose === null) {
      if (completedCloseError) throw completedCloseError;
      failDataGap(
        inputs.company.code,
        [inputs.fields.latestOfficialClose],
        "Reverse DCF 必須取得與 valuation inputs 相同 orchestration 的 authoritative completed-close context。",
      );
    }
    assertCompletedCloseContext(inputs, completedClose);
    const prepared = engineInput(query, inputs);
    let model: ReverseDcfResult;
    try {
      model = solveReverseDcf(prepared.input);
    } catch (error) {
      if (error instanceof ReverseDcfError) {
        throw mapReverseDcfEngineError(error);
      }
      throw error;
    }
    const requestedSensitivityCells = query.sensitivity_grids
      ? query.sensitivity_grids.wacc_percent.length *
        query.sensitivity_grids.terminal_growth_percent.length
      : 0;
    const generatedAt = this.now().toISOString();
    const latestDependencyTime = Math.max(
      Date.parse(inputs.generatedAt),
      ...inputs.sources.map((source) => Date.parse(source.retrievedAt)),
    );
    if (
      !STRICT_ISO_INSTANT.test(generatedAt) ||
      !Number.isFinite(Date.parse(generatedAt)) ||
      !Number.isFinite(latestDependencyTime) ||
      Date.parse(generatedAt) < latestDependencyTime
    ) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "Reverse DCF 的 upstream provenance time 晚於本次 orchestration time，無法建立可信時間順序。",
        {
          reason: "PROVENANCE_TIME_INCONSISTENT",
          category: "upstream",
          retryable: true,
          action: "retry",
          details: {
            generatedAt,
            valuationModelGeneratedAt: inputs.generatedAt,
            sourceRetrievedAt: inputs.sources.map((source) => ({
              sourceId: source.sourceId,
              retrievedAt: source.retrievedAt,
            })),
          },
        },
      );
    }
    const data: ReverseDcfOrchestrationResult = {
      query,
      generatedAt,
      timezone: "Asia/Taipei",
      currency: "TWD",
      scope: "market_implied_reverse_dcf",
      posture: "research_model_output_not_investment_advice",
      company: inputs.company,
      model,
      normalizedInputEvidence: {
        valuationModelGeneratedAt: inputs.generatedAt,
        usedFieldIds: prepared.usedFieldIds,
        fields: inputs.fields,
        periods: inputs.periods,
        factMappings: prepared.mappings,
        lineageLedger: inputs.lineage,
        sourceLedger: inputs.sources,
      },
      sources: inputs.sources,
      workBudget: {
        valuationModelInputCalls: { actual: 1, maximum: 1 },
        valuationModelInputs: inputs.workBudget,
        reverseDcfEngineOrchestrations: { actual: 1, maximum: 1 },
        sensitivityCells: {
          requested: requestedSensitivityCells,
          maximum: 25,
        },
        solveAttempts: {
          actual: 1 + requestedSensitivityCells,
          maximum: MAX_SOLVE_ATTEMPTS,
        },
        modelEvaluationUpperBound: {
          perSolveAttempt:
            MODEL_EVALUATIONS_PER_SOLVE_ATTEMPT_UPPER_BOUND,
          forRequestedWork:
            MODEL_EVALUATIONS_PER_SOLVE_ATTEMPT_UPPER_BOUND *
            (1 + requestedSensitivityCells),
          maximum: MODEL_EVALUATIONS_MAXIMUM,
        },
      },
      warnings: stableWarnings(inputs),
    };
    return { data, completedClose };
  }
}

export const reverseDcfMcpClient = new ReverseDcfMcpClient();
