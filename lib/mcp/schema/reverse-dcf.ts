import { z } from "zod";

import type { ReverseDcfPublicQuery } from "@/lib/reverse-dcf/mcp-client";
import { REVERSE_DCF_MODEL_VERSION } from "@/lib/reverse-dcf/types";

import { successResultShape } from "./common";
import { valuationModelInputsDataSchema } from "./valuation-model";

const strictIsoInstantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const finitePercentSchema = z.number().finite().describe("有限百分比數值，單位為 percentage points");
const nonNegativeTwdSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("caller 明示、非負且不超過 JavaScript safe-integer 範圍的 TWD 金額；0 必須是顯性輸入");

const callerBridgeSchema = z
  .object({
    non_operating_assets_twd: nonNegativeTwdSchema.describe(
      "未含在 cashAndCashEquivalents 的非營運資產；即使判定為 0 也必須由 caller 明示",
    ),
    non_controlling_interests_twd: nonNegativeTwdSchema.describe(
      "enterprise-to-equity bridge 的非控制權益；0 也必須由 caller 明示",
    ),
    preferred_equity_twd: nonNegativeTwdSchema.describe(
      "enterprise-to-equity bridge 的特別股權益；0 也必須由 caller 明示",
    ),
    pension_deficit_twd: nonNegativeTwdSchema.describe(
      "enterprise-to-equity bridge 的退休金缺口；0 也必須由 caller 明示",
    ),
    other_debt_like_items_twd: nonNegativeTwdSchema.describe(
      "未含在 normalized aggregate interest-bearing debt 的其他 debt-like claims；0 也必須由 caller 明示",
    ),
  })
  .strict()
  .describe("所有非 normalized valuation-model fields 的 EV bridge caller assumptions；不提供隱藏 0 預設");

const solveRangeSchema = z
  .object({
    minimum_percent: finitePercentSchema.describe("反解 bracket 的含頭最小百分比"),
    maximum_percent: finitePercentSchema.describe("反解 bracket 的含尾最大百分比，必須大於 minimum_percent"),
  })
  .strict()
  .refine((range) => range.minimum_percent < range.maximum_percent, {
    path: ["maximum_percent"],
    message: "maximum_percent 必須大於 minimum_percent",
  })
  .describe("caller 明示的 deterministic-bisection 解區間；找不到 bracket 時不外插猜測");

const sensitivityGridsSchema = z
  .object({
    wacc_percent: z
      .array(finitePercentSchema.positive().max(100).describe("單一 caller sensitivity WACC"))
      .min(1)
      .max(5)
      .describe("caller 明示 WACC 軸，1 至 5 個值"),
    terminal_growth_percent: z
      .array(finitePercentSchema.gt(-100).max(50).describe("單一 caller sensitivity 永續成長率"))
      .min(1)
      .max(5)
      .describe("caller 明示 terminal-growth 軸，1 至 5 個值"),
  })
  .strict()
  .superRefine((grids, context) => {
    if (grids.wacc_percent.length * grids.terminal_growth_percent.length > 25) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "sensitivity grid 最多 25 cells",
      });
    }
    if (new Set(grids.wacc_percent).size !== grids.wacc_percent.length) {
      context.addIssue({
        code: "custom",
        path: ["wacc_percent"],
        message: "WACC sensitivity axis 不得有重複值",
      });
    }
    if (
      new Set(grids.terminal_growth_percent).size !==
      grids.terminal_growth_percent.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminal_growth_percent"],
        message: "terminal-growth sensitivity axis 不得有重複值",
      });
    }
    for (const [waccIndex, wacc] of grids.wacc_percent.entries()) {
      for (const [growthIndex, growth] of grids.terminal_growth_percent.entries()) {
        if (wacc <= growth) {
          context.addIssue({
            code: "custom",
            path: ["terminal_growth_percent", growthIndex],
            message: `每個 sensitivity cell 都必須 WACC > terminal growth（wacc index ${waccIndex}）`,
          });
        }
      }
    }
  })
  .describe("可選且完全由 caller 明示的 WACC × terminal-growth sensitivity grid");

const commonInputShape = {
  company_code: z
    .string()
    .regex(/^\d{4}$/)
    .describe("單一四碼、目前公司 master 可核對的台股公司股票代號"),
  price_source: z
    .literal("latest_completed_close")
    .describe("固定使用 request-start authoritative resolver expectedAsOf 同日的官方 exact 單股 OHLC close；不接受或回退全市場 latest、盤中價或外部 quote"),
  forecast_years: z
    .number()
    .int()
    .min(1)
    .max(20)
    .describe("顯性 forecast horizon，1 至 20 年"),
  wacc_percent: finitePercentSchema
    .positive()
    .max(100)
    .describe("caller 明示 WACC；FCFF 只以此 WACC 折現"),
  terminal_growth_percent: finitePercentSchema
    .gt(-100)
    .max(50)
    .describe("caller 明示 perpetuity terminal growth；必須低於 WACC"),
  solve_range: solveRangeSchema,
  enterprise_value_bridge: callerBridgeSchema,
  sensitivity_grids: sensitivityGridsSchema
    .optional()
    .describe("可選 caller sensitivity grid；省略時不產生隱藏情境"),
};

const revenueForwardAssumptionsSchema = z
  .object({
    normalized_operating_margin_percent: finitePercentSchema
      .min(0)
      .max(100)
      .describe("caller 明示且 forecast horizon 固定使用的 normalized operating margin"),
    cash_tax_rate_percent: finitePercentSchema
      .min(0)
      .lt(100)
      .describe("caller 明示 cash tax rate，0% 至低於 100%"),
    sales_to_capital_ratio: z
      .number()
      .finite()
      .positive()
      .max(1000)
      .describe("caller 明示 sales-to-capital ratio，用於 ΔRevenue / ratio 的再投資估算"),
  })
  .strict()
  .describe("revenue CAGR mode 必須明示的三項 forward assumptions");

const fcffForwardAssumptionsSchema = z
  .object({})
  .strict()
  .describe("FCFF CAGR mode 不接受額外 forward assumptions；growth 即唯一反解變數");

const terminalMarginForwardAssumptionsSchema = z
  .object({
    revenue_cagr_percent: finitePercentSchema
      .gt(-100)
      .max(500)
      .describe("caller 明示 forecast revenue CAGR；此 mode 不反解 revenue growth"),
    cash_tax_rate_percent: finitePercentSchema
      .min(0)
      .lt(100)
      .describe("caller 明示 cash tax rate，0% 至低於 100%"),
    sales_to_capital_ratio: z
      .number()
      .finite()
      .positive()
      .max(1000)
      .describe("caller 明示 sales-to-capital ratio，用於 ΔRevenue / ratio 的再投資估算"),
  })
  .strict()
  .describe("terminal-margin mode 必須明示的 revenue growth、cash tax 與 reinvestment assumptions");

const reverseDcfInputBaseSchema = z
  .object({
    ...commonInputShape,
    solve_for: z
      .enum(["revenue_cagr", "fcff_cagr", "terminal_operating_margin"])
      .describe("本次唯一反解變數；三種 mode 各有精確 forward_assumptions contract"),
    forward_assumptions: z
      .union([
        revenueForwardAssumptionsSchema,
        fcffForwardAssumptionsSchema,
        terminalMarginForwardAssumptionsSchema,
      ])
      .describe("依 solve_for 嚴格配對的顯性 forward assumptions；不接受其他 keys"),
  })
  .strict();

const refinedReverseDcfInputSchema = reverseDcfInputBaseSchema
  .superRefine((input, context) => {
    if (input.wacc_percent <= input.terminal_growth_percent) {
      context.addIssue({
        code: "custom",
        path: ["terminal_growth_percent"],
        message: "FCFF perpetuity 必須滿足 wacc_percent > terminal_growth_percent",
      });
    }
    const assumptionKeys = Object.keys(input.forward_assumptions).sort();
    const expectedAssumptionKeys =
      input.solve_for === "revenue_cagr"
        ? [
            "cash_tax_rate_percent",
            "normalized_operating_margin_percent",
            "sales_to_capital_ratio",
          ]
        : input.solve_for === "fcff_cagr"
          ? []
          : [
              "cash_tax_rate_percent",
              "revenue_cagr_percent",
              "sales_to_capital_ratio",
            ];
    if (
      JSON.stringify(assumptionKeys) !==
      JSON.stringify(expectedAssumptionKeys)
    ) {
      context.addIssue({
        code: "custom",
        path: ["forward_assumptions"],
        message: `${input.solve_for} 的 forward_assumptions keys 不符合 mode-specific contract`,
      });
    }
    if (
      input.solve_for === "terminal_operating_margin" &&
      (input.solve_range.minimum_percent < 0 ||
        input.solve_range.maximum_percent > 100)
    ) {
      context.addIssue({
        code: "custom",
        path: ["solve_range"],
        message: "terminal operating margin solve range 必須介於 0% 與 100%",
      });
    }
    if (
      input.solve_for !== "terminal_operating_margin" &&
      (input.solve_range.minimum_percent <= -100 ||
        input.solve_range.maximum_percent > 500)
    ) {
      context.addIssue({
        code: "custom",
        path: ["solve_range"],
        message: "revenue／FCFF CAGR solve range 必須大於 -100% 且不超過 500%",
      });
    }
  })
  .describe("market-implied reverse DCF 的完整顯性輸入；一次只反解一個變數，不提供隱藏假設");

