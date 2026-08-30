import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  FinancialInstitutionMetricsBatchClient,
} from "@/lib/financial-screening/institution-batch";
import { resolveFinancialScreenMetricRoles } from "@/lib/financial-screening/metric-roles";
import type { FinancialInstitutionMapping } from "@/lib/financial-screening/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { parseCatalogHtml } from "@/lib/mopsfin/catalog";
import type { MopsfinClient } from "@/lib/mopsfin/client";
import type { FinancialInstitutionDefinition } from "@/lib/mopsfin/types";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);
const resolution = resolveFinancialScreenMetricRoles(parseCatalogHtml(catalogHtml));

function mapping(
  companyCode: string,
  institutionName: string,
  sector: "holding" | "bank" | "bills",
): FinancialInstitutionMapping {
  return {
    companyCode,
    companyName: institutionName,
    companyShortName: institutionName,
    market: "listed",
    status: "mapped",
    institutionCode: companyCode,
    institutionName,
    sector,
    matchBasis: "exact_company_code",
    identityMatch: "company_short_name",
    reasonCodes: [],
    catalogCandidates: [{ code: companyCode, name: institutionName, sector }],
  };
}

function metricResult(
  metricCode: string,
  institutions: FinancialInstitutionDefinition[],
) {
  return {
    sourceName: "Mopsfin",
    sourceUrl: "https://mopsfin.twse.com.tw/",
    retrievedAt: "2026-08-30T00:00:00.000Z",
    upstreamRoute: metricCode.startsWith("Fin")
      ? "/compare/fin"
      : "/compare/adequacy",
    freshnessNote: "test",
    query: {
      metricCode,
      metricName: metricCode,
      institutionCodes: institutions.map(({ code }) => code),
      institutions: institutions.map(({ name }) => name),
      includeIndustryAverage: true,
      includeInstitutionAverage: false,
      history: "recent_12" as const,
    },
    unit: "%",
    periods: ["2025Q4", "2026Q2"],
    series: [
      ...institutions.map((institution, index) => ({
        label: institution.name,
        seriesType: "institution" as const,
        institutionCode: institution.code,
        institutionName: institution.name,
        institutionSector: institution.sector,
        points: [
          { period: "2025Q4", value: 10 + index, valueStatus: "reported" as const },
          { period: "2026Q2", value: 11 + index, valueStatus: "reported" as const },
        ],
      })),
      {
        label: "業別平均",
        seriesType: "industry_average" as const,
        points: [
          { period: "2025Q4", value: 9, valueStatus: "reported" as const },
          { period: "2026Q2", value: 10, valueStatus: "reported" as const },
        ],
      },
    ],
    coverage: {
      selectionComplete: true,
      requestedInstitutionCodes: institutions.map(({ code }) => code),
      returnedInstitutionCodes: institutions.map(({ code }) => code),
      missingInstitutionCodes: [],
      noValidDataInstitutionCodes: [],
      commonThroughPeriod: "2026Q2",
      institutions: institutions.map(({ code }) => ({
        institutionCode: code,
        seriesReturned: true,
        nonNullPoints: 2,
        missingPoints: 0,
        invalidPoints: 0,
        firstReportedPeriod: "2025Q4",
        latestReportedPeriod: "2026Q2",
        missingPeriods: [],
      })),
    },
    warnings: [],
  };
}

function dependency(
  implementation: (
    input: Parameters<MopsfinClient["getFinancialInstitutionMetric"]>[0],
  ) => Promise<ReturnType<typeof metricResult>>,
) {
  const getFinancialInstitutionMetric = vi.fn(implementation);
  return {
    getFinancialInstitutionMetric,
    client: new FinancialInstitutionMetricsBatchClient(
      { getFinancialInstitutionMetric } as unknown as Pick<
        MopsfinClient,
        "getFinancialInstitutionMetric"
      >,
      () => new Date("2026-08-30T00:00:00.000Z"),
    ),
  };
}

