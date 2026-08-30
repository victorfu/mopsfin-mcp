import { createHash } from "node:crypto";

import type { MasterCompany } from "@/lib/company-master/types";
import type {
  Catalog,
  FinancialInstitutionDefinition,
} from "@/lib/mopsfin/types";

import type {
  FinancialInstitutionCoverageReport,
  FinancialInstitutionMapping,
  SupportedFinancialSector,
} from "./types";
import { financialCatalogSnapshotId } from "./metric-roles";

const SUPPORTED_SECTORS = new Set<SupportedFinancialSector>([
  "holding",
  "bank",
  "bills",
]);

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function identityMatch(
  company: MasterCompany,
  institution: FinancialInstitutionDefinition,
): FinancialInstitutionMapping["identityMatch"] {
  const institutionName = normalizeIdentity(institution.name);
  if (institutionName === normalizeIdentity(company.shortName)) {
    return "company_short_name";
  }
  if (institutionName === normalizeIdentity(company.name)) {
    return "company_name";
  }
  return "mismatch";
}

function mappingForCompany(
  company: MasterCompany,
  candidates: FinancialInstitutionDefinition[],
): FinancialInstitutionMapping {
  const catalogCandidates = candidates.map(({ code, name, sector }) => ({
    code,
    name,
    sector,
  }));
  if (candidates.length === 0) {
    return {
      companyCode: company.code,
      companyName: company.name,
      companyShortName: company.shortName,
      market: company.market,
      status: "institution_not_found",
      institutionCode: null,
      institutionName: null,
      sector: null,
      matchBasis: null,
      identityMatch: null,
      reasonCodes: ["financial_institution_exact_code_not_found"],
      catalogCandidates,
    };
  }
  if (candidates.length > 1) {
    return {
      companyCode: company.code,
      companyName: company.name,
      companyShortName: company.shortName,
      market: company.market,
      status: "duplicate_institution_code",
      institutionCode: company.code,
      institutionName: null,
      sector: null,
      matchBasis: "exact_company_code",
      identityMatch: null,
      reasonCodes: ["financial_institution_code_not_unique"],
      catalogCandidates,
    };
  }

  const [institution] = candidates;
  const matchedIdentity = identityMatch(company, institution);
  const supportedSector = SUPPORTED_SECTORS.has(
    institution.sector as SupportedFinancialSector,
  )
    ? (institution.sector as SupportedFinancialSector)
    : null;
  if (!supportedSector) {
    return {
      companyCode: company.code,
      companyName: company.name,
      companyShortName: company.shortName,
      market: company.market,
      status: "unsupported_institution_sector",
      institutionCode: institution.code,
      institutionName: institution.name,
      sector: null,
      matchBasis: "exact_company_code",
      identityMatch: matchedIdentity,
      reasonCodes: ["financial_institution_sector_unsupported"],
      catalogCandidates,
    };
  }
  if (matchedIdentity === "mismatch") {
    return {
      companyCode: company.code,
      companyName: company.name,
      companyShortName: company.shortName,
      market: company.market,
      status: "identity_mismatch",
      institutionCode: institution.code,
      institutionName: institution.name,
      sector: supportedSector,
      matchBasis: "exact_company_code",
      identityMatch: matchedIdentity,
      reasonCodes: ["financial_institution_name_mismatch"],
      catalogCandidates,
    };
  }
  return {
    companyCode: company.code,
    companyName: company.name,
    companyShortName: company.shortName,
    market: company.market,
    status: "mapped",
    institutionCode: institution.code,
    institutionName: institution.name,
    sector: supportedSector,
    matchBasis: "exact_company_code",
    identityMatch: matchedIdentity,
    reasonCodes: [],
    catalogCandidates,
  };
}

/**
 * Reconcile current listed/OTC financial stock identities with Mopsfin's
 * financial-institution catalog. Mapping is deliberately exact-code-only;
 * names are an independent identity check and are never used as a fuzzy
 * fallback.
 */
export function buildFinancialInstitutionCoverageReport(
  companies: MasterCompany[],
  catalog: Catalog,
): FinancialInstitutionCoverageReport {
  const institutionsByCode = new Map<string, FinancialInstitutionDefinition[]>();
  for (const institution of catalog.financialInstitutions) {
    const existing = institutionsByCode.get(institution.code) ?? [];
    existing.push(institution);
    institutionsByCode.set(institution.code, existing);
  }

  const financialCompanies = companies
    .filter((company) => company.isFinancial)
    .sort((left, right) => left.code.localeCompare(right.code));
  const mappings = financialCompanies.map((company) =>
    mappingForCompany(company, institutionsByCode.get(company.code) ?? [])
  );
  const count = (status: FinancialInstitutionMapping["status"]) =>
    mappings.filter((mapping) => mapping.status === status).length;
  const bySupportedSector = Object.fromEntries(
    (["holding", "bank", "bills"] as const).map((sector) => [
      sector,
      mappings.filter(
        (mapping) => mapping.status === "mapped" && mapping.sector === sector,
      ).length,
    ]),
  ) as Record<SupportedFinancialSector, number>;
  const mapped = count("mapped");
  const classifiedCount =
    mapped +
    count("institution_not_found") +
    count("duplicate_institution_code") +
    count("unsupported_institution_sector") +
    count("identity_mismatch");
  const mappedInstitutionCodes = mappings.flatMap((mapping) =>
    mapping.status === "mapped" && mapping.institutionCode
      ? [mapping.institutionCode]
      : []
  );
  const masterFinancialCodes = new Set(
    financialCompanies.map((company) => company.code),
  );
  const catalogOnlyInstitutions = catalog.financialInstitutions
    .filter((institution) => !masterFinancialCodes.has(institution.code))
    .map(({ code, name, sector }) => ({ code, name, sector }))
    .sort((left, right) =>
      left.code.localeCompare(right.code) || left.name.localeCompare(right.name)
    );
  const catalogSnapshotId = financialCatalogSnapshotId(catalog);
  const snapshotId = `financial-mapping-${createHash("sha256")
    .update(JSON.stringify({
      mappingContractVersion: "financial_institution_mapping.v1",
      catalogSnapshotId,
      mappings,
      catalogOnlyInstitutions,
    }))
    .digest("hex")}`;
  const coverageComplete = mapped === mappings.length;

  return {
    mappingContractVersion: "financial_institution_mapping.v1",
    scope: "current_listed_otc_financial_companies",
    catalogDiscoveredAt: catalog.discoveredAt,
    catalogSnapshotId,
    snapshotId,
    coverageComplete,
    counts: {
      financialCompanies: mappings.length,
      mapped,
      institutionNotFound: count("institution_not_found"),
      duplicateInstitutionCode: count("duplicate_institution_code"),
      unsupportedInstitutionSector: count("unsupported_institution_sector"),
      identityMismatch: count("identity_mismatch"),
      catalogInstitutions: catalog.financialInstitutions.length,
      catalogOnlyInstitutions: catalogOnlyInstitutions.length,
      bySupportedSector,
    },
    mappings,
    catalogOnlyInstitutions,
    reconciliation: {
      everyFinancialCompanyClassified: classifiedCount === mappings.length,
      oneToOneMappingVerified:
        new Set(mappedInstitutionCodes).size === mappedInstitutionCodes.length,
      countsReconcile: classifiedCount === mappings.length,
    },
    warnings: coverageComplete
      ? []
      : [
          "部分金融股無法以公司代號唯一對應到受支援的 Mopsfin 金融機構；不得模糊配對、默默略過或當成篩選失敗。",
        ],
  };
}