export const reverseDcfInputSchema =
  refinedReverseDcfInputSchema as unknown as z.ZodType<ReverseDcfPublicQuery>;

const evidenceClassSchema = z
  .enum([
    "MOPSFIN_RAW",
    "MOPSFIN_CALC",
    "OFFICIAL_MASTER_RAW",
    "OFFICIAL_MARKET_RAW",
    "OFFICIAL_CALC",
    "MIXED_OFFICIAL_CALC",
    "CALLER_ASSUMPTION",
    "MODEL_OUTPUT",
    "EXTERNAL_EXPECTATION",
    "UNAVAILABLE",
  ])
  .describe("原值、計算、caller assumption、模型輸出或不可用資料的證據類別");

const sourceEvidenceClassSchema = evidenceClassSchema.exclude([
  "CALLER_ASSUMPTION",
  "MODEL_OUTPUT",
  "UNAVAILABLE",
]);

const modelEvidenceUnitSchema = z
  .enum([
    "TWD",
    "TWD_per_share",
    "share",
    "percent",
    "ratio",
    "year",
    "date",
    "category",
    "boolean",
  ])
  .describe("evidence value 的明示單位");

const inputFactEvidenceSchema = z
  .object({
    id: z.string().min(1).describe("engine normalized fact 的穩定 ID"),
    value: z.union([z.number().finite(), z.string(), z.boolean()]).describe("模型實際使用的 normalized fact value"),
    unit: modelEvidenceUnitSchema,
    formula: z.null().describe("直接 normalized fact 不使用模型公式"),
    evidenceClass: sourceEvidenceClassSchema.describe(
      "此 normalized input fact 沿用的官方／Mopsfin evidence class",
    ),
    lineageIds: z.array(z.string().min(1)).min(1).describe("指向 normalizedInputEvidence.factMappings 的 mapping IDs"),
  })
  .strict()
  .describe("模型實際使用的官方／Mopsfin normalized fact evidence");

const callerAssumptionEvidenceSchema = z
  .object({
    id: z.string().min(1).describe("caller assumption 的穩定 ID"),
    value: z.union([z.number().finite(), z.string(), z.boolean()]).describe("caller 明示值"),
    unit: modelEvidenceUnitSchema,
    formula: z.null().describe("caller assumption 沒有模型推導公式"),
    evidenceClass: z.literal("CALLER_ASSUMPTION").describe("固定標示 caller assumption"),
    lineageIds: z.array(z.never()).length(0).describe("caller assumption 不冒充 upstream lineage"),
  })
  .strict()
  .describe("caller 明示且可與 raw／calculated facts 分離的假設 evidence");

const modelOutputEvidenceSchema = z
  .object({
    id: z.string().min(1).describe("model output 的穩定 ID"),
    value: z.union([z.number().finite(), z.string(), z.boolean()]).describe("可由 inputs 與 formula 重算的 model output"),
    unit: modelEvidenceUnitSchema,
    formula: z.string().min(1).describe("模型輸出計算公式"),
    evidenceClass: z.literal("MODEL_OUTPUT").describe("固定標示 deterministic model output"),
    lineageIds: z.array(z.never()).length(0).describe("模型輸出不冒充 raw source lineage"),
  })
  .strict()
  .describe("由 deterministic reverse DCF 公式產生且不冒充來源資料的 model-output evidence");

const forecastPeriodSchema = z
  .object({
    year: z.number().int().positive().describe("由 1 起算的 forecast year"),
    revenueTwd: z.number().finite().nullable().describe("forecast revenue；FCFF CAGR mode 為 null"),
    revenueGrowthPercent: finitePercentSchema.nullable().describe("forecast revenue growth；FCFF CAGR mode 為 null"),
    operatingMarginPercent: finitePercentSchema.nullable().describe("forecast operating margin；FCFF CAGR mode 為 null"),
    ebitTwd: z.number().finite().nullable().describe("forecast EBIT proxy；FCFF CAGR mode 為 null"),
    cashTaxesTwd: z.number().finite().nullable().describe("forecast cash taxes；FCFF CAGR mode 為 null"),
    reinvestmentTwd: z.number().finite().nullable().describe("forecast reinvestment；FCFF CAGR mode 為 null"),
    fcffTwd: z.number().finite().describe("forecast FCFF"),
    discountPeriodYears: z.number().int().positive().describe("year-end discount period"),
    presentValueFactor: z.number().finite().positive().describe("1/(1+WACC)^year"),
    presentValueFcffTwd: z.number().finite().describe("forecast FCFF present value"),
  })
  .strict()
  .describe("單一 forecast year 的 operating drivers、FCFF 與 year-end present value");

const terminalValueSchema = z
  .object({
    method: z.literal("perpetuity_growth").describe("固定 perpetuity-growth terminal value"),
    terminalRevenueTwd: z.number().finite().nullable().describe("terminal-period revenue；FCFF CAGR mode 為 null"),
    terminalOperatingMarginPercent: finitePercentSchema.nullable().describe("terminal operating margin；FCFF CAGR mode 為 null"),
    terminalEbitTwd: z.number().finite().nullable().describe("terminal EBIT；FCFF CAGR mode 為 null"),
    terminalCashTaxesTwd: z.number().finite().nullable().describe("terminal cash taxes；FCFF CAGR mode 為 null"),
    terminalReinvestmentTwd: z.number().finite().nullable().describe("terminal reinvestment；FCFF CAGR mode 為 null"),
    terminalFcffTwd: z.number().finite().positive().describe("perpetuity formula 使用的正值 terminal FCFF"),
    waccPercent: finitePercentSchema.positive().describe("terminal value 使用的 WACC"),
    terminalGrowthPercent: finitePercentSchema.describe("terminal value 使用的永續成長率"),
    undiscountedTerminalValueTwd: z.number().finite().positive().describe("terminal FCFF/(WACC-g)"),
    discountPeriodYears: z.number().int().positive().describe("terminal value 折現至 present 的 forecast horizon"),
    presentValueFactor: z.number().finite().positive().describe("terminal value 的 year-end present-value factor"),
    presentValueTerminalTwd: z.number().finite().positive().describe("terminal value present value"),
    presentValueTerminalPercentOfEnterpriseValue: finitePercentSchema.nullable().describe("terminal PV 佔 modeled EV 百分比；EV 為 0 時 null"),
    formula: z.literal("terminal_fcff_divided_by_wacc_minus_terminal_growth").describe("terminal-value 固定公式識別碼"),
  })
  .strict()
  .describe("可由 terminal FCFF、WACC、growth 與 year-end discount convention 重算的 perpetuity terminal value");

const bridgeSchema = z
  .object({
    observedPricePerShareTwd: z.number().finite().positive().describe("官方最近完成交易日收盤價"),
    observedPriceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("官方 close 完成交易日"),
    sharesOutstanding: z.number().finite().positive().describe("current-master issued common shares"),
    shareCountBasis: z.literal("issued_common_shares").describe("此 orchestration 固定使用 issued common shares，非 diluted shares"),
    observedEquityValueTwd: z.number().finite().positive().describe("close × issued shares"),
    plusInterestBearingDebtTwd: z.number().finite().nonnegative().describe("normalized aggregate interest-bearing debt，已含 exact lease roles"),
    plusLeaseLiabilitiesTwd: z.literal(0).describe("防止 aggregate debt 中 lease roles 被 double counted 的 bridge normalization；不表示租賃負債為零"),
    plusNonControllingInterestsTwd: z.number().finite().nonnegative().describe("caller 明示 NCI"),
    plusPreferredEquityTwd: z.number().finite().nonnegative().describe("caller 明示 preferred equity"),
    plusPensionDeficitTwd: z.number().finite().nonnegative().describe("caller 明示 pension deficit"),
    plusOtherDebtLikeItemsTwd: z.number().finite().nonnegative().describe("caller 明示其他 debt-like claims"),
    lessCashAndCashEquivalentsTwd: z.number().finite().nonnegative().describe("normalized cash and cash equivalents"),
    lessNonOperatingAssetsTwd: z.number().finite().nonnegative().describe("caller 明示 non-operating assets"),
    targetEnterpriseValueTwd: z.number().finite().positive().describe("由官方 close 與顯性 bridge 算得的 market-implied target EV"),
    formula: z.literal("observed_equity_value_plus_debt_like_claims_minus_cash_and_non_operating_assets").describe("EV bridge 固定公式識別碼"),
  })
  .strict()
  .describe("由 official completed close、issued shares、normalized debt/cash 與 caller claims 建立的 target EV bridge");