describe("FinancialInstitutionMetricsBatchClient", () => {
  it("routes only applicable subtype metrics and marks the rest not_applicable", async () => {
    const holding = mapping("2881", "富邦金", "holding");
    const bank = mapping("2801", "彰銀", "bank");
    const fixture = dependency(async (input) =>
      metricResult(
        input.metricCode,
        input.institutionCodes.map((code) => ({
          code,
          name: code === "2881" ? "富邦金" : "彰銀",
          sector: code === "2881" ? "holding" : "bank",
        })),
      )
    );

    const result = await fixture.client.getFinancialInstitutionMetricsBatch({
      mappings: [holding, bank],
      metricRoles: [
        "holding_capital_adequacy_ratio",
        "bank_capital_adequacy_ratio",
        "loan_overdue_ratio",
      ],
      resolution,
    });

    expect(fixture.getFinancialInstitutionMetric).toHaveBeenCalledTimes(3);
    expect(
      fixture.getFinancialInstitutionMetric.mock.calls.map(([input]) => [
        input.metricCode,
        input.institutionCodes,
      ]),
    ).toEqual([
      ["HoldingCAR", ["2881"]],
      ["BankCAR", ["2801"]],
      ["Fin01", ["2801"]],
    ]);
    expect(result.companies[0].metrics.map(({ availability }) => availability)).toEqual([
      "available",
      "not_applicable",
      "not_applicable",
    ]);
    expect(result.companies[1].metrics.map(({ availability }) => availability)).toEqual([
      "not_applicable",
      "available",
      "available",
    ]);
    expect(result.workBudget).toMatchObject({
      comparisonPlanUnits: 3,
      comparisonExecutedUnits: 3,
      concurrencyLimit: 2,
    });
    expect(result.coverage.selectionComplete).toBe(true);
  });

  it("preserves NO_DATA as no_data instead of unavailable or zero", async () => {
    const fixture = dependency(async () => {
      throw new MopsfinError("NO_DATA", "查無資料");
    });

    const result = await fixture.client.getFinancialInstitutionMetricsBatch({
      mappings: [mapping("2801", "彰銀", "bank")],
      metricRoles: ["loan_overdue_ratio"],
      resolution,
    });

    expect(result.failures).toEqual([]);
    expect(result.companies[0].metrics[0]).toMatchObject({
      availability: "no_data",
      points: [],
      failure: null,
    });
    expect(result.coverage).toMatchObject({
      selectionComplete: false,
      noValidDataCompanyCodes: ["2801"],
      unavailableCompanyCodes: [],
    });
  });

  it("bisects deterministic chunk failures and preserves healthy institutions", async () => {
    const fixture = dependency(async (input) => {
      if (input.institutionCodes.length > 1 || input.institutionCodes[0] === "2812") {
        throw new MopsfinError("UPSTREAM_BAD_RESPONSE", "bad institution", {
          reason: "TEST_BAD_INSTITUTION",
          retryable: false,
        });
      }
      return metricResult(input.metricCode, [
        { code: "2801", name: "彰銀", sector: "bank" },
      ]);
    });

    const result = await fixture.client.getFinancialInstitutionMetricsBatch({
      mappings: [
        mapping("2801", "彰銀", "bank"),
        mapping("2812", "台中銀", "bank"),
      ],
      metricRoles: ["bank_capital_adequacy_ratio"],
      resolution,
    });

    expect(fixture.getFinancialInstitutionMetric).toHaveBeenCalledTimes(3);
    expect(result.workBudget).toMatchObject({
      comparisonPlanUnits: 1,
      isolationRetryUnits: 2,
      comparisonExecutedUnits: 3,
    });
    expect(result.companies.map(({ companyCode, evaluationStatus }) => [
      companyCode,
      evaluationStatus,
    ])).toEqual([
      ["2801", "complete"],
      ["2812", "unavailable"],
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyCode: "2812",
        attribution: "institution",
        reason: "TEST_BAD_INSTITUTION",
      }),
    ]);
    expect(result.coverage.failureIsolationComplete).toBe(true);
  });
});
