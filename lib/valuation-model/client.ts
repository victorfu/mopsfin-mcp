import {
  companyMasterClient,
} from "@/lib/company-master/client";
import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import { authoritativeCompletedCloseClient } from "@/lib/completed-close/client";
import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import { COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI } from "@/lib/freshness/completed-session-resolver";
import {
  mopsfinClient,
  type StatementKind,
} from "@/lib/mopsfin/client";
import { asMopsfinError, MopsfinError } from "@/lib/mopsfin/errors";

import {
  canonicalStatementLabel,
  resolveFinancialStatement,
  resolveStatementRole,
  type FinancialStatementResultLike,
  type ResolvedStatement,
  type StatementRoleResolution,
} from "./statement-resolver";
import type {
  ValuationModelCompanyMasterSource,
  ValuationModelDataGapReason,
  ValuationModelFieldId,
  ValuationModelInputField,
  ValuationModelInputFields,
  ValuationModelInputsExecution,
  ValuationModelInputsQuery,
  ValuationModelInputsResult,
  ValuationModelLineageEntry,
  ValuationModelCompletedCloseSource,
  ValuationModelPeriods,
  ValuationModelSource,
  ValuationModelStatementSource,
  ValuationModelUnit,
} from "./types";

interface MopsfinStatementsLike {
  getFinancialStatement(options: {
    statement: StatementKind;
    companyCodes: string[];
    period: "latest" | string;
    page: { offset: number; limit: number };
  }): Promise<FinancialStatementResultLike>;
}

interface CompanyMasterLike {
  listCompanies(query: {
    market: "all" | "listed" | "otc";
    includeFinancial: boolean;
    includeKy: boolean;
  }): Promise<CompanyMasterResult>;
}

interface AuthoritativeCompletedCloseLike {
  getLatestCompletedClose(query: {
    company: {
      code: string;
      shortName: string;
      market: "listed" | "otc";
      exchange: "TWSE" | "TPEx";
    };
    evaluatedAt: string;
  }): Promise<AuthoritativeCompletedCloseResult>;
}

interface StatementLoad {
  statement: StatementKind;
  requestedPeriod: "latest" | string;
  resolved: ResolvedStatement | null;
  error: unknown | null;
}

interface CompletedCloseLoad {
  result: AuthoritativeCompletedCloseResult | null;
  error: MopsfinError | null;
}

interface RawMetric {
  value: number | null;
  lineageIds: string[];
  available: boolean;
  reason: ValuationModelDataGapReason | null;
  notes: string[];
}

const STATEMENT_PAGE_LIMIT = 500;
const FIELD_IDS = [
  "ttmRevenue",
  "ttmOperatingIncomeEbitProxy",
  "cashTaxRatePercent",
  "ttmDepreciationAndAmortization",
  "ttmCapitalExpenditure",
  "ttmDeltaNetWorkingCapital",
  "normalizedFcff",
  "cashAndCashEquivalents",
  "interestBearingDebt",
  "netDebt",
  "issuedShares",
  "latestOfficialClose",
  "marketCapitalization",
  "enterpriseValue",
] as const satisfies readonly ValuationModelFieldId[];

const ROLE_LABELS = {
  revenue: ["營業收入合計", "營業收入", "收入合計"],
  operatingIncome: ["營業利益（損失）", "營業利益(損失)", "營業淨利（淨損）"],
  pretaxIncome: ["稅前淨利（淨損）", "稅前淨利(淨損)"],
  cashTaxes: ["退還（支付）之所得稅", "退還(支付)之所得稅", "支付之所得稅"],
  depreciation: ["折舊費用"],
  amortization: ["攤銷費用"],
  combinedDepreciationAmortization: ["折舊及攤銷費用", "折舊與攤銷費用"],
  capex: ["取得不動產、廠房及設備", "購置不動產、廠房及設備"],
  workingCapitalCashImpact: [
    "與營業活動相關之資產及負債之淨變動合計",
    "營業資產及負債之淨變動合計",
  ],
  cash: ["現金及約當現金"],
} as const;

const DEBT_LABELS = [
  "短期借款",
  "應付短期票券",
  "一年或一營業週期內到期長期負債",
  "一年內到期之長期負債",
  "應付公司債",
  "長期借款",
  "租賃負債－流動",
  "租賃負債-流動",
  "租賃負債－非流動",
  "租賃負債-非流動",
] as const;

const DEBT_LIKE = /借款|公司債|短期票券|租賃負債|到期長期負債/;

function canonicalIdentity(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知上游錯誤";
}

function errorReason(error: unknown): string | null {
  return error instanceof MopsfinError ? error.reason ?? error.code : null;
}

function statementKey(statement: StatementKind, period: string): string {
  return `${statement}:${period}`;
}

function sourceIdForStatement(statement: StatementKind, period: string): string {
  return `statement:${statement}:${period}`;
}

function nextLineageId(index: number): string {
  return `lineage:${String(index + 1).padStart(3, "0")}`;
}

function gapField(
  id: ValuationModelFieldId,
  unit: ValuationModelUnit,
  reason: ValuationModelDataGapReason,
  options: {
    formula?: string;
    inputFieldIds?: ValuationModelFieldId[];
    inputLineageIds?: string[];
    notes?: string[];
  } = {},
): ValuationModelInputField {
  return {
    id,
    value: null,
    unit,
    status: "data_gap",
    evidenceClass: "UNAVAILABLE",
    formula: options.formula ?? null,
    inputFieldIds: options.inputFieldIds ?? [],
    inputLineageIds: options.inputLineageIds ?? [],
    dataGapReason: reason,
    notes: options.notes ?? [],
  };
}

function notApplicableField(
  id: ValuationModelFieldId,
  unit: ValuationModelUnit,
): ValuationModelInputField {
  return {
    id,
    value: null,
    unit,
    status: "not_applicable",
    evidenceClass: "UNAVAILABLE",
    formula: null,
    inputFieldIds: [],
    inputLineageIds: [],
    dataGapReason: "NOT_APPLICABLE_FINANCIAL_COMPANY",
    notes: ["金融業需使用 residual income、dividend 或 excess return 類模型。"],
  };
}

function reportedField(
  id: ValuationModelFieldId,
  unit: ValuationModelUnit,
  value: number,
  lineageIds: string[],
  notes: string[] = [],
  evidenceClass: ValuationModelInputField["evidenceClass"] = "MOPSFIN_RAW",
): ValuationModelInputField {
  return {
    id,
    value,
    unit,
    status: "reported",
    evidenceClass,
    formula: null,
    inputFieldIds: [],
    inputLineageIds: lineageIds,
    dataGapReason: null,
    notes,
  };
}

