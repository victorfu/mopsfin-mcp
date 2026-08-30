import { createHash } from "node:crypto";

import {
  MopsfinError,
  asMopsfinError,
  type MopsfinErrorAction,
  type MopsfinErrorCode,
} from "@/lib/mopsfin/errors";
import {
  mopsfinClient,
  type MopsfinClient,
} from "@/lib/mopsfin/client";
import type { SourceMetadata, TrendPoint } from "@/lib/mopsfin/types";

import {
  isFinancialMetricApplicable,
  resolvedFinancialMetric,
  type FinancialScreenMetricCatalogResolution,
  type FinancialScreenMetricRole,
  type ResolvedFinancialScreenMetric,
} from "./metric-roles";
import type {
  FinancialInstitutionMapping,
  SupportedFinancialSector,
} from "./types";

export type FinancialInstitutionMetricAvailability =
  | "available"
  | "no_data"
  | "unavailable"
  | "not_applicable";

export interface FinancialInstitutionBatchMetric {
  role: FinancialScreenMetricRole;
  metricCode: string;
  metricName: string;
  family: "fin" | "adequacy";
  unit: string;
  availability: FinancialInstitutionMetricAvailability;
  periods: string[];
  points: TrendPoint[];
  industryAveragePoints: TrendPoint[];
  coverage: {
    seriesReturned: boolean;
    nonNullPoints: number;
    missingPoints: number;
    invalidPoints: number;
    firstReportedPeriod: string | null;
    latestReportedPeriod: string | null;
    missingPeriods: string[];
    industryAverageSeriesReturned: boolean;
  };
  failure: FinancialInstitutionBatchFailureDetail | null;
}

export interface FinancialInstitutionBatchCompany {
  companyCode: string;
  institutionCode: string;
  institutionName: string;
  sector: SupportedFinancialSector;
  evaluationStatus: "complete" | "partial" | "unavailable";
  metrics: FinancialInstitutionBatchMetric[];
}

export interface FinancialInstitutionBatchFailureDetail {
  code: MopsfinErrorCode;
  reason: string | null;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  action: MopsfinErrorAction;
}

export type FinancialInstitutionBatchFailure =
  FinancialInstitutionBatchFailureDetail & {
    companyCode: string;
    institutionCode: string;
    metricRole: FinancialScreenMetricRole;
    metricCode: string;
    attribution: "institution" | "chunk";
  };

export interface FinancialInstitutionBatchQuery {
  mappings: FinancialInstitutionMapping[];
  metricRoles: FinancialScreenMetricRole[];
  resolution: FinancialScreenMetricCatalogResolution;
  startPeriod?: string;
  endPeriod?: string;
}

export interface FinancialInstitutionBatchResult {
  query: {
    companyCodes: string[];
    institutionCodes: string[];
    metricRoles: FinancialScreenMetricRole[];
    history: "recent_12";
    startPeriod?: string;
    endPeriod?: string;
  };
  retrievedAt: string;
  snapshotId: string;
  catalogDiscoveredAt: string;
  catalogSnapshotId: string;
  metricDefinitions: ResolvedFinancialScreenMetric[];
  companies: FinancialInstitutionBatchCompany[];
  failures: FinancialInstitutionBatchFailure[];
  coverage: {
    selectionComplete: boolean;
    sourceComplete: boolean;
    failureIsolationComplete: boolean;
    requestedCompanyCodes: string[];
    unavailableCompanyCodes: string[];
    noValidDataCompanyCodes: string[];
    metrics: Array<{
      role: FinancialScreenMetricRole;
      metricCode: string;
      applicableCompanyCodes: string[];
      availableCompanyCodes: string[];
      noDataCompanyCodes: string[];
      unavailableCompanyCodes: string[];
      notApplicableCompanyCodes: string[];
    }>;
  };
  workBudget: {
    comparisonPlanUnits: number;
    comparisonExecutedUnits: number;
    isolationRetryUnits: number;
    comparisonUnitLimit: 24;
    concurrencyLimit: 2;
    unitDefinition: "one_financial_metric_by_up_to_ten_institutions_request";
  };
  sources: SourceMetadata[];
  warnings: string[];
}

