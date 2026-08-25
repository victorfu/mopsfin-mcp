export type EndpointFamily =
  | "data"
  | "report"
  | "bcode"
  | "xb"
  | "fin"
  | "adequacy";

export interface MetricDefinition {
  code: string;
  name: string;
  unit: string;
  category: string;
  family: EndpointFamily;
}

export interface IndustryDefinition {
  code: string;
  name: string;
}

export interface FinancialInstitutionDefinition {
  code: string;
  name: string;
  sector: "holding" | "bank" | "bills" | "unknown";
}

export interface Catalog {
  metrics: MetricDefinition[];
  industries: IndustryDefinition[];
  financialInstitutions: FinancialInstitutionDefinition[];
  years: number[];
  quarters: number[];
  discoveredAt: string;
}

export interface CompanySuggestion {
  code: string;
  name: string;
  displayName: string;
}

export interface TrendPoint {
  period: string;
  value: number | null;
  status?: string;
}

export interface TrendSeries {
  label: string;
  points: TrendPoint[];
}

export interface NormalizedTrend {
  periods: string[];
  series: TrendSeries[];
  normalizationWarnings: string[];
  unit: string;
  showNames: string[];
  checkedNames: string[];
  extraNames: string[];
  displayNames: string[];
  year?: number;
  quarter?: number;
}

export interface NormalizedTable {
  title: string;
  headers: string[][];
  rows: string[][];
}

export interface ParsedHtmlResponse {
  period?: string;
  reportNames: string[];
  tables: NormalizedTable[];
  totalRows: number;
}

export interface PaginatedTables {
  tables: NormalizedTable[];
  pagination: {
    offset: number;
    limit: number;
    returnedRows: number;
    totalRows: number;
    nextOffset: number | null;
  };
}

export interface SourceMetadata {
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  upstreamRoute: string;
  freshnessNote: string;
}
