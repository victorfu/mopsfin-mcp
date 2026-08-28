import { describe, expect, it, vi } from "vitest";

import type {
  CompanyMasterResult,
  CompanyMasterSource,
  MasterCompany,
} from "@/lib/company-master/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import {
  ObservedPriceClient,
  type ObservedPriceCompanyMasterLike,
  type ObservedPriceOfficialPriceLike,
} from "@/lib/observed-price/client";
import type {
  DailyMarketOhlcResult,
  PriceSource,
} from "@/lib/price/types";

const NOW = new Date("2026-08-28T02:00:00.000Z");
const now = () => new Date(NOW);

function company(
  overrides: Partial<MasterCompany> = {},
): MasterCompany {
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
      financialReportTypeCode: { reported: 0, missing: companies.length, invalid: 0 },
    },
    companies,
    warnings: [],
    ...overrides,
  };
}

function priceSource(): PriceSource {
  return {
    market: "listed",
    sourceName: "臺灣證券交易所－上市個股日成交資訊",
    sourceUrl: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    retrievedAt: "2026-08-28T01:30:00.000Z",
    snapshotIdentity: "verified",
    dataDate: "2026-08-27",
    cache: {
      status: "hit",
      observedAt: "2026-08-28T01:30:00.000Z",
      storedAt: "2026-08-28T01:30:00.000Z",
      ageMs: 0,
      ttlMs: 300_000,
    },
    normalization: {
      volumeShares: {
        sourceUnit: "share",
        outputUnit: "share",
        multiplier: 1,
      },
      turnoverTwd: {
        sourceUnit: "TWD",
        outputUnit: "TWD",
        multiplier: 1,
      },
      tradeCount: {
        sourceUnit: "trade",
        outputUnit: "trade",
        multiplier: 1,
      },
    },
  };
}

function otcPriceSource(): PriceSource {
  return {
    ...priceSource(),
    market: "otc",
    sourceName: "證券櫃檯買賣中心－上櫃股票日成交資訊",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
    normalization: {
      volumeShares: {
        sourceUnit: "lot",
        outputUnit: "share",
        multiplier: 1000,
      },
      turnoverTwd: {
        sourceUnit: "TWD_thousand",
        outputUnit: "TWD",
        multiplier: 1000,
      },
      tradeCount: {
        sourceUnit: "trade",
        outputUnit: "trade",
        multiplier: 1,
      },
    },
  };
}

function officialResult(
  overrides: Partial<DailyMarketOhlcResult> = {},
): DailyMarketOhlcResult {
  return {
    query: {
      market: "listed",
      date: "latest",
      companyCodes: ["2330"],
      universePolicy: "compatible",
    },
    dataDate: "2026-08-27",
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    classificationMethod: "current_master",
    classificationPolicy: "current_master_with_code_fallback",
    coverageComplete: true,
    universeCoverageVerified: false,
    dataQualityComplete: true,
    reconciliation: [
      {
        market: "listed",
        masterCount: 1_000,
        sourceRowCount: 999,
        matchedCount: 999,
        marketOnlyCodes: [],
        masterMissingCodes: ["9999"],
        matchRatio: 0.999,
        coverageComplete: false,
      },
    ],
    selectionComplete: true,
    missingCompanyCodes: [],
    counts: { listed: 1, otc: 0, returned: 1 },
    bars: [
      {
        code: "2330",
        name: "台積電",
        date: "2026-08-27",
        open: 33.1,
        high: 33.5,
        low: 33,
        close: 33.2,
        volumeShares: 1_000_000,
        turnoverTwd: 33_200_000,
        tradeCount: 1_000,
        change: 0.1,
        changeMarker: null,
        market: "listed",
        status: "traded",
        qualityStatus: "complete",
        missingFields: [],
      },
    ],
    sources: [priceSource()],
    warnings: [],
    ...overrides,
  };
}