function derivedField(
  id: ValuationModelFieldId,
  unit: ValuationModelUnit,
  value: number,
  formula: string,
  options: {
    inputFieldIds?: ValuationModelFieldId[];
    inputLineageIds?: string[];
    notes?: string[];
    evidenceClass?: ValuationModelInputField["evidenceClass"];
  } = {},
): ValuationModelInputField {
  return {
    id,
    value,
    unit,
    status: "derived",
    evidenceClass: options.evidenceClass ?? "MOPSFIN_CALC",
    formula,
    inputFieldIds: options.inputFieldIds ?? [],
    inputLineageIds: options.inputLineageIds ?? [],
    dataGapReason: null,
    notes: options.notes ?? [],
  };
}

function unitsForField(id: ValuationModelFieldId): ValuationModelUnit {
  if (id === "cashTaxRatePercent") return "percent";
  if (id === "issuedShares") return "share";
  if (id === "latestOfficialClose") return "TWD_per_share";
  return "TWD";
}

function inheritedLineageIds(
  ...fields: ValuationModelInputField[]
): string[] {
  return [...new Set(fields.flatMap((field) => field.inputLineageIds))];
}

function allNotApplicableFields(): ValuationModelInputFields {
  return Object.fromEntries(
    FIELD_IDS.map((id) => [id, notApplicableField(id, unitsForField(id))]),
  ) as unknown as ValuationModelInputFields;
}

function findCompany(master: CompanyMasterResult, companyCode: string): MasterCompany {
  const matches = master.companies.filter((company) => company.code === companyCode);
  if (matches.length !== 1) {
    throw new MopsfinError(
      matches.length === 0 ? "NOT_FOUND" : "UPSTREAM_BAD_RESPONSE",
      matches.length === 0
        ? `公司 master 找不到 ${companyCode}。`
        : `公司 master 對 ${companyCode} 回傳重複 identity。`,
      {
        reason: matches.length === 0 ? "COMPANY_NOT_FOUND" : "COMPANY_IDENTITY_AMBIGUOUS",
        category: matches.length === 0 ? "lookup" : "upstream",
        retryable: false,
        action: "none",
      },
    );
  }
  return matches[0];
}

function companyMasterSource(
  master: CompanyMasterResult,
  company: MasterCompany,
): ValuationModelCompanyMasterSource | null {
  const matches = master.sources.filter((source) => source.market === company.market);
  if (matches.length !== 1) return null;
  const source = matches[0];
  return {
    sourceId: `company_master:${source.market}:${source.reportDate}`,
    stage: "company_master",
    market: source.market,
    exchange: source.exchange,
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    reportDate: source.reportDate,
    asOf: source.reportDate,
    asOfGranularity: "date",
    retrievedAt: source.retrievedAt,
    ...(source.cache ? { cache: source.cache } : {}),
  };
}

function statementSource(statement: ResolvedStatement): ValuationModelStatementSource {
  return {
    sourceId: sourceIdForStatement(statement.statement, statement.period),
    stage: "statement",
    sourceName: statement.source.sourceName,
    sourceUrl: statement.source.sourceUrl,
    retrievedAt: statement.source.retrievedAt,
    ...(statement.source.cache ? { cache: statement.source.cache } : {}),
    upstreamRoute: statement.source.upstreamRoute,
    statement: statement.statement,
    period: statement.period,
    asOf: statement.period,
    asOfGranularity: "quarter",
    reportName: statement.reportName,
    rawUnit: statement.rawUnit,
    unitSource: statement.unitSource,
    normalizedUnit: "TWD",
    amountMultiplier: 1000,
    consolidationScope: statement.consolidationScope,
  };
}

function periodPlan(latestPeriod: string | null): ValuationModelPeriods {
  if (!latestPeriod || !/^\d{4}Q[1-4]$/.test(latestPeriod)) {
    return {
      latestReportedPeriod: null,
      ttmMethod: "unavailable",
      currentYtdPeriod: null,
      priorFiscalYearPeriod: null,
      priorYearYtdPeriod: null,
      fiscalYearBasis: "mopsfin_calendar_year_quarters",
      consolidationScope: null,
    };
  }
  const year = Number(latestPeriod.slice(0, 4));
  const quarter = Number(latestPeriod.slice(-1));
  if (quarter === 4) {
    return {
      latestReportedPeriod: latestPeriod,
      ttmMethod: "fiscal_year",
      currentYtdPeriod: latestPeriod,
      priorFiscalYearPeriod: null,
      priorYearYtdPeriod: null,
      fiscalYearBasis: "mopsfin_calendar_year_quarters",
      consolidationScope: null,
    };
  }
  return {
    latestReportedPeriod: latestPeriod,
    ttmMethod: "current_ytd_plus_prior_fy_minus_prior_year_ytd",
    currentYtdPeriod: latestPeriod,
    priorFiscalYearPeriod: `${year - 1}Q4`,
    priorYearYtdPeriod: `${year - 1}Q${quarter}`,
    fiscalYearBasis: "mopsfin_calendar_year_quarters",
    consolidationScope: null,
  };
}

export class ValuationModelInputsClient {
  constructor(
    private readonly mopsfin: MopsfinStatementsLike = mopsfinClient,
    private readonly companyMaster: CompanyMasterLike = companyMasterClient,
    private readonly completedClose: AuthoritativeCompletedCloseLike =
      authoritativeCompletedCloseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getValuationModelInputs(
    query: ValuationModelInputsQuery,
  ): Promise<ValuationModelInputsResult> {
    return (await this.getValuationModelInputsWithContext(query)).data;
  }

  async getValuationModelInputsWithContext(
    query: ValuationModelInputsQuery,
  ): Promise<ValuationModelInputsExecution> {
    const evaluatedAt = this.now().toISOString();
    const normalizedCode = query.companyCode.trim();
    if (!/^\d{4}$/.test(normalizedCode)) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "company_code 必須是四碼公司股票代號。",
        {
          reason: "INVALID_COMPANY_CODE",
          category: "input",
          retryable: false,
          action: "fix_input",
        },
      );
    }
    const master = await this.companyMaster.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    const company = findCompany(master, normalizedCode);
    const masterSource = companyMasterSource(master, company);
    const baseSources: ValuationModelSource[] = masterSource ? [masterSource] : [];
    const companyResult = {
      code: company.code,
      name: company.name,
      shortName: company.shortName,
      market: company.market,
      exchange: company.exchange,
      industryCode: company.industryCode,
      isFinancial: company.isFinancial,
    };
    if (company.isFinancial) {
      const fields = allNotApplicableFields();
      return { data: {
        query: {
          companyCode: company.code,
          financialPeriod: "latest",
          priceDate: "latest_completed_official_session",
        },
        generatedAt: this.now().toISOString(),
        timezone: "Asia/Taipei",
        currency: "TWD",
        scope: "normalized_valuation_model_inputs",
        posture: "research_model_input_evidence_only",
        applicability: {
          status: "not_applicable",
          reason: "financial_company_requires_residual_income_or_dividend_model",
        },
        company: companyResult,
        periods: periodPlan(null),
        fields,
        lineage: [],
        sources: baseSources,
        quality: {
          calculationComplete: false,
          dataGapFields: [],
          notApplicableFields: [...FIELD_IDS],
        },
        workBudget: {
          requestedCompanies: 1,
          orchestrationCompanyMasterCalls: 1,
          statementCalls: { actual: 0, maximum: 7, rowsPerCallMaximum: 500 },
          authoritativeCompletedCloseCalls: {
            actual: 0,
            maximum: 1,
            completedSessionResolver: {
              actualLogicalLoads: 0,
              maximumLogicalLoads: 2,
            },
            exactStockOhlcAttempts: {
              actual: 0,
              maximum: 2,
              cacheRefreshPerformed: false,
            },
          },
        },
        warnings: [
          "金融公司不適用一般企業 FCFF／enterprise-value DCF；請改用 residual income、dividend discount 或 excess return 模型。",
        ],
      }, completedClose: null, completedCloseError: null };
    }

