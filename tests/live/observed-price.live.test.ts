import { describe, expect, it } from "vitest";

import { analyzeObservedPriceOutputSchema } from "@/lib/mcp/schema/observed-price";
import { analyzeObservedPriceTool } from "@/lib/mcp/tools/observed-price";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live caller-supplied observed-price contract", () => {
  it("binds 2330 to the resolver expectedAsOf and exact single-stock source", async () => {
    const observedAt = new Date().toISOString();
    const toolResult = await analyzeObservedPriceTool.handler(
      {
        company_code: "2330",
        observed_price_twd: 1,
        observed_at: observedAt,
        source_label: "live_contract_caller_supplied_test_value",
      },
      {} as Parameters<typeof analyzeObservedPriceTool.handler>[1],
    );
    expect(
      toolResult.isError,
      JSON.stringify(toolResult.structuredContent),
    ).not.toBe(true);
    const result = analyzeObservedPriceOutputSchema.parse(
      toolResult.structuredContent,
    );

    expect(result.company).toMatchObject({
      code: "2330",
      market: "listed",
      exchange: "TWSE",
    });
    expect(result.observedAt).toBe(observedAt);
    expect(result.latestOfficialCompletedClose).toBeGreaterThan(0);
    expect(result.latestOfficialCloseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.officialHistoryCutoff).toBe(result.latestOfficialCloseDate);
    expect(result.sources).toHaveLength(3);
    const masterSources = result.sources.filter(
      (source) => source.stage === "company_master",
    );
    expect(masterSources.map((source) => source.market)).toEqual([
      "listed",
      "otc",
    ]);
    expect(result.meta.asOf).toMatchObject({
      selector: "snapshot",
      resolved: { granularity: "mixed", from: null, through: null },
    });
    expect(result.meta.quality).toMatchObject({
      status: "partial",
      source: "partial",
      universe: "unverified",
      selection: "complete",
      values: "complete",
    });
    const completedFreshness = result.meta.quality.freshnessDetails.find(
      (detail) => detail.policyId === "official.completed-session.v1",
    );
    const masterFreshness = result.meta.quality.freshnessDetails.filter(
      (detail) =>
        detail.policyId === "official.current-snapshot.max-age-7d.v1",
    );
    expect(masterFreshness).toHaveLength(2);
    for (const source of masterSources) {
      expect(masterFreshness).toContainEqual(
        expect.objectContaining({
          observedAsOf: source.reportDate,
          sourceUrls: [source.sourceUrl],
        }),
      );
    }
    expect(completedFreshness).toMatchObject({
      status: "within_expected_window",
      observedAsOf: result.latestOfficialCloseDate,
      expectedAsOf: result.latestOfficialCloseDate,
      lag: { value: 0, unit: "trading_session" },
      resolverEvidence: {
        status: "resolved",
        expectedAsOf: result.latestOfficialCloseDate,
        markets: ["listed"],
      },
    });
    expect(
      completedFreshness?.resolverEvidence?.marketResolutions,
    ).toEqual([
      expect.objectContaining({
        market: "listed",
        status: "resolved",
        expectedAsOf: result.latestOfficialCloseDate,
      }),
    ]);
    expect(result.provenance.currentMasterIdentity.sourceIds).toHaveLength(2);
    expect(result.provenance.officialBaseline.sourceIds).toHaveLength(1);
    const closeSource = result.sources.find(
      (source) => source.stage === "latest_official_completed_close",
    );
    expect(closeSource).toMatchObject({
      companyCode: result.company.code,
      market: result.company.market,
      exchange: result.company.exchange,
      snapshotIdentity: "verified",
      dataMonth: result.latestOfficialCloseDate.slice(0, 7),
      selectedBarDate: result.latestOfficialCloseDate,
      observedName: result.company.shortName,
    });
    expect(closeSource).not.toHaveProperty("dataDate");
    expect(result.workBudget).toMatchObject({
      priceRoutingPolicy:
        "authoritative_completed_session_expected_as_of_then_exact_single_stock_ohlc",
      selectedCompanyIdentityPolicy:
        "outer_market_all_master_plus_exact_single_stock_source",
      dependencyInvocations: {
        orchestrationCompanyMaster: 1,
        authoritativeCompletedSessionResolver: 1,
        officialExactSingleStockOhlc: 1,
        maximumIncludingNestedDependencies: 3,
      },
      plannedOfficialSourceRequests: {
        completedSessionResolver: { actual: 2, maximum: 2 },
        exactSingleStockOhlc: {
          maximum: 2,
        },
        maximumTotal: 6,
      },
    });
    const sourceRequests = result.workBudget.plannedOfficialSourceRequests;
    expect([1, 2]).toContain(sourceRequests.exactSingleStockOhlc.actual);
    expect(sourceRequests.actualTotal).toBe(
      sourceRequests.orchestrationCompanyMasterMarkets +
        sourceRequests.completedSessionResolver.actual +
        sourceRequests.exactSingleStockOhlc.actual,
    );
    expect(result.dependencyLedger.map((entry) => entry.dependency)).toEqual([
      "orchestration_company_master",
      "authoritative_completed_session_resolver",
      "official_exact_single_stock_ohlc",
    ]);
    expect(JSON.stringify(result.dependencyLedger)).not.toContain(
      "official_daily_market_internal_compatible_master",
    );
    expect(JSON.stringify(result.dependencyLedger)).not.toContain(
      "official_daily_market_price",
    );
  }, 120_000);
});