function otcOfficialResult(): DailyMarketOhlcResult {
  const result = officialResult();
  result.query = {
    market: "otc",
    date: "latest",
    companyCodes: ["3105"],
    universePolicy: "compatible",
  };
  result.reconciliation = [
    {
      ...result.reconciliation[0],
      market: "otc",
    },
  ];
  result.counts = { listed: 0, otc: 1, returned: 1 };
  result.bars = [
    {
      ...result.bars[0],
      code: "3105",
      name: "穩懋",
      market: "otc",
    },
  ];
  result.sources = [otcPriceSource()];
  return result;
}

function dependencies(options: {
  master?: CompanyMasterResult;
  official?: DailyMarketOhlcResult;
} = {}) {
  const companyMaster = {
    listCompanies: vi.fn().mockResolvedValue(options.master ?? masterResult()),
  } satisfies ObservedPriceCompanyMasterLike;
  const officialPrice = {
    getDailyMarketOhlc: vi
      .fn()
      .mockResolvedValue(options.official ?? officialResult()),
  } satisfies ObservedPriceOfficialPriceLike;
  return { companyMaster, officialPrice };
}

function input(observedPriceTwd = 33.35) {
  return {
    companyCode: "2330",
    observedPriceTwd,
    observedAt: "2026-08-28T09:32:00+08:00",
    sourceLabel: "caller supplied terminal observation",
  };
}