    const warnings: string[] = [];
    const latestLoads = await Promise.all(
      (["income_statement", "cash_flow", "balance_sheet"] as const).map(
        (statement) => this.loadStatement(company, statement, "latest"),
      ),
    );
    const latestPeriods = [
      ...new Set(
        latestLoads.flatMap((load) =>
          load.resolved ? [load.resolved.period] : [],
        ),
      ),
    ];
    const latestPeriod = latestPeriods.length === 1 ? latestPeriods[0] : null;
    if (latestPeriods.length > 1) {
      warnings.push(
        `三大報表 latest 期別不一致：${latestPeriods.join("、")}；所有財報衍生值 fail closed。`,
      );
    }
    for (const load of latestLoads) {
      if (load.error) {
        warnings.push(
          `${load.statement} latest 無法使用（${errorReason(load.error) ?? "UNKNOWN"}）：${errorMessage(load.error)}`,
        );
      }
    }
    const periods = periodPlan(latestPeriod);
    const historicalPeriods = [
      periods.priorFiscalYearPeriod,
      periods.priorYearYtdPeriod,
    ].filter((period): period is string => period !== null);
    const historicalLoads = latestPeriod
      ? await Promise.all(
          historicalPeriods.flatMap((period) =>
            (["income_statement", "cash_flow"] as const).map((statement) =>
              this.loadStatement(company, statement, period),
            ),
          ),
        )
      : [];
    for (const load of historicalLoads) {
      if (load.error) {
        warnings.push(
          `${load.statement} ${load.requestedPeriod} 無法使用（${errorReason(load.error) ?? "UNKNOWN"}）：${errorMessage(load.error)}`,
        );
      }
    }
    const resolvedStatements = [...latestLoads, ...historicalLoads].flatMap(
      (load) => (load.resolved ? [load.resolved] : []),
    );
    const scopes = [...new Set(resolvedStatements.map((value) => value.consolidationScope))];
    const statementScopeConsistent = scopes.length <= 1;
    if (!statementScopeConsistent) {
      warnings.push(
        `必要財報的合併範圍不一致（${scopes.join("、")}）；所有財報衍生值 fail closed。`,
      );
    }
    periods.consolidationScope = statementScopeConsistent ? scopes[0] ?? null : null;
    const statementMap = new Map(
      statementScopeConsistent && latestPeriod
        ? resolvedStatements
            .filter(
              (statement) =>
                statement.period === latestPeriod ||
                historicalPeriods.includes(statement.period),
            )
            .map((statement) => [statementKey(statement.statement, statement.period), statement])
        : [],
    );
    const statementSources = [...new Map(
      resolvedStatements.map((statement) => [
        statementKey(statement.statement, statement.period),
        statement,
      ]),
    ).values()]
      .sort((left, right) =>
        left.period.localeCompare(right.period) ||
        left.statement.localeCompare(right.statement),
      )
      .map(statementSource);
    const sources: ValuationModelSource[] = [...baseSources, ...statementSources];
    const lineage: ValuationModelLineageEntry[] = [];
    const statementContractLineageIds: string[] = [];
    for (const load of [...latestLoads, ...historicalLoads]) {
      if (load.resolved) continue;
      const lineageId = nextLineageId(lineage.length);
      statementContractLineageIds.push(lineageId);
      lineage.push({
        lineageId,
        role: "statement_dependency_attempt",
        status: "missing",
        sourceId: null,
        statement: load.statement,
        period: load.requestedPeriod,
        rowLabel: null,
        rawValue: null,
        normalizedValue: null,
        unit: "TWD",
        candidateRowLabels: [],
        notes: [
          `reason=${errorReason(load.error) ?? "UNKNOWN"}`,
          errorMessage(load.error),
        ],
      });
    }
    if (latestPeriods.length !== 1) {
      const lineageId = nextLineageId(lineage.length);
      statementContractLineageIds.push(lineageId);
      lineage.push({
        lineageId,
        role: "latest_statement_period_consistency",
        status: latestPeriods.length === 0 ? "missing" : "ambiguous",
        sourceId: null,
        statement: null,
        period: null,
        rowLabel: null,
        rawValue: null,
        normalizedValue: null,
        unit: "TWD",
        candidateRowLabels: latestPeriods,
        notes: ["三大報表必須解析到唯一共同 latest period。"],
      });
    }
    if (!statementScopeConsistent) {
      const lineageId = nextLineageId(lineage.length);
      statementContractLineageIds.push(lineageId);
      lineage.push({
        lineageId,
        role: "statement_consolidation_scope_consistency",
        status: "ambiguous",
        sourceId: null,
        statement: null,
        period: latestPeriod,
        rowLabel: null,
        rawValue: null,
        normalizedValue: null,
        unit: "TWD",
        candidateRowLabels: scopes,
        notes: ["所有必要 TTM 與期末報表必須使用同一合併範圍。"],
      });
    }

    const addRoleLineage = (
      statement: ResolvedStatement | null,
      period: string,
      role: string,
      resolution: StatementRoleResolution | null,
      notes: string[] = [],
    ): { value: number | null; lineageId: string; available: boolean } => {
      const lineageId = nextLineageId(lineage.length);
      const resolved = resolution?.status === "resolved" ? resolution.row : null;
      lineage.push({
        lineageId,
        role,
        status: resolution?.status ?? "missing",
        sourceId: statement
          ? sourceIdForStatement(statement.statement, statement.period)
          : null,
        statement: statement?.statement ?? null,
        period,
        rowLabel: resolved?.label ?? null,
        rawValue: resolved?.rawValue ?? null,
        normalizedValue: resolved?.valueTwd ?? null,
        unit: "TWD",
        candidateRowLabels: resolution?.candidateRowLabels ?? [],
        notes,
      });
      return {
        value: resolved?.valueTwd ?? null,
        lineageId,
        available: resolved?.valueTwd !== null && resolved?.valueTwd !== undefined,
      };
    };

