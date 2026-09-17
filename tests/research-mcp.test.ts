import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { screenerClient, ScreenerClient } from "@/lib/screener/client";
import { comparisonClient } from "@/lib/comparison/client";
import { stockTechnicalsClient } from "@/lib/technicals/client";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { listCatalogOutputSchema } from "@/lib/mcp/schema/financials";
import { registerToolRegistry } from "@/lib/mcp/tool-registry";
import { screenCompaniesOutputSchema, compareCompaniesOutputSchema, stockTechnicalsOutputSchema } from "@/lib/mcp/schema/research-outputs";
import { researchMarketFixture, researchNow } from "./fixtures/research-market";
import { comparisonFixture } from "./fixtures/research-comparison";
import { technicalFixture } from "./fixtures/research-technicals";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import { priceClient } from "@/lib/price/client";
import { valuationClient } from "@/lib/valuation/client";
import { monthlyRevenueClient } from "@/lib/revenue/client";
import { stockPriceSeriesClient } from "@/lib/price-series/client";
import { PriceSeriesSummaryClient, priceSeriesSummaryClient } from "@/lib/research/price-summary";
import { companyMetricsBatchClient } from "@/lib/mopsfin/batch";
import { dailyMarketOhlcOutputSchema } from "@/lib/mcp/schema/price";
import { dailyMarketValuationOutputSchema } from "@/lib/mcp/schema/valuation";
import { monthlyRevenueOutputSchema } from "@/lib/mcp/schema/revenue";
import { companyMetricsBatchOutputSchema } from "@/lib/mcp/schema/financials";
import { stockPriceSeriesOutputSchema } from "@/lib/mcp/schema/price-series";
import { UpstreamReliabilityError } from "@/lib/upstream/reliability";

afterEach(() => vi.restoreAllMocks());

async function connected(task: (client: Client) => Promise<void>) {
  const server = new McpServer({ name: "research-integration", version: "test" });
  const client = new Client({ name: "test", version: "test" });
  registerToolRegistry(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(b); await client.connect(a); await task(client); }
  finally { await Promise.allSettled([client.close(), server.close()]); }
}
async function validCall(client: Client, name: string, args: Record<string, unknown>, schema: z.ZodType) {
  const output = await client.callTool({ name, arguments: args });
  expect(output.isError, JSON.stringify(output.content)).not.toBe(true);
  const parsed = schema.safeParse(output.structuredContent);
  expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  // The schema must describe the actual payload, not silently drop new metadata.
  expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(JSON.parse(JSON.stringify(output.structuredContent)));
  return output.structuredContent as Record<string, unknown>;
}

