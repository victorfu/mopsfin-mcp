import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { MopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinHttpClient } from "@/lib/mopsfin/http";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);
const reportHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/report.html", import.meta.url)),
  "utf8",
);
const companyMetricPartial = readFileSync(
  fileURLToPath(
    new URL("./fixtures/company-metric-partial.json", import.meta.url),
  ),
  "utf8",
);

function response(body: string, contentType = "text/html") {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

describe("MopsfinClient", () => {
  it("resolves company codes and probes backward when latest silently returns a wrong quarter", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(catalogHtml);
      if (parsed.pathname === "/suggestCompany") {
        return response(
          JSON.stringify({ suggestions: ["2330 台積電"] }),
          "application/json",
        );
      }
      if (parsed.pathname === "/compare/report") {
        const ys = (init?.body as URLSearchParams).get("ys");
        expect(["20262", "20261"]).toContain(ys);
        return response(reportHtml);
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
      () => new Date("2026-08-24T00:00:00+08:00"),
    );

    const result = await client.getFinancialStatement({
      statement: "balance_sheet",
      companyCodes: ["2330"],
      period: "latest",
      page: { offset: 0, limit: 100 },
    });

    expect(result.period).toBe("2026Q1");
    expect(result.query.companies).toEqual(["2330 台積電"]);
    expect(result.pagination.totalRows).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/compare/report"),
      ),
    ).toHaveLength(2);
  });

  it("rejects a requested period when Mopsfin returns a different period", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(catalogHtml);
      if (parsed.pathname === "/suggestCompany") {
        return response(JSON.stringify({ suggestions: ["2330 台積電"] }));
      }
      return response(reportHtml);
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );

    await expect(
      client.getFinancialStatement({
        statement: "balance_sheet",
        companyCodes: ["2330"],
        period: "2026Q2",
        page: { offset: 0, limit: 100 },
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("reports invalid company-search JSON as an upstream error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("not-json"));
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );

    await expect(client.findCompanies("2330")).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
    });
  });

  it("requires yoy_quarter for cumulative YOY requests before upstream data access", async () => {
    const client = new MopsfinClient();

    await expect(
      client.getCompanyMetric({
        metricCode: "RevenueYoY",
        companyCodes: ["2330"],
        basis: "cumulative_yoy",
        includeIndustryAverage: false,
        includeCompanyAverage: false,
        range: { history: "recent_12" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("binds reordered company series through upstream identity metadata and reports partial coverage", async () => {
    const suggestions: Record<string, string> = {
      "2330": "2330 台積電",
      "2454": "2454 聯發科",
      "2317": "2317 鴻海",
    };
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(catalogHtml);
      if (parsed.pathname === "/suggestCompany") {
        const query = parsed.searchParams.get("query") ?? "";
        return response(
          JSON.stringify({ suggestions: [suggestions[query]] }),
          "application/json",
        );
      }
      if (parsed.pathname === "/compare/data") {
        const body = init?.body as URLSearchParams;
        expect(body.getAll("companyId")).toEqual([
          "2330 台積電",
          "2454 聯發科",
          "2317 鴻海",
        ]);
        expect(body.get("bcodeAvg")).toBe("true");
        expect(body.get("companyAvg")).toBe("true");
        return response(companyMetricPartial, "application/json");
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );

    const result = await client.getCompanyMetric({
      metricCode: "RevenueYoY",
      companyCodes: ["2330", "2454", "2317"],
      basis: "quarterly",
      includeIndustryAverage: true,
      includeCompanyAverage: true,
      range: { history: "recent_12" },
    });

    expect(result.periods).toHaveLength(12);
    expect(result.periods[0]).toBe("2022Q2");
    expect(result.periods.at(-1)).toBe("2025Q1");
    expect(result.query).toMatchObject({
      includeIndustryAverage: true,
      includeCompanyAverage: true,
    });
    expect(
      result.series.find((series) => series.label === "TSMC"),
    ).toMatchObject({
      seriesType: "company",
      companyCode: "2330",
      companyName: "台積電",
      displayName: "2330 台積電",
    });
    expect(
      result.series.find((series) => series.label === "MediaTek"),
    ).toMatchObject({
      seriesType: "company",
      companyCode: "2454",
      companyName: "聯發科",
    });
    expect(
      result.series.find((series) => series.label === "公司平均數")
        ?.seriesType,
    ).toBe("selection_average");
    expect(
      result.series.find((series) => series.label === "半導體產業平均")
        ?.seriesType,
    ).toBe("industry_average");
    expect(result.coverage).toEqual({
      selectionComplete: false,
      requestedCompanyCodes: ["2330", "2454", "2317"],
      returnedCompanyCodes: ["2330", "2454"],
      missingCompanyCodes: ["2317"],
      noValidDataCompanyCodes: ["2454", "2317"],
      commonThroughPeriod: null,
      companies: [
        {
          companyCode: "2330",
          seriesReturned: true,
          nonNullPoints: 12,
          missingPoints: 0,
          invalidPoints: 0,
          firstReportedPeriod: "2022Q2",
          latestReportedPeriod: "2025Q1",
          missingPeriods: [],
        },
        {
          companyCode: "2454",
          seriesReturned: true,
          nonNullPoints: 0,
          missingPoints: 12,
          invalidPoints: 1,
          firstReportedPeriod: null,
          latestReportedPeriod: null,
          missingPeriods: result.periods,
        },
        {
          companyCode: "2317",
          seriesReturned: false,
          nonNullPoints: 0,
          missingPoints: 12,
          invalidPoints: 0,
          firstReportedPeriod: null,
          latestReportedPeriod: null,
          missingPeriods: result.periods,
        },
      ],
    });
    expect(result.warnings.join(" ")).toContain("invalid_upstream");
    expect(result.warnings.join(" ")).toContain("未回傳公司 series：2317");
  });

  it("returns NO_DATA when only averages have reported values", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(catalogHtml);
      if (parsed.pathname === "/suggestCompany") {
        return response(JSON.stringify({ suggestions: ["2330 台積電"] }));
      }
      if (parsed.pathname === "/compare/data") {
        return response(
          JSON.stringify({
            ylabel: "%",
            xaxisList: ["2025Q1"],
            graphData: [
              { label: "2330 台積電", data: [[0, null, "尚未申報"]] },
              { label: "公司平均數", data: [[0, 10]] },
            ],
            showNameList: ["台積電"],
            checkedNameList: ["2330 台積電"],
            displayCompanyId: ["2330 台積電"],
          }),
          "application/json",
        );
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );

    await expect(
      client.getCompanyMetric({
        metricCode: "RevenueYoY",
        companyCodes: ["2330"],
        basis: "quarterly",
        includeIndustryAverage: false,
        includeCompanyAverage: true,
        range: { history: "recent_12" },
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("rejects ambiguous duplicate company series rather than guessing", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(catalogHtml);
      if (parsed.pathname === "/suggestCompany") {
        return response(JSON.stringify({ suggestions: ["2330 台積電"] }));
      }
      return response(
        JSON.stringify({
          ylabel: "%",
          xaxisList: ["2025Q1"],
          graphData: [
            { label: "2330 台積電", data: [[0, 1]] },
            { label: "台積電", data: [[0, 1]] },
          ],
          checkedNameList: ["2330 台積電"],
          displayCompanyId: ["2330 台積電"],
        }),
        "application/json",
      );
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );

    await expect(
      client.getCompanyMetric({
        metricCode: "RevenueYoY",
        companyCodes: ["2330"],
        basis: "quarterly",
        includeIndustryAverage: false,
        includeCompanyAverage: false,
        range: { history: "all" },
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it("validates duplicate selections, incompatible YOY options, and reversed ranges before fetching", async () => {
    const fetchMock = vi.fn();
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );
    const base = {
      metricCode: "RevenueYoY",
      basis: "quarterly" as const,
      includeIndustryAverage: false,
      includeCompanyAverage: false,
    };

    await expect(
      client.getCompanyMetric({
        ...base,
        companyCodes: ["2330", "2330"],
        range: { history: "all" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.getCompanyMetric({
        ...base,
        companyCodes: ["2330"],
        yoyQuarter: 4,
        range: { history: "all" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.getCompanyMetric({
        ...base,
        companyCodes: ["2330"],
        range: {
          history: "all",
          startPeriod: "2025Q2",
          endPeriod: "2025Q1",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests and explains financial-industry and selected-institution averages", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/") return response(catalogHtml);
      if (parsed.pathname === "/compare/adequacy") {
        const body = init?.body as URLSearchParams;
        expect(body.get("compareItem")).toBe("BankCAR");
        expect(body.getAll("finCompanyId")).toEqual(["0040000"]);
        expect(body.get("bcodeAvg")).toBe("true");
        expect(body.get("companyAvg")).toBe("true");
        return response(
          JSON.stringify({
            ylabel: "%",
            xaxisList: ["2025Q4"],
            graphData: [
              { label: "臺銀", data: [[0, 14.2]] },
              { label: "公司平均數", data: [[0, 14.2]] },
              {
                label: "銀行業資本適足性",
                data: [
                  [0, 15.1],
                  [null, 15.0622, "C"],
                ],
              },
            ],
          }),
          "application/json",
        );
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, { retryDelayMs: 0 }),
    );

    const result = await client.getFinancialInstitutionMetric({
      metricCode: "BankCAR",
      institutionCodes: ["0040000"],
      includeIndustryAverage: true,
      includeInstitutionAverage: true,
      range: { history: "recent_12" },
    });

    expect(result.query).toMatchObject({
      includeIndustryAverage: true,
      includeInstitutionAverage: true,
    });
    expect(result.series.map((series) => series.label)).toEqual([
      "臺銀",
      "公司平均數",
      "銀行業資本適足性",
    ]);
    expect(result.warnings.join(" ")).toContain("不是市值加權");
    expect(result.warnings.join(" ")).toContain("已忽略以避免錯置期別");
    expect(
      result.series.find((series) => series.label === "銀行業資本適足性")
        ?.points,
    ).toEqual([
      { period: "2025Q4", value: 15.1, valueStatus: "reported" },
    ]);
  });
});
