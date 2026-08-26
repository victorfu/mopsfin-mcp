import { describe, expect, it, vi } from "vitest";

import { CompanyMetricsBatchClient } from "@/lib/mopsfin/batch";
import type { MopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";

function metricResult(metricCode: string, companyCodes: string[]) {
  return {
    sourceName: "Mopsfin",
    sourceUrl: "https://mopsfin.twse.com.tw/",
    retrievedAt: "2026-08-26T00:00:00.000Z",
    upstreamRoute: "/compare/data",
    freshnessNote: "daily",
    query: {
      metricCode,
      metricName: metricCode,
      companyCodes,
      companies: companyCodes.map((code) => `${code} C${code}`),
      basis: "quarterly" as const,
      includeIndustryAverage: false,
      includeCompanyAverage: false,
      history: "recent_12" as const,
    },
    unit: "%",
    periods: ["2025Q4", "2026Q1"],
    series: companyCodes.map((code) => ({
      label: `${code} C${code}`,
      seriesType: "company" as const,
      companyCode: code,
      companyName: `C${code}`,
      displayName: `${code} C${code}`,
      points: [
        { period: "2025Q4", value: 10, valueStatus: "reported" as const },
        { period: "2026Q1", value: 12, valueStatus: "reported" as const },
      ],
    })),
    coverage: {
      selectionComplete: true,
      requestedCompanyCodes: companyCodes,
      returnedCompanyCodes: companyCodes,
      missingCompanyCodes: [],
      noValidDataCompanyCodes: [],
      commonThroughPeriod: "2026Q1",
      companies: companyCodes.map((companyCode) => ({
        companyCode,
        seriesReturned: true,
        nonNullPoints: 2,
        missingPoints: 0,
        invalidPoints: 0,
        firstReportedPeriod: "2025Q4",
        latestReportedPeriod: "2026Q1",
        missingPeriods: [],
      })),
    },
    warnings: [],
  };
}

describe("CompanyMetricsBatchClient", () => {
  it("returns company-centric metrics and chunks upstream work by ten companies", async () => {
    const companyCodes = Array.from({ length: 12 }, (_, index) => String(1101 + index));
    const getCompanyMetric = vi.fn(async (options: { metricCode: string; companyCodes: string[] }) =>
      metricResult(options.metricCode, options.companyCodes),
    );
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
          { code: "MARGIN", name: "Margin", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn(async (codes: string[]) =>
        codes.map((code) => ({ code, name: `C${code}`, displayName: `${code} C${code}` })),
      ),
      getCompanyMetric,
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(
      mock,
      () => new Date("2026-08-26T00:00:00.000Z"),
    );

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: ["ROE", "MARGIN"],
      basis: "quarterly",
    });

    expect(getCompanyMetric).toHaveBeenCalledTimes(4);
    expect(result.companies).toHaveLength(12);
    expect(result.companies[0].metrics.map((metric) => metric.metricCode)).toEqual([
      "ROE",
      "MARGIN",
    ]);
    expect(result.coverage.selectionComplete).toBe(true);
  });

  it("rejects period windows over twelve quarters before upstream work", async () => {
    const mock = {
      getCatalog: vi.fn(),
      resolveCompanies: vi.fn(),
      getCompanyMetric: vi.fn(),
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    await expect(
      client.getCompanyMetricsBatch({
        companyCodes: ["2330"],
        metricCodes: ["ROE"],
        basis: "quarterly",
        startPeriod: "2022Q1",
        endPeriod: "2025Q1",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "WORK_BUDGET_EXCEEDED",
    });
    expect(mock.getCatalog).not.toHaveBeenCalled();
  });

  it("returns coverage instead of failing when every upstream chunk has no data", async () => {
    const companyCodes = ["1101", "2330"];
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
          { code: "MARGIN", name: "Margin", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn(async (codes: string[]) =>
        codes.map((code) => ({ code, name: `C${code}`, displayName: `${code} C${code}` })),
      ),
      getCompanyMetric: vi.fn().mockRejectedValue(
        new MopsfinError("NO_DATA", "fixture no data"),
      ),
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: ["ROE", "MARGIN"],
      basis: "quarterly",
    });

    expect(result.companies.map((company) => company.companyCode)).toEqual(
      companyCodes,
    );
    expect(result.coverage).toMatchObject({
      selectionComplete: false,
      returnedCompanyCodes: [],
      missingCompanyCodes: companyCodes,
      noValidDataCompanyCodes: companyCodes,
    });
    expect(result.coverage.metrics).toEqual([
      expect.objectContaining({
        metricCode: "ROE",
        missingCompanyCodes: companyCodes,
        noValidDataCompanyCodes: companyCodes,
      }),
      expect.objectContaining({
        metricCode: "MARGIN",
        missingCompanyCodes: companyCodes,
        noValidDataCompanyCodes: companyCodes,
      }),
    ]);
  });

  it("marks selection partial when any company-metric pair lacks reported values", async () => {
    const companyCodes = ["1101", "2330"];
    const getCompanyMetric = vi.fn(
      async (options: { metricCode: string; companyCodes: string[] }) => {
        if (options.metricCode === "MARGIN") {
          throw new MopsfinError("NO_DATA", "fixture no data");
        }
        return metricResult(options.metricCode, options.companyCodes);
      },
    );
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
          { code: "MARGIN", name: "Margin", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn(async (codes: string[]) =>
        codes.map((code) => ({ code, name: `C${code}`, displayName: `${code} C${code}` })),
      ),
      getCompanyMetric,
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: ["ROE", "MARGIN"],
      basis: "quarterly",
    });

    expect(result.coverage.selectionComplete).toBe(false);
    expect(result.coverage.noValidDataCompanyCodes).toEqual([]);
    expect(result.coverage.missingCompanyCodes).toEqual(companyCodes);
    expect(result.coverage.metrics[1]).toMatchObject({
      metricCode: "MARGIN",
      missingCompanyCodes: companyCodes,
      noValidDataCompanyCodes: companyCodes,
    });
  });

  it("keeps each company metric at no more than its own recent twelve periods", async () => {
    const companyCodes = Array.from({ length: 12 }, (_, index) => String(1101 + index));
    const periodsByChunk = [
      Array.from({ length: 12 }, (_, index) => {
        const year = 2019 + Math.floor(index / 4);
        return `${year}Q${(index % 4) + 1}`;
      }),
      Array.from({ length: 12 }, (_, index) => {
        const year = 2022 + Math.floor(index / 4);
        return `${year}Q${(index % 4) + 1}`;
      }),
    ];
    const getCompanyMetric = vi.fn(
      async (options: { metricCode: string; companyCodes: string[] }) => {
        const periods = periodsByChunk[options.companyCodes[0] === "1101" ? 0 : 1];
        const base = metricResult(options.metricCode, options.companyCodes);
        return {
          ...base,
          periods,
          series: options.companyCodes.map((code) => ({
            label: `${code} C${code}`,
            seriesType: "company" as const,
            companyCode: code,
            companyName: `C${code}`,
            displayName: `${code} C${code}`,
            points: periods.map((period, index) => ({
              period,
              value: index,
              valueStatus: "reported" as const,
            })),
          })),
        };
      },
    );
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn(async (codes: string[]) =>
        codes.map((code) => ({ code, name: `C${code}`, displayName: `${code} C${code}` })),
      ),
      getCompanyMetric,
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: ["ROE"],
      basis: "quarterly",
    });

    expect(result.companies[0].metrics[0].periods).toEqual(periodsByChunk[0]);
    expect(result.companies[10].metrics[0].periods).toEqual(periodsByChunk[1]);
    expect(
      result.companies.every((company) => company.metrics[0].points.length <= 12),
    ).toBe(true);
  });

  it("changes the page-content snapshot when a metric point changes", async () => {
    const buildClient = (value: number) => {
      const mock = {
        getCatalog: vi.fn().mockResolvedValue({
          metrics: [
            { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
          ],
        }),
        resolveCompanies: vi.fn().mockResolvedValue([
          { code: "2330", name: "台積電", displayName: "2330 台積電" },
        ]),
        getCompanyMetric: vi.fn(async () => {
          const result = metricResult("ROE", ["2330"]);
          return {
            ...result,
            series: result.series.map((series) => ({
              ...series,
              points: series.points.map((point) => ({
                ...point,
                value,
              })),
            })),
          };
        }),
      } as unknown as MopsfinClient;
      return new CompanyMetricsBatchClient(
        mock,
        () => new Date("2026-08-26T00:00:00.000Z"),
      );
    };
    const query = {
      companyCodes: ["2330"],
      metricCodes: ["ROE"],
      basis: "quarterly" as const,
    };

    const first = await buildClient(10).getCompanyMetricsBatch(query);
    const changed = await buildClient(11).getCompanyMetricsBatch(query);

    expect(changed.snapshotId).not.toBe(first.snapshotId);
  });
});
