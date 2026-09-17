import { describe, expect, it, vi } from "vitest";
import { runWithRequestDeadline } from "@/lib/upstream/reliability";
import { ComparisonClient, type CompareCompaniesQuery } from "@/lib/comparison/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { comparisonFixture as fixture } from "./fixtures/research-comparison";

const query: CompareCompaniesQuery = { companyCodes: ["6488", "2330", "2881"], columns: ["financial.Revenue", "financial.EPS", "financial.GrossMargin"], marketDate: "latest", revenueMonth: "latest", outputMode: "full" };
function fullRows(output: Awaited<ReturnType<ComparisonClient["compareCompanies"]>>) {
  if (!("rows" in output.presentation) || !output.presentation.rows) throw new Error("no rows");
  return output.presentation.rows.map((row) => { if (!("cells" in row)) throw new Error("not full"); return row; });
}

describe("company comparison", () => {
  it("starts no catalog, master or financial calls after cancellation or deadline expiry", async () => {
    const { client, dependencies, catalog, batch } = fixture();
    const stopped = new AbortController(); stopped.abort();
    await expect(runWithRequestDeadline(1000, () => client.compareCompanies(query), stopped.signal)).rejects.toMatchObject({ code: "ABORTED" });
    await runWithRequestDeadline(1000, async (deadline) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadline.expiresAtMs);
      try { await expect(client.compareCompanies(query)).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" }); }
      finally { clock.mockRestore(); }
    });
    expect(dependencies.master.listCompanies).not.toHaveBeenCalled();
    expect(catalog.getCatalog).not.toHaveBeenCalled();
    expect(batch.getCompanyMetricsBatch).not.toHaveBeenCalled();
  });
  it("preserves caller order and selects common reported quarter across all companies/metrics", async () => {
    const { client, batch, dependencies } = fixture();
    const output = await client.compareCompanies(query);
    expect(output.alignment?.commonPeriod).toBe("2026Q1");
    expect(fullRows(output).map((row) => row.code)).toEqual(["6488", "2330", "2881"]);
    expect(batch.getCompanyMetricsBatch).toHaveBeenCalledWith({ companyCodes: query.companyCodes, metricCodes: ["Revenue", "EPS", "GrossMargin"], basis: "quarterly", startPeriod: "2023Q3", endPeriod: "2026Q2" });
    expect(dependencies.price.getDailyMarketOhlc).not.toHaveBeenCalled();
    expect(dependencies.resolver.resolve).not.toHaveBeenCalled();
    const bank = fullRows(output)[2];
    expect(bank.cells["financial.Revenue"]).toMatchObject({ value: 100_000, unit: "TWD", period: "2026Q1", definitionId: expect.stringContaining("financial_net_revenue"), normalization: { sourceValue: 100, sourceUnit: "仟元", factor: 1000 } });
    expect(bank.cells["financial.GrossMargin"].status).toBe("not_applicable");
    expect(bank.cells["financial.EPS"]).toMatchObject({ value: 2.5, unit: "TWD/share" });
    expect(output.columns[0].definitionMismatch).toBe(true);
  });
  it("reports no-common-period rather than dropping a failed or missing company", async () => {
    const { client, data } = fixture();
    data.companies[1].metrics.forEach((metric) => { metric.points = []; metric.periods = []; metric.availability = "no_data"; });
    const output = await client.compareCompanies(query);
    expect(output.alignment?.status).toBe("no_common_period");
    expect(output.alignment?.commonPeriod).toBeNull();
    expect(fullRows(output)).toHaveLength(3);
    expect(fullRows(output)[1].cells["financial.EPS"]).toMatchObject({ value: null, status: "period_unaligned" });
  });
  it("supports company-latest and exact explicit selection without fallback", async () => {
    const { client } = fixture();
    const perCompany = await client.compareCompanies({ ...query, financialPeriodPolicy: "company_latest" });
    expect(perCompany.alignment?.companies.map((company) => company.selectedPeriod)).toEqual(["2026Q1", "2026Q2", "2026Q2"]);
    const exact = await client.compareCompanies({ ...query, financialPeriodPolicy: "explicit", fiscalPeriod: "2026Q2" });
    expect(fullRows(exact)[0].cells["financial.EPS"]).toMatchObject({ value: null, period: "2026Q2", status: "missing" });
  });
  it("keeps market values when financial acquisition fails and discloses the failure", async () => {
    const { client, batch } = fixture();
    batch.getCompanyMetricsBatch.mockRejectedValue(new MopsfinError("UPSTREAM_TIMEOUT", "financial unavailable"));
    const output = await client.compareCompanies({ ...query, columns: ["financial.EPS", "valuation.pe"] });
    expect(output.failures).toContainEqual(expect.objectContaining({ domain: "financial", code: "UPSTREAM_TIMEOUT" }));
    expect(fullRows(output)[0].cells["financial.EPS"].status).toBe("source_unavailable");
    expect(fullRows(output)[0].cells["valuation.pe"]).toMatchObject({ value: 20, status: "available" });
  });
  it("does not fetch financial data without financial columns and rejects ineffective period args", async () => {
    const { client, catalog, batch } = fixture();
    await client.compareCompanies({ ...query, columns: ["company.name"] });
    expect(catalog.getCatalog).not.toHaveBeenCalled();
    expect(batch.getCompanyMetricsBatch).not.toHaveBeenCalled();
    await expect(client.compareCompanies({ ...query, columns: ["company.name"], financialPeriodPolicy: "common_latest" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.compareCompanies({ ...query, fiscalPeriod: "2026Q1" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.compareCompanies({ ...query, companyCodes: ["2330", "2330"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("separates mixed definitions and mixed quarters in summary groups", async () => {
    const { client } = fixture();
    const output = await client.compareCompanies({ ...query, columns: ["financial.Revenue"], financialPeriodPolicy: "company_latest", outputMode: "summary" });
    expect(output.presentation).toMatchObject({ rowCount: 3, scope: "entire_selection", statistics: [{ field: "financial.Revenue", definitionMismatch: true, groups: [{ period: "2026Q1", count: 1 }, { period: "2026Q2", count: 1 }, { period: "2026Q2", count: 1 }] }] });
  });
  it("does not normalize a batch value whose unit contradicts the catalog", async () => {
    const { client, data } = fixture();
    data.companies[0].metrics.find((metric) => metric.metricCode === "Revenue")!.unit = "USD";
    const output = await client.compareCompanies(query);
    expect(fullRows(output)[1].cells["financial.Revenue"]).toMatchObject({ value: null, status: "invalid_upstream", reason: expect.stringContaining("單位") });
    expect(fullRows(output)[1].cells["financial.EPS"].value).toBe(2.5);
  });
});
