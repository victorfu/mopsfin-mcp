import { createHash } from "node:crypto";

import { companyMasterClient } from "@/lib/company-master/client";
import type {
  CompanyMarket,
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import { corporateActionClient } from "@/lib/corporate-actions/client";
import {
  buildPriceIndexCompatibleSeries,
  corporateActionEventsWithin,
  isPriceIndexAdjustableCorporateAction,
  type PriceIndexAdjustmentUnknownReason,
  type PriceIndexCompatibleSeriesResult,
} from "@/lib/corporate-actions/adjustment-engine";
import type {
  CorporateActionEvent,
  CorporateActionHistory,
  CorporateActionSource,
} from "@/lib/corporate-actions/types";
import { completedSessionSnapshotFingerprint } from "@/lib/freshness/completed-session-snapshot";
import {
  completedSessionExpectedAsOfForMarket,
  completedSessionResolver,
} from "@/lib/freshness/completed-session-resolver";
import type { CompletedSessionResolverEvidence } from "@/lib/freshness/types";
import type { OfficialMarketClientOptions } from "@/lib/market-data/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { priceClient } from "@/lib/price/client";
import { validateAndAppendRawOhlcPage } from "@/lib/price/raw-page-contract";
import type {
  OhlcBar,
  PriceSource,
  StockOhlcQuery,
  StockOhlcResult,
} from "@/lib/price/types";

import { BenchmarkClient } from "./benchmark-client";
import {
  calculateAverageWindowSignal,
  calculatePricePathSignal,
  calculateRatioSignal,
  calculateReturnSignal,
  exactSessionWindow,
} from "./calculations";
import {
  benchmarkFingerprint,
  decodeReactionCursor,
  encodeReactionCursor,
  reactionQueryHash,
  type ReactionCursorPayload,
} from "./cursor";
import type {
  AverageWindowSignal,
  BenchmarkHistory,
  CompanyReactionSignals,
  ExcessReturnComparabilityReason,
  ReactionComparability,
  ReactionHorizon,
  ReactionStockDataFailure,
  ReactionStockDataStatus,
  ReturnReactionSignal,
  StockReactionSignalsQuery,
  StockReactionSignalsResult,
} from "./types";

interface CompanyMasterLike {
  listCompanies(
    query: {
      market: "all" | "listed" | "otc";
      includeFinancial: boolean;
      includeKy: boolean;
    },
    force?: boolean,
  ): Promise<CompanyMasterResult>;
}

interface StockPriceLike {
  getStockOhlc(query: StockOhlcQuery): Promise<StockOhlcResult>;
}

interface BenchmarkLike {
  getHistory(market: CompanyMarket, months: string[]): Promise<BenchmarkHistory>;
}

interface CorporateActionLike {
  getHistory(
    market: CompanyMarket,
    startDate: string,
    endDate: string,
    options?: { companyCodes?: string[] },
  ): Promise<CorporateActionHistory>;
}

interface CompletedSessionResolverLike {
  resolve(input: {
    market: CompanyMarket;
    evaluatedAt?: Date | string;
  }): Promise<CompletedSessionResolverEvidence>;
}

interface ReactionClientOptions extends OfficialMarketClientOptions {
  concurrency?: number;
  benchmarkConcurrency?: number;
  benchmarkClient?: BenchmarkLike;
  corporateActionClient?: CorporateActionLike;
  completedSessionResolver?: CompletedSessionResolverLike;
}

interface NormalizedQuery {
  companyCodes: string[];
  asOf: "latest" | string;
  horizons: ReactionHorizon[];
  pageSize: number;
  cursor?: string;
}

interface PlannedCompany {
  company: MasterCompany;
  startDate: string;
  endDate: string;
  workUnits: number;
}

interface LoadedStockHistory {
  status: ReactionStockDataStatus;
  bars: OhlcBar[];
  observedNames: string[];
  sources: PriceSource[];
  failure: ReactionStockDataFailure | null;
}

interface LoadedCorporateActionHistory {
  market: CompanyMarket;
  history: CorporateActionHistory | null;
  fingerprint: string;
  requestCount: number;
  failure: string | null;
}

const WORK_UNIT_LIMIT = 48 as const;
const BENCHMARK_SUPPORTED_FROM = "1999-01-05";
const TWSE_STOCK_SUPPORTED_FROM = "2010-01-04";
const CORPORATE_ACTION_SUPPORTED_FROM: Record<CompanyMarket, string[]> = {
  listed: ["2003-05-05", "2011-01-01", "2019-09-09"],
  otc: ["2008-01-02", "2013-01-01", "2019-09-09"],
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_HORIZONS = new Set<ReactionHorizon>([5, 20, 60, 120]);

function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError(code, message, { details });
}

function cursorInvalid(message: string, details?: Record<string, unknown>): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "CURSOR_INVALID",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

function snapshotChanged(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "SNAPSHOT_CHANGED",
    category: "pagination",
    retryable: false,
    action: "restart_pagination",
  });
}

function completedSessionFailure(
  evidence: CompletedSessionResolverEvidence,
  market: CompanyMarket,
  reason: "COMPLETED_SESSION_UNRESOLVED" | "COMPLETED_SESSION_EVIDENCE_MISMATCH",
): never {
  throw new MopsfinError(
    "UPSTREAM_BAD_RESPONSE",
    reason === "COMPLETED_SESSION_UNRESOLVED"
      ? "authoritative completed-session resolver 無法解析 reaction latest 日期。"
      : "authoritative completed-session resolver evidence identity 不一致。",
    {
      reason,
      category: "upstream",
      retryable: reason === "COMPLETED_SESSION_UNRESOLVED",
      action: reason === "COMPLETED_SESSION_UNRESOLVED" ? "retry" : "none",
      details: {
        market,
        resolverStatus: evidence.status,
        resolverReasonCode: evidence.reasonCode,
        resolverMarkets: evidence.markets,
        resolverExpectedAsOf: evidence.expectedAsOf,
      },
    },
  );
}

function workBudgetExceeded(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    details,
    reason: "WORK_BUDGET_EXCEEDED",
    category: "input",
    retryable: false,
    action: "change_query",
  });
}

