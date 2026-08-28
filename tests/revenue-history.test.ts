import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMarket,
  MasterCompany,
} from "@/lib/company-master/types";
import {
  MonthlyRevenueClient,
  OfficialRevenueCsvLoader,
  normalizeMonthlyRevenueCsv,
} from "@/lib/revenue/client";
import { parseRevenueCsv } from "@/lib/revenue/csv";

const listedArchiveFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/revenue-archive-listed-2026-07.csv", import.meta.url),
  ),
  "utf8",
);
const otcArchiveFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/revenue-archive-otc-2026-07.csv", import.meta.url),
  ),
  "utf8",
);
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

const headers = [
  "出表日期",
  "資料年月",
  "公司代號",
  "公司名稱",
  "產業別",
  "當月營收",
  "上月營收",
  "去年當月營收",
  "上月比較增減(%)",
  "去年同月增減(%)",
  "當月累計營收",
  "去年累計營收",
  "前期比較增減(%)",
  "備註",
] as const;

const openapiHeaderByCsvHeader: Record<string, string> = {
  當月營收: "營業收入-當月營收",
  上月營收: "營業收入-上月營收",
  去年當月營收: "營業收入-去年當月營收",
  "上月比較增減(%)": "營業收入-上月比較增減(%)",
  "去年同月增減(%)": "營業收入-去年同月增減(%)",
  當月累計營收: "累計營業收入-當月累計營收",
  去年累計營收: "累計營業收入-去年累計營收",
  "前期比較增減(%)": "累計營業收入-前期比較增減(%)",
};

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvFromRecords(records: Array<Record<string, string>>): string {
  return `\ufeff${headers.join(",")}\r\n${records
    .map((record) =>
      headers
        .map((header) =>
          csvCell(record[header] ?? record[openapiHeaderByCsvHeader[header]] ?? ""),
        )
        .join(","),
    )
    .join("\r\n")}\r\n`;
}

function response(body: unknown, status = 200, contentType = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
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
  const missing = { reported: 0, missing: companies.length, invalid: 0 };
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
        incorporationDate: missing,
        paidInCapitalTwd: missing,
        issuedCommonShares: missing,
        parValueText: missing,
        financialReportTypeCode: missing,
      },
      companies,
      warnings: [],
    })),
  };
}

const now = () => new Date("2026-08-26T00:00:00.000Z");

function archiveRecord(
  dataMonth: string,
  code = "2330",
  values: { current: number; previousYear: number; yoy: number } = {
    current: 120,
    previousYear: 100,
    yoy: 20,
  },
): Record<string, string> {
  const [year, month] = dataMonth.split("-").map(Number);
  return {
    出表日期: "115/08/26",
    資料年月: `${year - 1911}/${month}`,
    公司代號: code,
    公司名稱: code === "2330" ? "台積電" : "台泥",
    產業別: code === "2330" ? "半導體業" : "水泥工業",
    當月營收: String(values.current),
    上月營收: String(values.current - 10),
    去年當月營收: String(values.previousYear),
    "上月比較增減(%)": "1",
    "去年同月增減(%)": String(values.yoy),
    當月累計營收: String(values.current * month),
    去年累計營收: String(values.previousYear * month),
    "前期比較增減(%)": String(values.yoy),
    備註: "",
  };
}

function archiveMonthFromUrl(input: URL | RequestInfo): string {
  const match = /t21sc03_(\d{3})_(\d{1,2})\.csv$/.exec(String(input));
  if (!match) throw new Error(`unexpected archive URL: ${String(input)}`);
  return `${Number(match[1]) + 1911}-${match[2].padStart(2, "0")}`;
}

