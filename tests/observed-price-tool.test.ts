import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthoritativeCompletedCloseResult } from "@/lib/completed-close/types";
import { analyzeObservedPriceOutputSchema } from "@/lib/mcp/schema/observed-price";
import { observedPriceMetaContract } from "@/lib/mcp/observed-price-meta-contract";
import { analyzeObservedPriceTool } from "@/lib/mcp/tools/observed-price";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { observedPriceClient } from "@/lib/observed-price/client";
import type {
  ObservedPriceAnalysisContext,
  ObservedPriceAnalysisResult,
} from "@/lib/observed-price/types";
import {
  COMPLETED_CLOSE_COMPANY,
  completedCloseBar,
  completedCloseResolverEvidenceFixture,
  exactCurrentCompanyOhlcFixture,
} from "@/tests/fixtures/completed-close";

const EVALUATED_AT = "2026-08-28T07:00:00.000Z";
const GENERATED_AT = "2026-08-28T07:04:00.000Z";
const SERVED_AT = "2026-08-28T07:05:00.000Z";
const OBSERVED_AT = "2026-08-28T14:32:00+08:00";
const OBSERVED_PRICE = 2_425;
const COMPLETED_CLOSE = 2_420;

function completedCloseFixture(): AuthoritativeCompletedCloseResult {
  const bar = {
    ...completedCloseBar({ close: COMPLETED_CLOSE }),
    close: COMPLETED_CLOSE,
    status: "traded" as const,
  };
  const exact = exactCurrentCompanyOhlcFixture({ bars: [bar] });
  const resolverEvidence = completedCloseResolverEvidenceFixture({
    evaluatedAt: EVALUATED_AT,
    expectedAsOf: bar.date,
  });
  return {
    query: {
      companyCode: COMPLETED_CLOSE_COMPANY.code,
      market: COMPLETED_CLOSE_COMPANY.market,
      evaluatedAt: EVALUATED_AT,
    },
    company: COMPLETED_CLOSE_COMPANY,
    expectedAsOf: bar.date,
    selectedBarDate: bar.date,
    close: bar.close,
    currency: "TWD",
    timezone: "Asia/Taipei",
    interval: "1d",
    priceBasis: "raw_unadjusted",
    bar,
    source: {
      ...exact.source,
      companyCode: COMPLETED_CLOSE_COMPANY.code,
      retrievedAt: "2026-08-28T06:59:00.000Z",
      exchange: COMPLETED_CLOSE_COMPANY.exchange,
      observedName: COMPLETED_CLOSE_COMPANY.shortName,
      selectedBarDate: bar.date,
    },
    resolverEvidence,
    cacheRefresh: exact.cacheRefresh,
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

function fixture(): ObservedPriceAnalysisContext {
  const completedClose = completedCloseFixture();
  const listedMaster = {
    sourceId: "company_master:listed:2026-08-27",
    stage: "company_master" as const,
    market: "listed" as const,
    exchange: "TWSE" as const,
    sourceName: "臺灣證券交易所－上市公司基本資料",
    sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
    reportDate: "2026-08-27",
    retrievedAt: "2026-08-28T00:30:00.000Z",
    rawCount: 1_001,
    excludedTdrCount: 1,
    companyCount: 1_000,
    minimumExpectedCount: 1_000,
    cache: {
      status: "hit" as const,
      observedAt: "2026-08-28T00:35:00.000Z",
      storedAt: "2026-08-28T00:30:00.000Z",
      ageMs: 300_000,
      ttlMs: 600_000,
    },
  };
  const otcMaster = {
    sourceId: "company_master:otc:2026-08-28",
    stage: "company_master" as const,
    market: "otc" as const,
    exchange: "TPEx" as const,
    sourceName: "證券櫃檯買賣中心－上櫃公司基本資料",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
    reportDate: "2026-08-28",
    retrievedAt: "2026-08-28T00:31:00.000Z",
    rawCount: 801,
    excludedTdrCount: 1,
    companyCount: 800,
    minimumExpectedCount: 800,
    cache: {
      status: "miss" as const,
      observedAt: "2026-08-28T00:31:00.000Z",
      storedAt: "2026-08-28T00:31:00.000Z",
      ageMs: 0,
      ttlMs: 600_000,
    },
  };
  const closeSource = {
    ...completedClose.source,
    sourceId: `official_close:listed:${completedClose.selectedBarDate}`,
    stage: "latest_official_completed_close" as const,
    cache: completedClose.source.cache!,
  };
  const data: ObservedPriceAnalysisResult = {
    query: {
      companyCode: "2330",
      observedPriceTwd: OBSERVED_PRICE,
      observedAt: OBSERVED_AT,
      sourceLabel: "caller supplied terminal observation",
    },
    generatedAt: GENERATED_AT,
    priceOrigin: "caller_supplied",
    officialBaselineOrigin: "official_latest_completed_close",
    company: {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      shortName: "台積電",
      market: "listed",
      exchange: "TWSE",
    },
    observedPriceTwd: OBSERVED_PRICE,
    observedAt: OBSERVED_AT,
    observedTaipeiDate: "2026-08-28",
    sourceLabel: "caller supplied terminal observation",
    latestOfficialCompletedClose: COMPLETED_CLOSE,
    latestOfficialCloseDate: "2026-08-28",
    changeFromOfficialCloseTwd: 5,
    changeFromOfficialClosePercent: 0.206612,
    officialHistoryCutoff: "2026-08-28",
    market: "listed",
    exchange: "TWSE",
    currency: "TWD",
    timezone: "Asia/Taipei",
    officialPriceBasis: "raw_unadjusted",
    sources: [listedMaster, otcMaster, closeSource],
    dependencyLedger: [
      {
        dependency: "orchestration_company_master",
        logicalInvocations: 1,
        plannedOfficialSourceLoads: 2,
        sourceEvidence: "exposed",
        sourceIds: [listedMaster.sourceId, otcMaster.sourceId],
      },
      {
        dependency: "authoritative_completed_session_resolver",
        logicalInvocations: 1,
        plannedOfficialSourceLoads: 2,
        sourceEvidence: "exposed_in_meta_resolver_evidence",
        sourceIds: [],
      },
      {
        dependency: "official_exact_single_stock_ohlc",
        logicalInvocations: 1,
        plannedOfficialSourceLoads: 1,
        sourceEvidence: "exposed",
        sourceIds: [closeSource.sourceId],
      },
    ],
    provenance: {
      observedPrice: {
        evidenceClass: "CALLER_SUPPLIED",
        official: false,
        independentlyVerified: false,
        sourceLabel: "caller supplied terminal observation",
        observedAt: OBSERVED_AT,
      },
      currentMasterIdentity: {
        evidenceClass: "OFFICIAL_MASTER_RAW",
        queryMarket: "all",
        coverageMarkets: ["listed", "otc"],
        companyMarket: "listed",
        sourceIds: [listedMaster.sourceId, otcMaster.sourceId],
      },
      officialBaseline: {
        evidenceClass: "OFFICIAL_MARKET_RAW",
        priceBasis: "raw_unadjusted",
        dataDate: "2026-08-28",
        sourceIds: [closeSource.sourceId],
      },
      comparison: {
        evidenceClass: "MOPSFIN_CALC",
        absoluteDifferenceFormula:
          "observed_price_twd - latest_official_completed_close_twd",
        percentDifferenceFormula:
          "(observed_price_twd / latest_official_completed_close_twd - 1) * 100",
        inputOrigins: ["CALLER_SUPPLIED", "OFFICIAL_MARKET_RAW"],
      },
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
        unitDefinition:
          "one_logical_official_source_load_before_cache_and_bounded_retry",
      },
      priceRoutingPolicy:
        "authoritative_completed_session_expected_as_of_then_exact_single_stock_ohlc",
      selectedCompanyIdentityPolicy:
        "outer_market_all_master_plus_exact_single_stock_source",
    },
    warnings: [
      "observedPriceTwd 完全由 caller 提供，MopsFin 未獨立驗證；它不是官方報價，也不得稱為 real-time 行情。",
      "官方基準只代表最近完成交易日的原始未還原權值收盤價，不是盤中行情或 adjusted close。",
      "若 caller 觀察值與官方 completed close 同一台北日期，採 13:33 Asia/Taipei 作為包含暫緩收盤可能性的保守 regular-session completion guard。",
      "價差只是 caller-supplied 觀察值相對官方完成交易日收盤價的機械比較，不代表 fair value、買賣建議或投資評級。",
      "官方基準先由 authoritative completed-session resolver 固定 expectedAsOf，再查同日 exact single-stock OHLC；不使用可能落後的全市場 latest endpoint，也不退回前一日價格。",
      "指定公司由外層 market=all master 與單股官方來源的 code、name、market 精確核對；exact price dependency 不重複取得 current master。",
      "上市與上櫃 master 各自驗證 schema、coverage、reportDate 與 source provenance；兩市場 reportDate 可不同，不會阻斷跨來源唯一的指定公司 identity。",
    ],
  };
  return { data, completedClose };
}

function staleFixture(): ObservedPriceAnalysisContext {
  const context = fixture();
  const data = structuredClone(context.data);
  const reportDate = "2026-08-20";
  data.sources[0].reportDate = reportDate;
  data.sources[0].sourceId = `company_master:listed:${reportDate}`;
  data.sources[1].reportDate = reportDate;
  data.sources[1].sourceId = `company_master:otc:${reportDate}`;
  data.provenance.currentMasterIdentity.sourceIds = [
    data.sources[0].sourceId,
    data.sources[1].sourceId,
  ];
  data.dependencyLedger[0].sourceIds = [
    data.sources[0].sourceId,
    data.sources[1].sourceId,
  ];
  return { ...context, data };
}

describe("analyze_observed_price public MCP tool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SERVED_AT));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the domain context's resolver evidence in a schema-valid envelope", async () => {
    const context = fixture();
    const analyzeSpy = vi
      .spyOn(observedPriceClient, "analyzeObservedPriceWithContext")
      .mockResolvedValue(context);

    const result = await analyzeObservedPriceTool.handler(
      {
        company_code: "2330",
        observed_price_twd: OBSERVED_PRICE,
        observed_at: OBSERVED_AT,
        source_label: "caller supplied terminal observation",
      },
      {} as Parameters<typeof analyzeObservedPriceTool.handler>[1],
    );
    const envelope = analyzeObservedPriceOutputSchema.parse(
      result.structuredContent,
    );

    expect(analyzeSpy).toHaveBeenCalledTimes(1);
    expect(analyzeSpy).toHaveBeenCalledWith({
      companyCode: "2330",
      observedPriceTwd: OBSERVED_PRICE,
      observedAt: OBSERVED_AT,
      sourceLabel: "caller supplied terminal observation",
    });
    expect(analyzeObservedPriceTool.config.outputSchema).toBe(
      analyzeObservedPriceOutputSchema,
    );
    expect(envelope.meta.asOf).toMatchObject({
      selector: "snapshot",
      resolved: { granularity: "mixed", from: null, through: null },
      servedAt: SERVED_AT,
      snapshotId: observedPriceMetaContract(
        context.data,
        context.completedClose.resolverEvidence,
      ).snapshotId,
    });
    expect(envelope.meta.asOf.sourceCutoffs).toHaveLength(5);
    for (const source of envelope.sources) {
      expect(envelope.meta.asOf.sourceCutoffs).toContainEqual(
        expect.objectContaining({
          sourceUrl: source.sourceUrl,
          retrievedAt: source.retrievedAt,
          cache: source.cache,
        }),
      );
    }
    expect(envelope.meta.quality).toMatchObject({
      status: "partial",
      source: "partial",
      universe: "unverified",
      selection: "complete",
      values: "complete",
      freshness: "within_expected_window",
    });
    const masterFreshness = envelope.meta.quality.freshnessDetails.filter(
      (detail) =>
        detail.policyId === "official.current-snapshot.max-age-7d.v1",
    );
    expect(masterFreshness).toEqual([
      expect.objectContaining({
        observedAsOf: "2026-08-27",
        sourceUrls: [
          "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
        ],
      }),
      expect.objectContaining({
        observedAsOf: "2026-08-28",
        sourceUrls: [
          "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
        ],
      }),
    ]);
    const completedFreshness = envelope.meta.quality.freshnessDetails.find(
      (detail) => detail.policyId === "official.completed-session.v1",
    );
    expect(completedFreshness).toMatchObject({
      status: "within_expected_window",
      observedAsOf: "2026-08-28",
      expectedAsOf: "2026-08-28",
      lag: { value: 0, unit: "trading_session" },
      resolverEvidence: context.completedClose.resolverEvidence,
    });
    expect(envelope.meta.quality.issues.map((issue) => issue.code)).toEqual([
      "CALLER_SUPPLIED_PRICE_UNVERIFIED",
      "OFFICIAL_BASELINE_COMPLETED_SESSION",
      "CONSERVATIVE_SAME_DAY_SESSION_GUARD",
      "MECHANICAL_PRICE_COMPARISON_NOT_FAIR_VALUE",
      "MASTER_ROWSET_HEURISTIC",
    ]);
    expect(Date.parse(envelope.meta.asOf.servedAt)).toBeGreaterThanOrEqual(
      Date.parse(envelope.generatedAt),
    );
    expect(envelope.provenance.observedPrice).toMatchObject({
      evidenceClass: "CALLER_SUPPLIED",
      official: false,
      independentlyVerified: false,
    });
    expect(envelope.sources[2]).toMatchObject({
      companyCode: "2330",
      dataMonth: "2026-08",
      selectedBarDate: "2026-08-28",
      exchange: "TWSE",
      observedName: "台積電",
    });
    expect(envelope.dependencyLedger).toEqual([
      expect.objectContaining({
        dependency: "orchestration_company_master",
        sourceEvidence: "exposed",
      }),
      expect.objectContaining({
        dependency: "authoritative_completed_session_resolver",
        sourceEvidence: "exposed_in_meta_resolver_evidence",
      }),
      expect.objectContaining({
        dependency: "official_exact_single_stock_ohlc",
        sourceEvidence: "exposed",
      }),
    ]);
    expect(envelope.workBudget).toMatchObject({
      dependencyInvocations: {
        authoritativeCompletedSessionResolver: 1,
        officialExactSingleStockOhlc: 1,
        maximumIncludingNestedDependencies: 3,
      },
      plannedOfficialSourceRequests: {
        completedSessionResolver: { actual: 2, maximum: 2 },
        exactSingleStockOhlc: {
          actual: 1,
          maximum: 2,
          cacheRefreshPerformed: false,
        },
        actualTotal: 5,
        maximumTotal: 6,
      },
    });
  });

  it("returns stale master evidence while preserving the same fresh completed-close context", async () => {
    const context = staleFixture();
    vi.spyOn(
      observedPriceClient,
      "analyzeObservedPriceWithContext",
    ).mockResolvedValue(context);

    const result = await analyzeObservedPriceTool.handler(
      {
        company_code: "2330",
        observed_price_twd: OBSERVED_PRICE,
        observed_at: OBSERVED_AT,
        source_label: "caller supplied terminal observation",
      },
      {} as Parameters<typeof analyzeObservedPriceTool.handler>[1],
    );
    const envelope = analyzeObservedPriceOutputSchema.parse(
      result.structuredContent,
    );

    expect(envelope.meta.quality.freshness).toBe("stale");
    expect(envelope.meta.quality.freshnessDetails).toEqual(
      observedPriceMetaContract(
        context.data,
        context.completedClose.resolverEvidence,
      ).freshnessDetails,
    );
    expect(envelope.meta.quality.issues.map((issue) => issue.code)).toEqual([
      "CALLER_SUPPLIED_PRICE_UNVERIFIED",
      "OFFICIAL_BASELINE_COMPLETED_SESSION",
      "CONSERVATIVE_SAME_DAY_SESSION_GUARD",
      "MECHANICAL_PRICE_COMPARISON_NOT_FAIR_VALUE",
      "MASTER_ROWSET_HEURISTIC",
      "DATA_STALE",
    ]);
    expect(envelope.meta.asOf.snapshotId).toBe(
      observedPriceMetaContract(
        context.data,
        context.completedClose.resolverEvidence,
      ).snapshotId,
    );
  });

  it("converts domain failures to the shared structured error envelope", async () => {
    vi.spyOn(
      observedPriceClient,
      "analyzeObservedPriceWithContext",
    ).mockRejectedValue(
      new MopsfinError("INVALID_ARGUMENT", "fixture observation is too early", {
        reason: "OBSERVATION_PRECEDES_OFFICIAL_SESSION_COMPLETION",
        category: "input",
        retryable: false,
        action: "fix_input",
        details: {
          observedAt: "2026-08-28T13:32:59+08:00",
          conservativeSessionCompletionTaipei:
            "2026-08-28T13:33:00+08:00",
        },
      }),
    );

    const result = await analyzeObservedPriceTool.handler(
      {
        company_code: "2330",
        observed_price_twd: OBSERVED_PRICE,
        observed_at: "2026-08-28T13:32:59+08:00",
        source_label: "caller",
      },
      {} as Parameters<typeof analyzeObservedPriceTool.handler>[1],
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          reason: "OBSERVATION_PRECEDES_OFFICIAL_SESSION_COMPLETION",
          category: "input",
          retryable: false,
          action: "fix_input",
        },
      },
    });
    expect(
      analyzeObservedPriceOutputSchema.safeParse(result.structuredContent)
        .success,
    ).toBe(false);
  });

  it("keeps caller cache observation state out of snapshot identity", async () => {
    const original = fixture();
    const cacheOnlyChange = structuredClone(original);
    cacheOnlyChange.data.sources[0].cache.observedAt =
      "2026-08-28T00:36:00.000Z";
    cacheOnlyChange.data.sources[0].cache.ageMs = 360_000;
    const retrievalChange = structuredClone(original);
    retrievalChange.data.sources[2].retrievedAt =
      "2026-08-28T06:58:00.000Z";
    const resolverCacheOnlyChange = structuredClone(original);
    const resolverCache =
      resolverCacheOnlyChange.completedClose.resolverEvidence
        .marketResolutions[0].sources[0].cache;
    resolverCache.observedAt = "2026-08-28T07:01:00.000Z";
    resolverCache.ageMs = 120_000;
    const resolverRetrievalChange = structuredClone(original);
    resolverRetrievalChange.completedClose.resolverEvidence
      .marketResolutions[0].sources[0].retrievedAt =
      "2026-08-28T06:58:59.000Z";
    const dependencyOnlyChange = structuredClone(original.data);
    Object.assign(dependencyOnlyChange.dependencyLedger[1], {
      sourceIds: ["delivery-ledger-is-not-snapshot-evidence"],
    });

    expect(
      observedPriceMetaContract(
        original.data,
        original.completedClose.resolverEvidence,
      ).snapshotId,
    ).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(
      observedPriceMetaContract(
        dependencyOnlyChange,
        original.completedClose.resolverEvidence,
      ).snapshotId,
    ).toBe(
      observedPriceMetaContract(
        original.data,
        original.completedClose.resolverEvidence,
      ).snapshotId,
    );

    vi.spyOn(observedPriceClient, "analyzeObservedPriceWithContext")
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(cacheOnlyChange)
      .mockResolvedValueOnce(retrievalChange)
      .mockResolvedValueOnce(resolverCacheOnlyChange)
      .mockResolvedValueOnce(resolverRetrievalChange);
    const query = {
      company_code: "2330",
      observed_price_twd: OBSERVED_PRICE,
      observed_at: OBSERVED_AT,
      source_label: "caller supplied terminal observation",
    } as const;
    const toolContext = {} as Parameters<
      typeof analyzeObservedPriceTool.handler
    >[1];

    const first = await analyzeObservedPriceTool.handler(query, toolContext);
    const cacheOnly = await analyzeObservedPriceTool.handler(
      query,
      toolContext,
    );
    const retrieved = await analyzeObservedPriceTool.handler(
      query,
      toolContext,
    );
    const resolverCacheOnly = await analyzeObservedPriceTool.handler(
      query,
      toolContext,
    );
    const resolverRetrieved = await analyzeObservedPriceTool.handler(
      query,
      toolContext,
    );
    const firstEnvelope = analyzeObservedPriceOutputSchema.parse(
      first.structuredContent,
    );
    const cacheOnlyEnvelope = analyzeObservedPriceOutputSchema.parse(
      cacheOnly.structuredContent,
    );
    const retrievedEnvelope = analyzeObservedPriceOutputSchema.parse(
      retrieved.structuredContent,
    );
    const resolverCacheOnlyEnvelope = analyzeObservedPriceOutputSchema.parse(
      resolverCacheOnly.structuredContent,
    );
    const resolverRetrievedEnvelope = analyzeObservedPriceOutputSchema.parse(
      resolverRetrieved.structuredContent,
    );
    const firstId = firstEnvelope.meta.asOf.snapshotId;

    expect(cacheOnlyEnvelope.meta.asOf.snapshotId).toBe(firstId);
    expect(retrievedEnvelope.meta.asOf.snapshotId).not.toBe(firstId);
    expect(resolverCacheOnlyEnvelope.meta.asOf.snapshotId).toBe(firstId);
    expect(resolverRetrievedEnvelope.meta.asOf.snapshotId).not.toBe(firstId);
  });
});
