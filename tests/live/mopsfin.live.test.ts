import { describe, expect, it } from "vitest";

import { companyMasterClient } from "@/lib/company-master/client";
import { companyMetricsBatchClient } from "@/lib/mopsfin/batch";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { priceClient } from "@/lib/price/client";
import { reactionClient } from "@/lib/reaction/client";
import { monthlyRevenueClient } from "@/lib/revenue/client";
import { valuationClient } from "@/lib/valuation/client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live Mopsfin contracts", () => {
  it("merges live OTC-to-listed history and resolves a delisted code", async () => {
    const transferred = await priceClient.getStockOhlc({
      companyCode: "3416",
      startDate: "2014-12-01",
      endDate: "2015-01-31",
    });
    const delisted = await priceClient.getStockOhlc({
      companyCode: "2475",
      startDate: "2018-01-01",
      endDate: "2018-01-31",
    });

    expect(transferred.coverage.coverageComplete).toBe(true);
    expect(new Set(transferred.bars.map((bar) => bar.market))).toEqual(
      new Set(["listed", "otc"]),
    );
    expect(transferred.bars.some((bar) => bar.date === "2015-01-22")).toBe(true);
    expect(transferred.bars.some((bar) => bar.date === "2015-01-23")).toBe(true);
    expect(delisted.bars.length).toBeGreaterThan(0);
    expect(delisted.bars.every((bar) => bar.market === "listed")).toBe(true);
  }, 60_000);

  it("continues a live 13-month stock range through the time cursor", async () => {
    const query = {
      companyCode: "2330",
      startDate: "2025-08-01",
      endDate: "2026-08-25",
    };
    const first = await priceClient.getStockOhlc(query);
    expect(first.coverage.coverageComplete).toBe(false);
    expect(first.coverage.nextCursor).toBeTruthy();
    expect(first.coverage.coveredThrough).toBe("2026-07-31");

    const second = await priceClient.getStockOhlc({
      ...query,
      cursor: first.coverage.nextCursor as string,
    });
    expect(second.coverage).toMatchObject({
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      coveredThrough: query.endDate,
      coverageComplete: true,
      nextCursor: null,
    });
    expect(first.bars.length).toBeGreaterThan(0);
    expect(second.bars.length).toBeGreaterThan(0);
    const firstLast = first.bars.at(-1);
    const secondFirst = second.bars.at(0);
    expect(firstLast).toBeDefined();
    expect(secondFirst).toBeDefined();
    expect((firstLast?.date ?? "") < (secondFirst?.date ?? "")).toBe(true);
  }, 60_000);

  it("queries an exact live all-market OHLC date with complete selection", async () => {
    const result = await priceClient.getDailyMarketOhlc({
      market: "all",
      date: "2026-08-24",
      companyCodes: ["2330", "3105"],
    });

    expect(result.coverageComplete).toBe(true);
    expect(result.selectionComplete).toBe(true);
    expect(result.dataDate).toBe("2026-08-24");
    expect(result.bars.map((bar) => [bar.code, bar.market])).toEqual([
      ["2330", "listed"],
      ["3105", "otc"],
    ]);
    expect(result.bars.every((bar) => bar.close !== null)).toBe(true);
  }, 60_000);

  it("lists heuristic-gated official listed, OTC and combined company universes", async () => {
    const listed = await companyMasterClient.listCompanies(
      { market: "listed", includeFinancial: true, includeKy: true },
      true,
    );
    const otc = await companyMasterClient.listCompanies(
      { market: "otc", includeFinancial: true, includeKy: true },
      true,
    );
    const all = await companyMasterClient.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });

    expect(listed.coverageComplete).toBe(true);
    expect(otc.coverageComplete).toBe(true);
    expect(all.coverageComplete).toBe(true);
    expect(listed.coverageVerification.status).toBe("heuristic");
    expect(otc.coverageVerification.officialDeclaredRowCountAvailable).toBe(false);
    expect(all.coverageVerification.status).toBe("heuristic");
    expect(listed.counts.returned).toBeGreaterThan(1_000);
    expect(otc.counts.returned).toBeGreaterThan(800);
    expect(all.counts.returned).toBe(
      listed.counts.returned + otc.counts.returned,
    );
    expect(listed.companies).toContainEqual(
      expect.objectContaining({ code: "2330", market: "listed" }),
    );
    expect(otc.companies).toContainEqual(
      expect.objectContaining({ code: "3105", market: "otc" }),
    );
    expect(all.companies.every((company) => /^\d{4}$/.test(company.code))).toBe(
      true,
    );
    expect(all.companies.some((company) => /-DR$/i.test(company.shortName))).toBe(
      false,
    );
  }, 60_000);

  it("discovers the current catalog and company suggestions", async () => {
    const catalog = await mopsfinClient.getCatalog(true);
    const companies = await mopsfinClient.findCompanies("2330");

    expect(catalog.metrics.length).toBeGreaterThanOrEqual(53);
    expect(new Set(catalog.metrics.map((metric) => metric.family))).toEqual(
      new Set(["data", "report", "bcode", "xb", "fin", "adequacy"]),
    );
    expect(companies).toContainEqual(expect.objectContaining({ code: "2330" }));
  }, 60_000);

  it("queries a real company trend and a specified financial statement", async () => {
    const catalog = await mopsfinClient.getCatalog();
    const revenue = catalog.metrics.find(
      (metric) => metric.family === "data" && metric.name === "營業收入",
    );
    const revenueYoy = catalog.metrics.find(
      (metric) => metric.family === "data" && metric.name === "營業收入年增率",
    );
    expect(revenue).toBeDefined();
    expect(revenueYoy).toBeDefined();

    const trend = await mopsfinClient.getCompanyMetric({
      metricCode: revenue?.code as string,
      companyCodes: ["2330"],
      basis: "quarterly",
      includeIndustryAverage: false,
      includeCompanyAverage: false,
      range: { history: "recent_12" },
    });
    const statement = await mopsfinClient.getFinancialStatement({
      statement: "balance_sheet",
      companyCodes: ["2330"],
      period: "2025Q4",
      page: { offset: 0, limit: 5 },
    });
    const cumulativeYoy = await mopsfinClient.getCompanyMetric({
      metricCode: revenueYoy?.code as string,
      companyCodes: ["2330"],
      basis: "cumulative_yoy",
      yoyQuarter: 4,
      includeIndustryAverage: false,
      includeCompanyAverage: false,
      range: { history: "recent_12" },
    });

    expect(trend.periods.length).toBeGreaterThan(0);
    expect(trend.series.length).toBeGreaterThan(0);
    expect(cumulativeYoy.series.length).toBeGreaterThan(0);
    expect(statement.period).toBe("2025Q4");
    expect(statement.pagination.returnedRows).toBeGreaterThan(0);
  }, 60_000);

  it("queries a real financial note and industry statistics", async () => {
    const catalog = await mopsfinClient.getCatalog();
    const semiconductor = catalog.industries.find((industry) =>
      /半導體/.test(industry.name),
    );
    expect(semiconductor).toBeDefined();
    const note = await mopsfinClient.getFinancialNote({
      note: "consolidated_subsidiaries",
      companyCodes: ["2330"],
      period: "2025Q4",
      page: { offset: 0, limit: 5 },
    });
    const industry = await mopsfinClient.getIndustryData({
      mode: "statistics",
      measure: "revenue",
      industryCodes: [],
      period: "2025Q4",
      range: { history: "recent_12" },
    });
    const industryTrend = await mopsfinClient.getIndustryData({
      mode: "trend",
      measure: "revenue",
      industryCodes: [semiconductor?.code as string],
      period: "latest",
      range: { history: "recent_12" },
    });

    expect(note.period).toBe("2025Q4");
    expect(note.pagination.returnedRows).toBeGreaterThan(0);
    expect(industry.series.length).toBeGreaterThan(0);
    expect(industryTrend.periods.length).toBeGreaterThan(0);
  }, 60_000);

  it("queries live financial-asset-quality and capital-adequacy series", async () => {
    const catalog = await mopsfinClient.getCatalog();
    const bank = catalog.financialInstitutions.find(
      (institution) => institution.sector === "bank",
    );
    const assetQuality = catalog.metrics.find((metric) => metric.family === "fin");
    const bankAdequacy = catalog.metrics.find(
      (metric) => metric.family === "adequacy" && /銀行/.test(metric.name),
    );
    expect(bank).toBeDefined();
    expect(assetQuality).toBeDefined();
    expect(bankAdequacy).toBeDefined();

    const first = await mopsfinClient.getFinancialInstitutionMetric({
      metricCode: assetQuality?.code as string,
      institutionCodes: [bank?.code as string],
      includeIndustryAverage: false,
      includeInstitutionAverage: false,
      range: { history: "recent_12" },
    });
    const second = await mopsfinClient.getFinancialInstitutionMetric({
      metricCode: bankAdequacy?.code as string,
      institutionCodes: [bank?.code as string],
      includeIndustryAverage: true,
      includeInstitutionAverage: true,
      range: { history: "recent_12" },
    });

    expect(first.series.length).toBeGreaterThan(0);
    expect(second.series.length).toBeGreaterThan(0);
    expect(second.query).toMatchObject({
      includeIndustryAverage: true,
      includeInstitutionAverage: true,
    });
    expect(second.series.some((series) => /公司平均數/.test(series.label))).toBe(
      true,
    );
  }, 60_000);

  it("validates the README ROE and non-null bank-capital examples", async () => {
    const catalog = await mopsfinClient.getCatalog();
    const roe = catalog.metrics.find(
      (metric) => metric.family === "data" && metric.name === "權益報酬率",
    );
    const bankCapital = catalog.metrics.find(
      (metric) =>
        metric.family === "adequacy" && metric.name === "銀行業資本適足率",
    );
    const taiwanBusinessBank = catalog.financialInstitutions.find(
      (institution) => institution.name === "臺企銀",
    );
    expect(roe).toBeDefined();
    expect(bankCapital).toBeDefined();
    expect(taiwanBusinessBank).toBeDefined();

    const roeResult = await mopsfinClient.getCompanyMetric({
      metricCode: roe?.code as string,
      companyCodes: ["2330", "2454"],
      basis: "quarterly",
      includeIndustryAverage: false,
      includeCompanyAverage: false,
      range: { history: "recent_12" },
    });
    const bankResult = await mopsfinClient.getFinancialInstitutionMetric({
      metricCode: bankCapital?.code as string,
      institutionCodes: [taiwanBusinessBank?.code as string],
      includeIndustryAverage: true,
      includeInstitutionAverage: false,
      range: { history: "recent_12" },
    });

    expect(roeResult.series).toHaveLength(2);
    expect(
      roeResult.series.every((series) =>
        series.points.some((point) => point.value !== null),
      ),
    ).toBe(true);
    expect(bankResult.series).toContainEqual(
      expect.objectContaining({ label: "臺企銀" }),
    );
    expect(
      bankResult.series
        .find((series) => series.label === "臺企銀")
        ?.points.some((point) => point.value !== null),
    ).toBe(true);
    expect(bankResult.warnings.join(" ")).toContain("已忽略以避免錯置期別");
    expect(
      bankResult.series.every(
        (series) =>
          new Set(series.points.map((point) => point.period)).size ===
          series.points.length,
      ),
    ).toBe(true);
  }, 60_000);

  it("queries live latest valuation and monthly-revenue contracts", async () => {
    const [valuation, revenue] = await Promise.all([
      valuationClient.getDailyMarketValuation({
        market: "all",
        date: "latest",
        companyCodes: ["2330", "3105"],
        universePolicy: "compatible",
      }),
      monthlyRevenueClient.getMonthlyRevenue({
        market: "all",
        dataMonth: "latest",
        companyCodes: ["2330", "3105"],
        universePolicy: "compatible",
      }),
    ]);

    expect(valuation.selectionComplete).toBe(true);
    expect(valuation.rows.map((row) => row.code)).toEqual(["2330", "3105"]);
    expect(valuation.sources.length).toBeGreaterThanOrEqual(2);
    expect(valuation.sources.every((source) => source.dataDate === valuation.dataDate)).toBe(true);
    expect(revenue.selectionComplete).toBe(true);
    expect(revenue.rows.map((row) => row.code)).toEqual(["2330", "3105"]);
    expect(revenue.dataMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(revenue.sources.every((source) => source.dataMonth === revenue.dataMonth)).toBe(true);
  }, 60_000);

  it("queries a live historical revenue trend and reaction benchmark", async () => {
    const [trend, reaction] = await Promise.all([
      monthlyRevenueClient.getMonthlyRevenueTrend({
        market: "all",
        companyCodes: ["2330", "3105"],
        endMonth: "2026-07",
        lookbackMonths: 3,
        universePolicy: "compatible",
      }),
      reactionClient.getStockReactionSignals({
        companyCodes: ["2330"],
        asOf: "latest",
        horizons: [5],
        pageSize: 1,
      }),
    ]);

    expect(trend.startMonth).toBe("2026-05");
    expect(trend.endMonth).toBe("2026-07");
    expect(trend.companies).toHaveLength(2);
    expect(trend.companies.every((company) => company.points.length === 3)).toBe(true);
    expect(reaction.companies).toHaveLength(1);
    expect(reaction.companies[0].returns).toContainEqual(
      expect.objectContaining({ horizonSessions: 5 }),
    );
    expect(reaction.benchmarkSources.length).toBeGreaterThan(0);
  }, 60_000);

  it("runs the production batch identity path for eleven companies", async () => {
    const catalog = await mopsfinClient.getCatalog();
    const roe = catalog.metrics.find(
      (metric) => metric.family === "data" && metric.name === "權益報酬率",
    );
    expect(roe).toBeDefined();
    const companyCodes = [
      "1101",
      "1102",
      "1216",
      "1301",
      "1303",
      "1326",
      "1402",
      "2002",
      "2105",
      "2207",
      "2303",
    ];

    const result = await companyMetricsBatchClient.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: [roe?.code as string],
      basis: "quarterly",
    });

    expect(result.query.companyCodes).toEqual(companyCodes);
    expect(result.companies).toHaveLength(11);
    expect(result.companies.map((company) => company.companyCode)).toEqual(companyCodes);
  }, 60_000);
});
