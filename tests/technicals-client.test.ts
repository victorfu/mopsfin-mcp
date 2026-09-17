import { describe, expect, it } from "vitest";
import type { StockTechnicalsQuery } from "@/lib/technicals/client";
import { technicalFixture as setup, technicalNow as now } from "./fixtures/research-technicals";
import { runWithRequestDeadline } from "@/lib/upstream/reliability";

const query: StockTechnicalsQuery = { companyCode: "2330", asOf: "latest", priceBasis: "raw_unadjusted", indicators: ["sma"], smaPeriods: [5] };

describe("technical orchestration", () => {
  it("uses one completed cutoff, loads only needed history, and includes nested acquisition cost", async () => {
    const { client, resolver, benchmark, priceCall } = setup();
    const output = await client.getStockTechnicals(query);
    expect(output.asOf).toBe("2026-08-28");
    expect(output.indicators.sma_5.value).toBe(26);
    expect(output.coverage.requiredSessions).toBe(5);
    expect(benchmark.getHistory).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledWith({ market: "listed", evaluatedAt: now() });
    expect(priceCall).toHaveBeenCalledWith(expect.objectContaining({ startDate: "2026-08-24", endDate: "2026-08-28" }));
    expect(output.workBudget).toMatchObject({ benchmarkLogicalLoads: 1, priceSeriesCalls: 1, priceSeries: { orchestrationCompanyMasterCalls: 1 } });
  });
  it("does not replace an absent as-of stock bar with the previous close", async () => {
    const { client } = setup({ missingLast: true });
    const output = await client.getStockTechnicals(query);
    expect(output.indicators.sma_5).toMatchObject({ value: null, reason: "missing_session_bar" });
    expect(output.coverage.indicatorsComplete).toBe(false);
  });
  it("does not validate transfer-spanning raw bars against only the current market calendar", async () => {
    const { client } = setup({ marketTransition: true });
    await expect(client.getStockTechnicals(query)).rejects.toMatchObject({ code: "INCOMPLETE_COVERAGE", message: expect.stringContaining("轉板") });
  });
  it("rejects unverified dates and invalid input before price acquisition", async () => {
    const failedResolver = setup({ resolverFailed: true });
    await expect(failedResolver.client.getStockTechnicals(query)).rejects.toMatchObject({ code: "INCOMPLETE_COVERAGE" });
    expect(failedResolver.priceCall).not.toHaveBeenCalled();
    const noSession = setup({ missingSession: true });
    await expect(noSession.client.getStockTechnicals({ ...query, asOf: "2026-08-28" })).rejects.toMatchObject({ code: "NO_DATA" });
    expect(noSession.priceCall).not.toHaveBeenCalled();
    const invalid = setup();
    await expect(invalid.client.getStockTechnicals({ ...query, asOf: "2026-02-30" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(invalid.resolver.resolve).not.toHaveBeenCalled();
    await expect(invalid.client.getStockTechnicals({ ...query, asOf: "2026-08-29" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(invalid.benchmark.getHistory).not.toHaveBeenCalled();
  });
  it("stops warmup acquisition at eighteen months and reports insufficiency", async () => {
    const { client, benchmark, priceCall } = setup({ sparseBenchmark: true });
    const output = await client.getStockTechnicals({ ...query, indicators: ["rsi"] });
    expect(benchmark.getHistory).toHaveBeenCalledTimes(18);
    expect(priceCall).toHaveBeenCalledTimes(1);
    expect(output.coverage).toMatchObject({ requiredSessions: 251, observedMarketSessions: 18, marketWindowComplete: false });
    expect(output.indicators.rsi_14).toMatchObject({ value: null, reason: "insufficient_sessions" });
  });
  it("honors cancellation before acquisition and after the final dependency completes", async () => {
    const before = setup();
    const stopped = new AbortController(); stopped.abort();
    await expect(runWithRequestDeadline(1000, () => before.client.getStockTechnicals(query), stopped.signal)).rejects.toBeDefined();
    expect(before.resolver.resolve).not.toHaveBeenCalled();
    expect(before.rawPrice.getStockOhlc).not.toHaveBeenCalled();
    const after = setup();
    const data = await after.prices.getStockPriceSeries({ companyCode: "2330", startDate: "2026-08-24", endDate: "2026-08-28", priceBasis: "raw_unadjusted", includeEventLedger: true });
    const cancelled = new AbortController();
    after.priceCall.mockImplementation(async () => { cancelled.abort(); return data; });
    await expect(runWithRequestDeadline(1000, () => after.client.getStockTechnicals(query), cancelled.signal)).rejects.toBeDefined();
  });
});
