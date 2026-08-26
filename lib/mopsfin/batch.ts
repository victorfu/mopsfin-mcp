import { createHash } from "node:crypto";

import {
  mopsfinClient,
  type CompanyMetricBasis,
  type MopsfinClient,
} from "./client";
import { MopsfinError } from "./errors";
import type {
  CompanySuggestion,
  MetricDefinition,
  SourceMetadata,
  TrendPoint,
} from "./types";

export interface CompanyMetricsBatchQuery {
  companyCodes: string[];
  metricCodes: string[];
  basis: CompanyMetricBasis;
  yoyQuarter?: number;
  startPeriod?: string;
  endPeriod?: string;
}

export interface CompanyMetricsBatchMetric {
  metricCode: string;
  metricName: string;
  unit: string;
  periods: string[];
  points: TrendPoint[];
  coverage: {
    seriesReturned: boolean;
    nonNullPoints: number;
    missingPoints: number;
    invalidPoints: number;
    firstReportedPeriod: string | null;
    latestReportedPeriod: string | null;
    missingPeriods: string[];
  };
}

export interface CompanyMetricsBatchCompany {
  companyCode: string;
  companyName: string;
  displayName: string;
  metrics: CompanyMetricsBatchMetric[];
}

export interface CompanyMetricsBatchResult {
  query: {
    companyCodes: string[];
    metricCodes: string[];
    basis: CompanyMetricBasis;
    yoyQuarter?: number;
    history: "recent_12";
    startPeriod?: string;
    endPeriod?: string;
  };
  retrievedAt: string;
  snapshotId: string;
  metricDefinitions: Array<Pick<MetricDefinition, "code" | "name" | "unit" | "category">>;
  companies: CompanyMetricsBatchCompany[];
  coverage: {
    selectionComplete: boolean;
    requestedCompanyCodes: string[];
    returnedCompanyCodes: string[];
    missingCompanyCodes: string[];
    noValidDataCompanyCodes: string[];
    metrics: Array<{
      metricCode: string;
      returnedCompanyCodes: string[];
      missingCompanyCodes: string[];
      noValidDataCompanyCodes: string[];
    }>;
  };
  sources: SourceMetadata[];
  warnings: string[];
}

type SingleMetricResult = Awaited<ReturnType<MopsfinClient["getCompanyMetric"]>>;

function quarterIndex(period: string): number {
  const match = /^(\d{4})Q([1-4])$/.exec(period);
  if (!match) throw new MopsfinError("INVALID_ARGUMENT", "期別必須是 YYYYQ1 至 YYYYQ4。");
  return Number(match[1]) * 4 + Number(match[2]) - 1;
}

function validateQuery(query: CompanyMetricsBatchQuery): {
  companyCodes: string[];
  metricCodes: string[];
} {
  const companyCodes = query.companyCodes.map((code) => code.trim());
  const metricCodes = query.metricCodes.map((code) => code.trim());
  if (companyCodes.length < 1 || companyCodes.length > 100) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 必須包含 1 至 100 個公司代號。");
  }
  if (metricCodes.length < 1 || metricCodes.length > 8) {
    throw new MopsfinError("INVALID_ARGUMENT", "metric_codes 必須包含 1 至 8 個指標代號。");
  }
  if (companyCodes.some((code) => !/^[0-9A-Za-z]{1,10}$/.test(code))) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 包含無效公司代號。");
  }
  if (metricCodes.some((code) => !code || code.length > 100)) {
    throw new MopsfinError("INVALID_ARGUMENT", "metric_codes 包含無效指標代號。");
  }
  if (new Set(companyCodes.map((code) => code.toLowerCase())).size !== companyCodes.length) {
    throw new MopsfinError("INVALID_ARGUMENT", "company_codes 不得重複。");
  }
  if (new Set(metricCodes).size !== metricCodes.length) {
    throw new MopsfinError("INVALID_ARGUMENT", "metric_codes 不得重複。");
  }
  if ((query.startPeriod === undefined) !== (query.endPeriod === undefined)) {
    throw new MopsfinError("INVALID_ARGUMENT", "start_period 與 end_period 必須同時提供或同時省略。");
  }
  if (query.startPeriod && query.endPeriod) {
    const start = quarterIndex(query.startPeriod);
    const end = quarterIndex(query.endPeriod);
    if (end < start) throw new MopsfinError("INVALID_ARGUMENT", "end_period 不得早於 start_period。");
    if (end - start + 1 > 12) {
      throw new MopsfinError("INVALID_ARGUMENT", "批次指標指定範圍最多 12 季。", {
        reason: "WORK_BUDGET_EXCEEDED",
      });
    }
  }
  if (query.basis === "cumulative_yoy") {
    if (!Number.isInteger(query.yoyQuarter) || (query.yoyQuarter as number) < 1 || (query.yoyQuarter as number) > 4) {
      throw new MopsfinError("INVALID_ARGUMENT", "cumulative_yoy 必須提供 Q1–Q4 的 yoy_quarter。");
    }
  } else if (query.yoyQuarter !== undefined) {
    throw new MopsfinError("INVALID_ARGUMENT", "quarterly 不得提供 yoy_quarter。");
  }
  return { companyCodes, metricCodes };
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        result[index] = await task(values[index]);
      }
    }),
  );
  return result;
}