const presentValueSchema = z
  .object({
    explicitForecastTwd: z.number().finite().describe("explicit forecast FCFF present value 合計"),
    terminalValueTwd: z.number().finite().describe("terminal value present value"),
    modeledEnterpriseValueTwd: z.number().finite().describe("explicit forecast PV + terminal PV"),
    targetEnterpriseValueTwd: z.number().finite().positive().describe("market-price EV bridge target"),
    residualTwd: z.number().finite().describe("modeled EV - target EV；收斂時接近 0"),
  })
  .strict()
  .describe("explicit forecast、terminal 與 target EV 的 present-value tie-out");

const solverPolicySchema = z
  .object({
    algorithm: z.literal("deterministic_bisection").describe("固定 deterministic bisection"),
    monotonicSampleIntervals: z.literal(64).describe("solve range monotonic QA sampling intervals"),
    maximumIterations: z.literal(256).describe("bisection 最大迭代數"),
    enterpriseValueRelativeTolerance: z.literal(1e-12).describe("EV relative tolerance"),
    enterpriseValueAbsoluteToleranceTwd: z.literal(0.01).describe("EV absolute tolerance，TWD"),
  })
  .strict()
  .describe("固定、可重現且只以 EV absolute／relative residual 判定收斂的 iteration／tolerance policy");

const solutionSchema = z
  .object({
    solveFor: z.enum(["revenue_cagr", "fcff_cagr", "terminal_operating_margin"]).describe("本次唯一反解變數"),
    solvedValuePercent: finitePercentSchema.describe("在 caller solve range 內反解出的市場隱含百分比"),
    solveRange: z.object({ minimumPercent: finitePercentSchema, maximumPercent: finitePercentSchema }).strict().describe("engine 使用的 caller bracket"),
    monotonicDirection: z.enum(["increasing", "decreasing"]).describe("solve range 內 modeled EV 的驗證方向"),
    iterations: z.number().int().nonnegative().max(256).describe("deterministic bisection 實際迭代數"),
    converged: z.literal(true).describe("只有完成收斂才回成功結果"),
    lowerEndpointModeledEnterpriseValueTwd: z.number().finite().describe("bracket 下界 modeled EV"),
    upperEndpointModeledEnterpriseValueTwd: z.number().finite().describe("bracket 上界 modeled EV"),
    targetEnterpriseValueTwd: z.number().finite().positive().describe("market bridge target EV"),
    residualTwd: z.number().finite().describe("解點 modeled EV 與 target EV 殘差"),
    modeFormula: z.enum([
      "constant_revenue_cagr_with_constant_normalized_margin_cash_tax_and_delta_revenue_over_sales_to_capital",
      "constant_compounded_fcff_cagr",
      "caller_revenue_cagr_with_linear_margin_transition_cash_tax_and_delta_revenue_over_sales_to_capital",
    ]).describe("solve mode 的穩定計算口徑識別碼"),
    solverPolicy: solverPolicySchema,
  })
  .strict()
  .describe("caller bracket 內完成 monotonic QA 與 deterministic bisection 的單一反解結果");

const sensitivityCellSchema = z
  .object({
    waccPercent: finitePercentSchema.describe("此 cell 的 caller WACC"),
    terminalGrowthPercent: finitePercentSchema.describe("此 cell 的 caller terminal growth"),
    status: z.enum([
      "solved",
      "no_feasible_solution",
      "non_monotonic_solve_range",
      "unidentifiable_solve_range",
      "terminal_value_not_viable",
    ]).describe("此 sensitivity cell 是否能在相同 caller bracket 內求解"),
    solvedValuePercent: finitePercentSchema.nullable().describe("solved cell 的反解值；失敗時 null"),
    modeledEnterpriseValueTwd: z.number().finite().nullable().describe("solved cell 的 modeled EV；失敗時 null"),
    residualTwd: z.number().finite().nullable().describe("solved cell 殘差；失敗時 null"),
    errorCode: z.enum([
      "NO_FEASIBLE_SOLUTION",
      "NON_MONOTONIC_SOLVE_RANGE",
      "UNIDENTIFIABLE_SOLVE_RANGE",
      "TERMINAL_VALUE_NOT_VIABLE",
    ]).nullable().describe("失敗 cell 的穩定 model error；solved 時 null"),
  })
  .strict()
  .superRefine((cell, context) => {
    const solved = cell.status === "solved";
    for (const key of ["solvedValuePercent", "modeledEnterpriseValueTwd", "residualTwd"] as const) {
      if (solved !== (cell[key] !== null)) {
        context.addIssue({ code: "custom", path: [key], message: solved ? "solved cell 必須有值" : "failed cell 必須為 null" });
      }
    }
    if (solved !== (cell.errorCode === null)) {
      context.addIssue({ code: "custom", path: ["errorCode"], message: solved ? "solved cell errorCode 必須為 null" : "failed cell 必須提供 errorCode" });
    }
  })
  .describe("一個 caller 指定 WACC × terminal-growth cell 的獨立反解結果或穩定失敗狀態");

const checkSchema = z
  .object({
    id: z.enum([
      "non_financial_fcff_scope",
      "wacc_above_terminal_growth",
      "enterprise_to_equity_bridge_tie_out",
      "terminal_value_discounted_at_forecast_horizon",
      "market_enterprise_value_solve_tie_out",
      "solve_range_monotonic",
    ]).describe("deterministic QA check ID"),
    status: z.literal("pass").describe("成功結果只包含通過的必要 checks"),
    value: z.union([z.number().finite(), z.boolean(), z.string()]).describe("check 的可稽核值"),
    tolerance: z.number().finite().nonnegative().nullable().describe("數值 check tolerance；分類 check 為 null"),
  })
  .strict()
  .describe("成功 reverse DCF result 中一項必要且已通過的 deterministic QA check");

const reverseDcfModelSchema = z
  .object({
    modelVersion: z.literal(REVERSE_DCF_MODEL_VERSION).describe("deterministic reverse DCF 模型版本"),
    modelType: z.literal("market_implied_reverse_dcf").describe("以市場價格反解單一假設，不是 target-price DCF"),
    cashFlowBasis: z.literal("fcff").describe("現金流口徑固定 FCFF"),
    discountRateBasis: z.literal("wacc").describe("FCFF 只以 WACC 折現"),
    discountConvention: z.literal("year_end").describe("explicit forecast 與 terminal value 採 year-end discount convention"),
    currency: z.literal("TWD").describe("所有金額固定 TWD"),
    posture: z.literal("research_model_output_not_investment_advice").describe("研究模型輸出，不是投資建議"),
    company: z
      .object({
        companyCode: z.string().regex(/^\d{4}$/).describe("公司代號"),
        isFinancial: z
          .literal(false)
          .describe("一般企業 FCFF 模型只接受非金融公司"),
      })
      .strict()
      .describe("通過 current-master identity 與非金融業 applicability gate 的公司"),
    solution: solutionSchema,
    forecast: z.array(forecastPeriodSchema).min(1).max(20).describe("逐年可重算 FCFF forecast"),
    terminal: terminalValueSchema,
    bridge: bridgeSchema,
    presentValue: presentValueSchema,
    evidence: z
      .object({
        inputFacts: z.array(inputFactEvidenceSchema).describe("官方／Mopsfin normalized input facts"),
        assumptions: z.array(callerAssumptionEvidenceSchema).describe("全部 caller assumptions，不能藏預設"),
        modelOutputs: z.array(modelOutputEvidenceSchema).describe("deterministic model outputs 與公式"),
      })
      .strict()
      .describe("分離 normalized facts、caller assumptions 與 model outputs 的完整證據分類"),
    sensitivities: z.array(sensitivityCellSchema).max(25).describe("caller 明示 grid 的逐 cell 結果；沒有 grid 時空陣列"),
    checks: z.array(checkSchema).describe("成功前通過的 deterministic QA checks"),
    limitations: z.tuple([
      z.literal("market_implied_result_depends_on_caller_provided_facts_and_assumptions"),
      z.literal("not_consensus_not_target_price_not_investment_advice"),
      z.literal("fcff_discounted_only_at_wacc_and_bridged_from_enterprise_to_equity_value"),
    ]).describe("固定模型限制，避免把市場隱含輸出解讀為目標價或建議"),
  })
  .strict()
  .superRefine((model, context) => {
    if (model.solution.solveFor === "fcff_cagr") {
      for (const [index, row] of model.forecast.entries()) {
        if (
          row.revenueTwd !== null ||
          row.revenueGrowthPercent !== null ||
          row.operatingMarginPercent !== null ||
          row.ebitTwd !== null ||
          row.cashTaxesTwd !== null ||
          row.reinvestmentTwd !== null
        ) {
          context.addIssue({ code: "custom", path: ["forecast", index], message: "FCFF CAGR mode 不得虛構 revenue/margin components" });
        }
      }
    }
  })
  .describe("完整 market-implied FCFF reverse DCF engine output，含 forecast、terminal、EV bridge、evidence 與 QA checks");

