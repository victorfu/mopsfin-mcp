import { describe, expect, it } from "vitest";

import {
  companyCatalystSnapshotsInputSchema,
  companyCatalystSnapshotsOutputSchema,
} from "@/lib/mcp/schemas";
import { buildResultMeta } from "@/lib/mcp/result-contract";

function fixtureData() {
  return {
    query: {
      companyCodes: ["2412"],
      snapshotTypes: ["forecast_achievement" as const],
      companyMarkets: [
        { companyCode: "2412", market: "listed" as const },
      ],
      asOf: "latest" as const,
      offset: 0,
      limit: 50,
    },
    generatedAt: "2026-08-28T00:00:00.000Z",
    timezone: "Asia/Taipei" as const,
    scope: "current_official_company_snapshots" as const,
    isConsensus: false as const,
    records: [
      {
        recordId: "fixture-catalyst-snapshot-record",
        snapshotType: "forecast_achievement" as const,
        companyCode: "2412",
        companyName: "中華電",
        market: "listed" as const,
        sourceMode: "current_official_snapshot" as const,
        sourceSnapshotDate: "2026-08-27",
        sourceSnapshotAgeDays: 1,
        freshness: "within_expected_window" as const,
        pointInTimeHistoryAvailable: false as const,
        firstKnownAt: null,
        isConsensus: false as const,
        upcomingEligible: false,
        sourceKey: "twse_forecast_achievement_current" as const,
        sourceUrl:
          "https://openapi.twse.com.tw/v1/opendata/t187ap15_L",
        sourceRecordKey: "2412:115:2:0",
        details: {
          kind: "forecast_achievement" as const,
          fiscalYear: 2026,
          fiscalYearRaw: "115",
          quarter: 2 as const,
          forecastSequence: "0",
          coveragePeriod: "一、二、三、四",
          actualCumulative: 20_593_145,
          actualCumulativeRaw: "20593145.00",
          valueUnit: "source_not_declared" as const,
          forecastCumulative: {
            raw: "9232695~9249329",
            lower: 9_232_695,
            upper: 9_249_329,
            unit: "source_not_declared" as const,
          },
        },
      },
    ],
    sources: [
      {
        snapshotType: "forecast_achievement" as const,
        market: "listed" as const,
        exchange: "TWSE" as const,
        sourceKey: "twse_forecast_achievement_current" as const,
        sourceName: "臺灣證券交易所－上市公司財務預測達成情形",
        sourceUrl:
          "https://openapi.twse.com.tw/v1/opendata/t187ap15_L",
        sourceMode: "current_official_snapshot" as const,
        pointInTimeHistoryAvailable: false as const,
        isConsensus: false as const,
        requestedCompanyCodes: ["2412"],
        status: "nonempty" as const,
        freshness: "within_expected_window" as const,
        retrievedAt: "2026-08-28T00:00:00.000Z",
        sourceSnapshotDate: "2026-08-27",
        sourceSnapshotAgeDays: 1,
        rawRowCount: 8,
        eligibleRecordCount: 8,
        duplicateRecordCount: 0,
        selectedRecordCount: 1,
        emptyVerification: "not_applicable" as const,
        officialDeclaredRowCount: null,
        rowsetCompleteness:
          "unverified_no_official_declared_count" as const,
        snapshotIdentity: "fixture-catalyst-source-snapshot",
        failureId: null,
      },
    ],
    coverage: {
      sourceComplete: true,
      selection: "complete" as const,
      failureIsolation: "per_snapshot_type_market" as const,
      snapshots: [
        {
          companyCode: "2412",
          snapshotType: "forecast_achievement" as const,
          routedMarkets: ["listed" as const],
          status: "complete" as const,
          disclosureStatus: "disclosed" as const,
          identityStatus: "verified_current_master_hint" as const,
          resolvedMarket: "listed" as const,
          freshness: "within_expected_window" as const,
          recordCount: 1,
          sourceKeys: ["twse_forecast_achievement_current" as const],
          failureIds: [],
        },
      ],
    },
    companies: [
      {
        companyCode: "2412",
        status: "complete" as const,
        identityStatus: "verified_current_master_hint" as const,
        resolvedMarket: "listed" as const,
        recordCount: 1,
        disclosedSnapshotTypes: ["forecast_achievement" as const],
        notDisclosedSnapshotTypes: [],
        staleSnapshotTypes: [],
        unsupportedSnapshotTypes: [],
        failedSnapshotTypes: [],
      },
    ],
    failures: [],
    counts: {
      requestedCompanies: 1,
      requestedSnapshotTypes: 1,
      totalRecords: 1,
      returnedRecords: 1,
      completeCompanies: 1,
      partialCompanies: 0,
      failedCompanies: 0,
      nonemptySources: 1,
      verifiedEmptySources: 0,
      staleSources: 0,
      failedSources: 0,
      unsupportedSources: 0,
    },
    workBudget: {
      companyCount: 1,
      snapshotTypeCount: 1,
      plannedSourceRoutes: 1,
      supportedSourceQueries: 1,
      unsupportedSourceRoutes: 0,
      sourceQueryLimit: 8 as const,
    },
    pagination: {
      offset: 0,
      limit: 50,
      totalRows: 1,
      returnedRows: 1,
      hasMore: false,
      nextOffset: null,
    },
    fingerprint: "fixture-catalyst-snapshot-fingerprint",
    warnings: [
      "Current official snapshots 不是 point-in-time 歷史資料。",
    ],
  };
}

