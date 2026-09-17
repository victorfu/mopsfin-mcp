import { describe, expect, it, vi } from "vitest";
import { runWithRequestDeadline } from "@/lib/upstream/reliability";
import { ScreenerClient, type ScreenCompaniesQuery } from "@/lib/screener/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { researchMarketFixture, researchNow } from "./fixtures/research-market";
import { completedSessionEvidenceFixture } from "./fixtures/completed-session";

const query: ScreenCompaniesQuery = {
  market: "all", includeFinancial: false, includeKy: true, asOf: "latest", revenueMonth: "latest", outputMode: "full",
  companyCodes: ["2330", "6488", "2881"],
  filters: [{ field: "revenue.yoy_pct", op: "gt", value: 20 }, { field: "valuation.pe", op: "between", value: [10, 25] }, { field: "price.turnover_twd", op: "gt", value: 100_000_000 }],
  columns: ["revenue.yoy_pct", "valuation.pe"], sort: [{ field: "revenue.yoy_pct", direction: "desc" }], pageSize: 1,
};

describe("bulk company screener", () => {
  it("starts no source work after cancellation or deadline expiry", async () => {
    const { dependencies, catalog } = researchMarketFixture();
    const client = new ScreenerClient(dependencies, catalog, researchNow);
    const stopped = new AbortController(); stopped.abort();
    await expect(runWithRequestDeadline(1000, () => client.screenCompanies(query), stopped.signal)).rejects.toMatchObject({ code: "ABORTED" });
    await runWithRequestDeadline(1000, async (deadline) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadline.expiresAtMs);
      try { await expect(client.screenCompanies(query)).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" }); }
      finally { clock.mockRestore(); }
    });
    expect(dependencies.master.listCompanies).not.toHaveBeenCalled();
    expect(catalog.getCatalog).not.toHaveBeenCalled();
  });
  it("joins bulk sources, filters before sorting/paging, and retains hidden filter evidence", async () => {
    const { dependencies, catalog } = researchMarketFixture();
    const output = await new ScreenerClient(dependencies, catalog, researchNow).screenCompanies(query);
    expect(output.counts).toMatchObject({ selected: 2, matched: 2, notMatched: 0, undetermined: 0 });
    expect(output.filterEvidence[0].code).toBe("6488");
    expect(output.filterEvidence[0].evidence[2]).toMatchObject({ filter: { field: "price.turnover_twd" }, cell: { value: 200_000_000 } });
    expect(output.page.next).not.toBeNull();
    expect(output.resultComplete).toBe(true);
    expect(output.universe.verification.status).toBe("heuristic");
    expect(dependencies.resolver.resolve).toHaveBeenCalledTimes(1);
    expect(dependencies.price.getDailyMarketOhlc).toHaveBeenCalledWith({ market: "all", date: "2026-08-28", universePolicy: "compatible" });
    expect(dependencies.valuation.getDailyMarketValuation).toHaveBeenCalledTimes(1);
    expect(dependencies.revenue.getMonthlyRevenue).toHaveBeenCalledTimes(1);
    expect(catalog.getCatalog).not.toHaveBeenCalled();
  });
  it("reuses cursor after retrieval timestamp changes but rejects changed source contents", async () => {
    const fixture = researchMarketFixture();
    const client = new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow);
    const first = await client.screenCompanies(query);
    const cursor = first.page.next?.kind === "cursor" ? first.page.next.cursor : "";
    await expect(client.screenCompanies({ ...query, cursor, filters: [{ field: "valuation.pe", op: "gt", value: 5 }] })).rejects.toMatchObject({ reason: "CURSOR_INVALID" });
    fixture.price.sources[0].retrievedAt = "2026-08-28T07:01:00Z";
    const next = await client.screenCompanies({ ...query, cursor });
    expect(next.filterEvidence[0].code).toBe("2330");
    fixture.price.bars[0].turnoverTwd = 201_000_000;
    await expect(client.screenCompanies({ ...query, cursor })).rejects.toMatchObject({ reason: "SNAPSHOT_CHANGED" });
  });
  it("preserves missing companies and isolates failed sources without false negatives", async () => {
    const fixture = researchMarketFixture();
    fixture.revenue.rows = fixture.revenue.rows.filter((row) => row.code !== "6488");
    const client = new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow);
    let output = await client.screenCompanies(query);
    expect(output.counts).toMatchObject({ selected: 2, matched: 1, undetermined: 1 });
    expect(output.unresolved.companies[0].code).toBe("6488");
    fixture.dependencies.valuation.getDailyMarketValuation.mockRejectedValue(new MopsfinError("UPSTREAM_TIMEOUT", "timeout"));
    output = await client.screenCompanies(query);
    expect(output.counts).toMatchObject({ matched: 0, undetermined: 2 });
    expect(output.failures[0]).toMatchObject({ domain: "valuation", code: "UPSTREAM_TIMEOUT" });
    expect(output.resultComplete).toBe(false);
  });
  it("plans domain-only acquisition and validates unknown fields/industries first", async () => {
    const fixture = researchMarketFixture();
    const client = new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow);
    const simple = { ...query, columns: ["company.name"], filters: [{ field: "company.code", op: "in" as const, value: ["2330", "6488"] }], sort: [] };
    await client.screenCompanies(simple);
    expect(fixture.dependencies.resolver.resolve).not.toHaveBeenCalled();
    expect(fixture.dependencies.price.getDailyMarketOhlc).not.toHaveBeenCalled();
    expect(fixture.dependencies.valuation.getDailyMarketValuation).not.toHaveBeenCalled();
    expect(fixture.dependencies.revenue.getMonthlyRevenue).not.toHaveBeenCalled();
    await expect(client.screenCompanies({ ...simple, columns: ["surprise"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.screenCompanies({ ...simple, industryCodes: ["nonexistent"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fixture.dependencies.master.listCompanies).toHaveBeenCalledTimes(1);
  });
  it("summarizes the entire match set rather than the current page", async () => {
    const fixture = researchMarketFixture();
    const output = await new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow).screenCompanies({ ...query, outputMode: "summary" });
    expect(output.presentation).toMatchObject({ scope: "entire_selection", rowCount: 2, statistics: [{ field: "revenue.yoy_pct", total: 2, groups: [{ count: 2, min: 25, max: 26, median: 25.5 }] }, { field: "valuation.pe" }] });
    expect(output.page.returned).toBe(1);
  });
  it("fails closed on mixed completed dates and revenue months", async () => {
    const fixture = researchMarketFixture();
    fixture.dependencies.resolver.resolve.mockResolvedValue(completedSessionEvidenceFixture({ market: "all", status: "unresolved" }));
    const client = new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow);
    const output = await client.screenCompanies(query);
    expect(output.resultComplete).toBe(false);
    expect(output.failures.map((failure) => failure.domain)).toEqual(["price", "valuation"]);
    expect(fixture.dependencies.price.getDailyMarketOhlc).not.toHaveBeenCalled();
    fixture.revenue.sources[1].dataMonth = "2026-06";
    const mismatch = await client.screenCompanies({ ...query, filters: [{ field: "company.code", op: "in" as const, value: ["2330", "6488"] }], sort: [], columns: ["revenue.yoy_pct"] });
    expect(mismatch.failures[0]).toMatchObject({ domain: "revenue", reason: "REVENUE_MONTH_UNALIGNED" });
  });
  it("does not use stale company classifications as fresh filter values", async () => {
    const fixture = researchMarketFixture();
    const client = new ScreenerClient(fixture.dependencies, fixture.catalog, () => new Date("2026-09-17T07:00:00Z"));
    const output = await client.screenCompanies({ ...query, columns: ["company.is_financial"], filters: [{ field: "company.is_financial", op: "eq", value: false }], sort: [] });
    expect(output.counts.undetermined).toBe(2);
    expect(output.universe.freshness.every((item) => item.freshness === "stale")).toBe(true);
  });
  it("keeps network fanout constant when the selected universe grows to 500 companies", async () => {
    const fixture = researchMarketFixture();
    const master = await fixture.dependencies.master.listCompanies({ market: "all", includeFinancial: true, includeKy: true });
    const template = master.companies.find((company) => company.code === "2330")!;
    master.companies = Array.from({ length: 500 }, (_, index) => ({ ...template, code: String(4000 + index) }));
    fixture.dependencies.master.listCompanies.mockResolvedValue(master);
    const output = await new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow).screenCompanies({ ...query, companyCodes: undefined });
    expect(output.counts).toMatchObject({ selected: 500, matched: 0, undetermined: 500 });
    expect(output.unresolved).toMatchObject({ total: 500, returned: 100, omitted: 400 });
    expect(fixture.dependencies.price.getDailyMarketOhlc).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.valuation.getDailyMarketValuation).toHaveBeenCalledTimes(1);
    expect(fixture.dependencies.revenue.getMonthlyRevenue).toHaveBeenCalledTimes(1);
    expect(output.workBudget.perCompanyMarketCalls).toBe(0);
  });
});
