import { describe, expect, it } from "vitest";

import { valuationModelInputsClient } from "@/lib/valuation-model/client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live valuation-model input contract", () => {
  it("normalizes 2330 latest statements into an auditable TTM bridge", async () => {
    const result = await valuationModelInputsClient.getValuationModelInputs({
      companyCode: "2330",
    });

    expect(result.applicability.status).toBe("applicable");
    expect(result.periods.latestReportedPeriod).toMatch(/^\d{4}Q[1-4]$/);
    expect(result.periods.consolidationScope).toBe("consolidated");
    expect(result.sources.some((source) => source.stage === "company_master")).toBe(
      true,
    );
    const statementSources = result.sources.filter(
      (source) => source.stage === "statement",
    );
    expect(statementSources.length).toBeGreaterThanOrEqual(3);
    expect(
      statementSources.every(
        (source) =>
          source.rawUnit === "新台幣仟元" &&
          source.unitSource !== "unavailable" &&
          source.amountMultiplier === 1000,
      ),
    ).toBe(true);
    for (const field of [
      result.fields.ttmRevenue,
      result.fields.ttmOperatingIncomeEbitProxy,
      result.fields.cashTaxRatePercent,
      result.fields.ttmDepreciationAndAmortization,
      result.fields.ttmCapitalExpenditure,
      result.fields.ttmDeltaNetWorkingCapital,
      result.fields.normalizedFcff,
      result.fields.cashAndCashEquivalents,
      result.fields.interestBearingDebt,
      result.fields.netDebt,
      result.fields.issuedShares,
    ]) {
      expect(field.status).not.toBe("data_gap");
      expect(field.value).not.toBeNull();
    }
    expect(
      result.lineage.some(
        (entry) =>
          entry.role === "revenue" &&
          entry.rowLabel === "營業收入合計" &&
          entry.status === "resolved",
      ),
    ).toBe(true);
  }, 180_000);
});
