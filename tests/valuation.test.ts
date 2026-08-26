import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMarket,
  MasterCompany,
} from "@/lib/company-master/types";
import { ValuationClient } from "@/lib/valuation/client";

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
}

const twseFixture = fixture<Array<Record<string, unknown>>>(
  "valuation-twse.json",
);
const tpexFixture = fixture<Array<Record<string, unknown>>>(
  "valuation-tpex.json",
);
const twseDailyModern = fixture<Record<string, unknown>>(
  "valuation-twse-daily-modern.json",
);
const tpexDailyModern = fixture<Record<string, unknown>>(
  "valuation-tpex-daily-modern.json",
);
const twseDailyLegacy = fixture<Record<string, unknown>>(
  "valuation-twse-daily-legacy.json",
);
const tpexDailyLegacy = fixture<Record<string, unknown>>(
  "valuation-tpex-daily-legacy.json",
);

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
    listCompanies: vi.fn(
      async (
        query: CompanyMasterResult["query"],
      ): Promise<CompanyMasterResult> => ({
        query,
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
          incorporationDate: {
            reported: 0,
            missing: companies.length,
            invalid: 0,
          },
          paidInCapitalTwd: {
            reported: 0,
            missing: companies.length,
            invalid: 0,
          },
          issuedCommonShares: {
            reported: 0,
            missing: companies.length,
            invalid: 0,
          },
          parValueText: {
            reported: 0,
            missing: companies.length,
            invalid: 0,
          },
          financialReportTypeCode: {
            reported: 0,
            missing: companies.length,
            invalid: 0,
          },
        },
        companies,
        warnings: [],
      }),
    ),
  };
}

interface FixtureSources {
  twseLatest: unknown;
  tpexLatest: unknown;
  twseDaily: unknown;
  tpexDaily: unknown;
}

function fixtureFetch(overrides: Partial<FixtureSources> = {}) {
  const sources: FixtureSources = {
    twseLatest: twseFixture,
    tpexLatest: tpexFixture,
    twseDaily: twseDailyModern,
    tpexDaily: tpexDailyModern,
    ...overrides,
  };
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("BWIBBU_d")) return response(sources.twseDaily);
    if (url.includes("peQryDate")) return response(sources.tpexDaily);
    if (url.includes("openapi.twse.com.tw")) {
      return response(sources.twseLatest);
    }
    return response(sources.tpexLatest);
  });
}

const now = () => new Date("2026-08-26T00:00:00.000Z");
const completeMaster = [
  company("1101", "台泥", "listed", "01"),
  company("2330", "台積電", "listed", "24"),
  company("3105", "穩懋", "otc", "24"),
  company("6488", "環球晶", "otc", "24"),
];

function withoutField(
  rows: Array<Record<string, unknown>>,
  field: string,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const copy = { ...row };
    Reflect.deleteProperty(copy, field);
    return copy;
  });
}

