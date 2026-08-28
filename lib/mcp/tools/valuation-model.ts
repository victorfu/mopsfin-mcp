import type { FreshnessEvaluation } from "@/lib/freshness/types";
import type { QualityIssue } from "@/lib/mcp/result-contract";
import { valuationModelInputsClient } from "@/lib/valuation-model/client";
import type {
  ValuationModelFieldId,
  ValuationModelInputsResult,
  ValuationModelSource,
} from "@/lib/valuation-model/types";

import {
  valuationModelInputsInputSchema,
  valuationModelInputsOutputSchema,
} from "../schema/valuation-model";
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

function latestObservedAsOf(sources: ValuationModelSource[]): string | null {
  return sources.map((source) => source.asOf).sort().at(-1) ?? null;
}

function freshnessDetails(
  data: ValuationModelInputsResult,
): FreshnessEvaluation[] {
  const details: FreshnessEvaluation[] = [];
  const masterSources = sourcesByStage(data.sources, "company_master");
  if (masterSources.length > 0) {
    details.push(
      evaluateFreshness({
        policy: FRESHNESS_POLICIES.currentSnapshotSevenDays,
        observedAsOf: latestObservedAsOf(masterSources),
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
        observedAsOf: data.periods.latestReportedPeriod,
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
        observedAsOf: latestObservedAsOf(marketSources),
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

function issueRefs(
  data: ValuationModelInputsResult,
  options: {
    fields?: string[];
    periods?: string[];
    sourceStages?: ValuationModelSource["stage"][];
  } = {},
): QualityIssue["refs"] {
  const selectedSources = options.sourceStages
    ? data.sources.filter((source) => options.sourceStages?.includes(source.stage))
    : data.sources;
  return {
    companyCodes: [data.company.code],
    fields: options.fields ?? [],
    periods: unique((options.periods ?? []).filter(Boolean)),
    sourceUrls: unique(selectedSources.map((source) => source.sourceUrl)),
  };
}

function qualityIssues(data: ValuationModelInputsResult): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (data.quality.dataGapFields.length > 0) {
    issues.push({
      code: "VALUATION_MODEL_DATA_GAP",
      severity: "warning",
      scope: "value",
      message:
        "至少一個必要模型輸入缺少足夠的 identity、單位、期別、row role 或 dependency 證據；value 維持 null，未以 0 或其他來源代填。",
      refs: issueRefs(data, {
        fields: data.quality.dataGapFields.map((field) => `fields.${field}`),
      }),
    });
  }
  if (data.applicability.status === "not_applicable") {
    issues.push({
      code: "VALUATION_MODEL_NOT_APPLICABLE",
      severity: "warning",
      scope: "value",
      message:
        "金融公司不適用一般企業 FCFF／enterprise-value DCF；所有模型欄位保持 not_applicable，應改用 residual income、dividend 或 excess-return 類模型。",
      refs: issueRefs(data, {
        fields: data.quality.notApplicableFields.map((field) => `fields.${field}`),
      }),
    });
  }
  if (!sourceDependenciesComplete(data)) {
    issues.push({
      code: "SOURCE_DEPENDENCY_INCOMPLETE",
      severity: "warning",
      scope: "source",
      message:
        "至少一個實際執行的 company master、statement 或 official valuation dependency 缺少對應 source lineage；source 品質為 partial。",
      refs: issueRefs(data, {
        fields: ["sources", "workBudget"],
      }),
    });
  }
  issues.push(
    {
      code: "VALUATION_MODEL_EVIDENCE_CLASSES",
      severity: "info",
      scope: "value",
      message:
        "每個欄位以 evidenceClass 分開標示 Mopsfin 原值／計算、官方 master／市場原值、同來源或跨來源計算；MIXED_OFFICIAL_CALC 不得解讀為單一 Mopsfin 原值。",
      refs: issueRefs(data, {
        fields: ["fields.*.evidenceClass", "lineage", "sources"],
      }),
    },
    {
      code: "DATA_GAPS_NOT_ZERO_FILLED",
      severity: "info",
      scope: "value",
      message:
        "缺少或無法唯一解析的模型輸入一律以 data_gap/null 揭露；0 只在官方值或可重算公式確實得到 0 時保留。",
      refs: issueRefs(data, {
        fields: ["fields.*.status", "fields.*.value", "quality.dataGapFields"],
      }),
    },
  );
  if (data.applicability.status === "applicable") {
    issues.push({
      code: "FINANCIAL_STATEMENT_CURRENT_VIEW_NOT_POINT_IN_TIME",
      severity: "info",
      scope: "period",
      message:
        "歷史財報是本次向 Mopsfin 取得的目前可見版本，可能包含後續重編；不是各 filing date 當時可見的 point-in-time vintage。",
      refs: issueRefs(data, {
        fields: ["periods", "lineage", "sources"],
        periods: data.sources
          .filter((source) => source.stage === "statement")
          .map((source) => source.asOf),
        sourceStages: ["statement"],
      }),
    }, {
      code: "ISSUED_SHARES_NOT_DILUTED",
      severity: "info",
      scope: "value",
      message:
        "issuedShares 來自目前公司 master 的已發行普通股股數；不是歷史期末股數、加權平均股數或 fully diluted shares。",
      refs: issueRefs(data, {
        fields: ["fields.issuedShares", "fields.marketCapitalization"],
        sourceStages: ["company_master"],
      }),
    }, {
      code: "HISTORICAL_FCFF_PROXY_NOT_FORECAST",
      severity: "info",
      scope: "value",
      message:
        "normalizedFcff 是 source/sign-normalized historical FCFF proxy，不代表分析師正規化獲利、管理層指引或預測 FCFF。",
      refs: issueRefs(data, {
        fields: ["fields.normalizedFcff"],
        sourceStages: ["statement"],
      }),
    }, {
      code: "CAPEX_PPE_ACQUISITION_ONLY",
      severity: "info",
      scope: "value",
      message:
        "ttmCapitalExpenditure 只採現金流量表的取得不動產、廠房及設備（PPE acquisition），未包含無形資產或其他投資支出。",
      refs: issueRefs(data, {
        fields: ["fields.ttmCapitalExpenditure"],
        sourceStages: ["statement"],
      }),
    });
  }
  return issues;
}

function sourceDependenciesComplete(data: ValuationModelInputsResult): boolean {
  const masterSourceCount = sourcesByStage(data.sources, "company_master").length;
  const statementSourceCount = sourcesByStage(data.sources, "statement").length;
  const marketSourceCount = sourcesByStage(data.sources, "market_valuation").length;
  return (
    masterSourceCount === 1 &&
    statementSourceCount === data.workBudget.statementCalls.actual &&
    (data.workBudget.valuationDependencyCalls.actual === 0 ||
      marketSourceCount > 0)
  );
}

export const getValuationModelInputsTool = defineTool(
  "get_valuation_model_inputs",
  {
    title: "取得可追溯的估值模型輸入",
    description:
      "為單一目前上市櫃非金融公司整理可重算的 valuation model input evidence：TTM revenue、營業利益 EBIT proxy、cash tax rate、D&A、只含 PPE acquisition 的 CapEx、ΔNWC、source/sign-normalized historical FCFF proxy、cash、有息負債、net debt、目前 issued shares、最近完成官方估值日收盤、market cap 與 enterprise value。財報 TTM 嚴格採 Q4 FY 或 current YTD + prior FY - prior-year YTD，並核對 company identity、報表類型、期別、合併範圍、row-role uniqueness 及 HTML/catalog unit provenance；任一證據不足即 data_gap/null，不補 0、不猜科目、不靜默換來源。每個欄位揭露 reported/derived/data_gap/not_applicable、evidenceClass、formula、inputs、lineage 與 notes；歷史財報是目前可見、可能重編版本，不是 point-in-time filing vintage。issuedShares 是目前 master 的已發行普通股，不是 fully diluted shares；latestOfficialClose 不是盤中價，且 official market latest freshness 在沒有權威交易日 resolver 時仍為 unknown。金融業明確 NOT_APPLICABLE，應改用 residual-income/dividend 類模型。本工具不執行 DCF、不提供 WACC／terminal-growth 隱藏預設、評級、目標價或投資建議。",
    inputSchema: valuationModelInputsInputSchema,
    outputSchema: valuationModelInputsOutputSchema,
    annotations,
  },
  async ({ company_code }) => {
    try {
      const data = await valuationModelInputsClient.getValuationModelInputs({
        companyCode: company_code,
      });
      const dataGapCount = data.quality.dataGapFields.length;
      const sourceComplete = sourceDependenciesComplete(data);
      const masterSourceCount = sourcesByStage(
        data.sources,
        "company_master",
      ).length;
      const snapshotId = fingerprint({
        query: data.query,
        applicability: data.applicability,
        periods: data.periods,
        sources: data.sources,
        fields: data.fields,
      });
      return success(
        data.applicability.status === "not_applicable"
          ? `${data.company.code} ${data.company.shortName}：一般企業 FCFF 模型不適用；請使用金融業專用模型。`
          : `${data.company.code} ${data.company.shortName}：完成 14 個可追溯模型欄位，data_gap=${dataGapCount}；本結果只提供 evidence，不執行估值判斷。`,
        data,
        {
          selector: "latest",
          resolved: {
            granularity: "mixed",
            from: null,
            through: null,
          },
          snapshotId,
          source: sourceComplete ? "complete" : "partial",
          universe: masterSourceCount === 1 ? "verified" : "unverified",
          selection: "complete",
          values:
            data.applicability.status === "not_applicable"
              ? "not_applicable"
              : dataGapCount > 0
                ? "partial"
                : "complete",
          freshnessDetails: freshnessDetails(data),
          issues: qualityIssues(data),
        },
      );
    } catch (error) {
      return failure(error);
    }
  },
);

export const valuationModelTools = [getValuationModelInputsTool] as const;
