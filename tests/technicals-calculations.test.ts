import { describe, expect, it } from "vitest";
import type { StockPriceSeriesBar } from "@/lib/price-series/types";
import { calculateSma, calculateRsi, calculateHistoricalVolatility, calculateBreakout, calculateVolumeRatio, type TechnicalWindowInput } from "@/lib/technicals/calculations";

function input(closes: number[]): TechnicalWindowInput {
  const bars: StockPriceSeriesBar[] = closes.map((close, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    open: close, high: close, low: close, close, volumeShares: 100, turnoverTwd: 100 * close,
    tradeCount: 1, change: 0, changeMarker: null, market: "listed", status: "traded",
    qualityStatus: "complete", missingFields: [], cumulativeFactor: 1,
    adjusted: { open: close, high: close, low: close, close }, adjustmentStatus: "complete", adjustmentUnknownReasons: [], volumeBasis: "raw_shares",
  }));
  // Synthetic supplied session grid tests formulas independently of calendar fetching.
  return { bars, sessions: bars.map((bar) => bar.date), asOf: bars.at(-1)!.date, priceBasis: "price_index_compatible_corporate_action_adjusted" };
}

describe("technical formulas", () => {
  it("computes SMA including today's close and percentage distance", () => {
    expect(calculateSma(input([100, 1, 2, 3, 4, 5]), 5)).toMatchObject({ value: 3, status: "available", details: { distancePct: (5 / 3 - 1) * 100 } });
  });
  it("uses exactly 251 closes for RSI and has defined flat and one-sided outcomes", () => {
    expect(calculateRsi(input(Array(251).fill(10))).value).toBe(50);
    expect(calculateRsi(input(Array.from({ length: 251 }, (_, index) => index + 1))).value).toBe(100);
    expect(calculateRsi(input(Array.from({ length: 251 }, (_, index) => 300 - index))).value).toBe(0);
    expect(calculateRsi(input(Array(250).fill(10)))).toMatchObject({ value: null, reason: "insufficient_sessions" });
    // Fourteen +1 seed gains, 235 flat deltas, then a -1 delta.
    // Gain before the last delta is (13/14)^235, loss is zero.
    const closes = [...Array.from({ length: 15 }, (_, index) => 100 + index), ...Array(235).fill(114), 113];
    const gain = (13 / 14) ** 236;
    const expected = 100 - 100 / (1 + gain / (1 / 14));
    expect(calculateRsi(input(closes)).value).toBeCloseTo(expected, 10);
    expect(calculateRsi(input([900, ...closes])).value).toBeCloseTo(expected, 10);
  });
  it("uses sample log-return volatility and exposes the 252-session convention", () => {
    // log returns = a, -a: mean zero, sample sd = sqrt(2)*a.
    const observed = calculateHistoricalVolatility(input([100, 200, 100]), 2);
    expect(observed.value).toBeCloseTo(Math.sqrt(2) * Math.log(2) * Math.sqrt(252) * 100, 10);
    expect(observed.details).toMatchObject({ ddof: 1, annualizationSessions: 252 });
  });
  it("breakout excludes today's high, requires strict greater-than, and uses prior highs", () => {
    const sample = input([1, 2, 3, 4]);
    const bars = sample.bars.map((bar, index) => ({ ...bar, adjusted: { ...bar.adjusted!, high: index === 3 ? 999 : 3 } }));
    expect(calculateBreakout({ ...sample, bars }, 3)).toMatchObject({ value: true, details: { referenceHigh: 3 } });
    expect(calculateBreakout(input([1, 2, 3, 3]), 3).value).toBe(false);
  });
  it("volume ratio excludes today from denominator and retains raw-shares comparability", () => {
    const sample = input(Array(21).fill(10));
    const bars = sample.bars.map((bar, index) => ({ ...bar, volumeShares: index === 20 ? 200 : 100 }));
    expect(calculateVolumeRatio({ ...sample, bars }, { verified: true, shareChangeDates: [] })).toMatchObject({ value: 2, priceBasis: "raw_shares", details: { denominator: 100, comparability: "verified" } });
    expect(calculateVolumeRatio({ ...sample, bars }, { verified: false, shareChangeDates: [] }).details.comparability).toBe("unverified");
    expect(calculateVolumeRatio({ ...sample, bars }, { verified: true, shareChangeDates: [sample.sessions[5]] })).toMatchObject({ value: null, reason: "not_comparable_corporate_action" });
    expect(calculateVolumeRatio({ ...sample, bars: bars.map((bar) => ({ ...bar, volumeShares: 0 })) }, { verified: true, shareChangeDates: [] }).reason).toBe("zero_denominator");
  });
});

describe("technical window integrity", () => {
  it("does not silently skip suspension gaps, use future bars, or fall back from adjusted to raw", () => {
    const sample = input([1, 2, 3, 4, 5]);
    expect(calculateSma({ ...sample, bars: sample.bars.filter((_, index) => index !== 3) }, 3)).toMatchObject({ value: null, reason: "missing_session_bar" });
    expect(calculateSma({ ...sample, asOf: sample.sessions[2] }, 3).value).toBe(2);
    const bars = sample.bars.map((bar, index) => index === 4 ? { ...bar, adjustmentStatus: "unknown" as const, adjusted: null } : bar);
    expect(calculateSma({ ...sample, bars }, 3)).toMatchObject({ value: null, reason: "adjustment_unavailable" });
    expect(calculateSma({ ...sample, bars, priceBasis: "raw_unadjusted" }, 3).value).toBe(4);
  });
  it("only invalidates windows dependent on a bad bar", () => {
    const sample = input([1, 2, 3, 4, 5]);
    const bars = sample.bars.map((bar, index) => index === 0 ? { ...bar, adjusted: null } : bar);
    expect(calculateSma({ ...sample, bars }, 3).value).toBe(4);
    expect(calculateSma({ ...sample, bars }, 5).status).toBe("unavailable");
    expect(calculateSma({ ...sample, bars: [...sample.bars, sample.bars[4]] }, 3).reason).toBe("duplicate_bar");
    expect(calculateSma({ ...sample, asOf: "2025-01-06" }, 3).reason).toBe("as_of_not_verified_session");
  });
  it("uses adjusted prices across a split while cash-only effects remain", () => {
    const sample = input([100, 102, 51]);
    const bars = sample.bars.map((bar, index) => ({ ...bar, adjusted: { ...bar.adjusted!, close: index < 2 ? bar.close! / 2 : bar.close! } }));
    expect(calculateSma({ ...sample, bars }, 3).value).toBeCloseTo(152 / 3);
    expect(calculateSma({ ...sample, bars, priceBasis: "raw_unadjusted" }, 3).value).toBeCloseTo(253 / 3);
    expect(calculateHistoricalVolatility(input([100, 100, 95]), 2).value).toBeGreaterThan(0);
  });
});
