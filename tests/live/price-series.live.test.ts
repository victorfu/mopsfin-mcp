import { describe, expect, it } from "vitest";

import { stockPriceSeriesClient } from "@/lib/price-series/client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live stock price-series contract", () => {
  it("keeps official raw evidence and fail-closed adjusted semantics for 2330", async () => {
    const result = await stockPriceSeriesClient.getStockPriceSeries({
      companyCode: "2330",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      priceBasis: "price_index_compatible_corporate_action_adjusted",
      includeEventLedger: true,
    });

    expect(result.bars.length).toBeGreaterThan(0);
    expect(result.coverage.rawPrice).toMatchObject({
      status: "complete",
      coverageComplete: true,
      coveredThrough: "2026-07-31",
    });
    expect(result.identity.companyCode).toBe("2330");
    expect(result.adjustment).toMatchObject({
      adjustmentDirection: "backward",
      cashDividendTreatment: "retained",
      isAdjustedClose: false,
      isTotalReturn: false,
      volumeAdjusted: false,
      volumeBasis: "raw_shares",
    });
    expect(
      result.bars.every(
        (bar) =>
          bar.volumeBasis === "raw_shares" &&
          (bar.adjustmentStatus === "complete"
            ? bar.cumulativeFactor !== null && bar.adjusted !== null
            : bar.cumulativeFactor === null && bar.adjusted === null),
      ),
    ).toBe(true);
    expect(result.sources.some((source) => source.stage === "raw_price")).toBe(
      true,
    );
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);
});