    const rawRole = (
      statement: StatementKind,
      period: string,
      role: string,
      labels: readonly string[],
    ) => {
      const resolvedStatement = statementMap.get(statementKey(statement, period)) ?? null;
      const resolution = resolvedStatement
        ? resolveStatementRole(resolvedStatement, role, labels)
        : null;
      return addRoleLineage(resolvedStatement, period, role, resolution);
    };

    const ttmMetric = (
      statement: StatementKind,
      role: string,
      labels: readonly string[],
    ): RawMetric => {
      if (!periods.currentYtdPeriod || periods.ttmMethod === "unavailable") {
        return {
          value: null,
          lineageIds: statementContractLineageIds,
          available: false,
          reason: "TTM_PERIOD_MISMATCH",
          notes: ["無法建立一致的 latest 財報期別。"],
        };
      }
      const periodInputs = periods.ttmMethod === "fiscal_year"
        ? [periods.currentYtdPeriod]
        : [
            periods.currentYtdPeriod,
            periods.priorFiscalYearPeriod as string,
            periods.priorYearYtdPeriod as string,
          ];
      const inputs = periodInputs.map((period) => rawRole(statement, period, role, labels));
      if (inputs.some((input) => !input.available)) {
        return {
          value: null,
          lineageIds: inputs.map((input) => input.lineageId),
          available: false,
          reason: "TTM_COMPONENT_UNAVAILABLE",
          notes: [`${role} 缺少或無法唯一解析必要累計期別。`],
        };
      }
      const values = inputs.map((input) => input.value as number);
      const value = periods.ttmMethod === "fiscal_year"
        ? values[0]
        : values[0] + values[1] - values[2];
      return {
        value,
        lineageIds: inputs.map((input) => input.lineageId),
        available: Number.isSafeInteger(value),
        reason: Number.isSafeInteger(value) ? null : "TTM_COMPONENT_UNAVAILABLE",
        notes: [],
      };
    };

    const ttmDa = this.ttmDepreciationAndAmortization(
      periods,
      statementMap,
      addRoleLineage,
      statementContractLineageIds,
    );
    const revenue = ttmMetric("income_statement", "revenue", ROLE_LABELS.revenue);
    const operatingIncome = ttmMetric(
      "income_statement",
      "operating_income_ebit_proxy",
      ROLE_LABELS.operatingIncome,
    );
    const pretaxIncome = ttmMetric(
      "income_statement",
      "pretax_income",
      ROLE_LABELS.pretaxIncome,
    );
    const cashTaxCashFlow = ttmMetric(
      "cash_flow",
      "cash_taxes_cash_flow_sign",
      ROLE_LABELS.cashTaxes,
    );
    const capexCashFlow = ttmMetric(
      "cash_flow",
      "capital_expenditure_cash_flow_sign",
      ROLE_LABELS.capex,
    );
    const workingCapitalCashFlow = ttmMetric(
      "cash_flow",
      "working_capital_cash_flow_impact",
      ROLE_LABELS.workingCapitalCashImpact,
    );
    const ttmFormula = periods.ttmMethod === "fiscal_year"
      ? `${periods.currentYtdPeriod} FY`
      : `${periods.currentYtdPeriod} YTD + ${periods.priorFiscalYearPeriod} FY - ${periods.priorYearYtdPeriod} YTD`;

    const ttmField = (
      id: ValuationModelFieldId,
      metric: RawMetric,
      notes: string[] = [],
    ) =>
      metric.available && metric.value !== null
        ? derivedField(id, "TWD", metric.value, ttmFormula, {
            inputLineageIds: metric.lineageIds,
            notes,
          })
        : gapField(id, "TWD", metric.reason ?? "TTM_COMPONENT_UNAVAILABLE", {
            formula: ttmFormula,
            inputLineageIds: metric.lineageIds,
            notes: metric.notes,
          });

    const ttmRevenue = ttmField("ttmRevenue", revenue);
    const ttmOperatingIncome = ttmField(
      "ttmOperatingIncomeEbitProxy",
      operatingIncome,
      ["EBIT proxy 採 Mopsfin 累計綜合損益表的營業利益（損失）。"],
    );
    const ttmDandA = ttmField("ttmDepreciationAndAmortization", ttmDa);
    const ttmCapex = capexCashFlow.available && capexCashFlow.value !== null
      ? capexCashFlow.value <= 0
        ? derivedField(
            "ttmCapitalExpenditure",
            "TWD",
            -capexCashFlow.value,
            `-1 × (${ttmFormula} cash-flow-sign CapEx)`,
            {
              inputLineageIds: capexCashFlow.lineageIds,
              notes: [
                "輸出以正數代表再投資支出；來源現金流出保留負號。",
                "CapEx 僅採取得不動產、廠房及設備（PPE acquisition）；未包含取得無形資產或其他投資支出。",
              ],
            },
          )
        : gapField("ttmCapitalExpenditure", "TWD", "ROW_VALUE_INVALID", {
            formula: `-1 × (${ttmFormula} cash-flow-sign CapEx)`,
            inputLineageIds: capexCashFlow.lineageIds,
            notes: ["取得 PP&E 的 TTM 現金流符號為正，無法保守解讀為資本支出。"],
          })
      : gapField(
          "ttmCapitalExpenditure",
          "TWD",
          capexCashFlow.reason ?? "TTM_COMPONENT_UNAVAILABLE",
          {
            formula: `-1 × (${ttmFormula} cash-flow-sign CapEx)`,
            inputLineageIds: capexCashFlow.lineageIds,
            notes: capexCashFlow.notes,
          },
        );
    const ttmDeltaNwc = workingCapitalCashFlow.available &&
      workingCapitalCashFlow.value !== null
      ? derivedField(
          "ttmDeltaNetWorkingCapital",
          "TWD",
          -workingCapitalCashFlow.value,
          `-1 × (${ttmFormula} operating-assets-and-liabilities cash-flow impact)`,
          {
            inputLineageIds: workingCapitalCashFlow.lineageIds,
            notes: [
              "正數代表營運資金占用現金，負數代表營運資金釋放現金；保留來源現金流符號橋接。",
            ],
          },
        )
      : gapField(
          "ttmDeltaNetWorkingCapital",
          "TWD",
          workingCapitalCashFlow.reason ?? "TTM_COMPONENT_UNAVAILABLE",
          {
            formula: `-1 × (${ttmFormula} operating-assets-and-liabilities cash-flow impact)`,
            inputLineageIds: workingCapitalCashFlow.lineageIds,
            notes: workingCapitalCashFlow.notes,
          },
        );
    let cashTaxRate: ValuationModelInputField;
    if (
      pretaxIncome.available &&
      pretaxIncome.value !== null &&
      pretaxIncome.value > 0 &&
      cashTaxCashFlow.available &&
      cashTaxCashFlow.value !== null
    ) {
      const cashTaxesPaid = -cashTaxCashFlow.value;
      cashTaxRate = derivedField(
        "cashTaxRatePercent",
        "percent",
        (cashTaxesPaid / pretaxIncome.value) * 100,
        `(-1 × TTM cash-flow tax line) / TTM pretax income × 100; TTM=${ttmFormula}`,
        {
          inputLineageIds: [
            ...pretaxIncome.lineageIds,
            ...cashTaxCashFlow.lineageIds,
          ],
          notes: [
            "不裁切負值或高於 100% 的實際現金稅率；下游模型必須顯性決定是否正規化。",
          ],
        },
      );
    } else {
      cashTaxRate = gapField(
        "cashTaxRatePercent",
        "percent",
        "DERIVED_INPUT_UNAVAILABLE",
        {
          formula: `(-1 × TTM cash-flow tax line) / TTM pretax income × 100; TTM=${ttmFormula}`,
          inputLineageIds: [
            ...pretaxIncome.lineageIds,
            ...cashTaxCashFlow.lineageIds,
          ],
          notes: ["需要正數 TTM 稅前淨利與可解析的現金流量表所得稅列。"],
        },
      );
    }
    const latestBalance = periods.latestReportedPeriod
      ? statementMap.get(statementKey("balance_sheet", periods.latestReportedPeriod)) ?? null
      : null;
    const cash = this.balanceSheetCash(latestBalance, lineage, addRoleLineage);
    const debt = this.balanceSheetDebt(latestBalance, lineage);
    const issuedShares = this.issuedShares(company, masterSource, lineage);

