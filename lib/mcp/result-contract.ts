import { createHash } from "node:crypto";

import type { MopsfinError, MopsfinErrorCode } from "@/lib/mopsfin/errors";

export const RESULT_CONTRACT_VERSION = "mopsfin.result.v1" as const;

export type ResultAsOfSelector =
  | "latest"
  | "explicit"
  | "range"
  | "snapshot"
  | "none";
export type ResultAsOfGranularity =
  | "instant"
  | "date"
  | "month"
  | "quarter"
  | "mixed"
  | "none";
export type QualityStatus = "complete" | "partial";
export type QualityDimensionStatus =
  | "complete"
  | "partial"
  | "unknown"
  | "not_applicable";

export interface QualityIssue {
  code: string;
  severity: "info" | "warning";
  scope: "source" | "universe" | "selection" | "value" | "period" | "page";
  message: string;
  refs: {
    companyCodes: string[];
    fields: string[];
    periods: string[];
    sourceUrls: string[];
  };
}

export interface ResultPageMeta {
  mode: "none" | "offset" | "cursor";
  unit: "none" | "row" | "company" | "month";
  limit: number | null;
  returned: number | null;
  total: number | null;
  next:
    | null
    | { kind: "offset"; offset: number }
    | { kind: "cursor"; cursor: string };
}

export interface ResultMeta {
  contractVersion: typeof RESULT_CONTRACT_VERSION;
  asOf: {
    selector: ResultAsOfSelector;
    resolved: {
      granularity: ResultAsOfGranularity;
      from: string | null;
      through: string | null;
    };
    timezone: "Asia/Taipei";
    assembledAt: string;
    snapshotId: string | null;
    sourceCutoffs: Array<{
      sourceUrl: string;
      resolved: {
        granularity: ResultAsOfGranularity;
        from: string | null;
        through: string | null;
      };
      publishedAt: string | null;
      retrievedAt: string;
    }>;
  };
  quality: {
    status: QualityStatus;
    source: "complete" | "partial";
    universe: "verified" | "compatible" | "unverified" | "not_applicable";
    selection: QualityDimensionStatus;
    values: QualityDimensionStatus;
    freshness:
      | "within_expected_window"
      | "stale"
      | "unknown"
      | "not_applicable";
    issues: QualityIssue[];
  };
  page: ResultPageMeta;
}

