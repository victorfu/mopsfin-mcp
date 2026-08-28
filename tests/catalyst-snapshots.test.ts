import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CompanyCatalystSnapshotClient,
  type CompanyCatalystSnapshotsJsonLoader,
} from "@/lib/catalyst/snapshot-client";
import { MopsfinError } from "@/lib/mopsfin/errors";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as unknown;
}

const forecastAchievement = fixture(
  "catalyst-snapshot-twse-forecast-achievement.json",
);
const forecastVariance = fixture(
  "catalyst-snapshot-twse-forecast-variance.json",
);
const tpexForecastEmpty = fixture(
  "catalyst-snapshot-tpex-forecast-achievement-empty.json",
);
const tpexVarianceStaleEmpty = fixture(
  "catalyst-snapshot-tpex-forecast-variance-stale-empty.json",
);
const twseMeetings = fixture("catalyst-snapshot-twse-meetings.json");
const tpexMeetings = fixture("catalyst-snapshot-tpex-meetings.json");
const twseDividends = fixture("catalyst-snapshot-twse-dividends.json");
const now = () => new Date("2026-08-28T04:00:00.000Z");

function loaderFor(
  entries: Record<string, unknown | Error>,
): CompanyCatalystSnapshotsJsonLoader & {
  get: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async (config) => {
      const value = entries[config.sourceUrl];
      if (value instanceof Error) throw value;
      if (value === undefined) {
        throw new Error(`Missing fixture for ${config.sourceUrl}`);
      }
      return {
        payload: structuredClone(value),
        retrievedAt: "2026-08-28T04:00:00.000Z",
      };
    }),
  };
}

function clientWith(entries: Record<string, unknown | Error>) {
  const loader = loaderFor(entries);
  return {
    client: new CompanyCatalystSnapshotClient(fetch, now, {
      jsonLoader: loader,
    }),
    loader,
  };
}

