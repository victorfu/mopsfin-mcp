import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

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
  /** Actual completion time of the upstream catalog fetch. */
  retrievedAt?: string;
  /** Acquisition-layer metadata; public tool schemas wire this separately. */
  cache?: CacheProvenance;
}

export interface CompanySuggestion {
  code: string;
  name: string;
  displayName: string;
}

export interface TrendPoint {
  period: string;
  value: number | null;
  valueStatus: "reported" | "missing" | "invalid_upstream";
  status?: string;
}

export type TrendSeriesType =
  | "company"
  | "institution"
  | "industry_average"
  | "selection_average"
  | "other";

interface TrendSeriesBase {
  label: string;
  points: TrendPoint[];
}

export type TrendSeries =
  | (TrendSeriesBase & {
      seriesType: "company";
      companyCode: string;
      companyName: string;
      displayName: string;
    })
  | (TrendSeriesBase & {
      seriesType: "institution";
      institutionCode: string;
      institutionName: string;
      institutionSector: FinancialInstitutionDefinition["sector"];
    })
  | (TrendSeriesBase & {
      seriesType: Exclude<TrendSeriesType, "company" | "institution">;
      companyCode?: never;
      companyName?: never;
      displayName?: never;
      institutionCode?: never;
      institutionName?: never;
      institutionSector?: never;
    })
  | (TrendSeriesBase & {
      seriesType?: undefined;
      companyCode?: never;
      companyName?: never;
      displayName?: never;
      institutionCode?: never;
      institutionName?: never;
      institutionSector?: never;
    });

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
  /** Amount unit explicitly rendered in the upstream HTML, when present. */
  unit?: string;
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
  cache?: CacheProvenance;
}