describe("ValuationClient", () => {
  it("resolves latest dates through OpenAPI and enriches both markets from exact-day endpoints", async () => {
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
      withClosePrice: 2,
      withDividendPerShare: 2,
      withDividendFiscalYear: 4,
      withReferenceFiscalPeriod: 4,
    });
    expect(result.rows.find((row) => row.code === "1101")).toMatchObject({
      peRatio: null,
      priceToBookRatio: null,
      dividendYieldPercent: 3.25,
      closePriceTwd: 31.6,
      dividendPerShareTwd: null,
      dividendFiscalYear: 2025,
      referenceFiscalPeriod: "2026Q2",
      valueStatus: {
        peRatio: "missing_or_not_meaningful",
        priceToBookRatio: "invalid_upstream",
        dividendYieldPercent: "reported",
        closePriceTwd: "reported",
        dividendPerShareTwd: "not_provided_by_source",
        dividendFiscalYear: "reported",
        referenceFiscalPeriod: "reported",
      },
      rawValue: {
        peRatio: "",
        priceToBookRatio: "not-a-number",
        dividendYieldPercent: "3.25",
        closePriceTwd: "31.60",
        dividendPerShareTwd: null,
        dividendFiscalYear: "114",
        referenceFiscalPeriod: "115/2",
      },
    });
    expect(result.rows.find((row) => row.code === "3105")).toMatchObject({
      peRatio: null,
      dividendYieldPercent: 0,
      closePriceTwd: null,
      dividendPerShareTwd: 0,
      valueStatus: {
        peRatio: "missing_or_not_meaningful",
        dividendYieldPercent: "reported",
        closePriceTwd: "not_provided_by_source",
        dividendPerShareTwd: "reported",
      },
    });
    expect(result.sources).toEqual([
      expect.objectContaining({
        market: "listed",
        dataDate: "2026-08-25",
        rawCount: 2,
        eligibleRowCount: 2,
        sourceUrl: expect.stringContaining("openapi.twse.com.tw"),
      }),
      expect.objectContaining({
        market: "listed",
        dataDate: "2026-08-25",
        rawCount: 2,
        eligibleRowCount: 2,
        sourceUrl: expect.stringContaining("BWIBBU_d"),
      }),
      expect.objectContaining({
        market: "otc",
        dataDate: "2026-08-25",
        rawCount: 2,
        eligibleRowCount: 2,
        sourceUrl: expect.stringContaining("openapi/v1"),
      }),
      expect.objectContaining({
        market: "otc",
        dataDate: "2026-08-25",
        rawCount: 2,
        eligibleRowCount: 2,
        sourceUrl: expect.stringContaining("peQryDate"),
      }),
    ]);
    expect(
      new Set(
        result.sources.map(
          (source) => `${source.market}:${source.dataDate}:${source.sourceUrl}`,
        ),
      ).size,
    ).toBe(result.sources.length);
  });

  it.each([
    { market: "listed" as const, field: "PEratio", rows: twseFixture },
    { market: "listed" as const, field: "PBratio", rows: twseFixture },
    { market: "listed" as const, field: "DividendYield", rows: twseFixture },
    { market: "otc" as const, field: "PriceEarningRatio", rows: tpexFixture },
    { market: "otc" as const, field: "PriceBookRatio", rows: tpexFixture },
    { market: "otc" as const, field: "YieldRatio", rows: tpexFixture },
  ])(
    "rejects latest $market rows when core field $field disappears",
    async ({ market, field, rows }) => {
      const sourceOverride =
        market === "listed"
          ? { twseLatest: withoutField(rows, field) }
          : { tpexLatest: withoutField(rows, field) };
      const client = new ValuationClient(
        fixtureFetch(sourceOverride) as typeof fetch,
        now,
        master(completeMaster.filter((company) => company.market === market)),
        { retryDelayMs: 0 },
      );

      await expect(
        client.getDailyMarketValuation({
          market,
          date: "latest",
          universePolicy: "compatible",
        }),
      ).rejects.toMatchObject({
        code: "UPSTREAM_BAD_RESPONSE",
        details: {
          market,
          companyCode: expect.any(String),
          missingFields: [field],
        },
      });
    },
  );

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
    const daily = {
      ...twseDailyModern,
      total: 3,
      data: [
        ...(twseDailyModern.data as unknown[]),
        ["9999", "新公司", "18.00", "1.00", 114, "12.00", "1.50", "115/2"],
      ],
    };
    const companies = completeMaster.filter((value) => value.market === "listed");

    await expect(
      new ValuationClient(
        fixtureFetch({ twseLatest: source, twseDaily: daily }) as typeof fetch,
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
      fixtureFetch({ twseLatest: source, twseDaily: daily }) as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    ).getDailyMarketValuation({
      market: "listed",
      date: "latest",
      universePolicy: "compatible",
    });
    expect(compatible.rows.map((row) => row.code)).toEqual([
      "1101",
      "2330",
      "9999",
    ]);
    expect(compatible.universeCoverageVerified).toBe(false);
    expect(compatible.coverageComplete).toBe(true);
    expect(compatible.classificationPolicy).toBe(
      "current_master_with_code_fallback",
    );
  });

  it("rejects a severely truncated compatible valuation universe", async () => {
    const listedMaster = completeMaster.filter(
      (value) => value.market === "listed",
    );
    const truncatedDaily = {
      ...twseDailyModern,
      data: (twseDailyModern.data as unknown[]).slice(0, 1),
    };
    const client = new ValuationClient(
      fixtureFetch({
        twseLatest: twseFixture.slice(0, 1),
        twseDaily: truncatedDaily,
      }) as typeof fetch,
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

  it("rejects mixed all-market latest dates before requesting day enrichment", async () => {
    const staleTpex = tpexFixture.map((row) => ({ ...row, Date: "1150824" }));
    const fetchMock = fixtureFetch({ tpexLatest: staleTpex });
    const client = new ValuationClient(
      fetchMock as typeof fetch,
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
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("afterTrading")),
    ).toBe(false);
  });

  it("falls back to latest OpenAPI fields when the same-day enrichment fails", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      return url.includes("BWIBBU_d")
        ? response("temporary failure", 503)
        : response(twseFixture);
    });
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster.filter((value) => value.market === "listed")),
      { maxAttempts: 1, retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "listed",
      date: "latest",
      universePolicy: "compatible",
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].sourceUrl).toContain("openapi.twse.com.tw");
    expect(result.rows[0]).toMatchObject({
      closePriceTwd: null,
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: null,
      valueStatus: {
        closePriceTwd: "not_provided_by_source",
        dividendPerShareTwd: "not_provided_by_source",
        dividendFiscalYear: "not_provided_by_source",
        referenceFiscalPeriod: "not_provided_by_source",
      },
    });
    expect(result.warnings.join(" ")).toContain("補強失敗");
  });

  it("preserves TPEx OpenAPI dividend-per-share data during latest fallback", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      return url.includes("peQryDate")
        ? response("temporary failure", 503)
        : response(tpexFixture);
    });
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      master(completeMaster.filter((value) => value.market === "otc")),
      { maxAttempts: 1, retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "otc",
      date: "latest",
      universePolicy: "compatible",
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].sourceUrl).toContain(
      "openapi/v1/tpex_mainboard_peratio_analysis",
    );
    expect(result.rows.find((row) => row.code === "3105")).toMatchObject({
      dividendPerShareTwd: 0,
      valueStatus: {
        closePriceTwd: "not_provided_by_source",
        dividendPerShareTwd: "reported",
        dividendFiscalYear: "not_provided_by_source",
        referenceFiscalPeriod: "not_provided_by_source",
      },
      rawValue: { dividendPerShareTwd: "0" },
    });
  });

  it("reads the earliest supported TWSE layout without consulting current master", async () => {
    const fetchMock = fixtureFetch({ twseDaily: twseDailyLegacy });
    const masterMock = master([]);
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      masterMock,
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "listed",
      date: "2005-09-02",
      universePolicy: "compatible",
    });

    expect(masterMock.listCompanies).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "BWIBBU_d?date=20050902&selectType=ALL&response=json",
    );
    expect(result).toMatchObject({
      dataDate: "2005-09-02",
      classificationPolicy: "historical_code_rule",
      coverageComplete: true,
      universeCoverageVerified: false,
      reconciliation: [],
      counts: {
        raw: 1,
        returned: 1,
        withPe: 1,
        withPb: 1,
        withDividendYield: 1,
        withClosePrice: 0,
        withDividendPerShare: 0,
        withDividendFiscalYear: 0,
        withReferenceFiscalPeriod: 0,
      },
    });
    expect(result.rows[0]).toMatchObject({
      code: "1101",
      peRatio: 16.92,
      dividendYieldPercent: 5.91,
      priceToBookRatio: 1.07,
      closePriceTwd: null,
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: null,
      valueStatus: {
        peRatio: "reported",
        priceToBookRatio: "reported",
        dividendYieldPercent: "reported",
        closePriceTwd: "not_provided_by_source",
        dividendPerShareTwd: "not_provided_by_source",
        dividendFiscalYear: "not_provided_by_source",
        referenceFiscalPeriod: "not_provided_by_source",
      },
      rawValue: {
        peRatio: "16.92",
        closePriceTwd: null,
        dividendPerShareTwd: null,
      },
    });
  });

  it("uses a slash-encoded TPEx date and normalizes ROC dividend years", async () => {
    const fetchMock = fixtureFetch({ tpexDaily: tpexDailyLegacy });
    const masterMock = master([]);
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      masterMock,
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "otc",
      date: "2007-01-02",
      universePolicy: "compatible",
    });

    expect(masterMock.listCompanies).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "peQryDate?date=2007%2F01%2F02&response=json",
    );
    expect(result.rows[0]).toMatchObject({
      code: "1333",
      dividendPerShareTwd: 0.43,
      dividendFiscalYear: 2006,
      referenceFiscalPeriod: null,
      valueStatus: {
        dividendPerShareTwd: "reported",
        dividendFiscalYear: "reported",
        referenceFiscalPeriod: "not_provided_by_source",
      },
      rawValue: {
        dividendPerShareTwd: "0.43",
        dividendFiscalYear: "95",
        referenceFiscalPeriod: null,
      },
    });
  });

  it("maps historical fields by normalized header name instead of column position", async () => {
    const reordered = {
      stat: "OK",
      date: "20260825",
      total: 1,
      fields: [
        " 證券名稱 ",
        "證券代號",
        "股價淨值比",
        "本益比",
        "殖利率（％）",
        "財報年/季",
        "股利年度",
        "收盤價",
      ],
      data: [[
        "台積電",
        "2330",
        "8.91",
        "29.75",
        "1.42",
        "115/2",
        114,
        "1,180",
      ]],
    };
    const client = new ValuationClient(
      fixtureFetch({ twseDaily: reordered }) as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "listed",
      date: "2026-08-25",
      universePolicy: "compatible",
    });

    expect(result.rows[0]).toMatchObject({
      code: "2330",
      name: "台積電",
      peRatio: 29.75,
      priceToBookRatio: 8.91,
      dividendYieldPercent: 1.42,
      closePriceTwd: 1180,
      dividendFiscalYear: 2025,
      referenceFiscalPeriod: "2026Q2",
    });
  });

  it("distinguishes new-field markers, malformed values, and source-absent fields", async () => {
    const markers = {
      stat: "OK",
      date: "20260825",
      total: 2,
      fields: [
        "證券代號",
        "證券名稱",
        "收盤價",
        "殖利率(%)",
        "股利年度",
        "本益比",
        "股價淨值比",
        "財報年/季",
      ],
      data: [
        ["1101", "台泥", "-", "3.25", "bad-year", "12", "1.1", "N/A"],
        ["2330", "台積電", "0", "1.42", "-", "29", "8.9", "bad-period"],
      ],
    };
    const client = new ValuationClient(
      fixtureFetch({ twseDaily: markers }) as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );

    const result = await client.getDailyMarketValuation({
      market: "listed",
      date: "2026-08-25",
      universePolicy: "compatible",
    });

    expect(result.rows[0]).toMatchObject({
      closePriceTwd: null,
      dividendPerShareTwd: null,
      dividendFiscalYear: null,
      referenceFiscalPeriod: null,
      valueStatus: {
        closePriceTwd: "missing_or_not_meaningful",
        dividendPerShareTwd: "not_provided_by_source",
        dividendFiscalYear: "invalid_upstream",
        referenceFiscalPeriod: "missing_or_not_meaningful",
      },
      rawValue: {
        closePriceTwd: "-",
        dividendPerShareTwd: null,
        dividendFiscalYear: "bad-year",
        referenceFiscalPeriod: "N/A",
      },
    });
    expect(result.rows[1].valueStatus).toMatchObject({
      closePriceTwd: "invalid_upstream",
      dividendFiscalYear: "missing_or_not_meaningful",
      referenceFiscalPeriod: "invalid_upstream",
    });
  });

  it("rejects TPEx responses whose response date differs from the requested date", async () => {
    const mismatched = { ...tpexDailyLegacy, date: "20070103" };
    const client = new ValuationClient(
      fixtureFetch({ tpexDaily: mismatched }) as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market: "otc",
        date: "2007-01-02",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      details: {
        requestedDate: "2007-01-02",
        responseDate: "2007-01-03",
      },
    });
  });

  it.each([
    {
      label: "TWSE missing total",
      market: "listed" as const,
      daily: { ...twseDailyModern, total: undefined },
    },
    {
      label: "TWSE malformed total",
      market: "listed" as const,
      daily: { ...twseDailyModern, total: "2.0" },
    },
    {
      label: "TWSE mismatched total",
      market: "listed" as const,
      daily: { ...twseDailyModern, total: 3 },
    },
    {
      label: "TPEx missing totalCount",
      market: "otc" as const,
      daily: {
        ...tpexDailyModern,
        tables: [
          {
            ...((tpexDailyModern.tables as Array<Record<string, unknown>>)[0]),
            totalCount: undefined,
          },
        ],
      },
    },
    {
      label: "TPEx malformed totalCount",
      market: "otc" as const,
      daily: {
        ...tpexDailyModern,
        tables: [
          {
            ...((tpexDailyModern.tables as Array<Record<string, unknown>>)[0]),
            totalCount: "2.0",
          },
        ],
      },
    },
    {
      label: "TPEx mismatched totalCount",
      market: "otc" as const,
      daily: {
        ...tpexDailyModern,
        tables: [
          {
            ...((tpexDailyModern.tables as Array<Record<string, unknown>>)[0]),
            totalCount: 3,
          },
        ],
      },
    },
  ])("rejects $label as a bad upstream response", async ({ market, daily }) => {
    const client = new ValuationClient(
      fixtureFetch(
        market === "listed" ? { twseDaily: daily } : { tpexDaily: daily },
      ) as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market,
        date: "2026-08-25",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
  });

  it.each([
    {
      market: "listed" as const,
      daily: {
        stat: "很抱歉，沒有符合條件的資料!",
        date: "20260823",
        fields: [],
        data: [],
      },
    },
    {
      market: "otc" as const,
      daily: {
        stat: "ok",
        date: "20260823",
        tables: [],
        totalCount: 0,
      },
    },
  ])("returns NO_DATA for an exact-date $market holiday without fallback", async ({
    market,
    daily,
  }) => {
    const fetchMock = fixtureFetch(
      market === "listed" ? { twseDaily: daily } : { tpexDaily: daily },
    );
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market,
        date: "2026-08-23",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "NO_DATA" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forbids strict-current-master semantics on historical dates before I/O", async () => {
    const fetchMock = fixtureFetch();
    const masterMock = master([]);
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      masterMock,
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market: "listed",
        date: "2026-08-25",
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(masterMock.listCompanies).not.toHaveBeenCalled();
  });

  it.each([
    { market: "listed" as const, date: "2005-09-01" },
    { market: "otc" as const, date: "2007-01-01" },
    { market: "all" as const, date: "2005-09-02" },
  ])("rejects dates before the supported $market floor", async ({ market, date }) => {
    const fetchMock = fixtureFetch();
    const client = new ValuationClient(
      fetchMock as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );

    await expect(
      client.getDailyMarketValuation({
        market,
        date,
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["20260825", "2026-02-30", "2026-08-27"])(
    "rejects malformed or future historical date %s before I/O",
    async (date) => {
      const fetchMock = fixtureFetch();
      const client = new ValuationClient(
        fetchMock as typeof fetch,
        now,
        master([]),
        { retryDelayMs: 0 },
      );

      await expect(
        client.getDailyMarketValuation({
          market: "listed",
          date,
          universePolicy: "compatible",
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retries one transient response and caches both accepted official snapshots", async () => {
    let latestAttempts = 0;
    const fetchMock = vi.fn(async (
      input: URL | RequestInfo,
      _init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("BWIBBU_d")) return response(twseDailyModern);
      latestAttempts += 1;
      return latestAttempts === 1
        ? response("temporarily unavailable", 503)
        : response(twseFixture);
    });
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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      redirect: "error",
    });
  });

  it("retries an HTTP 200 response whose body is temporarily not JSON", async () => {
    let latestAttempts = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("BWIBBU_d")) return response(twseDailyModern);
      latestAttempts += 1;
      return latestAttempts === 1
        ? response("<html>temporary gateway page</html>")
        : response(twseFixture);
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
