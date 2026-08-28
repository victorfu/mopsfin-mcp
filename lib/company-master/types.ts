import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

export type CompanyMarket = "listed" | "otc";
export type CompanyMarketSelection = CompanyMarket | "all";
export type CompanyProfileValueStatus = "reported" | "missing" | "invalid_upstream";

export interface MasterCompany {
  code: string;
  name: string;
  shortName: string;
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  industryCode: string;
  listingDate: string;
  incorporationDate: string | null;
  paidInCapitalTwd: number | null;
  issuedCommonShares: number | null;
  parValueText: string | null;
  financialReportTypeCode: string | null;
  profileValueStatus: {
    incorporationDate: CompanyProfileValueStatus;
    paidInCapitalTwd: CompanyProfileValueStatus;
    issuedCommonShares: CompanyProfileValueStatus;
    parValueText: CompanyProfileValueStatus;
    financialReportTypeCode: CompanyProfileValueStatus;
  };
  domicileCode: string;
  isKy: boolean;
  isFinancial: boolean;
}

export interface CompanyMasterSource {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
  reportDate: string;
  retrievedAt: string;
  rawCount: number;
  excludedTdrCount: number;
  companyCount: number;
  minimumExpectedCount: number;
  cache?: CacheProvenance;
}

export interface CompanyMasterCoverageVerification {
  status: "heuristic";
  method: "required_sources_schema_single_report_date_minimum_count";
  officialDeclaredRowCountAvailable: false;
}

export interface CompanyMarketSnapshot {
  source: CompanyMasterSource;
  companies: MasterCompany[];
  /** Acquisition-layer metadata; public tool schemas wire this separately. */
  cache?: CacheProvenance;
}

export interface CompanyMasterQuery {
  market: CompanyMarketSelection;
  includeFinancial: boolean;
  includeKy: boolean;
}

export interface CompanyMasterResult {
  query: CompanyMasterQuery;
  generatedAt: string;
  snapshotId: string;
  coverageVerification: CompanyMasterCoverageVerification;
  /**
   * Backward-compatible success flag. This means all required sources passed
   * schema, single-report-date, uniqueness, and minimum-count gates; the
   * upstream feeds do not expose an official declared row count.
   */
  coverageComplete: true;
  sources: CompanyMasterSource[];
  counts: {
    raw: number;
    excludedTdr: number;
    eligible: number;
    excludedFinancial: number;
    excludedKy: number;
    listed: number;
    otc: number;
    returned: number;
  };
  profileCoverage: Record<
    keyof MasterCompany["profileValueStatus"],
    { reported: number; missing: number; invalid: number }
  >;
  companies: MasterCompany[];
  warnings: string[];
}