function parseIsoDate(raw: string, field: string): Date {
  if (!ISO_DATE.test(raw)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 YYYY-MM-DD 或 latest。`, {
      field,
      value: raw,
    });
  }
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${field} 不是有效日期。`, { field, value: raw });
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

function subtractDays(date: string, days: number): string {
  const parsed = parseIsoDate(date, "as_of");
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function addMonths(month: string, count: number): string {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + count, 1))
    .toISOString()
    .slice(0, 7);
}

function monthEnd(month: string): string {
  const [year, value] = addMonths(month, 1).split("-").map(Number);
  return new Date(Date.UTC(year, value - 1, 0)).toISOString().slice(0, 10);
}

function monthsBetween(startDate: string, endDate: string): string[] {
  const startMonth = monthOf(startDate);
  const endMonth = monthOf(endDate);
  const months: string[] = [];
  for (let month = startMonth; month <= endMonth; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
}

function corporateActionBaseRequestCount(
  market: CompanyMarket,
  endDate: string,
): number {
  return CORPORATE_ACTION_SUPPORTED_FROM[market].filter(
    (supportedFrom) => endDate >= supportedFrom,
  ).length;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
  );
  return results;
}

function normalizeQuery(query: StockReactionSignalsQuery, today: string): NormalizedQuery {
  if (
    !Array.isArray(query.companyCodes) ||
    query.companyCodes.length < 1 ||
    query.companyCodes.length > 50
  ) {
    fail("INVALID_ARGUMENT", "company_codes 必須包含 1 至 50 個公司股票代號。");
  }
  const companyCodes = query.companyCodes.map((code) =>
    typeof code === "string" ? code.trim() : String(code),
  );
  if (companyCodes.some((code) => !/^\d{4}$/.test(code))) {
    fail("INVALID_ARGUMENT", "company_codes 只能包含四碼公司股票代號。");
  }
  if (new Set(companyCodes).size !== companyCodes.length) {
    fail("INVALID_ARGUMENT", "company_codes 不得包含重複代號。");
  }
  if (!Array.isArray(query.horizons) || query.horizons.length < 1) {
    fail("INVALID_ARGUMENT", "horizons 至少要指定一個交易日視窗。");
  }
  if (
    query.horizons.some((horizon) => !ALLOWED_HORIZONS.has(horizon)) ||
    new Set(query.horizons).size !== query.horizons.length
  ) {
    fail("INVALID_ARGUMENT", "horizons 只能是不重複的 5、20、60、120 子集合。", {
      horizons: query.horizons,
    });
  }
  const horizons = [...query.horizons].sort(
    (left, right) => left - right,
  ) as ReactionHorizon[];
  const pageSize = query.pageSize ?? 10;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) {
    fail("INVALID_ARGUMENT", "page_size 必須是 1 至 10 的整數。", {
      pageSize: query.pageSize,
    });
  }
  if (query.asOf !== "latest") {
    parseIsoDate(query.asOf, "as_of");
    if (query.asOf > today) {
      fail("INVALID_ARGUMENT", "as_of 不得晚於台北今日日期。", { today });
    }
    if (query.asOf < BENCHMARK_SUPPORTED_FROM) {
      fail("INVALID_ARGUMENT", "as_of 早於 benchmark 官方歷史支援範圍。", {
        supportedFrom: BENCHMARK_SUPPORTED_FROM,
      });
    }
  }
  return {
    companyCodes,
    asOf: query.asOf,
    horizons,
    pageSize,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

function requestedMarkets(companies: MasterCompany[]): CompanyMarket[] {
  return (["listed", "otc"] as const).filter((market) =>
    companies.some((company) => company.market === market),
  );
}

function selectedMasterFingerprint(companies: MasterCompany[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        companies.map((company) => ({
          code: company.code,
          name: company.name,
          shortName: company.shortName,
          market: company.market,
          exchange: company.exchange,
          listingDate: company.listingDate,
        })),
      ),
    )
    .digest("hex");
}

function benchmarkMap(histories: BenchmarkHistory[]): Map<CompanyMarket, BenchmarkHistory> {
  return new Map(histories.map((history) => [history.market, history]));
}

function exactBenchmarkAsOf(
  history: BenchmarkHistory,
  requested: string,
): string {
  if (!history.bars.some((bar) => bar.date === requested)) {
    fail("NO_DATA", "as_of 不是指定市場的官方交易日。", {
      market: history.market,
      asOf: requested,
    });
  }
  return requested;
}

function completedSessionDate(
  evidence: CompletedSessionResolverEvidence,
  market: CompanyMarket,
  evaluatedAt: string,
): string {
  const resolution = evidence.marketResolutions.filter(
    (item) => item.market === market,
  );
  const expectedAsOf = completedSessionExpectedAsOfForMarket(evidence, market);
  if (evidence.status === "unresolved") {
    completedSessionFailure(evidence, market, "COMPLETED_SESSION_UNRESOLVED");
  }
  if (
    evidence.resolverId !== "taiwan-equity.completed-session.v1" ||
    evidence.evaluatedAt !== evaluatedAt ||
    evidence.timezone !== "Asia/Taipei" ||
    evidence.markets.length !== 1 ||
    evidence.markets[0] !== market ||
    evidence.marketResolutions.length !== 1 ||
    resolution.length !== 1 ||
    resolution[0]?.status !== "resolved" ||
    evidence.expectedAsOf === null ||
    evidence.expectedAsOf !== expectedAsOf ||
    expectedAsOf === null
  ) {
    completedSessionFailure(
      evidence,
      market,
      "COMPLETED_SESSION_EVIDENCE_MISMATCH",
    );
  }
  return expectedAsOf;
}

function exactResolvedMap(
  values: Array<{ market: CompanyMarket; date: string }>,
): Map<CompanyMarket, string> {
  return new Map(values.map((value) => [value.market, value.date]));
}

function sameResolvedDates(
  left: Array<{ market: CompanyMarket; date: string }>,
  right: Array<{ market: CompanyMarket; date: string }>,
): boolean {
  const leftMap = exactResolvedMap(left);
  const rightMap = exactResolvedMap(right);
  return (
    leftMap.size === rightMap.size &&
    [...leftMap].every(([market, date]) => rightMap.get(market) === date)
  );
}

