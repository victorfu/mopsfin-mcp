import { describe, expect, it } from "vitest";

import { corporateActionClient } from "@/lib/corporate-actions/client";
import type { CorporateActionFamily } from "@/lib/corporate-actions/types";
import type { CompanyMarket } from "@/lib/company-master/types";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

interface NonemptyContractCase {
  market: CompanyMarket;
  family: CorporateActionFamily;
  date: string;
  expectedCompanyCode: string;
}

const NONEMPTY_CONTRACTS = [
  {
    market: "listed",
    family: "ex_right_dividend",
    date: "2025-07-07",
    expectedCompanyCode: "5706",
  },
  {
    market: "listed",
    family: "capital_reduction",
    date: "2025-06-23",
    expectedCompanyCode: "2371",
  },
  {
    market: "listed",
    family: "par_value_change",
    date: "2025-06-30",
    expectedCompanyCode: "4763",
  },
  {
    market: "otc",
    family: "ex_right_dividend",
    date: "2025-07-03",
    expectedCompanyCode: "5236",
  },
  {
    market: "otc",
    family: "capital_reduction",
    date: "2025-08-25",
    expectedCompanyCode: "3290",
  },
  {
    market: "otc",
    family: "par_value_change",
    date: "2025-03-31",
    expectedCompanyCode: "5314",
  },
] satisfies NonemptyContractCase[];

interface EmptyContractCase {
  market: CompanyMarket;
  family: CorporateActionFamily;
  expectedStatus: "verified_empty" | "unverified_empty";
}

const EMPTY_DATE = "2025-01-05";
const EMPTY_CONTRACTS = [
  {
    market: "listed",
    family: "ex_right_dividend",
    expectedStatus: "unverified_empty",
  },
  {
    market: "listed",
    family: "capital_reduction",
    expectedStatus: "unverified_empty",
  },
  {
    market: "listed",
    family: "par_value_change",
    expectedStatus: "verified_empty",
  },
  {
    market: "otc",
    family: "ex_right_dividend",
    expectedStatus: "verified_empty",
  },
  {
    market: "otc",
    family: "capital_reduction",
    expectedStatus: "verified_empty",
  },
  {
    market: "otc",
    family: "par_value_change",
    expectedStatus: "verified_empty",
  },
] satisfies EmptyContractCase[];

liveDescribe("live corporate-action contracts", () => {
  it.each(NONEMPTY_CONTRACTS)(
    "validates a fixed nonempty $market $family contract",
    async ({ market, family, date, expectedCompanyCode }) => {
      const result = await corporateActionClient.probeRangeContract(
        market,
        family,
        date,
        date,
      );

      expect(result).toMatchObject({
        status: "nonempty",
        market,
        family,
        queryStart: date,
        queryEnd: date,
        responseRangeVerified: true,
      });
      expect(result.upstreamStatus.toLowerCase()).toBe("ok");
      expect(result.source).toMatchObject({
        market,
        family,
        scope: "range_summary",
        queryStart: date,
        queryEnd: date,
        responseStart: date,
        responseEnd: date,
      });
      expect(result.source?.rawRowCount).toBeGreaterThan(0);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          companyCode: expectedCompanyCode,
          market,
          effectiveDate: date,
          sourceFamily: family,
        }),
      );
    },
    65_000,
  );

  it.each(EMPTY_CONTRACTS)(
    "validates a fixed empty $market $family contract",
    async ({ market, family, expectedStatus }) => {
      const result = await corporateActionClient.probeRangeContract(
        market,
        family,
        EMPTY_DATE,
        EMPTY_DATE,
      );

      expect(result).toMatchObject({
        status: expectedStatus,
        market,
        family,
        queryStart: EMPTY_DATE,
        queryEnd: EMPTY_DATE,
        responseRangeVerified: expectedStatus === "verified_empty",
        events: [],
      });
      expect(result.upstreamStatus.length).toBeGreaterThan(0);
      if (expectedStatus === "unverified_empty") {
        expect(result.source).toBeNull();
      } else {
        expect(result.source).toMatchObject({
          market,
          family,
          scope: "range_summary",
          queryStart: EMPTY_DATE,
          queryEnd: EMPTY_DATE,
          responseStart: EMPTY_DATE,
          responseEnd: EMPTY_DATE,
          rawRowCount: 0,
          companyEventCount: 0,
        });
      }
    },
    65_000,
  );

  it(
    "validates a fixed TWSE combined-event detail contract",
    async () => {
      const date = "2025-07-07";
      const summary = await corporateActionClient.probeRangeContract(
        "listed",
        "ex_right_dividend",
        date,
        date,
      );
      const summaryEvent = summary.events.find(
        (event) => event.companyCode === "5706",
      );
      expect(summaryEvent).toMatchObject({
        companyCode: "5706",
        effectiveDate: date,
        kind: "rights_and_dividend",
      });

      const detail = await corporateActionClient.probeTwseCombinedDetailContract(
        summaryEvent!,
      );

      expect(detail.event).toMatchObject({
        companyCode: "5706",
        effectiveDate: date,
        kind: "rights_and_dividend",
        adjustmentStatus: "available",
      });
      expect(detail.event.cashDividendPerShareTwd).toBeGreaterThan(0);
      expect(detail.event.priceIndexAdjustmentFactor).toBeGreaterThan(0);
      expect(detail.source).toMatchObject({
        market: "listed",
        family: "ex_right_dividend",
        scope: "event_detail",
        queryStart: date,
        queryEnd: date,
        responseStart: null,
        responseEnd: null,
        rawRowCount: 1,
        companyEventCount: 1,
      });
    },
    65_000,
  );
});
