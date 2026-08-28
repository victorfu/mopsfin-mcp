import type { FreshnessEvaluation } from "@/lib/freshness/types";
import type { QualityIssue } from "@/lib/mcp/result-contract";
import {
  reverseDcfMcpClient,
  type ReverseDcfOrchestrationResult,
} from "@/lib/reverse-dcf/mcp-client";
import type { ValuationModelSource } from "@/lib/valuation-model/types";

import {
  reverseDcfInputSchema,
  reverseDcfOutputSchema,
} from "../schema/reverse-dcf";
import { defineTool } from "./definition";
import {
  FRESHNESS_POLICIES,
  annotations,
  evaluateFreshness,
  failure,
  fingerprint,
  success,
  taipeiDate,
} from "./shared";

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sourcesByStage(
  sources: ValuationModelSource[],
  stage: ValuationModelSource["stage"],
): ValuationModelSource[] {
  return sources.filter((source) => source.stage === stage);
}

function latestAsOf(sources: ValuationModelSource[]): string | null {
  return sources.map((source) => source.asOf).sort().at(-1) ?? null;
}

function freshnessDetails(
  data: ReverseDcfOrchestrationResult,
): FreshnessEvaluation[] {
  const details: FreshnessEvaluation[] = [];
  const masterSources = sourcesByStage(data.sources, "company_master");
  if (masterSources.length > 0) {
    details.push(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
        observedAsOf: latestAsOf(masterSources),
        expectedAsOf: taipeiDate(data.generatedAt),
        sourceUrls: unique(masterSources.map((source) => source.sourceUrl)),
      }),
    );
  }

  const statementSources = sourcesByStage(data.sources, "statement");
  if (statementSources.length > 0) {
    details.push(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.mopsfinLatestUnverified,
        observedAsOf: data.normalizedInputEvidence.periods.latestReportedPeriod,
        expectedAsOf: null,
        sourceUrls: unique(statementSources.map((source) => source.sourceUrl)),
      }),
    );
  }

  const marketSources = sourcesByStage(data.sources, "market_valuation");
  if (marketSources.length > 0) {
    details.push(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.completedOfficialSession,
        observedAsOf: latestAsOf(marketSources),
        expectedAsOf: null,
        sourceUrls: unique(marketSources.map((source) => source.sourceUrl)),
      }),
    );
  }

  return details.length > 0
    ? details
    : [
        evaluateFreshness({
          policy: FRESHNESS_POLICIES.unspecified,
          observedAsOf: null,
          expectedAsOf: null,
          sourceUrls: [],
        }),
      ];
}

function sourceDependenciesComplete(
  data: ReverseDcfOrchestrationResult,
): boolean {
  const budget = data.workBudget.valuationModelInputs;
  return (
    sourcesByStage(data.sources, "company_master").length === 1 &&
    sourcesByStage(data.sources, "statement").length ===
      budget.statementCalls.actual &&
    (budget.valuationDependencyCalls.actual === 0 ||
      sourcesByStage(data.sources, "market_valuation").length > 0)
  );
}

function issueRefs(
  data: ReverseDcfOrchestrationResult,
  fields: string[],
  stages?: ValuationModelSource["stage"][],
): QualityIssue["refs"] {
  const sources = stages
    ? data.sources.filter((source) => stages.includes(source.stage))
    : data.sources;
  return {
    companyCodes: [data.company.code],
    fields,
    periods: unique(sources.map((source) => source.asOf)),
    sourceUrls: unique(sources.map((source) => source.sourceUrl)),
  };
}