export interface ResultMetaHints {
  selector?: ResultAsOfSelector;
  resolved?: {
    granularity: ResultAsOfGranularity;
    from: string | null;
    through: string | null;
  };
  page?: ResultPageMeta;
  source?: "complete" | "partial";
  universe?: ResultMeta["quality"]["universe"];
  selection?: QualityDimensionStatus;
  values?: QualityDimensionStatus;
  freshness?: ResultMeta["quality"]["freshness"];
  issues?: QualityIssue[];
  snapshotId?: string | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

function inferResolved(data: UnknownRecord): ResultMeta["asOf"]["resolved"] {
  const dataDate = readString(data, "dataDate");
  if (dataDate) return { granularity: "date", from: dataDate, through: dataDate };
  const dataMonth = readString(data, "dataMonth");
  if (dataMonth) return { granularity: "month", from: dataMonth, through: dataMonth };
  const period = readString(data, "period");
  if (period) return { granularity: "quarter", from: period, through: period };

  const coverage = isRecord(data.coverage) ? data.coverage : null;
  const requestedStart = coverage ? readString(coverage, "requestedStart") : null;
  const requestedEnd = coverage ? readString(coverage, "requestedEnd") : null;
  const coveredThrough = coverage ? readString(coverage, "coveredThrough") : null;
  if (requestedStart || requestedEnd || coveredThrough) {
    return {
      granularity: "date",
      from: requestedStart,
      through: coveredThrough ?? requestedEnd,
    };
  }

  const query = isRecord(data.query) ? data.query : null;
  const startPeriod = query ? readString(query, "startPeriod") : null;
  const endPeriod = query ? readString(query, "endPeriod") : null;
  if (startPeriod || endPeriod) {
    return {
      granularity: "quarter",
      from: startPeriod,
      through: endPeriod,
    };
  }

  const periods = Array.isArray(data.periods)
    ? data.periods.filter((value): value is string => typeof value === "string")
    : [];
  if (Array.isArray(data.series) && periods.length > 0) {
    const ordered = [...periods].sort();
    return {
      granularity: ordered.every((value) => /^\d{4}Q[1-4]$/.test(value))
        ? "quarter"
        : "mixed",
      from: ordered[0] ?? null,
      through: ordered.at(-1) ?? null,
    };
  }

  const instant =
    readString(data, "generatedAt") ??
    readString(data, "discoveredAt") ??
    readString(data, "retrievedAt");
  if (instant) return { granularity: "instant", from: instant, through: instant };
  return { granularity: "none", from: null, through: null };
}

function inferSelector(data: UnknownRecord, resolved: ResultMeta["asOf"]["resolved"]): ResultAsOfSelector {
  const query = isRecord(data.query) ? data.query : null;
  const requested = query
    ? readString(query, "date") ??
      readString(query, "dataMonth") ??
      readString(query, "period") ??
      readString(query, "asOf")
    : null;
  if (requested === "latest") return "latest";
  if (requested) return "explicit";
  if (query && readString(query, "history")) return "range";
  if (resolved.from && resolved.through && resolved.from !== resolved.through) return "range";
  if (readString(data, "snapshotId") || readString(data, "generatedAt")) return "snapshot";
  return resolved.granularity === "none" ? "none" : "snapshot";
}

function inferPage(data: UnknownRecord): ResultPageMeta {
  const pagination = isRecord(data.pagination) ? data.pagination : null;
  if (pagination) {
    const limit = typeof pagination.limit === "number" ? pagination.limit : null;
    const returned =
      typeof pagination.returnedRows === "number" ? pagination.returnedRows : null;
    const total = typeof pagination.totalRows === "number" ? pagination.totalRows : null;
    const nextOffset =
      typeof pagination.nextOffset === "number" ? pagination.nextOffset : null;
    return {
      mode: "offset",
      unit: "row",
      limit,
      returned,
      total,
      next: nextOffset === null ? null : { kind: "offset", offset: nextOffset },
    };
  }

  const coverage = isRecord(data.coverage) ? data.coverage : null;
  const nextCursor = coverage ? readString(coverage, "nextCursor") : null;
  if (coverage && Object.hasOwn(coverage, "nextCursor")) {
    return {
      mode: "cursor",
      unit: "month",
      limit: 12,
      returned: null,
      total: null,
      next: nextCursor ? { kind: "cursor", cursor: nextCursor } : null,
    };
  }

  return {
    mode: "none",
    unit: "none",
    limit: null,
    returned: null,
    total: null,
    next: null,
  };
}

function inferQuality(
  data: UnknownRecord,
  hints: ResultMetaHints,
): ResultMeta["quality"] {
  const coverage = isRecord(data.coverage) ? data.coverage : null;
  const hasContinuation = Boolean(coverage && readString(coverage, "nextCursor"));
  const coverageComplete =
    typeof data.coverageComplete === "boolean"
      ? data.coverageComplete
      : coverage && typeof coverage.coverageComplete === "boolean"
        ? coverage.coverageComplete
        : true;
  const source = hints.source ?? (!coverageComplete && !hasContinuation ? "partial" : "complete");

  const universe =
    hints.universe ??
    (data.universeCoverageVerified === true
      ? "verified"
      : data.classificationPolicy === "historical_code_rule"
        ? "unverified"
        : data.universeCoverageVerified === false
          ? "compatible"
          : "not_applicable");
  const selection =
    hints.selection ??
    (typeof data.selectionComplete === "boolean" ||
    (coverage && typeof coverage.selectionComplete === "boolean")
      ? (typeof data.selectionComplete === "boolean"
          ? data.selectionComplete
          : coverage?.selectionComplete)
        ? "complete"
        : "partial"
      : "not_applicable");
  const dataQualityComplete =
    typeof data.dataQualityComplete === "boolean"
      ? data.dataQualityComplete
      : coverage && typeof coverage.dataQualityComplete === "boolean"
        ? coverage.dataQualityComplete
        : undefined;
  const values =
    hints.values ??
    (typeof dataQualityComplete === "boolean"
      ? dataQualityComplete
        ? "complete"
        : "partial"
      : "unknown");

  const issues = [...(hints.issues ?? [])];
  const rawMissingCompanyCodes = Array.isArray(data.missingCompanyCodes)
    ? data.missingCompanyCodes
    : coverage && Array.isArray(coverage.missingCompanyCodes)
      ? coverage.missingCompanyCodes
      : [];
  const missingCompanyCodes = rawMissingCompanyCodes.filter(
    (value): value is string => typeof value === "string",
  );
  if (missingCompanyCodes.length > 0 && !issues.some((issue) => issue.code === "SELECTION_MISSING")) {
    issues.push({
      code: "SELECTION_MISSING",
      severity: "warning",
      scope: "selection",
      message: "部分 requested company codes 沒有符合資料。",
      refs: {
        companyCodes: missingCompanyCodes,
        fields: [],
        periods: [],
        sourceUrls: [],
      },
    });
  }

  return {
    status:
      source === "partial" ||
      universe === "compatible" ||
      universe === "unverified" ||
      selection === "partial" ||
      selection === "unknown" ||
      values === "partial" ||
      values === "unknown"
        ? "partial"
        : "complete",
    source,
    universe,
    selection,
    values,
    freshness: hints.freshness ?? "unknown",
    issues,
  };
}

function inferSourceCutoffs(
  data: UnknownRecord,
  fallback: ResultMeta["asOf"]["resolved"],
): ResultMeta["asOf"]["sourceCutoffs"] {
  const rawSources = Array.isArray(data.sources)
    ? data.sources
    : Array.isArray(data.benchmarkSources) ||
        Array.isArray(data.stockSources) ||
        Array.isArray(data.corporateActionSources)
      ? [
          ...(Array.isArray(data.benchmarkSources) ? data.benchmarkSources : []),
          ...(Array.isArray(data.stockSources) ? data.stockSources : []),
          ...(Array.isArray(data.corporateActionSources)
            ? data.corporateActionSources
            : []),
        ]
      : data.sourceUrl
        ? [data]
        : [];
  return rawSources.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const status = readString(raw, "status");
    if (status === "failed" || status === "unsupported") return [];
    const sourceUrl = readString(raw, "sourceUrl");
    if (!sourceUrl) return [];
    const retrievedAt =
      readString(raw, "retrievedAt") ?? readString(data, "retrievedAt");
    if (!retrievedAt) return [];
    const snapshotIdentity = readString(raw, "snapshotIdentity");
    const value =
      readString(raw, "dataDate") ??
      readString(raw, "dataMonth") ??
      readString(raw, "sourceSnapshotDate") ??
      readString(raw, "reportDate") ??
      readString(raw, "sourceReportDate") ??
      readString(raw, "asOf");
    const rangeFrom = readString(raw, "queryStart");
    const rangeThrough = readString(raw, "queryEnd");
    const declaredGranularity = readString(raw, "asOfGranularity");
    const granularity: ResultAsOfGranularity = declaredGranularity &&
      ["instant", "date", "month", "quarter", "mixed", "none"].includes(
        declaredGranularity,
      )
      ? (declaredGranularity as ResultAsOfGranularity)
      : value
      ? /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? "date"
        : /^\d{4}-\d{2}$/.test(value)
          ? "month"
          : "mixed"
      : fallback.granularity;
    return [
      {
        sourceUrl,
        resolved: snapshotIdentity === "unverified_empty"
          ? { granularity: "none" as const, from: null, through: null }
          : rangeFrom && rangeThrough
          ? {
              granularity: "date" as const,
              from: rangeFrom,
              through: rangeThrough,
            }
          : value
          ? { granularity, from: value, through: value }
          : { ...fallback },
        publishedAt:
          readString(raw, "sourceSnapshotDate") ??
          readString(raw, "sourceReportDate") ??
          readString(raw, "reportDate"),
        retrievedAt,
      },
    ];
  });
}

