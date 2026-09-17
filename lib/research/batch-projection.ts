import type { CompanyMetricsBatchResult, CompanyMetricsBatchMetric } from "@/lib/mopsfin/batch";
import type { TrendPoint } from "@/lib/mopsfin/types";
import { median } from "./statistics";
import { financialFieldApplicability } from "./financials";

export const BATCH_POINT_STATUSES = ["reported", "missing", "invalid_upstream"] as const;

export function compactFinancialBatch(data: CompanyMetricsBatchResult) {
  const periods = [...new Set(data.companies.flatMap((company) => company.metrics.flatMap((metric) => [...metric.periods, ...metric.points.map((point) => point.period)])))].sort();
  const indexes = new Map(periods.map((period, index) => [period, index]));
  const metricMetadata: Omit<CompanyMetricsBatchMetric, "periods" | "points">[] = [];
  const dictionary = new Map<string, number>();
  return {
    scope: "current_page" as const, outputMode: "compact" as const, companiesOmitted: false as const,
    periods, pointStatusEncoding: [...BATCH_POINT_STATUSES], pointEncoding: "[periodIndex,value,valueStatusIndex,optionalStatus]" as const,
    metricMetadata,
    companies: data.companies.map(({ metrics, ...company }) => ({
      ...company,
      metrics: metrics.map(({ periods: metricPeriods, points, ...metadata }) => {
        const key = JSON.stringify(metadata);
        let index = dictionary.get(key);
        if (index === undefined) { index = metricMetadata.length; dictionary.set(key, index); metricMetadata.push(metadata); }
        return {
          metadataIndex: index, periodIndexes: metricPeriods.map((period) => indexes.get(period)!),
          points: points.map((point): [number, number | null, number, string?] => {
            const tuple: [number, number | null, number, string?] = [indexes.get(point.period)!, point.value, BATCH_POINT_STATUSES.indexOf(point.valueStatus)];
            if (point.status !== undefined) tuple.push(point.status);
            return tuple;
          }),
        };
      }),
    })),
  };
}

export function summarizeFinancialBatch(data: CompanyMetricsBatchResult) {
  const groups = new Map<string, { metricCode: string; metricName: string; unit: string; basis: string; period: string; definitionId: string; companyCodes: string[]; values: number[] }>();
  const metricCoverage = data.metricDefinitions.map((definition) => {
    const metrics = data.companies.flatMap((company) => company.metrics.filter((metric) => metric.metricCode === definition.code));
    const counts = { reported: 0, missing: 0, invalid_upstream: 0 };
    for (const metric of metrics) for (const point of metric.points) counts[point.valueStatus]++;
    return { metricCode: definition.code, available: metrics.filter((metric) => metric.availability === "available").length, noData: metrics.filter((metric) => metric.availability === "no_data").length, unavailable: metrics.filter((metric) => metric.availability === "unavailable").length, pointStatuses: counts };
  });
  for (const company of data.companies) for (const metric of company.metrics) {
    const definition = data.metricDefinitions.find((item) => item.code === metric.metricCode);
    const broad = definition && financialFieldApplicability({ ...definition, family: "data" }) === "all" && !["營業收入", "營業利益", "稅後純益率", "營業收入年增率"].includes(definition.name);
    // Batch identities do not establish current market or financial subtype. Do not add master fetches solely for presentation.
    const definitionId = `mopsfin.${metric.metricCode}.${data.query.basis}${broad ? "" : `.industry_unverified.${company.companyCode}`}`;
    if (metric.availability !== "available") continue;
    for (const point of metric.points) {
      if (point.valueStatus !== "reported" || point.value === null || !Number.isFinite(point.value)) continue;
      const key = JSON.stringify([definitionId, metric.unit, point.period]);
      const group = groups.get(key) ?? { metricCode: metric.metricCode, metricName: metric.metricName, unit: metric.unit, basis: data.query.basis, period: point.period, definitionId, companyCodes: [], values: [] };
      group.companyCodes.push(company.companyCode); group.values.push(point.value); groups.set(key, group);
    }
  }
  return {
    scope: "current_page" as const, outputMode: "summary" as const, companiesOmitted: true as const,
    evaluatedCompanyCodes: data.coverage.requestedCompanyCodes,
    returnedCompanyCount: data.companies.length,
    metricCoverage,
    groups: [...groups.values()].map(({ values, ...group }) => ({ ...group, count: values.length, min: Math.min(...values), max: Math.max(...values), median: median(values) })),
    definitionPolicy: "common verified formula or per-company group when industry mapping is unverified" as const,
  };
}

/** Used by consumers/tests to verify that compact retains each original point exactly. */
export function decodeBatchPoints(points: Array<[number, number | null, number, string?]>, periods: string[]): TrendPoint[] {
  return points.map(([periodIndex, value, statusIndex, status]) => ({ period: periods[periodIndex], value, valueStatus: BATCH_POINT_STATUSES[statusIndex], ...(status !== undefined ? { status } : {}) }));
}