describe("company catalyst snapshots MCP contract", () => {
  it("defaults to latest, all four snapshot families and bounded pagination", () => {
    expect(
      companyCatalystSnapshotsInputSchema.parse({
        company_codes: ["2412"],
      }),
    ).toEqual({
      company_codes: ["2412"],
      snapshot_types: [
        "forecast_achievement",
        "forecast_material_variance",
        "shareholder_meeting",
        "dividend_decision",
      ],
      as_of: "latest",
      offset: 0,
      limit: 50,
    });
  });

  it("rejects duplicate identities/families, historical as-of, extra fields and page overflow", () => {
    expect(
      companyCatalystSnapshotsInputSchema.safeParse({
        company_codes: ["2412", "2412"],
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsInputSchema.safeParse({
        company_codes: ["2412"],
        snapshot_types: ["shareholder_meeting", "shareholder_meeting"],
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsInputSchema.safeParse({
        company_codes: ["2412"],
        as_of: "2026-08-27",
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsInputSchema.safeParse({
        company_codes: ["2412"],
        limit: 101,
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsInputSchema.safeParse({
        company_codes: ["2412"],
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("accepts source-backed current evidence with source snapshot cutoffs", () => {
    const data = fixtureData();
    const envelope = {
      ok: true as const,
      meta: buildResultMeta(
        data,
        {
          selector: "latest",
          resolved: {
            granularity: "date",
            from: "2026-08-27",
            through: "2026-08-27",
          },
          source: "complete",
          universe: "verified",
          selection: "complete",
          values: "complete",
          freshness: "within_expected_window",
          snapshotId: data.fingerprint,
        },
        data.generatedAt,
      ),
      ...data,
    };

    const parsed = companyCatalystSnapshotsOutputSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.meta.asOf.sourceCutoffs[0]).toMatchObject({
      publishedAt: "2026-08-27",
      resolved: {
        granularity: "date",
        from: "2026-08-27",
        through: "2026-08-27",
      },
    });
  });

  it("forbids consensus claims, forecast upcoming flags and contradictory source states", () => {
    const data = fixtureData();
    const envelope = {
      ok: true as const,
      meta: buildResultMeta(data),
      ...data,
    };
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        isConsensus: true,
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        records: data.records.map((record) => ({
          ...record,
          upcomingEligible: true,
        })),
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        companies: data.companies.map((company) => ({
          ...company,
          status: "partial",
          disclosedSnapshotTypes: [],
          notDisclosedSnapshotTypes: ["forecast_achievement"],
        })),
        counts: {
          ...data.counts,
          completeCompanies: 0,
          partialCompanies: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        sources: data.sources.map((source) => ({
          ...source,
          status: "verified_empty",
          emptyVerification: "not_applicable",
        })),
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        counts: { ...data.counts, returnedRecords: 0 },
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        pagination: { ...data.pagination, hasMore: true, nextOffset: 1 },
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        sources: data.sources.map((source) => ({
          ...source,
          freshness: "stale",
        })),
      }).success,
    ).toBe(false);
    expect(
      companyCatalystSnapshotsOutputSchema.safeParse({
        ...envelope,
        records: data.records.map((record) => ({
          ...record,
          sourceSnapshotDate: "2026-08-29",
          sourceSnapshotAgeDays: 0,
        })),
      }).success,
    ).toBe(false);
  });
});
