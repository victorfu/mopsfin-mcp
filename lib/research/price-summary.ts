import { BenchmarkClient } from "@/lib/reaction/benchmark-client";
import type { BenchmarkSource } from "@/lib/reaction/types";
import type { StockPriceSeriesResult } from "@/lib/price-series/types";
import { asMopsfinError } from "@/lib/mopsfin/errors";
import { getCurrentDeadline } from "@/lib/upstream/reliability";
import { sampleStandardDeviation } from "./statistics";

function statistic(value: number | null, reason: string | null, unit: string) {
  return { value, status: value === null ? "unavailable" as const : "available" as const, reason: value === null ? reason : null, unit };
}

export function summarizePriceBars(data: Pick<StockPriceSeriesResult, "bars" | "requestedPriceBasis" | "query">, sessions: readonly string[] | null) {
  const bars = [...data.bars].sort((a, b) => a.date.localeCompare(b.date));
  const adjusted = data.requestedPriceBasis !== "raw_unadjusted";
  const closes = bars.map((bar) => {
    const close = adjusted ? bar.adjustmentStatus === "complete" ? bar.adjusted?.close : null : bar.close;
    return bar.status === "traded" && typeof close === "number" && Number.isFinite(close) && close > 0 ? close : null;
  });
  const actualDates = new Set(bars.map((bar) => bar.date));
  const expected = sessions === null ? null : [...new Set(sessions.filter((date) => date >= data.query.startDate && date <= data.query.endDate))].sort();
  const expectedDates = expected === null ? null : new Set(expected);
  const missingSessionDates = expected?.filter((date) => !actualDates.has(date)) ?? [];
  const unexpectedBarDates = expectedDates ? [...actualDates].filter((date) => !expectedDates.has(date)) : [];
  const calendarReason = expected === null ? "official_session_grid_unavailable" : expected.length === 0 ? "official_session_grid_empty" : missingSessionDates.length ? "missing_session_bars" : unexpectedBarDates.length || actualDates.size !== bars.length ? "invalid_session_grid" : null;
  const priceReason = closes.some((close) => close === null) ? adjusted ? "adjusted_close_unavailable" : "raw_close_unavailable" : null;
  const pathReason = calendarReason ?? priceReason;
  const first = closes[0] ?? null, last = closes.at(-1) ?? null;
  let maxDrawdown: number | null = null;
  let dailySd: number | null = null;
  if (!pathReason && closes.length) {
    const valid = closes as number[];
    let peak = valid[0]; maxDrawdown = 0;
    for (const close of valid) { peak = Math.max(peak, close); maxDrawdown = Math.min(maxDrawdown, (close / peak - 1) * 100); }
    dailySd = sampleStandardDeviation(valid.slice(1).map((close, index) => Math.log(close / valid[index])));
  }
  const endpointReturn = first !== null && last !== null && closes.length > 1 ? (last / first - 1) * 100 : null;
  return {
    scope: "complete_collected_requested_window" as const, priceBasis: data.requestedPriceBasis,
    firstDate: bars[0]?.date ?? null, lastDate: bars.at(-1)?.date ?? null,
    barCount: bars.length, validCloseCount: closes.filter((close) => close !== null).length,
    firstClose: first, lastClose: last, expectedSessions: expected?.length ?? null,
    missingSessionDates, unexpectedBarDates, calendarVerified: calendarReason === null,
    endpointReturnPercent: statistic(endpointReturn, closes.length < 2 ? "insufficient_bars" : "missing_endpoint_close", "%"),
    maxDrawdownPercent: statistic(maxDrawdown, pathReason ?? "insufficient_bars", "%"),
    dailyLogReturnSampleStdDev: statistic(dailySd, pathReason ?? "insufficient_daily_returns", "log_return_ratio"),
    calculation: { version: "mopsfin.price-summary.v1", volatilityDdof: 1, volatilityAnnualized: false as const, drawdownBasis: "close" as const, endpointReturnBasis: "observed_first_to_last_close_only" as const, isTotalReturn: false as const },
    complete: endpointReturn !== null && maxDrawdown !== null && dailySd !== null,
  };
}

export class PriceSeriesSummaryClient {
  constructor(private readonly benchmark: Pick<BenchmarkClient, "getHistory"> = new BenchmarkClient()) {}

  async summarize(data: StockPriceSeriesResult) {
    const months: string[] = [];
    const start = new Date(`${data.query.startDate.slice(0, 7)}-01T00:00:00Z`);
    const end = data.query.endDate.slice(0, 7);
    for (let offset = 0; offset < 36; offset++) {
      const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
      if (month > end) break;
      months.push(month);
    }
    let sessions: string[] | null = null;
    let sources: BenchmarkSource[] = [];
    let failure: { code: string; message: string } | null = null;
    let loads = 0;
    if (data.identity.resolvedMarket && !data.adjustment.marketTransitionDetected && data.identity.reasons.length === 0) {
      try {
        getCurrentDeadline()?.throwIfExpired();
        loads = months.length;
        const history = await this.benchmark.getHistory(data.identity.resolvedMarket, months);
        sources = history.sources;
        sessions = history.bars.map((bar) => bar.date);
      } catch (error) {
        const normalized = asMopsfinError(error);
        failure = { code: normalized.code, message: normalized.message };
      }
      getCurrentDeadline()?.throwIfExpired();
    } else failure = { code: "IDENTITY_UNVERIFIED", message: "身份或轉板限制使單一市場 session grid 無法驗證此範圍。" };
    return {
      summary: summarizePriceBars(data, sessions), summarySources: sources, summaryFailure: failure,
      summaryWorkBudget: { benchmarkCalls: loads ? 1 : 0, requestedBenchmarkMonths: loads ? months : [], benchmarkMonthLogicalLoads: loads, maximumBenchmarkMonths: 36, retries: "dependency_managed_within_shared_request_deadline" as const },
    };
  }
}
export const priceSeriesSummaryClient = new PriceSeriesSummaryClient();
