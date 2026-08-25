export type CompanyMarket = "listed" | "otc";
export type CompanyMarketSelection = CompanyMarket | "all";

export interface MasterCompany {
  code: string;
  name: string;
  shortName: string;
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  industryCode: string;
  listingDate: string;
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
}

export interface CompanyMarketSnapshot {
  source: CompanyMasterSource;
  companies: MasterCompany[];
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
  companies: MasterCompany[];
  warnings: string[];
}
