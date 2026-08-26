import type {
  CompanyMarket,
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";

export type UniversePolicy = "compatible" | "strict_current_master";

export type CurrentMasterClassificationPolicy =
  | "current_master_strict"
  | "current_master_with_code_fallback";

export interface MarketReconciliation {
  market: CompanyMarket;
  masterCount: number;
  sourceRowCount: number;
  matchedCount: number;
  marketOnlyCodes: string[];
  masterMissingCodes: string[];
  matchRatio: number;
  coverageComplete: boolean;
}

export interface OfficialMarketSource {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  rawCount: number;
  eligibleRowCount: number;
}

export interface CurrentCompanyMasterLike {
  listCompanies(
    query: {
      market: "all" | "listed" | "otc";
      includeFinancial: boolean;
      includeKy: boolean;
    },
    force?: boolean,
  ): Promise<CompanyMasterResult>;
}

export interface OfficialMarketClientOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  cacheTtlMs?: number;
}

export interface CodeIdentity {
  code: string;
  market: CompanyMarket;
}

export interface ReconciledMarket<T extends CodeIdentity> {
  reconciliation: MarketReconciliation;
  masterByCode: Map<string, MasterCompany>;
  acceptedRows: T[];
}
