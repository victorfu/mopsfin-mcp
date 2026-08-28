import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeObservedPriceOutputSchema } from "@/lib/mcp/schema/observed-price";
import { observedPriceMetaContract } from "@/lib/mcp/observed-price-meta-contract";
import { analyzeObservedPriceTool } from "@/lib/mcp/tools/observed-price";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { observedPriceClient } from "@/lib/observed-price/client";
import type { ObservedPriceAnalysisResult } from "@/lib/observed-price/types";

const SERVED_AT = "2026-08-28T06:05:00.000Z";

function fixture(): ObservedPriceAnalysisResult {
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
    sourceId: "company_master:otc:2026-08-27",
    stage: "company_master" as const,
    market: "otc" as const,
    exchange: "TPEx" as const,
    sourceName: "證券櫃檯買賣中心－上櫃公司基本資料",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
    reportDate: "2026-08-27",
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
    sourceId: "official_close:listed:2026-08-27",
    stage: "latest_official_completed_close" as const,
    market: "listed" as const,
    sourceName: "臺灣證券交易所－上市個股日成交資訊",
    sourceUrl: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    retrievedAt: "2026-08-28T05:45:00.000Z",
    cache: {
      status: "bypass" as const,
      observedAt: "2026-08-28T05:45:00.000Z",
      storedAt: null,
      ageMs: null,
      ttlMs: 0,
    },
    snapshotIdentity: "verified" as const,
    dataDate: "2026-08-27",
    normalization: {
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
    },
  };
  return {
    query: {
      companyCode: "2330",
      observedPriceTwd: 33.35,
      observedAt: "2026-08-28T09:32:00+08:00",
      sourceLabel: "caller supplied terminal observation",
    },
    generatedAt: "2026-08-28T06:00:00.000Z",
    priceOrigin: "caller_supplied",
    officialBaselineOrigin: "official_latest_completed_close",
    company: {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      shortName: "台積電",
      market: "listed",
      exchange: "TWSE",
    },
    observedPriceTwd: 33.35,
    observedAt: "2026-08-28T09:32:00+08:00",
    observedTaipeiDate: "2026-08-28",
    sourceLabel: "caller supplied terminal observation",
    latestOfficialCompletedClose: 33.2,
    latestOfficialCloseDate: "2026-08-27",
    changeFromOfficialCloseTwd: 0.15,
    changeFromOfficialClosePercent: 0.451807,
    officialHistoryCutoff: "2026-08-27",
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
        dependency: "official_daily_market_price",
        logicalInvocations: 1,
        plannedOfficialSourceLoads: 1,
        sourceEvidence: "exposed",
        sourceIds: [closeSource.sourceId],
      },
      {
        dependency: "official_daily_market_internal_compatible_master",
        logicalInvocations: 1,
        plannedOfficialSourceLoads: 1,
        sourceEvidence: "not_exposed_by_dependency",
        sourceIds: [],
      },
    ],
    provenance: {
      observedPrice: {
        evidenceClass: "CALLER_SUPPLIED",
        official: false,
        independentlyVerified: false,
        sourceLabel: "caller supplied terminal observation",
        observedAt: "2026-08-28T09:32:00+08:00",
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
        dataDate: "2026-08-27",
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
        officialDailyMarketPrice: 1,
        officialDailyMarketInternalCompatibleMaster: 1,
        maximumIncludingNestedDependencies: 3,
      },
      plannedOfficialSourceRequests: {
        orchestrationCompanyMasterMarkets: 2,
        officialDailyMarketSnapshot: 1,
        officialDailyMarketInternalCompatibleMasterMarkets: 1,
        maximumTotal: 4,
        unitDefinition:
          "one_logical_official_source_load_before_cache_and_bounded_retry",
      },
      universePolicy: "compatible",
      selectedCompanyIdentityPolicy:
        "outer_market_all_master_plus_official_row_exact",
    },
    warnings: [
      "observedPriceTwd 完全由 caller 提供，MopsFin 未獨立驗證；它不是官方報價，也不得稱為 real-time 行情。",
      "官方基準只代表最近完成交易日的原始未還原權值收盤價，不是盤中行情或 adjusted close。",
      "若 caller 觀察值與官方 completed close 同一台北日期，採 13:33 Asia/Taipei 作為包含暫緩收盤可能性的保守 regular-session completion guard。",
      "價差只是 caller-supplied 觀察值相對官方完成交易日收盤價的機械比較，不代表 fair value、買賣建議或投資評級。",
      "官方價格 dependency 使用 compatible 全市場核對與至少 95% match-ratio 防截斷門檻；非目標公司的 master 差異不會阻斷查詢，但指定公司仍由外層 market=all master 與官方行情 code、name、market 精確核對。",
    ],
  };
}