describe("MOPS monthly revenue CSV", () => {
  it("preserves archive retrieval time and wires per-caller cache provenance", async () => {
    let clockMs = Date.parse("2026-08-26T00:00:00.000Z");
    const clock = () => new Date(clockMs);
    const fetchMock = vi.fn().mockResolvedValue(
      response(listedArchiveFixture, 200, "text/csv"),
    );
    const loader = new OfficialRevenueCsvLoader(
      fetchMock as typeof fetch,
      clock,
      { cacheTtlMs: 60_000, maxAttempts: 1 },
    );
    const config = {
      market: "listed" as const,
      exchange: "TWSE" as const,
      sourceName: "fixture",
      sourceUrl:
        "https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7.csv",
      dataMonth: "2026-07",
    };

    const first = await loader.get(config);
    clockMs += 4_000;
    const second = await loader.get(config);
    const normalized = normalizeMonthlyRevenueCsv(second, config);

    expect(first.cache?.status).toBe("miss");
    expect(second.retrievedAt).toBe(first.retrievedAt);
    expect(second.cache).toMatchObject({
      status: "hit",
      observedAt: "2026-08-26T00:00:04.000Z",
      storedAt: "2026-08-26T00:00:00.000Z",
      ageMs: 4_000,
      ttlMs: 60_000,
    });
    expect(normalized.source.cache).toEqual(second.cache);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses BOM, CRLF, quoted commas/newlines and escaped quotes as RFC 4180", () => {
    const record = archiveRecord("2026-07");
    record.備註 = '跨\r\n行，且有"引號"';
    const rows = parseRevenueCsv(csvFromRecords([record]));
    expect(rows[0].備註).toBe('跨\r\n行，且有"引號"');
    expect(() => parseRevenueCsv(`${headers.join(",")}\r\n1,"未結束`)).toThrow(
      "CSV 引號欄位未結束",
    );
  });

  it("accepts both official legacy and prefixed 14-column archive headers", () => {
    const record = archiveRecord("2026-07");
    const legacyCsv = csvFromRecords([record]);
    const prefixedHeaders = headers.map(
      (header) => openapiHeaderByCsvHeader[header] ?? header,
    );
    const prefixedCsv = legacyCsv.replace(
      headers.join(","),
      prefixedHeaders.join(","),
    );

    expect(parseRevenueCsv(legacyCsv)[0]).toHaveProperty("當月營收", "120");
    expect(parseRevenueCsv(prefixedCsv)[0]).toHaveProperty(
      "營業收入-當月營收",
      "120",
    );
    expect(
      normalizeMonthlyRevenueCsv(
        {
          payload: parseRevenueCsv(prefixedCsv),
          retrievedAt: now().toISOString(),
        },
        {
          market: "listed",
          exchange: "TWSE",
          sourceName: "fixture",
          sourceUrl:
            "https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7.csv",
          dataMonth: "2026-07",
        },
      ).rows[0].currentMonthRevenueTwd,
    ).toBe(120_000);
  });

  it("normalizes ROC fields, thousand TWD, official sentinel and quoted notes", () => {
    const result = normalizeMonthlyRevenueCsv(
      {
        payload: parseRevenueCsv(listedArchiveFixture),
        retrievedAt: now().toISOString(),
      },
      {
        market: "listed",
        exchange: "TWSE",
        sourceName: "fixture",
        sourceUrl:
          "https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7.csv",
        dataMonth: "2026-07",
      },
    );
    expect(result).toMatchObject({
      dataMonth: "2026-07",
      sourceReportDate: "2026-08-26",
      sourceKind: "archive",
    });
    expect(result.rows.find((row) => row.code === "1101")).toMatchObject({
      currentMonthRevenueTwd: 13_744_103_000,
      yoyPercent: null,
      valueStatus: { yoyPercent: "missing" },
    });
    expect(result.rows.find((row) => row.code === "2330")).toMatchObject({
      previousMonthRevenueTwd: 0,
      momPercent: null,
      note: "含,逗號",
    });
  });
});

