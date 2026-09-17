import { describe, expect, it, vi } from "vitest";
import { PriceSeriesSummaryClient, summarizePriceBars } from "@/lib/research/price-summary";
import { technicalFixture } from "./fixtures/research-technicals";

async function sample() {
  const fixture = technicalFixture();
  const data = await fixture.prices.getStockPriceSeries({ companyCode: "2330", startDate: "2026-08-24", endDate: "2026-08-28", priceBasis: "raw_unadjusted", includeEventLedger: false });
  data.bars.forEach((bar, index) => { bar.close = [100, 110, 88, 99, 100][index]; });
  return { fixture, data, dates: data.bars.map((bar) => bar.date) };
}

describe("price summary exact sessions and selected basis", () => {
  it("computes independently checked endpoint, close drawdown and sample daily log deviation", async () => {
    const { data, dates } = await sample();
    const result = summarizePriceBars(data, dates);
    expect(result.endpointReturnPercent.value).toBe(0);
    expect(result.maxDrawdownPercent.value).toBeCloseTo(-20, 12);
    const returns = [Math.log(1.1), Math.log(0.8), Math.log(1.125), Math.log(100 / 99)];
    const mean = returns.reduce((a, b) => a + b) / 4;
    const expected = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 3);
    expect(result.dailyLogReturnSampleStdDev.value).toBeCloseTo(expected, 14);
    expect(result).toMatchObject({ complete: true, calendarVerified: true, expectedSessions: 5, calculation: { volatilityAnnualized: false, volatilityDdof: 1, isTotalReturn: false } });
  });

  it("keeps only endpoint return when an interior official session is missing", async () => {
    const { data, dates } = await sample();
    data.bars.splice(2, 1);
    expect(summarizePriceBars(data, dates)).toMatchObject({
      complete: false, calendarVerified: false, missingSessionDates: ["2026-08-26"],
      endpointReturnPercent: { value: 0 }, maxDrawdownPercent: { value: null, reason: "missing_session_bars" }, dailyLogReturnSampleStdDev: { value: null },
    });
    expect(summarizePriceBars(data, null).maxDrawdownPercent.reason).toBe("official_session_grid_unavailable");
  });

  it("rejects duplicate or non-session bars and never fills adjusted prices with raw", async () => {
    const { data, dates } = await sample();
    data.bars.push(data.bars[0]);
    expect(summarizePriceBars(data, dates).maxDrawdownPercent.reason).toBe("invalid_session_grid");
    data.bars.pop();
    expect(summarizePriceBars(data, dates.slice(1)).unexpectedBarDates).toEqual([dates[0]]);
    data.requestedPriceBasis = "price_index_compatible_corporate_action_adjusted";
    expect(summarizePriceBars(data, dates)).toMatchObject({ validCloseCount: 0, firstClose: null, lastClose: null, endpointReturnPercent: { value: null }, maxDrawdownPercent: { value: null, reason: "adjusted_close_unavailable" } });
  });

  it("isolates benchmark failure and avoids a misleading single-market grid for transfer histories", async () => {
    const { data } = await sample();
    const benchmark = { getHistory: vi.fn().mockRejectedValue(new Error("fixture failure")) };
    const client = new PriceSeriesSummaryClient(benchmark);
    const failed = await client.summarize(data);
    expect(failed).toMatchObject({ summaryFailure: { code: expect.any(String) }, summary: { calendarVerified: false }, summaryWorkBudget: { benchmarkCalls: 1, requestedBenchmarkMonths: ["2026-08"] } });
    benchmark.getHistory.mockClear();
    data.adjustment.marketTransitionDetected = true;
    expect(await client.summarize(data)).toMatchObject({ summaryFailure: { code: "IDENTITY_UNVERIFIED" }, summaryWorkBudget: { benchmarkCalls: 0 } });
    expect(benchmark.getHistory).not.toHaveBeenCalled();
  });
});
