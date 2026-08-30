import { describe, expect, it } from "vitest";

import { companyMasterClient } from "@/lib/company-master/client";
import { buildFinancialInstitutionCoverageReport } from "@/lib/financial-screening/coverage";
import {
  resolveFinancialScreenMetricRoles,
  resolvedFinancialMetric,
} from "@/lib/financial-screening/metric-roles";
import type {
  FinancialInstitutionMapping,
  SupportedFinancialSector,
} from "@/lib/financial-screening/types";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { asMopsfinError } from "@/lib/mopsfin/errors";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

const capitalRoleBySector = {
  holding: "holding_capital_adequacy_ratio",
  bank: "bank_capital_adequacy_ratio",
  bills: "bills_capital_adequacy_ratio",
} as const;

liveDescribe("live financial screening mapping and coverage contract", () => {
  it("reconciles every current financial company without fuzzy mapping", async () => {
    const [master, catalog] = await Promise.all([
      companyMasterClient.listCompanies({
        market: "all",
        includeFinancial: true,
        includeKy: true,
      }),
      mopsfinClient.getCatalog(true),
    ]);
    const financialCompanies = master.companies.filter(
      (company) => company.isFinancial,
    );
    const report = buildFinancialInstitutionCoverageReport(
      master.companies,
      catalog,
    );

    expect(report.mappingContractVersion).toBe(
      "financial_institution_mapping.v1",
    );
    expect(report.snapshotId).toMatch(/^financial-mapping-[a-f0-9]{64}$/);
    expect(report.counts.financialCompanies).toBe(financialCompanies.length);
    expect(report.mappings).toHaveLength(financialCompanies.length);
    expect(report.reconciliation).toEqual({
      everyFinancialCompanyClassified: true,
      oneToOneMappingVerified: true,
      countsReconcile: true,
    });
    expect(
      report.counts.mapped +
        report.counts.institutionNotFound +
        report.counts.duplicateInstitutionCode +
        report.counts.unsupportedInstitutionSector +
        report.counts.identityMismatch,
    ).toBe(report.counts.financialCompanies);
    expect(report.counts.catalogInstitutions).toBe(
      catalog.financialInstitutions.length,
    );
    expect(report.counts.mapped).toBeGreaterThan(0);
    expect(
      report.mappings
        .filter((mapping) => mapping.status === "mapped")
        .every(
          (mapping) =>
            mapping.matchBasis === "exact_company_code" &&
            mapping.institutionCode === mapping.companyCode &&
            mapping.identityMatch !== "mismatch",
        ),
    ).toBe(true);
  }, 120_000);

  it("binds at least one subtype-routed capital series to institution identity", async () => {
    const [master, catalog] = await Promise.all([
      companyMasterClient.listCompanies({
        market: "all",
        includeFinancial: true,
        includeKy: true,
      }),
      mopsfinClient.getCatalog(),
    ]);
    const resolution = resolveFinancialScreenMetricRoles(catalog);
    const report = buildFinancialInstitutionCoverageReport(
      master.companies,
      catalog,
    );
    const mappedBySector = (["holding", "bank", "bills"] as const).flatMap(
      (sector) => {
        const mapping = report.mappings.find(
          (candidate): candidate is FinancialInstitutionMapping & {
            status: "mapped";
            institutionCode: string;
            sector: SupportedFinancialSector;
          } =>
            candidate.status === "mapped" &&
            candidate.institutionCode !== null &&
            candidate.sector === sector,
        );
        return mapping ? [mapping] : [];
      },
    );
    expect(mappedBySector.length).toBeGreaterThan(0);

    let verified = false;
    const noDataSectors: SupportedFinancialSector[] = [];
    for (const mapping of mappedBySector) {
      const role = capitalRoleBySector[mapping.sector];
      const metric = resolvedFinancialMetric(resolution, role);
      try {
        const result = await mopsfinClient.getFinancialInstitutionMetric({
          metricCode: metric.metricCode,
          institutionCodes: [mapping.institutionCode],
          includeIndustryAverage: true,
          includeInstitutionAverage: false,
          range: { history: "recent_12" },
        });
        expect(result.coverage).toMatchObject({
          selectionComplete: true,
          requestedInstitutionCodes: [mapping.institutionCode],
          returnedInstitutionCodes: [mapping.institutionCode],
          noValidDataInstitutionCodes: [],
        });
        expect(result.series).toContainEqual(
          expect.objectContaining({
            seriesType: "institution",
            institutionCode: mapping.institutionCode,
            institutionSector: mapping.sector,
          }),
        );
        verified = true;
        break;
      } catch (error) {
        const normalized = asMopsfinError(error);
        if (normalized.code !== "NO_DATA") throw error;
        noDataSectors.push(mapping.sector);
      }
    }
    expect(
      verified,
      `mapped subtypes all returned explicit NO_DATA: ${noDataSectors.join(",")}`,
    ).toBe(true);
  }, 120_000);
});