const mappingSchema = z
  .object({
    mappingId: z.string().min(1).describe("model evidence lineageIds 指向的 adapter mapping ID"),
    engineFactId: z.string().min(1).describe("此 mapping 對應的 engine fact ID"),
    evidenceClass: sourceEvidenceClassSchema.describe("沿用 upstream normalized OFFICIAL/MOPSFIN evidence class"),
    origin: z.enum([
      "valuation_model_field",
      "valuation_model_company_identity",
      "valuation_model_source_date",
      "aggregate_debt_bridge_normalization",
    ]).describe("normalized fact 的精確來源／轉換類型"),
    originFieldIds: z.array(valuationModelInputsDataSchema.shape.quality.shape.dataGapFields.element).describe("使用的 normalized valuation-model field IDs；公司 identity 可為空"),
    upstreamLineageIds: z.array(z.string().min(1)).describe("回指 valuation-model lineageLedger 的 IDs"),
    sourceIds: z.array(z.string().min(1)).describe("回指 sourceLedger 的 official source IDs"),
    transformation: z.string().min(1).nullable().describe("adapter transformation；直接取值時 null"),
    notes: z.array(z.string().min(1)).describe("口徑或 double-count 防護說明"),
  })
  .strict()
  .describe("engine fact 到 normalized valuation-model field、row lineage 與 official source 的 adapter mapping");

const reverseDcfDataBaseSchema = z
  .object({
    query: reverseDcfInputSchema.describe("完整 echo caller inputs，確保沒有隱藏假設"),
    generatedAt: z.string().regex(strictIsoInstantPattern).describe("完成 normalized-input orchestration 與 deterministic model 計算的 strict ISO UTC 時間"),
    timezone: z.literal("Asia/Taipei").describe("官方 close 與公司資料日期的解讀時區"),
    currency: z.literal("TWD").describe("模型金額幣別"),
    scope: z.literal("market_implied_reverse_dcf").describe("市場隱含單一變數 reverse DCF"),
    posture: z.literal("research_model_output_not_investment_advice").describe("研究模型，不輸出買賣建議或評級"),
    company: valuationModelInputsDataSchema.shape.company.describe("current-master 核對後的公司 identity"),
    model: reverseDcfModelSchema,
    normalizedInputEvidence: z
      .object({
        valuationModelGeneratedAt: z.string().regex(strictIsoInstantPattern).describe("normalized valuation-model inputs 的 strict ISO UTC 生成時間"),
        usedFieldIds: z.array(valuationModelInputsDataSchema.shape.quality.shape.dataGapFields.element).min(5).describe("本 solve mode 實際讀取的 normalized valuation-model fields"),
        fields: valuationModelInputsDataSchema.shape.fields.describe("完整 normalized valuation-model field snapshot；usedFieldIds 指出實際使用欄位"),
        periods: valuationModelInputsDataSchema.shape.periods.describe("valuation-model TTM period 與 consolidation-scope 證據"),
        factMappings: z.array(mappingSchema).min(9).describe("engine fact 到 normalized valuation-model fields／lineage／sources 的可重算 mapping ledger"),
        lineageLedger: valuationModelInputsDataSchema.shape.lineage.describe("valuation-model 原始 row-role lineage ledger"),
        sourceLedger: valuationModelInputsDataSchema.shape.sources.describe("normalized valuation-model 官方／Mopsfin source ledger，保留 retrievedAt 與 cache provenance"),
      })
      .strict()
      .describe("本次模型使用的 normalized valuation-model field snapshot、fact mappings、row lineage 與 source ledger"),
    sources: valuationModelInputsDataSchema.shape.sources.describe(
      "供共用 MCP result-contract 產生 sourceCutoffs 的 top-level sources；必須與 normalizedInputEvidence.sourceLedger 完全一致",
    ),
    workBudget: z
      .object({
        valuationModelInputCalls: z
          .object({
            actual: z.literal(1).describe("本次 normalized valuation-model orchestration 實際呼叫數"),
            maximum: z.literal(1).describe("單公司硬上限"),
          })
          .strict()
          .describe("normalized valuation-input orchestration call budget"),
        valuationModelInputs: valuationModelInputsDataSchema.shape.workBudget.describe("normalized valuation-model input 的完整 bounded dependency budget"),
        reverseDcfEngineOrchestrations: z
          .object({
            actual: z.literal(1).describe("deterministic engine 實際執行一次"),
            maximum: z.literal(1).describe("主模型 engine call 硬上限；sensitivity 由同一 engine orchestration 內 bounded cells 計算"),
          })
          .strict()
          .describe("主 reverse DCF engine invocation budget"),
        sensitivityCells: z
          .object({
            requested: z.number().int().min(0).max(25).describe("caller grid 實際 requested cells"),
            maximum: z.literal(25).describe("public MCP sensitivity cells 硬上限"),
          })
          .strict()
          .describe("bounded sensitivity cell budget"),
        solveAttempts: z
          .object({
            actual: z.number().int().min(1).max(26).describe("主解一次加上每個 sensitivity cell 各一次的 solve attempts"),
            maximum: z.literal(26).describe("主解 1 次 + 最多 25 sensitivity cells"),
          })
          .strict()
          .describe("deterministic solver attempts 的 bounded budget"),
        modelEvaluationUpperBound: z
          .object({
            perSolveAttempt: z.literal(323).describe("每次 solve 的 65 monotonic samples + 2 endpoints + 最多 256 bisection evaluations"),
            forRequestedWork: z.number().int().min(323).max(8398).describe("依本次 1 + sensitivity cells 計算的 worst-case model evaluations"),
            maximum: z.literal(8398).describe("26 solve attempts × 每次最多 323 model evaluations"),
          })
          .strict()
          .describe("不是實際耗用值，而是固定 solver policy 下的 deterministic evaluation upper bound"),
      })
      .strict()
      .describe("normalized input dependencies、主模型與 sensitivity 的 bounded work budget"),
    warnings: z.array(z.string().min(1)).min(5).describe("來源、股數、lease double-count、caller assumptions 與非投資建議警語"),
  })
  .strict()
  .describe("可由 normalized valuation-model source lineage、caller assumptions 與 deterministic formulas 完整重算的 reverse DCF result");

type ReverseDcfData = z.infer<typeof reverseDcfDataBaseSchema>;

type ReverseDcfUsedFieldId =
  | "cashAndCashEquivalents"
  | "interestBearingDebt"
  | "issuedShares"
  | "latestOfficialClose"
  | "normalizedFcff"
  | "ttmRevenue"
  | "ttmOperatingIncomeEbitProxy";

