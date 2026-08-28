import type { CompanyMarket } from "@/lib/company-master/types";
import type { OhlcBar } from "@/lib/price/types";

import type {
  CorporateActionCoverage,
  CorporateActionEvent,
} from "./types";

export type PriceIndexAdjustmentUnknownReason =
  | "corporate_action_coverage_incomplete"
  | "corporate_action_factor_unavailable"
  | "cash_only_factor_not_one"
  | "ambiguous_same_day_corporate_actions"
  | "corporate_action_prior_close_missing"
  | "corporate_action_prior_close_mismatch"
  | "unmatched_official_change_marker"
  | "market_transition_or_historical_market_mismatch"
  | "corporate_action_market_mismatch"
  | "company_identity_name_mismatch"
  | "corporate_action_company_code_mismatch"
  | "duplicate_raw_bar_date";

export interface PriceIndexAdjustmentInput {
  companyCode: string;
  currentCompanyName: string;
  currentMarket: CompanyMarket;
  observedNames: string[];
  bars: OhlcBar[];
  events: CorporateActionEvent[];
  coverage: CorporateActionCoverage | null;
  windowStartDate: string;
  anchorDate: string;
}

export interface PriceIndexAdjustedOhlc {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

export interface PriceIndexAdjustedBar extends OhlcBar {
  cumulativeFactor: number | null;
  adjusted: PriceIndexAdjustedOhlc | null;
  adjustmentStatus: "complete" | "unknown";
  unknownReasons: PriceIndexAdjustmentUnknownReason[];
  volumeBasis: "raw_shares";
}

export interface CorporateActionPriorCloseCheck {
  status:
    | "matched"
    | "official_prior_close_missing"
    | "raw_prior_close_missing"
    | "mismatch";
  officialPriorCloseTwd: number | null;
  observedPriorCloseDate: string | null;
  observedPriorCloseTwd: number | null;
  toleranceTwd: number | null;
}

export interface CorporateActionEventLedgerEntry {
  event: CorporateActionEvent;
  status: "applied" | "unknown";
  factor: number | null;
  priorCloseCheck: CorporateActionPriorCloseCheck;
  markerReconciliation: {
    status: "matched" | "not_present";
    marker: string | null;
  };
  unknownReasons: PriceIndexAdjustmentUnknownReason[];
}

export interface OfficialAdjustmentChangeMarker {
  date: string;
  marker: string;
}

export interface PriceIndexCompatibleSeriesResult {
  status: "complete" | "unknown";
  windowStartDate: string;
  anchorDate: string;
  adjustmentDirection: "backward";
  priceBasis: "price_index_compatible_corporate_action_adjusted";
  cashDividendTreatment: "retained";
  isAdjustedClose: false;
  isTotalReturn: false;
  volumeAdjusted: false;
  volumeBasis: "raw_shares";
  coverageComplete: boolean;
  factorAtWindowStart: number | null;
  bars: PriceIndexAdjustedBar[];
  eventLedger: CorporateActionEventLedgerEntry[];
  officialChangeMarkers: OfficialAdjustmentChangeMarker[];
  unmatchedOfficialChangeMarkers: OfficialAdjustmentChangeMarker[];
  unknownReasons: PriceIndexAdjustmentUnknownReason[];
  observedMarkets: CompanyMarket[];
  marketTransitionDetected: boolean;
}

const REASON_ORDER: PriceIndexAdjustmentUnknownReason[] = [
  "corporate_action_coverage_incomplete",
  "corporate_action_factor_unavailable",
  "cash_only_factor_not_one",
  "ambiguous_same_day_corporate_actions",
  "corporate_action_prior_close_missing",
  "corporate_action_prior_close_mismatch",
  "unmatched_official_change_marker",
  "market_transition_or_historical_market_mismatch",
  "corporate_action_market_mismatch",
  "company_identity_name_mismatch",
  "corporate_action_company_code_mismatch",
  "duplicate_raw_bar_date",
];

function orderedReasons(
  reasons: Iterable<PriceIndexAdjustmentUnknownReason>,
): PriceIndexAdjustmentUnknownReason[] {
  const selected = new Set(reasons);
  return REASON_ORDER.filter((reason) => selected.has(reason));
}

export function corporateActionEventsWithin(
  events: CorporateActionEvent[],
  startDate: string,
  endDate: string,
): CorporateActionEvent[] {
  return events.filter(
    (event) => event.effectiveDate > startDate && event.effectiveDate <= endDate,
  );
}

function officialMarkersWithin(
  bars: OhlcBar[],
  startDate: string,
  endDate: string,
): OfficialAdjustmentChangeMarker[] {
  return bars
    .filter(
      (bar) =>
        bar.date >= startDate &&
        bar.date <= endDate &&
        bar.changeMarker !== null,
    )
    .map((bar) => ({ date: bar.date, marker: bar.changeMarker as string }));
}

export function checkCorporateActionPriorClose(
  event: CorporateActionEvent,
  bars: OhlcBar[],
): CorporateActionPriorCloseCheck {
  const official = event.priorCloseTwd;
  const previous = bars
    .filter(
      (bar) =>
        bar.date < event.effectiveDate &&
        typeof bar.close === "number" &&
        Number.isFinite(bar.close) &&
        bar.close > 0,
    )
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1);
  if (
    typeof official !== "number" ||
    !Number.isFinite(official) ||
    official <= 0
  ) {
    return {
      status: "official_prior_close_missing",
      officialPriorCloseTwd: official,
      observedPriorCloseDate: previous?.date ?? null,
      observedPriorCloseTwd: previous?.close ?? null,
      toleranceTwd: null,
    };
  }
  const toleranceTwd = Math.max(1e-6, official * 1e-8);
  if (!previous || typeof previous.close !== "number") {
    return {
      status: "raw_prior_close_missing",
      officialPriorCloseTwd: official,
      observedPriorCloseDate: null,
      observedPriorCloseTwd: null,
      toleranceTwd,
    };
  }
  return {
    status:
      Math.abs(previous.close - official) <= toleranceTwd
        ? "matched"
        : "mismatch",
    officialPriorCloseTwd: official,
    observedPriorCloseDate: previous.date,
    observedPriorCloseTwd: previous.close,
    toleranceTwd,
  };
}

