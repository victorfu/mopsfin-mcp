export type CellValue = number | string | boolean | null;
export type CellStatus =
  | "available" | "missing" | "not_applicable" | "invalid_upstream"
  | "source_unavailable" | "period_unaligned" | "freshness_unverified";

/** Metadata is explicit even for nulls: absence must never become a zero. */
export interface ResearchCell {
  value: CellValue;
  status: CellStatus;
  unit: string;
  period: string | null;
  basis: string;
  definitionId: string;
  sourceRefs: string[];
  freshness: "fresh" | "stale" | "unverified" | "not_applicable";
  normalization?: { sourceUnit: string; sourceValue: CellValue; factor: number };
  reason?: string;
}

export interface ResearchRow {
  code: string;
  name: string;
  market: "listed" | "otc";
  cells: Record<string, ResearchCell>;
}

export type ResearchDomain = "company" | "price" | "valuation" | "revenue" | "financial";
export type FilterOperator = "gt" | "gte" | "lt" | "lte" | "between" | "eq" | "in";
export interface ResearchField {
  id: string;
  name: string;
  type: "number" | "string" | "boolean";
  unit: string;
  domain: ResearchDomain;
  frequency: "snapshot" | "daily" | "monthly" | "quarterly";
  basis: string;
  definitionId: string;
  dependencies: ResearchDomain[];
  applicability: "all" | "non_financial" | "industry_specific" | "unknown";
  filterOperators: FilterOperator[];
  sortable: boolean;
  cost: "master" | "market_bulk" | "company_metric_batch";
  normalization: { sourceUnit: string; outputUnit: string; factor: number } | null;
  supportedTools: Array<"screen_companies" | "compare_companies" | "get_daily_market_ohlc" | "get_daily_market_valuation" | "get_monthly_revenue">;
}

export interface ResearchFilter {
  field: string;
  op: FilterOperator;
  value: number | string | boolean | Array<number | string | boolean>;
}
export interface ResearchSort { field: string; direction: "asc" | "desc" }
