import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMarket,
  MasterCompany,
} from "@/lib/company-master/types";
import { dailyMarketValuationOutputSchema } from "@/lib/mcp/schemas";
import { ValuationClient } from "@/lib/valuation/client";

const twseFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/valuation-twse.json", import.meta.url)),
    "utf8",
  ),
) as Array<Record<string, string>>;
const tpexFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/valuation-tpex.json", import.meta.url)),
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
  industryCode = "24",
): MasterCompany {
  return {
    code,
    name,
    shortName: name,
    market,
    exchange: market === "listed" ? "TWSE" : "TPEx",
    industryCode,
    listingDate: "2000-01-01",
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

describe("ValuationClient", () => {
  it("normalizes both official markets and preserves missing versus invalid values", async () => {
    const client = new ValuationClient(
      fixtureFetch() as typeof fetch,
      now,
      master(completeMaster),
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "all",
      date: "latest",
      universePolicy: "strict_current_master",
    });

    expect(result.dataDate).toBe("2026-08-25");
    expect(result.coverageComplete).toBe(true);
    expect(result.universeCoverageVerified).toBe(true);
    expect(result.classificationPolicy).toBe("current_master_strict");
    expect(result.counts).toEqual({
      raw: 4,
      returned: 4,
      withPe: 2,
      withPb: 3,
      withDividendYield: 4,
    });
    expect(result.rows.find((row) => row.code === "1101")).toMatchObject({
      peRatio: null,
      priceToBookRatio: null,
      dividendYieldPercent: 3.25,
      valueStatus: {
        peRatio: "missing_or_not_meaningful",
        priceToBookRatio: "invalid_upstream",
        dividendYieldPercent: "reported",
      },
    });
    expect(result.rows.find((row) => row.code === "3105")).toMatchObject({
      peRatio: null,
      dividendYieldPercent: 0,
      valueStatus: {
        peRatio: "missing_or_not_meaningful",
        dividendYieldPercent: "reported",
      },
    });
    expect(result.sources).toEqual([
      expect.objectContaining({
        market: "listed",
        dataDate: "2026-08-25",
        rawCount: 2,
        eligibleRowCount: 2,
      }),
      expect.objectContaining({
        market: "otc",
        dataDate: "2026-08-25",
        rawCount: 2,
        eligibleRowCount: 2,
      }),
    ]);
    expect(() => dailyMarketValuationOutputSchema.parse(result)).not.toThrow();
  });

  it("reports a partial requested selection and rejects an entirely missing one", async () => {
    const client = new ValuationClient(
      fixtureFetch() as typeof fetch,
      now,
      master(completeMaster.filter((value) => value.market === "listed")),
      { retryDelayMs: 0 },
    );

    const partial = await client.getDailyMarketValuation({
      market: "listed",
      date: "latest",
      companyCodes: ["2330", "9999"],
      universePolicy: "strict_current_master",
    });
    expect(partial.selectionComplete).toBe(false);
    expect(partial.missingCompanyCodes).toEqual(["9999"]);
    expect(partial.rows.map((row) => row.code)).toEqual(["2330"]);

    await expect(
      client.getDailyMarketValuation({
        market: "listed",
        date: "latest",
        companyCodes: ["9999"],
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("fails strict reconciliation but exposes fallback rows in compatible mode", async () => {
    const source = [
      ...twseFixture,
      {
        Date: "1150825",
        Code: "9999",
        Name: "新公司",
        PEratio: "12.00",
        DividendYield: "1.00",
        PBratio: "1.50",
      },
    ];
    const companies = completeMaster.filter((value) => value.market === "listed");

    await expect(
      new ValuationClient(
        fixtureFetch(source) as typeof fetch,
        now,
        master(companies),
        { retryDelayMs: 0 },
      ).getDailyMarketValuation({
        market: "listed",
        date: "latest",
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({
      code: "INCOMPLETE_COVERAGE",
      details: {
        reconciliation: [expect.objectContaining({ marketOnlyCodes: ["9999"] })],
      },
    });

    const compatible = await new ValuationClient(
      fixtureFetch(source) as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    ).getDailyMarketValuation({
      market: "listed",
      date: "latest",
      universePolicy: "compatible",
    });
    expect(compatible.rows.map((row) => row.code)).toEqual(["1101", "2330", "9999"]);
    expect(compatible.universeCoverageVerified).toBe(false);
    expect(compatible.coverageComplete).toBe(true);
    expect(compatible.classificationPolicy).toBe("current_master_with_code_fallback");
  });

  it("rejects a severely truncated compatible valuation universe", async () => {
    const listedMaster = completeMaster.filter(
      (value) => value.market === "listed",
    );
    const client = new ValuationClient(
      fixtureFetch(twseFixture.slice(0, 1)) as typeof fetch,
      now,
      master(listedMaster),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market: "listed",
        date: "latest",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({
      code: "INCOMPLETE_COVERAGE",
      details: {
        universePolicy: "compatible",
        reconciliation: [expect.objectContaining({ matchRatio: 0.5 })],
      },
    });
  });

  it("rejects mixed all-market data dates", async () => {
    const staleTpex = tpexFixture.map((row) => ({ ...row, Date: "1150824" }));
    const client = new ValuationClient(
      fixtureFetch(twseFixture, staleTpex) as typeof fetch,
      now,
      master(completeMaster),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market: "all",
        date: "latest",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
  });

  it("retries one transient response and caches the accepted official snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("temporarily unavailable", 503))
      .mockResolvedValueOnce(response(twseFixture));
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster.filter((value) => value.market === "listed")),
      { retryDelayMs: 0 },
    );
    const query = {
      market: "listed" as const,
      date: "latest" as const,
      universePolicy: "strict_current_master" as const,
    };

    await client.getDailyMarketValuation(query);
    await client.getDailyMarketValuation(query);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      redirect: "error",
    });
  });

  it("retries an HTTP 200 response whose body is temporarily not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("<html>temporary gateway page</html>"))
      .mockResolvedValueOnce(response(twseFixture));
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster.filter((value) => value.market === "listed")),
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "listed",
      date: "latest",
      universePolicy: "compatible",
    });

    expect(result.rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
