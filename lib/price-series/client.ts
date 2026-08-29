import { createHash } from "node:crypto";

import { companyMasterClient } from "@/lib/company-master/client";
import type {
  CompanyMarket,
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import {
  buildPriceIndexCompatibleSeries,
  type PriceIndexCompatibleSeriesResult,
} from "@/lib/corporate-actions/adjustment-engine";
import { corporateActionClient } from "@/lib/corporate-actions/client";
import type {
  CorporateActionHistory,
  CorporateActionSource,
} from "@/lib/corporate-actions/types";
import {
  asMopsfinError,
  MopsfinError,
} from "@/lib/mopsfin/errors";
import { priceClient } from "@/lib/price/client";
import { validateAndAppendRawOhlcPage } from "@/lib/price/raw-page-contract";
import type {
  OhlcBar,
  PriceSource,
  StockOhlcQuery,
  StockOhlcResult,
} from "@/lib/price/types";

import type {
  StockPriceSeriesBar,
  StockPriceSeriesCoverage,
  StockPriceSeriesDependencyFailure,
  StockPriceSeriesIdentity,
  StockPriceSeriesQuery,
  StockPriceSeriesResult,
} from "./types";

export interface PriceSeriesCompanyMasterLike {
  listCompanies(
    query: {
      market: "all" | "listed" | "otc";
      includeFinancial: boolean;
      includeKy: boolean;
    },
    force?: boolean,
  ): Promise<CompanyMasterResult>;
}

export interface PriceSeriesRawPriceLike {
  getStockOhlc(query: StockOhlcQuery): Promise<StockOhlcResult>;
}

export interface PriceSeriesCorporateActionLike {
  getHistory(
    market: CompanyMarket,
    startDate: string,
    endDate: string,
    options?: { companyCodes?: string[] },
  ): Promise<CorporateActionHistory>;
}

interface LoadedRawPrice {
  bars: OhlcBar[];
  observedNames: string[];
  sources: PriceSource[];
  pageCount: number;
  dataQualityComplete: boolean;
  warnings: string[];
}

interface LoadedCorporateActions {
  history: CorporateActionHistory | null;
  failure: StockPriceSeriesDependencyFailure | null;
  historyCallCount: 0 | 1;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RAW_PRICE_PAGE_LIMIT = 3 as const;
const MAX_CALENDAR_MONTHS = 36;
const FINGERPRINT_BASIS =
  "query_identity_raw_bars_without_retrieved_at_or_cache_plus_corporate_action_history_and_adjustment_evidence" as const;

function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError(code, message, { details });
}

function parseIsoDate(value: string, field: string): Date {
  if (!ISO_DATE.test(value)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 YYYY-MM-DD。`, {
      field,
      value,
    });
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${field} 不是有效日期。`, { field, value });
  }
  return parsed;
}

function taipeiToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarMonthCount(startDate: string, endDate: string): number {
  const [startYear, startMonth] = startDate.slice(0, 7).split("-").map(Number);
  const [endYear, endMonth] = endDate.slice(0, 7).split("-").map(Number);
  return (endYear - startYear) * 12 + endMonth - startMonth + 1;
}

function normalizeQuery(
  query: StockPriceSeriesQuery,
  today: string,
): StockPriceSeriesQuery {
  const companyCode = query.companyCode.trim();
  if (!/^\d{4}$/.test(companyCode)) {
    fail("INVALID_ARGUMENT", "company_code 必須是四碼公司股票代號。", {
      companyCode: query.companyCode,
    });
  }
  parseIsoDate(query.startDate, "start_date");
  parseIsoDate(query.endDate, "end_date");
  if (query.startDate > query.endDate) {
    fail("INVALID_ARGUMENT", "end_date 不得早於 start_date。");
  }
  if (query.endDate > today) {
    fail("INVALID_ARGUMENT", "end_date 不得晚於台北今日日期。", { today });
  }
  const months = calendarMonthCount(query.startDate, query.endDate);
  if (months > MAX_CALENDAR_MONTHS) {
    fail("INVALID_ARGUMENT", "價格序列查詢最多涵蓋 36 個日曆月份。", {
      calendarMonthCount: months,
      maximumCalendarMonths: MAX_CALENDAR_MONTHS,
    });
  }
  if (
    query.priceBasis !== "raw_unadjusted" &&
    query.priceBasis !==
      "price_index_compatible_corporate_action_adjusted"
  ) {
    fail("INVALID_ARGUMENT", "price_basis 不支援指定的價格基礎。", {
      priceBasis: query.priceBasis,
    });
  }
  if (typeof query.includeEventLedger !== "boolean") {
    fail("INVALID_ARGUMENT", "include_event_ledger 必須是 boolean。");
  }
  return { ...query, companyCode };
}

