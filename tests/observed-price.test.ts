import { describe, expect, it, vi } from "vitest";

import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import type {
  CompanyMasterResult,
  CompanyMasterSource,
  MasterCompany,
} from "@/lib/company-master/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import {
  ObservedPriceClient,
  type ObservedPriceCompanyMasterLike,
  type ObservedPriceCompletedCloseLike,
} from "@/lib/observed-price/client";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";
import {
  completedCloseBar,
  completedCloseResolverEvidenceFixture,
} from "@/tests/fixtures/completed-close";

const REQUEST_START = "2026-08-28T07:00:00.000Z";
const NOW = new Date(REQUEST_START);
const now = () => new Date(NOW);

function company(overrides: Partial<MasterCompany> = {}): MasterCompany {
  return {
    code: "2330",
    name: "台灣積體電路製造股份有限公司",
    shortName: "台積電",
    market: "listed",
    exchange: "TWSE",
    industryCode: "24",
    listingDate: "1994-09-05",
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
    ...overrides,
  };
}

function companySource(
  market: "listed" | "otc" = "listed",
): CompanyMasterSource {
  const listed = market === "listed";
  return {
    market,
    exchange: listed ? "TWSE" : "TPEx",
    sourceName: listed
      ? "臺灣證券交易所－上市公司基本資料"
      : "證券櫃檯買賣中心－上櫃公司基本資料",
    sourceUrl: listed
      ? "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
      : "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
    reportDate: "2026-08-27",
    retrievedAt: "2026-08-28T00:30:00.000Z",
    rawCount: 1,
    excludedTdrCount: 0,
    companyCount: 1,
    minimumExpectedCount: 1,
    cache: {
      status: "miss",
      observedAt: "2026-08-28T00:30:00.000Z",
      storedAt: "2026-08-28T00:30:00.000Z",
      ageMs: 0,
      ttlMs: 300_000,
    },
  };
}