    const completedCloseLoad = await this.loadCompletedClose(
      company,
      evaluatedAt,
      warnings,
    );
    const completedClose = completedCloseLoad.result;
    const completedCloseSource = completedClose
      ? this.completedCloseSource(completedClose)
      : null;
    if (completedCloseSource) sources.push(completedCloseSource);
    const latestClose = this.latestClose(
      evaluatedAt,
      completedClose,
      completedCloseSource,
      lineage,
    );
    const netDebt = debt.status !== "data_gap" &&
      debt.value !== null &&
      cash.status !== "data_gap" &&
      cash.value !== null
      ? derivedField(
          "netDebt",
          "TWD",
          debt.value - cash.value,
          "interestBearingDebt - cashAndCashEquivalents",
          {
            inputFieldIds: ["interestBearingDebt", "cashAndCashEquivalents"],
            inputLineageIds: inheritedLineageIds(debt, cash),
          },
        )
      : gapField("netDebt", "TWD", "DERIVED_INPUT_UNAVAILABLE", {
          formula: "interestBearingDebt - cashAndCashEquivalents",
          inputFieldIds: ["interestBearingDebt", "cashAndCashEquivalents"],
          inputLineageIds: inheritedLineageIds(debt, cash),
        });
    const marketCapitalization = issuedShares.status === "reported" &&
      issuedShares.value !== null &&
      latestClose.status === "reported" &&
      latestClose.value !== null
      ? derivedField(
          "marketCapitalization",
          "TWD",
          issuedShares.value * latestClose.value,
          "issuedShares × latestOfficialClose",
          {
            inputFieldIds: ["issuedShares", "latestOfficialClose"],
            inputLineageIds: inheritedLineageIds(issuedShares, latestClose),
            evidenceClass: "OFFICIAL_CALC",
          },
        )
      : gapField("marketCapitalization", "TWD", "DERIVED_INPUT_UNAVAILABLE", {
          formula: "issuedShares × latestOfficialClose",
          inputFieldIds: ["issuedShares", "latestOfficialClose"],
          inputLineageIds: inheritedLineageIds(issuedShares, latestClose),
        });
    const enterpriseValue = marketCapitalization.status === "derived" &&
      marketCapitalization.value !== null &&
      netDebt.status === "derived" &&
      netDebt.value !== null
      ? derivedField(
          "enterpriseValue",
          "TWD",
          marketCapitalization.value + netDebt.value,
          "marketCapitalization + netDebt",
          {
            inputFieldIds: ["marketCapitalization", "netDebt"],
            inputLineageIds: inheritedLineageIds(marketCapitalization, netDebt),
            evidenceClass: "MIXED_OFFICIAL_CALC",
          },
        )
      : gapField("enterpriseValue", "TWD", "DERIVED_INPUT_UNAVAILABLE", {
          formula: "marketCapitalization + netDebt",
          inputFieldIds: ["marketCapitalization", "netDebt"],
          inputLineageIds: inheritedLineageIds(marketCapitalization, netDebt),
        });
    const normalizedFcff = [
      ttmOperatingIncome,
      cashTaxRate,
      ttmDandA,
      ttmCapex,
      ttmDeltaNwc,
    ].every((field) => field.status === "derived" && field.value !== null)
      ? derivedField(
          "normalizedFcff",
          "TWD",
          (ttmOperatingIncome.value as number) *
            (1 - (cashTaxRate.value as number) / 100) +
            (ttmDandA.value as number) -
            (ttmCapex.value as number) -
            (ttmDeltaNwc.value as number),
          "TTM EBIT proxy × (1 - cashTaxRatePercent / 100) + TTM D&A - TTM CapEx - TTM ΔNWC",
          {
            inputFieldIds: [
              "ttmOperatingIncomeEbitProxy",
              "cashTaxRatePercent",
              "ttmDepreciationAndAmortization",
              "ttmCapitalExpenditure",
              "ttmDeltaNetWorkingCapital",
            ],
            inputLineageIds: inheritedLineageIds(
              ttmOperatingIncome,
              cashTaxRate,
              ttmDandA,
              ttmCapex,
              ttmDeltaNwc,
            ),
            notes: [
              "欄位語意為 source/sign-normalized historical FCFF proxy：只做來源、單位、期間與現金流符號正規化，不代表分析師常態化獲利或預測 FCFF。",
              "這是可重算的歷史 FCFF proxy，不是管理層或分析師調整後預測，也不是投資建議。",
            ],
          },
        )
      : gapField("normalizedFcff", "TWD", "DERIVED_INPUT_UNAVAILABLE", {
          formula:
            "TTM EBIT proxy × (1 - cashTaxRatePercent / 100) + TTM D&A - TTM CapEx - TTM ΔNWC",
          inputFieldIds: [
            "ttmOperatingIncomeEbitProxy",
            "cashTaxRatePercent",
            "ttmDepreciationAndAmortization",
            "ttmCapitalExpenditure",
            "ttmDeltaNetWorkingCapital",
          ],
          inputLineageIds: inheritedLineageIds(
            ttmOperatingIncome,
            cashTaxRate,
            ttmDandA,
            ttmCapex,
            ttmDeltaNwc,
          ),
        });

