import { describe, expect, it } from "vitest";

import { analyzeObservedPriceOutputSchema } from "@/lib/mcp/schema/observed-price";
import { analyzeObservedPriceTool } from "@/lib/mcp/tools/observed-price";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live caller-supplied observed-price contract", () => {
  it("resolves 2330 through compatible market reconciliation and exact selected identity", async () => {
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
    expect(toolResult.isError).not.toBe(true);
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
    expect(result.officialHistoryCutoff).toBe(
      result.latestOfficialCloseDate,
    );
    expect(result.sources).toHaveLength(3);
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
    expect(result.provenance.currentMasterIdentity.sourceIds).toHaveLength(2);
    expect(result.provenance.officialBaseline.sourceIds).toHaveLength(1);
    expect(result.workBudget).toMatchObject({
      universePolicy: "compatible",
      selectedCompanyIdentityPolicy:
        "outer_market_all_master_plus_official_row_exact",
    });
    expect(
      result.dependencyLedger.find(
        (entry) =>
          entry.dependency ===
          "official_daily_market_internal_compatible_master",
      )?.sourceEvidence,
    ).toBe("not_exposed_by_dependency");
    expect(
      result.dependencyLedger.find(
        (entry) => entry.dependency === "official_daily_market_price",
      )?.sourceEvidence,
    ).toBe("exposed");
  }, 120_000);
});
