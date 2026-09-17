import type { CompanyMarketSelection } from "@/lib/company-master/types";
import type { OutputMode } from "@/lib/research/projection";
import type { ResearchFilter, ResearchSort } from "@/lib/research/types";

export interface ScreenCompaniesQuery {
  market: CompanyMarketSelection;
  includeFinancial: boolean;
  includeKy: boolean;
  industryCodes?: string[];
  companyCodes?: string[];
  asOf: "latest";
  revenueMonth: string;
  filters: ResearchFilter[];
  columns: string[];
  sort: ResearchSort[];
  pageSize?: number;
  cursor?: string;
  outputMode: OutputMode;
}