    const fields: ValuationModelInputFields = {
      ttmRevenue,
      ttmOperatingIncomeEbitProxy: ttmOperatingIncome,
      cashTaxRatePercent: cashTaxRate,
      ttmDepreciationAndAmortization: ttmDandA,
      ttmCapitalExpenditure: ttmCapex,
      ttmDeltaNetWorkingCapital: ttmDeltaNwc,
      normalizedFcff,
      cashAndCashEquivalents: cash,
      interestBearingDebt: debt,
      netDebt,
      issuedShares,
      latestOfficialClose: latestClose,
      marketCapitalization,
      enterpriseValue,
    };
    const dataGapFields = FIELD_IDS.filter((id) => fields[id].status === "data_gap");
    if (!masterSource) {
      warnings.push(
        "公司 master 找到 identity，但缺少該市場來源 lineage；issuedShares fail closed。",
      );
    }
    if (dataGapFields.length > 0) {
      warnings.push(
        `以下估值模型輸入仍為 data_gap，未補 0：${dataGapFields.join("、")}。`,
      );
    }
    warnings.push(
      "所有財報金額由 Mopsfin HTML 明示的新台幣仟元乘以 1,000 正規化為 TWD；若單位缺失或衝突即 fail closed。",
      "歷史財報是本次向 Mopsfin 取得的目前可見版本，可能包含上游後續重編；不是 point-in-time filing vintage。",
      "本結果只整理可追溯模型輸入，不提供買賣評級、目標價或隱藏 WACC／terminal growth 假設。",
    );
    const data: ValuationModelInputsResult = {
      query: {
        companyCode: company.code,
        financialPeriod: "latest",
        priceDate: "latest_completed_official_session",
      },
      generatedAt: this.now().toISOString(),
      timezone: "Asia/Taipei",
      currency: "TWD",
      scope: "normalized_valuation_model_inputs",
      posture: "research_model_input_evidence_only",
      applicability: { status: "applicable", reason: null },
      company: companyResult,
      periods,
      fields,
      lineage,
      sources,
      quality: {
        calculationComplete: dataGapFields.length === 0,
        dataGapFields,
        notApplicableFields: [],
      },
      workBudget: {
        requestedCompanies: 1,
        orchestrationCompanyMasterCalls: 1,
        statementCalls: {
          actual: latestLoads.length + historicalLoads.length,
          maximum: 7,
          rowsPerCallMaximum: 500,
        },
        authoritativeCompletedCloseCalls: {
          actual: 1,
          maximum: 1,
          completedSessionResolver: {
            actualLogicalLoads:
              completedClose?.workBudget.completedSessionResolver.actualTotal ??
              null,
            maximumLogicalLoads:
              completedClose?.workBudget.completedSessionResolver.maximumTotal ??
              2,
          },
          exactStockOhlcAttempts: {
            actual:
              completedClose?.workBudget.exactStockOhlcAttempts.actual ?? null,
            maximum: 2,
            cacheRefreshPerformed:
              completedClose?.workBudget.exactStockOhlcAttempts
                .cacheRefreshPerformed ?? null,
          },
        },
      },
      warnings,
    };
    return {
      data,
      completedClose,
      completedCloseError: completedCloseLoad.error,
    };
  }

  private async loadStatement(
    company: MasterCompany,
    statement: StatementKind,
    period: "latest" | string,
  ): Promise<StatementLoad> {
    try {
      const result = await this.mopsfin.getFinancialStatement({
        statement,
        companyCodes: [company.code],
        period,
        page: { offset: 0, limit: STATEMENT_PAGE_LIMIT },
      });
      return {
        statement,
        requestedPeriod: period,
        resolved: resolveFinancialStatement(
          result,
          company,
          statement,
          period === "latest" ? undefined : period,
        ),
        error: null,
      };
    } catch (error) {
      return { statement, requestedPeriod: period, resolved: null, error };
    }
  }

  private ttmDepreciationAndAmortization(
    periods: ValuationModelPeriods,
    statementMap: Map<string, ResolvedStatement>,
    addLineage: (
      statement: ResolvedStatement | null,
      period: string,
      role: string,
      resolution: StatementRoleResolution | null,
      notes?: string[],
    ) => { value: number | null; lineageId: string; available: boolean },
    statementContractLineageIds: string[],
  ): RawMetric {
    if (!periods.currentYtdPeriod || periods.ttmMethod === "unavailable") {
      return {
        value: null,
        lineageIds: statementContractLineageIds,
        available: false,
        reason: "TTM_PERIOD_MISMATCH",
        notes: ["無法建立一致的 latest 財報期別。"],
      };
    }
    const periodInputs = periods.ttmMethod === "fiscal_year"
      ? [periods.currentYtdPeriod]
      : [
          periods.currentYtdPeriod,
          periods.priorFiscalYearPeriod as string,
          periods.priorYearYtdPeriod as string,
        ];
    const values: number[] = [];
    const lineageIds: string[] = [];
    let available = true;
    for (const period of periodInputs) {
      const statement = statementMap.get(statementKey("cash_flow", period)) ?? null;
      if (!statement) {
        const missing = addLineage(statement, period, "depreciation_and_amortization", null);
        lineageIds.push(missing.lineageId);
        available = false;
        continue;
      }
      const combined = resolveStatementRole(
        statement,
        "depreciation_and_amortization_combined",
        ROLE_LABELS.combinedDepreciationAmortization,
      );
      const depreciation = resolveStatementRole(
        statement,
        "depreciation",
        ROLE_LABELS.depreciation,
      );
      const amortization = resolveStatementRole(
        statement,
        "amortization",
        ROLE_LABELS.amortization,
      );
      const combinedResolved = combined.status === "resolved";
      const combinedPresent = combined.status !== "missing";
      const componentsPresent =
        depreciation.status !== "missing" || amortization.status !== "missing";
      if (combinedPresent && componentsPresent) {
        const ambiguous = addLineage(
          statement,
          period,
          "depreciation_and_amortization",
          { status: "ambiguous", role: "depreciation_and_amortization", row: null, candidateRowLabels: [
            ...combined.candidateRowLabels,
            ...depreciation.candidateRowLabels,
            ...amortization.candidateRowLabels,
          ] },
          ["同時出現合併 D&A 與分拆折舊／攤銷列，不重複加總。"],
        );
        lineageIds.push(ambiguous.lineageId);
        available = false;
        continue;
      }
      if (combinedResolved) {
        const entry = addLineage(statement, period, "depreciation_and_amortization", combined);
        lineageIds.push(entry.lineageId);
        if (!entry.available || entry.value === null) available = false;
        else values.push(entry.value);
        continue;
      }
      const depreciationEntry = addLineage(statement, period, "depreciation", depreciation);
      const amortizationEntry = addLineage(statement, period, "amortization", amortization);
      lineageIds.push(depreciationEntry.lineageId, amortizationEntry.lineageId);
      if (
        !depreciationEntry.available ||
        depreciationEntry.value === null ||
        !amortizationEntry.available ||
        amortizationEntry.value === null
      ) {
        available = false;
      } else {
        values.push(depreciationEntry.value + amortizationEntry.value);
      }
    }
    if (!available || values.length !== periodInputs.length) {
      return {
        value: null,
        lineageIds,
        available: false,
        reason: "TTM_COMPONENT_UNAVAILABLE",
        notes: ["D&A 必須由唯一合併列，或同時存在的折舊與攤銷分拆列建立。"],
      };
    }
    const value = periods.ttmMethod === "fiscal_year"
      ? values[0]
      : values[0] + values[1] - values[2];
    return {
      value,
      lineageIds,
      available: Number.isSafeInteger(value),
      reason: Number.isSafeInteger(value) ? null : "TTM_COMPONENT_UNAVAILABLE",
      notes: [],
    };
  }

  private balanceSheetCash(
    statement: ResolvedStatement | null,
    _lineage: ValuationModelLineageEntry[],
    addLineage: (
      statement: ResolvedStatement | null,
      period: string,
      role: string,
      resolution: StatementRoleResolution | null,
      notes?: string[],
    ) => { value: number | null; lineageId: string; available: boolean },
  ): ValuationModelInputField {
    const period = statement?.period ?? "latest_unavailable";
    const resolution = statement
      ? resolveStatementRole(statement, "cash_and_cash_equivalents", ROLE_LABELS.cash)
      : null;
    const entry = addLineage(statement, period, "cash_and_cash_equivalents", resolution);
    return entry.available && entry.value !== null
      ? reportedField("cashAndCashEquivalents", "TWD", entry.value, [entry.lineageId])
      : gapField("cashAndCashEquivalents", "TWD", "ROW_ROLE_MISSING", {
          inputLineageIds: [entry.lineageId],
          notes: ["latest 資產負債表缺少唯一且有效的現金及約當現金列。"],
        });
  }

  private balanceSheetDebt(
    statement: ResolvedStatement | null,
    lineage: ValuationModelLineageEntry[],
  ): ValuationModelInputField {
    if (!statement) {
      const lineageId = nextLineageId(lineage.length);
      lineage.push({
        lineageId,
        role: "interest_bearing_debt_search",
        status: "missing",
        sourceId: null,
        statement: "balance_sheet",
        period: null,
        rowLabel: null,
        rawValue: null,
        normalizedValue: null,
        unit: "TWD",
        candidateRowLabels: [],
        notes: ["latest balance sheet unavailable"],
      });
      return gapField("interestBearingDebt", "TWD", "STATEMENT_UNAVAILABLE", {
        inputLineageIds: [lineageId],
      });
    }
    const accepted = new Set(DEBT_LABELS.map(canonicalStatementLabel));
    const debtLikeRows = statement.rows.filter((row) => DEBT_LIKE.test(row.label));
    const unmapped = debtLikeRows.filter(
      (row) => !accepted.has(canonicalStatementLabel(row.label)),
    );
    if (unmapped.length > 0) {
      const lineageIds = unmapped.map((row) => {
        const lineageId = nextLineageId(lineage.length);
        lineage.push({
          lineageId,
          role: "unmapped_debt_like_row",
          status: "ambiguous",
          sourceId: sourceIdForStatement(statement.statement, statement.period),
          statement: statement.statement,
          period: statement.period,
          rowLabel: row.label,
          rawValue: row.rawValue,
          normalizedValue: row.valueTwd,
          unit: "TWD",
          candidateRowLabels: [row.label],
          notes: ["此 debt-like label 不在穩定 interest-bearing debt role allowlist。"],
        });
        return lineageId;
      });
      return gapField("interestBearingDebt", "TWD", "UNMAPPED_DEBT_LIKE_ROW", {
        inputLineageIds: lineageIds,
        notes: [
          `latest 資產負債表出現未納入穩定 debt role 的列：${unmapped.map((row) => row.label).join("、")}。`,
        ],
      });
    }
    const matches = statement.rows.filter((row) =>
      accepted.has(canonicalStatementLabel(row.label)),
    );
    const canonicalLabels = matches.map((row) => canonicalStatementLabel(row.label));
    if (new Set(canonicalLabels).size !== canonicalLabels.length) {
      const lineageId = nextLineageId(lineage.length);
      lineage.push({
        lineageId,
        role: "interest_bearing_debt_search",
        status: "ambiguous",
        sourceId: sourceIdForStatement(statement.statement, statement.period),
        statement: statement.statement,
        period: statement.period,
        rowLabel: null,
        rawValue: null,
        normalizedValue: null,
        unit: "TWD",
        candidateRowLabels: matches.map((row) => row.label),
        notes: ["重複 canonical debt labels"],
      });
      return gapField("interestBearingDebt", "TWD", "ROW_ROLE_AMBIGUOUS", {
        inputLineageIds: [lineageId],
        notes: ["latest 資產負債表包含重複 interest-bearing debt 科目。"],
      });
    }
    if (matches.length === 0) {
      const lineageId = nextLineageId(lineage.length);
      lineage.push({
        lineageId,
        role: "interest_bearing_debt_search",
        status: "missing",
        sourceId: sourceIdForStatement(statement.statement, statement.period),
        statement: statement.statement,
        period: statement.period,
        rowLabel: null,
        rawValue: null,
        normalizedValue: null,
        unit: "TWD",
        candidateRowLabels: [],
        notes: [`searched exact labels: ${DEBT_LABELS.join("、")}`],
      });
      return gapField("interestBearingDebt", "TWD", "NO_REPORTED_DEBT_COMPONENTS", {
        inputLineageIds: [lineageId],
        notes: ["來源未回傳任何可辨識的有息負債列；不得以 0 補值。"],
      });
    }
    const lineageIds: string[] = [];
    for (const row of matches) {
      const lineageId = nextLineageId(lineage.length);
      lineageIds.push(lineageId);
      lineage.push({
        lineageId,
        role: "interest_bearing_debt_component",
        status: row.valueTwd === null || row.valueTwd < 0 ? "invalid" : "resolved",
        sourceId: sourceIdForStatement(statement.statement, statement.period),
        statement: statement.statement,
        period: statement.period,
        rowLabel: row.label,
        rawValue: row.rawValue,
        normalizedValue: row.valueTwd,
        unit: "TWD",
        candidateRowLabels: [row.label],
        notes: [],
      });
    }
    if (matches.some((row) => row.valueTwd === null || row.valueTwd < 0)) {
      return gapField("interestBearingDebt", "TWD", "ROW_VALUE_INVALID", {
        inputLineageIds: lineageIds,
      });
    }
    return derivedField(
      "interestBearingDebt",
      "TWD",
      matches.reduce((sum, row) => sum + (row.valueTwd as number), 0),
      "sum(all exact-matched reported interest-bearing debt rows in latest balance sheet)",
      {
        inputLineageIds: lineageIds,
        notes: [
          "只加總來源實際回傳且吻合穩定 debt role 的列；不存在的列不補 0，未知 debt-like label 會使整欄 data_gap。",
        ],
      },
    );
  }

  private issuedShares(
    company: MasterCompany,
    source: ValuationModelCompanyMasterSource | null,
    lineage: ValuationModelLineageEntry[],
  ): ValuationModelInputField {
    const lineageId = nextLineageId(lineage.length);
    const value = company.issuedCommonShares;
    const valid =
      source !== null &&
      company.profileValueStatus.issuedCommonShares === "reported" &&
      value !== null &&
      Number.isSafeInteger(value) &&
      value > 0;
    lineage.push({
      lineageId,
      role: "issued_common_shares",
      status: valid ? "resolved" : "missing",
      sourceId: source?.sourceId ?? null,
      statement: null,
      period: source?.reportDate ?? null,
      rowLabel: "issuedCommonShares",
      rawValue: value,
      normalizedValue: value,
      unit: "share",
      candidateRowLabels: ["issuedCommonShares"],
      notes: ["目前公司 master 的已發行普通股股數；不是加權平均稀釋股數。"],
    });
    return valid
      ? reportedField("issuedShares", "share", value, [lineageId], [
          "股數基礎為目前公司 master 的 issuedCommonShares。",
        ], "OFFICIAL_MASTER_RAW")
      : gapField(
          "issuedShares",
          "share",
          "COMPANY_PROFILE_VALUE_UNAVAILABLE",
          { inputLineageIds: [lineageId] },
        );
  }

  private async loadCompletedClose(
    company: MasterCompany,
    evaluatedAt: string,
    warnings: string[],
  ): Promise<CompletedCloseLoad> {
    try {
      const result = await this.completedClose.getLatestCompletedClose({
        company: {
          code: company.code,
          shortName: company.shortName,
          market: company.market,
          exchange: company.exchange,
        },
        evaluatedAt,
      });
      const marketResolution = result.resolverEvidence.marketResolutions[0];
      const valid =
        result.query.companyCode === company.code &&
        result.query.market === company.market &&
        result.query.evaluatedAt === evaluatedAt &&
        result.company.code === company.code &&
        result.company.market === company.market &&
        result.company.exchange === company.exchange &&
        canonicalIdentity(result.company.shortName) ===
          canonicalIdentity(company.shortName) &&
        result.expectedAsOf === result.selectedBarDate &&
        result.expectedAsOf === result.bar.date &&
        result.expectedAsOf === result.source.selectedBarDate &&
        result.source.dataMonth === result.expectedAsOf.slice(0, 7) &&
        result.source.companyCode === company.code &&
        result.source.market === company.market &&
        result.source.exchange === company.exchange &&
        canonicalIdentity(result.source.observedName) ===
          canonicalIdentity(company.shortName) &&
        result.source.snapshotIdentity === "verified" &&
        Number.isFinite(Date.parse(result.source.retrievedAt)) &&
        Date.parse(result.source.retrievedAt) >=
          Date.parse(
            `${result.expectedAsOf}T${COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI}+08:00`,
          ) &&
        result.close === result.bar.close &&
        result.close > 0 &&
        result.bar.status === "traded" &&
        result.currency === "TWD" &&
        result.timezone === "Asia/Taipei" &&
        result.interval === "1d" &&
        result.priceBasis === "raw_unadjusted" &&
        result.workBudget.scope === "authoritative_completed_close_routing" &&
        JSON.stringify(result.workBudget.completedSessionResolver) ===
          JSON.stringify(result.resolverEvidence.workBudget) &&
        result.workBudget.exactStockOhlcAttempts.actual ===
          (result.cacheRefresh.attempted ? 2 : 1) &&
        result.workBudget.exactStockOhlcAttempts.maximum === 2 &&
        result.workBudget.exactStockOhlcAttempts.cacheRefreshPerformed ===
          result.cacheRefresh.attempted &&
        result.resolverEvidence.status === "resolved" &&
        result.resolverEvidence.evaluatedAt === evaluatedAt &&
        result.resolverEvidence.expectedAsOf === result.expectedAsOf &&
        result.resolverEvidence.markets.length === 1 &&
        result.resolverEvidence.markets[0] === company.market &&
        result.resolverEvidence.marketResolutions.length === 1 &&
        marketResolution?.market === company.market &&
        marketResolution.status === "resolved" &&
        marketResolution.expectedAsOf === result.expectedAsOf;
      if (!valid) {
        throw new MopsfinError(
          "UPSTREAM_BAD_RESPONSE",
          "authoritative completed-close dependency identity／date contract 不一致。",
          {
            reason: "COMPLETED_CLOSE_DEPENDENCY_MISMATCH",
            category: "upstream",
            retryable: false,
            action: "none",
          },
        );
      }
      return { result, error: null };
    } catch (error) {
      const completedCloseError = asMopsfinError(error);
      warnings.push(
        `authoritative completed-close dependency 失敗（${completedCloseError.reason ?? "UNKNOWN"}）：${completedCloseError.message}；未回退全市場 latest。`,
      );
      return { result: null, error: completedCloseError };
    }
  }

  private completedCloseSource(
    completedClose: AuthoritativeCompletedCloseResult,
  ): ValuationModelCompletedCloseSource {
    return {
      ...completedClose.source,
      sourceId: `latest_official_completed_close:${completedClose.company.market}:${completedClose.selectedBarDate}`,
      stage: "latest_official_completed_close",
      asOf: completedClose.selectedBarDate,
      asOfGranularity: "date",
    };
  }

  private latestClose(
    evaluatedAt: string,
    completedClose: AuthoritativeCompletedCloseResult | null,
    source: ValuationModelCompletedCloseSource | null,
    lineage: ValuationModelLineageEntry[],
  ): ValuationModelInputField {
    const valid = completedClose !== null && source !== null;
    const lineageId = nextLineageId(lineage.length);
    lineage.push({
      lineageId,
      role: "latest_completed_official_close",
      status: valid ? "resolved" : "missing",
      sourceId: source?.sourceId ?? null,
      statement: null,
      period: completedClose?.selectedBarDate ?? null,
      rowLabel: "close",
      rawValue: completedClose?.close ?? null,
      normalizedValue: completedClose?.close ?? null,
      unit: "TWD_per_share",
      candidateRowLabels: valid ? ["close"] : [],
      notes: [
        "authoritative completed-session resolver 的 expectedAsOf 與官方 exact single-stock OHLC bar 日期必須完全相等。",
        "價格來源為官方單股月資料中的 exact selected bar；不是全市場 latest、盤中價或 adjusted close。",
        `request-start evaluatedAt=${evaluatedAt}`,
      ],
    });
    return valid
      ? reportedField(
          "latestOfficialClose",
          "TWD_per_share",
          completedClose.close,
          [lineageId],
          [
            `resolver expectedAsOf=${completedClose.expectedAsOf}`,
            `official exact selected bar date=${completedClose.selectedBarDate}`,
          ],
          "OFFICIAL_MARKET_RAW",
        )
      : gapField(
          "latestOfficialClose",
          "TWD_per_share",
          "VALUATION_VALUE_UNAVAILABLE",
          { inputLineageIds: [lineageId] },
        );
  }
}

export const valuationModelInputsClient = new ValuationModelInputsClient();