function staleFixture(): ObservedPriceAnalysisResult {
  const data = structuredClone(fixture());
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
  return data;
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

  it("returns a schema-valid envelope with separated caller and official evidence", async () => {
    const data = fixture();
    const analyzeSpy = vi
      .spyOn(observedPriceClient, "analyzeObservedPrice")
      .mockResolvedValue(data);

    const result = await analyzeObservedPriceTool.handler(
      {
        company_code: "2330",
        observed_price_twd: 33.35,
        observed_at: "2026-08-28T09:32:00+08:00",
        source_label: "caller supplied terminal observation",
      },
      {} as Parameters<typeof analyzeObservedPriceTool.handler>[1],
    );
    const envelope = analyzeObservedPriceOutputSchema.parse(
      result.structuredContent,
    );

    expect(analyzeSpy).toHaveBeenCalledWith({
      companyCode: "2330",
      observedPriceTwd: 33.35,
      observedAt: "2026-08-28T09:32:00+08:00",
      sourceLabel: "caller supplied terminal observation",
    });
    expect(analyzeObservedPriceTool.config.outputSchema).toBe(
      analyzeObservedPriceOutputSchema,
    );
    expect(envelope.meta.asOf).toMatchObject({
      selector: "snapshot",
      resolved: { granularity: "mixed", from: null, through: null },
      servedAt: SERVED_AT,
      snapshotId: observedPriceMetaContract(data).snapshotId,
    });
    expect(envelope.meta.asOf.sourceCutoffs).toHaveLength(3);
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
      freshness: "unknown",
    });
    expect(envelope.meta.quality.freshnessDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyId: "official.current-snapshot.max-age-7d.v1",
          status: "within_expected_window",
        }),
        expect.objectContaining({
          policyId: "official.completed-session.v1",
          status: "unknown",
        }),
      ]),
    );
    expect(envelope.meta.quality.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "CALLER_SUPPLIED_PRICE_UNVERIFIED",
        "OFFICIAL_BASELINE_COMPLETED_SESSION",
        "CONSERVATIVE_SAME_DAY_SESSION_GUARD",
        "MECHANICAL_PRICE_COMPARISON_NOT_FAIR_VALUE",
        "MASTER_ROWSET_HEURISTIC",
        "NESTED_MASTER_SOURCE_EVIDENCE_NOT_EXPOSED",
        "FRESHNESS_UNVERIFIED",
      ]),
    );
    expect(Date.parse(envelope.meta.asOf.servedAt)).toBeGreaterThanOrEqual(
      Date.parse(envelope.generatedAt),
    );
    expect(envelope.provenance.observedPrice).toMatchObject({
      evidenceClass: "CALLER_SUPPLIED",
      official: false,
      independentlyVerified: false,
    });
    expect(envelope.dependencyLedger[2]).toMatchObject({
      sourceEvidence: "not_exposed_by_dependency",
      sourceIds: [],
    });
  });

  it("returns a schema-valid stale envelope with exact policy evidence and issues", async () => {
    const data = staleFixture();
    vi.spyOn(observedPriceClient, "analyzeObservedPrice").mockResolvedValue(
      data,
    );

    const result = await analyzeObservedPriceTool.handler(
      {
        company_code: "2330",
        observed_price_twd: 33.35,
        observed_at: "2026-08-28T09:32:00+08:00",
        source_label: "caller supplied terminal observation",
      },
      {} as Parameters<typeof analyzeObservedPriceTool.handler>[1],
    );
    const envelope = analyzeObservedPriceOutputSchema.parse(
      result.structuredContent,
    );

    expect(envelope.meta.quality.freshness).toBe("stale");
    expect(envelope.meta.quality.freshnessDetails).toEqual(
      observedPriceMetaContract(data).freshnessDetails,
    );
    expect(envelope.meta.quality.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["DATA_STALE", "FRESHNESS_UNVERIFIED"]),
    );
    expect(envelope.meta.asOf.snapshotId).toBe(
      observedPriceMetaContract(data).snapshotId,
    );
  });

  it("converts domain failures to the shared structured error envelope", async () => {
    vi.spyOn(observedPriceClient, "analyzeObservedPrice").mockRejectedValue(
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
        observed_price_twd: 33.35,
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
    cacheOnlyChange.sources[0].cache.observedAt =
      "2026-08-28T00:36:00.000Z";
    cacheOnlyChange.sources[0].cache.ageMs = 360_000;
    const retrievalChange = structuredClone(original);
    retrievalChange.sources[2].retrievedAt = "2026-08-28T05:44:00.000Z";
    const dependencyOnlyChange = structuredClone(original);
    Object.assign(dependencyOnlyChange.dependencyLedger[2], {
      sourceIds: ["delivery-ledger-is-not-snapshot-evidence"],
    });

    expect(observedPriceMetaContract(original).snapshotId).toMatch(
      /^[A-Za-z0-9_-]{32}$/,
    );
    expect(observedPriceMetaContract(dependencyOnlyChange).snapshotId).toBe(
      observedPriceMetaContract(original).snapshotId,
    );

    vi.spyOn(observedPriceClient, "analyzeObservedPrice")
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(cacheOnlyChange)
      .mockResolvedValueOnce(retrievalChange);
    const query = {
      company_code: "2330",
      observed_price_twd: 33.35,
      observed_at: "2026-08-28T09:32:00+08:00",
      source_label: "caller supplied terminal observation",
    } as const;
    const context = {} as Parameters<
      typeof analyzeObservedPriceTool.handler
    >[1];

    const first = await analyzeObservedPriceTool.handler(query, context);
    const cacheOnly = await analyzeObservedPriceTool.handler(query, context);
    const retrieved = await analyzeObservedPriceTool.handler(query, context);
    const firstEnvelope = analyzeObservedPriceOutputSchema.parse(
      first.structuredContent,
    );
    const cacheOnlyEnvelope = analyzeObservedPriceOutputSchema.parse(
      cacheOnly.structuredContent,
    );
    const retrievedEnvelope = analyzeObservedPriceOutputSchema.parse(
      retrieved.structuredContent,
    );
    const firstId = firstEnvelope.meta.asOf.snapshotId;

    expect(cacheOnlyEnvelope.meta.asOf.snapshotId).toBe(firstId);
    expect(retrievedEnvelope.meta.asOf.snapshotId).not.toBe(firstId);
  });
});
