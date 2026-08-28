import { describe, expect, it } from "vitest";

import {
  buildPriceIndexCompatibleSeries,
  corporateActionEventsWithin,
  type PriceIndexAdjustmentInput,
} from "@/lib/corporate-actions/adjustment-engine";
import type {
  CorporateActionCoverage,
  CorporateActionEvent,
} from "@/lib/corporate-actions/types";
import type { OhlcBar } from "@/lib/price/types";

function bar(
  date: string,
  close: number,
  options: Partial<OhlcBar> = {},
): OhlcBar {
  return {
    date,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volumeShares: 1_000,
    turnoverTwd: close * 1_000,
    tradeCount: 100,
    change: 1,
    changeMarker: null,
    market: "listed",
    status: "traded",
    qualityStatus: "complete",
    missingFields: [],
    ...options,
  };
}

function event(
  overrides: Partial<CorporateActionEvent> = {},
): CorporateActionEvent {
  return {
    companyCode: "2330",
    name: "台積電",
    market: "listed",
    effectiveDate: "2026-01-05",
    kind: "stock_rights",
    priorCloseTwd: 100,
    referencePriceTwd: 50,
    cashDividendPerShareTwd: 0,
    priceIndexAdjustmentFactor: 0.5,
    shareCountChanged: true,
    adjustmentStatus: "available",
    adjustmentReason: "official_reference_price_divided_by_prior_close",
    sourceFamily: "ex_right_dividend",
    sourceUrl: "https://example.test/action",
    rawType: "權",
    ...overrides,
  };
}