type SingleMetricResult = Awaited<
  ReturnType<MopsfinClient["getFinancialInstitutionMetric"]>
>;

interface MetricJob {
  role: FinancialScreenMetricRole;
  metric: ResolvedFinancialScreenMetric & { family: "fin" | "adequacy" };
  mappings: FinancialInstitutionMapping[];
}

interface MetricJobOutcome {
  role: FinancialScreenMetricRole;
  metricCode: string;
  mappings: FinancialInstitutionMapping[];
  result: SingleMetricResult | null;
  failure: FinancialInstitutionBatchFailureDetail | null;
  error?: MopsfinError;
}

const COMPARISON_UNIT_LIMIT = 24 as const;
const CONCURRENCY_LIMIT = 2 as const;

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

function validateQuery(query: FinancialInstitutionBatchQuery): {
  mappings: Array<FinancialInstitutionMapping & {
    status: "mapped";
    institutionCode: string;
    institutionName: string;
    sector: SupportedFinancialSector;
  }>;
  metricRoles: FinancialScreenMetricRole[];
} {
  if (query.mappings.length < 1 || query.mappings.length > 100) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "金融機構批次 mappings 必須包含 1 至 100 家公司。",
    );
  }
  const mappings = query.mappings.map((mapping) => {
    if (
      mapping.status !== "mapped" ||
      !mapping.institutionCode ||
      !mapping.institutionName ||
      !mapping.sector
    ) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        `公司 ${mapping.companyCode} 沒有可供金融批次使用的唯一 mapped institution identity。`,
      );
    }
    return mapping as FinancialInstitutionMapping & {
      status: "mapped";
      institutionCode: string;
      institutionName: string;
      sector: SupportedFinancialSector;
    };
  });
  if (new Set(mappings.map((mapping) => mapping.companyCode)).size !== mappings.length) {
    throw new MopsfinError("INVALID_ARGUMENT", "金融機構批次 company codes 不得重複。");
  }
  if (
    new Set(mappings.map((mapping) => mapping.institutionCode)).size !== mappings.length
  ) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "同一金融機構不得映射到多個股票代號。",
    );
  }
  if (query.metricRoles.length < 1) {
    throw new MopsfinError("INVALID_ARGUMENT", "metricRoles 不得為空。");
  }
  if (new Set(query.metricRoles).size !== query.metricRoles.length) {
    throw new MopsfinError("INVALID_ARGUMENT", "metricRoles 不得重複。");
  }
  for (const role of query.metricRoles) {
    const metric = resolvedFinancialMetric(query.resolution, role);
    if (metric.family !== "fin" && metric.family !== "adequacy") {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        `金融機構批次不接受 family=${metric.family} 的 role ${role}。`,
      );
    }
  }
  if ((query.startPeriod === undefined) !== (query.endPeriod === undefined)) {
    throw new MopsfinError(
      "INVALID_ARGUMENT",
      "startPeriod 與 endPeriod 必須同時提供或同時省略。",
    );
  }
  return { mappings, metricRoles: [...query.metricRoles] };
}

function failureDetail(error: MopsfinError): FinancialInstitutionBatchFailureDetail {
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
    error.code === "NOT_FOUND" ||
    error.reason === "UPSTREAM_DEADLINE_EXCEEDED";
}

function canBisect(error: MopsfinError): boolean {
  return !mustPropagate(error) &&
    error.code === "UPSTREAM_BAD_RESPONSE" &&
    error.retryable !== true;
}

function isSourceFailure(failure: FinancialInstitutionBatchFailure): boolean {
  return failure.code === "INCOMPLETE_COVERAGE" ||
    failure.code === "UPSTREAM_TIMEOUT" ||
    failure.code === "UPSTREAM_RATE_LIMITED" ||
    failure.code === "UPSTREAM_BAD_RESPONSE";
}

