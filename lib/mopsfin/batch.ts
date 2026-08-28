import { createHash } from "node:crypto";

import {
  mopsfinClient,
  type CompanyMetricBasis,
  type MopsfinClient,
} from "./client";
import {
  MopsfinError,
  type MopsfinErrorAction,
  type MopsfinErrorCode,
} from "./errors";
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
  availability: "available" | "no_data" | "unavailable";
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
  failure: CompanyMetricsBatchFailureDetail | null;
}

export interface CompanyMetricsBatchCompany {
  companyCode: string;
  companyName: string;
  displayName: string;
  evaluationStatus: "complete" | "partial" | "unavailable";
  metrics: CompanyMetricsBatchMetric[];
}

export interface CompanyMetricsBatchFailureDetail {
  code: MopsfinErrorCode;
  reason: string | null;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  action: MopsfinErrorAction;
}

export type CompanyMetricsBatchFailure = CompanyMetricsBatchFailureDetail &
  (
    | {
        companyCode: string;
        stage: "identity";
        metricCode: null;
        attribution: "company";
      }
    | {
        companyCode: string;
        stage: "metric";
        metricCode: string;
        attribution: "company" | "chunk";
      }
  );

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
  failures: CompanyMetricsBatchFailure[];
  coverage: {
    selectionComplete: boolean;
    requestedCompanyCodes: string[];
    returnedCompanyCodes: string[];
    missingCompanyCodes: string[];
    noValidDataCompanyCodes: string[];
    unavailableCompanyCodes: string[];
    sourceComplete: boolean;
    failureIsolationComplete: boolean;
    identityFailedCompanyCodes: string[];
    metrics: Array<{
      metricCode: string;
      returnedCompanyCodes: string[];
      missingCompanyCodes: string[];
      noValidDataCompanyCodes: string[];
      unavailableCompanyCodes: string[];
    }>;
  };
  workBudget: {
    comparisonPlanUnits: number;
    comparisonExecutedUnits: number;
    isolationRetryUnits: number;
    comparisonUnitLimit: 24;
    identityLookupUpperBound: number;
    unitDefinition: "one_metric_by_up_to_ten_companies_request";
  };
  sources: SourceMetadata[];
  warnings: string[];
}

type SingleMetricResult = Awaited<ReturnType<MopsfinClient["getCompanyMetric"]>>;

interface MetricJob {
  metric: MetricDefinition;
  companyCodes: string[];
  identities: CompanySuggestion[];
}

interface MetricJobOutcome {
  metricCode: string;
  companyCodes: string[];
  result: SingleMetricResult | null;
  failure: CompanyMetricsBatchFailureDetail | null;
  error?: MopsfinError;
}

const COMPARISON_PLAN_UNIT_LIMIT = 24 as const;

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

function failureDetail(error: MopsfinError): CompanyMetricsBatchFailureDetail {
  return {
    code: error.code,
    reason: error.reason ?? null,
    message: error.message,
    retryable: error.retryable ?? false,
    retryAfterMs: error.retryAfterMs ?? null,
    action: error.action ?? (error.retryable ? "retry" : "none"),
  };
}

function mustPropagate(error: MopsfinError): boolean {
  return error.code === "INVALID_ARGUMENT" ||
    error.reason === "UPSTREAM_DEADLINE_EXCEEDED";
}

function canBisectMetricFailure(error: MopsfinError): boolean {
  if (mustPropagate(error)) return false;
  return error.code === "UPSTREAM_BAD_RESPONSE" && error.retryable !== true;
}

function inRequestedOrder(
  requestedCompanyCodes: string[],
  ...groups: string[][]
): string[] {
  const included = new Set(groups.flat().map((code) => code.toLowerCase()));
  return requestedCompanyCodes.filter((code) => included.has(code.toLowerCase()));
}

