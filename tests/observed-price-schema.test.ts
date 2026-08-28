import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildResultMeta } from "@/lib/mcp/result-contract";
import {
  observedPriceMetaContract,
  observedPriceQualityIssues,
} from "@/lib/mcp/observed-price-meta-contract";
import {
  analyzeObservedPriceDataSchema,
  analyzeObservedPriceInputSchema,
  analyzeObservedPriceOutputSchema,
} from "@/lib/mcp/schema/observed-price";
import type { ObservedPriceAnalysisResult } from "@/lib/observed-price/types";
import { completedCloseResolverEvidenceFixture } from "@/tests/fixtures/completed-close";

function validData(): ObservedPriceAnalysisResult {
  return {
    query: {
      companyCode: "2330",
      observedPriceTwd: 2_430,
      observedAt: "2026-08-28T14:32:00+08:00",
      sourceLabel: "caller supplied terminal observation",
    },
    generatedAt: "2026-08-28T07:10:00.000Z",
    priceOrigin: "caller_supplied",
    officialBaselineOrigin: "official_latest_completed_close",
    company: {
      code: "2330",
      name: "台灣積體電路製造股份有限公司",
      shortName: "台積電",
      market: "listed",
      exchange: "TWSE",
    },
    observedPriceTwd: 2_430,
    observedAt: "2026-08-28T14:32:00+08:00",
    observedTaipeiDate: "2026-08-28",
    sourceLabel: "caller supplied terminal observation",
    latestOfficialCompletedClose: 2_420,
    latestOfficialCloseDate: "2026-08-28",
    changeFromOfficialCloseTwd: 10,
    changeFromOfficialClosePercent: 0.413223,
    officialHistoryCutoff: "2026-08-28",
    market: "listed",
    exchange: "TWSE",
    currency: "TWD",
    timezone: "Asia/Taipei",
    officialPriceBasis: "raw_unadjusted",
    sources: [
      {
        sourceId: "company_master:listed:2026-08-27",
        stage: "company_master",
        market: "listed",
        exchange: "TWSE",
        sourceName: "臺灣證券交易所－上市公司基本資料",
        sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L",
        reportDate: "2026-08-27",
        retrievedAt: "2026-08-28T00:30:00.000Z",
        rawCount: 1_001,
        excludedTdrCount: 1,
        companyCount: 1_000,
        minimumExpectedCount: 1_000,
        cache: {
          status: "hit",
          observedAt: "2026-08-28T00:35:00.000Z",
          storedAt: "2026-08-28T00:30:00.000Z",
          ageMs: 300_000,
          ttlMs: 600_000,
        },
      },
      {
        sourceId: "company_master:otc:2026-08-27",
        stage: "company_master",
        market: "otc",
        exchange: "TPEx",
        sourceName: "證券櫃檯買賣中心－上櫃公司基本資料",
        sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",
        reportDate: "2026-08-27",
        retrievedAt: "2026-08-28T00:31:00.000Z",
        rawCount: 801,
        excludedTdrCount: 1,
        companyCount: 800,
        minimumExpectedCount: 800,
        cache: {
          status: "miss",
          observedAt: "2026-08-28T00:31:00.000Z",
          storedAt: "2026-08-28T00:31:00.000Z",
          ageMs: 0,
          ttlMs: 600_000,
        },
      },
      {
        sourceId: "official_close:listed:2026-08-28",
        stage: "latest_official_completed_close",
        companyCode: "2330",
        market: "listed",
        exchange: "TWSE",
        sourceName: "臺灣證券交易所－個股日成交資訊",
        sourceUrl:
          "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260801&stockNo=2330&response=json",
        retrievedAt: "2026-08-28T07:05:00.000Z",
        cache: {
          status: "bypass",
          observedAt: "2026-08-28T07:05:00.000Z",
          storedAt: null,
          ageMs: null,
          ttlMs: 0,
        },
        snapshotIdentity: "verified",
        dataMonth: "2026-08",
        observedName: "台積電",
        selectedBarDate: "2026-08-28",
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
      },
    ],
    provenance: {
      observedPrice: {
        evidenceClass: "CALLER_SUPPLIED",
        official: false,
        independentlyVerified: false,
        sourceLabel: "caller supplied terminal observation",
        observedAt: "2026-08-28T14:32:00+08:00",
      },
      currentMasterIdentity: {
        evidenceClass: "OFFICIAL_MASTER_RAW",
        queryMarket: "all",
        coverageMarkets: ["listed", "otc"],
        companyMarket: "listed",
        sourceIds: [
          "company_master:listed:2026-08-27",
          "company_master:otc:2026-08-27",
        ],
      },
      officialBaseline: {
        evidenceClass: "OFFICIAL_MARKET_RAW",
        priceBasis: "raw_unadjusted",
        dataDate: "2026-08-28",
        sourceIds: ["official_close:listed:2026-08-28"],
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
    dependencyLedger: [
      {
        dependency: "orchestration_company_master",
        logicalInvocations: 1,
        plannedOfficialSourceLoads: 2,
        sourceEvidence: "exposed",
        sourceIds: [
          "company_master:listed:2026-08-27",
          "company_master:otc:2026-08-27",
        ],
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
        sourceIds: ["official_close:listed:2026-08-28"],
      },
    ],
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
    ],
  };
}

function validEnvelope(
  data = validData(),
  resolverEvidence = completedCloseResolverEvidenceFixture(),
) {
  const contract = observedPriceMetaContract(data, resolverEvidence);
  return {
    ok: true as const,
    meta: buildResultMeta(
      data as unknown as Record<string, unknown>,
      {
        selector: "snapshot",
        resolved: {
          granularity: "mixed",
          from: null,
          through: null,
        },
        source: "partial",
        universe: "unverified",
        selection: "complete",
        values: "complete",
        freshnessDetails: contract.freshnessDetails,
        issues: observedPriceQualityIssues(data),
        snapshotId: contract.snapshotId,
      },
      "2026-08-28T07:15:00.000Z",
    ),
    ...data,
  };
}

function staleData(): ObservedPriceAnalysisResult {
  const data = structuredClone(validData());
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

function closeSource(data: ObservedPriceAnalysisResult) {
  const source = data.sources.find(
    (item) => item.stage === "latest_official_completed_close",
  );
  if (!source) throw new Error("test fixture is missing close source");
  return source;
}

function sameDayData(observedAt: string): ObservedPriceAnalysisResult {
  const data = structuredClone(validData());
  data.query.observedAt = observedAt;
  data.observedAt = observedAt;
  data.observedTaipeiDate = "2026-08-28";
  data.provenance.observedPrice.observedAt = observedAt;
  return data;
}

describe("analyze observed price MCP schemas", () => {
  it("accepts bounded offset-ISO input and trims the caller source label", () => {
    expect(
      analyzeObservedPriceInputSchema.parse({
        company_code: "2330",
        observed_price_twd: 33.35,
        observed_at: "2026-08-28T01:32:00Z",
        source_label: "  caller terminal  ",
      }),
    ).toEqual({
      company_code: "2330",
      observed_price_twd: 33.35,
      observed_at: "2026-08-28T01:32:00Z",
      source_label: "caller terminal",
    });
  });

  it.each([
    { label: "bad company", patch: { company_code: "233" } },
    { label: "zero price", patch: { observed_price_twd: 0 } },
    { label: "infinite price", patch: { observed_price_twd: Number.POSITIVE_INFINITY } },
    { label: "timestamp without offset", patch: { observed_at: "2026-08-28T09:32:00" } },
    { label: "unknown negative-zero offset", patch: { observed_at: "2026-08-28T09:32:00-00:00" } },
    { label: "invalid calendar", patch: { observed_at: "2026-02-30T09:32:00+08:00" } },
    { label: "invalid offset", patch: { observed_at: "2026-08-28T09:32:00+15:00" } },
    { label: "unreasonable year", patch: { observed_at: "1899-08-28T09:32:00+08:00" } },
    { label: "empty label", patch: { source_label: "   " } },
    { label: "overlong label", patch: { source_label: "x".repeat(201) } },
    { label: "unknown field", patch: { unknown: true } },
  ])("rejects $label input", ({ patch }) => {
    expect(
      analyzeObservedPriceInputSchema.safeParse({
        company_code: "2330",
        observed_price_twd: 33.35,
        observed_at: "2026-08-28T09:32:00+08:00",
        source_label: "caller",
        ...patch,
      }).success,
    ).toBe(false);
  });

  it("accepts the strict core data and full MCP success envelope", () => {
    const data = validData();
    const parsedData = analyzeObservedPriceDataSchema.safeParse(data);
    expect(
      parsedData.success,
      parsedData.success ? "" : JSON.stringify(parsedData.error.issues),
    ).toBe(true);

    const envelope = validEnvelope();
    const parsedEnvelope = analyzeObservedPriceOutputSchema.safeParse(envelope);
    expect(
      parsedEnvelope.success,
      parsedEnvelope.success ? "" : JSON.stringify(parsedEnvelope.error.issues),
    ).toBe(true);

    const unknownNested = structuredClone(envelope);
    Object.assign(unknownNested.provenance.observedPrice, { unknown: true });
    expect(
      analyzeObservedPriceOutputSchema.safeParse(unknownNested).success,
    ).toBe(false);

    expect(
      analyzeObservedPriceOutputSchema.safeParse({
        ...envelope,
        unknown: true,
      }).success,
    ).toBe(false);

    const badEnvelopeFormula = structuredClone(envelope);
    badEnvelopeFormula.changeFromOfficialClosePercent = 99;
    expect(
      analyzeObservedPriceOutputSchema.safeParse(badEnvelopeFormula).success,
    ).toBe(false);
  });

  it("accepts resolver-confirmed exact close and rejects unresolved or date-mismatched evidence", () => {
    const envelope = validEnvelope();
    const parsed = analyzeObservedPriceOutputSchema.safeParse(envelope);
    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.meta.quality.freshness).toBe(
      "within_expected_window",
    );
    expect(parsed.data.meta.quality.freshnessDetails[1]).toMatchObject({
      policyId: "official.completed-session.v1",
      status: "within_expected_window",
      observedAsOf: "2026-08-28",
      expectedAsOf: "2026-08-28",
      lag: { value: 0, unit: "trading_session" },
    });
    expect(
      parsed.data.meta.quality.issues.some(
        (issue) => issue.code === "FRESHNESS_UNVERIFIED",
      ),
    ).toBe(false);

    const wrongMarket = structuredClone(envelope);
    const detail = wrongMarket.meta.quality.freshnessDetails.find(
      (item) => item.policyId === "official.completed-session.v1",
    );
    if (!detail?.resolverEvidence) throw new Error("fixture evidence missing");
    detail.resolverEvidence.markets = ["otc"];
    expect(
      analyzeObservedPriceOutputSchema.safeParse(wrongMarket).success,
    ).toBe(false);

    const unresolved = validEnvelope(
      validData(),
      completedCloseResolverEvidenceFixture({ status: "unresolved" }),
    );
    expect(
      analyzeObservedPriceOutputSchema.safeParse(unresolved).success,
    ).toBe(false);

    const wrongExpectedDate = validEnvelope(
      validData(),
      completedCloseResolverEvidenceFixture({ expectedAsOf: "2026-08-27" }),
    );
    expect(
      analyzeObservedPriceOutputSchema.safeParse(wrongExpectedDate).success,
    ).toBe(false);
  });

  it("accepts stale master evidence only when authoritative completed close stays exact and fresh", () => {
    const envelope = validEnvelope(staleData());
    const parsed = analyzeObservedPriceOutputSchema.safeParse(envelope);

    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.meta.quality.freshness).toBe("stale");
    expect(parsed.data.meta.quality.freshnessDetails).toHaveLength(2);
    expect(parsed.data.meta.quality.freshnessDetails[0]).toMatchObject({
      policyId: "official.current-snapshot.max-age-7d.v1",
      observedAsOf: "2026-08-20",
      expectedAsOf: "2026-08-28",
      status: "stale",
      lag: { value: 8, unit: "calendar_day" },
    });
    expect(parsed.data.meta.quality.freshnessDetails[1]).toMatchObject({
      policyId: "official.completed-session.v1",
      observedAsOf: "2026-08-28",
      expectedAsOf: "2026-08-28",
      status: "within_expected_window",
    });
    expect(parsed.data.meta.quality.issues.map((issue) => issue.code)).toContain(
      "DATA_STALE",
    );
    expect(parsed.data.meta.quality.issues.map((issue) => issue.code)).not.toContain(
      "FRESHNESS_UNVERIFIED",
    );
  });

  it("rejects stale aggregate or required DATA_STALE issue mutations", () => {
    const wrongAggregate = validEnvelope(staleData());
    wrongAggregate.meta.quality.freshness = "unknown";
    expect(
      analyzeObservedPriceOutputSchema.safeParse(wrongAggregate).success,
    ).toBe(false);

    const missingIssue = validEnvelope(staleData());
    missingIssue.meta.quality.issues =
      missingIssue.meta.quality.issues.filter(
        (issue) => issue.code !== "DATA_STALE",
      );
    expect(
      analyzeObservedPriceOutputSchema.safeParse(missingIssue).success,
    ).toBe(false);
  });

  it("rejects advertised output time, cache, source-set and cutoff contradictions", () => {
    const cases: Array<{
      label: string;
      mutate: (envelope: ReturnType<typeof validEnvelope>) => void;
    }> = [
      {
        label: "served before domain generation",
        mutate: (envelope) => {
          envelope.meta.asOf.servedAt = "2026-08-28T07:09:59.999Z";
          envelope.meta.asOf.assembledAt = "2026-08-28T07:09:59.999Z";
        },
      },
      {
        label: "assembled instant differs from served instant",
        mutate: (envelope) => {
          envelope.meta.asOf.assembledAt = "2026-08-28T07:15:00.001Z";
        },
      },
      {
        label: "selector is not snapshot",
        mutate: (envelope) => {
          envelope.meta.asOf.selector = "latest";
        },
      },
      {
        label: "resolved as-of is not mixed null/null",
        mutate: (envelope) => {
          envelope.meta.asOf.resolved = {
            granularity: "date",
            from: "2026-08-27",
            through: "2026-08-27",
          };
        },
      },
      {
        label: "page is not none",
        mutate: (envelope) => {
          envelope.meta.page.mode = "offset";
        },
      },
      {
        label: "source quality is optimistic",
        mutate: (envelope) => {
          envelope.meta.quality.source = "complete";
        },
      },
      {
        label: "universe quality is optimistic",
        mutate: (envelope) => {
          envelope.meta.quality.universe = "verified";
        },
      },
      {
        label: "selection quality is not complete",
        mutate: (envelope) => {
          envelope.meta.quality.selection = "partial";
        },
      },
      {
        label: "value quality is not complete",
        mutate: (envelope) => {
          envelope.meta.quality.values = "partial";
        },
      },
      {
        label: "freshness aggregate is contradictory",
        mutate: (envelope) => {
          envelope.meta.quality.freshness = "unknown";
        },
      },
      {
        label: "aggregate status is optimistic",
        mutate: (envelope) => {
          envelope.meta.quality.status = "complete";
        },
      },
      {
        label: "freshness policy set is incomplete",
        mutate: (envelope) => {
          envelope.meta.quality.freshnessDetails.pop();
        },
      },
      {
        label: "caller observation is later than request-start resolver evaluatedAt",
        mutate: (envelope) => {
          const observedAt = "2026-08-28T15:05:00+08:00";
          envelope.query.observedAt = observedAt;
          envelope.observedAt = observedAt;
          envelope.provenance.observedPrice.observedAt = observedAt;
          const detail = envelope.meta.quality.freshnessDetails.find(
            (item) => item.policyId === "official.completed-session.v1",
          );
          if (!detail?.resolverEvidence) throw new Error("resolver fixture missing");
          envelope.meta.asOf.snapshotId = observedPriceMetaContract(
            envelope,
            detail.resolverEvidence,
          ).snapshotId;
        },
      },
      {
        label: "resolver evaluatedAt is later than generatedAt",
        mutate: (envelope) => {
          const detail = envelope.meta.quality.freshnessDetails.find(
            (item) => item.policyId === "official.completed-session.v1",
          );
          if (!detail?.resolverEvidence) throw new Error("resolver fixture missing");
          detail.resolverEvidence.evaluatedAt =
            "2026-08-28T07:10:00.001Z";
        },
      },
      {
        label: "resolver source retrieval is later than generatedAt",
        mutate: (envelope) => {
          const detail = envelope.meta.quality.freshnessDetails.find(
            (item) => item.policyId === "official.completed-session.v1",
          );
          if (!detail?.resolverEvidence) throw new Error("resolver fixture missing");
          const source = detail.resolverEvidence.marketResolutions[0].sources[0];
          source.retrievedAt = "2026-08-28T07:10:00.001Z";
          const cutoff = envelope.meta.asOf.sourceCutoffs.find(
            (candidate) => candidate.sourceUrl === source.sourceUrl,
          );
          if (!cutoff) throw new Error("resolver cutoff missing");
          cutoff.retrievedAt = source.retrievedAt;
          envelope.meta.asOf.snapshotId = observedPriceMetaContract(
            envelope,
            detail.resolverEvidence,
          ).snapshotId;
        },
      },
      {
        label: "embedded resolver budget omits the marker load",
        mutate: (envelope) => {
          const detail = envelope.meta.quality.freshnessDetails.find(
            (item) => item.policyId === "official.completed-session.v1",
          );
          if (!detail?.resolverEvidence) throw new Error("resolver fixture missing");
          const evidence = detail.resolverEvidence;
          evidence.marketResolutions[0].workBudget.sessionMarkerLogicalLoads = 0;
          evidence.marketResolutions[0].workBudget.actualTotal = 1;
          evidence.workBudget.sessionMarkerLogicalLoads = 0;
          evidence.workBudget.actualTotal = 1;
        },
      },
      {
        label: "freshness policy id differs",
        mutate: (envelope) => {
          envelope.meta.quality.freshnessDetails[0].policyId =
            "unverified.no-policy.v1";
        },
      },
      {
        label: "freshness source urls differ",
        mutate: (envelope) => {
          envelope.meta.quality.freshnessDetails[0].sourceUrls = [
            envelope.sources[0].sourceUrl,
          ];
        },
      },
      {
        label: "freshness observed as-of differs",
        mutate: (envelope) => {
          envelope.meta.quality.freshnessDetails[0].observedAsOf =
            "2026-08-26";
        },
      },
      {
        label: "freshness expected as-of differs",
        mutate: (envelope) => {
          envelope.meta.quality.freshnessDetails[0].expectedAsOf =
            "2026-08-27";
        },
      },
      {
        label: "freshness status differs",
        mutate: (envelope) => {
          envelope.meta.quality.freshnessDetails[0].status = "stale";
        },
      },
      {
        label: "fresh authoritative result invents FRESHNESS_UNVERIFIED",
        mutate: (envelope) => {
          envelope.meta.quality.issues.push({
            ...envelope.meta.quality.issues[0],
            code: "FRESHNESS_UNVERIFIED",
          });
        },
      },
      {
        label: "required domain issue is missing",
        mutate: (envelope) => {
          envelope.meta.quality.issues = envelope.meta.quality.issues.filter(
            (issue) => issue.code !== "CALLER_SUPPLIED_PRICE_UNVERIFIED",
          );
        },
      },
      {
        label: "required domain issue is duplicated",
        mutate: (envelope) => {
          const issue = envelope.meta.quality.issues.find(
            (candidate) =>
              candidate.code === "CALLER_SUPPLIED_PRICE_UNVERIFIED",
          );
          if (issue) {
            envelope.meta.quality.issues.push(structuredClone(issue));
          }
        },
      },
      {
        label: "non-stale result invents DATA_STALE",
        mutate: (envelope) => {
          const template = envelope.meta.quality.issues[0];
          envelope.meta.quality.issues.push({
            ...template,
            code: "DATA_STALE",
          });
        },
      },
      {
        label: "result invents an unrelated quality issue",
        mutate: (envelope) => {
          const template = envelope.meta.quality.issues[0];
          envelope.meta.quality.issues.push({
            ...template,
            code: "UNRELATED_ISSUE",
          });
        },
      },
      {
        label: "snapshot id is null",
        mutate: (envelope) => {
          envelope.meta.asOf.snapshotId = null;
        },
      },
      {
        label: "snapshot id is not 32-char base64url",
        mutate: (envelope) => {
          envelope.meta.asOf.snapshotId = "A".repeat(31);
        },
      },
      {
        label: "snapshot id is well-formed but not recomputable",
        mutate: (envelope) => {
          envelope.meta.asOf.snapshotId = "A".repeat(32);
        },
      },
      {
        label: "source cache age is not recomputable",
        mutate: (envelope) => {
          envelope.sources[0].cache.ageMs = 300_001;
        },
      },
      {
        label: "source cache status and null fields disagree",
        mutate: (envelope) => {
          Object.assign(envelope.sources[2].cache, {
            status: "bypass" as const,
            storedAt: "2026-08-28T07:05:00.000Z",
            ageMs: 0,
          });
        },
      },
      {
        label: "source cutoff retrieval differs from evidence",
        mutate: (envelope) => {
          envelope.meta.asOf.sourceCutoffs[0].retrievedAt =
            "2026-08-28T00:30:00.001Z";
        },
      },
      {
        label: "source cutoff cache differs from evidence",
        mutate: (envelope) => {
          envelope.meta.asOf.sourceCutoffs[1].cache.ageMs = 1;
        },
      },
      {
        label: "source cutoff invents a publication time",
        mutate: (envelope) => {
          envelope.meta.asOf.sourceCutoffs[2].publishedAt =
            "2026-08-28T05:40:00.000Z";
        },
      },
      {
        label: "missing top-level evidence source",
        mutate: (envelope) => {
          envelope.sources.pop();
        },
      },
      {
        label: "extra top-level evidence source",
        mutate: (envelope) => {
          envelope.sources.push(structuredClone(envelope.sources[2]));
        },
      },
      {
        label: "resolver dependency invents top-level source evidence",
        mutate: (envelope) => {
          Object.assign(envelope.dependencyLedger[1], {
            sourceIds: ["company_master:listed:2026-08-27"],
          });
        },
      },
    ];

    for (const entry of cases) {
      const envelope = validEnvelope();
      entry.mutate(envelope);
      expect(
        analyzeObservedPriceOutputSchema.safeParse(envelope).success,
        entry.label,
      ).toBe(false);
    }
  });

  it("enforces identity, cutoff, provenance, formulas, warning and work-budget invariants", () => {
    const cases: Array<{ label: string; data: ObservedPriceAnalysisResult }> = [];

    const queryMismatch = structuredClone(validData());
    queryMismatch.query.companyCode = "2317";
    cases.push({ label: "query identity", data: queryMismatch });

    const exchangeMismatch = structuredClone(validData());
    Object.assign(exchangeMismatch.company, { exchange: "TPEx" });
    cases.push({ label: "exchange identity", data: exchangeMismatch });

    const cutoffMismatch = structuredClone(validData());
    cutoffMismatch.officialHistoryCutoff = "2026-08-26";
    cases.push({ label: "official cutoff", data: cutoffMismatch });

    const wrongDifference = structuredClone(validData());
    wrongDifference.changeFromOfficialClosePercent = 0.45;
    cases.push({ label: "recomputed difference", data: wrongDifference });

    const wrongProvenance = structuredClone(validData());
    wrongProvenance.provenance.officialBaseline.sourceIds = [
      "official_close:listed:2026-08-26",
    ];
    cases.push({ label: "source lineage", data: wrongProvenance });

    const weakWarnings = structuredClone(validData());
    weakWarnings.warnings = ["a", "b", "c", "d"];
    cases.push({ label: "semantic warnings", data: weakWarnings });

    const undercountedBudget = structuredClone(validData());
    (
      undercountedBudget.workBudget.plannedOfficialSourceRequests as {
        maximumTotal: number;
      }
    ).maximumTotal = 3;
    cases.push({ label: "work budget", data: undercountedBudget });

    for (const entry of cases) {
      expect(
        analyzeObservedPriceDataSchema.safeParse(entry.data).success,
        entry.label,
      ).toBe(false);
    }
  });

  it("enforces exact source stages, ids, verified identity and acquisition times", () => {
    const cases: Array<{ label: string; data: ObservedPriceAnalysisResult }> = [];

    const wrongOrder = structuredClone(validData());
    wrongOrder.sources.reverse();
    cases.push({ label: "source stage order", data: wrongOrder });

    const wrongId = structuredClone(validData());
    closeSource(wrongId).sourceId = "official_close:listed:2026-08-26";
    cases.push({ label: "source id", data: wrongId });

    const unverified = structuredClone(validData());
    Object.assign(closeSource(unverified), {
      snapshotIdentity: "unverified_empty",
    });
    cases.push({ label: "snapshot identity", data: unverified });

    const wrongMonth = structuredClone(validData());
    closeSource(wrongMonth).dataMonth = "2026-07";
    cases.push({ label: "monthly snapshot identity", data: wrongMonth });

    const wrongSelectedDate = structuredClone(validData());
    closeSource(wrongSelectedDate).selectedBarDate = "2026-08-27";
    cases.push({ label: "selected exact bar date", data: wrongSelectedDate });

    const wrongObservedName = structuredClone(validData());
    closeSource(wrongObservedName).observedName = "不是台積電";
    cases.push({ label: "official observed name", data: wrongObservedName });

    const wrongCompanyCode = structuredClone(validData());
    closeSource(wrongCompanyCode).companyCode = "2317";
    cases.push({ label: "official source company code", data: wrongCompanyCode });

    const wrongUrlCode = structuredClone(validData());
    closeSource(wrongUrlCode).sourceUrl = closeSource(
      wrongUrlCode,
    ).sourceUrl.replace("stockNo=2330", "stockNo=2317");
    cases.push({ label: "official URL company code", data: wrongUrlCode });

    const nonOfficialHost = structuredClone(validData());
    closeSource(nonOfficialHost).sourceUrl = closeSource(
      nonOfficialHost,
    ).sourceUrl.replace("www.twse.com.tw", "example.com");
    cases.push({ label: "official URL host", data: nonOfficialHost });

    const afterGeneration = structuredClone(validData());
    closeSource(afterGeneration).retrievedAt = "2026-08-28T07:10:00.001Z";
    cases.push({ label: "retrieved after generated", data: afterGeneration });

    const noOffset = structuredClone(validData());
    closeSource(noOffset).retrievedAt = "2026-08-28T07:05:00";
    cases.push({ label: "retrieved without offset", data: noOffset });

    const dataAfterRetrieval = structuredClone(validData());
    closeSource(dataAfterRetrieval).retrievedAt = "2026-08-26T15:59:59Z";
    cases.push({ label: "data after retrieval", data: dataAfterRetrieval });

    for (const entry of cases) {
      expect(
        analyzeObservedPriceDataSchema.safeParse(entry.data).success,
        entry.label,
      ).toBe(false);
    }
  });

  it("uses the 13:33 Asia/Taipei same-day guard across caller timezones", () => {
    expect(
      analyzeObservedPriceDataSchema.safeParse(
        sameDayData("2026-08-28T05:32:59Z"),
      ).success,
    ).toBe(false);
    expect(
      analyzeObservedPriceDataSchema.safeParse(
        sameDayData("2026-08-27T21:33:00-08:00"),
      ).success,
    ).toBe(true);

    const sourceBeforeGuard = sameDayData("2026-08-28T05:40:00Z");
    closeSource(sourceBeforeGuard).retrievedAt = "2026-08-28T05:32:59Z";
    expect(
      analyzeObservedPriceDataSchema.safeParse(sourceBeforeGuard).success,
    ).toBe(false);
  });

  it("recursively describes every input and advertised output property", () => {
    type JsonSchemaNode = {
      description?: string;
      properties?: Record<string, JsonSchemaNode>;
      items?: JsonSchemaNode;
      anyOf?: JsonSchemaNode[];
      oneOf?: JsonSchemaNode[];
      allOf?: JsonSchemaNode[];
    };

    const missingDescriptions = (
      node: JsonSchemaNode | undefined,
      path: string,
    ): string[] => {
      if (!node) return [`${path}:missing-schema`];
      const missing: string[] = [];
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const childPath = `${path}.${key}`;
        if (!child.description?.trim()) missing.push(childPath);
        missing.push(...missingDescriptions(child, childPath));
      }
      if (node.items) {
        missing.push(...missingDescriptions(node.items, `${path}[]`));
      }
      for (const variants of [node.anyOf, node.oneOf, node.allOf]) {
        for (const [index, child] of (variants ?? []).entries()) {
          missing.push(
            ...missingDescriptions(child, `${path}.variant${index}`),
          );
        }
      }
      return missing;
    };

    const inputJson = z.toJSONSchema(analyzeObservedPriceInputSchema, {
      target: "draft-07",
      unrepresentable: "any",
      reused: "inline",
    }) as JsonSchemaNode;
    const outputJson = z.toJSONSchema(analyzeObservedPriceOutputSchema, {
      target: "draft-07",
      unrepresentable: "any",
      reused: "inline",
    }) as JsonSchemaNode;

    expect([
      ...missingDescriptions(inputJson, "input"),
      ...missingDescriptions(outputJson, "output"),
    ]).toEqual([]);
  });
});
