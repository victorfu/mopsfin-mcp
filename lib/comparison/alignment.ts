import { MopsfinError } from "@/lib/mopsfin/errors";

import type { FinancialPeriodPolicy, AlignmentSeries } from "./types";
export type { FinancialPeriodPolicy, AlignmentSeries } from "./types";

function ordinal(period: string): number {
  const match = /^(\d{4})Q([1-4])$/.exec(period);
  if (!match) throw new MopsfinError("INVALID_ARGUMENT", `季別格式錯誤：${period}`);
  return Number(match[1]) * 4 + Number(match[2]) - 1;
}
function periodAt(index: number): string { return `${Math.floor(index / 4)}Q${index % 4 + 1}`; }

/** One calendar window for all companies; no per-company last-12 shortcuts. */
export function completedQuarterWindow(evaluatedAt: Date): string[] {
  if (!Number.isFinite(evaluatedAt.getTime())) throw new MopsfinError("INVALID_ARGUMENT", "evaluatedAt 無效。");
  const taipei = new Date(evaluatedAt.getTime() + 8 * 60 * 60 * 1000);
  const current = taipei.getUTCFullYear() * 4 + Math.floor(taipei.getUTCMonth() / 3);
  return Array.from({ length: 12 }, (_, index) => periodAt(current - 12 + index));
}

export function alignFinancialPeriods(options: {
  companies: string[];
  metrics: string[];
  series: AlignmentSeries[];
  window: string[];
  policy: FinancialPeriodPolicy;
  fiscalPeriod?: string;
}) {
  const { companies, metrics, series, window, policy, fiscalPeriod } = options;
  if (policy === "explicit" ? !fiscalPeriod : fiscalPeriod !== undefined) throw new MopsfinError("INVALID_ARGUMENT", "只有 explicit 期別策略可以且必須指定 fiscal_period。");
  if (fiscalPeriod) ordinal(fiscalPeriod);
  const candidates = [...new Set(window)].sort((a, b) => ordinal(b) - ordinal(a));
  const index = new Map<string, AlignmentSeries>();
  for (const item of series) {
    const key = `${item.companyCode}:${item.metricCode}`;
    if (index.has(key)) throw new MopsfinError("INVALID_ARGUMENT", `重複財務序列：${key}`);
    index.set(key, item);
  }
  const evidence = companies.map((companyCode) => {
    const constraints = metrics.map((metricCode) => {
      const item = index.get(`${companyCode}:${metricCode}`);
      return {
        metricCode, applicability: item?.applicability ?? "unknown",
        availablePeriods: candidates.filter((period) => item?.reportedPeriods.includes(period)),
      };
    });
    const applicable = constraints.filter((item) => item.applicability !== "not_applicable");
    const availablePeriods = candidates.filter((period) => applicable.every((item) => item.availablePeriods.includes(period)));
    return { companyCode, constraints, availablePeriods, applicableMetricCount: applicable.length };
  });
  const commonPeriods = candidates.filter((period) => evidence.every((item) => item.availablePeriods.includes(period)));
  const anyApplicable = evidence.some((item) => item.applicableMetricCount > 0);
  const commonPeriod = policy === "common_latest" && anyApplicable ? commonPeriods[0] ?? null : null;
  return {
    policy, searchWindow: [...candidates].reverse(),
    status: !anyApplicable ? "not_applicable" : policy === "common_latest" && !commonPeriod ? "no_common_period" : "selected",
    commonPeriod,
    companies: evidence.map((item) => ({
      ...item,
      selectedPeriod: policy === "explicit" ? fiscalPeriod! : policy === "common_latest" ? commonPeriod : item.applicableMetricCount ? item.availablePeriods[0] ?? null : null,
    })),
  };
}