describe("public research MCP tools", () => {
  it.each([
    { code: "DEADLINE_EXCEEDED" as const, reason: "UPSTREAM_DEADLINE_EXCEEDED", retryable: true },
    { code: "ABORTED" as const, reason: "UPSTREAM_OPERATION_ABORTED", retryable: false },
  ])("preserves orchestration $code in the public error contract", async ({ code, reason, retryable }) => {
    vi.spyOn(stockTechnicalsClient, "getStockTechnicals").mockRejectedValue(new UpstreamReliabilityError(code, "fixture"));
    await connected(async (client) => {
      const output = await client.callTool({ name: "get_stock_technicals", arguments: { company_code: "2330" } });
      expect(output.isError).toBe(true);
      expect(output.structuredContent).toMatchObject({ ok: false, error: { code: "UPSTREAM_TIMEOUT", reason, retryable } });
    });
  });
  it("serves static research fields without upstream and adds financial fields to kind=all", async () => {
    const getCatalog = vi.spyOn(mopsfinClient, "getCatalog").mockRejectedValue(new Error("upstream unavailable"));
    await connected(async (client) => {
      const staticFields = await validCall(client, "list_catalog", { kind: "research_fields", query: "valuation" }, listCatalogOutputSchema);
      expect(staticFields).toMatchObject({ scope: "static_fields", financialFieldsIncluded: false, researchFieldsCount: 20, researchFields: [{ id: "valuation.pe" }, { id: "valuation.pb" }, { id: "valuation.dividend_yield_pct" }] });
      expect(getCatalog).not.toHaveBeenCalled();
      getCatalog.mockResolvedValue(comparisonFixture().catalogData);
      const all = await validCall(client, "list_catalog", { kind: "all" }, listCatalogOutputSchema);
      expect(all).toMatchObject({ researchFieldsCount: 23, researchFields: expect.arrayContaining([expect.objectContaining({ id: "financial.EPS", unit: "TWD/share" })]) });
    });
  });
  it("registers and serves all three presentation variants with source/freshness/page metadata", async () => {
    const fixture = researchMarketFixture();
    const domain = new ScreenerClient(fixture.dependencies, fixture.catalog, researchNow);
    vi.spyOn(screenerClient, "screenCompanies").mockImplementation(domain.screenCompanies.bind(domain));
    await connected(async (client) => {
      for (const mode of ["full", "compact", "summary"]) {
        const output = await validCall(client, "screen_companies", { company_codes: ["2330", "6488"], columns: ["valuation.pe", "revenue.yoy_pct"], filters: [{ field: "revenue.yoy_pct", op: "gt", value: 20 }], page_size: 1, output_mode: mode }, screenCompaniesOutputSchema);
        expect(output).toMatchObject({ counts: { matched: 2 }, meta: { quality: { universe: "unverified" }, page: { returned: 1, total: 2 } }, presentation: { outputMode: mode, rowCount: mode === "summary" ? 2 : 1 } });
        expect(output).toMatchObject({ meta: { asOf: { sourceCutoffs: expect.arrayContaining([
          expect.objectContaining({ resolved: { granularity: "date", from: "2026-08-28", through: "2026-08-28" } }),
          expect.objectContaining({ resolved: { granularity: "month", from: "2026-07", through: "2026-07" } }),
        ]) } } });
      }
    });
  });
  it("preserves financial definitions, aligned periods, and summary grouping through callTool", async () => {
    const fixture = comparisonFixture();
    vi.spyOn(comparisonClient, "compareCompanies").mockImplementation(fixture.client.compareCompanies.bind(fixture.client));
    await connected(async (client) => {
      for (const mode of ["full", "compact", "summary"]) {
        const output = await validCall(client, "compare_companies", { company_codes: ["2330", "6488", "2881"], columns: ["financial.Revenue", "financial.EPS", "financial.GrossMargin", "valuation.pe"], output_mode: mode }, compareCompaniesOutputSchema);
        expect(output).toMatchObject({ alignment: { commonPeriod: "2026Q1" }, meta: { quality: { values: "complete", freshness: "unknown", issues: expect.arrayContaining([expect.objectContaining({ code: "RESEARCH_DEFINITION_MISMATCH" })]) } } });
      }
      const rejected = await client.callTool({ name: "compare_companies", arguments: { company_codes: ["2330"], columns: ["price.close"], financial_period_policy: "explicit", financial_period: "2026Q1" } });
      expect(rejected.isError).toBe(true);
    });
  });
  it("serves technical indicator evidence and reports partial indicator windows in meta", async () => {
    const fixture = technicalFixture({ missingLast: true });
    vi.spyOn(stockTechnicalsClient, "getStockTechnicals").mockImplementation(fixture.client.getStockTechnicals.bind(fixture.client));
    await connected(async (client) => {
      const output = await validCall(client, "get_stock_technicals", { company_code: "2330", indicators: ["sma"], sma_periods: [5], price_basis: "raw_unadjusted" }, stockTechnicalsOutputSchema);
      expect(output).toMatchObject({ asOf: "2026-08-28", indicators: { sma_5: { value: null, reason: "missing_session_bar" } }, meta: { quality: { values: "partial", issues: expect.arrayContaining([expect.objectContaining({ code: "TECHNICAL_INDICATOR_UNAVAILABLE" })]) } } });
      expect(output).toMatchObject({ meta: { asOf: { sourceCutoffs: expect.arrayContaining([
        expect.objectContaining({ sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L", resolved: expect.objectContaining({ granularity: "date" }) }),
      ]) } } });
    });
  });
});

function withoutAssemblyTimes(value: unknown) {
  return JSON.parse(JSON.stringify(value, (key, item) => ["servedAt", "assembledAt"].includes(key) ? undefined : item));
}

describe("legacy tool projection MCP contracts", () => {
  it("keeps the original full payload and projects all three market domains without another acquisition", async () => {
    const fixture = researchMarketFixture();
    expect(dailyMarketOhlcOutputSchema.safeParse({ ...fixture.price, ok: true, meta: buildResultMeta(fixture.price) }).error).toBeUndefined();
    const price = vi.spyOn(priceClient, "getDailyMarketOhlc").mockResolvedValue(fixture.price);
    const valuation = vi.spyOn(valuationClient, "getDailyMarketValuation").mockResolvedValue(fixture.valuation);
    const revenue = vi.spyOn(monthlyRevenueClient, "getMonthlyRevenue").mockResolvedValue(fixture.revenue);
    const cases = [
      { name: "get_daily_market_ohlc", args: { date: "2026-08-28" }, column: "price.close", schema: dailyMarketOhlcOutputSchema, mock: price },
      { name: "get_daily_market_valuation", args: { date: "2026-08-28" }, column: "valuation.pe", schema: dailyMarketValuationOutputSchema, mock: valuation },
      { name: "get_monthly_revenue", args: { data_month: "2026-07" }, column: "revenue.yoy_pct", schema: monthlyRevenueOutputSchema, mock: revenue },
    ];
    await connected(async (client) => {
      for (const item of cases) {
        const legacy = await validCall(client, item.name, item.args, item.schema);
        const full = await validCall(client, item.name, { ...item.args, output_mode: "full" }, item.schema);
        expect(withoutAssemblyTimes(full)).toEqual(withoutAssemblyTimes(legacy));
        expect(full).not.toHaveProperty("presentation");
        for (const mode of ["full", "compact", "summary"]) {
          const output = await validCall(client, item.name, { ...item.args, page_size: 1, output_mode: mode, columns: [item.column] }, item.schema);
          expect(output).toMatchObject({ rawRowsOmitted: true, sources: legacy.sources, meta: { page: { returned: 1, total: 3 } }, presentation: { outputMode: mode, rowCount: mode === "summary" ? 3 : 1, scope: mode === "summary" ? "entire_selection" : "current_page" } });
          expect(output).not.toHaveProperty("bars");
          expect(output).not.toHaveProperty("rows");
        }
        expect(item.mock).toHaveBeenCalledTimes(5);
        const rejected = await client.callTool({ name: item.name, arguments: { ...item.args, columns: ["unknown.field"] } });
        expect(rejected.isError).toBe(true);
        expect(item.mock).toHaveBeenCalledTimes(5);
      }
    });
  });

  it("marks selected missing values outside the first market page in a whole-selection summary", async () => {
    const fixture = researchMarketFixture();
    fixture.valuation.rows[1].peRatio = null;
    fixture.valuation.rows[1].valueStatus.peRatio = "missing_or_not_meaningful";
    vi.spyOn(valuationClient, "getDailyMarketValuation").mockResolvedValue(fixture.valuation);
    await connected(async (client) => {
      const output = await validCall(client, "get_daily_market_valuation", { date: "2026-08-28", page_size: 1, columns: ["valuation.pe"], output_mode: "summary" }, dailyMarketValuationOutputSchema);
      expect(output).toMatchObject({ meta: { quality: { values: "partial" } }, presentation: { statistics: [{ total: 3, usableCount: 2, statusCounts: { available: 2, missing: 1 } }] } });
    });
  });

  it("serves batch compact and summary for only the evaluated page, retaining cursor and quality", async () => {
    const fixture = comparisonFixture();
    vi.spyOn(mopsfinClient, "getCatalog").mockResolvedValue(fixture.catalogData);
    vi.spyOn(companyMetricsBatchClient, "getCompanyMetricsBatch").mockImplementation(async (query) => ({
      ...fixture.data, query: { ...fixture.data.query, ...query },
      companies: fixture.data.companies.filter((company) => query.companyCodes.includes(company.companyCode)),
      coverage: { ...fixture.data.coverage, requestedCompanyCodes: query.companyCodes, returnedCompanyCodes: query.companyCodes },
    }));
    await connected(async (client) => {
      expect(companyMetricsBatchOutputSchema.safeParse({ ...fixture.data, ok: true, meta: buildResultMeta(fixture.data) }).error).toBeUndefined();
      const args = { company_codes: ["2330", "6488", "2881"], metric_codes: ["Revenue", "EPS", "GrossMargin"], page_size: 1 };
      const legacy = await validCall(client, "get_company_metrics_batch", args, companyMetricsBatchOutputSchema);
      const full = await validCall(client, "get_company_metrics_batch", { ...args, output_mode: "full" }, companyMetricsBatchOutputSchema);
      expect(withoutAssemblyTimes(full)).toEqual(withoutAssemblyTimes(legacy));
      for (const mode of ["compact", "summary"]) {
        const output = await validCall(client, "get_company_metrics_batch", { ...args, output_mode: mode }, companyMetricsBatchOutputSchema);
        expect(output).toMatchObject({ rawCompaniesOmitted: true, sources: legacy.sources, coverage: legacy.coverage, meta: { page: { returned: 1, total: 3, next: expect.anything() } }, presentation: { scope: "current_page", outputMode: mode } });
        expect(output).not.toHaveProperty("companies");
      }
    });
  });

  it("adds session evidence only for price summary and preserves full compatibility", async () => {
    const fixture = technicalFixture();
    const data = await fixture.prices.getStockPriceSeries({ companyCode: "2330", startDate: "2026-08-24", endDate: "2026-08-28", priceBasis: "raw_unadjusted", includeEventLedger: false });
    vi.spyOn(stockPriceSeriesClient, "getStockPriceSeries").mockResolvedValue(data);
    const domain = new PriceSeriesSummaryClient(fixture.benchmark);
    vi.spyOn(priceSeriesSummaryClient, "summarize").mockImplementation(domain.summarize.bind(domain));
    await connected(async (client) => {
      const args = { company_code: "2330", start_date: "2026-08-24", end_date: "2026-08-28", price_basis: "raw_unadjusted", include_event_ledger: false };
      const legacy = await validCall(client, "get_stock_price_series", args, stockPriceSeriesOutputSchema);
      const full = await validCall(client, "get_stock_price_series", { ...args, output_mode: "full" }, stockPriceSeriesOutputSchema);
      expect(withoutAssemblyTimes(full)).toEqual(withoutAssemblyTimes(legacy));
      expect(fixture.benchmark.getHistory).not.toHaveBeenCalled();
      const output = await validCall(client, "get_stock_price_series", { ...args, output_mode: "summary" }, stockPriceSeriesOutputSchema);
      expect(output).not.toHaveProperty("bars");
      expect(output).toMatchObject({ barsOmitted: true, eventLedger: legacy.eventLedger, coverage: legacy.coverage, sources: legacy.sources, summary: { complete: true, scope: "complete_collected_requested_window", barCount: 5, expectedSessions: 5 }, summaryWorkBudget: { benchmarkCalls: 1 } });
      expect(fixture.benchmark.getHistory).toHaveBeenCalledExactlyOnceWith("listed", ["2026-08"]);
      expect(stockPriceSeriesOutputSchema.safeParse({ ...output, summary: { ...(output.summary as object), barCount: 3 } }).success).toBe(false);
    });
  });

  it("reduces a 250-bar public response by at least half while retaining provenance and reporting calendar failure", async () => {
    const fixture = technicalFixture();
    const data = await fixture.prices.getStockPriceSeries({ companyCode: "2330", startDate: "2026-08-24", endDate: "2026-08-28", priceBasis: "raw_unadjusted", includeEventLedger: false });
    const dates: string[] = [];
    for (let day = 0; dates.length < 250; day++) {
      const date = new Date(Date.UTC(2025, 8, 1 + day));
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
    }
    data.bars = dates.map((date, index) => ({ ...data.bars[0], date, close: 100 + index }));
    data.query.startDate = dates[0]; data.query.endDate = dates.at(-1)!;
    data.coverage.requestedStart = dates[0]; data.coverage.requestedEnd = dates.at(-1)!;
    data.coverage.rawPrice.barCount = 250; data.coverage.rawPrice.coveredThrough = dates.at(-1)!;
    data.adjustment.anchorDate = dates.at(-1)!;
    const source = { market: "listed" as const, exchange: "TWSE" as const, benchmarkCode: "TAIEX" as const, benchmarkName: "發行量加權股價指數" as const, sourceName: "fixture benchmark", sourceUrl: "https://www.twse.com.tw/fixture-benchmark", dataMonth: "2026-08", retrievedAt: "2026-08-28T07:00:00Z", rowCount: 250 };
    const benchmark = { getHistory: vi.fn(async () => ({ market: "listed" as const, benchmarkCode: "TAIEX" as const, benchmarkName: "發行量加權股價指數" as const, priceBasis: "price_index" as const, sources: [source], bars: dates.map((date) => ({ date, close: 100 })) })) };
    const domain = new PriceSeriesSummaryClient(benchmark);
    vi.spyOn(stockPriceSeriesClient, "getStockPriceSeries").mockResolvedValue(data);
    vi.spyOn(priceSeriesSummaryClient, "summarize").mockImplementation(domain.summarize.bind(domain));
    await connected(async (client) => {
      const args = { company_code: "2330", start_date: dates[0], end_date: dates.at(-1), price_basis: "raw_unadjusted", include_event_ledger: false };
      const full = await validCall(client, "get_stock_price_series", args, stockPriceSeriesOutputSchema);
      const summary = await validCall(client, "get_stock_price_series", { ...args, output_mode: "summary" }, stockPriceSeriesOutputSchema);
      expect(Buffer.byteLength(JSON.stringify(summary)) / Buffer.byteLength(JSON.stringify(full))).toBeLessThan(0.5);
      expect(summary).toMatchObject({ sources: full.sources, coverage: full.coverage, eventLedger: full.eventLedger, warnings: full.warnings, summarySources: [source], meta: { asOf: { sourceCutoffs: expect.arrayContaining([expect.objectContaining({ sourceUrl: source.sourceUrl, retrievedAt: source.retrievedAt })]) } } });
      benchmark.getHistory.mockRejectedValueOnce(new Error("benchmark unavailable"));
      const failed = await validCall(client, "get_stock_price_series", { ...args, output_mode: "summary" }, stockPriceSeriesOutputSchema);
      expect(failed).toMatchObject({ summaryFailure: { code: expect.any(String) }, meta: { quality: { source: "partial", values: "partial" } }, summary: { complete: false, endpointReturnPercent: { status: "available" }, maxDrawdownPercent: { value: null }, dailyLogReturnSampleStdDev: { value: null } } });
    });
  });
});