function mergeMetricResults(
  metric: MetricDefinition,
  chunkResults: Array<SingleMetricResult | null>,
  companyChunks: string[][],
  companyCodes: string[],
): {
  periods: string[];
  byCompany: Map<string, CompanyMetricsBatchMetric>;
  returnedCompanyCodes: string[];
  missingCompanyCodes: string[];
  noValidDataCompanyCodes: string[];
} {
  const periods = [
    ...new Set(chunkResults.flatMap((result) => result?.periods ?? [])),
  ].sort().slice(-12);
  const periodsByCompany = new Map<string, string[]>();
  chunkResults.forEach((result, index) => {
    const chunkPeriods = [...new Set(result?.periods ?? [])].sort().slice(-12);
    for (const companyCode of companyChunks[index]) {
      periodsByCompany.set(
        companyCode,
        chunkPeriods.length > 0 ? chunkPeriods : periods,
      );
    }
  });
  const seriesByCode = new Map(
    chunkResults.flatMap((result) =>
      (result?.series ?? [])
        .filter((series) => series.seriesType === "company")
        .map((series) => [series.companyCode.toLowerCase(), series] as const),
    ),
  );
  const byCompany = new Map<string, CompanyMetricsBatchMetric>();
  const returnedCompanyCodes: string[] = [];
  const missingCompanyCodes: string[] = [];
  const noValidDataCompanyCodes: string[] = [];
  for (const companyCode of companyCodes) {
    const series = seriesByCode.get(companyCode.toLowerCase());
    const companyPeriods = periodsByCompany.get(companyCode) ?? periods;
    const pointByPeriod = new Map(series?.points.map((point) => [point.period, point]));
    const points = companyPeriods.map(
      (period): TrendPoint =>
        pointByPeriod.get(period) ?? {
          period,
          value: null,
          valueStatus: "missing",
        },
    );
    const reported = points.filter((point) => point.valueStatus === "reported");
    const invalidPoints = points.filter((point) => point.valueStatus === "invalid_upstream").length;
    if (series) returnedCompanyCodes.push(companyCode);
    else missingCompanyCodes.push(companyCode);
    if (reported.length === 0) noValidDataCompanyCodes.push(companyCode);
    byCompany.set(companyCode, {
      metricCode: metric.code,
      metricName: metric.name,
      unit: chunkResults.find(Boolean)?.unit || metric.unit,
      periods: companyPeriods,
      points,
      coverage: {
        seriesReturned: Boolean(series),
        nonNullPoints: reported.length,
        missingPoints: points.length - reported.length,
        invalidPoints,
        firstReportedPeriod: reported.at(0)?.period ?? null,
        latestReportedPeriod: reported.at(-1)?.period ?? null,
        missingPeriods: points
          .filter((point) => point.valueStatus !== "reported")
          .map((point) => point.period),
      },
    });
  }
  return {
    periods,
    byCompany,
    returnedCompanyCodes,
    missingCompanyCodes,
    noValidDataCompanyCodes,
  };
}