function coverage(
  overrides: Partial<CorporateActionCoverage> = {},
): CorporateActionCoverage {
  return {
    status: "complete",
    coverageComplete: true,
    requestedStart: "2026-01-02",
    requestedEnd: "2026-01-06",
    gaps: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<PriceIndexAdjustmentInput> = {},
): PriceIndexAdjustmentInput {
  return {
    companyCode: "2330",
    currentCompanyName: "台積電",
    currentMarket: "listed",
    observedNames: ["台積電"],
    bars: [
      bar("2026-01-02", 100),
      bar("2026-01-05", 50, { changeMarker: "X" }),
      bar("2026-01-06", 55),
    ],
    events: [event()],
    coverage: coverage(),
    windowStartDate: "2026-01-02",
    anchorDate: "2026-01-06",
    ...overrides,
  };
}

describe("buildPriceIndexCompatibleSeries", () => {
  it("keeps raw price scale at factor one when verified history has no events", () => {
    const bars = input().bars.map((item) => ({
      ...item,
      changeMarker: null,
    }));
    const result = buildPriceIndexCompatibleSeries(
      input({ bars, events: [] }),
    );

    expect(result).toMatchObject({
      status: "complete",
      factorAtWindowStart: 1,
      eventLedger: [],
      unknownReasons: [],
    });
    expect(result.bars.map((item) => item.cumulativeFactor)).toEqual([1, 1, 1]);
    expect(result.bars.map((item) => item.adjusted?.close)).toEqual(
      bars.map((item) => item.close),
    );
  });

  it("backward-adjusts OHLC with the verified official factor and leaves volume raw", () => {
    const result = buildPriceIndexCompatibleSeries(input());

    expect(result).toMatchObject({
      status: "complete",
      adjustmentDirection: "backward",
      priceBasis: "price_index_compatible_corporate_action_adjusted",
      cashDividendTreatment: "retained",
      isAdjustedClose: false,
      isTotalReturn: false,
      volumeAdjusted: false,
      volumeBasis: "raw_shares",
      factorAtWindowStart: 0.5,
      unknownReasons: [],
      unmatchedOfficialChangeMarkers: [],
    });
    expect(result.bars[0]).toMatchObject({
      date: "2026-01-02",
      close: 100,
      volumeShares: 1_000,
      cumulativeFactor: 0.5,
      adjusted: { open: 49.5, high: 50.5, low: 49, close: 50 },
      adjustmentStatus: "complete",
      unknownReasons: [],
      volumeBasis: "raw_shares",
    });
    expect(result.bars[1]).toMatchObject({
      date: "2026-01-05",
      cumulativeFactor: 1,
      adjusted: { close: 50 },
    });
    expect(result.eventLedger[0]).toMatchObject({
      status: "applied",
      factor: 0.5,
      priorCloseCheck: {
        status: "matched",
        officialPriorCloseTwd: 100,
        observedPriorCloseDate: "2026-01-02",
        observedPriorCloseTwd: 100,
      },
      markerReconciliation: { status: "matched", marker: "X" },
      unknownReasons: [],
    });
  });

  it("keeps a cash-only event at factor one instead of creating total return", () => {
    const cashEvent = event({
      kind: "cash_dividend",
      referencePriceTwd: 95,
      cashDividendPerShareTwd: 5,
      priceIndexAdjustmentFactor: 1,
      shareCountChanged: false,
      adjustmentReason: "cash_only_price_index_factor_is_one",
      rawType: "息",
    });
    const result = buildPriceIndexCompatibleSeries(input({ events: [cashEvent] }));

    expect(result.status).toBe("complete");
    expect(result.factorAtWindowStart).toBe(1);
    expect(result.bars[0].adjusted?.close).toBe(100);
    expect(result.eventLedger[0]).toMatchObject({
      status: "applied",
      factor: 1,
    });

    const invalid = buildPriceIndexCompatibleSeries(
      input({
        events: [
          {
            ...cashEvent,
            priceIndexAdjustmentFactor: 0.95,
          },
        ],
      }),
    );
    expect(invalid.unknownReasons).toContain("cash_only_factor_not_one");
    expect(invalid.bars[0]).toMatchObject({
      cumulativeFactor: null,
      adjusted: null,
      adjustmentStatus: "unknown",
    });
  });

  it("multiplies later official factors for a backward cumulative series", () => {
    const first = event({
      effectiveDate: "2026-01-03",
      priorCloseTwd: 100,
      referencePriceTwd: 50,
      priceIndexAdjustmentFactor: 0.5,
    });
    const second = event({
      effectiveDate: "2026-01-05",
      priorCloseTwd: 50,
      referencePriceTwd: 40,
      priceIndexAdjustmentFactor: 0.8,
    });
    const result = buildPriceIndexCompatibleSeries(
      input({
        bars: [
          bar("2026-01-02", 100),
          bar("2026-01-03", 50, { changeMarker: "X" }),
          bar("2026-01-05", 40, { changeMarker: "X" }),
          bar("2026-01-06", 44),
        ],
        events: [first, second],
      }),
    );

    expect(result.factorAtWindowStart).toBeCloseTo(0.4, 12);
    expect(result.bars.map((item) => item.cumulativeFactor)).toEqual([
      0.4,
      0.8,
      1,
      1,
    ]);
    expect(result.bars.map((item) => item.adjusted?.close)).toEqual([
      40,
      40,
      40,
      44,
    ]);
  });

  it("fails only pre-event bars when a factor is missing and preserves explicit ledger evidence", () => {
    const result = buildPriceIndexCompatibleSeries(
      input({
        events: [
          event({
            priorCloseTwd: null,
            referencePriceTwd: null,
            priceIndexAdjustmentFactor: null,
            adjustmentStatus: "unavailable",
            adjustmentReason: "twse_combined_event_detail_failed",
          }),
        ],
      }),
    );

    expect(result.status).toBe("unknown");
    expect(result.unknownReasons).toEqual([
      "corporate_action_factor_unavailable",
      "corporate_action_prior_close_missing",
    ]);
    expect(result.eventLedger[0]).toMatchObject({
      status: "unknown",
      factor: null,
      priorCloseCheck: { status: "official_prior_close_missing" },
    });
    expect(result.bars[0]).toMatchObject({ adjusted: null });
    expect(result.bars[1]).toMatchObject({
      cumulativeFactor: 1,
      adjusted: { close: 50 },
      adjustmentStatus: "complete",
    });
  });

  it("fails closed on prior-close mismatch and ambiguous same-day actions", () => {
    const mismatch = buildPriceIndexCompatibleSeries(
      input({ events: [event({ priorCloseTwd: 999 })] }),
    );
    expect(mismatch.unknownReasons).toContain(
      "corporate_action_prior_close_mismatch",
    );
    expect(mismatch.eventLedger[0].priorCloseCheck).toMatchObject({
      status: "mismatch",
      observedPriorCloseTwd: 100,
    });
    expect(mismatch.factorAtWindowStart).toBeNull();

    const ambiguous = buildPriceIndexCompatibleSeries(
      input({
        events: [
          event(),
          event({
            kind: "par_value_change",
            sourceFamily: "par_value_change",
            rawType: "變更股票面額",
          }),
        ],
      }),
    );
    expect(ambiguous.unknownReasons).toContain(
      "ambiguous_same_day_corporate_actions",
    );
    expect(ambiguous.eventLedger.every((item) => item.status === "unknown")).toBe(
      true,
    );
  });

  it("fails closed on unmatched markers, coverage gaps, market transitions, and name mismatch", () => {
    const result = buildPriceIndexCompatibleSeries(
      input({
        bars: [
          bar("2026-01-02", 100, { market: "otc" }),
          bar("2026-01-05", 101, { changeMarker: "X" }),
          bar("2026-01-06", 102),
        ],
        events: [],
        coverage: coverage({
          status: "partial",
          coverageComplete: false,
          gaps: [
            {
              market: "listed",
              family: "ex_right_dividend",
              requestedStart: "2026-01-02",
              uncoveredThrough: "2026-01-03",
              supportedFrom: "2026-01-04",
              reason: "before_official_history_start",
            },
          ],
        }),
        observedNames: ["舊公司"],
      }),
    );

    expect(result.unknownReasons).toEqual([
      "corporate_action_coverage_incomplete",
      "unmatched_official_change_marker",
      "market_transition_or_historical_market_mismatch",
      "company_identity_name_mismatch",
    ]);
    expect(result.unmatchedOfficialChangeMarkers).toEqual([
      { date: "2026-01-05", marker: "X" },
    ]);
    expect(result.marketTransitionDetected).toBe(true);
    expect(result.bars.every((item) => item.adjusted === null)).toBe(true);
  });

  it("fails closed on event identity mismatch and duplicate raw dates", () => {
    const duplicate = bar("2026-01-02", 100);
    const result = buildPriceIndexCompatibleSeries(
      input({
        bars: [duplicate, { ...duplicate }, bar("2026-01-06", 55)],
        events: [
          event({
            companyCode: "2317",
            name: "鴻海",
            market: "otc",
          }),
        ],
      }),
    );

    expect(result.unknownReasons).toEqual(
      expect.arrayContaining([
        "corporate_action_market_mismatch",
        "company_identity_name_mismatch",
        "corporate_action_company_code_mismatch",
        "duplicate_raw_bar_date",
      ]),
    );
    expect(result.eventLedger[0]).toMatchObject({
      status: "unknown",
      unknownReasons: expect.arrayContaining([
        "corporate_action_market_mismatch",
        "corporate_action_company_code_mismatch",
      ]),
    });
  });

  it("uses open-start, closed-end event window semantics", () => {
    const start = event({ effectiveDate: "2026-01-02" });
    const middle = event({ effectiveDate: "2026-01-05" });
    const after = event({ effectiveDate: "2026-01-07" });

    expect(
      corporateActionEventsWithin(
        [start, middle, after],
        "2026-01-02",
        "2026-01-06",
      ),
    ).toEqual([middle]);
  });
});
