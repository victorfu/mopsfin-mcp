import { describe, expect, it } from "vitest";

import { mopsfinClient } from "@/lib/mopsfin/client";

const liveDescribe =
  process.env.RUN_LIVE_MOPSFIN_TESTS === "1" ? describe : describe.skip;

liveDescribe("live Mopsfin contracts", () => {
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
      range: { history: "recent_12" },
    });
    const second = await mopsfinClient.getFinancialInstitutionMetric({
      metricCode: bankAdequacy?.code as string,
      institutionCodes: [bank?.code as string],
      range: { history: "recent_12" },
    });

    expect(first.series.length).toBeGreaterThan(0);
    expect(second.series.length).toBeGreaterThan(0);
  }, 60_000);
});
