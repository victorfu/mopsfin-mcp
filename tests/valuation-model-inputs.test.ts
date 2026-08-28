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
import { valuationModelInputsDataSchema } from "@/lib/mcp/schema/valuation-model";
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

function masterResult(company: MasterCompany): CompanyMasterResult {
  return {
    query: { market: "all", includeFinancial: true, includeKy: true },
    generatedAt: "2026-08-28T01:00:00.000Z",
    snapshotId: "listed-2026-08-28",
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
        sourceName: "TWSE company master fixture",
        sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
        reportDate: "2026-08-28",
        retrievedAt: "2026-08-28T01:00:00.000Z",
        rawCount: 1,
        excludedTdrCount: 0,
        companyCount: 1,
        minimumExpectedCount: 1,
      },
    ],
    counts: {
      raw: 1,
      excludedTdr: 0,
      eligible: 1,
      excludedFinancial: 0,
      excludedKy: 0,
      listed: company.market === "listed" ? 1 : 0,
      otc: company.market === "otc" ? 1 : 0,
      returned: 1,
    },
    profileCoverage: {
      incorporationDate: { reported: 1, missing: 0, invalid: 0 },
      paidInCapitalTwd: { reported: 1, missing: 0, invalid: 0 },
      issuedCommonShares: { reported: 1, missing: 0, invalid: 0 },
      parValueText: { reported: 1, missing: 0, invalid: 0 },
      financialReportTypeCode: { reported: 1, missing: 0, invalid: 0 },
    },
    companies: [company],
    warnings: [],
  };
}

function statementResult(
  company: MasterCompany,
  statement: StatementKind,
  period: string,
  fixture: StatementFixture,
): FinancialStatementResultLike {
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
    reportNames: [`${company.code} ${company.shortName} (上市半導體業)`],
    tables: [
      {
        title: "會計科目",
        headers: [["報表類別"], ["會計科目"]],
        rows: fixture.labels.map((label) => [label]),
      },
      {
        title: "公司數值",
        headers: [["合併"], [`${company.code} ${company.shortName}(上市半導體業)`]],
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
  return {
    query: {
      market: company.market,
      date: "latest",
      companyCodes: [company.code],
      universePolicy: "strict_current_master",
    },
    dataDate: fixture.dataDate,
    currency: "TWD",
    classificationPolicy: "current_master_strict",
    coverageComplete: true,
    universeCoverageVerified: true,
    selectionComplete: true,
    missingCompanyCodes: [],
    reconciliation: [],
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
        sourceName: "TWSE latest valuation discovery fixture",
        sourceUrl: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
        retrievedAt: "2026-08-28T01:02:59.000Z",
        dataDate: fixture.dataDate,
        rawCount: 1,
        eligibleRowCount: 1,
      },
      {
        market: company.market,
        exchange: company.exchange,
        sourceName: "TWSE exact-day valuation fixture",
        sourceUrl: "https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d",
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
        internalCurrentMasterPolicy: "strict_current_master",
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
      universePolicy: "strict_current_master",
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
  });

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
