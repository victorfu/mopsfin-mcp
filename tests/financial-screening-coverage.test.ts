import { describe, expect, it } from "vitest";

import type { MasterCompany } from "@/lib/company-master/types";
import { buildFinancialInstitutionCoverageReport } from "@/lib/financial-screening/coverage";
import type { Catalog } from "@/lib/mopsfin/types";

function company(
  code: string,
  shortName: string,
  options: { name?: string; isFinancial?: boolean } = {},
): MasterCompany {
  return {
    code,
    name: options.name ?? shortName,
    shortName,
    market: "listed",
    exchange: "TWSE",
    industryCode: options.isFinancial === false ? "24" : "17",
    listingDate: "2001-01-01",
    incorporationDate: null,
    paidInCapitalTwd: null,
    issuedCommonShares: null,
    parValueText: null,
    financialReportTypeCode: null,
    profileValueStatus: {
      incorporationDate: "missing",
      paidInCapitalTwd: "missing",
      issuedCommonShares: "missing",
      parValueText: "missing",
      financialReportTypeCode: "missing",
    },
    domicileCode: "TW",
    isKy: false,
    isFinancial: options.isFinancial ?? true,
  };
}

function catalog(
  financialInstitutions: Catalog["financialInstitutions"],
): Catalog {
  return {
    metrics: [],
    industries: [],
    financialInstitutions,
    years: [2025, 2026],
    quarters: [1, 2, 3, 4],
    discoveredAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("buildFinancialInstitutionCoverageReport", () => {
  it("maps current financial stocks by exact code and audits the identity name", () => {
    const report = buildFinancialInstitutionCoverageReport(
      [company("2881", "富邦金"), company("2330", "台積電", { isFinancial: false })],
      catalog([{ code: "2881", name: "富邦金", sector: "holding" }]),
    );

    expect(report).toMatchObject({
      coverageComplete: true,
      counts: {
        financialCompanies: 1,
        mapped: 1,
        bySupportedSector: { holding: 1, bank: 0, bills: 0 },
      },
      mappings: [
        {
          companyCode: "2881",
          status: "mapped",
          institutionCode: "2881",
          sector: "holding",
          matchBasis: "exact_company_code",
          identityMatch: "company_short_name",
          reasonCodes: [],
        },
      ],
      warnings: [],
    });
  });

  it("accounts for every unsupported or unsafe mapping without fuzzy fallback", () => {
    const report = buildFinancialInstitutionCoverageReport(
      [
        company("2801", "彰銀"),
        company("2812", "台中銀"),
        company("2823", "中壽"),
        company("2834", "臺企銀"),
      ],
      catalog([
        { code: "2812", name: "台中銀", sector: "bank" },
        { code: "2812", name: "台中銀行", sector: "bank" },
        { code: "2823", name: "中壽", sector: "unknown" },
        { code: "2834", name: "另一家公司", sector: "bank" },
      ]),
    );

    expect(report.coverageComplete).toBe(false);
    expect(report.counts).toEqual({
      financialCompanies: 4,
      mapped: 0,
      institutionNotFound: 1,
      duplicateInstitutionCode: 1,
      unsupportedInstitutionSector: 1,
      identityMismatch: 1,
      bySupportedSector: { holding: 0, bank: 0, bills: 0 },
    });
    expect(report.mappings.map(({ companyCode, status }) => [companyCode, status])).toEqual([
      ["2801", "institution_not_found"],
      ["2812", "duplicate_institution_code"],
      ["2823", "unsupported_institution_sector"],
      ["2834", "identity_mismatch"],
    ]);
    expect(report.warnings.join(" ")).toContain("不得模糊配對");
  });

  it("accepts an exact normalized full company name when the short name differs", () => {
    const report = buildFinancialInstitutionCoverageReport(
      [company("2872", "台灣票券", { name: "臺灣票券金融股份有限公司" })],
      catalog([
        { code: "2872", name: "臺灣票券金融股份有限公司", sector: "bills" },
      ]),
    );

    expect(report.mappings[0]).toMatchObject({
      status: "mapped",
      sector: "bills",
      identityMatch: "company_name",
    });
  });
});
