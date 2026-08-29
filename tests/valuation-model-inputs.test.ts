import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import type { StatementKind } from "@/lib/mopsfin/client";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { buildResultMeta } from "@/lib/mcp/result-contract";
import {
  valuationModelInputsDataSchema,
  valuationModelInputsOutputSchema,
} from "@/lib/mcp/schema/valuation-model";
import { ValuationModelInputsClient } from "@/lib/valuation-model/client";
import type { FinancialStatementResultLike } from "@/lib/valuation-model/statement-resolver";
import { completedSessionEvidenceFixture } from "@/tests/fixtures/completed-session";

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

function completedCloseResult(
  company: MasterCompany,
  fixture: FixtureShape["latestValuation"],
  evaluatedAt = "2026-08-28T07:05:00.000Z",
): AuthoritativeCompletedCloseResult {
  const dataDate = fixture.dataDate;
  const resolverEvidence = completedSessionEvidenceFixture({
    market: company.market,
    expectedAsOf: dataDate,
  });
  resolverEvidence.evaluatedAt = evaluatedAt;
  const normalization = {
    volumeShares: {
      sourceUnit: "share" as const,
      outputUnit: "share" as const,
      multiplier: 1 as const,
    },
    turnoverTwd: {
      sourceUnit: "TWD" as const,
      outputUnit: "TWD" as const,
      multiplier: 1 as const,
    },
    tradeCount: {
      sourceUnit: "trade" as const,
      outputUnit: "trade" as const,
      multiplier: 1 as const,
    },
  };
  const sourceUrl = company.market === "listed"
    ? `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${dataDate.slice(0, 7).replace("-", "")}01&stockNo=${company.code}&response=json`
    : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${company.code}&date=${dataDate.slice(0, 7).replace("-", "/")}%2F01&response=json`;
  const bar = {
    date: dataDate,
    open: fixture.closePriceTwd,
    high: fixture.closePriceTwd,
    low: fixture.closePriceTwd,
    close: fixture.closePriceTwd,
    volumeShares: 1_000,
    turnoverTwd: fixture.closePriceTwd * 1_000,
    tradeCount: 10,
    change: 0,
    changeMarker: null,
    market: company.market,
    status: "traded" as const,
    qualityStatus: "complete" as const,
    missingFields: [],
  };
  return {
    query: {
      companyCode: company.code,
      market: company.market,
      evaluatedAt,
    },
    company: {
      code: company.code,
      shortName: company.shortName,
      market: company.market,
      exchange: company.exchange,
    },
    expectedAsOf: dataDate,
    selectedBarDate: dataDate,
    close: fixture.closePriceTwd,
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    bar,
    source: {
      companyCode: company.code,
      market: company.market,
      exchange: company.exchange,
      sourceName: `${company.exchange} exact single-stock OHLC fixture`,
      sourceUrl,
      retrievedAt: "2026-08-28T07:00:00.000Z",
      cache: {
        status: "miss",
        observedAt: "2026-08-28T07:00:00.000Z",
        storedAt: "2026-08-28T07:00:00.000Z",
        ageMs: 0,
        ttlMs: 300_000,
      },
      snapshotIdentity: "verified",
      dataMonth: dataDate.slice(0, 7),
      normalization,
      observedName: company.shortName,
      selectedBarDate: dataDate,
    },
    resolverEvidence,
    cacheRefresh: { attempted: false, initialCacheStatus: "miss" },
    workBudget: {
      scope: "authoritative_completed_close_routing",
      completedSessionResolver: resolverEvidence.workBudget,
      exactStockOhlcAttempts: {
        actual: 1,
        maximum: 2,
        cacheRefreshPerformed: false,
      },
    },
  };
}

function dependencies(options: {
  fixture?: FixtureShape;
  mutateStatement?: (
    result: FinancialStatementResultLike,
    statement: StatementKind,
    requestedPeriod: string,
  ) => FinancialStatementResultLike;
  completedCloseFailure?: boolean;
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
  const completedClose = {
    getLatestCompletedClose: options.completedCloseFailure
      ? vi.fn(async () => {
          throw new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            "fixture completed close temporarily unavailable",
            {
              reason: "COMPLETED_SESSION_UNRESOLVED",
              category: "upstream",
              retryable: true,
              action: "retry",
            },
          );
        })
      : vi.fn(async (query: { evaluatedAt: string }) =>
          completedCloseResult(
            fixture.company,
            fixture.latestValuation,
            query.evaluatedAt,
          )),
    getDailyMarketValuation: vi.fn(async () => {
      throw new Error("bulk valuation sentinel must not be called");
    }),
  };
  return { fixture, master, mopsfin, completedClose };
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
      deps.completedClose,
      () => new Date("2026-08-28T07:05:00.000Z"),
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
    expect(new Set(result.fields.netDebt.inputLineageIds)).toEqual(
      new Set([
        ...result.fields.interestBearingDebt.inputLineageIds,
        ...result.fields.cashAndCashEquivalents.inputLineageIds,
      ]),
    );
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
    expect(result.fields.enterpriseValue.inputLineageIds).toEqual(
      expect.arrayContaining(result.fields.netDebt.inputLineageIds),
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
      authoritativeCompletedCloseCalls: {
        actual: 1,
        maximum: 1,
        completedSessionResolver: {
          actualLogicalLoads: 2,
          maximumLogicalLoads: 2,
        },
        exactStockOhlcAttempts: {
          actual: 1,
          maximum: 2,
          cacheRefreshPerformed: false,
        },
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
      "latest_official_completed_close",
    ]);
    expect(
      result.lineage.find(
        (entry) => entry.role === "latest_completed_official_close",
      )?.sourceId,
    ).toBe("latest_official_completed_close:listed:2026-08-27");
    expect(deps.mopsfin.getFinancialStatement).toHaveBeenCalledTimes(7);
    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledTimes(1);
    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledWith({
      company: {
        code: "2330",
        shortName: "台積電",
        market: "listed",
        exchange: "TWSE",
      },
      evaluatedAt: "2026-08-28T07:05:00.000Z",
    });
    expect(
      deps.completedClose.getDailyMarketValuation,
    ).not.toHaveBeenCalled();
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
    const wrongCompletedCloseUrl = structuredClone(advertisedOutput);
    const completedCloseSource = wrongCompletedCloseUrl.sources.find(
      (source) => source.stage === "latest_official_completed_close",
    );
    if (!completedCloseSource) {
      throw new Error("fixture completed-close source missing");
    }
    completedCloseSource.sourceUrl = completedCloseSource.sourceUrl.replace(
      "stockNo=2330",
      "stockNo=2454",
    );
    expect(
      valuationModelInputsOutputSchema.safeParse(wrongCompletedCloseUrl).success,
    ).toBe(false);
  });

  it("routes 2026-08-28 latest completed close to exact single-stock OHLC 2420 and never bulk valuation", async () => {
    const fixture = readFixture();
    fixture.latestValuation = {
      dataDate: "2026-08-28",
      closePriceTwd: 2_420,
      rawClosePrice: "2,420.00",
    };
    const deps = dependencies({ fixture });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.completedClose,
      () => new Date("2026-08-28T07:05:00.000Z"),
    );

    const execution = await client.getValuationModelInputsWithContext({
      companyCode: "2330",
    });
    const { data: result, completedClose } = execution;

    expect(
      deps.completedClose.getDailyMarketValuation,
    ).not.toHaveBeenCalled();
    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledTimes(1);
    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledWith({
      company: {
        code: "2330",
        shortName: "台積電",
        market: "listed",
        exchange: "TWSE",
      },
      evaluatedAt: "2026-08-28T07:05:00.000Z",
    });
    expect(completedClose).not.toBeNull();
    expect(completedClose).toMatchObject({
      expectedAsOf: "2026-08-28",
      selectedBarDate: "2026-08-28",
      close: 2_420,
    });
    expect(result.fields.latestOfficialClose).toMatchObject({
      status: "reported",
      value: 2_420,
      evidenceClass: "OFFICIAL_MARKET_RAW",
    });
    expect(result.fields.marketCapitalization.value).toBe(
      25_932_071_458 * 2_420,
    );
    expect(latestCloseLineage(result)).toMatchObject({
      status: "resolved",
      period: "2026-08-28",
      sourceId: "latest_official_completed_close:listed:2026-08-28",
    });
    expect(
      result.sources.find(
        (source) => source.stage === "latest_official_completed_close",
      ),
    ).toMatchObject({
      dataMonth: "2026-08",
      selectedBarDate: "2026-08-28",
      asOf: "2026-08-28",
    });
    expect(result.workBudget.authoritativeCompletedCloseCalls).toEqual({
      actual: 1,
      maximum: 1,
      completedSessionResolver: {
        actualLogicalLoads: 2,
        maximumLogicalLoads: 2,
      },
      exactStockOhlcAttempts: {
        actual: 1,
        maximum: 2,
        cacheRefreshPerformed: false,
      },
    });
    expect(valuationModelInputsDataSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    [
      "resolver expected date",
      (value: AuthoritativeCompletedCloseResult) => {
        value.resolverEvidence.expectedAsOf = "2026-08-26";
      },
    ],
    [
      "selected bar date",
      (value: AuthoritativeCompletedCloseResult) => {
        value.selectedBarDate = "2026-08-26";
      },
    ],
    [
      "official observed name",
      (value: AuthoritativeCompletedCloseResult) => {
        value.source.observedName = "另一家公司";
      },
    ],
    [
      "close value",
      (value: AuthoritativeCompletedCloseResult) => {
        value.close = 2_419;
      },
    ],
    [
      "pre-completion source retrieval",
      (value: AuthoritativeCompletedCloseResult) => {
        value.source.retrievedAt = "2026-08-27T05:32:59.000Z";
      },
    ],
  ] as const)(
    "fails close/market-cap/EV closed when authoritative context has mismatched %s",
    async (_label, mutate) => {
      const deps = dependencies();
      const mismatched = completedCloseResult(
        deps.fixture.company,
        deps.fixture.latestValuation,
      );
      mutate(mismatched);
      deps.completedClose.getLatestCompletedClose.mockResolvedValue(mismatched);
      const client = new ValuationModelInputsClient(
        deps.mopsfin,
        deps.master,
        deps.completedClose,
        () => new Date("2026-08-28T07:05:00.000Z"),
      );

      const execution = await client.getValuationModelInputsWithContext({
        companyCode: "2330",
      });

      expect(execution.completedClose).toBeNull();
      expect(execution.data.fields.latestOfficialClose.status).toBe("data_gap");
      expect(execution.data.fields.marketCapitalization.status).toBe("data_gap");
      expect(execution.data.fields.enterpriseValue.status).toBe("data_gap");
      expect(latestCloseLineage(execution.data)?.status).toBe("missing");
      expect(execution.data.warnings.join(" ")).toContain(
        "未回退全市場 latest",
      );
    },
  );

  it("keeps statement evidence when authoritative completed close fails", async () => {
    const deps = dependencies({ completedCloseFailure: true });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.completedClose,
      () => new Date("2026-08-28T07:05:00.000Z"),
    );

    const execution = await client.getValuationModelInputsWithContext({
      companyCode: "2330",
    });
    const result = execution.data;

    expect(execution.completedClose).toBeNull();
    expect(execution.completedCloseError).toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_SESSION_UNRESOLVED",
      retryable: true,
      action: "retry",
    });
    expect(result.fields.ttmRevenue.value).toBe(4_436_000);
    expect(result.fields.normalizedFcff.status).toBe("derived");
    expect(result.fields.latestOfficialClose.status).toBe("data_gap");
    expect(result.fields.marketCapitalization.status).toBe("data_gap");
    expect(result.fields.enterpriseValue.status).toBe("data_gap");
    expect(result.workBudget.authoritativeCompletedCloseCalls).toMatchObject({
      actual: 1,
      completedSessionResolver: { actualLogicalLoads: null },
      exactStockOhlcAttempts: {
        actual: null,
        cacheRefreshPerformed: null,
      },
    });
    expect(result.sources.some(
      (source) => source.stage === "latest_official_completed_close",
    )).toBe(false);
  });

  it("accepts an OTC exact single-stock completed close with truthful monthly source", async () => {
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
      deps.completedClose,
      () => new Date("2026-08-28T07:05:00.000Z"),
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
    });
    expect(result.sources.find(
      (source) => source.stage === "latest_official_completed_close",
    )).toMatchObject({
      market: "otc",
      exchange: "TPEx",
      observedName: "環球晶",
      dataMonth: "2026-08",
      selectedBarDate: "2026-08-27",
    });
  });

  it("keeps completed-session evaluatedAt fixed to request start when the clock crosses later", async () => {
    const deps = dependencies();
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-08-28T05:32:59.000Z"))
      .mockReturnValueOnce(new Date("2026-08-28T05:33:01.000Z"));
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.completedClose,
      now,
    );

    const execution = await client.getValuationModelInputsWithContext({
      companyCode: "2330",
    });

    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluatedAt: "2026-08-28T05:32:59.000Z",
      }),
    );
    expect(execution.completedClose?.query.evaluatedAt).toBe(
      "2026-08-28T05:32:59.000Z",
    );
    expect(now).toHaveBeenCalledTimes(2);
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
      deps.completedClose,
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
      deps.completedClose,
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

  it("preserves financial inputs when authoritative completed close fails", async () => {
    const deps = dependencies({ completedCloseFailure: true });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.completedClose,
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
    expect(result.warnings.join(" ")).toContain(
      "authoritative completed-close dependency",
    );
  });

  it("returns NOT_APPLICABLE for financial companies without calling statements or completed close", async () => {
    const fixture = readFixture();
    fixture.company.isFinancial = true;
    fixture.company.industryCode = "17";
    const deps = dependencies({ fixture });
    const client = new ValuationModelInputsClient(
      deps.mopsfin,
      deps.master,
      deps.completedClose,
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
    expect(deps.completedClose.getLatestCompletedClose).not.toHaveBeenCalled();
    expect(result.workBudget.statementCalls.actual).toBe(0);
    expect(result.workBudget.authoritativeCompletedCloseCalls.actual).toBe(0);
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
      deps.completedClose,
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
      deps.completedClose,
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