export function buildResultMeta(
  data: object,
  hints: ResultMetaHints = {},
  assembledAt = new Date().toISOString(),
): ResultMeta {
  const record = data as UnknownRecord;
  const resolved = hints.resolved ?? inferResolved(record);
  const sourceCutoffs = inferSourceCutoffs(record, resolved);
  const snapshotId =
    hints.snapshotId !== undefined
      ? hints.snapshotId
      : readString(record, "snapshotId") ??
        (sourceCutoffs.length > 0
          ? createHash("sha256")
              .update(JSON.stringify(sourceCutoffs))
              .digest("hex")
              .slice(0, 24)
          : null);
  return {
    contractVersion: RESULT_CONTRACT_VERSION,
    asOf: {
      selector: hints.selector ?? inferSelector(record, resolved),
      resolved,
      timezone: "Asia/Taipei",
      assembledAt,
      snapshotId,
      sourceCutoffs,
    },
    quality: inferQuality(record, hints),
    page: hints.page ?? inferPage(record),
  };
}

const ERROR_CATEGORY_BY_CODE: Record<
  MopsfinErrorCode,
  "input" | "lookup" | "no_data" | "coverage" | "upstream" | "pagination"
> = {
  INVALID_ARGUMENT: "input",
  NOT_FOUND: "lookup",
  NO_DATA: "no_data",
  INCOMPLETE_COVERAGE: "coverage",
  UPSTREAM_TIMEOUT: "upstream",
  UPSTREAM_RATE_LIMITED: "upstream",
  UPSTREAM_BAD_RESPONSE: "upstream",
};

function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeJson(item, depth + 1));
  if (!isRecord(value)) return String(value).slice(0, 2_000);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/stack|authorization|cookie|token|secret/i.test(key))
      .slice(0, 100)
      .map(([key, item]) => [key, sanitizeJson(item, depth + 1)]),
  );
}

export function structuredError(error: MopsfinError) {
  const reason = error.reason ?? null;
  const paginationReason = reason === "CURSOR_INVALID" || reason === "SNAPSHOT_CHANGED";
  const category = paginationReason ? "pagination" : error.category ?? ERROR_CATEGORY_BY_CODE[error.code];
  const retryable =
    error.retryable ??
    (error.code === "UPSTREAM_TIMEOUT" || error.code === "UPSTREAM_RATE_LIMITED");
  const action =
    error.action ??
    (paginationReason
      ? "restart_pagination"
      : retryable
        ? "retry"
        : category === "input"
          ? "fix_input"
          : category === "lookup" || category === "no_data"
            ? "change_query"
            : "none");
  return {
    ok: false as const,
    meta: {
      contractVersion: RESULT_CONTRACT_VERSION,
      asOf: null,
      quality: null,
      page: null,
    },
    error: {
      code: error.code,
      reason,
      category,
      message: error.message,
      retryable,
      retryAfterMs: error.retryAfterMs ?? null,
      action,
      details: sanitizeJson(error.details ?? {}),
    },
  };
}
