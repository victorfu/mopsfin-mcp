import type { CompanyMarket } from "@/lib/company-master/types";

export type SupportedFinancialSector = "holding" | "bank" | "bills";

export type FinancialInstitutionMappingStatus =
  | "mapped"
  | "institution_not_found"
  | "duplicate_institution_code"
  | "unsupported_institution_sector"
  | "identity_mismatch";

export interface FinancialInstitutionMapping {
  companyCode: string;
  companyName: string;
  companyShortName: string;
  market: CompanyMarket;
  status: FinancialInstitutionMappingStatus;
  institutionCode: string | null;
  institutionName: string | null;
  sector: SupportedFinancialSector | null;
  matchBasis: "exact_company_code" | null;
  identityMatch: "company_name" | "company_short_name" | "mismatch" | null;
  reasonCodes: string[];
  catalogCandidates: Array<{
    code: string;
    name: string;
    sector: SupportedFinancialSector | "unknown";
  }>;
}

export interface FinancialInstitutionCoverageReport {
  scope: "current_listed_otc_financial_companies";
  catalogDiscoveredAt: string;
  coverageComplete: boolean;
  counts: {
    financialCompanies: number;
    mapped: number;
    institutionNotFound: number;
    duplicateInstitutionCode: number;
    unsupportedInstitutionSector: number;
    identityMismatch: number;
    bySupportedSector: Record<SupportedFinancialSector, number>;
  };
  mappings: FinancialInstitutionMapping[];
  warnings: string[];
}
