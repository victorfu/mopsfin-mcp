import { describe, expect, it } from "vitest";

import { ReverseDcfMcpClient } from "@/lib/reverse-dcf/mcp-client";
import { valuationModelInputsClient } from "@/lib/valuation-model/client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live valuation-model input contract", () => {
  it("normalizes 2330 latest statements into an auditable TTM bridge", async () => {
    const execution =
      await valuationModelInputsClient.getValuationModelInputsWithContext({
        companyCode: "2330",
      });
    const { data: result, completedClose } = execution;

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
    expect(result.fields.latestOfficialClose).toMatchObject({
      status: "reported",
      evidenceClass: "OFFICIAL_MARKET_RAW",
      dataGapReason: null,
    });
    expect(result.fields.latestOfficialClose.value).toBeGreaterThan(0);
    expect(completedClose).not.toBeNull();
    expect(completedClose?.expectedAsOf).toBe(
      completedClose?.selectedBarDate,
    );
    expect(completedClose?.selectedBarDate).toBe(
      result.sources.find(
        (source) => source.stage === "latest_official_completed_close",
      )?.selectedBarDate,
    );
    expect(result.fields.marketCapitalization.status).toBe("derived");
    expect(result.fields.enterpriseValue.status).toBe("derived");
    expect(result.workBudget.authoritativeCompletedCloseCalls).toMatchObject({
      actual: 1,
      completedSessionResolver: {
        actualLogicalLoads: 2,
        maximumLogicalLoads: 2,
      },
      exactStockOhlcAttempts: {
        actual: expect.any(Number),
        maximum: 2,
      },
    });
    expect(result.warnings.join(" ")).not.toContain(
      "authoritative completed-close dependency 失敗",
    );
    expect(
      result.lineage.some(
        (entry) =>
          entry.role === "revenue" &&
          entry.rowLabel === "營業收入合計" &&
          entry.status === "resolved",
      ),
    ).toBe(true);

    const reverseDcf = new ReverseDcfMcpClient(
      {
        getValuationModelInputsWithContext: async () => execution,
      },
      () => new Date(Date.parse(result.generatedAt) + 1_000),
    );
    const reverseResult = await reverseDcf.runReverseDcf({
      company_code: "2330",
      price_source: "latest_completed_close",
      forecast_years: 5,
      wacc_percent: 9,
      terminal_growth_percent: 2,
      solve_for: "fcff_cagr",
      solve_range: { minimum_percent: -99, maximum_percent: 500 },
      enterprise_value_bridge: {
        non_operating_assets_twd: 0,
        non_controlling_interests_twd: 0,
        preferred_equity_twd: 0,
        pension_deficit_twd: 0,
        other_debt_like_items_twd: 0,
      },
      forward_assumptions: {},
    });
    expect(reverseResult.company.code).toBe("2330");
    expect(reverseResult.normalizedInputEvidence.fields.latestOfficialClose)
      .toMatchObject({ status: "reported", value: result.fields.latestOfficialClose.value });
    expect(Number.isFinite(reverseResult.model.solution.solvedValuePercent)).toBe(
      true,
    );
  }, 180_000);
});