function isSourceFailure(failure: CompanyMetricsBatchFailure): boolean {
  return failure.code === "INCOMPLETE_COVERAGE" ||
    failure.code === "UPSTREAM_TIMEOUT" ||
    failure.code === "UPSTREAM_RATE_LIMITED" ||
    failure.code === "UPSTREAM_BAD_RESPONSE";
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
  outcomes: MetricJobOutcome[],
  companyCodes: string[],
): {
  periods: string[];
  byCompany: Map<string, CompanyMetricsBatchMetric>;
  returnedCompanyCodes: string[];
  missingCompanyCodes: string[];
  noValidDataCompanyCodes: string[];
  unavailableCompanyCodes: string[];
} {
  const periods = [
    ...new Set(outcomes.flatMap((outcome) => outcome.result?.periods ?? [])),
  ].sort().slice(-12);
  const periodsByCompany = new Map<string, string[]>();
  const outcomeByCompany = new Map<string, MetricJobOutcome>();
  outcomes.forEach((outcome) => {
    const chunkPeriods = [...new Set(outcome.result?.periods ?? [])].sort().slice(-12);
    for (const companyCode of outcome.companyCodes) {
      outcomeByCompany.set(companyCode.toLowerCase(), outcome);
      periodsByCompany.set(
        companyCode,
        chunkPeriods.length > 0 ? chunkPeriods : periods,
      );
    }
  });
  const seriesByCode = new Map(
    outcomes.flatMap((outcome) =>
      (outcome.result?.series ?? [])
        .filter((series) => series.seriesType === "company")
        .map((series) => [series.companyCode.toLowerCase(), series] as const),
    ),
  );
  const byCompany = new Map<string, CompanyMetricsBatchMetric>();
  const returnedCompanyCodes: string[] = [];
  const missingCompanyCodes: string[] = [];
  const noValidDataCompanyCodes: string[] = [];
  const unavailableCompanyCodes: string[] = [];
  for (const companyCode of companyCodes) {
    const outcome = outcomeByCompany.get(companyCode.toLowerCase());
    const unavailable = outcome?.failure ?? null;
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
    if (series && !unavailable) returnedCompanyCodes.push(companyCode);
    else missingCompanyCodes.push(companyCode);
    if (reported.length === 0) noValidDataCompanyCodes.push(companyCode);
    if (unavailable) unavailableCompanyCodes.push(companyCode);
    byCompany.set(companyCode, {
      metricCode: metric.code,
      metricName: metric.name,
      unit: outcomes.find((candidate) => candidate.result)?.result?.unit || metric.unit,
      availability: unavailable
        ? "unavailable"
        : reported.length > 0
          ? "available"
          : "no_data",
      periods: unavailable ? [] : companyPeriods,
      points: unavailable ? [] : points,
      coverage: {
        seriesReturned: Boolean(series) && !unavailable,
        nonNullPoints: unavailable ? 0 : reported.length,
        missingPoints: unavailable ? 0 : points.length - reported.length,
        invalidPoints: unavailable ? 0 : invalidPoints,
        firstReportedPeriod: unavailable ? null : reported.at(0)?.period ?? null,
        latestReportedPeriod: unavailable ? null : reported.at(-1)?.period ?? null,
        missingPeriods: unavailable
          ? []
          : points
              .filter((point) => point.valueStatus !== "reported")
              .map((point) => point.period),
      },
      failure: unavailable,
    });
  }
  return {
    periods,
    byCompany,
    returnedCompanyCodes,
    missingCompanyCodes,
    noValidDataCompanyCodes,
    unavailableCompanyCodes,
  };
}

