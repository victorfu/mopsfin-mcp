import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMarket,
  MasterCompany,
} from "@/lib/company-master/types";
import { MonthlyRevenueClient } from "@/lib/revenue/client";

const twseFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/revenue-twse.json", import.meta.url)),
    "utf8",
  ),
) as Array<Record<string, string>>;
const tpexFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/revenue-tpex.json", import.meta.url)),
    "utf8",
  ),
) as Array<Record<string, string>>;

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function company(
  code: string,
  name: string,
  market: CompanyMarket,
  industryCode: string,
): MasterCompany {
  return {
    code,
    name,
    shortName: name,
    market,
    exchange: market === "listed" ? "TWSE" : "TPEx",
    industryCode,
    listingDate: "2000-01-01",
    incorporationDate: null,
    paidInCapitalTwd: null,
    issuedCommonShares: null,
    parValueText: null,
    financialReportTypeCode: null,
    profileValueStatus: {
      incorporationDate: "missing",
      paidInCapitalTwd: "missing",
      issuedCommonShares: "missing",
      parValueText: "missing",
      financialReportTypeCode: "missing",
    },
    domicileCode: "TW",
    isKy: false,
    isFinancial: false,
  };
}

function master(companies: MasterCompany[]) {
  return {
    listCompanies: vi.fn(async (): Promise<CompanyMasterResult> => ({
      query: { market: "all", includeFinancial: true, includeKy: true },
      generatedAt: "2026-08-26T00:00:00.000Z",
      snapshotId: "fixture",
      coverageVerification: {
        status: "heuristic",
        method: "required_sources_schema_single_report_date_minimum_count",
        officialDeclaredRowCountAvailable: false,
      },
      coverageComplete: true,
      sources: [],
      counts: {
        raw: companies.length,
        excludedTdr: 0,
        eligible: companies.length,
        excludedFinancial: 0,
        excludedKy: 0,
        listed: companies.filter((value) => value.market === "listed").length,
        otc: companies.filter((value) => value.market === "otc").length,
        returned: companies.length,
      },
      profileCoverage: {
        incorporationDate: { reported: 0, missing: companies.length, invalid: 0 },
        paidInCapitalTwd: { reported: 0, missing: companies.length, invalid: 0 },
        issuedCommonShares: { reported: 0, missing: companies.length, invalid: 0 },
        parValueText: { reported: 0, missing: companies.length, invalid: 0 },
        financialReportTypeCode: {
          reported: 0,
          missing: companies.length,
          invalid: 0,
        },
      },
      companies,
      warnings: [],
    })),
  };
}

function fixtureFetch(
  twse: unknown = twseFixture,
  tpex: unknown = tpexFixture,
) {
  return vi.fn(async (input: URL | RequestInfo) =>
    response(String(input).includes("openapi.twse.com.tw") ? twse : tpex),
  );
}

const now = () => new Date("2026-08-26T00:00:00.000Z");
const completeMaster = [
  company("1101", "台泥", "listed", "01"),
  company("2330", "台積電", "listed", "24"),
  company("3105", "穩懋", "otc", "24"),
  company("6488", "環球晶", "otc", "24"),
];