function validateReverseDcfData(
  result: ReverseDcfData,
  context: z.RefinementCtx,
): void {
    const approximatelyEqual = (left: number, right: number): boolean => {
      const tolerance = Math.max(0.01, Math.abs(right) * 1e-12);
      return Math.abs(left - right) <= tolerance;
    };
    if (result.company.code !== result.query.company_code || result.model.company.companyCode !== result.query.company_code) {
      context.addIssue({ code: "custom", path: ["company", "code"], message: "query、company 與 model company_code 必須一致" });
    }
    if (result.model.solution.solveFor !== result.query.solve_for) {
      context.addIssue({ code: "custom", path: ["model", "solution", "solveFor"], message: "model solveFor 必須與 query solve_for 一致" });
    }
    if (result.model.forecast.length !== result.query.forecast_years) {
      context.addIssue({ code: "custom", path: ["model", "forecast"], message: "forecast rows 必須等於 forecast_years" });
    }
    if (result.company.isFinancial !== false) {
      context.addIssue({ code: "custom", path: ["company", "isFinancial"], message: "一般企業 FCFF reverse DCF 的 company.isFinancial 必須為 false" });
    }
    if (
      result.model.terminal.waccPercent !== result.query.wacc_percent ||
      result.model.terminal.terminalGrowthPercent !==
        result.query.terminal_growth_percent
    ) {
      context.addIssue({ code: "custom", path: ["model", "terminal"], message: "model terminal WACC/g 必須與 caller query 完全一致" });
    }
    if (
      result.model.solution.solveRange.minimumPercent !==
        result.query.solve_range.minimum_percent ||
      result.model.solution.solveRange.maximumPercent !==
        result.query.solve_range.maximum_percent
    ) {
      context.addIssue({ code: "custom", path: ["model", "solution", "solveRange"], message: "engine solve range 必須與 caller query 完全一致" });
    }
    const bridgeAssumptions = result.query.enterprise_value_bridge;
    const bridge = result.model.bridge;
    if (
      bridge.lessNonOperatingAssetsTwd !==
        bridgeAssumptions.non_operating_assets_twd ||
      bridge.plusNonControllingInterestsTwd !==
        bridgeAssumptions.non_controlling_interests_twd ||
      bridge.plusPreferredEquityTwd !== bridgeAssumptions.preferred_equity_twd ||
      bridge.plusPensionDeficitTwd !== bridgeAssumptions.pension_deficit_twd ||
      bridge.plusOtherDebtLikeItemsTwd !==
        bridgeAssumptions.other_debt_like_items_twd
    ) {
      context.addIssue({ code: "custom", path: ["model", "bridge"], message: "model EV bridge 的 caller-supplied values 必須與 query 完全一致" });
    }
    const normalizedFields = result.normalizedInputEvidence.fields;
    if (
      bridge.observedPricePerShareTwd !==
        normalizedFields.latestOfficialClose.value ||
      bridge.sharesOutstanding !== normalizedFields.issuedShares.value ||
      bridge.lessCashAndCashEquivalentsTwd !==
        normalizedFields.cashAndCashEquivalents.value ||
      bridge.plusInterestBearingDebtTwd !==
        normalizedFields.interestBearingDebt.value
    ) {
      context.addIssue({ code: "custom", path: ["model", "bridge"], message: "official price/shares/cash/aggregate debt 必須與 normalized valuation-model fields 完全一致" });
    }
    const expectedEquityValue =
      bridge.observedPricePerShareTwd * bridge.sharesOutstanding;
    const expectedTargetEnterpriseValue =
      expectedEquityValue +
      bridge.plusInterestBearingDebtTwd +
      bridge.plusLeaseLiabilitiesTwd +
      bridge.plusNonControllingInterestsTwd +
      bridge.plusPreferredEquityTwd +
      bridge.plusPensionDeficitTwd +
      bridge.plusOtherDebtLikeItemsTwd -
      bridge.lessCashAndCashEquivalentsTwd -
      bridge.lessNonOperatingAssetsTwd;
    if (
      !approximatelyEqual(bridge.observedEquityValueTwd, expectedEquityValue) ||
      !approximatelyEqual(
        bridge.targetEnterpriseValueTwd,
        expectedTargetEnterpriseValue,
      )
    ) {
      context.addIssue({ code: "custom", path: ["model", "bridge"], message: "observed equity value 與 target EV 必須依揭露公式精確 tie out" });
    }
    if (
      result.query.solve_for !== "fcff_cagr" &&
      (normalizedFields.ttmRevenue.value === null ||
        normalizedFields.ttmRevenue.value <= 0)
    ) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "fields", "ttmRevenue"], message: "revenue／terminal-margin mode 的 base TTM revenue 必須大於 0" });
    }
    const expectedUsedFieldIds: ReverseDcfUsedFieldId[] = [
      "cashAndCashEquivalents",
      "interestBearingDebt",
      "issuedShares",
      "latestOfficialClose",
      ...(result.query.solve_for === "fcff_cagr"
        ? ["normalizedFcff" as const]
        : result.query.solve_for === "revenue_cagr"
          ? ["ttmRevenue" as const]
          : [
              "ttmRevenue" as const,
              "ttmOperatingIncomeEbitProxy" as const,
            ]),
    ];
    if (
      JSON.stringify(result.normalizedInputEvidence.usedFieldIds) !==
      JSON.stringify(expectedUsedFieldIds)
    ) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "usedFieldIds"], message: "usedFieldIds 必須精確對應 solve mode 的必要 normalized valuation-model fields" });
    }
    for (const fieldId of expectedUsedFieldIds) {
      const field = normalizedFields[fieldId];
      if (
        field.value === null ||
        (field.status !== "reported" && field.status !== "derived") ||
        field.evidenceClass === "UNAVAILABLE"
      ) {
        context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "fields", fieldId], message: "每個 used field 都必須有 reported／derived value 與可用 evidence class" });
      }
    }
    const expectedFieldSemantics = {
      cashAndCashEquivalents: ["TWD", "reported", "MOPSFIN_RAW"],
      interestBearingDebt: ["TWD", "derived", "MOPSFIN_CALC"],
      issuedShares: ["share", "reported", "OFFICIAL_MASTER_RAW"],
      latestOfficialClose: [
        "TWD_per_share",
        "reported",
        "OFFICIAL_MARKET_RAW",
      ],
      normalizedFcff: ["TWD", "derived", "MOPSFIN_CALC"],
      ttmRevenue: ["TWD", "derived", "MOPSFIN_CALC"],
      ttmOperatingIncomeEbitProxy: ["TWD", "derived", "MOPSFIN_CALC"],
    } as const;
    for (const fieldId of expectedUsedFieldIds) {
      const field = normalizedFields[fieldId];
      const semantic = expectedFieldSemantics[fieldId];
      if (
        field.id !== fieldId ||
        field.unit !== semantic[0] ||
        field.status !== semantic[1] ||
        field.evidenceClass !== semantic[2] ||
        field.inputLineageIds.length === 0
      ) {
        context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "fields", fieldId], message: "used field 的 id/unit/status/evidenceClass/lineage 必須符合穩定 semantic contract" });
      }
    }
    const expectedCells = result.query.sensitivity_grids
      ? result.query.sensitivity_grids.wacc_percent.length * result.query.sensitivity_grids.terminal_growth_percent.length
      : 0;
    if (result.workBudget.sensitivityCells.requested !== expectedCells || result.model.sensitivities.length !== expectedCells) {
      context.addIssue({ code: "custom", path: ["workBudget", "sensitivityCells", "requested"], message: "requested、grid cells 與 sensitivity outputs 必須一致" });
    }
    const expectedSolveAttempts = 1 + expectedCells;
    const expectedEvaluationUpperBound = 323 * expectedSolveAttempts;
    if (
      result.workBudget.solveAttempts.actual !== expectedSolveAttempts ||
      result.workBudget.modelEvaluationUpperBound.forRequestedWork !==
        expectedEvaluationUpperBound
    ) {
      context.addIssue({ code: "custom", path: ["workBudget"], message: "solve attempts 必須為 1 + sensitivity cells，evaluation upper bound 必須為 323 × attempts" });
    }
    const presentValue = result.model.presentValue;
    const explicitForecastTwd = result.model.forecast.reduce(
      (sum, row) => sum + row.presentValueFcffTwd,
      0,
    );
    if (
      !approximatelyEqual(presentValue.explicitForecastTwd, explicitForecastTwd) ||
      !approximatelyEqual(
        presentValue.terminalValueTwd,
        result.model.terminal.presentValueTerminalTwd,
      ) ||
      !approximatelyEqual(
        presentValue.modeledEnterpriseValueTwd,
        presentValue.explicitForecastTwd + presentValue.terminalValueTwd,
      ) ||
      !approximatelyEqual(
        presentValue.targetEnterpriseValueTwd,
        bridge.targetEnterpriseValueTwd,
      ) ||
      !approximatelyEqual(
        presentValue.residualTwd,
        presentValue.modeledEnterpriseValueTwd -
          presentValue.targetEnterpriseValueTwd,
      ) ||
      !approximatelyEqual(
        result.model.solution.targetEnterpriseValueTwd,
        bridge.targetEnterpriseValueTwd,
      ) ||
      !approximatelyEqual(
        result.model.solution.residualTwd,
        presentValue.residualTwd,
      )
    ) {
      context.addIssue({ code: "custom", path: ["model", "presentValue"], message: "forecast PV、terminal PV、modeled EV、target EV 與 residual 必須完整 tie out" });
    }
    const wacc = result.query.wacc_percent / 100;
    const terminalGrowth = result.query.terminal_growth_percent / 100;
    for (const [index, row] of result.model.forecast.entries()) {
      const expectedYear = index + 1;
      const expectedFactor = 1 / Math.pow(1 + wacc, expectedYear);
      if (
        row.year !== expectedYear ||
        row.discountPeriodYears !== expectedYear ||
        !approximatelyEqual(row.presentValueFactor, expectedFactor) ||
        !approximatelyEqual(
          row.presentValueFcffTwd,
          row.fcffTwd * row.presentValueFactor,
        )
      ) {
        context.addIssue({ code: "custom", path: ["model", "forecast", index], message: "forecast years 必須連續，並依 year-end WACC factor 精確折現 FCFF" });
      }
    }
    const terminal = result.model.terminal;
    const expectedTerminalFactor =
      1 / Math.pow(1 + wacc, result.query.forecast_years);
    const expectedUndiscountedTerminal =
      terminal.terminalFcffTwd / (wacc - terminalGrowth);
    if (
      terminal.discountPeriodYears !== result.query.forecast_years ||
      !approximatelyEqual(terminal.presentValueFactor, expectedTerminalFactor) ||
      !approximatelyEqual(
        terminal.undiscountedTerminalValueTwd,
        expectedUndiscountedTerminal,
      ) ||
      !approximatelyEqual(
        terminal.presentValueTerminalTwd,
        terminal.undiscountedTerminalValueTwd * terminal.presentValueFactor,
      )
    ) {
      context.addIssue({ code: "custom", path: ["model", "terminal"], message: "terminal value 必須以 caller WACC/g 與 forecast horizon 的 year-end factor 精確 tie out" });
    }
    if (
      result.model.solution.solvedValuePercent <
        result.query.solve_range.minimum_percent ||
      result.model.solution.solvedValuePercent >
        result.query.solve_range.maximum_percent
    ) {
      context.addIssue({ code: "custom", path: ["model", "solution", "solvedValuePercent"], message: "solved value 必須位於 caller-provided solve range 內" });
    }
    const expectedCheckIds = [
      "non_financial_fcff_scope",
      "wacc_above_terminal_growth",
      "enterprise_to_equity_bridge_tie_out",
      "terminal_value_discounted_at_forecast_horizon",
      "market_enterprise_value_solve_tie_out",
      "solve_range_monotonic",
    ] as const;
    const checkIds = result.model.checks.map((check) => check.id);
    if (
      JSON.stringify(checkIds) !== JSON.stringify(expectedCheckIds) ||
      new Set(checkIds).size !== expectedCheckIds.length
    ) {
      context.addIssue({ code: "custom", path: ["model", "checks"], message: "checks 必須包含六個穩定 IDs，且維持 engine 定義順序並各出現一次" });
    } else {
      const [
        nonFinancialCheck,
        rateCheck,
        bridgeCheck,
        terminalDiscountCheck,
        marketResidualCheck,
        monotonicCheck,
      ] = result.model.checks;
      const bridgeResidual =
        bridge.targetEnterpriseValueTwd - expectedTargetEnterpriseValue;
      const terminalDiscountResidual =
        terminal.presentValueFactor - expectedTerminalFactor;
      const marketTolerance = Math.max(
        0.01,
        Math.abs(bridge.targetEnterpriseValueTwd) * 1e-12,
      );
      const validBoundedResidual = (
        check: (typeof result.model.checks)[number],
        expectedValue: number,
        expectedTolerance: number,
      ): boolean =>
        typeof check.value === "number" &&
        check.tolerance === expectedTolerance &&
        approximatelyEqual(check.value, expectedValue) &&
        Math.abs(check.value) <= expectedTolerance;
      if (
        nonFinancialCheck?.value !== true ||
        nonFinancialCheck.tolerance !== null ||
        typeof rateCheck?.value !== "number" ||
        rateCheck.value !==
          result.query.wacc_percent - result.query.terminal_growth_percent ||
        rateCheck.value <= 0 ||
        rateCheck.tolerance !== 0 ||
        !bridgeCheck ||
        !validBoundedResidual(bridgeCheck, bridgeResidual, 0.01) ||
        !terminalDiscountCheck ||
        !validBoundedResidual(
          terminalDiscountCheck,
          terminalDiscountResidual,
          Number.EPSILON,
        ) ||
        !marketResidualCheck ||
        !validBoundedResidual(
          marketResidualCheck,
          presentValue.residualTwd,
          marketTolerance,
        ) ||
        monotonicCheck?.value !==
          result.model.solution.monotonicDirection ||
        monotonicCheck.tolerance !== null
      ) {
        context.addIssue({ code: "custom", path: ["model", "checks"], message: "check values/tolerances 必須與 nonfinancial、WACC-g、bridge、terminal discount、market residual 與 monotonic solution 證據精確一致" });
      }
    }
    const expectedSensitivityCells = result.query.sensitivity_grids
      ? result.query.sensitivity_grids.wacc_percent.flatMap((waccPercent) =>
          result.query.sensitivity_grids?.terminal_growth_percent.map(
            (terminalGrowthPercent) => ({
              waccPercent,
              terminalGrowthPercent,
            }),
          ) ?? [],
        )
      : [];
    const sensitivityErrorByStatus = {
      no_feasible_solution: "NO_FEASIBLE_SOLUTION",
      non_monotonic_solve_range: "NON_MONOTONIC_SOLVE_RANGE",
      unidentifiable_solve_range: "UNIDENTIFIABLE_SOLVE_RANGE",
      terminal_value_not_viable: "TERMINAL_VALUE_NOT_VIABLE",
    } as const;
    for (const [index, cell] of result.model.sensitivities.entries()) {
      const expectedCell = expectedSensitivityCells[index];
      const expectedError =
        cell.status === "solved"
          ? null
          : sensitivityErrorByStatus[cell.status];
      if (
        !expectedCell ||
        cell.waccPercent !== expectedCell.waccPercent ||
        cell.terminalGrowthPercent !== expectedCell.terminalGrowthPercent ||
        cell.errorCode !== expectedError
      ) {
        context.addIssue({ code: "custom", path: ["model", "sensitivities", index], message: "sensitivity cells 必須按 caller WACC outer × growth inner 的 Cartesian order，且 status/errorCode 精確對應" });
      }
      if (cell.status === "solved") {
        const solvedValuePercent = cell.solvedValuePercent;
        const modeledEnterpriseValueTwd = cell.modeledEnterpriseValueTwd;
        const residualTwd = cell.residualTwd;
        const sensitivityTolerance = Math.max(
          result.model.solution.solverPolicy.enterpriseValueAbsoluteToleranceTwd,
          Math.abs(bridge.targetEnterpriseValueTwd) *
            result.model.solution.solverPolicy.enterpriseValueRelativeTolerance,
        );
        if (
          solvedValuePercent === null ||
          modeledEnterpriseValueTwd === null ||
          residualTwd === null ||
          solvedValuePercent < result.query.solve_range.minimum_percent ||
          solvedValuePercent > result.query.solve_range.maximum_percent ||
          !approximatelyEqual(
            residualTwd,
            modeledEnterpriseValueTwd - bridge.targetEnterpriseValueTwd,
          ) ||
          Math.abs(modeledEnterpriseValueTwd - bridge.targetEnterpriseValueTwd) >
            sensitivityTolerance ||
          Math.abs(residualTwd) > sensitivityTolerance
        ) {
          context.addIssue({
            code: "custom",
            path: ["model", "sensitivities", index],
            message:
              "solved sensitivity cell 必須位於 caller bracket，且 modeled EV／residual 必須與 market target EV 在 solver residual tolerance 內完整 tie out",
          });
        }
      }
    }
    const mappingIds = result.normalizedInputEvidence.factMappings.map((item) => item.mappingId);
    const mappingSet = new Set(mappingIds);
    if (mappingSet.size !== mappingIds.length) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "factMappings"], message: "mappingId 不得重複" });
    }
    const mappingFactIds = result.normalizedInputEvidence.factMappings.map(
      (mapping) => mapping.engineFactId,
    );
    if (new Set(mappingFactIds).size !== mappingFactIds.length) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "factMappings"], message: "每個 sourced engineFactId 必須剛好有一個 mapping" });
    }
    const sourceIds = result.normalizedInputEvidence.sourceLedger.map(
      (source) => source.sourceId,
    );
    const lineageIds = result.normalizedInputEvidence.lineageLedger.map(
      (entry) => entry.lineageId,
    );
    const sourceSet = new Set(sourceIds);
    const lineageSet = new Set(lineageIds);
    if (sourceSet.size !== sourceIds.length) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "sourceLedger"], message: "sourceId 不得重複" });
    }
    if (lineageSet.size !== lineageIds.length) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "lineageLedger"], message: "lineageId 不得重複" });
    }
    const companyMasterSources =
      result.normalizedInputEvidence.sourceLedger.filter(
        (source) => source.stage === "company_master",
      );
    if (
      companyMasterSources.length !== 1 ||
      companyMasterSources[0]?.market !== result.company.market ||
      companyMasterSources[0]?.exchange !== result.company.exchange
    ) {
      context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "sourceLedger"], message: "必須剛好有一個與 company market／exchange 一致的 current-master source" });
    }
    for (const [index, entry] of result.normalizedInputEvidence.lineageLedger.entries()) {
      if (entry.sourceId !== null && !sourceSet.has(entry.sourceId)) {
        context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "lineageLedger", index, "sourceId"], message: `sourceId ${entry.sourceId} 不存在 sourceLedger` });
      }
    }
    const sourceById = new Map(
      result.normalizedInputEvidence.sourceLedger.map(
        (source) => [source.sourceId, source] as const,
      ),
    );
    const lineageById = new Map(
      result.normalizedInputEvidence.lineageLedger.map(
        (entry) => [entry.lineageId, entry] as const,
      ),
    );
    const expectedSourceStage = {
      cashAndCashEquivalents: "statement",
      interestBearingDebt: "statement",
      issuedShares: "company_master",
      latestOfficialClose: "latest_official_completed_close",
      normalizedFcff: "statement",
      ttmRevenue: "statement",
      ttmOperatingIncomeEbitProxy: "statement",
    } as const;
    for (const fieldId of expectedUsedFieldIds) {
      const field = normalizedFields[fieldId];
      const contractStage = expectedSourceStage[fieldId];
      const invalidReference = field.inputLineageIds.some((lineageId) => {
        const entry = lineageById.get(lineageId);
        const source =
          entry?.sourceId === null || entry?.sourceId === undefined
            ? undefined
            : sourceById.get(entry.sourceId);
        if (
          !entry ||
          entry.status !== "resolved" ||
          !source ||
          source.stage !== contractStage
        ) {
          return true;
        }
        return source.stage === "company_master" ||
          source.stage === "latest_official_completed_close"
          ? source.market !== result.company.market ||
              source.exchange !== result.company.exchange
          : false;
      });
      if (invalidReference) {
        context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "fields", fieldId, "inputLineageIds"], message: "used field lineage 必須 resolved，且 source stage／market／exchange 符合 semantic contract" });
      }
    }
    for (const [index, mapping] of result.normalizedInputEvidence.factMappings.entries()) {
      if (mapping.sourceIds.length === 0) {
        context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "factMappings", index, "sourceIds"], message: "每個 sourced fact mapping 必須連到至少一個 official／Mopsfin source" });
      }
      for (const sourceId of mapping.sourceIds) {
        if (!sourceSet.has(sourceId)) context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "factMappings", index, "sourceIds"], message: `sourceId ${sourceId} 不存在 sourceLedger` });
      }
      for (const lineageId of mapping.upstreamLineageIds) {
        if (!lineageSet.has(lineageId)) context.addIssue({ code: "custom", path: ["normalizedInputEvidence", "factMappings", index, "upstreamLineageIds"], message: `lineageId ${lineageId} 不存在 lineageLedger` });
      }
    }
    for (const [index, fact] of result.model.evidence.inputFacts.entries()) {
      const mapping = result.normalizedInputEvidence.factMappings.find(
        (candidate) => candidate.engineFactId === fact.id,
      );
      if (
        !mapping ||
        fact.lineageIds.length !== 1 ||
        fact.lineageIds[0] !== mapping.mappingId ||
        fact.evidenceClass !== mapping.evidenceClass
      ) {
        context.addIssue({ code: "custom", path: ["model", "evidence", "inputFacts", index], message: "每個 sourced model input fact 必須精確對應一個同 evidence class 的 fact mapping" });
      }
      for (const mappingIdValue of fact.lineageIds) {
        if (!mappingSet.has(mappingIdValue)) context.addIssue({ code: "custom", path: ["model", "evidence", "inputFacts", index, "lineageIds"], message: `mappingId ${mappingIdValue} 不存在 factMappings` });
      }
    }
    if (
      result.model.evidence.inputFacts.length !==
      result.normalizedInputEvidence.factMappings.length
    ) {
      context.addIssue({ code: "custom", path: ["model", "evidence", "inputFacts"], message: "input facts 與 sourced fact mappings 必須一對一完整覆蓋" });
    }
    const inputFactIds = result.model.evidence.inputFacts.map(
      (fact) => fact.id,
    );
    const assumptionIds = result.model.evidence.assumptions.map(
      (assumption) => assumption.id,
    );
    const modelOutputIds = result.model.evidence.modelOutputs.map(
      (output) => output.id,
    );
    if (
      new Set(inputFactIds).size !== inputFactIds.length ||
      new Set(assumptionIds).size !== assumptionIds.length ||
      new Set(modelOutputIds).size !== modelOutputIds.length
    ) {
      context.addIssue({ code: "custom", path: ["model", "evidence"], message: "input fact、assumption 與 model-output IDs 必須在各自分類內唯一" });
    }
    const expectedModelOutputs: Record<
      string,
      { value: number; unit: string; formula: string }
    > = {
      "bridge.observedEquityValueTwd": {
        value: bridge.observedEquityValueTwd,
        unit: "TWD",
        formula: "observedPricePerShareTwd * sharesOutstanding",
      },
      "bridge.targetEnterpriseValueTwd": {
        value: bridge.targetEnterpriseValueTwd,
        unit: "TWD",
        formula:
          "observed_equity_value_plus_debt_like_claims_minus_cash_and_non_operating_assets",
      },
      "solution.solvedValuePercent": {
        value: result.model.solution.solvedValuePercent,
        unit: "percent",
        formula:
          "bisection(modeledEnterpriseValueTwd - targetEnterpriseValueTwd = 0)",
      },
      "presentValue.explicitForecastTwd": {
        value: result.model.presentValue.explicitForecastTwd,
        unit: "TWD",
        formula: "sum(fcff_t / (1 + wacc)^t)",
      },
      "terminal.terminalFcffTwd": {
        value: result.model.terminal.terminalFcffTwd,
        unit: "TWD",
        formula:
          result.query.solve_for === "fcff_cagr"
            ? "finalForecastFcffTwd * (1 + terminalGrowth)"
            : "terminalRevenueTwd * terminalOperatingMargin * (1 - cashTaxRate_on_positive_ebit) - deltaRevenueTwd / salesToCapitalRatio",
      },
      "terminal.undiscountedTerminalValueTwd": {
        value: result.model.terminal.undiscountedTerminalValueTwd,
        unit: "TWD",
        formula: "terminalFcffTwd / (wacc - terminalGrowth)",
      },
      "terminal.presentValueTerminalTwd": {
        value: result.model.terminal.presentValueTerminalTwd,
        unit: "TWD",
        formula:
          "undiscountedTerminalValueTwd / (1 + wacc)^forecastYears",
      },
      "presentValue.modeledEnterpriseValueTwd": {
        value: result.model.presentValue.modeledEnterpriseValueTwd,
        unit: "TWD",
        formula: "explicitForecastTwd + presentValueTerminalTwd",
      },
      "presentValue.residualTwd": {
        value: result.model.presentValue.residualTwd,
        unit: "TWD",
        formula: "modeledEnterpriseValueTwd - targetEnterpriseValueTwd",
      },
    };
    const modelOutputById = new Map(
      result.model.evidence.modelOutputs.map(
        (output) => [output.id, output] as const,
      ),
    );
    if (
      result.model.evidence.modelOutputs.length !==
        Object.keys(expectedModelOutputs).length ||
      modelOutputById.size !== Object.keys(expectedModelOutputs).length ||
      Object.entries(expectedModelOutputs).some(([id, expected]) => {
        const output = modelOutputById.get(id);
        return (
          !output ||
          typeof output.value !== "number" ||
          !approximatelyEqual(output.value, expected.value) ||
          output.unit !== expected.unit ||
          output.formula !== expected.formula
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["model", "evidence", "modelOutputs"],
        message:
          "MODEL_OUTPUT evidence 必須以九個穩定 ID 精確覆蓋實際 bridge／solution／PV／terminal values、units 與 formulas",
      });
    }
    const expectedInputFacts: Record<
      string,
      { value: number | string | boolean; unit: string }
    > = {
      "company.companyCode": {
        value: result.company.code,
        unit: "category",
      },
      "company.isFinancial": { value: false, unit: "boolean" },
      "marketFacts.observedPricePerShareTwd": {
        value: bridge.observedPricePerShareTwd,
        unit: "TWD_per_share",
      },
      "marketFacts.observedPriceDate": {
        value: bridge.observedPriceDate,
        unit: "date",
      },
      "marketFacts.sharesOutstanding": {
        value: bridge.sharesOutstanding,
        unit: "share",
      },
      "marketFacts.shareCountBasis": {
        value: bridge.shareCountBasis,
        unit: "category",
      },
      "marketFacts.cashAndCashEquivalentsTwd": {
        value: bridge.lessCashAndCashEquivalentsTwd,
        unit: "TWD",
      },
      "marketFacts.interestBearingDebtTwd": {
        value: bridge.plusInterestBearingDebtTwd,
        unit: "TWD",
      },
      "marketFacts.leaseLiabilitiesTwd": {
        value: bridge.plusLeaseLiabilitiesTwd,
        unit: "TWD",
      },
    };
    if (result.query.solve_for === "fcff_cagr") {
      expectedInputFacts["operatingFacts.baseFcffTwd"] = {
        value: normalizedFields.normalizedFcff.value as number,
        unit: "TWD",
      };
    } else {
      expectedInputFacts["operatingFacts.baseRevenueTwd"] = {
        value: normalizedFields.ttmRevenue.value as number,
        unit: "TWD",
      };
      if (result.query.solve_for === "terminal_operating_margin") {
        expectedInputFacts["operatingFacts.baseOperatingMarginPercent"] = {
          value:
            ((normalizedFields.ttmOperatingIncomeEbitProxy.value as number) /
              (normalizedFields.ttmRevenue.value as number)) *
            100,
          unit: "percent",
        };
      }
    }
    const inputFactById = new Map(
      result.model.evidence.inputFacts.map(
        (fact) => [fact.id, fact] as const,
      ),
    );
    const invalidInputEvidence =
      inputFactById.size !== Object.keys(expectedInputFacts).length ||
      Object.entries(expectedInputFacts).some(([id, expected]) => {
        const fact = inputFactById.get(id);
        if (!fact || fact.unit !== expected.unit) return true;
        return typeof expected.value === "number"
          ? typeof fact.value !== "number" ||
              !approximatelyEqual(fact.value, expected.value)
          : !Object.is(fact.value, expected.value);
      });
    if (invalidInputEvidence) {
      context.addIssue({ code: "custom", path: ["model", "evidence", "inputFacts"], message: "每個 stable input fact 的 value/unit 必須與 company、EV bridge 或 mode-specific normalized operating base 精確 tie out" });
    }
    const expectedAssumptions: Record<
      string,
      { value: number | string | boolean; unit: string }
    > = {
      "marketFacts.nonOperatingAssetsTwd":
        { value: bridgeAssumptions.non_operating_assets_twd, unit: "TWD" },
      "marketFacts.nonControllingInterestsTwd":
        {
          value: bridgeAssumptions.non_controlling_interests_twd,
          unit: "TWD",
        },
      "marketFacts.preferredEquityTwd":
        { value: bridgeAssumptions.preferred_equity_twd, unit: "TWD" },
      "marketFacts.pensionDeficitTwd":
        { value: bridgeAssumptions.pension_deficit_twd, unit: "TWD" },
      "marketFacts.otherDebtLikeItemsTwd":
        { value: bridgeAssumptions.other_debt_like_items_twd, unit: "TWD" },
      forecastYears: { value: result.query.forecast_years, unit: "year" },
      waccPercent: { value: result.query.wacc_percent, unit: "percent" },
      terminalGrowthPercent: {
        value: result.query.terminal_growth_percent,
        unit: "percent",
      },
      solveFor: { value: result.query.solve_for, unit: "category" },
      "solveRange.minimumPercent": {
        value: result.query.solve_range.minimum_percent,
        unit: "percent",
      },
      "solveRange.maximumPercent": {
        value: result.query.solve_range.maximum_percent,
        unit: "percent",
      },
      discountConvention: { value: "year_end", unit: "category" },
      terminalValueMethod: {
        value: "perpetuity_growth",
        unit: "category",
      },
    };
    if (result.query.solve_for === "revenue_cagr") {
      expectedAssumptions["operatingAssumptions.marginPolicy"] =
        { value: "constant_normalized", unit: "category" };
      expectedAssumptions[
        "operatingAssumptions.normalizedOperatingMarginPercent"
      ] = {
        value:
          result.query.forward_assumptions
            .normalized_operating_margin_percent,
        unit: "percent",
      };
      expectedAssumptions["operatingAssumptions.cashTaxRatePercent"] =
        {
          value: result.query.forward_assumptions.cash_tax_rate_percent,
          unit: "percent",
        };
      expectedAssumptions["operatingAssumptions.salesToCapitalRatio"] =
        {
          value: result.query.forward_assumptions.sales_to_capital_ratio,
          unit: "ratio",
        };
    } else if (result.query.solve_for === "fcff_cagr") {
      expectedAssumptions["operatingAssumptions.growthPolicy"] =
        { value: "constant_compounded", unit: "category" };
    } else {
      expectedAssumptions["operatingAssumptions.revenueCagrPercent"] =
        {
          value: result.query.forward_assumptions.revenue_cagr_percent,
          unit: "percent",
        };
      expectedAssumptions["operatingAssumptions.cashTaxRatePercent"] =
        {
          value: result.query.forward_assumptions.cash_tax_rate_percent,
          unit: "percent",
        };
      expectedAssumptions["operatingAssumptions.salesToCapitalRatio"] =
        {
          value: result.query.forward_assumptions.sales_to_capital_ratio,
          unit: "ratio",
        };
      expectedAssumptions["operatingAssumptions.marginTransition"] =
        {
          value: "linear_from_base_to_terminal",
          unit: "category",
        };
    }
    result.query.sensitivity_grids?.wacc_percent.forEach((value, index) => {
      expectedAssumptions[`sensitivityGrids.waccPercent.${index}`] = {
        value,
        unit: "percent",
      };
    });
    result.query.sensitivity_grids?.terminal_growth_percent.forEach(
      (value, index) => {
        expectedAssumptions[
          `sensitivityGrids.terminalGrowthPercent.${index}`
        ] = { value, unit: "percent" };
      },
    );
    const assumptionById = new Map(
      result.model.evidence.assumptions.map(
        (assumption) => [assumption.id, assumption] as const,
      ),
    );
    if (
      result.model.evidence.assumptions.length !==
        Object.keys(expectedAssumptions).length ||
      assumptionById.size !== Object.keys(expectedAssumptions).length ||
      Object.entries(expectedAssumptions).some(
        ([id, expected]) => {
          const assumption = assumptionById.get(id);
          return (
            !assumption ||
            !Object.is(assumption.value, expected.value) ||
            assumption.unit !== expected.unit
          );
        },
      )
    ) {
      context.addIssue({ code: "custom", path: ["model", "evidence", "assumptions"], message: "model assumptions 必須以精確 value／unit 完整 echo caller query 與固定揭露 conventions，不得隱藏或改寫" });
    }
    if (
      JSON.stringify(result.sources) !==
      JSON.stringify(result.normalizedInputEvidence.sourceLedger)
    ) {
      context.addIssue({ code: "custom", path: ["sources"], message: "top-level sources 必須與 normalizedInputEvidence.sourceLedger 完全一致" });
    }
    const generatedAtMs = Date.parse(result.generatedAt);
    const valuationGeneratedAt =
      result.normalizedInputEvidence.valuationModelGeneratedAt;
    const valuationGeneratedAtMs = Date.parse(valuationGeneratedAt);
    const sourceTimes = result.sources.map((source) => ({
      raw: source.retrievedAt,
      timestamp: Date.parse(source.retrievedAt),
    }));
    if (
      !strictIsoInstantPattern.test(result.generatedAt) ||
      !strictIsoInstantPattern.test(valuationGeneratedAt) ||
      !Number.isFinite(generatedAtMs) ||
      !Number.isFinite(valuationGeneratedAtMs) ||
      valuationGeneratedAtMs > generatedAtMs ||
      sourceTimes.some(
        (item) =>
          !strictIsoInstantPattern.test(item.raw) ||
          !Number.isFinite(item.timestamp) ||
          item.timestamp > valuationGeneratedAtMs,
      )
    ) {
      context.addIssue({ code: "custom", path: ["generatedAt"], message: "所有時間必須是 strict ISO UTC，且滿足 source retrievedAt <= valuationModelGeneratedAt <= reverse generatedAt" });
    }
  }

export const reverseDcfDataSchema = reverseDcfDataBaseSchema
  .superRefine(validateReverseDcfData)
  .describe("可由 normalized valuation-model source lineage、caller assumptions 與 deterministic formulas 完整重算的 reverse DCF result");

export const reverseDcfOutputSchema = z
  .object({
    ...successResultShape,
    ...reverseDcfDataSchema.shape,
  })
  .strict()
  .superRefine((result, context) => {
    validateReverseDcfData(result, context);
    const servedAt = result.meta.asOf.servedAt;
    if (
      !strictIsoInstantPattern.test(servedAt) ||
      !Number.isFinite(Date.parse(servedAt)) ||
      Date.parse(servedAt) < Date.parse(result.generatedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta", "asOf", "servedAt"],
        message:
          "advertised MCP meta.asOf.servedAt 必須是 strict ISO UTC，且不得早於 reverse DCF generatedAt",
      });
    }
  })
  .describe("run_reverse_dcf 的成功結果與共用 MCP metadata");
