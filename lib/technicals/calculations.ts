import type { IndicatorResult, TechnicalWindowInput } from "./types";
import type { StockPriceSeriesBar } from "@/lib/price-series/types";
import { sampleStandardDeviation } from "@/lib/research/statistics";

export const TECHNICAL_CALCULATION_VERSION = "mopsfin.technicals.v1";
export type { IndicatorResult, TechnicalWindowInput } from "./types";

function exactWindow(input: TechnicalWindowInput, count: number) {
  const sessions = [...new Set(input.sessions.filter((date) => date <= input.asOf))].sort().slice(-count);
  const index = new Map<string, StockPriceSeriesBar>();
  const duplicates = new Set<string>();
  for (const bar of input.bars) { if (index.has(bar.date)) duplicates.add(bar.date); index.set(bar.date, bar); }
  const bars = sessions.map((date) => index.get(date));
  const window = { from: sessions[0] ?? null, through: input.asOf, expectedSessions: count, observedSessions: bars.filter(Boolean).length };
  const reason = sessions.at(-1) !== input.asOf ? "as_of_not_verified_session" : sessions.length < count ? "insufficient_sessions" : sessions.some((date) => duplicates.has(date)) ? "duplicate_bar" : bars.some((bar) => !bar) ? "missing_session_bar" : null;
  return { bars, window, reason };
}
function result(input: TechnicalWindowInput, window: IndicatorResult["window"], unit: string, value: IndicatorResult["value"], reason: string | null, details: IndicatorResult["details"] = {}): IndicatorResult {
  const invalid = typeof value === "number" && !Number.isFinite(value);
  return { value: reason || invalid ? null : value, status: reason || invalid ? "unavailable" : "available", reason: reason ?? (invalid ? "non_finite_result" : null), unit, priceBasis: input.priceBasis, calculationVersion: TECHNICAL_CALCULATION_VERSION, window, details };
}
function prices(input: TechnicalWindowInput, count: number, field: "close" | "high" = "close") {
  const selected = exactWindow(input, count);
  const values: number[] = [];
  let reason = selected.reason;
  for (const bar of selected.bars) {
    if (!bar) continue;
    const adjusted = input.priceBasis !== "raw_unadjusted";
    const value = adjusted ? bar.adjusted?.[field] : bar[field];
    if (adjusted && bar.adjustmentStatus !== "complete") reason ??= "adjustment_unavailable";
    if (bar.status !== "traded" || value == null || !Number.isFinite(value) || value <= 0) reason ??= "invalid_price";
    else values.push(value);
  }
  return { ...selected, reason, values };
}

export function calculateSma(input: TechnicalWindowInput, period: number): IndicatorResult {
  const { values, window, reason } = prices(input, period);
  const mean = reason ? null : values.reduce((sum, value) => sum + value, 0) / period;
  return result(input, window, "TWD", mean, reason, { period, distancePct: mean ? (values.at(-1)! / mean - 1) * 100 : null });
}

/** Fixed 251-close seed makes repeated calls deterministic across requested history lengths. */
export function calculateRsi(input: TechnicalWindowInput): IndicatorResult {
  const { values, window, reason } = prices(input, 251);
  const details: IndicatorResult["details"] = { period: 14, seedCloses: 15, requiredCloses: 251, seedStart: window.from, smoothing: "Wilder: (previous * 13 + current) / 14" };
  if (reason) return result(input, window, "index_0_100", null, reason, details);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < values.length; index++) {
    const delta = values[index] - values[index - 1];
    const up = Math.max(0, delta), down = Math.max(0, -delta);
    if (index <= 14) { gain += up / 14; loss += down / 14; }
    else { gain = (gain * 13 + up) / 14; loss = (loss * 13 + down) / 14; }
  }
  const value = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
  return result(input, window, "index_0_100", value, null, details);
}

export function calculateHistoricalVolatility(input: TechnicalWindowInput, period: number): IndicatorResult {
  const { values, window, reason } = prices(input, period + 1);
  const returns = values.slice(1).map((value, index) => Math.log(value / values[index]));
  const sd = reason ? null : sampleStandardDeviation(returns);
  return result(input, window, "%_annualized", sd === null ? null : sd * Math.sqrt(252) * 100, reason ?? (sd === null ? "insufficient_returns" : null), { period, ddof: 1, annualizationSessions: 252, returnType: "log" });
}

export function calculateBreakout(input: TechnicalWindowInput, period: number): IndicatorResult {
  // Today's high is intentionally not required: comparison uses prior highs only.
  const selected = exactWindow(input, period + 1);
  const priorSessions = input.sessions.filter((date) => date < input.asOf).sort();
  const priorDate = priorSessions.at(-1);
  const prior = priorDate ? prices({ ...input, asOf: priorDate }, period, "high") : null;
  const current = prices(input, 1);
  const reason = selected.reason ?? current.reason ?? prior?.reason ?? (!prior ? "insufficient_sessions" : null);
  const referenceHigh = !reason && prior ? Math.max(...prior.values) : null;
  return result(input, selected.window, "boolean", referenceHigh === null ? null : current.values[0] > referenceHigh, reason, { period, referenceHigh, distancePct: referenceHigh ? (current.values[0] / referenceHigh - 1) * 100 : null, includesCurrentInReference: false });
}

export function calculateVolumeRatio(input: TechnicalWindowInput, actions: { verified: boolean; shareChangeDates: readonly string[] }): IndicatorResult {
  const { bars, window, reason: windowReason } = exactWindow(input, 21);
  let reason = windowReason;
  const volumes = bars.map((bar) => bar?.volumeShares);
  if (volumes.some((value) => value == null || !Number.isFinite(value) || value < 0)) reason ??= "invalid_volume";
  const shareChange = actions.shareChangeDates.some((date) => window.from !== null && date > window.from && date <= input.asOf);
  if (shareChange) reason ??= "not_comparable_corporate_action";
  const denominator = reason ? null : (volumes.slice(0, -1) as number[]).reduce((sum, value) => sum + value, 0) / 20;
  if (denominator === 0) reason ??= "zero_denominator";
  const output = result(input, window, "ratio", denominator ? volumes.at(-1)! / denominator : null, reason, { priorSessionCount: 20, denominator, comparability: shareChange ? "not_comparable" : actions.verified ? "verified" : "unverified", includesCurrentInDenominator: false });
  return { ...output, priceBasis: "raw_shares" };
}