function sourceIdentity(source: SourceMetadata): string {
  return JSON.stringify([
    source.sourceName,
    source.sourceUrl,
    source.retrievedAt,
    source.upstreamRoute,
  ]);
}

function uniqueSources(sources: SourceMetadata[]): SourceMetadata[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const identity = sourceIdentity(source);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function assertIndustryAverageConsistency(
  outcomes: MetricJobOutcome[],
): void {
  const roles = [...new Set(outcomes.map((outcome) => outcome.role))];
  for (const role of roles) {
    const pointSets = outcomes
      .filter((outcome) => outcome.role === role && outcome.result !== null)
      .flatMap((outcome) =>
        (outcome.result?.series ?? [])
          .filter((series) => series.seriesType === "industry_average")
          .map((series) => JSON.stringify(series.points))
      );
    if (new Set(pointSets).size > 1) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        `金融指標 ${role} 在不同 chunk 回傳不一致的產業平均。`,
        { reason: "FINANCIAL_INDUSTRY_AVERAGE_INCONSISTENT" },
      );
    }
  }
}

function normalizeMetricForCompany(options: {
  mapping: FinancialInstitutionMapping & {
    institutionCode: string;
    sector: SupportedFinancialSector;
  };
  role: FinancialScreenMetricRole;
  metric: ResolvedFinancialScreenMetric & { family: "fin" | "adequacy" };
  outcome: MetricJobOutcome | undefined;
  applicable: boolean;
}): FinancialInstitutionBatchMetric {
  const { mapping, role, metric, outcome, applicable } = options;
  if (!applicable) {
    return {
      role,
      metricCode: metric.metricCode,
      metricName: metric.metricName,
      family: metric.family,
      unit: metric.unit,
      availability: "not_applicable",
      periods: [],
      points: [],
      industryAveragePoints: [],
      coverage: {
        seriesReturned: false,
        nonNullPoints: 0,
        missingPoints: 0,
        invalidPoints: 0,
        firstReportedPeriod: null,
        latestReportedPeriod: null,
        missingPeriods: [],
        industryAverageSeriesReturned: false,
      },
      failure: null,
    };
  }
  if (outcome?.failure) {
    return {
      role,
      metricCode: metric.metricCode,
      metricName: metric.metricName,
      family: metric.family,
      unit: metric.unit,
      availability: "unavailable",
      periods: [],
      points: [],
      industryAveragePoints: [],
      coverage: {
        seriesReturned: false,
        nonNullPoints: 0,
        missingPoints: 0,
        invalidPoints: 0,
        firstReportedPeriod: null,
        latestReportedPeriod: null,
        missingPeriods: [],
        industryAverageSeriesReturned: false,
      },
      failure: outcome.failure,
    };
  }
  const result = outcome?.result ?? null;
  const institutionSeries = result?.series.find(
    (series) =>
      series.seriesType === "institution" &&
      series.institutionCode === mapping.institutionCode,
  );
  const industryAverageSeries = result?.series.filter(
    (series) => series.seriesType === "industry_average",
  ) ?? [];
  if (industryAverageSeries.length > 1) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `${metric.metricCode} 回傳多個產業平均 series，無法安全選擇。`,
      { reason: "FINANCIAL_INDUSTRY_AVERAGE_AMBIGUOUS" },
    );
  }
  const periods = result?.periods ?? [];
  const pointByPeriod = new Map(
    institutionSeries?.points.map((point) => [point.period, point]),
  );
  const points = periods.map(
    (period): TrendPoint =>
      pointByPeriod.get(period) ?? {
        period,
        value: null,
        valueStatus: "missing",
      },
  );
  const reported = points.filter((point) => point.valueStatus === "reported");
  const invalidPoints = points.filter(
    (point) => point.valueStatus === "invalid_upstream",
  ).length;
  return {
    role,
    metricCode: metric.metricCode,
    metricName: metric.metricName,
    family: metric.family,
    unit: result?.unit || metric.unit,
    availability: reported.length > 0 ? "available" : "no_data",
    periods,
    points,
    industryAveragePoints: industryAverageSeries[0]?.points ?? [],
    coverage: {
      seriesReturned: institutionSeries !== undefined,
      nonNullPoints: reported.length,
      missingPoints: points.length - reported.length,
      invalidPoints,
      firstReportedPeriod: reported[0]?.period ?? null,
      latestReportedPeriod: reported.at(-1)?.period ?? null,
      missingPeriods: points
        .filter((point) => point.valueStatus !== "reported")
        .map((point) => point.period),
      industryAverageSeriesReturned: industryAverageSeries.length === 1,
    },
    failure: null,
  };
}