function qualityIssues(data: ReverseDcfOrchestrationResult): QualityIssue[] {
  const failedSensitivityCells = data.model.sensitivities.filter(
    (cell) => cell.status !== "solved",
  );
  const used = new Set(data.normalizedInputEvidence.usedFieldIds);
  const unusedDataGaps = Object.values(data.normalizedInputEvidence.fields)
    .filter((field) => field.status === "data_gap" && !used.has(field.id))
    .map((field) => field.id);
  const issues: QualityIssue[] = [
    {
      code: "MARKET_IMPLIED_NOT_TARGET_PRICE",
      severity: "info",
      scope: "value",
      message:
        "結果反解的是目前官方完成交易日價格所隱含的單一營運變數，不是 intrinsic-value 目標價、分析師共識、買賣評級或投資建議。",
      refs: issueRefs(data, [
        "model.solution.solvedValuePercent",
        "model.bridge.observedPricePerShareTwd",
      ], ["market_valuation"]),
    },
    {
      code: "CALLER_ASSUMPTIONS_EXPLICIT",
      severity: "info",
      scope: "value",
      message:
        "WACC、terminal growth、forecast years、solve range、forward assumptions 與 sensitivity grid 全部由 caller 明示；模型不補隱藏預設。",
      refs: issueRefs(data, [
        "query.wacc_percent",
        "query.terminal_growth_percent",
        "query.forecast_years",
        "query.solve_range",
        "query.forward_assumptions",
        "query.sensitivity_grids",
      ]),
    },
    {
      code: "EV_BRIDGE_CALLER_ASSUMPTIONS",
      severity: "info",
      scope: "value",
      message:
        "非營運資產、非控制權益、特別股、退休金缺口與其他 debt-like claims 是 caller 明示 bridge assumptions；即使為 0 也不是系統預設或官方已驗證值。",
      refs: issueRefs(data, [
        "query.enterprise_value_bridge",
        "model.bridge",
        "model.evidence.assumptions",
      ]),
    },
    {
      code: "AGGREGATE_DEBT_LEASE_NOT_DOUBLE_COUNTED",
      severity: "info",
      scope: "value",
      message:
        "v0.8 interestBearingDebt 已彙總可唯一解析的 debt 與 lease-liability roles；engine 的 lease bridge 為 0 只為避免重複計入，不代表租賃負債實際為零。",
      refs: issueRefs(data, [
        "normalizedInputEvidence.fields.interestBearingDebt",
        "model.bridge.plusLeaseLiabilitiesTwd",
      ], ["statement"]),
    },
    {
      code: "ISSUED_SHARES_NOT_DILUTED",
      severity: "info",
      scope: "value",
      message:
        "market equity value 使用目前 company master 的 issued common shares；不是歷史期末、加權平均或 fully diluted shares。",
      refs: issueRefs(data, [
        "normalizedInputEvidence.fields.issuedShares",
        "model.bridge.shareCountBasis",
      ], ["company_master"]),
    },
    {
      code: "MODEL_LIMITATIONS",
      severity: "info",
      scope: "value",
      message:
        "第一版固定 FCFF／WACC、year-end discounting 與 perpetuity-growth terminal value；每次只反解一個變數，其他輸入保持 caller 明示。",
      refs: issueRefs(data, [
        "model.cashFlowBasis",
        "model.discountRateBasis",
        "model.discountConvention",
        "model.terminal.method",
        "model.limitations",
      ]),
    },
    {
      code: "FINANCIAL_STATEMENT_CURRENT_VIEW_NOT_POINT_IN_TIME",
      severity: "info",
      scope: "period",
      message:
        "模型沿用查詢當下可見、可能包含後續重編的 Mopsfin 財報；不是各 filing date 當時可見的 point-in-time vintage。",
      refs: issueRefs(data, [
        "normalizedInputEvidence.periods",
        "normalizedInputEvidence.lineageLedger",
      ], ["statement"]),
    },
  ];

  if (!sourceDependenciesComplete(data)) {
    issues.push({
      code: "SOURCE_DEPENDENCY_INCOMPLETE",
      severity: "warning",
      scope: "source",
      message:
        "v0.8 normalization 至少一個實際執行、但本 solve mode 未必使用的 dependency 缺少 source lineage；主模型已由 usedFieldIds 完整建立，但整體 source 品質為 partial。",
      refs: issueRefs(data, ["sources", "workBudget.valuationModelInputs"]),
    });
  }
  if (unusedDataGaps.length > 0) {
    issues.push({
      code: "UNUSED_NORMALIZED_INPUT_GAPS",
      severity: "warning",
      scope: "value",
      message:
        "完整 v0.8 field snapshot 含本 solve mode 未使用的 data_gap；這些缺口未被補 0，也未參與本次成功模型計算。",
      refs: issueRefs(
        data,
        unusedDataGaps.map((field) =>
          `normalizedInputEvidence.fields.${field}`,
        ),
      ),
    });
  }
  if (failedSensitivityCells.length > 0) {
    issues.push({
      code: "SENSITIVITY_CELL_FAILURE",
      severity: "warning",
      scope: "value",
      message:
        "至少一個 caller-requested sensitivity cell 無可行解或不符合數學條件；失敗已逐 cell 隔離，不以主模型值或鄰近 cell 代填。",
      refs: issueRefs(
        data,
        failedSensitivityCells.map(
          (cell) =>
            `model.sensitivities[WACC=${cell.waccPercent},g=${cell.terminalGrowthPercent}]`,
        ),
      ),
    });
  }
  return issues;
}