function numericFactor(event: CorporateActionEvent): number | null {
  const factor = event.priceIndexAdjustmentFactor;
  return event.adjustmentStatus === "available" &&
    typeof factor === "number" &&
    Number.isFinite(factor) &&
    factor > 0
    ? factor
    : null;
}

export function isPriceIndexAdjustableCorporateAction(
  event: CorporateActionEvent,
): boolean {
  const factor = numericFactor(event);
  return factor !== null && (event.kind !== "cash_dividend" || factor === 1);
}

function ambiguousActionKeys(events: CorporateActionEvent[]): Set<string> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = `${event.companyCode}:${event.effectiveDate}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    [...counts]
      .filter(([, count]) => count > 1)
      .map(([key]) => key),
  );
}

function coverageComplete(
  coverage: CorporateActionCoverage | null,
  windowStartDate: string,
  anchorDate: string,
): boolean {
  return (
    coverage?.coverageComplete === true &&
    coverage.requestedStart <= windowStartDate &&
    coverage.requestedEnd >= anchorDate
  );
}

function adjustedPrice(value: number | null, factor: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value * factor
    : null;
}

function reasonsForDate(
  date: string,
  globalReasons: PriceIndexAdjustmentUnknownReason[],
  eventLedger: CorporateActionEventLedgerEntry[],
  unmatchedMarkers: OfficialAdjustmentChangeMarker[],
): PriceIndexAdjustmentUnknownReason[] {
  const reasons: PriceIndexAdjustmentUnknownReason[] = globalReasons.filter(
    (reason) =>
      reason !== "corporate_action_factor_unavailable" &&
      reason !== "cash_only_factor_not_one" &&
      reason !== "ambiguous_same_day_corporate_actions" &&
      reason !== "corporate_action_prior_close_missing" &&
      reason !== "corporate_action_prior_close_mismatch" &&
      reason !== "unmatched_official_change_marker",
  );
  for (const ledger of eventLedger) {
    if (ledger.event.effectiveDate > date) {
      reasons.push(...ledger.unknownReasons);
    }
  }
  if (unmatchedMarkers.some((marker) => marker.date > date)) {
    reasons.push("unmatched_official_change_marker");
  }
  return orderedReasons(reasons);
}

function factorForDate(
  date: string,
  eventLedger: CorporateActionEventLedgerEntry[],
  reasons: PriceIndexAdjustmentUnknownReason[],
): number | null {
  if (reasons.length > 0) return null;
  return eventLedger
    .filter((ledger) => ledger.event.effectiveDate > date)
    .reduce((product, ledger) => product * (ledger.factor as number), 1);
}

export function buildPriceIndexCompatibleSeries(
  input: PriceIndexAdjustmentInput,
): PriceIndexCompatibleSeriesResult {
  const bars = input.bars
    .filter(
      (bar) =>
        bar.date >= input.windowStartDate && bar.date <= input.anchorDate,
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  const events = corporateActionEventsWithin(
    input.events,
    input.windowStartDate,
    input.anchorDate,
  ).sort(
    (left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate) ||
      left.sourceFamily.localeCompare(right.sourceFamily) ||
      left.rawType.localeCompare(right.rawType),
  );
  const officialChangeMarkers = officialMarkersWithin(
    bars,
    input.windowStartDate,
    input.anchorDate,
  );
  const eventDates = new Set(events.map((event) => event.effectiveDate));
  const unmatchedOfficialChangeMarkers = officialChangeMarkers.filter(
    (marker) =>
      marker.date > input.windowStartDate && !eventDates.has(marker.date),
  );
  const markersByDate = new Map(
    officialChangeMarkers.map((marker) => [marker.date, marker.marker]),
  );
  const ambiguousKeys = ambiguousActionKeys(events);

  const eventLedger = events.map((event): CorporateActionEventLedgerEntry => {
    const reasons: PriceIndexAdjustmentUnknownReason[] = [];
    const factor = numericFactor(event);
    const check = checkCorporateActionPriorClose(event, bars);
    if (event.companyCode !== input.companyCode) {
      reasons.push("corporate_action_company_code_mismatch");
    }
    if (event.market !== input.currentMarket) {
      reasons.push("corporate_action_market_mismatch");
    }
    if (event.name.trim() !== input.currentCompanyName.trim()) {
      reasons.push("company_identity_name_mismatch");
    }
    if (ambiguousKeys.has(`${event.companyCode}:${event.effectiveDate}`)) {
      reasons.push("ambiguous_same_day_corporate_actions");
    }
    if (factor === null) {
      reasons.push("corporate_action_factor_unavailable");
    } else if (event.kind === "cash_dividend" && factor !== 1) {
      reasons.push("cash_only_factor_not_one");
    }
    if (
      check.status === "official_prior_close_missing" ||
      check.status === "raw_prior_close_missing"
    ) {
      reasons.push("corporate_action_prior_close_missing");
    } else if (check.status === "mismatch") {
      reasons.push("corporate_action_prior_close_mismatch");
    }
    const unknownReasons = orderedReasons(reasons);
    const marker = markersByDate.get(event.effectiveDate) ?? null;
    return {
      event,
      status: unknownReasons.length === 0 ? "applied" : "unknown",
      factor: unknownReasons.length === 0 ? factor : null,
      priorCloseCheck: check,
      markerReconciliation: {
        status: marker === null ? "not_present" : "matched",
        marker,
      },
      unknownReasons,
    };
  });

  const observedMarkets = (["listed", "otc"] as const).filter((market) =>
    bars.some((bar) => bar.market === market),
  );
  const marketTransitionDetected =
    observedMarkets.length > 1 ||
    observedMarkets.some((market) => market !== input.currentMarket);
  const nameMismatch =
    new Set(
      [
        input.currentCompanyName,
        ...input.observedNames,
        ...events.map((event) => event.name),
      ].map((name) => name.trim()),
    ).size > 1;
  const barDateCounts = new Map<string, number>();
  for (const bar of bars) {
    barDateCounts.set(bar.date, (barDateCounts.get(bar.date) ?? 0) + 1);
  }
  const hasDuplicateBarDate = [...barDateCounts.values()].some(
    (count) => count > 1,
  );
  const globalReasons: PriceIndexAdjustmentUnknownReason[] = [];
  const completeCoverage = coverageComplete(
    input.coverage,
    input.windowStartDate,
    input.anchorDate,
  );
  if (!completeCoverage) {
    globalReasons.push("corporate_action_coverage_incomplete");
  }
  globalReasons.push(...eventLedger.flatMap((ledger) => ledger.unknownReasons));
  if (unmatchedOfficialChangeMarkers.length > 0) {
    globalReasons.push("unmatched_official_change_marker");
  }
  if (marketTransitionDetected) {
    globalReasons.push("market_transition_or_historical_market_mismatch");
  }
  if (events.some((event) => event.market !== input.currentMarket)) {
    globalReasons.push("corporate_action_market_mismatch");
  }
  if (nameMismatch) {
    globalReasons.push("company_identity_name_mismatch");
  }
  if (events.some((event) => event.companyCode !== input.companyCode)) {
    globalReasons.push("corporate_action_company_code_mismatch");
  }
  if (hasDuplicateBarDate) {
    globalReasons.push("duplicate_raw_bar_date");
  }
  const unknownReasons = orderedReasons(globalReasons);
  const adjustedBars = bars.map((bar): PriceIndexAdjustedBar => {
    const barReasons = reasonsForDate(
      bar.date,
      unknownReasons,
      eventLedger,
      unmatchedOfficialChangeMarkers,
    );
    const cumulativeFactor = factorForDate(
      bar.date,
      eventLedger,
      barReasons,
    );
    return {
      ...bar,
      cumulativeFactor,
      adjusted:
        cumulativeFactor === null
          ? null
          : {
              open: adjustedPrice(bar.open, cumulativeFactor),
              high: adjustedPrice(bar.high, cumulativeFactor),
              low: adjustedPrice(bar.low, cumulativeFactor),
              close: adjustedPrice(bar.close, cumulativeFactor),
            },
      adjustmentStatus: cumulativeFactor === null ? "unknown" : "complete",
      unknownReasons: barReasons,
      volumeBasis: "raw_shares",
    };
  });
  const startReasons = reasonsForDate(
    input.windowStartDate,
    unknownReasons,
    eventLedger,
    unmatchedOfficialChangeMarkers,
  );
  return {
    status: unknownReasons.length === 0 ? "complete" : "unknown",
    windowStartDate: input.windowStartDate,
    anchorDate: input.anchorDate,
    adjustmentDirection: "backward",
    priceBasis: "price_index_compatible_corporate_action_adjusted",
    cashDividendTreatment: "retained",
    isAdjustedClose: false,
    isTotalReturn: false,
    volumeAdjusted: false,
    volumeBasis: "raw_shares",
    coverageComplete: completeCoverage,
    factorAtWindowStart: factorForDate(
      input.windowStartDate,
      eventLedger,
      startReasons,
    ),
    bars: adjustedBars,
    eventLedger,
    officialChangeMarkers,
    unmatchedOfficialChangeMarkers,
    unknownReasons,
    observedMarkets,
    marketTransitionDetected,
  };
}