export class CompanyMetricsBatchClient {
  constructor(
    private readonly client: MopsfinClient = mopsfinClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCompanyMetricsBatch(query: CompanyMetricsBatchQuery): Promise<CompanyMetricsBatchResult> {
    const { companyCodes, metricCodes } = validateQuery(query);
    const companyChunks = chunks(companyCodes, 10);
    const workUnits = companyChunks.length * metricCodes.length;
    if (workUnits > 24) {
      throw new MopsfinError("INVALID_ARGUMENT", "批次指標工作量超過每頁 24 units。", {
        reason: "WORK_BUDGET_EXCEEDED",
        details: {
          workUnits,
          comparisonWorkUnits: workUnits,
          identityLookupUpperBound: companyCodes.length,
          maximum: 24,
          maximumComparisonWorkUnits: 24,
        },
      });
    }
    const catalog = await this.client.getCatalog();
    const metrics = metricCodes.map((code) => {
      const metric = catalog.metrics.find((candidate) => candidate.code === code && candidate.family === "data");
      if (!metric) {
        throw new MopsfinError("NOT_FOUND", `找不到 family=data 的 metric_code ${code}；請先呼叫 list_catalog。`);
      }
      return metric;
    });
    const identities = await this.client.resolveCompanies(companyCodes, {
      maximumCompanyCount: 100,
    });
    const identityByCode = new Map(
      identities.map((company) => [company.code.toLowerCase(), company]),
    );
    const identityChunks = companyChunks.map((companyChunk) =>
      companyChunk.map((companyCode) => {
        const identity = identityByCode.get(companyCode.toLowerCase());
        if (!identity) {
          throw new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `公司 identity 解析結果缺少 ${companyCode}。`,
          );
        }
        return identity;
      }),
    );
    const jobs = metrics.flatMap((metric) =>
      companyChunks.map((companyChunk, chunkIndex) => ({
        metric,
        companyChunk,
        identities: identityChunks[chunkIndex],
      })),
    );
    const results = await mapWithConcurrency(jobs, 3, async ({ metric, companyChunk, identities }) => {
      try {
        return await this.client.getCompanyMetric(
          {
            metricCode: metric.code,
            companyCodes: companyChunk,
            basis: query.basis,
            yoyQuarter: query.yoyQuarter,
            includeIndustryAverage: false,
            includeCompanyAverage: false,
            range: {
              history: "recent_12",
              startPeriod: query.startPeriod,
              endPeriod: query.endPeriod,
            },
          },
          identities,
        );
      } catch (error) {
        if (error instanceof MopsfinError && error.code === "NO_DATA") return null;
        throw error;
      }
    });

    const mergedByMetric = metrics.map((metric, metricIndex) =>
      mergeMetricResults(
        metric,
        results.slice(
          metricIndex * companyChunks.length,
          (metricIndex + 1) * companyChunks.length,
        ),
        companyChunks,
        companyCodes,
      ),
    );
    const companies = companyCodes.map((companyCode) => {
      const identity = identityByCode.get(companyCode.toLowerCase()) as CompanySuggestion;
      return {
        companyCode,
        companyName: identity.name,
        displayName: identity.displayName,
        metrics: mergedByMetric.map((merged) => merged.byCompany.get(companyCode) as CompanyMetricsBatchMetric),
      };
    });
    const noValidDataCompanyCodes = companies
      .filter((company) => company.metrics.every((metric) => metric.coverage.nonNullPoints === 0))
      .map((company) => company.companyCode);
    const missingCompanyCodes = companies
      .filter((company) => company.metrics.some((metric) => !metric.coverage.seriesReturned))
      .map((company) => company.companyCode);
    const selectionComplete = mergedByMetric.every(
      (metric) =>
        metric.missingCompanyCodes.length === 0 &&
        metric.noValidDataCompanyCodes.length === 0,
    );
    const sources = results
      .filter((result): result is SingleMetricResult => Boolean(result))
      .map((result) => ({
        sourceName: result.sourceName,
        sourceUrl: result.sourceUrl,
        retrievedAt: result.retrievedAt,
        upstreamRoute: result.upstreamRoute,
        freshnessNote: result.freshnessNote,
      }));
    const normalizedQuery = {
      companyCodes,
      metricCodes,
      basis: query.basis,
      ...(query.yoyQuarter ? { yoyQuarter: query.yoyQuarter } : {}),
      history: "recent_12" as const,
      ...(query.startPeriod ? { startPeriod: query.startPeriod } : {}),
      ...(query.endPeriod ? { endPeriod: query.endPeriod } : {}),
    };
    const metricDefinitions = metrics.map(({ code, name, unit, category }) => ({
      code,
      name,
      unit,
      category,
    }));
    const coverage = {
      selectionComplete,
      requestedCompanyCodes: companyCodes,
      returnedCompanyCodes: companyCodes.filter(
        (code) => !missingCompanyCodes.includes(code),
      ),
      missingCompanyCodes,
      noValidDataCompanyCodes,
      metrics: metrics.map((metric, index) => ({
        metricCode: metric.code,
        returnedCompanyCodes: mergedByMetric[index].returnedCompanyCodes,
        missingCompanyCodes: mergedByMetric[index].missingCompanyCodes,
        noValidDataCompanyCodes:
          mergedByMetric[index].noValidDataCompanyCodes,
      })),
    };
    const retrievedAt = this.now().toISOString();
    const snapshotId = createHash("sha256")
      .update(
        JSON.stringify({
          query: normalizedQuery,
          metricDefinitions,
          companies,
          coverage,
          sources: sources.map(({ sourceUrl, upstreamRoute, freshnessNote }) => ({
            sourceUrl,
            upstreamRoute,
            freshnessNote,
          })),
        }),
      )
      .digest("hex")
      .slice(0, 24);
    return {
      query: normalizedQuery,
      retrievedAt,
      snapshotId,
      metricDefinitions,
      companies,
      coverage,
      sources,
      warnings: [
        "批次工具不包含產業平均或所選公司平均；每頁每家公司都包含全部 requested metrics。",
        `本頁 comparison work units=${workUnits}/24；identity logical lookup 上限=${companyCodes.length}（cache hit 可減少，HTTP retry 另計），且每個代號的解析結果會跨全部 requested metrics 重用。`,
        ...(missingCompanyCodes.length > 0
          ? [`部分公司至少一項指標未回傳 series：${missingCompanyCodes.join("、")}。`]
          : []),
        ...(noValidDataCompanyCodes.length > 0
          ? [`部分公司在全部 requested metrics 中沒有 reported 值：${noValidDataCompanyCodes.join("、")}。`]
          : []),
      ],
    };
  }
}

export const companyMetricsBatchClient = new CompanyMetricsBatchClient();
