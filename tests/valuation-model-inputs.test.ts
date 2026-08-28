import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import type { StatementKind } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import {
  valuationModelInputsDataSchema,
  valuationModelInputsOutputSchema,
} from "@/lib/mcp/schema/valuation-model";
import type { DailyMarketValuationResult } from "@/lib/valuation/types";
import { ValuationModelInputsClient } from "@/lib/valuation-model/client";
import type { FinancialStatementResultLike } from "@/lib/valuation-model/statement-resolver";

interface StatementFixture {
  labels: string[];
  values: string[];
}

interface FixtureShape {
  company: MasterCompany;
  statementPeriods: {
    latest: string;
    priorFiscalYear: string;
    priorYearYtd: string;
  };
  statements: Record<string, Partial<Record<StatementKind, StatementFixture>>>;
  latestValuation: {
    dataDate: string;
    closePriceTwd: number;
    rawClosePrice: string;
  };
}

function readFixture(): FixtureShape {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("./fixtures/valuation-model-inputs.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as FixtureShape;
}

function masterResult(
  company: MasterCompany,
  companies: MasterCompany[] = [company],
): CompanyMasterResult {
  const marketCompanyCount = companies.filter(
    (candidate) => candidate.market === company.market,
  ).length;
  return {
    query: { market: "all", includeFinancial: true, includeKy: true },
    generatedAt: "2026-08-28T01:00:00.000Z",
    snapshotId: `${company.market}-2026-08-28`,
    coverageVerification: {
      status: "heuristic",
      method: "required_sources_schema_single_report_date_minimum_count",
      officialDeclaredRowCountAvailable: false,
    },
    coverageComplete: true,
    sources: [
      {
        market: company.market,
        exchange: company.exchange,
        sourceName: `${company.exchange} company master fixture`,
        sourceUrl:
          company.market === "listed"
            ? "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
            : "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
        reportDate: "2026-08-28",
        retrievedAt: "2026-08-28T01:00:00.000Z",
        rawCount: marketCompanyCount,
        excludedTdrCount: 0,
        companyCount: marketCompanyCount,
        minimumExpectedCount: 1,
      },
    ],
    counts: {
      raw: companies.length,
      excludedTdr: 0,
      eligible: companies.length,
      excludedFinancial: 0,
      excludedKy: 0,
      listed: companies.filter((candidate) => candidate.market === "listed")
        .length,
      otc: companies.filter((candidate) => candidate.market === "otc").length,
      returned: companies.length,
    },
    profileCoverage: {
      incorporationDate: { reported: companies.length, missing: 0, invalid: 0 },
      paidInCapitalTwd: { reported: companies.length, missing: 0, invalid: 0 },
      issuedCommonShares: { reported: companies.length, missing: 0, invalid: 0 },
      parValueText: { reported: companies.length, missing: 0, invalid: 0 },
      financialReportTypeCode: {
        reported: companies.length,
        missing: 0,
        invalid: 0,
      },
    },
    companies,
    warnings: [],
  };
}

function currentMasterCompanies(
  selected: MasterCompany,
  count: number,
): MasterCompany[] {
  return [
    selected,
    ...Array.from({ length: count - 1 }, (_, index) => ({
      ...selected,
      code: String(3001 + index),
      name: `測試公司 ${index + 1} 股份有限公司`,
      shortName: `測試${index + 1}`,
      issuedCommonShares: 1_000_000 + index,
    })),
  ];
}

function statementResult(
  company: MasterCompany,
  statement: StatementKind,
  period: string,
  fixture: StatementFixture,
): FinancialStatementResultLike {
  const marketLabel = company.market === "listed" ? "上市" : "上櫃";
  return {
    sourceName: "Mopsfin statement fixture",
    sourceUrl: "https://mopsfin.twse.com.tw/",
    retrievedAt: "2026-08-28T01:02:03.000Z",
    upstreamRoute: "/compare/report",
    query: {
      statement,
      companyCodes: [company.code],
      companies: [`${company.code} ${company.shortName}`],
      period,
    },
    unit: "新台幣仟元",
    unitSource: "response_html",
    period,
    reportNames: [`${company.code} ${company.shortName} (${marketLabel}半導體業)`],
    tables: [
      {
        title: "會計科目",
        headers: [["報表類別"], ["會計科目"]],
        rows: fixture.labels.map((label) => [label]),
      },
      {
        title: "公司數值",
        headers: [
          ["合併"],
          [`${company.code} ${company.shortName}(${marketLabel}半導體業)`],
        ],
        rows: fixture.values.map((value) => [value]),
      },
    ],
    pagination: {
      offset: 0,
      limit: 500,
      returnedRows: fixture.labels.length * 2,
      totalRows: fixture.labels.length * 2,
      nextOffset: null,
    },
  };
}

function valuationResult(
  company: MasterCompany,
  fixture: FixtureShape["latestValuation"],
): DailyMarketValuationResult {
  const latestSource =
    company.market === "listed"
      ? {
          name: "TWSE latest valuation discovery fixture",
          url: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
        }
      : {
          name: "TPEx latest valuation discovery fixture",
          url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
        };
  const exactSource =
    company.market === "listed"
      ? {
          name: "TWSE exact-day valuation fixture",
          url: "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d",
        }
      : {
          name: "TPEx exact-day valuation fixture",
          url: "https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate",
        };
  return {
    query: {
      market: company.market,
      date: "latest",
      companyCodes: [company.code],
      universePolicy: "compatible",
    },
    dataDate: fixture.dataDate,
    currency: "TWD",
    classificationPolicy: "current_master_with_code_fallback",
    coverageComplete: true,
    universeCoverageVerified: true,
    selectionComplete: true,
    missingCompanyCodes: [],
    reconciliation: [
      {
        market: company.market,
        masterCount: 1,
        sourceRowCount: 1,
        matchedCount: 1,
        marketOnlyCodes: [],
        masterMissingCodes: [],
        matchRatio: 1,
        coverageComplete: true,
      },
    ],
    counts: {
      raw: 1,
      returned: 1,
      withPe: 1,
      withPb: 1,
      withDividendYield: 1,
      withClosePrice: 1,
      withDividendPerShare: 0,
      withDividendFiscalYear: 0,
      withReferenceFiscalPeriod: 0,
    },
    rows: [
      {
        code: company.code,
        name: company.shortName,
        market: company.market,
        peRatio: 20,
        priceToBookRatio: 8,
        dividendYieldPercent: 1.5,
        closePriceTwd: fixture.closePriceTwd,
        dividendPerShareTwd: null,
        dividendFiscalYear: null,
        referenceFiscalPeriod: null,
        valueStatus: {
          peRatio: "reported",
          priceToBookRatio: "reported",
          dividendYieldPercent: "reported",
          closePriceTwd: "reported",
          dividendPerShareTwd: "not_provided_by_source",
          dividendFiscalYear: "not_provided_by_source",
          referenceFiscalPeriod: "not_provided_by_source",
        },
        rawValue: {
          peRatio: "20",
          priceToBookRatio: "8",
          dividendYieldPercent: "1.5",
          closePriceTwd: fixture.rawClosePrice,
          dividendPerShareTwd: null,
          dividendFiscalYear: null,
          referenceFiscalPeriod: null,
        },
      },
    ],
    sources: [
      {
        market: company.market,
        exchange: company.exchange,
        sourceName: latestSource.name,
        sourceUrl: latestSource.url,
        retrievedAt: "2026-08-28T01:02:59.000Z",
        dataDate: fixture.dataDate,
        rawCount: 1,
        eligibleRowCount: 1,
      },
      {
        market: company.market,
        exchange: company.exchange,
        sourceName: exactSource.name,
        sourceUrl: exactSource.url,
        retrievedAt: "2026-08-28T01:03:00.000Z",
        dataDate: fixture.dataDate,
        rawCount: 1,
        eligibleRowCount: 1,
      },
    ],
    warnings: [],
  };
}

function dependencies(options: {
  fixture?: FixtureShape;
  mutateStatement?: (
    result: FinancialStatementResultLike,
    statement: StatementKind,
    requestedPeriod: string,
  ) => FinancialStatementResultLike;
  valuationFailure?: boolean;
} = {}) {
  const fixture = options.fixture ?? readFixture();
  const master = {
    listCompanies: vi.fn(async () => masterResult(fixture.company)),
  };
  const mopsfin = {
    getFinancialStatement: vi.fn(
      async (query: {
        statement: StatementKind;
        companyCodes: string[];
        period: string;
        page: { offset: number; limit: number };
      }) => {
        const actualPeriod =
          query.period === "latest" ? fixture.statementPeriods.latest : query.period;
        const rows = fixture.statements[actualPeriod]?.[query.statement];
        if (!rows) {
          throw new MopsfinError("NO_DATA", "fixture statement unavailable");
        }
        const result = statementResult(
          fixture.company,
          query.statement,
          actualPeriod,
          rows,
        );
        return options.mutateStatement
          ? options.mutateStatement(result, query.statement, query.period)
          : result;
      },
    ),
  };
  const valuation = {
    getDailyMarketValuation: options.valuationFailure
      ? vi.fn(async () => {
          throw new MopsfinError("NO_DATA", "fixture valuation unavailable");
        })
      : vi.fn(async () => valuationResult(fixture.company, fixture.latestValuation)),
  };
  return { fixture, master, mopsfin, valuation };
}

type ValuationInputsResult = Awaited<
  ReturnType<ValuationModelInputsClient["getValuationModelInputs"]>
>;

function latestCloseLineage(result: ValuationInputsResult) {
  return result.lineage.find(
    (entry) => entry.role === "latest_completed_official_close",
  );
}

describe("ValuationModelInputsClient", () => {
  it("builds auditable TTM inputs, FCFF, net debt and enterprise value", async () => {
    const deps = dependencies();
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
      () => new Date("2026-08-28T02:00:00.000Z"),
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(valuationModelInputsDataSchema.safeParse(result).success).toBe(true);

    expect(result.applicability).toEqual({ status: "applicable", reason: null });
    expect(result.periods).toMatchObject({
      latestReportedPeriod: "2026Q2",
      ttmMethod: "current_ytd_plus_prior_fy_minus_prior_year_ytd",
      currentYtdPeriod: "2026Q2",
      priorFiscalYearPeriod: "2025Q4",
      priorYearYtdPeriod: "2025Q2",
      consolidationScope: "consolidated",
    });
    expect(result.fields.ttmRevenue.value).toBe(4_436_000);
    expect(result.fields.ttmOperatingIncomeEbitProxy.value).toBe(2_491_000);
    expect(result.fields.cashTaxRatePercent.value).toBeCloseTo(
      (312_000 / 2_668_000) * 100,
      10,
    );
    expect(result.fields.ttmDepreciationAndAmortization.value).toBe(687_000);
    expect(result.fields.ttmCapitalExpenditure.value).toBe(1_490_000);
    expect(result.fields.ttmDeltaNetWorkingCapital.value).toBe(236_000);
    expect(result.fields.normalizedFcff.value).toBeCloseTo(
      2_491_000 * (1 - 312_000 / 2_668_000) + 687_000 - 1_490_000 - 236_000,
      6,
    );
    expect(result.fields.cashAndCashEquivalents.value).toBe(3_134_000);
    expect(result.fields.interestBearingDebt.value).toBe(897_000);
    expect(result.fields.netDebt.value).toBe(-2_237_000);
    expect(result.fields.issuedShares.value).toBe(25_932_071_458);
    expect(result.fields.issuedShares.evidenceClass).toBe("OFFICIAL_MASTER_RAW");
    expect(result.fields.latestOfficialClose.value).toBe(2_000);
    expect(result.fields.latestOfficialClose.evidenceClass).toBe(
      "OFFICIAL_MARKET_RAW",
    );
    expect(result.fields.marketCapitalization.value).toBe(51_864_142_916_000);
    expect(result.fields.marketCapitalization.evidenceClass).toBe(
      "OFFICIAL_CALC",
    );
    expect(result.fields.enterpriseValue.value).toBe(51_864_140_679_000);
    expect(result.fields.enterpriseValue.evidenceClass).toBe(
      "MIXED_OFFICIAL_CALC",
    );
    expect(result.quality).toEqual({
      calculationComplete: true,
      dataGapFields: [],
      notApplicableFields: [],
    });
    expect(result.workBudget).toEqual({
      requestedCompanies: 1,
      orchestrationCompanyMasterCalls: 1,
      statementCalls: { actual: 7, maximum: 7, rowsPerCallMaximum: 500 },
      valuationDependencyCalls: {
        actual: 1,
        maximum: 1,
        internalCurrentMasterPolicy: "compatible",
        minimumCurrentMasterMatchRatio: 0.95,
        selectedCompanyIdentityPolicy:
          "outer_market_all_master_plus_official_row_exact",
      },
    });
    expect(result.lineage.some((entry) => entry.rowLabel === "營業收入合計")).toBe(
      true,
    );
    expect(result.sources.map((source) => source.stage)).toEqual([
      "company_master",
      "statement",
      "statement",
      "statement",
      "statement",
      "statement",
      "statement",
      "statement",
      "market_valuation",
      "market_valuation",
    ]);
    expect(
      result.lineage.find(
        (entry) => entry.role === "latest_completed_official_close",
      )?.sourceId,
    ).toBe("market_valuation:listed:2026-08-27:2");
    expect(deps.mopsfin.getFinancialStatement).toHaveBeenCalledTimes(7);
    expect(deps.valuation.getDailyMarketValuation).toHaveBeenCalledTimes(1);
    expect(deps.valuation.getDailyMarketValuation).toHaveBeenCalledWith({
      market: "listed",
      date: "latest",
      companyCodes: ["2330"],
      universePolicy: "compatible",
    });
    const meta = buildResultMeta(
      result,
      {
        selector: "latest",
        resolved: { granularity: "mixed", from: null, through: null },
      },
      result.generatedAt,
    );
    expect(
      meta.asOf.sourceCutoffs.some(
        (cutoff) =>
          cutoff.resolved.granularity === "quarter" &&
          cutoff.resolved.from === "2026Q2",
      ),
    ).toBe(true);

    const advertisedOutput = { ok: true as const, meta, ...result };
    expect(
      valuationModelInputsOutputSchema.safeParse(advertisedOutput).success,
    ).toBe(true);
    const inconsistentOutput = structuredClone(advertisedOutput);
    inconsistentOutput.quality.calculationComplete = false;
    expect(
      valuationModelInputsOutputSchema.safeParse(inconsistentOutput).success,
    ).toBe(false);
  });

  it("keeps a valid selected close when unrelated current-master codes differ above the compatible 95% gate", async () => {
    const deps = dependencies();
    const companies = currentMasterCompanies(deps.fixture.company, 20);
    const unrelatedMissingCode = companies.at(-1)?.code as string;
    deps.master.listCompanies.mockResolvedValue(
      masterResult(deps.fixture.company, companies),
    );
    const compatible = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    compatible.universeCoverageVerified = false;
    compatible.reconciliation = [
      {
        market: deps.fixture.company.market,
        masterCount: 20,
        sourceRowCount: 19,
        matchedCount: 19,
        marketOnlyCodes: [],
        masterMissingCodes: [unrelatedMissingCode],
        matchRatio: 0.95,
        coverageComplete: false,
      },
    ];
    deps.valuation.getDailyMarketValuation.mockResolvedValue(compatible);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose).toMatchObject({
      status: "reported",
      value: 2_000,
      evidenceClass: "OFFICIAL_MARKET_RAW",
    });
    expect(latestCloseLineage(result)?.status).toBe("resolved");
    expect(result.quality.calculationComplete).toBe(true);
    expect(result.warnings.join(" ")).toContain(
      "通過 compatible 95% 防截斷門檻",
    );
    expect(valuationModelInputsDataSchema.safeParse(result).success).toBe(true);
  });

  it("fails latest close closed when compatible full-market coverage is below 95%", async () => {
    const deps = dependencies();
    const companies = currentMasterCompanies(deps.fixture.company, 20);
    deps.master.listCompanies.mockResolvedValue(
      masterResult(deps.fixture.company, companies),
    );
    const truncated = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    truncated.universeCoverageVerified = false;
    truncated.reconciliation = [
      {
        market: deps.fixture.company.market,
        masterCount: 20,
        sourceRowCount: 18,
        matchedCount: 18,
        marketOnlyCodes: [],
        masterMissingCodes: companies.slice(-2).map((company) => company.code),
        matchRatio: 0.9,
        coverageComplete: false,
      },
    ];
    deps.valuation.getDailyMarketValuation.mockResolvedValue(truncated);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose).toMatchObject({
      status: "data_gap",
      value: null,
      dataGapReason: "VALUATION_VALUE_UNAVAILABLE",
    });
    expect(result.fields.marketCapitalization.status).toBe("data_gap");
    expect(result.fields.enterpriseValue.status).toBe("data_gap");
    expect(result.warnings.join(" ")).toContain(
      "未通過 composite identity／reconciliation 契約",
    );
  });

  it("fails latest close closed when reconciliation marks the selected company missing", async () => {
    const deps = dependencies();
    const companies = currentMasterCompanies(deps.fixture.company, 20);
    deps.master.listCompanies.mockResolvedValue(
      masterResult(deps.fixture.company, companies),
    );
    const inconsistent = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    inconsistent.universeCoverageVerified = false;
    inconsistent.reconciliation = [
      {
        market: deps.fixture.company.market,
        masterCount: 20,
        sourceRowCount: 19,
        matchedCount: 19,
        marketOnlyCodes: [],
        masterMissingCodes: [deps.fixture.company.code],
        matchRatio: 0.95,
        coverageComplete: false,
      },
    ];
    deps.valuation.getDailyMarketValuation.mockResolvedValue(inconsistent);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(
      result.lineage.find(
        (entry) => entry.role === "latest_completed_official_close",
      )?.status,
    ).toBe("invalid");
  });

  it("fails latest close closed when the selected official row identity differs from outer current master", async () => {
    const deps = dependencies();
    const mismatched = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    mismatched.rows[0].name = "另一家公司";
    deps.valuation.getDailyMarketValuation.mockResolvedValue(mismatched);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(
      result.lineage.find(
        (entry) => entry.role === "latest_completed_official_close",
      )?.status,
    ).toBe("invalid");
  });

  it("accepts a fully reconciled OTC selected close with TPEx source identity", async () => {
    const fixture = readFixture();
    Object.assign(fixture.company, {
      code: "6488",
      name: "環球晶圓股份有限公司",
      shortName: "環球晶",
      market: "otc" as const,
      exchange: "TPEx" as const,
      issuedCommonShares: 436_250_000,
    });
    const deps = dependencies({ fixture });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "6488" });

    expect(result.company).toMatchObject({
      code: "6488",
      market: "otc",
      exchange: "TPEx",
    });
    expect(result.fields.latestOfficialClose).toMatchObject({
      status: "reported",
      value: 2_000,
      evidenceClass: "OFFICIAL_MARKET_RAW",
    });
    expect(latestCloseLineage(result)).toMatchObject({
      status: "resolved",
      sourceId: "market_valuation:otc:2026-08-27:2",
    });
    expect(deps.valuation.getDailyMarketValuation).toHaveBeenCalledWith({
      market: "otc",
      date: "latest",
      companyCodes: ["6488"],
      universePolicy: "compatible",
    });
    expect(valuationModelInputsDataSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    "missing_or_not_meaningful",
    "not_provided_by_source",
  ] as const)(
    "classifies a contract-valid official %s close as missing",
    async (valueStatus) => {
      const deps = dependencies();
      const missing = valuationResult(
        deps.fixture.company,
        deps.fixture.latestValuation,
      );
      missing.rows[0].closePriceTwd = null;
      missing.rows[0].rawValue.closePriceTwd =
        valueStatus === "missing_or_not_meaningful" ? "-" : null;
      missing.rows[0].valueStatus.closePriceTwd = valueStatus;
      missing.counts.withClosePrice = 0;
      deps.valuation.getDailyMarketValuation.mockResolvedValue(missing);
      const client = new ValuationModelInputsClient(
        deps.mopsfin,
        deps.master,
        deps.valuation,
      );

      const result = await client.getValuationModelInputs({ companyCode: "2330" });

      expect(result.fields.latestOfficialClose.status).toBe("data_gap");
      expect(latestCloseLineage(result)).toMatchObject({
        status: "missing",
        rawValue: valueStatus === "missing_or_not_meaningful" ? "-" : null,
        normalizedValue: null,
      });
      expect(result.warnings.join(" ")).toContain(valueStatus);
    },
  );

  it("classifies an invalid_upstream selected close as invalid", async () => {
    const deps = dependencies();
    const invalid = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    invalid.rows[0].closePriceTwd = null;
    invalid.rows[0].rawValue.closePriceTwd = "not-a-price";
    invalid.rows[0].valueStatus.closePriceTwd = "invalid_upstream";
    invalid.counts.withClosePrice = 0;
    deps.valuation.getDailyMarketValuation.mockResolvedValue(invalid);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(latestCloseLineage(result)?.status).toBe("invalid");
  });

  it("classifies an internally inconsistent official missing status as invalid", async () => {
    const deps = dependencies();
    const inconsistent = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    inconsistent.rows[0].closePriceTwd = null;
    inconsistent.rows[0].rawValue.closePriceTwd = "2,000.00";
    inconsistent.rows[0].valueStatus.closePriceTwd =
      "missing_or_not_meaningful";
    inconsistent.counts.withClosePrice = 0;
    deps.valuation.getDailyMarketValuation.mockResolvedValue(inconsistent);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(latestCloseLineage(result)?.status).toBe("invalid");
  });

  it("classifies duplicate selected official rows as invalid", async () => {
    const deps = dependencies();
    const duplicate = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    duplicate.rows.push(structuredClone(duplicate.rows[0]));
    duplicate.counts.returned = 2;
    deps.valuation.getDailyMarketValuation.mockResolvedValue(duplicate);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(latestCloseLineage(result)?.status).toBe("invalid");
  });

  it("classifies an absent selected official row as missing", async () => {
    const deps = dependencies();
    const companies = currentMasterCompanies(deps.fixture.company, 20);
    deps.master.listCompanies.mockResolvedValue(
      masterResult(deps.fixture.company, companies),
    );
    const missing = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    missing.rows = [];
    missing.counts.returned = 0;
    missing.counts.withClosePrice = 0;
    missing.coverageComplete = false;
    missing.selectionComplete = false;
    missing.missingCompanyCodes = [deps.fixture.company.code];
    missing.universeCoverageVerified = false;
    missing.reconciliation = [
      {
        market: deps.fixture.company.market,
        masterCount: 20,
        sourceRowCount: 19,
        matchedCount: 19,
        marketOnlyCodes: [],
        masterMissingCodes: [deps.fixture.company.code],
        matchRatio: 0.95,
        coverageComplete: false,
      },
    ];
    deps.valuation.getDailyMarketValuation.mockResolvedValue(missing);
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(latestCloseLineage(result)).toMatchObject({
      status: "missing",
      rawValue: null,
      normalizedValue: null,
    });
  });

  it("keeps the inner full-market master count tied to the outer per-market master", async () => {
    const deps = dependencies();
    const companies = currentMasterCompanies(deps.fixture.company, 20);
    deps.master.listCompanies.mockResolvedValue(
      masterResult(deps.fixture.company, companies),
    );
    const selectedOnlyReconciliation = valuationResult(
      deps.fixture.company,
      deps.fixture.latestValuation,
    );
    deps.valuation.getDailyMarketValuation.mockResolvedValue(
      selectedOnlyReconciliation,
    );
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(selectedOnlyReconciliation.reconciliation[0].masterCount).toBe(1);
    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(latestCloseLineage(result)?.status).toBe("invalid");
  });

  it.each([
    [
      "query company code",
      (value: DailyMarketValuationResult) => {
        value.query.companyCodes = ["2454"];
      },
    ],
    [
      "query market",
      (value: DailyMarketValuationResult) => {
        value.query.market = "otc";
      },
    ],
    [
      "query universe policy",
      (value: DailyMarketValuationResult) => {
        value.query.universePolicy = "strict_current_master";
      },
    ],
    [
      "classification policy",
      (value: DailyMarketValuationResult) => {
        value.classificationPolicy = "historical_code_rule";
      },
    ],
    [
      "source exchange",
      (value: DailyMarketValuationResult) => {
        value.sources[1].exchange = "TPEx";
      },
    ],
    [
      "source data date",
      (value: DailyMarketValuationResult) => {
        value.sources[1].dataDate = "2026-08-26";
      },
    ],
    [
      "raw close",
      (value: DailyMarketValuationResult) => {
        value.rows[0].rawValue.closePriceTwd = "1,999.00";
      },
    ],
  ] as const)(
    "classifies a selected row with mismatched %s evidence as invalid",
    async (_label, mutate) => {
      const deps = dependencies();
      const inconsistent = valuationResult(
        deps.fixture.company,
        deps.fixture.latestValuation,
      );
      mutate(inconsistent);
      deps.valuation.getDailyMarketValuation.mockResolvedValue(inconsistent);
      const client = new ValuationModelInputsClient(
        deps.mopsfin,
        deps.master,
        deps.valuation,
      );

      const result = await client.getValuationModelInputs({ companyCode: "2330" });

      expect(result.fields.latestOfficialClose.status).toBe("data_gap");
      expect(latestCloseLineage(result)?.status).toBe("invalid");
    },
  );

  it.each([
    [
      "source-row arithmetic",
      (value: DailyMarketValuationResult) => {
        value.reconciliation[0].sourceRowCount = 2;
      },
    ],
    [
      "matched-count arithmetic",
      (value: DailyMarketValuationResult) => {
        value.reconciliation[0].matchedCount = 0;
        value.reconciliation[0].matchRatio = 0;
      },
    ],
    [
      "match-ratio arithmetic",
      (value: DailyMarketValuationResult) => {
        value.reconciliation[0].matchRatio = 0.99;
      },
    ],
  ] as const)(
    "classifies a selected row with invalid reconciliation %s as invalid",
    async (_label, mutate) => {
      const deps = dependencies();
      const inconsistent = valuationResult(
        deps.fixture.company,
        deps.fixture.latestValuation,
      );
      mutate(inconsistent);
      deps.valuation.getDailyMarketValuation.mockResolvedValue(inconsistent);
      const client = new ValuationModelInputsClient(
        deps.mopsfin,
        deps.master,
        deps.valuation,
      );

      const result = await client.getValuationModelInputs({ companyCode: "2330" });

      expect(result.fields.latestOfficialClose.status).toBe("data_gap");
      expect(latestCloseLineage(result)?.status).toBe("invalid");
    },
  );

  it("uses a Q4 annual statement directly without fetching historical TTM bridge periods", async () => {
    const fixture = readFixture();
    fixture.statementPeriods.latest = "2025Q4";
    fixture.statements["2025Q4"].balance_sheet =
      fixture.statements["2026Q2"].balance_sheet;
    const deps = dependencies({ fixture });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.periods.ttmMethod).toBe("fiscal_year");
    expect(result.fields.ttmRevenue.value).toBe(3_809_000);
    expect(deps.mopsfin.getFinancialStatement).toHaveBeenCalledTimes(3);
  });

  it("fails the affected TTM field closed when a semantic row is ambiguous", async () => {
    const deps = dependencies({
      mutateStatement: (result, statement, requestedPeriod) => {
        if (statement !== "income_statement" || requestedPeriod !== "latest") {
          return result;
        }
        const copy = structuredClone(result);
        copy.tables[0].rows.push(["營業收入"]);
        copy.tables[1].rows.push(["2,400"]);
        copy.pagination.returnedRows += 2;
        copy.pagination.totalRows += 2;
        return copy;
      },
    });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.ttmRevenue).toMatchObject({
      value: null,
      status: "data_gap",
      evidenceClass: "UNAVAILABLE",
      dataGapReason: "TTM_COMPONENT_UNAVAILABLE",
    });
    expect(
      result.lineage.find(
        (entry) => entry.role === "revenue" && entry.period === "2026Q2",
      ),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("preserves financial inputs when latest official valuation fails", async () => {
    const deps = dependencies({ valuationFailure: true });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.ttmRevenue.status).toBe("derived");
    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(result.fields.marketCapitalization.status).toBe("data_gap");
    expect(result.fields.enterpriseValue.status).toBe("data_gap");
    expect(latestCloseLineage(result)?.status).toBe("missing");
    for (const field of Object.values(result.fields).filter(
      (candidate) => candidate.status === "data_gap",
    )) {
      expect(field.inputLineageIds.length).toBeGreaterThan(0);
    }
    expect(result.warnings.join(" ")).toContain("latest official close dependency");
  });

  it("returns NOT_APPLICABLE for financial companies without calling statements or valuation", async () => {
    const fixture = readFixture();
    fixture.company.isFinancial = true;
    fixture.company.industryCode = "17";
    const deps = dependencies({ fixture });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.applicability).toEqual({
      status: "not_applicable",
      reason: "financial_company_requires_residual_income_or_dividend_model",
    });
    expect(valuationModelInputsDataSchema.safeParse(result).success).toBe(true);
    expect(result.quality.notApplicableFields).toHaveLength(14);
    expect(Object.values(result.fields).every((field) => field.status === "not_applicable"))
      .toBe(true);
    expect(deps.mopsfin.getFinancialStatement).not.toHaveBeenCalled();
    expect(deps.valuation.getDailyMarketValuation).not.toHaveBeenCalled();
    expect(result.workBudget.statementCalls.actual).toBe(0);
    expect(result.workBudget.valuationDependencyCalls.actual).toBe(0);
  });

  it("records an auditable search lineage when an unknown debt-like row blocks debt", async () => {
    const deps = dependencies({
      mutateStatement: (result, statement, requestedPeriod) => {
        if (statement !== "balance_sheet" || requestedPeriod !== "latest") {
          return result;
        }
        const copy = structuredClone(result);
        copy.tables[0].rows.push(["其他特殊借款"]);
        copy.tables[1].rows.push(["10"]);
        copy.pagination.returnedRows += 2;
        copy.pagination.totalRows += 2;
        return copy;
      },
    });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    const result = await client.getValuationModelInputs({ companyCode: "2330" });

    expect(result.fields.interestBearingDebt).toMatchObject({
      status: "data_gap",
      dataGapReason: "UNMAPPED_DEBT_LIKE_ROW",
    });
    expect(result.fields.interestBearingDebt.inputLineageIds).toHaveLength(1);
    expect(
      result.lineage.find(
        (entry) => entry.lineageId === result.fields.interestBearingDebt.inputLineageIds[0],
      ),
    ).toMatchObject({
      role: "unmapped_debt_like_row",
      status: "ambiguous",
      rowLabel: "其他特殊借款",
    });
  });

  it("rejects invalid company codes before any dependency call", async () => {
    const deps = dependencies();
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.valuation,
    );

    await expect(
      client.getValuationModelInputs({ companyCode: "TSMC" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "INVALID_COMPANY_CODE",
    });
    expect(deps.master.listCompanies).not.toHaveBeenCalled();
  });
});