function estimatedStockWorkUnits(
  company: MasterCompany,
  startDate: string,
  endDate: string,
): number {
  const listingMonth = monthOf(company.listingDate);
  return monthsBetween(startDate, endDate).reduce((units, month) => {
    if (month < listingMonth) {
      return units + (monthEnd(month) >= TWSE_STOCK_SUPPORTED_FROM ? 2 : 1);
    }
    if (month === listingMonth) return units + 2;
    return units + 1;
  }, 0);
}

function uniquePriceSources(values: PriceSource[]): PriceSource[] {
  const seen = new Set<string>();
  return values.filter((source) => {
    const key = `${source.market}:${source.sourceUrl}:${source.dataDate ?? ""}:${source.dataMonth ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueCorporateActionSources(
  values: CorporateActionSource[],
): CorporateActionSource[] {
  const seen = new Set<string>();
  return values.filter((source) => {
    const key = JSON.stringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combinedCorporateActionFingerprint(
  values: LoadedCorporateActionHistory[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...values]
          .sort((left, right) => left.market.localeCompare(right.market))
          .map(({ market, fingerprint }) => ({ market, fingerprint })),
      ),
    )
    .digest("hex");
}

function loadedCorporateActionEvidenceComplete(
  loaded: LoadedCorporateActionHistory,
): boolean {
  const history = loaded.history;
  return (
    history !== null &&
    history.coverage.coverageComplete &&
    history.events
      .filter((event) => event.effectiveDate > history.requestedStart)
      .every(isPriceIndexAdjustableCorporateAction)
  );
}

function noDataPriceSources(error: MopsfinError): PriceSource[] {
  const values = error.details?.sources;
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC dependency 的 NO_DATA sources 格式錯誤。");
  }
  const sources = values.filter((value): value is PriceSource => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const source = value as Partial<PriceSource>;
    return (
      (source.market === "listed" || source.market === "otc") &&
      typeof source.sourceName === "string" &&
      typeof source.sourceUrl === "string" &&
      typeof source.retrievedAt === "string" &&
      Boolean(source.normalization) &&
      typeof source.normalization === "object"
    );
  });
  if (sources.length !== values.length) {
    fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC dependency 的 NO_DATA sources 內容錯誤。");
  }
  return sources;
}

function stockDataFailure(error: MopsfinError): ReactionStockDataFailure {
  const retryable =
    error.retryable ??
    (error.code === "UPSTREAM_TIMEOUT" ||
      error.code === "UPSTREAM_RATE_LIMITED");
  return {
    code: error.code,
    reason: error.reason ?? null,
    message: error.message,
    retryable,
    retryAfterMs: error.retryAfterMs ?? null,
    action: error.action ?? (retryable ? "retry" : "none"),
  };
}

function adjustmentForWindow(
  company: MasterCompany,
  benchmarkWindow: BenchmarkHistory["bars"],
  bars: OhlcBar[],
  observedNames: string[],
  actionHistory: CorporateActionHistory | null,
  companyEvents: CorporateActionEvent[],
): PriceIndexCompatibleSeriesResult {
  return buildPriceIndexCompatibleSeries({
    companyCode: company.code,
    currentCompanyName: company.shortName,
    currentMarket: company.market,
    observedNames: [
      ...observedNames,
      ...companyEvents.map((event) => event.name),
    ],
    bars,
    events: companyEvents,
    coverage: actionHistory?.coverage ?? null,
    windowStartDate: benchmarkWindow[0].date,
    anchorDate: (benchmarkWindow.at(-1) as { date: string }).date,
  });
}

function adjustedCloseMap(
  adjustment: PriceIndexCompatibleSeriesResult,
): Map<string, number> {
  return new Map(
    adjustment.bars.flatMap((bar) =>
      typeof bar.adjusted?.close === "number"
        ? [[bar.date, bar.adjusted.close] as const]
        : [],
    ),
  );
}

function hasAdjustmentReason(
  adjustment: PriceIndexCompatibleSeriesResult,
  reasons: PriceIndexAdjustmentUnknownReason[],
): boolean {
  return reasons.some((reason) => adjustment.unknownReasons.includes(reason));
}

function hasUsableFactorWithPriorCloseFailure(
  adjustment: PriceIndexCompatibleSeriesResult,
): boolean {
  return adjustment.eventLedger.some(
    (ledger) =>
      isPriceIndexAdjustableCorporateAction(ledger.event) &&
      ledger.priorCloseCheck.status !== "matched",
  );
}

function returnComparabilityReasonsFromAdjustment(
  adjustment: PriceIndexCompatibleSeriesResult,
): ExcessReturnComparabilityReason[] {
  const reasons: ExcessReturnComparabilityReason[] = [];
  if (
    adjustment.unknownReasons.includes(
      "corporate_action_coverage_incomplete",
    )
  ) {
    reasons.push("corporate_action_coverage_incomplete");
  }
  if (
    hasAdjustmentReason(adjustment, [
      "corporate_action_factor_unavailable",
      "cash_only_factor_not_one",
      "ambiguous_same_day_corporate_actions",
      "duplicate_raw_bar_date",
    ])
  ) {
    reasons.push("corporate_action_adjustment_unavailable");
  }
  if (hasUsableFactorWithPriorCloseFailure(adjustment)) {
    reasons.push("corporate_action_prior_close_mismatch");
  }
  if (
    adjustment.unknownReasons.includes("unmatched_official_change_marker")
  ) {
    reasons.push("unmatched_official_change_marker_within_horizon");
  }
  if (
    hasAdjustmentReason(adjustment, [
      "market_transition_or_historical_market_mismatch",
      "corporate_action_market_mismatch",
    ])
  ) {
    reasons.push(
      "market_transition_or_historical_market_mismatch_within_horizon",
    );
  }
  if (
    hasAdjustmentReason(adjustment, [
      "company_identity_name_mismatch",
      "corporate_action_company_code_mismatch",
    ])
  ) {
    reasons.push("multiple_observed_names");
  }
  return reasons;
}

function applyReturnComparability(
  signal: ReturnReactionSignal,
  adjustment: PriceIndexCompatibleSeriesResult,
): ReturnReactionSignal {
  if (signal.status !== "available") return signal;
  const reasons = returnComparabilityReasonsFromAdjustment(adjustment);
  return reasons.length === 0
    ? signal
    : {
        ...signal,
        priceIndexCompatibleStockReturnPercent: null,
        corporateActionAdjustmentFactor: null,
        excessReturnPercentagePoints: null,
        excessReturnStatus: "not_comparable",
        excessReturnReasons: reasons,
      };
}

function corporateActionNotComparable(
  signal: AverageWindowSignal,
): AverageWindowSignal {
  return {
    ...signal,
    value: null,
    status: "not_comparable_corporate_action",
  };
}

function volumeWindowComparable(
  signal: { startDate: string; endDate: string },
  company: MasterCompany,
  bars: OhlcBar[],
  observedNames: string[],
  actionHistory: CorporateActionHistory | null,
  companyEvents: CorporateActionEvent[],
): boolean {
  const adjustment = buildPriceIndexCompatibleSeries({
    companyCode: company.code,
    currentCompanyName: company.shortName,
    currentMarket: company.market,
    observedNames,
    bars,
    events: companyEvents,
    coverage: actionHistory?.coverage ?? null,
    windowStartDate: signal.startDate,
    anchorDate: signal.endDate,
  });
  if (
    !adjustment.coverageComplete ||
    adjustment.unmatchedOfficialChangeMarkers.length > 0
  ) {
    return false;
  }
  return !corporateActionEventsWithin(
    companyEvents,
    signal.startDate,
    signal.endDate,
  ).some(
    (event) =>
      event.shareCountChanged ||
      !isPriceIndexAdjustableCorporateAction(event),
  );
}

function comparability(
  company: MasterCompany,
  bars: OhlcBar[],
  observedNames: string[],
  stockDataStatus: ReactionStockDataStatus,
  actionHistory: CorporateActionHistory | null,
  companyEvents: CorporateActionEvent[],
  startDate: string,
  endDate: string,
): ReactionComparability {
  const adjustment = buildPriceIndexCompatibleSeries({
    companyCode: company.code,
    currentCompanyName: company.shortName,
    currentMarket: company.market,
    observedNames: [
      ...observedNames,
      ...companyEvents.map((event) => event.name),
    ],
    bars,
    events: companyEvents,
    coverage: actionHistory?.coverage ?? null,
    windowStartDate: startDate,
    anchorDate: endDate,
  });
  const coverageComplete = adjustment.coverageComplete;
  const hasUnavailableAdjustment = hasAdjustmentReason(adjustment, [
    "corporate_action_factor_unavailable",
    "cash_only_factor_not_one",
    "ambiguous_same_day_corporate_actions",
    "duplicate_raw_bar_date",
  ]);
  const hasPriorCloseMismatch =
    hasUsableFactorWithPriorCloseFailure(adjustment);
  const reasons: ReactionComparability["reasons"] = [];
  if (stockDataStatus === "no_data") reasons.push("no_stock_data");
  if (stockDataStatus === "unavailable") {
    reasons.push("stock_data_unavailable");
  }
  if (!coverageComplete) reasons.push("corporate_action_coverage_incomplete");
  if (hasUnavailableAdjustment) {
    reasons.push("corporate_action_adjustment_unavailable");
  }
  if (hasPriorCloseMismatch) {
    reasons.push("corporate_action_prior_close_mismatch");
  }
  if (adjustment.unmatchedOfficialChangeMarkers.length > 0) {
    reasons.push("unmatched_official_change_marker_present");
  }
  if (
    hasAdjustmentReason(adjustment, [
      "market_transition_or_historical_market_mismatch",
      "corporate_action_market_mismatch",
    ])
  ) {
    reasons.push("market_transition_or_historical_market_mismatch");
  }
  if (hasAdjustmentReason(adjustment, [
    "company_identity_name_mismatch",
    "corporate_action_company_code_mismatch",
  ])) {
    reasons.push("multiple_observed_names");
  }
  return {
    status: stockDataStatus !== "available"
      ? "unavailable"
      : reasons.length > 0
        ? "not_comparable"
        : "price_index_compatible",
    rawPriceBasis: "raw_unadjusted",
    returnBasis: "price_index_compatible_corporate_action_adjusted",
    corporateActionAdjustment:
      !coverageComplete || hasUnavailableAdjustment || hasPriorCloseMismatch
      ? "incomplete"
      : companyEvents.length > 0
        ? "applied"
        : "not_required",
    corporateActionEvidence: !coverageComplete
      ? "official_history_incomplete"
      : companyEvents.length > 0
        ? "official_history_verified_events"
        : "official_history_verified_no_event",
    corporateActionCoverageComplete: coverageComplete,
    marketTransitionDetected: adjustment.marketTransitionDetected,
    observedMarkets: adjustment.observedMarkets,
    corporateActions: companyEvents,
    officialChangeMarkers: adjustment.officialChangeMarkers,
    unmatchedOfficialChangeMarkers:
      adjustment.unmatchedOfficialChangeMarkers,
    reasons,
  };
}

function companySignals(
  company: MasterCompany,
  requestedAsOf: "latest" | string,
  horizons: ReactionHorizon[],
  benchmark: BenchmarkHistory,
  resolvedAsOf: string,
  stock: LoadedStockHistory,
  actionHistory: CorporateActionHistory | null,
  actionFailure: string | null,
): CompanyReactionSignals {
  const barsByDate = new Map(stock.bars.map((bar) => [bar.date, bar]));
  const longestHorizon = horizons.at(-1) as ReactionHorizon;
  const longestBenchmarkWindow = exactSessionWindow(
    benchmark.bars,
    resolvedAsOf,
    longestHorizon + 1,
  );
  const actionEvidenceWindow = exactSessionWindow(
    benchmark.bars,
    resolvedAsOf,
    Math.max(longestHorizon + 1, 20),
  );
  const companyEvents = (actionHistory?.events ?? []).filter(
    (event) =>
      event.companyCode === company.code &&
      event.effectiveDate > actionEvidenceWindow[0].date &&
      event.effectiveDate <= resolvedAsOf,
  );
  const returns = horizons.map((horizon) => {
    const window = exactSessionWindow(
      benchmark.bars,
      resolvedAsOf,
      horizon + 1,
    );
    const adjustment = adjustmentForWindow(
      company,
      window,
      stock.bars,
      stock.observedNames,
      actionHistory,
      companyEvents,
    );
    return applyReturnComparability(
      calculateReturnSignal(
        horizon,
        window,
        barsByDate,
        stock.status,
        adjustedCloseMap(adjustment),
        adjustment.factorAtWindowStart ?? 1,
      ),
      adjustment,
    );
  });
  const rawVolume5 = calculateAverageWindowSignal(
    5,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 5),
    barsByDate,
    "volumeShares",
    stock.status,
  );
  const rawVolume20 = calculateAverageWindowSignal(
    20,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 20),
    barsByDate,
    "volumeShares",
    stock.status,
  );
  const turnover20 = calculateAverageWindowSignal(
    20,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 20),
    barsByDate,
    "turnoverTwd",
    stock.status,
  );
  const turnover60 = calculateAverageWindowSignal(
    60,
    exactSessionWindow(benchmark.bars, resolvedAsOf, 60),
    barsByDate,
    "turnoverTwd",
    stock.status,
  );
  const pathAdjustment = adjustmentForWindow(
    company,
    longestBenchmarkWindow,
    stock.bars,
    stock.observedNames,
    actionHistory,
    companyEvents,
  );
  const rawPricePath = calculatePricePathSignal(
    longestHorizon,
    longestBenchmarkWindow,
    barsByDate,
    stock.status,
    adjustedCloseMap(pathAdjustment),
  );
  const actionPathComparable = pathAdjustment.status === "complete";
  const pricePath = !actionPathComparable && stock.status === "available"
    ? {
        ...rawPricePath,
        maximumDrawdownPercent: null,
        distanceBelowWindowHighPercent: null,
        status: "not_comparable_corporate_action" as const,
      }
    : rawPricePath;
  const comparison = comparability(
    company,
    stock.bars.filter(
      (bar) =>
        bar.date >= actionEvidenceWindow[0].date && bar.date <= resolvedAsOf,
    ),
    stock.observedNames,
    stock.status,
    actionHistory,
    companyEvents,
    actionEvidenceWindow[0].date,
    resolvedAsOf,
  );
  const volume5 =
    rawVolume5.status === "available" &&
    !volumeWindowComparable(
      rawVolume5,
      company,
      stock.bars,
      stock.observedNames,
      actionHistory,
      companyEvents,
    )
      ? corporateActionNotComparable(rawVolume5)
      : rawVolume5;
  const volume20 =
    rawVolume20.status === "available" &&
    !volumeWindowComparable(
      rawVolume20,
      company,
      stock.bars,
      stock.observedNames,
      actionHistory,
      companyEvents,
    )
      ? corporateActionNotComparable(rawVolume20)
      : rawVolume20;
  const volumeRatio = calculateRatioSignal(volume5, volume20);
  const turnoverRatio = calculateRatioSignal(turnover20, turnover60);
  const statuses = [
    ...returns.map((signal) => signal.excessReturnStatus),
    volume5.status,
    volume20.status,
    volumeRatio.status,
    turnover20.status,
    turnover60.status,
    turnoverRatio.status,
    pricePath.status,
  ];
  const warnings: string[] = [];
  if (stock.status === "no_data") {
    warnings.push("指定 exact benchmark 視窗內查無個股官方 OHLC。");
  } else if (stock.status === "unavailable") {
    warnings.push(
      `個股官方 OHLC dependency 無法完成；本公司所有 stock-derived signals 保持 unavailable：${stock.failure?.code ?? "UNKNOWN"}。`,
    );
  } else if (statuses.some((status) => status !== "available")) {
    warnings.push("個股在部分 exact benchmark sessions 缺少必要成交或收盤欄位；相關 signal 為 null。");
  }
  if (actionFailure) {
    warnings.push(`公司行動官方歷史無法驗證；price-compatible signals 為 null：${actionFailure}`);
  } else if (!comparison.corporateActionCoverageComplete) {
    warnings.push("公司行動官方歷史 coverage 不完整；跨越未驗證區間的 price-compatible signals 為 null。");
  }
  if (comparison.unmatchedOfficialChangeMarkers.length > 0) {
    warnings.push("requested 視窗存在無法與官方公司行動結果對上的漲跌註記；受影響 signal 為 null。");
  }
  if (comparison.reasons.includes("corporate_action_adjustment_unavailable")) {
    warnings.push("至少一筆官方公司行動缺少可驗證 factor；跨越該事件的 signal 為 null。");
  }
  if (comparison.reasons.includes("corporate_action_prior_close_mismatch")) {
    warnings.push("至少一筆公司行動的官方事件前收盤無法與 raw OHLC 銜接；跨越該事件的 signal 為 null。");
  }
  if (comparison.marketTransitionDetected) {
    warnings.push("requested return 視窗內市場別與目前母體不一致或跨市場；受影響 horizon 的 excess return 為 null。");
  }
  if (comparison.reasons.includes("multiple_observed_names")) {
    warnings.push("同一代號出現多個公司名稱；可能為改名或代號重用，須先確認 identity。");
  }
  return {
    companyCode: company.code,
    companyName: company.shortName,
    market: company.market,
    benchmarkCode: benchmark.benchmarkCode,
    requestedAsOf,
    resolvedAsOf,
    stockDataStatus: stock.status,
    stockDataFailure: stock.failure,
    returns,
    liquidity: {
      averageVolume5SessionsShares: volume5,
      averageVolume20SessionsShares: volume20,
      volume5To20Ratio: volumeRatio,
      averageTurnover20SessionsTwd: turnover20,
      averageTurnover60SessionsTwd: turnover60,
      turnover20To60Ratio: turnoverRatio,
    },
    pricePath,
    comparability: comparison,
    dataQualityComplete:
      statuses.every((status) => status === "available") &&
      comparison.status === "price_index_compatible",
    warnings,
  };
}

export class ReactionClient {
  private readonly benchmarkClient: BenchmarkLike;
  private readonly corporateActions: CorporateActionLike;
  private readonly completedSessions: CompletedSessionResolverLike;
  private readonly concurrency: number;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CompanyMasterLike = companyMasterClient,
    private readonly stockPrice: StockPriceLike = priceClient,
    options: ReactionClientOptions = {},
  ) {
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 2));
    this.corporateActions = options.corporateActionClient ?? corporateActionClient;
    this.completedSessions =
      options.completedSessionResolver ?? completedSessionResolver;
    this.benchmarkClient =
      options.benchmarkClient ??
      new BenchmarkClient(fetchImpl, now, {
        timeoutMs: options.timeoutMs,
        retryDelayMs: options.retryDelayMs,
        maxAttempts: options.maxAttempts,
        cacheTtlMs: options.cacheTtlMs,
        concurrency: Math.max(
          1,
          Math.min(options.benchmarkConcurrency ?? 4, 4),
        ),
      });
  }

  async getStockReactionSignals(
    query: StockReactionSignalsQuery,
  ): Promise<StockReactionSignalsResult> {
    const evaluatedAt = new Date(this.now().getTime()).toISOString();
    const today = taipeiToday(new Date(evaluatedAt));
    const normalized = normalizeQuery(query, today);
    const master = await this.companyMaster.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    const byCode = new Map(master.companies.map((company) => [company.code, company]));
    const missingCompanyCodes = normalized.companyCodes.filter((code) => !byCode.has(code));
    if (missingCompanyCodes.length > 0) {
      fail("NOT_FOUND", "部分 company_codes 不在目前 TWSE／TPEx 公司母體。", {
        missingCompanyCodes,
        masterSnapshotId: master.snapshotId,
      });
    }
    const requestedCompanies = normalized.companyCodes.map(
      (code) => byCode.get(code) as MasterCompany,
    );
    const masterFingerprint = selectedMasterFingerprint(requestedCompanies);
    const markets = requestedMarkets(requestedCompanies);
    const normalizedForHash = {
      companyCodes: normalized.companyCodes,
      asOf: normalized.asOf,
      horizons: normalized.horizons,
      pageSize: normalized.pageSize,
    };
    const queryHash = reactionQueryHash(normalizedForHash);
    const decodedCursor = normalized.cursor
      ? decodeReactionCursor(normalized.cursor)
      : undefined;
    if (decodedCursor && decodedCursor.queryHash !== queryHash) {
      cursorInvalid("cursor 與本次 reaction 查詢不符。");
    }
    if (decodedCursor && decodedCursor.masterSnapshotId !== master.snapshotId) {
      snapshotChanged("cursor 的公司母體快照已變更，請重新開始查詢。", {
        cursorMasterSnapshotId: decodedCursor.masterSnapshotId,
        currentMasterSnapshotId: master.snapshotId,
      });
    }
    if (decodedCursor && decodedCursor.masterFingerprint !== masterFingerprint) {
      snapshotChanged("cursor 的公司 identity／市場快照已變更，請重新開始查詢。", {
        masterSnapshotId: master.snapshotId,
      });
    }
    const startIndex = decodedCursor?.nextIndex ?? 0;
    if (startIndex < 0 || startIndex >= requestedCompanies.length) {
      cursorInvalid("cursor 的公司續查位置超出查詢範圍。", {
        nextIndex: startIndex,
        companyCount: requestedCompanies.length,
      });
    }

    const completedSessionEvidence =
      normalized.asOf === "latest"
        ? await Promise.all(
            markets.map((market) =>
              this.completedSessions.resolve({ market, evaluatedAt }),
            ),
          )
        : [];
    const latestDateByMarket = new Map(
      completedSessionEvidence.map((evidence) => {
        const market = evidence.markets[0] as CompanyMarket;
        return [
          market,
          completedSessionDate(evidence, market, evaluatedAt),
        ] as const;
      }),
    );
    const completedSessionFingerprint =
      normalized.asOf === "latest"
        ? completedSessionSnapshotFingerprint(completedSessionEvidence)
        : null;
    if (
      decodedCursor &&
      decodedCursor.completedSessionFingerprint !== completedSessionFingerprint
    ) {
      snapshotChanged(
        "cursor 釘住的 authoritative completed-session evidence 已變更，請重新開始查詢。",
      );
    }

    const largestRequiredSessionSpan = Math.max(
      normalized.horizons.at(-1) as ReactionHorizon,
      59,
    );
    const latestRangeEnd = [...latestDateByMarket.values()].sort().at(-1);
    const rangeEnd =
      decodedCursor?.rangeEnd ??
      (normalized.asOf === "latest"
        ? (latestRangeEnd as string)
        : normalized.asOf);
    if (
      decodedCursor &&
      (rangeEnd > today ||
        (normalized.asOf !== "latest" && rangeEnd !== normalized.asOf))
    ) {
      cursorInvalid("cursor 的釘住日期與本次 as_of 不符。", {
        cursorRangeEnd: rangeEnd,
        asOf: normalized.asOf,
        today,
      });
    }
    const calculatedStart = subtractDays(
      rangeEnd,
      Math.ceil(largestRequiredSessionSpan * 7 / 5) + 31,
    );
    const expectedRangeStart =
      calculatedStart < BENCHMARK_SUPPORTED_FROM
        ? BENCHMARK_SUPPORTED_FROM
        : calculatedStart;
    if (decodedCursor && decodedCursor.rangeStart !== expectedRangeStart) {
      cursorInvalid("cursor 的 benchmark 視窗與本次查詢不符。", {
        cursorRangeStart: decodedCursor.rangeStart,
        expectedRangeStart,
      });
    }
    const rangeStart = decodedCursor?.rangeStart ?? expectedRangeStart;
    const benchmarkMonths = monthsBetween(rangeStart, rangeEnd);

    const histories: BenchmarkHistory[] = [];
    for (const market of markets) {
      histories.push(await this.benchmarkClient.getHistory(market, benchmarkMonths));
    }
    const historyByMarket = benchmarkMap(histories);
    const resolvedByMarket = markets.map((market) => {
      const history = historyByMarket.get(market) as BenchmarkHistory;
      return {
        market,
        date: exactBenchmarkAsOf(
          history,
          normalized.asOf === "latest"
            ? (latestDateByMarket.get(market) as string)
            : normalized.asOf,
        ),
      };
    });
    if (
      decodedCursor &&
      !sameResolvedDates(decodedCursor.resolvedByMarket, resolvedByMarket)
    ) {
      snapshotChanged("cursor 釘住的 benchmark as-of 已無法重現，請重新查詢。", {
        cursorResolvedByMarket: decodedCursor.resolvedByMarket,
        currentResolvedByMarket: resolvedByMarket,
      });
    }
    const requiredObservationCount = Math.max(
      (normalized.horizons.at(-1) as ReactionHorizon) + 1,
      60,
    );
    const corporateActionObservationCount = Math.max(
      (normalized.horizons.at(-1) as ReactionHorizon) + 1,
      20,
    );
    for (const { market, date } of resolvedByMarket) {
      const bars = (historyByMarket.get(market) as BenchmarkHistory).bars;
      const endIndex = bars.findIndex((bar) => bar.date === date);
      if (endIndex < 0 || endIndex + 1 < requiredObservationCount) {
        fail("NO_DATA", "benchmark 不足以形成 requested exact-session 視窗。", {
          market,
          resolvedAsOf: date,
          requiredObservationCount,
          availableObservationCount: Math.max(0, endIndex + 1),
        });
      }
    }
    const fingerprint = benchmarkFingerprint(
      histories.map((history) => ({
        market: history.market,
        bars: history.bars.filter(
          (bar) => bar.date <= rangeEnd,
        ),
      })),
    );
    if (decodedCursor && decodedCursor.benchmarkFingerprint !== fingerprint) {
      snapshotChanged("cursor 釘住的 benchmark 資料已變更，請重新開始查詢。");
    }

    const resolvedMap = exactResolvedMap(resolvedByMarket);
    const benchmarkUnits = benchmarkMonths.length * markets.length;
    const plannedCompanies: PlannedCompany[] = [];
    let stockUnits = 0;
    for (let index = startIndex; index < requestedCompanies.length; index += 1) {
      if (plannedCompanies.length >= normalized.pageSize) break;
      const company = requestedCompanies[index];
      const history = historyByMarket.get(company.market) as BenchmarkHistory;
      const resolved = resolvedMap.get(company.market) as string;
      const startDate = exactSessionWindow(
        history.bars,
        resolved,
        requiredObservationCount,
      )[0].date;
      const workUnits = estimatedStockWorkUnits(company, startDate, resolved);
      if (benchmarkUnits + stockUnits + workUnits > WORK_UNIT_LIMIT) break;
      plannedCompanies.push({
        company,
        startDate,
        endDate: resolved,
        workUnits,
      });
      stockUnits += workUnits;
    }
    if (plannedCompanies.length === 0) {
      workBudgetExceeded("單一公司 reaction 查詢已超過每頁 48 work units。", {
        benchmarkUnits,
        firstCompanyCode: requestedCompanies[startIndex].code,
      });
    }

    const [loadedStocks, loadedCorporateActions] = await Promise.all([
      mapWithConcurrency(
        plannedCompanies,
        this.concurrency,
        (plan) => this.loadStockHistory(plan),
      ),
      Promise.all(
        markets.map((market) => {
          // Keep the corporate-action scope identical on every stateless page.
          // The returned fingerprint includes selected TWSE combined-event
          // details, so limiting this to plannedCompanies would make the
          // fingerprint (and its evidence) change merely because the cursor
          // advanced to a different company page.
          const companyCodes = requestedCompanies
            .filter((company) => company.market === market)
            .map((company) => company.code);
          const benchmark = historyByMarket.get(market) as BenchmarkHistory;
          const resolved = resolvedMap.get(market) as string;
          const actionStart = exactSessionWindow(
            benchmark.bars,
            resolved,
            corporateActionObservationCount,
          )[0].date;
          return this.loadCorporateActionHistory(
            market,
            actionStart,
            resolved,
            companyCodes,
          );
        }),
      ),
    ]);
    const corporateActionFingerprint = combinedCorporateActionFingerprint(
      loadedCorporateActions,
    );
    if (
      decodedCursor &&
      decodedCursor.corporateActionFingerprint !== corporateActionFingerprint
    ) {
      snapshotChanged(
        "cursor 釘住的公司行動官方歷史已變更，請重新開始查詢。",
      );
    }
    const corporateActionByMarket = new Map(
      loadedCorporateActions.map((loaded) => [loaded.market, loaded]),
    );
    const companies = plannedCompanies.map((plan, index) => {
      const benchmark = historyByMarket.get(plan.company.market) as BenchmarkHistory;
      const actions = corporateActionByMarket.get(
        plan.company.market,
      ) as LoadedCorporateActionHistory;
      return companySignals(
        plan.company,
        normalized.asOf,
        normalized.horizons,
        benchmark,
        plan.endDate,
        loadedStocks[index],
        actions.history,
        actions.failure,
      );
    });
    const nextIndex = startIndex + plannedCompanies.length;
    const hasMore = nextIndex < requestedCompanies.length;
    const cursorPayload: Omit<ReactionCursorPayload, "nextIndex"> = {
      version: 3,
      queryHash,
      masterSnapshotId: master.snapshotId,
      masterFingerprint,
      rangeStart,
      rangeEnd,
      resolvedByMarket,
      completedSessionFingerprint,
      benchmarkFingerprint: fingerprint,
      corporateActionFingerprint,
    };
    const snapshotId = createHash("sha256")
      .update(JSON.stringify(cursorPayload))
      .digest("hex")
      .slice(0, 24);
    const dataQualityComplete = companies.every(
      (company) => company.dataQualityComplete,
    );
    const corporateActionHistoryComplete = loadedCorporateActions.every(
      loadedCorporateActionEvidenceComplete,
    );
    const corporateActionSources = uniqueCorporateActionSources(
      loadedCorporateActions.flatMap((loaded) => loaded.history?.sources ?? []),
    );
    const warnings = [
      "stockReturnPercent 保留 raw unadjusted 原始報酬；priceIndexCompatibleStockReturnPercent 才用官方 actual-result factor 移除股數變動的機械斷點。",
      "現金股利造成的價格效果會保留，以維持和官方 price index 一致；這不是 adjusted close 或 total shareholder return。",
      "N-session 報酬只使用 benchmark 交易日曆的 exact 起訖日期；個股缺少任一錨點時不以前一成交日代填。",
      "只有 TWSE／TPEx 公司行動實際計算結果可產生 factor；coverage、factor 或 marker reconciliation 不完整時回 null／not_comparable，不猜測。",
    ];
    if (hasMore) {
      warnings.push("本頁受 48 work-unit 上限限制；請使用 nextCursor 續查其餘公司。");
    }
    if (!dataQualityComplete) {
      warnings.push("部分公司無法形成完整 exact-session signals；請依各 signal status 判斷。");
    }
    if (!corporateActionHistoryComplete) {
      warnings.push("至少一個市場的公司行動官方歷史 coverage 不完整，或 requested-company event 缺少可用 adjustment factor；相關 price-compatible signals 不可比較。");
    }
    return {
      query: normalizedForHash,
      timezone: "Asia/Taipei",
      currency: "TWD",
      priceBasis: "raw_unadjusted",
      returnBasis: "price_index_compatible_corporate_action_adjusted",
      benchmarkBasis: "price_index",
      asOf: {
        requested: normalized.asOf,
        resolvedByMarket,
        completedSessionEvidence,
      },
      coverage: {
        selectionComplete: true,
        benchmarkHistoryComplete: true,
        corporateActionHistoryComplete,
        dataQualityComplete,
        missingCompanyCodes: [],
      },
      pagination: {
        snapshotId,
        requestedCompanyCount: requestedCompanies.length,
        requestedPageSize: normalized.pageSize,
        pageStartIndex: startIndex,
        returnedCompanyCount: companies.length,
        nextCompanyIndex: nextIndex,
        hasMore,
        nextCursor: hasMore
          ? encodeReactionCursor({ ...cursorPayload, nextIndex })
          : null,
      },
      workBudget: {
        limit: WORK_UNIT_LIMIT,
        consumed: benchmarkUnits + stockUnits,
        benchmarkUnits,
        stockUnits,
        unitDefinition: "one_official_market_month_request",
        corporateActionRequests: loadedCorporateActions.reduce(
          (sum, loaded) => sum + loaded.requestCount,
          0,
        ),
        corporateActionRequestDefinition: "one_official_range_or_detail_request",
      },
      companies,
      benchmarkSources: histories.flatMap((history) => history.sources),
      stockSources: uniquePriceSources(
        loadedStocks.flatMap((stock) => stock.sources),
      ),
      corporateActionSources,
      warnings,
    };
  }

  private async loadCorporateActionHistory(
    market: CompanyMarket,
    startDate: string,
    endDate: string,
    companyCodes: string[],
  ): Promise<LoadedCorporateActionHistory> {
    try {
      const history = await this.corporateActions.getHistory(
        market,
        startDate,
        endDate,
        companyCodes.length > 0 ? { companyCodes } : undefined,
      );
      if (
        history.market !== market ||
        history.requestedStart !== startDate ||
        history.requestedEnd !== endDate ||
        !/^[a-f0-9]{64}$/.test(history.fingerprint)
      ) {
        fail(
          "UPSTREAM_BAD_RESPONSE",
          "公司行動 dependency 回傳查詢 scope 或 fingerprint 不一致。",
          {
            requestedMarket: market,
            returnedMarket: history.market,
            requestedStart: startDate,
            returnedStart: history.requestedStart,
            requestedEnd: endDate,
            returnedEnd: history.requestedEnd,
          },
        );
      }
      return {
        market,
        history,
        fingerprint: history.fingerprint,
        requestCount: history.requestCount,
        failure: null,
      };
    } catch (error) {
      const code = error instanceof MopsfinError ? error.code : "UNKNOWN";
      const message = error instanceof Error ? error.message : String(error);
      return {
        market,
        history: null,
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              market,
              startDate,
              endDate,
              status: "unavailable",
              code,
            }),
          )
          .digest("hex"),
        requestCount: corporateActionBaseRequestCount(market, endDate),
        failure: `${code}: ${message}`,
      };
    }
  }

  private async loadStockHistory(plan: PlannedCompany): Promise<LoadedStockHistory> {
    const barsByDate = new Map<string, OhlcBar>();
    const observedNames = new Set<string>();
    const sources: PriceSource[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let coveredThrough: string | null = null;
    try {
      for (let page = 0; page < 24; page += 1) {
        const dependencyQuery: StockOhlcQuery = {
          companyCode: plan.company.code,
          startDate: plan.startDate,
          endDate: plan.endDate,
          ...(cursor ? { cursor } : {}),
        };
        const result = await this.stockPrice.getStockOhlc(dependencyQuery);
        validateAndAppendRawOhlcPage(
          result,
          dependencyQuery,
          cursor,
          coveredThrough,
          barsByDate,
        );
        for (const name of result.observedNames) observedNames.add(name);
        sources.push(...result.sources);
        coveredThrough = result.coverage.coveredThrough;
        if (result.coverage.coverageComplete) {
          const bars = [...barsByDate.values()].sort((left, right) =>
            left.date.localeCompare(right.date),
          );
          return {
            status: bars.length === 0 ? "no_data" : "available",
            bars,
            observedNames:
              observedNames.size > 0
                ? [...observedNames]
                : [plan.company.shortName],
            sources: uniquePriceSources(sources),
            failure: null,
          };
        }
        const nextCursor = result.coverage.nextCursor;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC 分頁 cursor 未前進。", {
            companyCode: plan.company.code,
          });
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      fail("UPSTREAM_BAD_RESPONSE", "個股 OHLC 分頁超過安全上限。", {
        companyCode: plan.company.code,
      });
    } catch (error) {
      if (!(error instanceof MopsfinError)) throw error;
      if (error.code === "NO_DATA") {
        let explicitNoDataSources: PriceSource[];
        try {
          explicitNoDataSources = noDataPriceSources(error);
        } catch (sourceError) {
          if (!(sourceError instanceof MopsfinError)) throw sourceError;
          return {
            status: "unavailable",
            bars: [],
            observedNames: [plan.company.shortName],
            sources: uniquePriceSources(sources),
            failure: stockDataFailure(sourceError),
          };
        }
        return {
          status: "no_data",
          bars: [],
          observedNames: [plan.company.shortName],
          sources: uniquePriceSources([
            ...sources,
            ...explicitNoDataSources,
          ]),
          failure: null,
        };
      }
      return {
        status: "unavailable",
        bars: [],
        observedNames: [plan.company.shortName],
        sources: uniquePriceSources(sources),
        failure: stockDataFailure(error),
      };
    }
  }
}

export const reactionClient = new ReactionClient();
