import { describe, expect, it } from "vitest";

import { companyMasterClient } from "@/lib/company-master/client";
import { mopsfinClient } from "@/lib/mopsfin/client";
import { priceClient } from "@/lib/price/client";

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

  it("lists complete official listed, OTC and combined company universes", async () => {
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

  it("discovers the complete current catalog and company suggestions", async () => {
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
});
