import type { FinancialScreenMetricRole } from "./metric-roles";
import type { SupportedFinancialSector } from "./types";

export const TAIWAN_FINANCIAL_SCREEN_PRESET = "balanced_financial_v1" as const;
export const TAIWAN_FINANCIAL_SCREEN_DEFINITION =
  "taiwan_financial_screen.v1" as const;

export const FINANCIAL_SCREEN_THRESHOLDS = {
  annualRoeMinimumPercent: 8,
  positiveTtmNetProfitQuartersMinimum: 3,
  qualityScoreMinimum: 70,
  improvementScoreMinimum: 60,
  priceToBookMaximum: 5,
  priceEarningsMaximum: 30,
  dividendYieldSupportMinimumPercent: 2,
  valuationPeerMinimum: 3,
  valuationPercentileMaximum: 70,
  roeAdjustedPriceToBookMaximum: 30,
  extremeRoeAdjustedPriceToBook: 50,
  extremePriceToBookPercentile: 90,
} as const;

export const CORE_INSTITUTION_METRIC_ROLES = {
  holding: ["holding_capital_adequacy_ratio"],
  bank: [
    "bank_capital_adequacy_ratio",
    "loan_overdue_ratio",
    "loan_loss_reserve_coverage_ratio",
  ],
  bills: ["bills_capital_adequacy_ratio"],
} as const satisfies Record<SupportedFinancialSector, readonly FinancialScreenMetricRole[]>;

export const FINANCIAL_SCREEN_DEFINITION = {
  id: TAIWAN_FINANCIAL_SCREEN_DEFINITION,
  preset: TAIWAN_FINANCIAL_SCREEN_PRESET,
  posture: "research_triage_not_recommendation",
  supportedSectors: ["holding", "bank", "bills"],
  scoreCompensationAcrossPillars: false,
  crossModelScoreComparable: false,
  pillarWeights: {
    company_quality: 25,
    fundamental_improvement: 25,
    reasonable_valuation: 25,
    market_underreaction_proxy: 25,
  },
  evidencePolicies: {
    profitabilityRoles: ["roe", "net_profit", "eps"],
    coreInstitutionMetricRoles: CORE_INSTITUTION_METRIC_ROLES,
    financialAlignment:
      "profitability_exact_quarter_capital_expected_semiannual_asset_quality_exact_quarter",
    valuationPeerScope: "same_financial_subtype_no_fallback",
    valuationPeerMinimum: FINANCIAL_SCREEN_THRESHOLDS.valuationPeerMinimum,
    reactionPriceBasis:
      "price_index_compatible_corporate_action_adjusted_vs_price_index",
  },
  limitations: [
    "只支援可與 Mopsfin 金融機構目錄唯一 exact-code 對應的金控、銀行與票券公司。",
    "保險、證券、unknown subtype 或 identity 無法核對者明示 unsupported/unmapped，不會模糊配對。",
    "資本適足與資產品質採公司相對同一期 Mopsfin 業別平均及 exact YoY，不宣稱法定監理門檻。",
    "金融模型分數只允許同模型內排序，不得與 balanced_non_financial_v2 raw score 比較。",
  ],
} as const;