describe("MonthlyRevenueClient history", () => {
  it("uses only the archive for an explicit month and rejects strict historical identity", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (!String(input).includes("t21sc03_115_7.csv")) {
        return response("not found", 404, "text/plain");
      }
      return response(listedArchiveFixture, 200, "text/csv");
    });
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([
        company("1101", "台泥", "listed", "01"),
        company("2330", "台積電", "listed"),
      ]),
      { retryDelayMs: 0 },
    );

    const result = await client.getMonthlyRevenue({
      market: "listed",
      dataMonth: "2026-07",
      companyCodes: ["2330"],
      universePolicy: "compatible",
    });
    expect(result.dataMonth).toBe("2026-07");
    expect(result.rows[0]).toMatchObject({
      code: "2330",
      industryCode: "24",
      sourceIndustryName: "半導體業",
      currentMonthRevenueTwd: 3_000_000_000,
    });
    expect(result.sources[0].sourceUrl).toContain("t21sc03_115_7.csv");
    expect(result).toMatchObject({
      coverageComplete: false,
      sourceCoverage: {
        status: "unverified",
        method: "structure_only_no_official_declared_count",
        complete: false,
      },
      filingCoverage: {
        complete: false,
        status: "historical_cross_timepoint_unverified",
      },
    });
    expect(result.sources[0].integrity).toEqual({
      format: "rfc4180_csv",
      structure: "verified",
      snapshotIdentity: "verified",
      eligibleCompanyCodesUnique: "verified",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "unverified_no_official_declared_count",
    });
    expect(fetchMock.mock.calls.every(([input]) =>
      String(input).includes("mopsov.twse.com.tw"),
    )).toBe(true);

    await expect(
      client.getMonthlyRevenue({
        market: "listed",
        dataMonth: "2026-07",
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("does not claim complete historical rowset coverage for a valid one-row archive", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const month = archiveMonthFromUrl(input);
      return response(
        csvFromRecords([archiveRecord(month, "2330")]),
        200,
        "text/csv",
      );
    });
    const result = await new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([company("2330", "台積電", "listed")]),
      { retryDelayMs: 0 },
    ).getMonthlyRevenue({
      market: "listed",
      dataMonth: "2026-07",
      universePolicy: "compatible",
    });

    expect(result.rows).toHaveLength(1);
    expect(result.coverageComplete).toBe(false);
    expect(result.sourceCoverage).toEqual({
      status: "unverified",
      method: "structure_only_no_official_declared_count",
      complete: false,
    });
    expect(result.filingCoverage).toMatchObject({
      expectedCompanyCount: 1,
      reportedCompanyCount: 1,
      complete: false,
      status: "historical_cross_timepoint_unverified",
    });
  });

  it("loads one historical CSV per selected market and retries malformed 200 responses", async () => {
    const attempts = new Map<string, number>();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      attempts.set(url, (attempts.get(url) ?? 0) + 1);
      if ((attempts.get(url) as number) === 1) {
        return response("<html>temporary gateway page</html>", 200, "text/html");
      }
      return response(
        url.includes("/sii/") ? listedArchiveFixture : otcArchiveFixture,
        200,
        "text/csv",
      );
    });
    const companies = [
      company("1101", "台泥", "listed", "01"),
      company("2330", "台積電", "listed"),
      company("3105", "穩懋", "otc"),
      company("6488", "環球晶", "otc"),
    ];
    const result = await new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    ).getMonthlyRevenue({
      market: "all",
      dataMonth: "2026-07",
      universePolicy: "compatible",
    });
    expect(result.counts).toEqual({ listed: 2, otc: 2, returned: 4 });
    expect(result.sources.map((source) => source.sourceUrl)).toEqual([
      "https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7.csv",
      "https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_115_7.csv",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects an archive above the configured row cap without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      response(listedArchiveFixture, 200, "text/csv"),
    );
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([
        company("1101", "台泥", "listed", "01"),
        company("2330", "台積電", "listed"),
      ]),
      { maxAttempts: 2, maxCsvRows: 1, retryDelayMs: 0 },
    );

    await expect(
      client.getMonthlyRevenue({
        market: "listed",
        dataMonth: "2026-07",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "UPSTREAM_RESPONSE_LIMIT_EXCEEDED",
      retryable: false,
      action: "none",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers a newer same-month archive, reports revisions, and rejects same-vintage conflicts", async () => {
    const extra = { ...twseFixture[0], 公司代號: "9999", 公司名稱: "新申報" };
    const archive = csvFromRecords(
      [...twseFixture, extra].map((record) => ({
        ...record,
        出表日期: "115/08/26",
      })),
    );
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("openapi.twse.com.tw")) return response(twseFixture);
      if (url.endsWith("t21sc03_115_7.csv")) {
        return response(archive, 200, "text/csv");
      }
      return response("not found", 404, "text/plain");
    });
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([
        company("1101", "台泥", "listed", "01"),
        company("2330", "台積電", "listed"),
      ]),
      { retryDelayMs: 0 },
    );
    const result = await client.getMonthlyRevenue({
      market: "listed",
      dataMonth: "latest",
      companyCodes: ["2330"],
      universePolicy: "compatible",
    });
    expect(result.sources[0]).toMatchObject({
      sourceReportDate: "2026-08-26",
      sourceUrl:
        "https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_7.csv",
    });
    expect(result.warnings.some((warning) => warning.includes("列集合不同"))).toBe(
      true,
    );

    const conflictingArchive = csvFromRecords(
      twseFixture.map((record) => ({
        ...record,
        出表日期: "115/08/26",
        ...(record.公司代號 === "2330"
          ? { "營業收入-當月營收": "3000001" }
          : {}),
      })),
    );
    const conflictFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("openapi.twse.com.tw")) return response(twseFixture);
      if (url.endsWith("t21sc03_115_7.csv")) {
        return response(conflictingArchive, 200, "text/csv");
      }
      return response("not found", 404, "text/plain");
    });
    const revised = await new MonthlyRevenueClient(
      conflictFetch as typeof fetch,
      now,
      master([company("1101", "台泥", "listed"), company("2330", "台積電", "listed")]),
      { retryDelayMs: 0 },
    ).getMonthlyRevenue({
      market: "listed",
      dataMonth: "latest",
      companyCodes: ["2330"],
      universePolicy: "compatible",
    });
    expect(revised.rows[0].currentMonthRevenueTwd).toBe(3_000_001_000);
    expect(revised.warnings.join(" ")).toContain("官方修訂");

    const sameVintageConflict = conflictingArchive.replaceAll(
      "115/08/26",
      "115/08/17",
    );
    const sameVintageFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("openapi.twse.com.tw")) return response(twseFixture);
      if (url.endsWith("t21sc03_115_7.csv")) {
        return response(sameVintageConflict, 200, "text/csv");
      }
      return response("not found", 404, "text/plain");
    });
    await expect(
      new MonthlyRevenueClient(
        sameVintageFetch as typeof fetch,
        now,
        master([company("1101", "台泥", "listed"), company("2330", "台積電", "listed")]),
        { retryDelayMs: 0 },
      ).getMonthlyRevenue({
        market: "listed",
        dataMonth: "latest",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });

    const systemicOpenapi = Array.from({ length: 6 }, (_, index) => ({
      ...twseFixture[1],
      公司代號: String(1200 + index),
      公司名稱: `公司${index}`,
    }));
    const systemicArchive = csvFromRecords(
      systemicOpenapi.map((record, index) => ({
        ...record,
        出表日期: "115/08/26",
        "營業收入-當月營收": String(4_000_000 + index),
      })),
    );
    const systemicFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("openapi.twse.com.tw")) return response(systemicOpenapi);
      if (url.endsWith("t21sc03_115_7.csv")) {
        return response(systemicArchive, 200, "text/csv");
      }
      return response("not found", 404, "text/plain");
    });
    await expect(
      new MonthlyRevenueClient(
        systemicFetch as typeof fetch,
        now,
        master(
          systemicOpenapi.map((record) =>
            company(record.公司代號, record.公司名稱, "listed"),
          ),
        ),
        { retryDelayMs: 0 },
      ).getMonthlyRevenue({
        market: "listed",
        dataMonth: "latest",
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      details: {
        conflictingCompanyCount: 6,
        maximumRevisionConflicts: 5,
      },
    });
  });

  it("selects the newest common valid month when market OpenAPI months differ", async () => {
    const tpexJune = tpexFixture.map((record) => ({
      ...record,
      出表日期: "1150717",
      資料年月: "11506",
    }));
    const twseJune = twseFixture.map((record) => ({
      ...record,
      出表日期: "115/07/26",
      資料年月: "115/06",
    }));
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("openapi.twse.com.tw")) return response(twseFixture);
      if (url.includes("tpex.org.tw/openapi")) return response(tpexJune);
      if (url.includes("/sii/") && url.endsWith("_7.csv")) {
        return response(
          csvFromRecords(twseFixture.map((row) => ({ ...row, 出表日期: "115/08/26" }))),
          200,
          "text/csv",
        );
      }
      if (url.includes("/sii/") && url.endsWith("_6.csv")) {
        return response(csvFromRecords(twseJune), 200, "text/csv");
      }
      if (url.includes("/otc/") && url.endsWith("_6.csv")) {
        return response(
          csvFromRecords(tpexJune.map((row) => ({ ...row, 出表日期: "115/07/26" }))),
          200,
          "text/csv",
        );
      }
      return response("not found", 404, "text/plain");
    });
    const companies = [
      company("1101", "台泥", "listed", "01"),
      company("2330", "台積電", "listed"),
      company("3105", "穩懋", "otc"),
      company("6488", "環球晶", "otc"),
    ];
    const result = await new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master(companies),
      { retryDelayMs: 0 },
    ).getMonthlyRevenue({
      market: "all",
      dataMonth: "latest",
      universePolicy: "strict_current_master",
    });
    expect(result.dataMonth).toBe("2026-06");
    expect(result.sources.map((source) => source.dataMonth)).toEqual([
      "2026-06",
      "2026-06",
    ]);
    expect(result.warnings.some((warning) => warning.includes("最新年月不一致"))).toBe(
      true,
    );
  });
});

