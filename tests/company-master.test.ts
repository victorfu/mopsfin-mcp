import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CompanyMasterClient } from "@/lib/company-master/client";

const twseFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/twse-companies.json", import.meta.url)),
  "utf8",
);
const tpexFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/tpex-companies.json", import.meta.url)),
  "utf8",
);

function jsonResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixtureFetch() {
  return vi.fn(async (url: URL | RequestInfo) => {
    const value = String(url);
    if (value.includes("openapi.twse.com.tw")) return jsonResponse(twseFixture);
    if (value.includes("www.tpex.org.tw")) return jsonResponse(tpexFixture);
    throw new Error(`unexpected ${value}`);
  });
}

const testOptions = {
  retryDelayMs: 0,
  minimumCompanyCounts: { listed: 1, otc: 1 },
};

describe("CompanyMasterClient", () => {
  it.each([
    ["listed", 4, 4, 0, ["1101", "2330", "2881", "6415"]],
    ["otc", 4, 0, 4, ["1591", "3105", "5864", "6488"]],
    [
      "all",
      8,
      4,
      4,
      ["1101", "1591", "2330", "2881", "3105", "5864", "6415", "6488"],
    ],
  ] as const)(
    "returns the complete %s company universe",
    async (market, returned, listed, otc, codes) => {
      const fetchMock = fixtureFetch();
      const client = new CompanyMasterClient(
        fetchMock as typeof fetch,
        () => new Date("2026-08-25T00:00:00.000Z"),
        testOptions,
      );

      const result = await client.listCompanies({
        market,
        includeFinancial: true,
        includeKy: true,
      });

      expect(result.coverageComplete).toBe(true);
      expect(result.snapshotId).toContain("2026-08-24");
      expect(result.counts).toMatchObject({ returned, listed, otc });
      expect(result.companies.map((company) => company.code)).toEqual(codes);
      expect(result.sources).toHaveLength(market === "all" ? 2 : 1);
      expect(result.profileCoverage.incorporationDate.reported).toBeGreaterThanOrEqual(0);
      expect(fetchMock).toHaveBeenCalledTimes(market === "all" ? 2 : 1);
    },
  );

  it("excludes both four- and six-digit TDR rows without dropping ordinary stocks", async () => {
    const client = new CompanyMasterClient(
      fixtureFetch() as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    const result = await client.listCompanies({
      market: "listed",
      includeFinancial: true,
      includeKy: true,
    });

    expect(result.counts).toMatchObject({ raw: 6, excludedTdr: 2, eligible: 4 });
    expect(result.companies.every((company) => /^\d{4}$/.test(company.code))).toBe(
      true,
    );
    expect(result.companies.map((company) => company.code)).not.toContain("9103");
  });

  it("applies financial and KY filters after building the complete market snapshot", async () => {
    const client = new CompanyMasterClient(
      fixtureFetch() as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    const result = await client.listCompanies({
      market: "all",
      includeFinancial: false,
      includeKy: false,
    });

    expect(result.counts).toMatchObject({
      eligible: 8,
      excludedFinancial: 2,
      excludedKy: 2,
      listed: 2,
      otc: 2,
      returned: 4,
    });
    expect(result.companies.map((company) => company.code)).toEqual([
      "1101",
      "2330",
      "3105",
      "6488",
    ]);
  });

  it("normalizes current-snapshot profile fields without deriving par value or market cap", async () => {
    const client = new CompanyMasterClient(
      fixtureFetch() as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    const result = await client.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    const twse = result.companies.find((company) => company.code === "2330");
    const tpex = result.companies.find((company) => company.code === "3105");

    expect(twse).toMatchObject({
      incorporationDate: "1987-02-21",
      paidInCapitalTwd: 280_000_000_000,
      issuedCommonShares: 25_930_380_458,
      parValueText: "新台幣 10.0000元",
      financialReportTypeCode: "1",
    });
    expect(tpex).toMatchObject({
      incorporationDate: "1994-07-05",
      paidInCapitalTwd: 10_000_000_000,
      issuedCommonShares: 1_000_000_000,
    });
    expect(result.profileCoverage.issuedCommonShares.reported).toBe(2);
  });

  it("keeps optional profile parse failures as null with invalid_upstream status", async () => {
    const rows = JSON.parse(twseFixture) as Array<Record<string, string>>;
    rows[1]["成立日期"] = "20260230";
    rows[1]["實收資本額"] = "999999999999999999999";
    const client = new CompanyMasterClient(
      vi.fn().mockResolvedValue(jsonResponse(JSON.stringify(rows))) as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    const result = await client.listCompanies({
      market: "listed",
      includeFinancial: true,
      includeKy: true,
    });
    const company = result.companies.find((item) => item.code === "2330");
    expect(company?.incorporationDate).toBeNull();
    expect(company?.paidInCapitalTwd).toBeNull();
    expect(company?.profileValueStatus).toMatchObject({
      incorporationDate: "invalid_upstream",
      paidInCapitalTwd: "invalid_upstream",
    });
    expect(result.profileCoverage.incorporationDate.invalid).toBe(1);
  });

  it("caches each official market snapshot independently", async () => {
    const fetchMock = fixtureFetch();
    const client = new CompanyMasterClient(
      fetchMock as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    await client.listCompanies({
      market: "listed",
      includeFinancial: true,
      includeKy: true,
    });
    await client.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails the all-market request instead of publishing a partial universe", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).includes("openapi.twse.com.tw")) {
        return jsonResponse(twseFixture);
      }
      return jsonResponse("unavailable", 503);
    });
    const client = new CompanyMasterClient(
      fetchMock as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    await expect(
      client.listCompanies({
        market: "all",
        includeFinancial: true,
        includeKy: true,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE", status: 503 });
  });

  it("rejects a suspiciously truncated source before setting coverageComplete", async () => {
    const client = new CompanyMasterClient(
      fixtureFetch() as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      {
        retryDelayMs: 0,
        minimumCompanyCounts: { listed: 5, otc: 1 },
      },
    );

    await expect(
      client.listCompanies({
        market: "listed",
        includeFinancial: true,
        includeKy: true,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      details: { companyCount: 4, minimum: 5 },
    });
  });

  it("rejects mixed source dates instead of claiming a single complete snapshot", async () => {
    const rows = JSON.parse(twseFixture) as Array<Record<string, string>>;
    rows[1]["出表日期"] = "1150823";
    const client = new CompanyMasterClient(
      vi.fn().mockResolvedValue(jsonResponse(JSON.stringify(rows))) as typeof fetch,
      () => new Date("2026-08-25T00:00:00.000Z"),
      testOptions,
    );

    await expect(
      client.listCompanies({
        market: "listed",
        includeFinancial: true,
        includeKy: true,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });
});