export class FinancialInstitutionMetricsBatchClient {
  constructor(
    private readonly client: Pick<MopsfinClient, "getFinancialInstitutionMetric"> =
      mopsfinClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getFinancialInstitutionMetricsBatch(
    query: FinancialInstitutionBatchQuery,
  ): Promise<FinancialInstitutionBatchResult> {
    const { mappings, metricRoles } = validateQuery(query);
    const metrics = metricRoles.map((role) => {
      const metric = resolvedFinancialMetric(query.resolution, role);
      return metric as ResolvedFinancialScreenMetric & { family: "fin" | "adequacy" };
    });
    const jobs: MetricJob[] = metrics.flatMap((metric) => {
      const applicableMappings = mappings.filter((mapping) =>
        metric.applicableSectors.includes(mapping.sector)
      );
      return chunks(applicableMappings, 10).map((mappingChunk) => ({
        role: metric.role,
        metric,
        mappings: mappingChunk,
      }));
    });
    if (jobs.length > COMPARISON_UNIT_LIMIT) {
      throw new MopsfinError(
        "INVALID_ARGUMENT",
        "金融機構批次工作量超過每頁 24 units。",
        {
          reason: "WORK_BUDGET_EXCEEDED",
          details: {
            workUnits: jobs.length,
            maximum: COMPARISON_UNIT_LIMIT,
          },
        },
      );
    }

    let isolationRetryUnits = 0;
    let failureIsolationComplete = true;
    const runJob = async (job: MetricJob): Promise<MetricJobOutcome[]> => {
      try {
        const result = await this.client.getFinancialInstitutionMetric({
          metricCode: job.metric.metricCode,
          institutionCodes: job.mappings.map(
            (mapping) => mapping.institutionCode as string,
          ),
          includeIndustryAverage: true,
          includeInstitutionAverage: false,
          range: {
            history: "recent_12",
            startPeriod: query.startPeriod,
            endPeriod: query.endPeriod,
          },
        });
        return [{
          role: job.role,
          metricCode: job.metric.metricCode,
          mappings: job.mappings,
          result,
          failure: null,
        }];
      } catch (rawError) {
        const error = asMopsfinError(rawError);
        if (error.code === "NO_DATA") {
          return [{
            role: job.role,
            metricCode: job.metric.metricCode,
            mappings: job.mappings,
            result: null,
            failure: null,
          }];
        }
        if (mustPropagate(error)) throw error;
        if (canBisect(error) && job.mappings.length > 1) {
          const remainingUnits =
            COMPARISON_UNIT_LIMIT - jobs.length - isolationRetryUnits;
          if (remainingUnits >= 2) {
            isolationRetryUnits += 2;
            const splitAt = Math.ceil(job.mappings.length / 2);
            const left = await runJob({
              ...job,
              mappings: job.mappings.slice(0, splitAt),
            });
            const right = await runJob({
              ...job,
              mappings: job.mappings.slice(splitAt),
            });
            return [...left, ...right];
          }
          failureIsolationComplete = false;
        }
        if (job.mappings.length > 1) failureIsolationComplete = false;
        return [{
          role: job.role,
          metricCode: job.metric.metricCode,
          mappings: job.mappings,
          result: null,
          failure: failureDetail(error),
          error,
        }];
      }
    };
    const outcomes = (
      await mapWithConcurrency(jobs, CONCURRENCY_LIMIT, runJob)
    ).flat();
    assertIndustryAverageConsistency(outcomes);
    if (jobs.length > 0 && outcomes.every((outcome) => outcome.failure !== null)) {
      const firstError = outcomes.find((outcome) => outcome.error)?.error;
      if (firstError) throw firstError;
    }
    const outcomeFor = (
      role: FinancialScreenMetricRole,
      institutionCode: string,
    ) => outcomes.find(
      (outcome) =>
        outcome.role === role &&
        outcome.mappings.some(
          (mapping) => mapping.institutionCode === institutionCode,
        ),
    );
    const companies = mappings.map((mapping): FinancialInstitutionBatchCompany => {
      const companyMetrics = metrics.map((metric) =>
        normalizeMetricForCompany({
          mapping,
          role: metric.role,
          metric,
          outcome: outcomeFor(metric.role, mapping.institutionCode),
          applicable: isFinancialMetricApplicable(
            query.resolution,
            metric.role,
            mapping.sector,
          ),
        })
      );
      const applicable = companyMetrics.filter(
        (metric) => metric.availability !== "not_applicable",
      );
      const unavailable = applicable.filter(
        (metric) => metric.availability === "unavailable",
      );
      const available = applicable.filter(
        (metric) => metric.availability === "available",
      );
      return {
        companyCode: mapping.companyCode,
        institutionCode: mapping.institutionCode,
        institutionName: mapping.institutionName,
        sector: mapping.sector,
        evaluationStatus:
          unavailable.length === applicable.length && applicable.length > 0
            ? "unavailable"
            : available.length === applicable.length
              ? "complete"
              : "partial",
        metrics: companyMetrics,
      };
    });
    const failures: FinancialInstitutionBatchFailure[] = outcomes.flatMap(
      (outcome): FinancialInstitutionBatchFailure[] =>
        outcome.failure
          ? outcome.mappings.map((mapping) => ({
              companyCode: mapping.companyCode,
              institutionCode: mapping.institutionCode as string,
              metricRole: outcome.role,
              metricCode: outcome.metricCode,
              attribution:
                outcome.mappings.length === 1 ? "institution" : "chunk",
              ...outcome.failure as FinancialInstitutionBatchFailureDetail,
            }))
          : [],
    );
    if (failures.some((failure) => failure.attribution === "chunk")) {
      failureIsolationComplete = false;
    }
    const unavailableCompanyCodes = companies
      .filter((company) =>
        company.metrics.some((metric) => metric.availability === "unavailable")
      )
      .map((company) => company.companyCode);
    const noValidDataCompanyCodes = companies
      .filter((company) => {
        const applicable = company.metrics.filter(
          (metric) => metric.availability !== "not_applicable",
        );
        return applicable.length > 0 &&
          applicable.every((metric) => metric.availability !== "available");
      })
      .map((company) => company.companyCode);
    const metricCoverage = metrics.map((metric) => {
      const companyMetrics = companies.map((company) => ({
        companyCode: company.companyCode,
        metric: company.metrics.find((candidate) => candidate.role === metric.role) as
          FinancialInstitutionBatchMetric,
      }));
      return {
        role: metric.role,
        metricCode: metric.metricCode,
        applicableCompanyCodes: companyMetrics
          .filter(({ metric }) => metric.availability !== "not_applicable")
          .map(({ companyCode }) => companyCode),
        availableCompanyCodes: companyMetrics
          .filter(({ metric }) => metric.availability === "available")
          .map(({ companyCode }) => companyCode),
        noDataCompanyCodes: companyMetrics
          .filter(({ metric }) => metric.availability === "no_data")
          .map(({ companyCode }) => companyCode),
        unavailableCompanyCodes: companyMetrics
          .filter(({ metric }) => metric.availability === "unavailable")
          .map(({ companyCode }) => companyCode),
        notApplicableCompanyCodes: companyMetrics
          .filter(({ metric }) => metric.availability === "not_applicable")
          .map(({ companyCode }) => companyCode),
      };
    });
    const sources = uniqueSources(
      outcomes.flatMap((outcome): SourceMetadata[] =>
        outcome.result
          ? [{
              sourceName: outcome.result.sourceName,
              sourceUrl: outcome.result.sourceUrl,
              retrievedAt: outcome.result.retrievedAt,
              ...(outcome.result.cache ? { cache: outcome.result.cache } : {}),
              upstreamRoute: outcome.result.upstreamRoute,
              freshnessNote: outcome.result.freshnessNote,
            }]
          : []
      ),
    );
    const normalizedQuery = {
      companyCodes: mappings.map((mapping) => mapping.companyCode),
      institutionCodes: mappings.map((mapping) => mapping.institutionCode),
      metricRoles,
      history: "recent_12" as const,
      ...(query.startPeriod ? { startPeriod: query.startPeriod } : {}),
      ...(query.endPeriod ? { endPeriod: query.endPeriod } : {}),
    };
    const coverage = {
      selectionComplete:
        companies.every((company) =>
          company.metrics.every(
            (metric) =>
              metric.availability === "available" ||
              metric.availability === "not_applicable",
          )
        ),
      sourceComplete: !failures.some(isSourceFailure),
      failureIsolationComplete,
      requestedCompanyCodes: mappings.map((mapping) => mapping.companyCode),
      unavailableCompanyCodes,
      noValidDataCompanyCodes,
      metrics: metricCoverage,
    };
    const workBudget = {
      comparisonPlanUnits: jobs.length,
      comparisonExecutedUnits: jobs.length + isolationRetryUnits,
      isolationRetryUnits,
      comparisonUnitLimit: COMPARISON_UNIT_LIMIT,
      concurrencyLimit: CONCURRENCY_LIMIT,
      unitDefinition:
        "one_financial_metric_by_up_to_ten_institutions_request" as const,
    };
    const metricDefinitions = metrics.map((metric) => ({ ...metric }));
    const snapshotId = createHash("sha256")
      .update(JSON.stringify({
        query: normalizedQuery,
        catalogSnapshotId: query.resolution.catalogSnapshotId,
        metricDefinitions,
        companies,
        failures,
        coverage,
        workBudget,
        sources: sources.map(({ sourceUrl, upstreamRoute }) => ({
          sourceUrl,
          upstreamRoute,
        })),
      }))
      .digest("hex")
      .slice(0, 24);
    return {
      query: normalizedQuery,
      retrievedAt:
        sources.map((source) => source.retrievedAt).sort().at(-1) ??
        this.now().toISOString(),
      snapshotId,
      catalogDiscoveredAt: query.resolution.catalogDiscoveredAt,
      catalogSnapshotId: query.resolution.catalogSnapshotId,
      metricDefinitions,
      companies,
      failures,
      coverage,
      workBudget,
      sources,
      warnings: [
        "金融機構批次只依 exact mapped institution identity 查詢；不適用子業別的 role 不送上游請求，並明示 not_applicable。",
        "NO_DATA、缺少 institution series 或缺值保留為 no_data/null；產業平均有值不能替代受查機構證據。",
        `本頁金融 comparison work units=${workBudget.comparisonExecutedUnits}/24（planned=${jobs.length}、isolation=${isolationRetryUnits}），domain concurrency=${CONCURRENCY_LIMIT}。`,
        ...(!failureIsolationComplete
          ? ["部分金融指標錯誤只能歸因到共享 metric×chunk，或隔離預算已用盡。"]
          : []),
      ],
    };
  }
}

export const financialInstitutionMetricsBatchClient =
  new FinancialInstitutionMetricsBatchClient();
