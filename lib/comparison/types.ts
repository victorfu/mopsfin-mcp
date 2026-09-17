import type { OutputMode } from "@/lib/research/projection";

export type FinancialPeriodPolicy = "common_latest" | "company_latest" | "explicit";
export interface AlignmentSeries {
  companyCode: string;
  metricCode: string;
  applicability: "applicable" | "not_applicable" | "unknown";
  reportedPeriods: string[];
}


export interface CompareCompaniesQuery {
  companyCodes: string[];
  columns: string[];
  financialPeriodPolicy?: FinancialPeriodPolicy;
  fiscalPeriod?: string;
  financialBasis?: "quarterly";
  marketDate: string;
  revenueMonth: string;
  outputMode: OutputMode;
}