describe("MonthlyRevenueClient", () => {
  it("normalizes ROC dates, thousand-TWD amounts, statuses, and partial filing coverage", async () => {
    const companies = [
      ...completeMaster,
      company("9998", "尚未申報", "listed", "20"),
    ];
    const client = new MonthlyRevenueClient(
      fixtureFetch() as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    );

    const result = await client.getMonthlyRevenue({
      market: "all",
      dataMonth: "latest",
      universePolicy: "strict_current_master",
    });

    expect(result.dataMonth).toBe("2026-07");
    expect(result.coverageComplete).toBe(true);
    expect(result.counts).toEqual({ listed: 2, otc: 2, returned: 4 });
    expect(result.filingCoverage).toEqual({
      expectedCompanyCount: 5,
      reportedCompanyCount: 4,
      missingCompanyCodes: ["9998"],
      coverageRatio: 0.8,
      complete: false,
      status: "partial",
    });
    expect(result.rows.find((row) => row.code === "2330")).toMatchObject({
      industryCode: "24",
      sourceReportDate: "2026-08-17",
      currentMonthRevenueTwd: 3_000_000_000,
      previousMonthRevenueTwd: 0,
      momPercent: null,
      yoyPercent: 20,
      valueStatus: {
        previousMonthRevenueTwd: "reported",
        momPercent: "missing",
        yoyPercent: "reported",
      },
    });
    expect(result.rows.find((row) => row.code === "1101")).toMatchObject({
      currentMonthRevenueTwd: 13_744_103_000,
      yoyPercent: null,
      note: null,
      valueStatus: { yoyPercent: "invalid_upstream" },
    });
    expect(result.sources[0]).toMatchObject({
      sourceReportDate: "2026-08-17",
      dataMonth: "2026-07",
      sourceAmountUnit: "thousand_TWD",
      outputAmountUnit: "TWD",
      amountMultiplier: 1000,
    });
    expect(result.warnings.some((warning) => warning.includes("OpenAPI fallback"))).toBe(
      true,
    );
  });

  it("treats incomplete filings as normal and reports missing requested companies", async () => {
    const companies = [
      ...completeMaster.filter((value) => value.market === "listed"),
      company("9998", "尚未申報", "listed", "20"),
    ];
    const client = new MonthlyRevenueClient(
      fixtureFetch() as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    );

    const result = await client.getMonthlyRevenue({
      market: "listed",
      dataMonth: "latest",
      companyCodes: ["2330", "9998"],
      universePolicy: "strict_current_master",
    });
    expect(result.selectionComplete).toBe(false);
    expect(result.missingCompanyCodes).toEqual(["9998"]);
    expect(result.rows.map((row) => row.code)).toEqual(["2330"]);
    expect(result.filingCoverage.complete).toBe(false);

    await expect(
      client.getMonthlyRevenue({
        market: "listed",
        dataMonth: "latest",
        companyCodes: ["9998"],
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("keeps a compatible fallback with null industry but excludes it in strict mode", async () => {
    const fallback = {
      ...twseFixture[0],
      公司代號: "9999",
      公司名稱: "新申報公司",
    };
    const source = [...twseFixture, fallback];
    const companies = completeMaster.filter((value) => value.market === "listed");

    const strict = await new MonthlyRevenueClient(
      fixtureFetch(source) as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    ).getMonthlyRevenue({
      market: "listed",
      dataMonth: "latest",
      universePolicy: "strict_current_master",
    });
    expect(strict.rows.map((row) => row.code)).toEqual(["1101", "2330"]);
    expect(strict.reconciliation[0].marketOnlyCodes).toEqual(["9999"]);

    const compatible = await new MonthlyRevenueClient(
      fixtureFetch(source) as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    ).getMonthlyRevenue({
      market: "listed",
      dataMonth: "latest",
      universePolicy: "compatible",
    });
    expect(compatible.rows.find((row) => row.code === "9999")).toMatchObject({
      industryCode: null,
      currentMonthRevenueTwd: 13_744_103_000,
    });
  });

  it("rejects different latest data months across markets", async () => {
    const staleTpex = tpexFixture.map((row) => ({ ...row, 資料年月: "11506" }));
    const client = new MonthlyRevenueClient(
      fixtureFetch(twseFixture, staleTpex) as typeof fetch,
      now,
      master(completeMaster),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getMonthlyRevenue({
        market: "all",
        dataMonth: "latest",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("rejects duplicate requested company codes before fetching", async () => {
    const fetchMock = fixtureFetch();
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getMonthlyRevenue({
        market: "listed",
        dataMonth: "latest",
        companyCodes: ["2330", "2330"],
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries an HTTP 200 response whose body is temporarily not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("<html>temporary gateway page</html>"))
      .mockResolvedValueOnce(response(twseFixture));
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster.filter((value) => value.market === "listed")),
      { retryDelayMs: 0 },
    );

    const result = await client.getMonthlyRevenue({
      market: "listed",
      dataMonth: "latest",
      universePolicy: "strict_current_master",
    });

    expect(result.rows).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("openapi.twse.com.tw"),
    )).toHaveLength(2);
  });

  it("aborts and drains the other market after an archive source fails", async () => {
    const siblingSignals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        if (String(input).includes("/sii/")) {
          return new Response("bad request", { status: 400 });
        }
        const signal = init?.signal as AbortSignal;
        siblingSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    );
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster),
      { maxAttempts: 1, cacheTtlMs: 0 },
    );

    await expect(
      client.getMonthlyRevenue({
        market: "all",
        dataMonth: "2026-07",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
    expect(siblingSignals).toHaveLength(1);
    expect(siblingSignals[0].aborted).toBe(true);
  });
});