export class CompanyMetricsBatchClient {
  constructor(
    private readonly client: MopsfinClient = mopsfinClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCompanyMetricsBatch(query: CompanyMetricsBatchQuery): Promise<CompanyMetricsBatchResult> {
    const { companyCodes, metricCodes } = validateQuery(query);
    const comparisonPlanUnits = chunks(companyCodes, 10).length * metricCodes.length;
    if (comparisonPlanUnits > COMPARISON_PLAN_UNIT_LIMIT) {
      throw new MopsfinError("INVALID_ARGUMENT", "批次指標工作量超過每頁 24 units。", {
        reason: "WORK_BUDGET_EXCEEDED",
        details: {
          workUnits: comparisonPlanUnits,
          comparisonWorkUnits: comparisonPlanUnits,
          identityLookupUpperBound: companyCodes.length,
          maximum: COMPARISON_PLAN_UNIT_LIMIT,
          maximumComparisonWorkUnits: COMPARISON_PLAN_UNIT_LIMIT,
        },
      });
    }
    const catalog = await this.client.getCatalog();
    const metrics = metricCodes.map((code) => {
      const metric = catalog.metrics.find((candidate) => candidate.code === code && candidate.family === "data");
      if (!metric) {
        throw new MopsfinError(
          "NOT_FOUND",
          `找不到 family=data 的 metric_code ${code}；請先呼叫 list_catalog。`,
          {
            reason: "CATALOG_METRIC_NOT_FOUND",
            retryable: false,
            action: "change_query",
            details: {
              metricCode: code,
              family: "data",
              catalogDiscoveredAt: catalog.discoveredAt,
            },
          },
        );
      }
      return metric;
    });
    const identityOutcomes = await mapWithConcurrency(companyCodes, 3, async (companyCode) => {
      try {
        const identities = await this.client.resolveCompanies([companyCode], {
          maximumCompanyCount: 1,
        });
        const identity = identities.find(
          (candidate) => candidate.code.toLowerCase() === companyCode.toLowerCase(),
        );
        if (!identity) {
          throw new MopsfinError(
            "UPSTREAM_BAD_RESPONSE",
            `公司 identity 解析結果缺少 ${companyCode}。`,
            {
              reason: "IDENTITY_RESULT_MISSING",
              retryable: false,
              action: "none",
            },
          );
        }
        return { companyCode, identity, error: null, failure: null };
      } catch (error) {
        if (!(error instanceof MopsfinError)) throw error;
        if (mustPropagate(error)) throw error;
        return {
          companyCode,
          identity: null,
          error,
          failure: failureDetail(error),
        };
      }
    });
    const resolvedIdentityOutcomes = identityOutcomes.filter(
      (outcome): outcome is typeof outcome & { identity: CompanySuggestion } =>
        outcome.identity !== null,
    );
    if (resolvedIdentityOutcomes.length === 0) {
      throw identityOutcomes.find((outcome) => outcome.error)?.error ??
        new MopsfinError(
          "UPSTREAM_BAD_RESPONSE",
          "本頁所有公司 identity 解析均失敗。",
          { reason: "BATCH_IDENTITY_RESOLUTION_FAILED" },
        );
    }
    const identityByCode = new Map(
      resolvedIdentityOutcomes.map(({ identity }) => [identity.code.toLowerCase(), identity]),
    );
    const resolvedCompanyCodes = companyCodes.filter((companyCode) =>
      identityByCode.has(companyCode.toLowerCase()),
    );
    const resolvedCompanyChunks = chunks(resolvedCompanyCodes, 10);
    const jobs: MetricJob[] = metrics.flatMap((metric) =>
      resolvedCompanyChunks.map((companyChunk) => ({
        metric,
        companyCodes: companyChunk,
        identities: companyChunk.map(
          (companyCode) => identityByCode.get(companyCode.toLowerCase()) as CompanySuggestion,
        ),
      })),
    );
    let isolationRetryUnits = 0;
    let failureIsolationComplete = true;
    const runMetricJob = async (job: MetricJob): Promise<MetricJobOutcome[]> => {
      try {
        const result = await this.client.getCompanyMetric(
          {
            metricCode: job.metric.code,
            companyCodes: job.companyCodes,
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
          job.identities,
        );
        return [{
          metricCode: job.metric.code,
          companyCodes: job.companyCodes,
          result,
          failure: null,
        }];
      } catch (error) {
        if (!(error instanceof MopsfinError)) throw error;
        if (error.code === "NO_DATA") {
          return [{
            metricCode: job.metric.code,
            companyCodes: job.companyCodes,
            result: null,
            failure: null,
          }];
        }
        if (mustPropagate(error) || error.code === "NOT_FOUND") throw error;
        if (canBisectMetricFailure(error) && job.companyCodes.length > 1) {
          const remainingUnits = COMPARISON_PLAN_UNIT_LIMIT - jobs.length - isolationRetryUnits;
          if (remainingUnits >= 2) {
            isolationRetryUnits += 2;
            const splitAt = Math.ceil(job.companyCodes.length / 2);
            const left = await runMetricJob({
              metric: job.metric,
              companyCodes: job.companyCodes.slice(0, splitAt),
              identities: job.identities.slice(0, splitAt),
            });
            const right = await runMetricJob({
              metric: job.metric,
              companyCodes: job.companyCodes.slice(splitAt),
              identities: job.identities.slice(splitAt),
            });
            return [...left, ...right];
          }
          failureIsolationComplete = false;
        }
        if (job.companyCodes.length > 1) failureIsolationComplete = false;
        return [{
          metricCode: job.metric.code,
          companyCodes: job.companyCodes,
          result: null,
          failure: failureDetail(error),
          error,
        }];
      }
    };
    const outcomeGroups = await mapWithConcurrency(jobs, 3, runMetricJob);
    const outcomes = outcomeGroups.flat();
    const completedMetricOutcomes = outcomes.filter((outcome) => !outcome.failure);
    if (jobs.length > 0 && completedMetricOutcomes.length === 0) {
      const firstError = outcomes.find((outcome) => outcome.error)?.error;
      if (firstError) throw firstError;
    }

    const outcomesByMetric = new Map(
      metrics.map((metric) => [
        metric.code,
        outcomes.filter((outcome) => outcome.metricCode === metric.code),
      ]),
    );
    const mergedByMetric = metrics.map((metric) =>
      mergeMetricResults(
        metric,
        outcomesByMetric.get(metric.code) ?? [],
        resolvedCompanyCodes,
      ),
    );
    const companies = resolvedCompanyCodes.map((companyCode) => {
      const identity = identityByCode.get(companyCode.toLowerCase()) as CompanySuggestion;
      const companyMetrics = mergedByMetric.map(
        (merged) => merged.byCompany.get(companyCode) as CompanyMetricsBatchMetric,
      );
      const availableMetrics = companyMetrics.filter(
        (metric) => metric.availability === "available",
      ).length;
      const unavailableMetrics = companyMetrics.filter(
        (metric) => metric.availability === "unavailable",
      ).length;
      return {
        companyCode,
        companyName: identity.name,
        displayName: identity.displayName,
        evaluationStatus:
          unavailableMetrics === companyMetrics.length
            ? "unavailable" as const
            : availableMetrics === companyMetrics.length
              ? "complete" as const
              : "partial" as const,
        metrics: companyMetrics,
      };
    });
    const identityFailures: CompanyMetricsBatchFailure[] = identityOutcomes.flatMap(
      (outcome): CompanyMetricsBatchFailure[] =>
        outcome.failure
          ? [{
              companyCode: outcome.companyCode,
              stage: "identity",
              metricCode: null,
              attribution: "company",
              ...outcome.failure,
            }]
          : [],
    );
    const metricFailures: CompanyMetricsBatchFailure[] = outcomes.flatMap(
      (outcome): CompanyMetricsBatchFailure[] =>
        outcome.failure
          ? outcome.companyCodes.map((companyCode) => ({
              companyCode,
              stage: "metric",
              metricCode: outcome.metricCode,
              attribution: outcome.companyCodes.length === 1 ? "company" : "chunk",
              ...outcome.failure as CompanyMetricsBatchFailureDetail,
            }))
          : [],
    );
    const failures = [...identityFailures, ...metricFailures];
    if (metricFailures.some((failure) => failure.attribution === "chunk")) {
      failureIsolationComplete = false;
    }
    const noValidDataCompanyCodes = companies
      .filter((company) => company.metrics.every((metric) => metric.coverage.nonNullPoints === 0))
      .map((company) => company.companyCode);
    const identityFailedCompanyCodes = identityFailures.map(
      (failure) => failure.companyCode,
    );
    const missingCompanyCodes = inRequestedOrder(
      companyCodes,
      identityFailedCompanyCodes,
      companies
      .filter((company) => company.metrics.some((metric) => !metric.coverage.seriesReturned))
      .map((company) => company.companyCode),
    );
    const unavailableCompanyCodes = inRequestedOrder(
      companyCodes,
      identityFailedCompanyCodes,
      companies
          .filter((company) =>
            company.metrics.some((metric) => metric.availability === "unavailable"),
          )
          .map((company) => company.companyCode),
    );
    const orderedNoValidDataCompanyCodes = inRequestedOrder(
      companyCodes,
      identityFailedCompanyCodes,
      noValidDataCompanyCodes,
    );
    const selectionComplete = mergedByMetric.every(
      (metric) =>
        metric.missingCompanyCodes.length === 0 &&
        metric.noValidDataCompanyCodes.length === 0,
    ) && identityFailures.length === 0 && failures.length === 0;
    const sources = outcomes
      .map((outcome) => outcome.result)
      .filter((result): result is SingleMetricResult => Boolean(result))
      .map((result) => ({
        sourceName: result.sourceName,
        sourceUrl: result.sourceUrl,
        retrievedAt: result.retrievedAt,
        upstreamRoute: result.upstreamRoute,
        freshnessNote: result.freshnessNote,
        ...(result.cache ? { cache: result.cache } : {}),
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
      returnedCompanyCodes: resolvedCompanyCodes.filter(
        (code) => !missingCompanyCodes.includes(code),
      ),
      missingCompanyCodes,
      noValidDataCompanyCodes: orderedNoValidDataCompanyCodes,
      unavailableCompanyCodes,
      sourceComplete: !failures.some(isSourceFailure),
      failureIsolationComplete,
      identityFailedCompanyCodes,
      metrics: metrics.map((metric, index) => ({
        metricCode: metric.code,
        returnedCompanyCodes: mergedByMetric[index].returnedCompanyCodes,
        missingCompanyCodes: inRequestedOrder(
          companyCodes,
          identityFailedCompanyCodes,
          mergedByMetric[index].missingCompanyCodes,
        ),
        noValidDataCompanyCodes: inRequestedOrder(
          companyCodes,
          identityFailedCompanyCodes,
          mergedByMetric[index].noValidDataCompanyCodes,
        ),
        unavailableCompanyCodes: inRequestedOrder(
          companyCodes,
          identityFailedCompanyCodes,
          mergedByMetric[index].unavailableCompanyCodes,
        ),
      })),
    };
    const workBudget = {
      comparisonPlanUnits,
      comparisonExecutedUnits: jobs.length + isolationRetryUnits,
      isolationRetryUnits,
      comparisonUnitLimit: COMPARISON_PLAN_UNIT_LIMIT,
      identityLookupUpperBound: companyCodes.length,
      unitDefinition: "one_metric_by_up_to_ten_companies_request" as const,
    };
    const retrievedAt =
      sources.map((source) => source.retrievedAt).sort().at(-1) ??
      this.now().toISOString();
    const snapshotId = createHash("sha256")
      .update(
        JSON.stringify({
          query: normalizedQuery,
          metricDefinitions,
          companies,
          failures,
          coverage,
          workBudget,
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
      failures,
      coverage,
      workBudget,
      sources,
      warnings: [
        "批次工具不包含產業平均或所選公司平均；完成 identity 的每家公司都保留全部 requested metrics，unavailable 不會被改寫成 no_data 或 0。",
        `本頁 comparison work units=${workBudget.comparisonExecutedUnits}/24（planned=${comparisonPlanUnits}、isolation=${isolationRetryUnits}）；identity logical lookup 上限=${companyCodes.length}（cache hit 可減少，HTTP retry 另計）。`,
        ...(identityFailures.length > 0
          ? [`部分公司 identity 失敗但未阻斷其他公司：${identityFailedCompanyCodes.join("、")}。`]
          : []),
        ...(metricFailures.length > 0
          ? [`部分公司指標查詢 unavailable，其他成功公司／指標仍保留：${unavailableCompanyCodes.join("、")}。`]
          : []),
        ...(!failureIsolationComplete
          ? ["部分指標錯誤只能歸因到共享的 metric×chunk request，或已用盡 24-unit 隔離預算；請依 failures[].attribution 判讀。"]
          : []),
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
