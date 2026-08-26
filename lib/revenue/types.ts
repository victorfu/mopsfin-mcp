import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";
import type {
  MarketReconciliation,
  OfficialMarketSource,
  UniversePolicy,
} from "@/lib/market-data/types";

export type RevenueValueStatus = "reported" | "missing" | "invalid_upstream";

export interface MonthlyRevenueQuery {
  market: CompanyMarketSelection;
  dataMonth: "latest";
  companyCodes?: string[];
  universePolicy: UniversePolicy;
}

export interface MonthlyRevenueRow {
  code: string;
  name: string;
  market: CompanyMarket;
  industryCode: string | null;
  sourceReportDate: string;
  currentMonthRevenueTwd: number | null;
  previousMonthRevenueTwd: number | null;
  sameMonthLastYearRevenueTwd: number | null;
  momPercent: number | null;
  yoyPercent: number | null;
  currentYearCumulativeRevenueTwd: number | null;
  previousYearCumulativeRevenueTwd: number | null;
  cumulativeYoyPercent: number | null;
  note: string | null;
  valueStatus: {
    currentMonthRevenueTwd: RevenueValueStatus;
    previousMonthRevenueTwd: RevenueValueStatus;
    sameMonthLastYearRevenueTwd: RevenueValueStatus;
    momPercent: RevenueValueStatus;
    yoyPercent: RevenueValueStatus;
    currentYearCumulativeRevenueTwd: RevenueValueStatus;
    previousYearCumulativeRevenueTwd: RevenueValueStatus;
    cumulativeYoyPercent: RevenueValueStatus;
  };
}

export interface MonthlyRevenueSource extends OfficialMarketSource {
  dataMonth: string;
  sourceReportDate: string;
  sourceAmountUnit: "thousand_TWD";
  outputAmountUnit: "TWD";
  amountMultiplier: 1000;
}

export interface MonthlyRevenueResult {
  query: MonthlyRevenueQuery;
  dataMonth: string;
  currency: "TWD";
  amountUnit: "TWD";
  coverageComplete: true;
  selectionComplete: boolean;
  missingCompanyCodes: string[];
  filingCoverage: {
    expectedCompanyCount: number;
    reportedCompanyCount: number;
    missingCompanyCodes: string[];
    coverageRatio: number;
    complete: boolean;
  };
  reconciliation: MarketReconciliation[];
  counts: {
    listed: number;
    otc: number;
    returned: number;
  };
  rows: MonthlyRevenueRow[];
  sources: MonthlyRevenueSource[];
  warnings: string[];
}

export type { MarketReconciliation, UniversePolicy };
