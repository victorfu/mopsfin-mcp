import { MopsfinError } from "@/lib/mopsfin/errors";
import type { OhlcBar } from "@/lib/price/types";

import type {
  AverageWindowSignal,
  BenchmarkBar,
  PricePathSignal,
  RatioSignal,
  ReactionHorizon,
  ReturnReactionSignal,
} from "./types";

function fail(message: string, details?: Record<string, unknown>): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, { details });
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

export function exactSessionWindow(
  benchmarkBars: BenchmarkBar[],
  resolvedAsOf: string,
  observationCount: number,
): BenchmarkBar[] {
  const endIndex = benchmarkBars.findIndex((bar) => bar.date === resolvedAsOf);
  if (endIndex < 0) {
    fail("benchmark 缺少 resolved as-of 交易日。", { resolvedAsOf });
  }
  const startIndex = endIndex - observationCount + 1;
  if (startIndex < 0) {
    fail("benchmark 交易日歷史不足。", {
      resolvedAsOf,
      requiredObservationCount: observationCount,
      availableObservationCount: endIndex + 1,
    });
  }
  return benchmarkBars.slice(startIndex, endIndex + 1);
}

function numericBarValue(
  barsByDate: Map<string, OhlcBar>,
  date: string,
  field: "close" | "volumeShares" | "turnoverTwd",
): number | null {
  const value = barsByDate.get(date)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function calculateReturnSignal(
  horizon: ReactionHorizon,
  benchmarkWindow: BenchmarkBar[],
  stockBarsByDate: Map<string, OhlcBar>,
  noStockData: boolean,
): ReturnReactionSignal {
  if (benchmarkWindow.length !== horizon + 1) {
    fail("benchmark 報酬視窗不是 exact N-session。", {
      horizon,
      observationCount: benchmarkWindow.length,
    });
  }
  const start = benchmarkWindow[0];
  const end = benchmarkWindow.at(-1) as BenchmarkBar;
  const benchmarkReturnPercent = round((end.close / start.close - 1) * 100);
  if (noStockData) {
    return {
      horizonSessions: horizon,
      startDate: start.date,
      endDate: end.date,
      stockReturnPercent: null,
      benchmarkReturnPercent,
      excessReturnPercentagePoints: null,
      status: "no_stock_data",
      excessReturnStatus: "no_stock_data",
      excessReturnReasons: [],
    };
  }
  const startClose = numericBarValue(stockBarsByDate, start.date, "close");
  if (startClose === null || startClose <= 0) {
    return {
      horizonSessions: horizon,
      startDate: start.date,
      endDate: end.date,
      stockReturnPercent: null,
      benchmarkReturnPercent,
      excessReturnPercentagePoints: null,
      status: "missing_stock_start_close",
      excessReturnStatus: "missing_stock_start_close",
      excessReturnReasons: [],
    };
  }
  const endClose = numericBarValue(stockBarsByDate, end.date, "close");
  if (endClose === null || endClose <= 0) {
    return {
      horizonSessions: horizon,
      startDate: start.date,
      endDate: end.date,
      stockReturnPercent: null,
      benchmarkReturnPercent,
      excessReturnPercentagePoints: null,
      status: "missing_stock_end_close",
      excessReturnStatus: "missing_stock_end_close",
      excessReturnReasons: [],
    };
  }
  const stockReturnPercent = round((endClose / startClose - 1) * 100);
  return {
    horizonSessions: horizon,
    startDate: start.date,
    endDate: end.date,
    stockReturnPercent,
    benchmarkReturnPercent,
    excessReturnPercentagePoints: round(stockReturnPercent - benchmarkReturnPercent),
    status: "available",
    excessReturnStatus: "available",
    excessReturnReasons: [],
  };
}

export function calculateAverageWindowSignal(
  windowSessions: 5 | 20 | 60,
  benchmarkWindow: BenchmarkBar[],
  stockBarsByDate: Map<string, OhlcBar>,
  field: "volumeShares" | "turnoverTwd",
  noStockData: boolean,
): AverageWindowSignal {
  if (benchmarkWindow.length !== windowSessions) {
    fail("流動性視窗不是 exact N-session。", {
      windowSessions,
      observationCount: benchmarkWindow.length,
    });
  }
  const values = benchmarkWindow
    .map((benchmark) => numericBarValue(stockBarsByDate, benchmark.date, field))
    .filter((value): value is number => value !== null);
  const common = {
    windowSessions,
    startDate: benchmarkWindow[0].date,
    endDate: (benchmarkWindow.at(-1) as BenchmarkBar).date,
    expectedObservationCount: windowSessions,
    observationCount: values.length,
  } as const;
  if (noStockData) {
    return { ...common, value: null, status: "no_stock_data" };
  }
  if (values.length !== windowSessions) {
    return { ...common, value: null, status: "incomplete_stock_window" };
  }
  return {
    ...common,
    value: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    status: "available",
  };
}

export function calculateRatioSignal(
  numerator: AverageWindowSignal,
  denominator: AverageWindowSignal,
): RatioSignal {
  const common = {
    numeratorWindowSessions: numerator.windowSessions as 5 | 20,
    denominatorWindowSessions: denominator.windowSessions as 20 | 60,
  };
  if (numerator.status === "no_stock_data" || denominator.status === "no_stock_data") {
    return { ...common, value: null, status: "no_stock_data" };
  }
  if (
    numerator.status !== "available" ||
    denominator.status !== "available" ||
    numerator.value === null ||
    denominator.value === null
  ) {
    return { ...common, value: null, status: "incomplete_stock_window" };
  }
  if (denominator.value === 0) {
    return { ...common, value: null, status: "invalid_denominator" };
  }
  return {
    ...common,
    value: round(numerator.value / denominator.value),
    status: "available",
  };
}

export function calculatePricePathSignal(
  horizon: ReactionHorizon,
  benchmarkWindow: BenchmarkBar[],
  stockBarsByDate: Map<string, OhlcBar>,
  noStockData: boolean,
): PricePathSignal {
  if (benchmarkWindow.length !== horizon + 1) {
    fail("價格路徑視窗不是 exact N-session。", {
      horizon,
      observationCount: benchmarkWindow.length,
    });
  }
  const closes = benchmarkWindow
    .map((benchmark) => numericBarValue(stockBarsByDate, benchmark.date, "close"))
    .filter((value): value is number => value !== null && value > 0);
  const common = {
    horizonSessions: horizon,
    startDate: benchmarkWindow[0].date,
    endDate: (benchmarkWindow.at(-1) as BenchmarkBar).date,
    expectedObservationCount: horizon + 1,
    observationCount: closes.length,
  } as const;
  if (noStockData) {
    return {
      ...common,
      maximumDrawdownPercent: null,
      distanceBelowWindowHighPercent: null,
      status: "no_stock_data",
    };
  }
  if (closes.length !== horizon + 1) {
    return {
      ...common,
      maximumDrawdownPercent: null,
      distanceBelowWindowHighPercent: null,
      status: "incomplete_stock_window",
    };
  }
  let peak = closes[0];
  let maximumDrawdownPercent = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    maximumDrawdownPercent = Math.min(
      maximumDrawdownPercent,
      (close / peak - 1) * 100,
    );
  }
  const windowHigh = Math.max(...closes);
  const lastClose = closes.at(-1) as number;
  return {
    ...common,
    maximumDrawdownPercent: round(maximumDrawdownPercent),
    distanceBelowWindowHighPercent: round((1 - lastClose / windowHigh) * 100),
    status: "available",
  };
}
