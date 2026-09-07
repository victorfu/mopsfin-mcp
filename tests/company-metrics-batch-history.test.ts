import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { CompanyMetricsBatchClient } from "@/lib/mopsfin/batch";
import { MopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinHttpClient } from "@/lib/mopsfin/http";

const catalogHtml = readFileSync(new URL("./fixtures/catalog.html", import.meta.url), "utf8");
const periods = Array.from({ length: 24 }, (_, index) =>
  `${2020 + Math.floor(index / 4)}Q${index % 4 + 1}`,
);
const halfYearPeriods = periods.filter((period) => /Q[24]$/.test(period));
const now = () => new Date("2026-09-07T03:00:00.000Z");

function setup() {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/") return new Response(catalogHtml);
    if (url.pathname === "/suggestCompany") {
      const code = url.searchParams.get("query");
      return Response.json({ suggestions: [`${code} C${code}`] });
    }
    if (url.pathname !== "/compare/data") throw new Error(`Unexpected ${url.pathname}`);
    const fields = init?.body as URLSearchParams;
    const companyNames = fields.getAll("companyId");
    const metric = fields.get("compareItem");
    return Response.json({
      ylabel: metric === "EPS" ? "元" : "%",
      xaxisList: periods,
      graphData: companyNames.map((label) => {
        const code = label.split(" ")[0];
        return {
          label,
          data: periods.flatMap((period, index) => {
            if (code === "1101" && !halfYearPeriods.includes(period)) return [];
            if (code === "1102" && period > "2022Q4") return [];
            if (code === "1103" && index < 21) return [];
            const value = code === "1104" ? null
              : code === "1105" && period === "2025Q4" ? "invalid-value"
              : 100 + index;
            return [[index, value]];
          }),
        };
      }),
      showNameList: [], checkedNameList: [], extraNameList: [], displayCompanyId: [],
    });
  });
  const client = new MopsfinClient(new MopsfinHttpClient(fetchMock, { now, maxAttempts: 1 }), now);
  return { client, batch: new CompanyMetricsBatchClient(client, now), fetchMock };
}

const query = { metricCodes: ["ROE", "EPS"], basis: "quarterly" as const };

describe("batch history through the real Mopsfin client", () => {
  it("keeps each company's own twelve reported periods across mixed frequencies and cutoffs", async () => {
    const { batch } = setup();
    const result = await batch.getCompanyMetricsBatch({ ...query, companyCodes: ["2330", "1101", "1102"] });
    const expected = [periods.slice(-12), halfYearPeriods, periods.slice(0, 12)];
    result.companies.forEach((company, index) => {
      for (const metric of company.metrics) {
        expect(metric.periods).toEqual(expected[index]);
        expect(metric.coverage.nonNullPoints).toBe(12);
        expect(metric.coverage.missingPoints).toBe(0);
      }
    });
    expect(result.workBudget.comparisonExecutedUnits).toBe(2);
  });

  it("does not change a company's history when its order or upstream chunk changes", async () => {
    const { batch } = setup();
    const fillers = Array.from({ length: 9 }, (_, index) => String(1200 + index));
    const solo = await batch.getCompanyMetricsBatch({ ...query, companyCodes: ["1101"] });
    for (const companyCodes of [["1101", ...fillers, "2330"], ["2330", ...fillers, "1101"]]) {
      const result = await batch.getCompanyMetricsBatch({ ...query, companyCodes });
      expect(result.companies.find((company) => company.companyCode === "1101")?.metrics).toEqual(solo.companies[0].metrics);
      expect(result.workBudget.comparisonExecutedUnits).toBe(4);
    }
  });

  it("keeps short histories and no-data empty, while retaining warnings for excluded invalid points", async () => {
    const { batch } = setup();
    const result = await batch.getCompanyMetricsBatch({ ...query, companyCodes: ["2330", "1103", "1104", "1105"] });
    expect(result.companies[1].metrics[0].periods).toEqual(periods.slice(-3));
    expect(result.companies[2].metrics[0]).toMatchObject({ availability: "no_data", periods: [], points: [], coverage: { nonNullPoints: 0, missingPoints: 0 } });
    expect(result.companies[3].metrics[0].periods).toEqual(periods.slice(-13, -1));
    expect(result.warnings.join(" ")).toContain("invalid_upstream");
    expect(result.warnings.join(" ")).toContain("1105");
  });

  it("retains missing and invalid points for explicit ranges and keeps the standalone tool unchanged", async () => {
    const { batch, client } = setup();
    const result = await batch.getCompanyMetricsBatch({ ...query, companyCodes: ["2330", "1101", "1105"], startPeriod: "2025Q1", endPeriod: "2025Q4" });
    expect(result.companies[1].metrics[0].periods).toEqual(periods.slice(-4));
    expect(result.companies[1].metrics[0].coverage.missingPeriods).toEqual(["2025Q1", "2025Q3"]);
    expect(result.companies[2].metrics[0].coverage.invalidPoints).toBe(1);
    const standalone = await client.getCompanyMetric({ metricCode: "ROE", companyCodes: ["2330", "1101"], basis: "quarterly", includeIndustryAverage: false, includeCompanyAverage: false, range: { history: "recent_12" } });
    expect(standalone.periods).toEqual(periods.slice(-12));
  });
});
