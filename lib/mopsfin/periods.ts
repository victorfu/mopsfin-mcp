import { MopsfinError } from "./errors";
import type { NormalizedTrend } from "./types";

const PERIOD_PATTERN = /^(\d{4})Q([1-4])$/;

export interface ParsedPeriod {
  year: number;
  quarter: number;
}

export function parsePeriod(period: string): ParsedPeriod {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      `無效期別 ${period}；請使用 YYYYQ1 至 YYYYQ4。`,
    );
  }

  return { year: Number(match[1]), quarter: Number(match[2]) };
}

export function toPeriod(year: number, quarter: number): string {
  return `${year}Q${quarter}`;
}

export function toYs(period: string): string {
  const { year, quarter } = parsePeriod(period);
  return `${year}${quarter}`;
}

export function comparePeriods(a: string, b: string): number {
  const left = parsePeriod(a);
  const right = parsePeriod(b);
  return left.year * 4 + left.quarter - (right.year * 4 + right.quarter);
}

export function latestCompletedQuarter(now = new Date()): ParsedPeriod {
  const taipei = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(taipei.find((part) => part.type === "year")?.value);
  const month = Number(taipei.find((part) => part.type === "month")?.value);
  const currentQuarter = Math.floor((month - 1) / 3) + 1;

  if (currentQuarter === 1) {
    return { year: year - 1, quarter: 4 };
  }

  return { year, quarter: currentQuarter - 1 };
}

export function latestPeriodCandidates(now = new Date(), count = 12): string[] {
  const candidates: string[] = [];
  let cursor = latestCompletedQuarter(now);

  for (let index = 0; index < count; index += 1) {
    candidates.push(toPeriod(cursor.year, cursor.quarter));
    cursor =
      cursor.quarter === 1
        ? { year: cursor.year - 1, quarter: 4 }
        : { year: cursor.year, quarter: cursor.quarter - 1 };
  }

  return candidates;
}

export function sliceTrend(
  trend: NormalizedTrend,
  options: {
    history: "recent_12" | "all";
    startPeriod?: string;
    endPeriod?: string;
  },
): NormalizedTrend {
  let selected = trend.periods.filter((period) => PERIOD_PATTERN.test(period));

  if (options.startPeriod) {
    parsePeriod(options.startPeriod);
    selected = selected.filter(
      (period) => comparePeriods(period, options.startPeriod as string) >= 0,
    );
  }
  if (options.endPeriod) {
    parsePeriod(options.endPeriod);
    selected = selected.filter(
      (period) => comparePeriods(period, options.endPeriod as string) <= 0,
    );
  }
  if (!options.startPeriod && !options.endPeriod && options.history === "recent_12") {
    selected = selected.slice(-12);
  }

  const periodSet = new Set(selected);
  return {
    ...trend,
    periods: selected,
    series: trend.series.map((series) => ({
      ...series,
      points: series.points.filter((point) => periodSet.has(point.period)),
    })),
  };
}