describe("CompanyCatalystSnapshotClient official current snapshots", () => {
  it("preserves issuer forecast raw values and range bounds without inventing consensus or units", async () => {
    const { client, loader } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L":
        forecastAchievement,
      "https://openapi.twse.com.tw/v1/opendata/t187ap16_L": forecastVariance,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["2412"],
      companyMarkets: [{ companyCode: "2412", market: "listed" }],
      snapshotTypes: [
        "forecast_achievement",
        "forecast_material_variance",
      ],
      asOf: "latest",
    });

    expect(loader.get).toHaveBeenCalledTimes(2);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      snapshotType: "forecast_achievement",
      sourceSnapshotDate: "2026-08-27",
      sourceSnapshotAgeDays: 1,
      freshness: "within_expected_window",
      sourceMode: "current_official_snapshot",
      pointInTimeHistoryAvailable: false,
      firstKnownAt: null,
      isConsensus: false,
      upcomingEligible: false,
      details: {
        kind: "forecast_achievement",
        fiscalYear: 2026,
        quarter: 2,
        actualCumulative: 20_593_145,
        actualCumulativeRaw: "20593145.00",
        valueUnit: "source_not_declared",
        forecastCumulative: {
          raw: "9232695~9249329",
          lower: 9_232_695,
          upper: 9_249_329,
          unit: "source_not_declared",
        },
      },
    });
    expect(result.records[1]).toMatchObject({
      snapshotType: "forecast_material_variance",
      details: {
        kind: "forecast_material_variance",
        selectionBasis: "official_dataset_membership",
        officialSelectionRule:
          "quarter_difference_at_least_10_percent_or_cumulative_difference_at_least_20_percent",
        thresholdDetail: null,
      },
    });
    expect(result.coverage).toMatchObject({
      sourceComplete: true,
      selection: "complete",
      failureIsolation: "per_snapshot_type_market",
    });
    expect(result.workBudget).toMatchObject({
      companyCount: 1,
      snapshotTypeCount: 2,
      plannedSourceRoutes: 2,
      supportedSourceQueries: 2,
      unsupportedSourceRoutes: 0,
      sourceQueryLimit: 8,
    });
  });

  it("marks only a fresh future shareholder meeting as upcoming eligible", async () => {
    const { client } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap41_L": twseMeetings,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      companyMarkets: [{ companyCode: "1101", market: "listed" }],
      snapshotTypes: ["shareholder_meeting"],
    });

    expect(result.records).toHaveLength(2);
    expect(
      result.records.find(
        (record) =>
          record.details.kind === "shareholder_meeting" &&
          record.details.meetingDate === "2026-10-13",
      ),
    ).toMatchObject({
      upcomingEligible: true,
      details: {
        meetingType: "臨時會",
        meetingLocation: "臺北市中山北路二段113號3樓",
        directorSupervisorElection: "否",
        electronicVoting: "強制",
      },
    });
    expect(
      result.records.find(
        (record) =>
          record.details.kind === "shareholder_meeting" &&
          record.details.meetingDate === "2026-05-22",
      )?.upcomingEligible,
    ).toBe(false);
  });

  it("uses one Taipei evaluation anchor even if the request spans local midnight", async () => {
    const loader = loaderFor({
      "https://openapi.twse.com.tw/v1/opendata/t187ap41_L": twseMeetings,
    });
    const instants = [
      new Date("2026-08-28T15:59:59.000Z"),
      new Date("2026-08-28T16:00:01.000Z"),
    ];
    const nowSpy = vi.fn(() => instants.shift() ?? new Date("2026-08-28T16:00:01.000Z"));
    const client = new CompanyCatalystSnapshotClient(fetch, nowSpy, {
      jsonLoader: loader,
    });

    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      companyMarkets: [{ companyCode: "1101", market: "listed" }],
      snapshotTypes: ["shareholder_meeting"],
    });

    expect(nowSpy).toHaveBeenCalledTimes(1);
    expect(result.generatedAt).toBe("2026-08-28T15:59:59.000Z");
    expect(result.sources[0].sourceSnapshotAgeDays).toBe(1);
  });

  it("accepts official preferred-security rows while selecting only requested four-digit companies", async () => {
    const { client } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap45_L": twseDividends,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      snapshotTypes: ["dividend_decision"],
    });

    expect(result.records).toHaveLength(1);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: "twse_dividend_decision_current",
          rawRowCount: 2,
          eligibleRecordCount: 2,
          selectedRecordCount: 1,
        }),
        expect.objectContaining({
          sourceKey: "tpex_dividend_decision_current_unsupported",
          sourceUrl: null,
          status: "unsupported",
        }),
      ]),
    );
    expect(result.records[0]).toMatchObject({
      companyCode: "1101",
      market: "listed",
      upcomingEligible: false,
      firstKnownAt: null,
      details: {
        kind: "dividend_decision",
        decisionStage: "董事會決議 / 股東會確認",
        dividendYear: 2025,
        periodRaw: "1140101~1141231",
        periodStart: "2025-01-01",
        periodEnd: "2025-12-31",
        boardDecisionDate: "2026-03-11",
        shareholderMeetingDate: "2026-05-22",
        cashDividend: {
          earningsPerShare: 0,
          capitalReservePerShare: 0.8,
          totalAmount: 5_994_545_394,
        },
        stockDividend: { totalShares: 0 },
      },
    });
    expect(result.companies[0]).toMatchObject({
      identityStatus: "verified_official_record",
      resolvedMarket: "listed",
    });
  });

  it("returns unsupported-only TPEx dividend scope as partial success without an HTTP query", async () => {
    const { client, loader } = clientWith({});
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["3105"],
      companyMarkets: [{ companyCode: "3105", market: "otc" }],
      snapshotTypes: ["dividend_decision"],
    });

    expect(loader.get).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.coverage).toMatchObject({
      sourceComplete: false,
      selection: "partial",
      snapshots: [
        expect.objectContaining({
          status: "unsupported",
          disclosureStatus: "unsupported",
          identityStatus: "verified_current_master_hint",
        }),
      ],
    });
    expect(result.companies[0].status).toBe("partial");
    expect(result.workBudget).toMatchObject({
      plannedSourceRoutes: 1,
      supportedSourceQueries: 0,
      unsupportedSourceRoutes: 1,
    });
  });

  it("distinguishes fresh verified empty from stale blank-sentinel evidence", async () => {
    const { client } = clientWith({
      "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O":
        tpexForecastEmpty,
      "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap16_O":
        tpexVarianceStaleEmpty,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["3105"],
      companyMarkets: [{ companyCode: "3105", market: "otc" }],
      snapshotTypes: [
        "forecast_achievement",
        "forecast_material_variance",
      ],
    });

    expect(result.sources[0]).toMatchObject({
      status: "verified_empty",
      freshness: "within_expected_window",
      emptyVerification: "official_blank_sentinel",
    });
    expect(result.sources[1]).toMatchObject({
      status: "verified_empty",
      freshness: "stale",
      sourceSnapshotDate: "2021-04-16",
    });
    expect(result.coverage.snapshots).toEqual([
      expect.objectContaining({
        snapshotType: "forecast_achievement",
        status: "complete",
        disclosureStatus: "not_disclosed_in_snapshot",
      }),
      expect.objectContaining({
        snapshotType: "forecast_material_variance",
        status: "partial",
        disclosureStatus: "unknown_stale_snapshot",
      }),
    ]);
    expect(result.coverage.sourceComplete).toBe(false);
  });

  it("deduplicates identical stable identities and fails closed on conflicting content", async () => {
    const baseRow = (
      forecastAchievement as Array<Record<string, unknown>>
    )[0];
    const duplicateClient = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L": [
        baseRow,
        structuredClone(baseRow),
      ],
    }).client;
    const duplicate = await duplicateClient.getCompanyCatalystSnapshots({
      companyCodes: ["2412"],
      companyMarkets: [{ companyCode: "2412", market: "listed" }],
      snapshotTypes: ["forecast_achievement"],
    });
    expect(duplicate.records).toHaveLength(1);
    expect(duplicate.sources[0]).toMatchObject({
      rawRowCount: 2,
      eligibleRecordCount: 1,
      duplicateRecordCount: 1,
    });

    const conflictClient = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L": [
        baseRow,
        {
          ...baseRow,
          截至該季經會計師查核或核閱數: "20593146.00",
        },
      ],
      "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O":
        tpexForecastEmpty,
    }).client;
    const conflict = await conflictClient.getCompanyCatalystSnapshots({
      companyCodes: ["2412"],
      snapshotTypes: ["forecast_achievement"],
    });
    expect(conflict.failures).toEqual([
      expect.objectContaining({ reason: "UPSTREAM_CONFLICTING_DUPLICATE" }),
    ]);
    expect(conflict.records).toEqual([]);

    const changed = await clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L": [
        {
          ...baseRow,
          截至該季經會計師查核或核閱數: "20593146.00",
        },
      ],
    }).client.getCompanyCatalystSnapshots({
      companyCodes: ["2412"],
      companyMarkets: [{ companyCode: "2412", market: "listed" }],
      snapshotTypes: ["forecast_achievement"],
    });
    expect(changed.records[0].recordId).toBe(duplicate.records[0].recordId);
    expect(changed.fingerprint).not.toBe(duplicate.fingerprint);
  });

  it("uses dual-market safe probes and refuses to call absence not-disclosed when identity is unverified", async () => {
    const { client, loader } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L":
        forecastAchievement,
      "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O":
        tpexForecastEmpty,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["2330"],
      snapshotTypes: ["forecast_achievement"],
    });

    expect(loader.get).toHaveBeenCalledTimes(2);
    expect(result.records).toEqual([]);
    expect(result.coverage.snapshots[0]).toMatchObject({
      routedMarkets: ["listed", "otc"],
      status: "partial",
      disclosureStatus: "identity_unverified",
      identityStatus: "unverified",
      resolvedMarket: null,
    });
    expect(result.companies[0]).toMatchObject({
      status: "partial",
      identityStatus: "unverified",
    });
  });

  it("excludes stale same-code records from the other market after fresh identity resolution", async () => {
    const staleListedRows = structuredClone(
      twseMeetings as Array<Record<string, unknown>>,
    ).map((row, index) => ({
      ...row,
      出表日期: "1150801",
      ...(index === 0
        ? { 公司代號: "3105", 公司名稱: "另一市場舊同碼" }
        : {}),
    }));
    const { client } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap41_L":
        staleListedRows,
      "https://www.tpex.org.tw/openapi/v1/t187ap41_O": tpexMeetings,
    });

    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["3105"],
      snapshotTypes: ["shareholder_meeting"],
    });

    expect(result.records).toEqual([
      expect.objectContaining({ companyCode: "3105", market: "otc" }),
    ]);
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKey: "twse_shareholder_meeting_current",
          freshness: "stale",
          selectedRecordCount: 0,
        }),
      ]),
    );
    expect(result.coverage.snapshots[0]).toMatchObject({
      identityStatus: "verified_official_record",
      resolvedMarket: "otc",
      freshness: "within_expected_window",
      recordCount: 1,
    });
    expect(result.companies[0].recordCount).toBe(1);
    expect(result.counts.totalRecords).toBe(1);
    expect(
      result.sources.reduce(
        (sum, source) => sum + source.selectedRecordCount,
        0,
      ),
    ).toBe(result.counts.totalRecords);
    expect(
      result.coverage.snapshots.reduce(
        (sum, snapshot) => sum + snapshot.recordCount,
        0,
      ),
    ).toBe(result.counts.totalRecords);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("已排除 1 筆另一市場")]),
    );
  });

  it("isolates one source failure while retaining another snapshot family", async () => {
    const failure = new MopsfinError("UPSTREAM_TIMEOUT", "fixture timeout", {
      reason: "UPSTREAM_ATTEMPT_TIMEOUT",
      retryable: true,
      action: "retry",
    });
    const { client } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L": failure,
      "https://openapi.twse.com.tw/v1/opendata/t187ap41_L": twseMeetings,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      companyMarkets: [{ companyCode: "1101", market: "listed" }],
      snapshotTypes: ["forecast_achievement", "shareholder_meeting"],
    });

    expect(result.records).toHaveLength(2);
    expect(result.failures).toEqual([
      expect.objectContaining({
        snapshotType: "forecast_achievement",
        market: "listed",
        affectedCompanyCodes: ["1101"],
        code: "UPSTREAM_TIMEOUT",
        retryable: true,
      }),
    ]);
    expect(result.coverage.snapshots[0]).toMatchObject({
      status: "failed",
      disclosureStatus: "unknown_source_failure",
    });
    expect(result.coverage.snapshots[1].status).toBe("complete");
    expect(result.companies[0].status).toBe("partial");
  });

  it("fails closed on non-scalar optional dividend text while preserving other families", async () => {
    const dividendRows = structuredClone(
      twseDividends as Array<Record<string, unknown>>,
    );
    dividendRows[0]["備註"] = { unexpected: "object" };
    const { client } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap41_L": twseMeetings,
      "https://openapi.twse.com.tw/v1/opendata/t187ap45_L": dividendRows,
    });

    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      companyMarkets: [{ companyCode: "1101", market: "listed" }],
      snapshotTypes: ["shareholder_meeting", "dividend_decision"],
    });

    expect(result.records).toHaveLength(2);
    expect(result.records.every((record) => record.snapshotType === "shareholder_meeting")).toBe(true);
    expect(result.failures).toEqual([
      expect.objectContaining({
        snapshotType: "dividend_decision",
        reason: "UPSTREAM_SCHEMA_DRIFT",
      }),
    ]);
    expect(result.coverage.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snapshotType: "dividend_decision",
          disclosureStatus: "unknown_source_failure",
        }),
      ]),
    );
  });

  it("throws one aggregate upstream error when every queried supported source fails", async () => {
    const { client } = clientWith({
      "https://openapi.twse.com.tw/v1/opendata/t187ap15_L": new Error(
        "network down",
      ),
    });
    await expect(
      client.getCompanyCatalystSnapshots({
        companyCodes: ["2412"],
        companyMarkets: [{ companyCode: "2412", market: "listed" }],
        snapshotTypes: ["forecast_achievement"],
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "ALL_CATALYST_SNAPSHOT_SOURCES_FAILED",
    });
  });

  it("fails closed on [], arbitrary blank objects, schema drift, and future snapshot dates", async () => {
    const cases: Array<{ payload: unknown; expectedReason: string }> = [
      { payload: [], expectedReason: "UPSTREAM_UNVERIFIED_EMPTY" },
      { payload: [{ Date: "1150827", message: "" }], expectedReason: "UPSTREAM_SCHEMA_DRIFT" },
      {
        payload: [
          {
            ...(forecastAchievement as Array<Record<string, unknown>>)[0],
            unexpected: "field",
          },
        ],
        expectedReason: "UPSTREAM_SCHEMA_DRIFT",
      },
      {
        payload: [
          {
            ...(forecastAchievement as Array<Record<string, unknown>>)[0],
            出表日期: "1150829",
          },
        ],
        expectedReason: "UPSTREAM_FUTURE_REPORT_DATE",
      },
    ];

    for (const testCase of cases) {
      const { client } = clientWith({
        "https://openapi.twse.com.tw/v1/opendata/t187ap15_L": testCase.payload,
        "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O":
          tpexForecastEmpty,
      });
      const result = await client.getCompanyCatalystSnapshots({
        companyCodes: ["2330"],
        snapshotTypes: ["forecast_achievement"],
      });
      expect(result.failures).toEqual([
        expect.objectContaining({ reason: testCase.expectedReason }),
      ]);
    }
  });

  it("keeps stateless offset pages on one full-snapshot fingerprint", async () => {
    const entries = {
      "https://openapi.twse.com.tw/v1/opendata/t187ap41_L": twseMeetings,
    };
    const first = await clientWith(entries).client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      companyMarkets: [{ companyCode: "1101", market: "listed" }],
      snapshotTypes: ["shareholder_meeting"],
      offset: 0,
      limit: 1,
    });
    const second = await clientWith(entries).client.getCompanyCatalystSnapshots({
      companyCodes: ["1101"],
      companyMarkets: [{ companyCode: "1101", market: "listed" }],
      snapshotTypes: ["shareholder_meeting"],
      offset: 1,
      limit: 1,
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.pagination).toMatchObject({
      totalRows: 2,
      returnedRows: 1,
      hasMore: true,
      nextOffset: 1,
    });
    expect(second.pagination).toMatchObject({
      totalRows: 2,
      returnedRows: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect(first.records[0].recordId).not.toBe(second.records[0].recordId);
  });

  it("validates latest-only input, uniqueness, company limit, and pagination", async () => {
    const { client } = clientWith({});
    const invalidQueries = [
      { companyCodes: [] },
      { companyCodes: ["2330", "2330"] },
      { companyCodes: ["233"] },
      {
        companyCodes: Array.from({ length: 21 }, (_, index) =>
          String(1000 + index),
        ),
      },
      { companyCodes: ["2330"], snapshotTypes: [] },
      { companyCodes: ["2330"], asOf: "2026-08-28" },
      { companyCodes: ["2330"], offset: -1 },
      { companyCodes: ["2330"], limit: 101 },
      {
        companyCodes: ["2330"],
        companyMarkets: [{ companyCode: "2454", market: "listed" }],
      },
    ];
    for (const invalidQuery of invalidQueries) {
      await expect(
        client.getCompanyCatalystSnapshots(
          invalidQuery as Parameters<
            CompanyCatalystSnapshotClient["getCompanyCatalystSnapshots"]
          >[0],
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("keeps successful TPEx shareholder-meeting data separate from TWSE", async () => {
    const { client } = clientWith({
      "https://www.tpex.org.tw/openapi/v1/t187ap41_O": tpexMeetings,
    });
    const result = await client.getCompanyCatalystSnapshots({
      companyCodes: ["3105"],
      companyMarkets: [{ companyCode: "3105", market: "otc" }],
      snapshotTypes: ["shareholder_meeting"],
    });
    expect(result.records).toEqual([
      expect.objectContaining({
        companyCode: "3105",
        market: "otc",
        sourceKey: "tpex_shareholder_meeting_current",
      }),
    ]);
    expect(result.sources[0].exchange).toBe("TPEx");
  });
});