function uniquePriceSources(sources: PriceSource[]): PriceSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = JSON.stringify({
      market: source.market,
      sourceName: source.sourceName,
      sourceUrl: source.sourceUrl,
      snapshotIdentity: source.snapshotIdentity ?? null,
      dataDate: source.dataDate ?? null,
      dataMonth: source.dataMonth ?? null,
      normalization: source.normalization,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueCorporateActionSources(
  sources: CorporateActionSource[],
): CorporateActionSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = JSON.stringify({
      ...source,
      retrievedAt: undefined,
      cache: undefined,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dependencyFailure(error: unknown): StockPriceSeriesDependencyFailure {
  const normalized = asMopsfinError(error);
  const retryable =
    normalized.retryable ??
    (normalized.code === "UPSTREAM_TIMEOUT" ||
      normalized.code === "UPSTREAM_RATE_LIMITED");
  return {
    code: normalized.code,
    reason: normalized.reason ?? null,
    message: normalized.message,
    retryable,
    retryAfterMs: normalized.retryAfterMs ?? null,
    action: normalized.action ?? (retryable ? "retry" : "none"),
  };
}

function identityFor(
  companyCode: string,
  master: CompanyMasterResult,
  raw: LoadedRawPrice,
): StockPriceSeriesIdentity {
  const current = master.companies.find((company) => company.code === companyCode);
  const observedMarkets = (["listed", "otc"] as const).filter((market) =>
    raw.bars.some((bar) => bar.market === market),
  );
  const latestHistoricalMarket = raw.bars.at(-1)?.market ?? null;
  const reasons: StockPriceSeriesIdentity["reasons"] = [];
  if (!current) reasons.push("not_in_current_master");
  if (observedMarkets.length > 1) reasons.push("multiple_historical_markets");
  if (
    current &&
    latestHistoricalMarket !== null &&
    current.market !== latestHistoricalMarket
  ) {
    reasons.push("current_market_differs_from_latest_historical_market");
  }
  if (new Set(raw.observedNames.map((name) => name.trim())).size > 1) {
    reasons.push("multiple_observed_names");
  }
  const resolvedMarket = current?.market ??
    (observedMarkets.length === 1 ? latestHistoricalMarket : null);
  return {
    status: current
      ? "verified_current_master"
      : observedMarkets.length === 1 && raw.observedNames.length > 0
        ? "inferred_from_historical_bars"
        : "unverified",
    companyCode,
    companyName: current?.shortName ?? raw.observedNames[0] ?? null,
    resolvedMarket,
    currentMasterMarket: current?.market ?? null,
    currentMasterName: current?.shortName ?? null,
    masterSnapshotId: master.snapshotId,
    observedNames: raw.observedNames,
    observedMarkets,
    reasons,
  };
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function priceSourceFingerprintEvidence(source: PriceSource) {
  return {
    market: source.market,
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    snapshotIdentity: source.snapshotIdentity ?? null,
    dataDate: source.dataDate ?? null,
    dataMonth: source.dataMonth ?? null,
    normalization: source.normalization,
  };
}

function rawSeriesBars(bars: OhlcBar[]): StockPriceSeriesBar[] {
  return bars.map((bar) => ({
    ...bar,
    cumulativeFactor: null,
    adjusted: null,
    adjustmentStatus: "not_requested",
    adjustmentUnknownReasons: [],
    volumeBasis: "raw_shares",
  }));
}

function adjustedSeriesBars(
  adjustment: PriceIndexCompatibleSeriesResult,
): StockPriceSeriesBar[] {
  return adjustment.bars.map(({ unknownReasons, ...bar }) => ({
    ...bar,
    adjustmentUnknownReasons: unknownReasons,
  }));
}

export class StockPriceSeriesClient {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: PriceSeriesCompanyMasterLike =
      companyMasterClient,
    private readonly rawPrice: PriceSeriesRawPriceLike = priceClient,
    private readonly corporateActions: PriceSeriesCorporateActionLike =
      corporateActionClient,
  ) {}

  async getStockPriceSeries(
    query: StockPriceSeriesQuery,
  ): Promise<StockPriceSeriesResult> {
    const normalized = normalizeQuery(query, taipeiToday(this.now()));
    const [master, raw] = await Promise.all([
      this.companyMaster.listCompanies({
        market: "all",
        includeFinancial: true,
        includeKy: true,
      }),
      this.loadRawPrice(normalized),
    ]);
    const identity = identityFor(normalized.companyCode, master, raw);
    const anchorDate = (raw.bars.at(-1) as OhlcBar).date;

    let loadedActions: LoadedCorporateActions = {
      history: null,
      failure: null,
      historyCallCount: 0,
    };
    let adjustment: PriceIndexCompatibleSeriesResult | null = null;
    if (
      normalized.priceBasis ===
      "price_index_compatible_corporate_action_adjusted"
    ) {
      loadedActions = await this.loadCorporateActions(normalized, identity);
      const adjustmentMarket =
        identity.resolvedMarket ?? raw.bars.at(-1)?.market;
      if (adjustmentMarket === undefined) {
        fail(
          "UPSTREAM_BAD_RESPONSE",
          "已有完整 raw coverage，但沒有可供 fail-conservative adjustment 評估的歷史市場 bar。",
        );
      }
      adjustment = buildPriceIndexCompatibleSeries({
        companyCode: normalized.companyCode,
        currentCompanyName:
          identity.currentMasterName ?? identity.companyName ?? normalized.companyCode,
        currentMarket: adjustmentMarket,
        observedNames: identity.observedNames,
        bars: raw.bars,
        events: loadedActions.history?.events ?? [],
        coverage: loadedActions.history?.coverage ?? null,
        windowStartDate: normalized.startDate,
        anchorDate,
      });
    }

    const bars = adjustment
      ? adjustedSeriesBars(adjustment)
      : rawSeriesBars(raw.bars);
    const corporateActionStatus =
      normalized.priceBasis === "raw_unadjusted"
        ? "not_requested" as const
        : loadedActions.failure
          ? "unavailable" as const
          : loadedActions.history?.coverage.coverageComplete
            ? "complete" as const
            : "partial" as const;
    const adjustmentStatus: StockPriceSeriesCoverage["adjustment"]["status"] =
      adjustment?.status ?? "not_requested";
    const adjustmentUnknownReasons = adjustment?.unknownReasons ?? [];
    const actionSources = uniqueCorporateActionSources(
      loadedActions.history?.sources ?? [],
    );
    const warnings = [
      ...raw.warnings,
      "raw OHLC 與成交量永遠保留官方未還原值；null 不會改寫成 0。",
    ];
    if (normalized.priceBasis === "raw_unadjusted") {
      warnings.push(
        "本次 price_basis=raw_unadjusted，未查詢公司行動，也未產生任何調整後價格。",
      );
    } else {
      warnings.push(
        "backward price-index-compatible 調整只移除股數變動機械斷點；現金股利效果保留，這不是 adjusted close、股息再投資或 total return。",
        "成交量維持 raw shares，未依公司行動調整。",
      );
      warnings.push(...(loadedActions.history?.warnings ?? []));
      if (loadedActions.failure) {
        warnings.push(
          `公司行動 dependency 無法取得；受影響 adjusted OHLC 保留 null：${loadedActions.failure.code}: ${loadedActions.failure.message}`,
        );
      }
      if (adjustment?.status === "unknown") {
        warnings.push(
          `部分或全部 adjusted OHLC 因必要證據不足而為 null：${adjustmentUnknownReasons.join("、")}`,
        );
      }
    }
    if (identity.reasons.length > 0) {
      warnings.push(`公司 identity 注意事項：${identity.reasons.join("、")}`);
    }

    const resultWithoutFingerprint = {
      query: normalized,
      generatedAt: this.now().toISOString(),
      timezone: "Asia/Taipei" as const,
      currency: "TWD" as const,
      interval: "1d" as const,
      requestedPriceBasis: normalized.priceBasis,
      rawPriceBasis: "raw_unadjusted" as const,
      adjustedPriceBasis: adjustment?.priceBasis ?? null,
      coverageComplete:
        adjustment === null ? true : adjustment.coverageComplete,
      dataQualityComplete:
        raw.dataQualityComplete &&
        (adjustment === null || adjustment.status === "complete"),
      identity,
      adjustment: adjustment
        ? {
            status: adjustment.status,
            adjustmentDirection: adjustment.adjustmentDirection,
            anchorDate: adjustment.anchorDate,
            factorAtWindowStart: adjustment.factorAtWindowStart,
            cashDividendTreatment: adjustment.cashDividendTreatment,
            isAdjustedClose: adjustment.isAdjustedClose,
            isTotalReturn: adjustment.isTotalReturn,
            volumeAdjusted: adjustment.volumeAdjusted,
            volumeBasis: adjustment.volumeBasis,
            unknownReasons: adjustment.unknownReasons,
            officialChangeMarkers: adjustment.officialChangeMarkers,
            unmatchedOfficialChangeMarkers:
              adjustment.unmatchedOfficialChangeMarkers,
            marketTransitionDetected: adjustment.marketTransitionDetected,
          }
        : {
            status: "not_requested" as const,
            adjustmentDirection: "not_applicable" as const,
            anchorDate,
            factorAtWindowStart: null,
            cashDividendTreatment: "not_applicable" as const,
            isAdjustedClose: false as const,
            isTotalReturn: false as const,
            volumeAdjusted: false as const,
            volumeBasis: "raw_shares" as const,
            unknownReasons: [],
            officialChangeMarkers: [],
            unmatchedOfficialChangeMarkers: [],
            marketTransitionDetected: identity.observedMarkets.length > 1,
          },
      bars,
      eventLedgerIncluded: normalized.includeEventLedger,
      eventLedger:
        normalized.includeEventLedger && adjustment
          ? adjustment.eventLedger
          : [],
      coverage: {
        requestedStart: normalized.startDate,
        requestedEnd: normalized.endDate,
        rawPrice: {
          status: "complete" as const,
          coverageComplete: true as const,
          coveredThrough: normalized.endDate,
          pageCount: raw.pageCount,
          barCount: raw.bars.length,
          dataQualityComplete: raw.dataQualityComplete,
        },
        corporateActions: {
          status: corporateActionStatus,
          coverage: loadedActions.history?.coverage ?? null,
          failure: loadedActions.failure,
        },
        adjustment: {
          status: adjustmentStatus,
          completeBarCount: bars.filter(
            (bar) => bar.adjustmentStatus === "complete",
          ).length,
          unknownBarCount: bars.filter(
            (bar) => bar.adjustmentStatus === "unknown",
          ).length,
        },
      },
      sources: [
        ...master.sources.map((source) => ({
          ...source,
          stage: "company_master" as const,
        })),
        ...raw.sources.map((source) => ({
          ...source,
          stage: "raw_price" as const,
        })),
        ...actionSources.map((source) => ({
          ...source,
          stage: "corporate_actions" as const,
        })),
      ],
      workBudget: {
        orchestrationCompanyMasterCalls: 1 as const,
        rawPriceDependencyMasterLookupPolicy:
          "dependency_managed_per_cursor_page_not_counted_as_orchestration_call" as const,
        rawPricePageLimit: RAW_PRICE_PAGE_LIMIT,
        rawPricePageCount: raw.pageCount,
        rawPricePageUnitDefinition:
          "one_get_stock_ohlc_cursor_page" as const,
        corporateActionHistoryCalls: loadedActions.historyCallCount,
        corporateActionOfficialRequestCount:
          loadedActions.history?.requestCount ??
          (loadedActions.historyCallCount === 0 ? 0 : null),
        corporateActionRequestUnitDefinition:
          "one_official_range_or_selected_event_detail_request" as const,
      },
      fingerprintBasis: FINGERPRINT_BASIS,
      warnings: [...new Set(warnings)],
    };
    const fingerprint = stableFingerprint({
      query: resultWithoutFingerprint.query,
      identity: resultWithoutFingerprint.identity,
      rawBars: raw.bars,
      priceSources: raw.sources.map(priceSourceFingerprintEvidence),
      corporateActionHistory: loadedActions.history
        ? {
            fingerprint: loadedActions.history.fingerprint,
            coverage: loadedActions.history.coverage,
            events: loadedActions.history.events,
          }
        : {
            status:
              normalized.priceBasis === "raw_unadjusted"
                ? "not_requested"
                : "unavailable",
            failure: loadedActions.failure
              ? {
                  code: loadedActions.failure.code,
                  reason: loadedActions.failure.reason,
                }
              : null,
          },
      adjustment: adjustment
        ? {
            status: adjustment.status,
            factorAtWindowStart: adjustment.factorAtWindowStart,
            bars: adjustment.bars,
            eventLedger: adjustment.eventLedger,
            unknownReasons: adjustment.unknownReasons,
          }
        : null,
    });
    return { ...resultWithoutFingerprint, fingerprint };
  }

  private async loadRawPrice(
    query: StockPriceSeriesQuery,
  ): Promise<LoadedRawPrice> {
    const barsByDate = new Map<string, OhlcBar>();
    const observedNames = new Set<string>();
    const sources: PriceSource[] = [];
    const warnings: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let coveredThrough: string | null = null;
    let dataQualityComplete = true;

    for (let page = 1; page <= RAW_PRICE_PAGE_LIMIT; page += 1) {
      const result = await this.rawPrice.getStockOhlc({
        companyCode: query.companyCode,
        startDate: query.startDate,
        endDate: query.endDate,
        ...(cursor ? { cursor } : {}),
      });
      validateAndAppendRawOhlcPage(
        result,
        {
          companyCode: query.companyCode,
          startDate: query.startDate,
          endDate: query.endDate,
          ...(cursor ? { cursor } : {}),
        },
        cursor,
        coveredThrough,
        barsByDate,
      );
      dataQualityComplete &&= result.dataQualityComplete;
      result.observedNames.forEach((name) => observedNames.add(name.trim()));
      sources.push(...result.sources);
      warnings.push(...result.warnings);
      coveredThrough = result.coverage.coveredThrough;
      if (result.coverage.coverageComplete) {
        const bars = [...barsByDate.values()].sort((left, right) =>
          left.date.localeCompare(right.date),
        );
        if (bars.length === 0) {
          fail("NO_DATA", "指定股票與日期範圍查無官方 OHLC。", {
            companyCode: query.companyCode,
            startDate: query.startDate,
            endDate: query.endDate,
          });
        }
        return {
          bars,
          observedNames: [...observedNames].filter(Boolean),
          sources: uniquePriceSources(sources),
          pageCount: page,
          dataQualityComplete:
            dataQualityComplete &&
            bars.every((bar) => bar.qualityStatus !== "partial"),
          warnings: [...new Set(warnings)],
        };
      }
      const nextCursor = result.coverage.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC cursor 未前進。", {
          companyCode: query.companyCode,
          page,
        });
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    fail(
      "INCOMPLETE_COVERAGE",
      "個股 OHLC 在三頁安全上限內未涵蓋完整 requested range。",
      {
        companyCode: query.companyCode,
        startDate: query.startDate,
        endDate: query.endDate,
        pageLimit: RAW_PRICE_PAGE_LIMIT,
        coveredThrough,
        nextCursor: cursor,
      },
    );
  }

  private async loadCorporateActions(
    query: StockPriceSeriesQuery,
    identity: StockPriceSeriesIdentity,
  ): Promise<LoadedCorporateActions> {
    if (
      identity.status === "unverified" ||
      identity.resolvedMarket === null
    ) {
      return {
        history: null,
        failure: dependencyFailure(
          new MopsfinError(
            "INCOMPLETE_COVERAGE",
            "無法由目前 master 或單一市場歷史 bars 確認公司行動查詢 identity。",
          ),
        ),
        historyCallCount: 0,
      };
    }
    try {
      const history = await this.corporateActions.getHistory(
        identity.resolvedMarket,
        query.startDate,
        query.endDate,
        { companyCodes: [query.companyCode] },
      );
      if (
        history.market !== identity.resolvedMarket ||
        history.requestedStart !== query.startDate ||
        history.requestedEnd !== query.endDate ||
        !history.filteredCompanyCodes ||
        history.filteredCompanyCodes.length !== 1 ||
        history.filteredCompanyCodes[0] !== query.companyCode ||
        !/^[a-f0-9]{64}$/.test(history.fingerprint)
      ) {
        fail(
          "UPSTREAM_BAD_RESPONSE",
          "公司行動 dependency 回傳 query scope 或 fingerprint 不一致。",
          {
            requestedMarket: identity.resolvedMarket,
            returnedMarket: history.market,
            requestedStart: query.startDate,
            returnedStart: history.requestedStart,
            requestedEnd: query.endDate,
            returnedEnd: history.requestedEnd,
            filteredCompanyCodes: history.filteredCompanyCodes,
          },
        );
      }
      return { history, failure: null, historyCallCount: 1 };
    } catch (error) {
      return {
        history: null,
        failure: dependencyFailure(error),
        historyCallCount: 1,
      };
    }
  }
}

export const stockPriceSeriesClient = new StockPriceSeriesClient();