function masterResult(
  overrides: Partial<CompanyMasterResult> = {},
): CompanyMasterResult {
  const companies =
    overrides.companies ??
    [
      company(),
      company({
        code: "3105",
        name: "穩懋半導體股份有限公司",
        shortName: "穩懋",
        market: "otc",
        exchange: "TPEx",
      }),
    ];
  return {
    query: { market: "all", includeFinancial: true, includeKy: true },
    generatedAt: "2026-08-28T00:30:00.000Z",
    snapshotId: "all-2026-08-27",
    coverageVerification: {
      status: "heuristic",
      method: "required_sources_schema_single_report_date_minimum_count",
      officialDeclaredRowCountAvailable: false,
    },
    coverageComplete: true,
    sources: [companySource("listed"), companySource("otc")],
    counts: {
      raw: companies.length,
      excludedTdr: 0,
      eligible: companies.length,
      excludedFinancial: 0,
      excludedKy: 0,
      listed: companies.filter((item) => item.market === "listed").length,
      otc: companies.filter((item) => item.market === "otc").length,
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
    ...overrides,
  };
}

function storedCache(at: string): CacheProvenance {
  return {
    status: "miss",
    observedAt: at,
    storedAt: at,
    ageMs: 0,
    ttlMs: 300_000,
  };
}

function authoritativeCompletedCloseFixture(options: {
  identity?: AuthoritativeCompletedCloseResult["company"];
  evaluatedAt?: string;
  expectedAsOf?: string;
  selectedBarDate?: string;
  close?: number;
  sourceRetrievedAt?: string;
  cacheRefreshAttempted?: boolean;
} = {}): AuthoritativeCompletedCloseResult {
  const identity = options.identity ?? {
    code: "2330",
    shortName: "台積電",
    market: "listed",
    exchange: "TWSE",
  };
  const evaluatedAt = options.evaluatedAt ?? REQUEST_START;
  const expectedAsOf = options.expectedAsOf ?? "2026-08-28";
  const selectedBarDate = options.selectedBarDate ?? expectedAsOf;
  const close = options.close ?? 2_420;
  const sourceRetrievedAt =
    options.sourceRetrievedAt ?? "2026-08-28T06:45:00.000Z";
  const cacheRefreshAttempted = options.cacheRefreshAttempted ?? false;
  const resolverEvidence = completedCloseResolverEvidenceFixture({
    evaluatedAt,
    expectedAsOf,
  });
  resolverEvidence.markets = [identity.market];
  resolverEvidence.marketResolutions[0] = {
    ...resolverEvidence.marketResolutions[0],
    market: identity.market,
  };
  const bar: AuthoritativeCompletedCloseResult["bar"] = {
    ...completedCloseBar({
      date: selectedBarDate,
      close,
      market: identity.market,
    }),
    close,
    status: "traded",
  };
  const listed = identity.market === "listed";

  return {
    query: {
      companyCode: identity.code,
      market: identity.market,
      evaluatedAt,
    },
    company: { ...identity },
    expectedAsOf,
    selectedBarDate,
    close,
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    bar,
    source: {
      companyCode: identity.code,
      market: identity.market,
      exchange: identity.exchange,
      sourceName: listed
        ? "臺灣證券交易所－個股日成交資訊"
        : "證券櫃檯買賣中心－個股日成交資訊",
      sourceUrl: listed
        ? `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${expectedAsOf.slice(0, 7).replace("-", "")}01&stockNo=${identity.code}&response=json`
        : `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${identity.code}&date=${expectedAsOf.slice(0, 7).replace("-", "/")}/01&response=json`,
      retrievedAt: sourceRetrievedAt,
      cache: storedCache(sourceRetrievedAt),
      snapshotIdentity: "verified",
      dataMonth: expectedAsOf.slice(0, 7),
      observedName: identity.shortName,
      selectedBarDate,
      normalization: {
        volumeShares: {
          sourceUnit: listed ? "share" : "lot",
          outputUnit: "share",
          multiplier: listed ? 1 : 1000,
        },
        turnoverTwd: {
          sourceUnit: listed ? "TWD" : "TWD_thousand",
          outputUnit: "TWD",
          multiplier: listed ? 1 : 1000,
        },
        tradeCount: {
          sourceUnit: "trade",
          outputUnit: "trade",
          multiplier: 1,
        },
      },
    },
    resolverEvidence,
    cacheRefresh: {
      attempted: cacheRefreshAttempted,
      initialCacheStatus: cacheRefreshAttempted ? "hit" : "miss",
    },
    workBudget: {
      scope: "authoritative_completed_close_routing",
      completedSessionResolver: resolverEvidence.workBudget,
      exactStockOhlcAttempts: {
        actual: cacheRefreshAttempted ? 2 : 1,
        maximum: 2,
        cacheRefreshPerformed: cacheRefreshAttempted,
      },
    },
  };
}

function dependencies(options: {
  master?: CompanyMasterResult;
  completedClose?: AuthoritativeCompletedCloseResult;
} = {}) {
  const companyMaster = {
    listCompanies: vi.fn().mockResolvedValue(options.master ?? masterResult()),
  } satisfies ObservedPriceCompanyMasterLike;
  const completedClose = {
    getLatestCompletedClose: vi.fn(
      async (
        query: Parameters<
          ObservedPriceCompletedCloseLike["getLatestCompletedClose"]
        >[0],
      ) =>
        options.completedClose ??
        authoritativeCompletedCloseFixture({
          identity: query.company,
          evaluatedAt:
            query.evaluatedAt instanceof Date
              ? query.evaluatedAt.toISOString()
              : query.evaluatedAt,
        }),
    ),
  } satisfies ObservedPriceCompletedCloseLike;
  return { companyMaster, completedClose };
}

function input(observedPriceTwd = 2_425) {
  return {
    companyCode: "2330",
    observedPriceTwd,
    observedAt: "2026-08-28T14:32:00+08:00",
    sourceLabel: "caller supplied terminal observation",
  };
}

describe("ObservedPriceClient", () => {
  it("uses resolver expectedAsOf plus exact 2026-08-28 close=2420 with request-start TOCTOU binding", async () => {
    const completedClose = authoritativeCompletedCloseFixture({
      evaluatedAt: REQUEST_START,
      expectedAsOf: "2026-08-28",
      selectedBarDate: "2026-08-28",
      close: 2_420,
    });
    const deps = dependencies({ completedClose });
    const sequencedNow = vi
      .fn()
      .mockReturnValueOnce(new Date(REQUEST_START))
      .mockReturnValueOnce(new Date("2026-08-29T01:00:00.000Z"));
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      sequencedNow,
    );

    const context = await client.analyzeObservedPriceWithContext(input());
    const result = context.data;

    expect(deps.companyMaster.listCompanies).toHaveBeenCalledTimes(1);
    expect(deps.companyMaster.listCompanies).toHaveBeenCalledWith({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledTimes(1);
    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledWith({
      company: {
        code: "2330",
        shortName: "台積電",
        market: "listed",
        exchange: "TWSE",
      },
      evaluatedAt: REQUEST_START,
    });
    expect(context.completedClose).toBe(completedClose);
    expect(context.completedClose).toMatchObject({
      expectedAsOf: "2026-08-28",
      selectedBarDate: "2026-08-28",
      close: 2_420,
      source: {
        dataMonth: "2026-08",
        selectedBarDate: "2026-08-28",
      },
    });
    expect(result).toMatchObject({
      generatedAt: "2026-08-29T01:00:00.000Z",
      priceOrigin: "caller_supplied",
      officialBaselineOrigin: "official_latest_completed_close",
      observedPriceTwd: 2_425,
      observedAt: "2026-08-28T14:32:00+08:00",
      observedTaipeiDate: "2026-08-28",
      latestOfficialCompletedClose: 2_420,
      latestOfficialCloseDate: "2026-08-28",
      officialHistoryCutoff: "2026-08-28",
      changeFromOfficialCloseTwd: 5,
      changeFromOfficialClosePercent: 0.206612,
      market: "listed",
      exchange: "TWSE",
      currency: "TWD",
      timezone: "Asia/Taipei",
      officialPriceBasis: "raw_unadjusted",
      provenance: {
        observedPrice: {
          evidenceClass: "CALLER_SUPPLIED",
          official: false,
          independentlyVerified: false,
        },
        officialBaseline: {
          evidenceClass: "OFFICIAL_MARKET_RAW",
          dataDate: "2026-08-28",
          sourceIds: ["official_close:listed:2026-08-28"],
        },
        comparison: { evidenceClass: "MOPSFIN_CALC" },
      },
      workBudget: {
        requestedCompanies: 1,
        dependencyInvocations: {
          orchestrationCompanyMaster: 1,
          authoritativeCompletedSessionResolver: 1,
          officialExactSingleStockOhlc: 1,
          maximumIncludingNestedDependencies: 3,
        },
        plannedOfficialSourceRequests: {
          orchestrationCompanyMasterMarkets: 2,
          completedSessionResolver: { actual: 2, maximum: 2 },
          exactSingleStockOhlc: {
            actual: 1,
            maximum: 2,
            cacheRefreshPerformed: false,
          },
          actualTotal: 5,
          maximumTotal: 6,
        },
        priceRoutingPolicy:
          "authoritative_completed_session_expected_as_of_then_exact_single_stock_ohlc",
        selectedCompanyIdentityPolicy:
          "outer_market_all_master_plus_exact_single_stock_source",
      },
    });
    expect(sequencedNow).toHaveBeenCalledTimes(2);
    expect(
      deps.completedClose.getLatestCompletedClose.mock.invocationCallOrder[0],
    ).toBeLessThan(sequencedNow.mock.invocationCallOrder[1]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        stage: "company_master",
        market: "listed",
      }),
      expect.objectContaining({
        stage: "company_master",
        market: "otc",
      }),
      expect.objectContaining({
        stage: "latest_official_completed_close",
        market: "listed",
        dataMonth: "2026-08",
        selectedBarDate: "2026-08-28",
        retrievedAt: "2026-08-28T06:45:00.000Z",
      }),
    ]);
    expect(result.dependencyLedger).toEqual([
      expect.objectContaining({
        dependency: "orchestration_company_master",
        sourceEvidence: "exposed",
        sourceIds: [
          "company_master:listed:2026-08-27",
          "company_master:otc:2026-08-27",
        ],
      }),
      expect.objectContaining({
        dependency: "authoritative_completed_session_resolver",
        sourceEvidence: "exposed_in_meta_resolver_evidence",
        sourceIds: [],
      }),
      expect.objectContaining({
        dependency: "official_exact_single_stock_ohlc",
        sourceIds: ["official_close:listed:2026-08-28"],
      }),
    ]);
    expect(result.sources.map((source) => source.retrievedAt)).not.toContain(
      result.generatedAt,
    );
    expect(result.warnings.join(" ")).toContain("不是官方報價");
    expect(result.warnings.join(" ")).toContain("不代表 fair value");
    expect(result.warnings.join(" ")).toContain("expectedAsOf");
    expect(result.warnings.join(" ")).toContain(
      "不使用可能落後的全市場 latest endpoint",
    );
  });

  it("supports an OTC company while retaining both outer current-master sources", async () => {
    const otc = {
      code: "3105",
      shortName: "穩懋",
      market: "otc",
      exchange: "TPEx",
    } as const;
    const deps = dependencies({
      completedClose: authoritativeCompletedCloseFixture({ identity: otc }),
    });
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    const result = await client.analyzeObservedPrice({
      ...input(),
      companyCode: "3105",
    });

    expect(deps.completedClose.getLatestCompletedClose).toHaveBeenCalledWith({
      company: otc,
      evaluatedAt: REQUEST_START,
    });
    expect(result).toMatchObject({
      company: { code: "3105", market: "otc", exchange: "TPEx" },
      market: "otc",
      exchange: "TPEx",
      sources: [
        { stage: "company_master", market: "listed" },
        { stage: "company_master", market: "otc" },
        {
          stage: "latest_official_completed_close",
          market: "otc",
          exchange: "TPEx",
          observedName: "穩懋",
          selectedBarDate: "2026-08-28",
        },
      ],
      provenance: {
        currentMasterIdentity: {
          coverageMarkets: ["listed", "otc"],
          companyMarket: "otc",
        },
        officialBaseline: {
          sourceIds: ["official_close:otc:2026-08-28"],
        },
      },
    });
  });

  it.each([
    {
      label: "negative",
      observedPriceTwd: 2_410,
      expectedAbsolute: -10,
      expectedPercent: -0.413223,
    },
    {
      label: "zero",
      observedPriceTwd: 2_420,
      expectedAbsolute: 0,
      expectedPercent: 0,
    },
  ])(
    "preserves the $label comparison sign",
    async ({ observedPriceTwd, expectedAbsolute, expectedPercent }) => {
      const deps = dependencies();
      const client = new ObservedPriceClient(
        deps.companyMaster,
        deps.completedClose,
        now,
      );

      const result = await client.analyzeObservedPrice(input(observedPriceTwd));

      expect(result.changeFromOfficialCloseTwd).toBe(expectedAbsolute);
      expect(result.changeFromOfficialClosePercent).toBe(expectedPercent);
      expect(Object.is(result.changeFromOfficialCloseTwd, -0)).toBe(false);
      expect(Object.is(result.changeFromOfficialClosePercent, -0)).toBe(false);
    },
  );

  it.each([
    {
      label: "company code",
      patch: { companyCode: "233" },
      reason: "INVALID_COMPANY_CODE",
    },
    {
      label: "zero price",
      patch: { observedPriceTwd: 0 },
      reason: "INVALID_OBSERVED_PRICE",
    },
    {
      label: "non-finite price",
      patch: { observedPriceTwd: Number.POSITIVE_INFINITY },
      reason: "INVALID_OBSERVED_PRICE",
    },
    {
      label: "empty source label",
      patch: { sourceLabel: "   " },
      reason: "INVALID_SOURCE_LABEL",
    },
    {
      label: "overlong source label",
      patch: { sourceLabel: "x".repeat(201) },
      reason: "INVALID_SOURCE_LABEL",
    },
  ])("rejects invalid $label before dependency calls", async ({ patch, reason }) => {
    const deps = dependencies();
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    await expect(
      client.analyzeObservedPrice({ ...input(), ...patch }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason,
      category: "input",
      action: "fix_input",
    });
    expect(deps.companyMaster.listCompanies).not.toHaveBeenCalled();
    expect(deps.completedClose.getLatestCompletedClose).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "timestamp without offset",
      observedAt: "2026-08-28T09:32:00",
      reason: "OBSERVED_AT_INVALID",
    },
    {
      label: "invalid calendar date",
      observedAt: "2026-02-30T09:32:00+08:00",
      reason: "OBSERVED_AT_INVALID",
    },
    {
      label: "invalid offset",
      observedAt: "2026-08-28T09:32:00+15:00",
      reason: "OBSERVED_AT_INVALID_OFFSET",
    },
    {
      label: "RFC 3339 unknown local offset",
      observedAt: "2026-08-28T09:32:00-00:00",
      reason: "OBSERVED_AT_UNKNOWN_OFFSET",
    },
    {
      label: "future timestamp",
      observedAt: "2026-08-28T15:01:00+08:00",
      reason: "OBSERVED_AT_IN_FUTURE",
    },
    {
      label: "unsupported historical year",
      observedAt: "1899-08-28T09:32:00+08:00",
      reason: "OBSERVED_AT_YEAR_UNSUPPORTED",
    },
  ])("rejects $label", async ({ observedAt, reason }) => {
    const deps = dependencies();
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    await expect(
      client.analyzeObservedPrice({ ...input(), observedAt }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason,
    });
    expect(deps.companyMaster.listCompanies).not.toHaveBeenCalled();
    expect(deps.completedClose.getLatestCompletedClose).not.toHaveBeenCalled();
  });

  it("rejects an observation whose Taipei date predates resolver expectedAsOf", async () => {
    const deps = dependencies();
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    await expect(
      client.analyzeObservedPrice({
        ...input(),
        observedAt: "2026-08-27T23:59:59+08:00",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "OBSERVATION_PREDATES_OFFICIAL_CLOSE",
      details: {
        observedTaipeiDate: "2026-08-27",
        latestOfficialCloseDate: "2026-08-28",
      },
    });
  });

  it("rejects a 09:32 same-day observation and accepts the exact 13:33 Taipei boundary", async () => {
    const deps = dependencies();
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    await expect(
      client.analyzeObservedPrice({
        ...input(),
        observedAt: "2026-08-28T09:32:00+08:00",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "OBSERVATION_PRECEDES_OFFICIAL_SESSION_COMPLETION",
      details: {
        observedTaipeiDate: "2026-08-28",
        latestOfficialCloseDate: "2026-08-28",
        conservativeSessionCompletionTaipei: "2026-08-28T13:33:00+08:00",
      },
    });

    const accepted = await client.analyzeObservedPrice({
      ...input(),
      // The local date is Aug 27, but this instant is exactly Aug 28 13:33 Taipei.
      observedAt: "2026-08-27T21:33:00-08:00",
    });
    expect(accepted.observedTaipeiDate).toBe("2026-08-28");
    expect(accepted.latestOfficialCloseDate).toBe("2026-08-28");
    expect(accepted.warnings.join(" ")).toContain("13:33 Asia/Taipei");
  });

  it("rejects caller values whose derived comparison would overflow", async () => {
    const deps = dependencies({
      completedClose: authoritativeCompletedCloseFixture({
        close: Number.MIN_VALUE,
      }),
    });
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    await expect(
      client.analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "OBSERVED_PRICE_COMPARISON_OVERFLOW",
      category: "input",
      action: "fix_input",
    });
  });

  it("fails closed when the company is absent or ambiguous in current master", async () => {
    const missingMaster = masterResult();
    missingMaster.companies[0] = company({
      code: "2317",
      name: "鴻海精密工業股份有限公司",
      shortName: "鴻海",
    });
    const missingDeps = dependencies({ master: missingMaster });
    await expect(
      new ObservedPriceClient(
        missingDeps.companyMaster,
        missingDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reason: "COMPANY_NOT_IN_CURRENT_MASTER",
    });
    expect(
      missingDeps.completedClose.getLatestCompletedClose,
    ).not.toHaveBeenCalled();

    const duplicateMaster = masterResult();
    duplicateMaster.companies[1] = company();
    duplicateMaster.counts.listed = 2;
    duplicateMaster.counts.otc = 0;
    const duplicateDeps = dependencies({ master: duplicateMaster });
    await expect(
      new ObservedPriceClient(
        duplicateDeps.companyMaster,
        duplicateDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_IDENTITY_CONTRACT_MISMATCH",
    });
    expect(
      duplicateDeps.completedClose.getLatestCompletedClose,
    ).not.toHaveBeenCalled();
  });

  it("propagates exact completed-close dependency failures without a bulk fallback", async () => {
    const companyMaster = {
      listCompanies: vi.fn().mockResolvedValue(masterResult()),
    } satisfies ObservedPriceCompanyMasterLike;
    const failure = new MopsfinError("NO_DATA", "8/28 exact bar 尚未發布。", {
      reason: "COMPLETED_CLOSE_EXACT_BAR_NOT_FOUND",
      category: "no_data",
      retryable: true,
      action: "retry",
    });
    const bulkFallback = vi.fn();
    const completedClose = {
      getLatestCompletedClose: vi.fn().mockRejectedValue(failure),
      getDailyMarketOhlc: bulkFallback,
    };
    const client = new ObservedPriceClient(companyMaster, completedClose, now);

    await expect(client.analyzeObservedPrice(input())).rejects.toBe(failure);
    expect(companyMaster.listCompanies).toHaveBeenCalledTimes(1);
    expect(completedClose.getLatestCompletedClose).toHaveBeenCalledTimes(1);
    expect(bulkFallback).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "query evaluatedAt mismatch",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.query.evaluatedAt = "2026-08-28T06:59:59.999Z";
      },
      reason: "OFFICIAL_PRICE_QUERY_IDENTITY_MISMATCH",
    },
    {
      label: "company short name mismatch",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.company.shortName = "錯誤公司";
      },
      reason: "OFFICIAL_PRICE_QUERY_IDENTITY_MISMATCH",
    },
    {
      label: "source observed name mismatch",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.source.observedName = "錯誤公司";
      },
      reason: "OFFICIAL_PRICE_CONTRACT_MISMATCH",
    },
    {
      label: "source market mismatch",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.source.market = "otc";
      },
      reason: "OFFICIAL_PRICE_CONTRACT_MISMATCH",
    },
  ])("rejects completed-close $label", async ({ mutate, reason }) => {
    const completedClose = authoritativeCompletedCloseFixture();
    mutate(completedClose);
    const deps = dependencies({ completedClose });

    await expect(
      new ObservedPriceClient(
        deps.companyMaster,
        deps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason,
    });
  });

  it.each([
    {
      label: "top-level selectedBarDate",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.selectedBarDate = "2026-08-27";
      },
    },
    {
      label: "bar date",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.bar.date = "2026-08-27";
      },
    },
    {
      label: "source selectedBarDate",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.source.selectedBarDate = "2026-08-27";
      },
    },
    {
      label: "source dataMonth",
      mutate: (result: AuthoritativeCompletedCloseResult) => {
        result.source.dataMonth = "2026-07";
      },
    },
  ])("rejects a $label not bound to expectedAsOf", async ({ mutate }) => {
    const completedClose = authoritativeCompletedCloseFixture();
    mutate(completedClose);
    const deps = dependencies({ completedClose });

    await expect(
      new ObservedPriceClient(
        deps.companyMaster,
        deps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_DATE_MISMATCH",
      details: { expectedAsOf: "2026-08-28" },
    });
  });

  it("rejects resolver evidence that is not the same completed-session decision", async () => {
    const completedClose = authoritativeCompletedCloseFixture();
    completedClose.resolverEvidence.evaluatedAt =
      "2026-08-28T06:59:59.999Z";
    const deps = dependencies({ completedClose });

    await expect(
      new ObservedPriceClient(
        deps.companyMaster,
        deps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "COMPLETED_SESSION_EVIDENCE_MISMATCH",
    });
  });

  it("rejects an unavailable or contradictory completed close", async () => {
    const unavailable = authoritativeCompletedCloseFixture({ close: 0 });
    const unavailableDeps = dependencies({ completedClose: unavailable });
    await expect(
      new ObservedPriceClient(
        unavailableDeps.companyMaster,
        unavailableDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "NO_DATA",
      reason: "OFFICIAL_COMPLETED_CLOSE_UNAVAILABLE",
    });

    const contradictory = authoritativeCompletedCloseFixture();
    contradictory.close = 2_410;
    const contradictoryDeps = dependencies({ completedClose: contradictory });
    await expect(
      new ObservedPriceClient(
        contradictoryDeps.companyMaster,
        contradictoryDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "NO_DATA",
      reason: "OFFICIAL_COMPLETED_CLOSE_UNAVAILABLE",
    });
  });

  it("requires exact outer-master sources and source-level close provenance", async () => {
    const noMasterSource = dependencies({
      master: masterResult({ sources: [] }),
    });
    await expect(
      new ObservedPriceClient(
        noMasterSource.companyMaster,
        noMasterSource.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
    });

    const missingOtcMaster = masterResult();
    missingOtcMaster.sources = [missingOtcMaster.sources[0]];
    const missingOtcDeps = dependencies({ master: missingOtcMaster });
    await expect(
      new ObservedPriceClient(
        missingOtcDeps.companyMaster,
        missingOtcDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
    });

    const extraMaster = masterResult();
    extraMaster.sources = [...extraMaster.sources, companySource("listed")];
    const extraMasterDeps = dependencies({ master: extraMaster });
    await expect(
      new ObservedPriceClient(
        extraMasterDeps.companyMaster,
        extraMasterDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
    });

    const noCloseCache = authoritativeCompletedCloseFixture();
    delete noCloseCache.source.cache;
    const noCloseCacheDeps = dependencies({ completedClose: noCloseCache });
    await expect(
      new ObservedPriceClient(
        noCloseCacheDeps.companyMaster,
        noCloseCacheDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_SOURCE_CACHE_MISSING",
    });
  });

  it("validates master reportDate and source retrieval timestamps", async () => {
    const invalidReportMaster = masterResult();
    invalidReportMaster.sources[0] = {
      ...invalidReportMaster.sources[0],
      reportDate: "2026-02-30",
    };
    const invalidReportDeps = dependencies({ master: invalidReportMaster });
    await expect(
      new ObservedPriceClient(
        invalidReportDeps.companyMaster,
        invalidReportDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_REPORT_DATE_INVALID",
    });

    const invalidRetrievedMaster = masterResult();
    invalidRetrievedMaster.sources[0] = {
      ...invalidRetrievedMaster.sources[0],
      retrievedAt: "2026-08-28 08:30:00",
    };
    const invalidRetrievedDeps = dependencies({ master: invalidRetrievedMaster });
    await expect(
      new ObservedPriceClient(
        invalidRetrievedDeps.companyMaster,
        invalidRetrievedDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_SOURCE_RETRIEVED_AT_INVALID",
    });

    const inconsistentMasterTime = masterResult();
    inconsistentMasterTime.sources[0] = {
      ...inconsistentMasterTime.sources[0],
      reportDate: "2026-08-28",
      retrievedAt: "2026-08-27T15:59:59.000Z",
      cache: storedCache("2026-08-27T15:59:59.000Z"),
    };
    inconsistentMasterTime.sources[1] = {
      ...inconsistentMasterTime.sources[1],
      reportDate: "2026-08-28",
    };
    const inconsistentMasterTimeDeps = dependencies({
      master: inconsistentMasterTime,
    });
    await expect(
      new ObservedPriceClient(
        inconsistentMasterTimeDeps.companyMaster,
        inconsistentMasterTimeDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_SOURCE_TIME_INCONSISTENT",
    });
  });

  it.each([
    {
      label: "invalid retrievedAt",
      sourceRetrievedAt: "not-an-iso-time",
      reason: "OFFICIAL_PRICE_SOURCE_RETRIEVED_AT_INVALID",
    },
    {
      label: "future retrievedAt",
      sourceRetrievedAt: "2026-08-28T07:00:00.001Z",
      reason: "OFFICIAL_PRICE_SOURCE_RETRIEVED_AT_IN_FUTURE",
    },
    {
      label: "retrieval before data date",
      sourceRetrievedAt: "2026-08-27T15:59:59.000Z",
      reason: "OFFICIAL_PRICE_SOURCE_TIME_INCONSISTENT",
    },
    {
      label: "same-day retrieval before 13:33",
      sourceRetrievedAt: "2026-08-28T05:32:59.000Z",
      reason: "OFFICIAL_PRICE_SOURCE_PRECEDES_SESSION_COMPLETION",
    },
  ])("rejects official source $label", async ({ sourceRetrievedAt, reason }) => {
    const completedClose = authoritativeCompletedCloseFixture({
      sourceRetrievedAt,
    });
    const deps = dependencies({ completedClose });

    await expect(
      new ObservedPriceClient(
        deps.companyMaster,
        deps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({ reason });
  });

  it("fails closed on contradictory or future close cache provenance", async () => {
    const cases: Array<{
      label: string;
      mutate: (result: AuthoritativeCompletedCloseResult) => void;
      reason: string;
    }> = [
      {
        label: "retrieval after storage",
        mutate: (result) => {
          result.source.cache = {
            status: "hit",
            observedAt: "2026-08-28T06:45:00.000Z",
            storedAt: "2026-08-28T06:44:00.000Z",
            ageMs: 60_000,
            ttlMs: 300_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_INCONSISTENT",
      },
      {
        label: "bypass with stored value",
        mutate: (result) => {
          result.source.cache = {
            status: "bypass",
            observedAt: "2026-08-28T06:45:00.000Z",
            storedAt: "2026-08-28T06:45:00.000Z",
            ageMs: 0,
            ttlMs: 0,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_CONTRACT_MISMATCH",
      },
      {
        label: "storage after observation",
        mutate: (result) => {
          result.source.cache = {
            status: "hit",
            observedAt: "2026-08-28T06:45:00.000Z",
            storedAt: "2026-08-28T06:46:00.000Z",
            ageMs: 0,
            ttlMs: 300_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_INCONSISTENT",
      },
      {
        label: "wrong age",
        mutate: (result) => {
          result.source.cache = {
            status: "hit",
            observedAt: "2026-08-28T06:46:00.000Z",
            storedAt: "2026-08-28T06:45:00.000Z",
            ageMs: 59_999,
            ttlMs: 300_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_INCONSISTENT",
      },
      {
        label: "observation after generation",
        mutate: (result) => {
          result.source.cache = {
            status: "hit",
            observedAt: "2026-08-28T07:00:00.001Z",
            storedAt: "2026-08-28T06:45:00.000Z",
            ageMs: 900_001,
            ttlMs: 3_600_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_IN_FUTURE",
      },
    ];

    for (const entry of cases) {
      const completedClose = authoritativeCompletedCloseFixture();
      entry.mutate(completedClose);
      const deps = dependencies({ completedClose });
      await expect(
        new ObservedPriceClient(
          deps.companyMaster,
          deps.completedClose,
          now,
        ).analyzeObservedPrice(input()),
        entry.label,
      ).rejects.toMatchObject({ reason: entry.reason });
    }

    const master = masterResult();
    master.sources[0].retrievedAt = "2026-08-28T00:29:59.000Z";
    master.sources[0].cache = {
      status: "hit",
      observedAt: "2026-08-28T00:30:00.000Z",
      storedAt: "2026-08-28T00:29:59.000Z",
      ageMs: 999,
      ttlMs: 300_000,
    };
    const masterDeps = dependencies({ master });
    await expect(
      new ObservedPriceClient(
        masterDeps.companyMaster,
        masterDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "CURRENT_MASTER_SOURCE_CACHE_TIME_INCONSISTENT",
    });
  });

  it("validates exact snapshot identity, bar quality, and work-budget evidence", async () => {
    const unverified = authoritativeCompletedCloseFixture();
    (
      unverified.source as unknown as { snapshotIdentity: string }
    ).snapshotIdentity = "unverified_empty";
    const unverifiedDeps = dependencies({ completedClose: unverified });
    await expect(
      new ObservedPriceClient(
        unverifiedDeps.companyMaster,
        unverifiedDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_CONTRACT_MISMATCH",
    });

    const inconsistentQuality = authoritativeCompletedCloseFixture();
    inconsistentQuality.bar.missingFields = ["change"];
    const qualityDeps = dependencies({ completedClose: inconsistentQuality });
    await expect(
      new ObservedPriceClient(
        qualityDeps.companyMaster,
        qualityDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_QUALITY_MISMATCH",
    });

    const inconsistentBudget = authoritativeCompletedCloseFixture();
    inconsistentBudget.workBudget.exactStockOhlcAttempts.actual = 2;
    const budgetDeps = dependencies({ completedClose: inconsistentBudget });
    await expect(
      new ObservedPriceClient(
        budgetDeps.companyMaster,
        budgetDeps.completedClose,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_WORK_BUDGET_MISMATCH",
    });
  });

  it("accepts internally consistent partial non-close quality and bounded cache refresh", async () => {
    const partial = authoritativeCompletedCloseFixture({
      cacheRefreshAttempted: true,
    });
    partial.bar.change = null;
    partial.bar.qualityStatus = "partial";
    partial.bar.missingFields = ["change"];
    const deps = dependencies({ completedClose: partial });
    const result = await new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    ).analyzeObservedPrice(input());

    expect(result.latestOfficialCompletedClose).toBe(2_420);
    expect(
      result.workBudget.plannedOfficialSourceRequests.exactSingleStockOhlc,
    ).toEqual({
      actual: 2,
      maximum: 2,
      cacheRefreshPerformed: true,
    });
    expect(result.warnings.join(" ")).toContain("非收盤價欄位缺失");
    expect(result.warnings.join(" ")).toContain("有界失效重取");
  });

  it("returns structured MopsfinError instances", async () => {
    const deps = dependencies({ master: masterResult({ companies: [] }) });
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.completedClose,
      now,
    );

    await expect(client.analyzeObservedPrice(input())).rejects.toBeInstanceOf(
      MopsfinError,
    );
  });
});
