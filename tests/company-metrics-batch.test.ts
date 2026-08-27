import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CompanyMetricsBatchClient } from "@/lib/mopsfin/batch";
import { MopsfinClient } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { MopsfinHttpClient } from "@/lib/mopsfin/http";
import { runWithRequestDeadline } from "@/lib/upstream/reliability";

const catalogHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/catalog.html", import.meta.url)),
  "utf8",
);

function response(body: string, contentType = "text/html") {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

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
    expect(result.failures).toEqual([]);
    expect(result.workBudget).toMatchObject({
      comparisonPlanUnits: 4,
      comparisonExecutedUnits: 4,
      isolationRetryUnits: 0,
      comparisonUnitLimit: 24,
    });
  });

  it("isolates one identity failure and keeps resolved companies", async () => {
    const companyCodes = ["1101", "9999", "2330"];
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn(async (codes: string[]) => {
        const code = codes[0];
        if (code === "9999") {
          throw new MopsfinError("NOT_FOUND", "fixture identity missing", {
            reason: "COMPANY_NOT_FOUND",
            action: "change_query",
          });
        }
        return [{ code, name: `C${code}`, displayName: `${code} C${code}` }];
      }),
      getCompanyMetric: vi.fn(
        async (options: { metricCode: string; companyCodes: string[] }) =>
          metricResult(options.metricCode, options.companyCodes),
      ),
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: ["ROE"],
      basis: "quarterly",
    });

    expect(result.companies.map((company) => company.companyCode)).toEqual([
      "1101",
      "2330",
    ]);
    expect(result.companies.every((company) => company.evaluationStatus === "complete")).toBe(true);
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyCode: "9999",
        stage: "identity",
        metricCode: null,
        attribution: "company",
        code: "NOT_FOUND",
        reason: "COMPANY_NOT_FOUND",
      }),
    ]);
    expect(result.coverage).toMatchObject({
      selectionComplete: false,
      sourceComplete: true,
      failureIsolationComplete: true,
      identityFailedCompanyCodes: ["9999"],
      unavailableCompanyCodes: ["9999"],
      returnedCompanyCodes: ["1101", "2330"],
      missingCompanyCodes: ["9999"],
      noValidDataCompanyCodes: ["9999"],
    });
    expect(mock.getCompanyMetric).toHaveBeenCalledWith(
      expect.objectContaining({ companyCodes: ["1101", "2330"] }),
      expect.any(Array),
    );
  });

  it("fails the request when no company identity can be resolved", async () => {
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn().mockRejectedValue(
        new MopsfinError("NOT_FOUND", "fixture identity missing", {
          reason: "COMPANY_NOT_FOUND",
          action: "change_query",
        }),
      ),
      getCompanyMetric: vi.fn(),
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    await expect(
      client.getCompanyMetricsBatch({
        companyCodes: ["9998", "9999"],
        metricCodes: ["ROE"],
        basis: "quarterly",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reason: "COMPANY_NOT_FOUND",
    });
    expect(mock.getCompanyMetric).not.toHaveBeenCalled();
  });

  it("propagates an ambient deadline failure instead of disguising it as a partial company result", async () => {
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: [
          { code: "ROE", name: "ROE", unit: "%", category: "profit", family: "data" },
        ],
      }),
      resolveCompanies: vi.fn(async (codes: string[]) => {
        const code = codes[0];
        if (code === "2330") {
          throw new MopsfinError("UPSTREAM_TIMEOUT", "fixture deadline", {
            reason: "UPSTREAM_DEADLINE_EXCEEDED",
            retryable: true,
            action: "retry",
          });
        }
        return [{ code, name: `C${code}`, displayName: `${code} C${code}` }];
      }),
      getCompanyMetric: vi.fn(),
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    await expect(
      client.getCompanyMetricsBatch({
        companyCodes: ["1101", "2330"],
        metricCodes: ["ROE"],
        basis: "quarterly",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_DEADLINE_EXCEEDED",
    });
    expect(mock.getCompanyMetric).not.toHaveBeenCalled();
  });

  it("bisects a semantic metric failure to one company within the 24-unit budget", async () => {
    const companyCodes = ["1101", "9999", "2330"];
    const getCompanyMetric = vi.fn(
      async (options: { metricCode: string; companyCodes: string[] }) => {
        if (options.companyCodes.includes("9999")) {
          throw new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            "fixture company series identity conflict",
            {
              reason: "COMPANY_SERIES_IDENTITY_AMBIGUOUS",
              retryable: false,
              action: "none",
            },
          );
        }
        return metricResult(options.metricCode, options.companyCodes);
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

    expect(getCompanyMetric).toHaveBeenCalledTimes(5);
    expect(result.workBudget).toMatchObject({
      comparisonPlanUnits: 1,
      comparisonExecutedUnits: 5,
      isolationRetryUnits: 4,
      comparisonUnitLimit: 24,
    });
    expect(result.workBudget.comparisonExecutedUnits).toBeLessThanOrEqual(24);
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyCode: "9999",
        stage: "metric",
        metricCode: "ROE",
        attribution: "company",
        reason: "COMPANY_SERIES_IDENTITY_AMBIGUOUS",
      }),
    ]);
    expect(result.coverage).toMatchObject({
      selectionComplete: false,
      sourceComplete: false,
      failureIsolationComplete: true,
      unavailableCompanyCodes: ["9999"],
      returnedCompanyCodes: ["1101", "2330"],
    });
    const failed = result.companies.find((company) => company.companyCode === "9999");
    expect(failed).toMatchObject({
      evaluationStatus: "unavailable",
      metrics: [
        {
          metricCode: "ROE",
          availability: "unavailable",
          periods: [],
          points: [],
          failure: expect.objectContaining({ code: "UPSTREAM_BAD_RESPONSE" }),
        },
      ],
    });
  });

  it("keeps successful metrics when a retryable shared chunk fails without false attribution", async () => {
    const companyCodes = ["1101", "2330"];
    const getCompanyMetric = vi.fn(
      async (options: { metricCode: string; companyCodes: string[] }) => {
        if (options.metricCode === "MARGIN") {
          throw new MopsfinError("UPSTREAM_TIMEOUT", "fixture timeout", {
            reason: "UPSTREAM_ATTEMPT_TIMEOUT",
            retryable: true,
            action: "retry",
          });
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

    expect(getCompanyMetric).toHaveBeenCalledTimes(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures).toEqual(
      expect.arrayContaining(
        companyCodes.map((companyCode) =>
          expect.objectContaining({
            companyCode,
            metricCode: "MARGIN",
            attribution: "chunk",
            code: "UPSTREAM_TIMEOUT",
            retryable: true,
          }),
        ),
      ),
    );
    expect(result.coverage).toMatchObject({
      sourceComplete: false,
      failureIsolationComplete: false,
      unavailableCompanyCodes: companyCodes,
    });
    expect(result.companies).toEqual(
      expect.arrayContaining(
        companyCodes.map((companyCode) =>
          expect.objectContaining({
            companyCode,
            evaluationStatus: "partial",
            metrics: expect.arrayContaining([
              expect.objectContaining({ metricCode: "ROE", availability: "available" }),
              expect.objectContaining({ metricCode: "MARGIN", availability: "unavailable" }),
            ]),
          }),
        ),
      ),
    );
  });

  it("never exceeds 24 comparison units when the isolation budget is exhausted", async () => {
    const companyCodes = Array.from({ length: 30 }, (_, index) => String(1000 + index));
    const metricCodes = Array.from({ length: 8 }, (_, index) => `M${index}`);
    const getCompanyMetric = vi.fn(
      async (options: { metricCode: string; companyCodes: string[] }) => {
        if (options.metricCode === "M0" && options.companyCodes.includes("1000")) {
          throw new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            "fixture semantic failure at a full plan budget",
            {
              reason: "COMPANY_SERIES_IDENTITY_AMBIGUOUS",
              retryable: false,
              action: "none",
            },
          );
        }
        return metricResult(options.metricCode, options.companyCodes);
      },
    );
    const mock = {
      getCatalog: vi.fn().mockResolvedValue({
        metrics: metricCodes.map((code) => ({
          code,
          name: code,
          unit: "%",
          category: "profit",
          family: "data",
        })),
      }),
      resolveCompanies: vi.fn(async (codes: string[]) =>
        codes.map((code) => ({ code, name: `C${code}`, displayName: `${code} C${code}` })),
      ),
      getCompanyMetric,
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes,
      basis: "quarterly",
    });

    expect(getCompanyMetric).toHaveBeenCalledTimes(24);
    expect(result.workBudget).toMatchObject({
      comparisonPlanUnits: 24,
      comparisonExecutedUnits: 24,
      isolationRetryUnits: 0,
      comparisonUnitLimit: 24,
    });
    expect(result.coverage.failureIsolationComplete).toBe(false);
    expect(result.failures).toHaveLength(10);
    expect(result.failures).toEqual(
      expect.arrayContaining(
        companyCodes.slice(0, 10).map((companyCode) =>
          expect.objectContaining({
            companyCode,
            metricCode: "M0",
            attribution: "chunk",
          }),
        ),
      ),
    );
  });

  it("fails when every metric outcome is a semantic upstream failure", async () => {
    const getCompanyMetric = vi.fn().mockRejectedValue(
      new MopsfinError("UPSTREAM_BAD_RESPONSE", "fixture semantic failure", {
        reason: "COMPANY_SERIES_IDENTITY_AMBIGUOUS",
        retryable: false,
        action: "none",
      }),
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

    await expect(
      client.getCompanyMetricsBatch({
        companyCodes: ["1101", "2330"],
        metricCodes: ["ROE"],
        basis: "quarterly",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPANY_SERIES_IDENTITY_AMBIGUOUS",
    });
    expect(getCompanyMetric).toHaveBeenCalledTimes(3);
  });

  it("propagates a metric-stage ambient deadline without isolation retries", async () => {
    const getCompanyMetric = vi.fn().mockRejectedValue(
      new MopsfinError("UPSTREAM_TIMEOUT", "fixture deadline", {
        reason: "UPSTREAM_DEADLINE_EXCEEDED",
        retryable: true,
        action: "retry",
      }),
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

    await expect(
      client.getCompanyMetricsBatch({
        companyCodes: ["1101", "2330"],
        metricCodes: ["ROE"],
        basis: "quarterly",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_DEADLINE_EXCEEDED",
    });
    expect(getCompanyMetric).toHaveBeenCalledTimes(1);
  });

  it("serves a twenty-company page with a real client and resolves each identity only once", async () => {
    const companyCodes = Array.from({ length: 20 }, (_, index) =>
      String(1101 + index),
    );
    let activeSuggestions = 0;
    let peakSuggestions = 0;
    const fetchMock = vi.fn(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/") return response(catalogHtml);
        if (parsed.pathname === "/suggestCompany") {
          activeSuggestions += 1;
          peakSuggestions = Math.max(peakSuggestions, activeSuggestions);
          await new Promise((resolve) => setTimeout(resolve, 2));
          activeSuggestions -= 1;
          const code = parsed.searchParams.get("query") as string;
          return response(
            JSON.stringify({ suggestions: [`${code} C${code}`] }),
            "application/json",
          );
        }
        if (parsed.pathname === "/compare/data") {
          const body = init?.body as URLSearchParams;
          const companies = body.getAll("companyId");
          expect(companies.length).toBeLessThanOrEqual(10);
          return response(
            JSON.stringify({
              ylabel: "%",
              xaxisList: ["2025Q4", "2026Q1"],
              graphData: companies.map((company, index) => ({
                label: company,
                data: [
                  [0, 10 + index],
                  [1, 12 + index],
                ],
              })),
              showNameList: companies,
              checkedNameList: companies,
              displayCompanyId: companies,
            }),
            "application/json",
          );
        }
        throw new Error(`unexpected ${parsed.pathname}`);
      },
    );
    const mopsfin = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, {
        retryDelayMs: 0,
        maxAttempts: 1,
      }),
      () => new Date("2026-08-26T00:00:00.000Z"),
      { identityLookupConcurrency: 3, identityCacheTtlMs: 0 },
    );
    const client = new CompanyMetricsBatchClient(
      mopsfin,
      () => new Date("2026-08-26T00:00:00.000Z"),
    );

    const result = await client.getCompanyMetricsBatch({
      companyCodes,
      metricCodes: ["ROE", "GrossMargin"],
      basis: "quarterly",
    });

    const paths = fetchMock.mock.calls.map(([url]) =>
      new URL(String(url)).pathname,
    );
    expect(paths.filter((path) => path === "/suggestCompany")).toHaveLength(20);
    expect(paths.filter((path) => path === "/compare/data")).toHaveLength(4);
    expect(paths.filter((path) => path === "/")).toHaveLength(1);
    expect(peakSuggestions).toBeLessThanOrEqual(3);
    expect(result.companies.map((company) => company.companyCode)).toEqual(
      companyCodes,
    );
    expect(result.coverage.selectionComplete).toBe(true);
    expect(result.warnings.join(" ")).toContain("comparison work units=4/24");
    expect(result.warnings.join(" ")).toContain("identity logical lookup 上限=20");
  });

  it("single-flights identity lookups, bounds concurrency, expires TTL entries, and retries failures", async () => {
    let nowMs = Date.parse("2026-08-26T00:00:00.000Z");
    let activeSuggestions = 0;
    let peakSuggestions = 0;
    let failFirst9999 = true;
    const callsByCode = new Map<string, number>();
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/suggestCompany");
      const code = parsed.searchParams.get("query") as string;
      callsByCode.set(code, (callsByCode.get(code) ?? 0) + 1);
      activeSuggestions += 1;
      peakSuggestions = Math.max(peakSuggestions, activeSuggestions);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeSuggestions -= 1;
      if (code === "9999" && failFirst9999) {
        failFirst9999 = false;
        return response(JSON.stringify({ suggestions: [] }), "application/json");
      }
      return response(
        JSON.stringify({ suggestions: [`${code} C${code}`] }),
        "application/json",
      );
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, {
        retryDelayMs: 0,
        maxAttempts: 1,
      }),
      () => new Date(nowMs),
      {
        identityLookupConcurrency: 2,
        identityCacheTtlMs: 100,
        identityCacheMaximumEntries: 8,
      },
    );

    await Promise.all([
      client.resolveCompanies(["2330"]),
      client.resolveCompanies(["2330"]),
    ]);
    await client.resolveCompanies(["2330"]);
    expect(callsByCode.get("2330")).toBe(1);

    nowMs += 101;
    await client.resolveCompanies(["2330"]);
    expect(callsByCode.get("2330")).toBe(2);

    await client.resolveCompanies(["1101", "1102", "1103", "1104", "1105"]);
    expect(peakSuggestions).toBeLessThanOrEqual(2);

    await expect(client.resolveCompanies(["9999"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.resolveCompanies(["9999"])).resolves.toEqual([
      { code: "9999", name: "C9999", displayName: "9999 C9999" },
    ]);
    expect(callsByCode.get("9999")).toBe(2);
  });

  it("keeps in-flight deduplication but not completed identity cache entries when TTL is zero", async () => {
    let suggestionCalls = 0;
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/suggestCompany");
      suggestionCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      const code = parsed.searchParams.get("query") as string;
      return response(
        JSON.stringify({ suggestions: [`${code} C${code}`] }),
        "application/json",
      );
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, {
        retryDelayMs: 0,
        maxAttempts: 1,
      }),
      () => new Date("2026-08-26T00:00:00.000Z"),
      { identityCacheTtlMs: 0 },
    );

    const [first, concurrent] = await Promise.all([
      client.resolveCompanies(["2330", "2330"]),
      client.resolveCompanies(["2330"]),
    ]);
    expect(first).toEqual([
      { code: "2330", name: "C2330", displayName: "2330 C2330" },
      { code: "2330", name: "C2330", displayName: "2330 C2330" },
    ]);
    expect(concurrent).toEqual([first[0]]);
    expect(suggestionCalls).toBe(1);

    await client.resolveCompanies(["2330"]);
    expect(suggestionCalls).toBe(2);

    await expect(
      client.resolveCompanies(
        Array.from({ length: 11 }, (_, index) => String(1101 + index)),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(suggestionCalls).toBe(2);
  });

  it("bounds and deadline-cancels the identity lookup wait queue", async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      const code = parsed.searchParams.get("query") as string;
      if (code !== "1101") {
        return response(
          JSON.stringify({ suggestions: [`${code} C${code}`] }),
          "application/json",
        );
      }
      return new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const client = new MopsfinClient(
      new MopsfinHttpClient(fetchMock as typeof fetch, {
        retryDelayMs: 0,
        maxAttempts: 1,
      }),
      () => new Date("2026-08-26T00:00:00.000Z"),
      {
        identityLookupConcurrency: 1,
        identityLookupMaximumQueue: 1,
        identityCacheTtlMs: 0,
      },
    );

    const first = client.resolveCompanies(["1101"]);
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    const queued = runWithRequestDeadline(20, () =>
      client.resolveCompanies(["1102"]),
    );

    await expect(client.resolveCompanies(["1103"])).rejects.toMatchObject({
      code: "UPSTREAM_RATE_LIMITED",
      reason: "IDENTITY_LOOKUP_BACKPRESSURE",
      retryable: true,
      action: "retry",
    });
    await expect(queued).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      reason: "UPSTREAM_DEADLINE_EXCEEDED",
      retryable: true,
    });

    releaseFirst?.(
      response(
        JSON.stringify({ suggestions: ["1101 C1101"] }),
        "application/json",
      ),
    );
    await expect(first).resolves.toEqual([
      { code: "1101", name: "C1101", displayName: "1101 C1101" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an over-budget comparison plan before catalog or identity work", async () => {
    const mock = {
      getCatalog: vi.fn(),
      resolveCompanies: vi.fn(),
      getCompanyMetric: vi.fn(),
    } as unknown as MopsfinClient;
    const client = new CompanyMetricsBatchClient(mock);

    await expect(
      client.getCompanyMetricsBatch({
        companyCodes: Array.from({ length: 31 }, (_, index) =>
          String(1000 + index),
        ),
        metricCodes: Array.from({ length: 8 }, (_, index) => `M${index}`),
        basis: "quarterly",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "WORK_BUDGET_EXCEEDED",
      details: {
        workUnits: 32,
        comparisonWorkUnits: 32,
        identityLookupUpperBound: 31,
        maximum: 24,
      },
    });
    expect(mock.getCatalog).not.toHaveBeenCalled();
    expect(mock.resolveCompanies).not.toHaveBeenCalled();
    expect(mock.getCompanyMetric).not.toHaveBeenCalled();
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