describe("MonthlyRevenueClient trend", () => {
  it("returns six chronological points and the approved derived formulas/statuses", async () => {
    const values = new Map([
      ["2026-02", { current: 120, previousYear: 100, yoy: 20 }],
      ["2026-03", { current: 130, previousYear: 100, yoy: 30 }],
      ["2026-04", { current: 140, previousYear: 100, yoy: 40 }],
      ["2026-05", { current: 150, previousYear: 100, yoy: 50 }],
      ["2026-06", { current: 160, previousYear: 100, yoy: 60 }],
      ["2026-07", { current: 180, previousYear: 100, yoy: 80 }],
    ]);
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const month = archiveMonthFromUrl(input);
      return response(
        csvFromRecords([archiveRecord(month, "2330", values.get(month))]),
        200,
        "text/csv",
      );
    });
    const result = await new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    ).getMonthlyRevenueTrend({
      market: "listed",
      companyCodes: ["2330"],
      endMonth: "2026-07",
      lookbackMonths: 6,
      universePolicy: "compatible",
    });

    expect(result).toMatchObject({
      startMonth: "2026-02",
      endMonth: "2026-07",
      coverageComplete: false,
      sourceCoverage: {
        status: "unverified",
        method: "structure_only_no_official_declared_count",
        complete: false,
      },
      counts: {
        requestedCompanies: 1,
        returnedCompanies: 1,
        requestedMonths: 6,
      },
    });
    expect(result.companies[0].points.map((point) => point.dataMonth)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
    expect(result.companies[0].points.every(
      (point) => point.sourceIndustryName === "半導體業",
    )).toBe(true);
    expect(result.companies[0].derived).toEqual({
      latestYoyPercent: 80,
      rolling3MonthYoyPercent: 63.333333,
      rolling6MonthYoyPercent: 46.666667,
      yoyAccelerationVs3MonthsAgoPp: 40,
      positiveYoyMonthsInWindow: 6,
      reportedYoyMonthsInWindow: 6,
      consecutivePositiveYoyMonths: 6,
      valueStatus: {
        latestYoyPercent: "reported",
        rolling3MonthYoyPercent: "reported",
        rolling6MonthYoyPercent: "reported",
        yoyAccelerationVs3MonthsAgoPp: "reported",
        positiveYoyMonthsInWindow: "reported",
        reportedYoyMonthsInWindow: "reported",
        consecutivePositiveYoyMonths: "reported",
      },
    });
  });

  it("marks observed name and market transitions needs_review and does not join derived values", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const month = archiveMonthFromUrl(input);
      const listed = url.includes("/sii/");
      let record: Record<string, string>;
      if (month === "2026-05" && listed) {
        record = { ...archiveRecord(month, "2330"), 公司名稱: "台積電舊名" };
      } else if (month !== "2026-05" && !listed) {
        record = { ...archiveRecord(month, "2330"), 公司名稱: "台積電新名" };
      } else {
        record = archiveRecord(month, listed ? "1101" : "3105");
      }
      return response(csvFromRecords([record]), 200, "text/csv");
    });
    const result = await new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    ).getMonthlyRevenueTrend({
      market: "all",
      companyCodes: ["2330"],
      endMonth: "2026-07",
      lookbackMonths: 3,
      universePolicy: "compatible",
    });

    const companyResult = result.companies[0];
    expect(companyResult.observedNames).toEqual(["台積電舊名", "台積電新名"]);
    expect(companyResult.observedMarkets).toEqual(["listed", "otc"]);
    expect(companyResult.points.map(({ dataMonth, name, market }) => ({
      dataMonth,
      name,
      market,
    }))).toEqual([
      { dataMonth: "2026-05", name: "台積電舊名", market: "listed" },
      { dataMonth: "2026-06", name: "台積電新名", market: "otc" },
      { dataMonth: "2026-07", name: "台積電新名", market: "otc" },
    ]);
    expect(companyResult.comparability).toEqual({
      status: "needs_review",
      reasons: ["observed_name_transition", "observed_market_transition"],
      transitions: [
        {
          dataMonth: "2026-06",
          fromName: "台積電舊名",
          toName: "台積電新名",
          fromMarket: "listed",
          toMarket: "otc",
          reasons: ["observed_name_transition", "observed_market_transition"],
        },
      ],
    });
    expect(companyResult.derived).toEqual({
      latestYoyPercent: null,
      rolling3MonthYoyPercent: null,
      rolling6MonthYoyPercent: null,
      yoyAccelerationVs3MonthsAgoPp: null,
      positiveYoyMonthsInWindow: null,
      reportedYoyMonthsInWindow: null,
      consecutivePositiveYoyMonths: null,
      valueStatus: {
        latestYoyPercent: "needs_review",
        rolling3MonthYoyPercent: "needs_review",
        rolling6MonthYoyPercent: "needs_review",
        yoyAccelerationVs3MonthsAgoPp: "needs_review",
        positiveYoyMonthsInWindow: "needs_review",
        reportedYoyMonthsInWindow: "needs_review",
        consecutivePositiveYoyMonths: "needs_review",
      },
    });
    expect(result.warnings.some((warning) => warning.includes("derived 全數回 null"))).toBe(
      true,
    );
  });

  it("keeps missing company-month points explicit and does not derive through gaps", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const month = archiveMonthFromUrl(input);
      const code = month === "2026-06" ? "1101" : "2330";
      return response(
        csvFromRecords([archiveRecord(month, code)]),
        200,
        "text/csv",
      );
    });
    const result = await new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    ).getMonthlyRevenueTrend({
      market: "listed",
      companyCodes: ["2330", "9999"],
      endMonth: "2026-07",
      lookbackMonths: 3,
      universePolicy: "compatible",
    });
    expect(result.selectionComplete).toBe(false);
    expect(result.missingCompanyCodes).toEqual(["9999"]);
    expect(result.companies[0].missingMonths).toEqual(["2026-06"]);
    expect(result.companies[0].derived).toMatchObject({
      rolling3MonthYoyPercent: null,
      positiveYoyMonthsInWindow: 2,
      reportedYoyMonthsInWindow: 2,
      consecutivePositiveYoyMonths: 1,
      valueStatus: {
        rolling3MonthYoyPercent: "insufficient_data",
        positiveYoyMonthsInWindow: "partial",
        consecutivePositiveYoyMonths: "partial",
      },
    });
  });

  it("validates the 1-100 company, 3-24 month and historical-universe bounds before fetching", async () => {
    const fetchMock = vi.fn();
    const client = new MonthlyRevenueClient(
      fetchMock as typeof fetch,
      now,
      master([]),
      { retryDelayMs: 0 },
    );
    await expect(
      client.getMonthlyRevenueTrend({
        market: "listed",
        companyCodes: Array.from({ length: 101 }, (_, index) =>
          String(1000 + index),
        ),
        endMonth: "2026-07",
        lookbackMonths: 6,
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.getMonthlyRevenueTrend({
        market: "listed",
        companyCodes: ["2330"],
        endMonth: "2026-07",
        lookbackMonths: 2,
        universePolicy: "compatible",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.getMonthlyRevenueTrend({
        market: "listed",
        companyCodes: ["2330"],
        endMonth: "2026-07",
        lookbackMonths: 6,
        universePolicy: "strict_current_master",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
