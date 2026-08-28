import { describe, expect, it } from "vitest";

import { companyCatalystSnapshotClient } from "@/lib/catalyst/snapshot-client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live catalyst snapshot contracts", () => {
  it(
    "validates all supported current routes and the TPEx dividend unsupported contract",
    async () => {
      const result =
        await companyCatalystSnapshotClient.getCompanyCatalystSnapshots({
          companyCodes: ["2330", "3105"],
          companyMarkets: [
            { companyCode: "2330", market: "listed" },
            { companyCode: "3105", market: "otc" },
          ],
          asOf: "latest",
          offset: 0,
          limit: 100,
        });

      expect(result).toMatchObject({
        scope: "current_official_company_snapshots",
        isConsensus: false,
        coverage: {
          failureIsolation: "per_snapshot_type_market",
        },
        workBudget: {
          companyCount: 2,
          snapshotTypeCount: 4,
          plannedSourceRoutes: 8,
          supportedSourceQueries: 7,
          unsupportedSourceRoutes: 1,
          sourceQueryLimit: 8,
        },
      });
      expect(result.failures).toEqual([]);

      expect(result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceKey: "twse_forecast_achievement_current",
            sourceUrl:
              "https://openapi.twse.com.tw/v1/opendata/t187ap15_L",
          }),
          expect.objectContaining({
            sourceKey: "tpex_forecast_achievement_current",
            sourceUrl:
              "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O",
          }),
          expect.objectContaining({
            sourceKey: "twse_forecast_material_variance_current",
            sourceUrl:
              "https://openapi.twse.com.tw/v1/opendata/t187ap16_L",
          }),
          expect.objectContaining({
            sourceKey: "tpex_forecast_material_variance_current",
            sourceUrl:
              "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap16_O",
          }),
          expect.objectContaining({
            sourceKey: "twse_shareholder_meeting_current",
            sourceUrl:
              "https://openapi.twse.com.tw/v1/opendata/t187ap41_L",
          }),
          expect.objectContaining({
            sourceKey: "tpex_shareholder_meeting_current",
            sourceUrl:
              "https://www.tpex.org.tw/openapi/v1/t187ap41_O",
          }),
          expect.objectContaining({
            sourceKey: "twse_dividend_decision_current",
            sourceUrl:
              "https://openapi.twse.com.tw/v1/opendata/t187ap45_L",
          }),
          expect.objectContaining({
            sourceKey: "tpex_dividend_decision_current_unsupported",
            sourceUrl: null,
            status: "unsupported",
            freshness: "not_applicable",
            snapshotIdentity: null,
          }),
        ]),
      );

      const queriedSources = result.sources.filter(
        (source) => source.status !== "unsupported",
      );
      expect(queriedSources).toHaveLength(7);
      expect(
        queriedSources.every(
          (source) =>
            source.status !== "failed" &&
            source.sourceSnapshotDate !== null &&
            source.sourceSnapshotAgeDays !== null &&
            source.snapshotIdentity !== null,
        ),
      ).toBe(true);
      expect(
        result.records.every(
          (record) =>
            record.pointInTimeHistoryAvailable === false &&
            record.firstKnownAt === null &&
            record.isConsensus === false &&
            (record.snapshotType === "shareholder_meeting" ||
              record.upcomingEligible === false),
        ),
      ).toBe(true);
    },
    70_000,
  );
});
