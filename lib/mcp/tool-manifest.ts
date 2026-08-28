/** Ordered public MCP surface. Keep this module dependency-free and browser-safe. */
export const PUBLIC_TOOL_NAMES = [
  "find_companies",
  "get_stock_ohlc",
  "get_stock_price_series",
  "get_daily_market_ohlc",
  "analyze_observed_price",
  "get_stock_reaction_signals",
  "get_company_catalyst_events",
  "get_company_catalyst_snapshots",
  "screen_taiwan_stock_candidates",
  "screen_taiwan_stock_candidates_with_catalyst_snapshots",
  "get_daily_market_valuation",
  "get_valuation_model_inputs",
  "run_reverse_dcf",
  "get_monthly_revenue",
  "get_monthly_revenue_trend",
  "list_companies",
  "list_catalog",
  "get_company_metric",
  "get_company_metrics_batch",
  "get_financial_statement",
  "get_financial_note",
  "get_industry_data",
  "get_financial_institution_metric",
] as const;

export type McpToolName = (typeof PUBLIC_TOOL_NAMES)[number];

export const TOOL_COUNT = PUBLIC_TOOL_NAMES.length;
