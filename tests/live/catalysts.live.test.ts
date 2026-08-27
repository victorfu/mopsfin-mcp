import { describe, expect, it } from "vitest";

import { catalystClient } from "@/lib/catalyst/client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live catalyst contracts", () => {
  it(
    "validates both current official material-information snapshots",
    async () => {
      const result = await catalystClient.getCurrentMaterialInformation({
        market: "all",
        companyCodes: ["2330"],
      });

      expect(result).toMatchObject({
        scope: "current_official_snapshot",
        isConsensus: false,
        query: { market: "all", companyCodes: ["2330"] },
      });
      expect(result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceKey: "twse_material_information_current",
            sourceUrl:
              "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
            market: "listed",
          }),
          expect.objectContaining({
            sourceKey: "tpex_material_information_current",
            sourceUrl:
              "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
            market: "otc",
          }),
        ]),
      );
      expect(
        result.sources.every((source) => source.snapshotIdentity.length > 0),
      ).toBe(true);
    },
    65_000,
  );

  it(
    "validates fixed historical material-information and investor-conference sources",
    async () => {
      const startDate = "2024-01-01";
      const endDate = "2024-01-31";
      const result = await catalystClient.getCompanyCatalystEvents({
        companyCodes: ["2330"],
        companyMarkets: [{ companyCode: "2330", market: "listed" }],
        startDate,
        endDate,
        eventTypes: ["material_information", "investor_conference"],
        offset: 0,
        limit: 100,
      });

      expect(result.query).toMatchObject({
        companyCodes: ["2330"],
        startDate,
        endDate,
        eventTypes: ["material_information", "investor_conference"],
      });
      expect(result).toMatchObject({
        scope: "official_disclosure_events",
        isConsensus: false,
        coverage: {
          sourceComplete: true,
          failureIsolation: "per_company_event_type_calendar_month",
        },
        workBudget: {
          companyCount: 1,
          distinctCalendarMonths: 1,
          eventTypeCount: 2,
          historicalLogicalUnits: 2,
          historicalUpstreamRequests: 3,
          currentSnapshotRequests: 0,
          plannedUpstreamRequests: 3,
          upstreamRequestLimit: 40,
        },
        failures: [],
      });

      expect(result.familyCoverage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            companyCode: "2330",
            eventType: "material_information",
            status: "complete",
            requestCount: 1,
            completedRequestCount: 1,
            queryStart: startDate,
            queryEnd: endDate,
          }),
          expect.objectContaining({
            companyCode: "2330",
            eventType: "investor_conference",
            status: "complete",
            requestCount: 2,
            completedRequestCount: 2,
            queryStart: startDate,
            queryEnd: endDate,
          }),
        ]),
      );
      expect(
        result.familyCoverage.every(
          (coverage) => coverage.snapshotIdentity.length > 0,
        ),
      ).toBe(true);

      expect(result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "material_information",
            exchange: "MOPS",
            sourceKey: "mops_material_information_history",
            sourceUrl: "https://mopsov.twse.com.tw/mops/web/ajax_t05st01",
            scope: "selected_company_historical_months",
            queryStart: startDate,
            queryEnd: endDate,
          }),
          expect.objectContaining({
            eventType: "investor_conference",
            exchange: "MOPS",
            sourceKey: "mops_investor_conference_history",
            sourceUrl: "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1",
            scope: "selected_company_historical_months",
            queryStart: startDate,
            queryEnd: endDate,
          }),
        ]),
      );
      expect(
        result.sources.every((source) => source.snapshotIdentity.length > 0),
      ).toBe(true);

      expect(result.events.every((event) => event.companyCode === "2330")).toBe(
        true,
      );
      expect(
        result.events.every(
          (event) =>
            event.sourceKey === "mops_material_information_history" ||
            event.sourceKey === "mops_investor_conference_history",
        ),
      ).toBe(true);
    },
    65_000,
  );
});