export const runReverseDcfTool = defineTool(
  "run_reverse_dcf",
  {
    title: "反解市場價格隱含的 Reverse DCF 變數",
    description:
      "為單一目前上市櫃非金融公司執行 deterministic、可重算的 market-implied FCFF reverse DCF。工具先沿用 get_valuation_model_inputs 的 current-master identity、TTM／historical FCFF proxy、cash、aggregate interest-bearing debt、issued common shares 與官方最近完成交易日收盤，再一次只反解 revenue_cagr、fcff_cagr 或 terminal_operating_margin。caller 必須明示 forecast years、WACC、terminal growth、solve bracket、mode-specific forward assumptions、所有額外 EV bridge 金額（包含顯性 0）與可選 sensitivity grid；不提供隱藏預設。每個 sensitivity cell 重新求解且個別揭露無可行解；WACC 必須大於 terminal growth，缺必要 input、lineage 或 bracket 時 fail closed。輸出分開 MOPSFIN_RAW／CALC、官方證據、CALLER_ASSUMPTION 與 MODEL_OUTPUT，保留公式、forecast、terminal value、EV bridge、checks、來源與時間 lineage。金融業不適用；結果是目前市場價格隱含條件，不是 intrinsic value、目標價、分析師共識、買賣評級或投資建議，也不改變 balanced_non_financial_v2 screening 契約。",
    inputSchema: reverseDcfInputSchema,
    outputSchema: reverseDcfOutputSchema,
    annotations,
  },
  async (query) => {
    try {
      const data = await reverseDcfMcpClient.runReverseDcf(query);
      const sourceComplete = sourceDependenciesComplete(data);
      const masterSourceCount = sourcesByStage(
        data.sources,
        "company_master",
      ).length;
      const snapshotId = fingerprint({
        query: data.query,
        company: data.company,
        model: data.model,
        usedFieldIds: data.normalizedInputEvidence.usedFieldIds,
        factMappings: data.normalizedInputEvidence.factMappings,
        sources: data.sources,
      });
      return success(
        `${data.company.code} ${data.company.shortName}：${data.model.solution.solveFor} 的市場隱含值為 ${data.model.solution.solvedValuePercent}%；這是 caller assumptions 下的可重算模型輸出，不是目標價或投資建議。`,
        data,
        {
          selector: "latest",
          resolved: { granularity: "mixed", from: null, through: null },
          snapshotId,
          source: sourceComplete ? "complete" : "partial",
          universe: masterSourceCount === 1 ? "verified" : "unverified",
          selection: "complete",
          values: "complete",
          freshnessDetails: freshnessDetails(data),
          issues: qualityIssues(data),
        },
      );
    } catch (error) {
      return failure(error);
    }
  },
);

export const reverseDcfTools = [runReverseDcfTool] as const;