describe("ObservedPriceClient", () => {
  it("accepts production-like unrelated compatible differences while keeping selected identity exact", async () => {
    const master = masterResult();
    master.generatedAt = "2026-08-28T02:00:03.000Z";
    master.sources = master.sources.map((source, index) => ({
      ...source,
      retrievedAt: `2026-08-28T02:00:0${index + 1}.000Z`,
      cache: {
        status: "miss",
        observedAt: `2026-08-28T02:00:0${index + 1}.000Z`,
        storedAt: `2026-08-28T02:00:0${index + 1}.000Z`,
        ageMs: 0,
        ttlMs: 300_000,
      },
    }));
    const official = officialResult();
    official.sources[0] = {
      ...official.sources[0],
      retrievedAt: "2026-08-28T02:00:04.000Z",
      cache: {
        status: "miss",
        observedAt: "2026-08-28T02:00:04.000Z",
        storedAt: "2026-08-28T02:00:04.000Z",
        ageMs: 0,
        ttlMs: 300_000,
      },
    };
    const deps = dependencies({ master, official });
    const sequencedNow = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-08-28T02:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-28T02:00:05.000Z"));
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      sequencedNow,
    );

    const result = await client.analyzeObservedPrice(input());

    expect(deps.companyMaster.listCompanies).toHaveBeenCalledWith({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    expect(deps.officialPrice.getDailyMarketOhlc).toHaveBeenCalledWith({
      market: "listed",
      date: "latest",
      companyCodes: ["2330"],
      universePolicy: "compatible",
    });
    expect(result).toMatchObject({
      generatedAt: "2026-08-28T02:00:05.000Z",
      priceOrigin: "caller_supplied",
      officialBaselineOrigin: "official_latest_completed_close",
      observedPriceTwd: 33.35,
      observedAt: "2026-08-28T09:32:00+08:00",
      observedTaipeiDate: "2026-08-28",
      latestOfficialCompletedClose: 33.2,
      latestOfficialCloseDate: "2026-08-27",
      officialHistoryCutoff: "2026-08-27",
      changeFromOfficialCloseTwd: 0.15,
      changeFromOfficialClosePercent: 0.451807,
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
          sourceIds: ["official_close:listed:2026-08-27"],
        },
        comparison: { evidenceClass: "MOPSFIN_CALC" },
      },
      workBudget: {
        requestedCompanies: 1,
        dependencyInvocations: {
          orchestrationCompanyMaster: 1,
          officialDailyMarketPrice: 1,
          officialDailyMarketInternalCompatibleMaster: 1,
          maximumIncludingNestedDependencies: 3,
        },
        plannedOfficialSourceRequests: {
          orchestrationCompanyMasterMarkets: 2,
          officialDailyMarketSnapshot: 1,
          officialDailyMarketInternalCompatibleMasterMarkets: 1,
          maximumTotal: 4,
        },
        universePolicy: "compatible",
        selectedCompanyIdentityPolicy:
          "outer_market_all_master_plus_official_row_exact",
      },
    });
    expect(sequencedNow).toHaveBeenCalledTimes(2);
    expect(
      deps.officialPrice.getDailyMarketOhlc.mock.invocationCallOrder[0],
    ).toBeLessThan(sequencedNow.mock.invocationCallOrder[1]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        stage: "company_master",
        retrievedAt: "2026-08-28T02:00:01.000Z",
      }),
      expect.objectContaining({
        stage: "company_master",
        retrievedAt: "2026-08-28T02:00:02.000Z",
      }),
      expect.objectContaining({
        stage: "latest_official_completed_close",
        retrievedAt: "2026-08-28T02:00:04.000Z",
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
        dependency: "official_daily_market_price",
        sourceIds: ["official_close:listed:2026-08-27"],
      }),
      expect.objectContaining({
        dependency: "official_daily_market_internal_compatible_master",
        sourceEvidence: "not_exposed_by_dependency",
        sourceIds: [],
      }),
    ]);
    expect(result.sources.map((source) => source.retrievedAt)).not.toContain(
      result.generatedAt,
    );
    expect(result.warnings.join(" ")).toContain("不是官方報價");
    expect(result.warnings.join(" ")).toContain("不代表 fair value");
    expect(result.warnings.join(" ")).toContain("compatible");
    expect(result.warnings.join(" ")).toContain("至少 95%");
    expect(result.warnings.join(" ")).toContain("code、name、market 精確核對");
  });

  it("supports an OTC company while retaining both outer current-master sources", async () => {
    const deps = dependencies({ official: otcOfficialResult() });
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      now,
    );

    const result = await client.analyzeObservedPrice({
      ...input(),
      companyCode: "3105",
    });

    expect(deps.officialPrice.getDailyMarketOhlc).toHaveBeenCalledWith({
      market: "otc",
      date: "latest",
      companyCodes: ["3105"],
      universePolicy: "compatible",
    });
    expect(result).toMatchObject({
      company: { code: "3105", market: "otc", exchange: "TPEx" },
      market: "otc",
      exchange: "TPEx",
      sources: [
        { stage: "company_master", market: "listed" },
        { stage: "company_master", market: "otc" },
        { stage: "latest_official_completed_close", market: "otc" },
      ],
      provenance: {
        currentMasterIdentity: {
          coverageMarkets: ["listed", "otc"],
          companyMarket: "otc",
        },
        officialBaseline: {
          sourceIds: ["official_close:otc:2026-08-27"],
        },
      },
    });
  });

  it.each([
    {
      label: "negative",
      observedPriceTwd: 33,
      expectedAbsolute: -0.2,
      expectedPercent: -0.60241,
    },
    {
      label: "zero",
      observedPriceTwd: 33.2,
      expectedAbsolute: 0,
      expectedPercent: 0,
    },
  ])(
    "preserves the $label comparison sign",
    async ({ observedPriceTwd, expectedAbsolute, expectedPercent }) => {
      const deps = dependencies();
      const client = new ObservedPriceClient(
        deps.companyMaster,
        deps.officialPrice,
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
      deps.officialPrice,
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
    expect(deps.officialPrice.getDailyMarketOhlc).not.toHaveBeenCalled();
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
      observedAt: "2026-08-28T10:01:00+08:00",
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
      deps.officialPrice,
      now,
    );

    await expect(
      client.analyzeObservedPrice({ ...input(), observedAt }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason,
    });
    expect(deps.companyMaster.listCompanies).not.toHaveBeenCalled();
    expect(deps.officialPrice.getDailyMarketOhlc).not.toHaveBeenCalled();
  });

  it("rejects an observation whose Taipei date predates the official close", async () => {
    const deps = dependencies();
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      now,
    );

    await expect(
      client.analyzeObservedPrice({
        ...input(),
        observedAt: "2026-08-26T23:59:59+08:00",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "OBSERVATION_PREDATES_OFFICIAL_CLOSE",
      details: {
        observedTaipeiDate: "2026-08-26",
        latestOfficialCloseDate: "2026-08-27",
      },
    });
  });

  it("uses the Taipei instant and a conservative 13:33 guard for same-day completed close", async () => {
    const sameDay = officialResult({
      dataDate: "2026-08-28",
      bars: [
        {
          ...officialResult().bars[0],
          date: "2026-08-28",
        },
      ],
      sources: [
        {
          ...priceSource(),
          dataDate: "2026-08-28",
          retrievedAt: "2026-08-28T05:45:00.000Z",
          cache: {
            status: "miss",
            observedAt: "2026-08-28T05:45:00.000Z",
            storedAt: "2026-08-28T05:45:00.000Z",
            ageMs: 0,
            ttlMs: 300_000,
          },
        },
      ],
    });
    const deps = dependencies({ official: sameDay });
    const afterCloseNow = () => new Date("2026-08-28T06:00:00.000Z");
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      afterCloseNow,
    );

    await expect(
      client.analyzeObservedPrice({
        ...input(),
        // 05:32:59Z is 13:32:59 in Asia/Taipei.
        observedAt: "2026-08-28T05:32:59Z",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      reason: "OBSERVATION_PRECEDES_OFFICIAL_SESSION_COMPLETION",
      details: {
        observedTaipeiDate: "2026-08-28",
        conservativeSessionCompletionTaipei:
          "2026-08-28T13:33:00+08:00",
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
    const deps = dependencies();
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      now,
    );

    await expect(
      client.analyzeObservedPrice(input(Number.MAX_VALUE)),
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
    const missingDeps = dependencies({
      master: missingMaster,
    });
    await expect(
      new ObservedPriceClient(
        missingDeps.companyMaster,
        missingDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      reason: "COMPANY_NOT_IN_CURRENT_MASTER",
    });
    expect(missingDeps.officialPrice.getDailyMarketOhlc).not.toHaveBeenCalled();

    const duplicateMaster = masterResult();
    duplicateMaster.companies[1] = company();
    duplicateMaster.counts.listed = 2;
    duplicateMaster.counts.otc = 0;
    const duplicateDeps = dependencies({ master: duplicateMaster });
    await expect(
      new ObservedPriceClient(
        duplicateDeps.companyMaster,
        duplicateDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_IDENTITY_CONTRACT_MISMATCH",
    });
    expect(duplicateDeps.officialPrice.getDailyMarketOhlc).not.toHaveBeenCalled();
  });

  it("rejects a missing official selection and an official identity mismatch", async () => {
    const missingDeps = dependencies({
      official: officialResult({
        selectionComplete: false,
        missingCompanyCodes: ["2330"],
        counts: { listed: 0, otc: 0, returned: 0 },
        bars: [],
      }),
    });
    await expect(
      new ObservedPriceClient(
        missingDeps.companyMaster,
        missingDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "NO_DATA",
      reason: "OFFICIAL_COMPLETED_CLOSE_NOT_FOUND",
    });

    const mismatch = officialResult();
    mismatch.bars[0] = { ...mismatch.bars[0], name: "錯誤公司" };
    const mismatchDeps = dependencies({ official: mismatch });
    await expect(
      new ObservedPriceClient(
        mismatchDeps.companyMaster,
        mismatchDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_IDENTITY_MISMATCH",
    });

    const duplicate = officialResult();
    duplicate.bars = [duplicate.bars[0], { ...duplicate.bars[0] }];
    duplicate.counts = { listed: 2, otc: 0, returned: 2 };
    const duplicateDeps = dependencies({ official: duplicate });
    await expect(
      new ObservedPriceClient(
        duplicateDeps.companyMaster,
        duplicateDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_IDENTITY_AMBIGUOUS",
    });
  });

  it("rejects compatible coverage below 95% and an unavailable close", async () => {
    const incomplete = officialResult();
    incomplete.universeCoverageVerified = false;
    incomplete.reconciliation[0] = {
      ...incomplete.reconciliation[0],
      masterCount: 100,
      sourceRowCount: 94,
      matchedCount: 94,
      masterMissingCodes: ["1001", "1002", "1003", "1004", "1005", "9999"],
      matchRatio: 0.94,
      coverageComplete: false,
    };
    const coverageDeps = dependencies({ official: incomplete });
    await expect(
      new ObservedPriceClient(
        coverageDeps.companyMaster,
        coverageDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "INCOMPLETE_COVERAGE",
      reason: "OFFICIAL_PRICE_COVERAGE_INCOMPLETE",
    });

    const noTrade = officialResult();
    noTrade.bars[0] = {
      ...noTrade.bars[0],
      close: null,
      status: "no_trade",
      qualityStatus: "official_no_trade",
      missingFields: ["close"],
    };
    const noTradeDeps = dependencies({ official: noTrade });
    await expect(
      new ObservedPriceClient(
        noTradeDeps.companyMaster,
        noTradeDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "NO_DATA",
      reason: "OFFICIAL_COMPLETED_CLOSE_UNAVAILABLE",
    });
  });

  it("accepts the exact compatible 95% boundary when the selected row is exact", async () => {
    const threshold = officialResult();
    threshold.reconciliation[0] = {
      market: "listed",
      masterCount: 20,
      sourceRowCount: 19,
      matchedCount: 19,
      marketOnlyCodes: [],
      masterMissingCodes: ["9999"],
      matchRatio: 0.95,
      coverageComplete: false,
    };
    const deps = dependencies({ official: threshold });

    const result = await new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      now,
    ).analyzeObservedPrice(input());

    expect(result.company.code).toBe("2330");
    expect(result.latestOfficialCompletedClose).toBe(33.2);
  });

  it("fails closed on malformed compatible reconciliation evidence", async () => {
    const cases: Array<{
      label: string;
      mutate: (result: DailyMarketOhlcResult) => void;
    }> = [
      {
        label: "ratio is not recomputable",
        mutate: (result) => {
          result.reconciliation[0].matchRatio = 0.998;
        },
      },
      {
        label: "difference set is not sorted",
        mutate: (result) => {
          result.reconciliation[0] = {
            ...result.reconciliation[0],
            masterCount: 1_000,
            sourceRowCount: 998,
            matchedCount: 998,
            masterMissingCodes: ["9999", "1001"],
            matchRatio: 0.998,
          };
        },
      },
      {
        label: "difference set contains duplicates",
        mutate: (result) => {
          result.reconciliation[0] = {
            ...result.reconciliation[0],
            masterCount: 1_000,
            sourceRowCount: 998,
            matchedCount: 998,
            masterMissingCodes: ["9999", "9999"],
            matchRatio: 0.998,
          };
        },
      },
      {
        label: "selected outer-master company is classified market-only",
        mutate: (result) => {
          result.reconciliation[0] = {
            ...result.reconciliation[0],
            sourceRowCount: 1_000,
            marketOnlyCodes: ["2330"],
          };
        },
      },
      {
        label: "universe verified disagrees with exact coverage",
        mutate: (result) => {
          result.universeCoverageVerified = true;
        },
      },
      {
        label: "coverage flag disagrees with difference sets",
        mutate: (result) => {
          result.reconciliation[0].coverageComplete = true;
        },
      },
    ];

    for (const entry of cases) {
      const official = officialResult();
      entry.mutate(official);
      const deps = dependencies({ official });
      await expect(
        new ObservedPriceClient(
          deps.companyMaster,
          deps.officialPrice,
          now,
        ).analyzeObservedPrice(input()),
        entry.label,
      ).rejects.toMatchObject({
        code: "UPSTREAM_BAD_RESPONSE",
        reason: "OFFICIAL_PRICE_RECONCILIATION_MISMATCH",
      });
    }
  });

  it("requires source-level retrievedAt provenance instead of synthesizing it at serve time", async () => {
    const noMasterSource = dependencies({
      master: masterResult({ sources: [] }),
    });
    await expect(
      new ObservedPriceClient(
        noMasterSource.companyMaster,
        noMasterSource.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
    });

    const noPriceSource = dependencies({
      official: officialResult({ sources: [] }),
    });
    await expect(
      new ObservedPriceClient(
        noPriceSource.companyMaster,
        noPriceSource.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_SOURCE_SET_MISMATCH",
    });
  });

  it("requires the exact outer-master and official-price source sets", async () => {
    const missingOtcMaster = masterResult();
    missingOtcMaster.sources = [missingOtcMaster.sources[0]];
    const missingOtcDeps = dependencies({ master: missingOtcMaster });
    await expect(
      new ObservedPriceClient(
        missingOtcDeps.companyMaster,
        missingOtcDeps.officialPrice,
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
        extraMasterDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
    });

    const extraPrice = officialResult();
    extraPrice.sources = [priceSource(), otcPriceSource()];
    const extraPriceDeps = dependencies({ official: extraPrice });
    await expect(
      new ObservedPriceClient(
        extraPriceDeps.companyMaster,
        extraPriceDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_SOURCE_SET_MISMATCH",
    });

    const mismatchedPrice = officialResult();
    mismatchedPrice.sources = [otcPriceSource()];
    const mismatchedPriceDeps = dependencies({ official: mismatchedPrice });
    await expect(
      new ObservedPriceClient(
        mismatchedPriceDeps.companyMaster,
        mismatchedPriceDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_SOURCE_SET_MISMATCH",
    });
  });

  it("validates master reportDate and all returned source retrieval timestamps", async () => {
    const invalidReportMaster = masterResult();
    invalidReportMaster.sources[0] = {
      ...invalidReportMaster.sources[0],
      reportDate: "2026-02-30",
    };
    const invalidReportDeps = dependencies({ master: invalidReportMaster });
    await expect(
      new ObservedPriceClient(
        invalidReportDeps.companyMaster,
        invalidReportDeps.officialPrice,
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
    const invalidRetrievedDeps = dependencies({
      master: invalidRetrievedMaster,
    });
    await expect(
      new ObservedPriceClient(
        invalidRetrievedDeps.companyMaster,
        invalidRetrievedDeps.officialPrice,
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
        inconsistentMasterTimeDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "CURRENT_MASTER_SOURCE_TIME_INCONSISTENT",
    });

    const invalidPriceRetrieved = officialResult();
    invalidPriceRetrieved.sources[0] = {
      ...invalidPriceRetrieved.sources[0],
      retrievedAt: "not-an-iso-time",
    };
    const invalidPriceRetrievedDeps = dependencies({
      official: invalidPriceRetrieved,
    });
    await expect(
      new ObservedPriceClient(
        invalidPriceRetrievedDeps.companyMaster,
        invalidPriceRetrievedDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_SOURCE_RETRIEVED_AT_INVALID",
    });

    const futurePrice = officialResult();
    futurePrice.sources[0] = {
      ...futurePrice.sources[0],
      retrievedAt: "2026-08-28T02:00:00.001Z",
    };
    const futurePriceDeps = dependencies({ official: futurePrice });
    await expect(
      new ObservedPriceClient(
        futurePriceDeps.companyMaster,
        futurePriceDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      code: "UPSTREAM_BAD_RESPONSE",
      reason: "OFFICIAL_PRICE_SOURCE_RETRIEVED_AT_IN_FUTURE",
    });
  });

  it("fails closed on missing, contradictory, or future cache provenance", async () => {
    const cases: Array<{
      label: string;
      mutate: (source: PriceSource) => void;
      reason: string;
    }> = [
      {
        label: "missing cache",
        mutate: (source) => {
          delete source.cache;
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_MISSING",
      },
      {
        label: "retrieval after storage",
        mutate: (source) => {
          source.cache = {
            status: "hit",
            observedAt: "2026-08-28T01:30:00.000Z",
            storedAt: "2026-08-28T01:29:00.000Z",
            ageMs: 60_000,
            ttlMs: 300_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_INCONSISTENT",
      },
      {
        label: "storage after observation",
        mutate: (source) => {
          source.cache = {
            status: "hit",
            observedAt: "2026-08-28T01:30:00.000Z",
            storedAt: "2026-08-28T01:31:00.000Z",
            ageMs: 0,
            ttlMs: 300_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_INCONSISTENT",
      },
      {
        label: "wrong age",
        mutate: (source) => {
          source.cache = {
            status: "hit",
            observedAt: "2026-08-28T01:30:01.000Z",
            storedAt: "2026-08-28T01:30:00.000Z",
            ageMs: 999,
            ttlMs: 300_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_INCONSISTENT",
      },
      {
        label: "bypass with stored value",
        mutate: (source) => {
          source.cache = {
            status: "bypass",
            observedAt: "2026-08-28T01:30:00.000Z",
            storedAt: "2026-08-28T01:30:00.000Z",
            ageMs: 0,
            ttlMs: 0,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_CONTRACT_MISMATCH",
      },
      {
        label: "observation after generation",
        mutate: (source) => {
          source.cache = {
            status: "hit",
            observedAt: "2026-08-28T02:00:00.001Z",
            storedAt: "2026-08-28T01:30:00.000Z",
            ageMs: 1_800_001,
            ttlMs: 3_600_000,
          };
        },
        reason: "OFFICIAL_PRICE_SOURCE_CACHE_TIME_IN_FUTURE",
      },
    ];

    for (const entry of cases) {
      const official = officialResult();
      entry.mutate(official.sources[0]);
      const deps = dependencies({ official });
      await expect(
        new ObservedPriceClient(
          deps.companyMaster,
          deps.officialPrice,
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
        masterDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "CURRENT_MASTER_SOURCE_CACHE_TIME_INCONSISTENT",
    });
  });

  it("validates compatible classification, reconciliation arithmetic, counts, and quality contracts", async () => {
    const classification = officialResult({
      classificationPolicy: "current_master_strict",
    });
    const classificationDeps = dependencies({ official: classification });
    await expect(
      new ObservedPriceClient(
        classificationDeps.companyMaster,
        classificationDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_CLASSIFICATION_MISMATCH",
    });

    const inconsistentReconciliation = officialResult();
    inconsistentReconciliation.reconciliation[0] = {
      ...inconsistentReconciliation.reconciliation[0],
      matchedCount: 998,
    };
    const reconciliationDeps = dependencies({
      official: inconsistentReconciliation,
    });
    await expect(
      new ObservedPriceClient(
        reconciliationDeps.companyMaster,
        reconciliationDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_RECONCILIATION_MISMATCH",
    });

    const inconsistentCounts = officialResult({
      counts: { listed: 0, otc: 0, returned: 1 },
    });
    const countsDeps = dependencies({ official: inconsistentCounts });
    await expect(
      new ObservedPriceClient(
        countsDeps.companyMaster,
        countsDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_COUNTS_MISMATCH",
    });

    const inconsistentMissingFields = officialResult();
    inconsistentMissingFields.bars[0] = {
      ...inconsistentMissingFields.bars[0],
      missingFields: ["change"],
    };
    const missingFieldsDeps = dependencies({
      official: inconsistentMissingFields,
    });
    await expect(
      new ObservedPriceClient(
        missingFieldsDeps.companyMaster,
        missingFieldsDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_QUALITY_MISMATCH",
    });

    const inconsistentTopQuality = officialResult({
      dataQualityComplete: false,
    });
    const topQualityDeps = dependencies({ official: inconsistentTopQuality });
    await expect(
      new ObservedPriceClient(
        topQualityDeps.companyMaster,
        topQualityDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_QUALITY_MISMATCH",
    });
  });

  it("requires a verified official snapshot whose dataDate is not after retrieval", async () => {
    const unverified = officialResult();
    unverified.sources[0] = {
      ...unverified.sources[0],
      snapshotIdentity: "unverified_empty",
    };
    const unverifiedDeps = dependencies({ official: unverified });
    await expect(
      new ObservedPriceClient(
        unverifiedDeps.companyMaster,
        unverifiedDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_SOURCE_IDENTITY_UNVERIFIED",
    });

    const retrievedBeforeData = officialResult();
    retrievedBeforeData.sources[0] = {
      ...retrievedBeforeData.sources[0],
      retrievedAt: "2026-08-26T15:59:59.000Z",
    };
    const retrievedBeforeDataDeps = dependencies({
      official: retrievedBeforeData,
    });
    await expect(
      new ObservedPriceClient(
        retrievedBeforeDataDeps.companyMaster,
        retrievedBeforeDataDeps.officialPrice,
        now,
      ).analyzeObservedPrice(input()),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_SOURCE_TIME_INCONSISTENT",
    });

    const preCloseSameDay = officialResult({
      dataDate: "2026-08-28",
      bars: [
        {
          ...officialResult().bars[0],
          date: "2026-08-28",
        },
      ],
      sources: [
        {
          ...priceSource(),
          dataDate: "2026-08-28",
          retrievedAt: "2026-08-28T05:32:59.000Z",
          cache: {
            status: "miss",
            observedAt: "2026-08-28T05:32:59.000Z",
            storedAt: "2026-08-28T05:32:59.000Z",
            ageMs: 0,
            ttlMs: 300_000,
          },
        },
      ],
    });
    const preCloseDeps = dependencies({ official: preCloseSameDay });
    const afterCloseNow = () => new Date("2026-08-28T06:00:00.000Z");
    await expect(
      new ObservedPriceClient(
        preCloseDeps.companyMaster,
        preCloseDeps.officialPrice,
        afterCloseNow,
      ).analyzeObservedPrice({
        ...input(),
        observedAt: "2026-08-28T05:40:00Z",
      }),
    ).rejects.toMatchObject({
      reason: "OFFICIAL_PRICE_SOURCE_PRECEDES_SESSION_COMPLETION",
    });
  });

  it("accepts internally consistent partial non-close quality with an explicit warning", async () => {
    const partial = officialResult({ dataQualityComplete: false });
    partial.bars[0] = {
      ...partial.bars[0],
      change: null,
      qualityStatus: "partial",
      missingFields: ["change"],
    };
    const deps = dependencies({ official: partial });
    const result = await new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      now,
    ).analyzeObservedPrice(input());

    expect(result.latestOfficialCompletedClose).toBe(33.2);
    expect(result.warnings.join(" ")).toContain("非收盤價欄位缺失");
  });

  it("returns structured MopsfinError instances", async () => {
    const deps = dependencies({ master: masterResult({ companies: [] }) });
    const client = new ObservedPriceClient(
      deps.companyMaster,
      deps.officialPrice,
      now,
    );

    await expect(client.analyzeObservedPrice(input())).rejects.toBeInstanceOf(
      MopsfinError,
    );
  });
});
