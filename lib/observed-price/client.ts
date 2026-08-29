import { authoritativeCompletedCloseClient } from "@/lib/completed-close/client";
import type {
  AuthoritativeCompletedCloseQuery,
  AuthoritativeCompletedCloseResult,
} from "@/lib/completed-close/types";
import { companyMasterClient } from "@/lib/company-master/client";
import type {
  CompanyMasterResult,
  MasterCompany,
} from "@/lib/company-master/types";
import {
  MopsfinError,
  type MopsfinErrorAction,
  type MopsfinErrorCategory,
} from "@/lib/mopsfin/errors";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

import type {
  ObservedPriceAnalysisContext,
  ObservedPriceAnalysisResult,
  ObservedPriceCompanyMasterSource,
  ObservedPriceOfficialCloseSource,
  ObservedPriceQuery,
} from "./types";

export interface ObservedPriceCompanyMasterLike {
  listCompanies(
    query: {
      market: "all" | "listed" | "otc";
      includeFinancial: boolean;
      includeKy: boolean;
    },
    force?: boolean,
  ): Promise<CompanyMasterResult>;
}

export interface ObservedPriceCompletedCloseLike {
  getLatestCompletedClose(
    query: AuthoritativeCompletedCloseQuery,
  ): Promise<AuthoritativeCompletedCloseResult>;
}

interface ParsedObservedAt {
  timestampMs: number;
  taipeiDate: string;
}

type OffsetIsoParseResult =
  | ({ ok: true } & ParsedObservedAt)
  | {
      ok: false;
      error: "format" | "calendar" | "offset" | "unknown_offset" | "year";
    };

const OFFSET_ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const OBSERVED_YEAR_SUPPORTED_FROM = 1900;
export const CONSERVATIVE_REGULAR_SESSION_COMPLETION_TAIPEI = "13:33:00";

function conservativeSessionCompletionMs(dataDate: string): number {
  return Date.parse(
    `${dataDate}T${CONSERVATIVE_REGULAR_SESSION_COMPLETION_TAIPEI}+08:00`,
  );
}

function fail(
  code: ConstructorParameters<typeof MopsfinError>[0],
  message: string,
  options: {
    reason: string;
    category: MopsfinErrorCategory;
    retryable?: boolean;
    action?: MopsfinErrorAction;
    details?: Record<string, unknown>;
  },
): never {
  throw new MopsfinError(code, message, {
    reason: options.reason,
    category: options.category,
    retryable: options.retryable ?? false,
    action: options.action ?? "none",
    details: options.details,
  });
}

function taipeiDate(timestampMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestampMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3])
  );
}

function tryParseOffsetIsoDateTime(raw: string): OffsetIsoParseResult {
  const match = OFFSET_ISO_DATE_TIME.exec(raw);
  if (!match) return { ok: false, error: "format" };

  const year = Number(match[1]);
  if (year < OBSERVED_YEAR_SUPPORTED_FROM) {
    return { ok: false, error: "year" };
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const localCalendar = new Date(
    `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`,
  );
  if (
    !Number.isFinite(localCalendar.getTime()) ||
    localCalendar.getUTCFullYear() !== year ||
    localCalendar.getUTCMonth() + 1 !== month ||
    localCalendar.getUTCDate() !== day
  ) {
    return { ok: false, error: "calendar" };
  }

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetMinutePart = Number(match[11]);
    if (
      offsetHours > 14 ||
      offsetMinutePart > 59 ||
      (offsetHours === 14 && offsetMinutePart !== 0)
    ) {
      return { ok: false, error: "offset" };
    }
    if (match[9] === "-" && offsetHours === 0 && offsetMinutePart === 0) {
      return { ok: false, error: "unknown_offset" };
    }
    offsetMinutes =
      (match[9] === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutePart);
  }
  const timestampMs =
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) -
    offsetMinutes * 60_000;
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, error: "calendar" };
  }
  return { ok: true, timestampMs, taipeiDate: taipeiDate(timestampMs) };
}

function parseObservedAt(raw: string): ParsedObservedAt {
  const parsed = tryParseOffsetIsoDateTime(raw);
  if (parsed.ok) return parsed;
  if (parsed.error === "offset") {
    fail("INVALID_ARGUMENT", "observed_at 的 UTC offset 無效。", {
      reason: "OBSERVED_AT_INVALID_OFFSET",
      category: "input",
      action: "fix_input",
      details: { observedAt: raw },
    });
  }
  if (parsed.error === "unknown_offset") {
    fail(
      "INVALID_ARGUMENT",
      "observed_at 不接受 RFC 3339 的 -00:00 unknown-local-offset 標記；請提供 Z 或已知 UTC offset。",
      {
        reason: "OBSERVED_AT_UNKNOWN_OFFSET",
        category: "input",
        action: "fix_input",
        details: { observedAt: raw },
      },
    );
  }
  if (parsed.error === "year") {
    fail(
      "INVALID_ARGUMENT",
      `observed_at 年份不得早於 ${OBSERVED_YEAR_SUPPORTED_FROM}。`,
      {
        reason: "OBSERVED_AT_YEAR_UNSUPPORTED",
        category: "input",
        action: "fix_input",
        details: {
          observedAt: raw,
          supportedFromYear: OBSERVED_YEAR_SUPPORTED_FROM,
        },
      },
    );
  }
  fail(
    "INVALID_ARGUMENT",
    "observed_at 必須是有效且含明確 Z 或 UTC offset 的 ISO 8601 日期時間。",
    {
      reason: "OBSERVED_AT_INVALID",
      category: "input",
      action: "fix_input",
      details: { observedAt: raw },
    },
  );
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim();
}

function round(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function assertSourceTimeAndCache(
  source: {
    sourceName: string;
    sourceUrl: string;
    retrievedAt: string;
    cache?: CacheProvenance;
  },
  generatedAtMs: number,
  context: {
    reasonPrefix: "CURRENT_MASTER" | "OFFICIAL_PRICE";
  },
): { retrieved: ParsedObservedAt; cache: CacheProvenance } {
  const retrieved = tryParseOffsetIsoDateTime(source.retrievedAt);
  if (!retrieved.ok) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 retrievedAt 不是有效的 offset ISO 8601 時間。", {
      reason: `${context.reasonPrefix}_SOURCE_RETRIEVED_AT_INVALID`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        retrievedAt: source.retrievedAt,
      },
    });
  }
  if (retrieved.timestampMs > generatedAtMs) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 retrievedAt 晚於本次結果 generatedAt。", {
      reason: `${context.reasonPrefix}_SOURCE_RETRIEVED_AT_IN_FUTURE`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        retrievedAt: source.retrievedAt,
        generatedAt: new Date(generatedAtMs).toISOString(),
      },
    });
  }

  const cache = source.cache;
  if (!cache) {
    fail("UPSTREAM_BAD_RESPONSE", "來源缺少 caller-specific cache provenance。", {
      reason: `${context.reasonPrefix}_SOURCE_CACHE_MISSING`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
      },
    });
  }
  const observed = tryParseOffsetIsoDateTime(cache.observedAt);
  if (!observed.ok) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 cache.observedAt 不是有效的 offset ISO 8601 時間。", {
      reason: `${context.reasonPrefix}_SOURCE_CACHE_TIME_INVALID`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        observedAt: cache.observedAt,
      },
    });
  }
  if (observed.timestampMs > generatedAtMs) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 cache.observedAt 晚於本次結果 generatedAt。", {
      reason: `${context.reasonPrefix}_SOURCE_CACHE_TIME_IN_FUTURE`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        observedAt: cache.observedAt,
        generatedAt: new Date(generatedAtMs).toISOString(),
      },
    });
  }

  const stored =
    cache.storedAt === null
      ? null
      : tryParseOffsetIsoDateTime(cache.storedAt);
  if (stored !== null && !stored.ok) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 cache.storedAt 不是有效的 offset ISO 8601 時間。", {
      reason: `${context.reasonPrefix}_SOURCE_CACHE_TIME_INVALID`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        storedAt: cache.storedAt,
      },
    });
  }
  const storedParsed = stored?.ok ? stored : null;
  const storedStatuses = new Set<CacheProvenance["status"]>([
    "hit",
    "miss",
    "shared",
  ]);
  const unstoredStatuses = new Set<CacheProvenance["status"]>([
    "bypass",
    "not_applicable",
    "unknown",
  ]);
  const storedCoherent =
    storedStatuses.has(cache.status) &&
    storedParsed !== null &&
    Number.isSafeInteger(cache.ageMs) &&
    cache.ageMs !== null &&
    cache.ageMs >= 0 &&
    Number.isSafeInteger(cache.ttlMs) &&
    cache.ttlMs !== null &&
    cache.ttlMs > 0;
  const unstoredCoherent =
    unstoredStatuses.has(cache.status) &&
    storedParsed === null &&
    cache.ageMs === null &&
    ((cache.status === "bypass" && cache.ttlMs === 0) ||
      ((cache.status === "not_applicable" || cache.status === "unknown") &&
        cache.ttlMs === null));
  if (!storedCoherent && !unstoredCoherent) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 cache status 與 storedAt／ageMs／ttlMs 不一致。", {
      reason: `${context.reasonPrefix}_SOURCE_CACHE_CONTRACT_MISMATCH`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        cache,
      },
    });
  }

  if (retrieved.timestampMs > observed.timestampMs) {
    fail("UPSTREAM_BAD_RESPONSE", "來源 retrievedAt 晚於 cache.observedAt。", {
      reason: `${context.reasonPrefix}_SOURCE_CACHE_TIME_INCONSISTENT`,
      category: "upstream",
      details: {
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        retrievedAt: source.retrievedAt,
        observedAt: cache.observedAt,
      },
    });
  }
  if (storedParsed) {
    const expectedAgeMs = observed.timestampMs - storedParsed.timestampMs;
    if (
      retrieved.timestampMs > storedParsed.timestampMs ||
      storedParsed.timestampMs > observed.timestampMs ||
      cache.ageMs !== expectedAgeMs
    ) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "來源時間必須符合 retrievedAt <= cache.storedAt <= cache.observedAt，且 ageMs 必須可精確重算。",
        {
          reason: `${context.reasonPrefix}_SOURCE_CACHE_TIME_INCONSISTENT`,
          category: "upstream",
          details: {
            sourceName: source.sourceName,
            sourceUrl: source.sourceUrl,
            retrievedAt: source.retrievedAt,
            cache,
            expectedAgeMs,
          },
        },
      );
    }
  }
  return { retrieved, cache };
}

function expectedMissingFields(
  bar: AuthoritativeCompletedCloseResult["bar"],
): Array<(typeof bar.missingFields)[number]> {
  return (
    [
      ["open", bar.open],
      ["high", bar.high],
      ["low", bar.low],
      ["close", bar.close],
      ["volumeShares", bar.volumeShares],
      ["turnoverTwd", bar.turnoverTwd],
      ["tradeCount", bar.tradeCount],
      ["change", bar.change],
    ] as const
  )
    .filter(([, value]) => value === null)
    .map(([field]) => field);
}

function assertMasterResult(
  master: CompanyMasterResult,
  companyCode: string,
): {
  company: MasterCompany;
  sources: [
    ObservedPriceCompanyMasterSource,
    ObservedPriceCompanyMasterSource,
  ];
  generatedAtMs: number;
} {
  if (
    master.query.market !== "all" ||
    master.query.includeFinancial !== true ||
    master.query.includeKy !== true
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體 dependency 回傳的 query identity 不符。", {
      reason: "CURRENT_MASTER_QUERY_IDENTITY_MISMATCH",
      category: "upstream",
      details: { companyCode, actualQuery: master.query },
    });
  }
  if (master.coverageComplete !== true) {
    fail("INCOMPLETE_COVERAGE", "目前公司母體覆蓋不完整。", {
      reason: "CURRENT_MASTER_INCOMPLETE",
      category: "coverage",
      retryable: true,
      action: "retry",
      details: { companyCode, snapshotId: master.snapshotId },
    });
  }
  if (
    master.coverageVerification.status !== "heuristic" ||
    master.coverageVerification.method !==
      "required_sources_schema_single_report_date_minimum_count" ||
    master.coverageVerification.officialDeclaredRowCountAvailable !== false
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體的 coverage verification contract 不符。", {
      reason: "CURRENT_MASTER_COVERAGE_CONTRACT_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        coverageVerification: master.coverageVerification,
      },
    });
  }
  const masterGenerated = tryParseOffsetIsoDateTime(master.generatedAt);
  if (!masterGenerated.ok) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體 generatedAt 不是有效的 offset ISO 8601 時間。", {
      reason: "CURRENT_MASTER_GENERATED_AT_INVALID",
      category: "upstream",
      details: { generatedAt: master.generatedAt },
    });
  }
  if (master.sources.length !== 2) {
    fail("UPSTREAM_BAD_RESPONSE", "market=all 公司母體必須精確保留 listed 與 otc 兩份來源。", {
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        sourceCount: master.sources.length,
        markets: master.sources.map((source) => source.market),
      },
    });
  }
  const listedSources = master.sources.filter(
    (source) => source.market === "listed" && source.exchange === "TWSE",
  );
  const otcSources = master.sources.filter(
    (source) => source.market === "otc" && source.exchange === "TPEx",
  );
  if (listedSources.length !== 1 || otcSources.length !== 1) {
    fail("UPSTREAM_BAD_RESPONSE", "market=all 公司母體來源必須唯一涵蓋 listed/TWSE 與 otc/TPEx。", {
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        sources: master.sources.map((source) => ({
          market: source.market,
          exchange: source.exchange,
          sourceUrl: source.sourceUrl,
        })),
      },
    });
  }
  const orderedRawSources = [
    listedSources[0],
    otcSources[0],
  ] as const;
  const invalidReportDateSource = orderedRawSources.find(
    (source) => !isValidIsoCalendarDate(source.reportDate),
  );
  if (invalidReportDateSource) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體的 reportDate 格式無效。", {
      reason: "CURRENT_MASTER_REPORT_DATE_INVALID",
      category: "upstream",
      details: {
        companyCode,
        market: invalidReportDateSource.market,
        reportDate: invalidReportDateSource.reportDate,
        sourceUrl: invalidReportDateSource.sourceUrl,
      },
    });
  }
  if (new Set(orderedRawSources.map((source) => source.sourceUrl)).size !== 2) {
    fail("UPSTREAM_BAD_RESPONSE", "market=all 公司母體來源 URL 必須唯一。", {
      reason: "CURRENT_MASTER_SOURCE_SET_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        sources: orderedRawSources.map((source) => ({
          market: source.market,
          sourceUrl: source.sourceUrl,
          reportDate: source.reportDate,
        })),
      },
    });
  }
  const validatedSources = orderedRawSources.map((source) => {
    if (
      !source.sourceName.trim() ||
      !source.sourceUrl.trim() ||
      !isValidIsoCalendarDate(source.reportDate) ||
      !Number.isSafeInteger(source.rawCount) ||
      source.rawCount < 0 ||
      !Number.isSafeInteger(source.excludedTdrCount) ||
      source.excludedTdrCount < 0 ||
      !Number.isSafeInteger(source.companyCount) ||
      source.companyCount < 0 ||
      !Number.isSafeInteger(source.minimumExpectedCount) ||
      source.minimumExpectedCount <= 0 ||
      source.rawCount !== source.companyCount + source.excludedTdrCount ||
      source.companyCount < source.minimumExpectedCount
    ) {
      fail("UPSTREAM_BAD_RESPONSE", "目前公司母體來源的 schema、日期或 coverage counts 不一致。", {
        reason: "CURRENT_MASTER_SOURCE_CONTRACT_MISMATCH",
        category: "upstream",
        details: { companyCode, source },
      });
    }
    const provenance = assertSourceTimeAndCache(
      source,
      masterGenerated.timestampMs,
      { reasonPrefix: "CURRENT_MASTER" },
    );
    if (source.reportDate > provenance.retrieved.taipeiDate) {
      fail("UPSTREAM_BAD_RESPONSE", "目前公司母體 reportDate 晚於來源 retrievedAt 的台北日期。", {
        reason: "CURRENT_MASTER_SOURCE_TIME_INCONSISTENT",
        category: "upstream",
        details: {
          companyCode,
          reportDate: source.reportDate,
          retrievedAt: source.retrievedAt,
        },
      });
    }
    return {
      ...source,
      cache: provenance.cache,
      sourceId: `company_master:${source.market}:${source.reportDate}`,
      stage: "company_master" as const,
    };
  }) as [
    ObservedPriceCompanyMasterSource,
    ObservedPriceCompanyMasterSource,
  ];

  const uniqueCodes = new Set<string>();
  for (const company of master.companies) {
    const expectedExchange = company.market === "listed" ? "TWSE" : "TPEx";
    if (
      !/^\d{4}$/.test(company.code) ||
      uniqueCodes.has(company.code) ||
      company.exchange !== expectedExchange
    ) {
      fail("UPSTREAM_BAD_RESPONSE", "目前公司母體含重複或市場不一致的 company identity。", {
        reason: "CURRENT_MASTER_IDENTITY_CONTRACT_MISMATCH",
        category: "upstream",
        details: {
          companyCode: company.code,
          market: company.market,
          exchange: company.exchange,
        },
      });
    }
    uniqueCodes.add(company.code);
  }
  const expectedCounts = {
    raw: orderedRawSources.reduce((sum, source) => sum + source.rawCount, 0),
    excludedTdr: orderedRawSources.reduce(
      (sum, source) => sum + source.excludedTdrCount,
      0,
    ),
    eligible: orderedRawSources.reduce(
      (sum, source) => sum + source.companyCount,
      0,
    ),
    listed: master.companies.filter((company) => company.market === "listed")
      .length,
    otc: master.companies.filter((company) => company.market === "otc").length,
    returned: master.companies.length,
  };
  if (
    master.counts.raw !== expectedCounts.raw ||
    master.counts.excludedTdr !== expectedCounts.excludedTdr ||
    master.counts.eligible !== expectedCounts.eligible ||
    master.counts.listed !== expectedCounts.listed ||
    master.counts.otc !== expectedCounts.otc ||
    master.counts.returned !== expectedCounts.returned ||
    master.counts.returned !== master.counts.eligible ||
    orderedRawSources[0].companyCount !== expectedCounts.listed ||
    orderedRawSources[1].companyCount !== expectedCounts.otc ||
    master.counts.excludedFinancial !== 0 ||
    master.counts.excludedKy !== 0
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體 sources、companies 與 counts 無法互相核對。", {
      reason: "CURRENT_MASTER_COUNTS_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        expectedCounts,
        actualCounts: master.counts,
      },
    });
  }
  for (const [field, coverage] of Object.entries(master.profileCoverage)) {
    if (
      coverage.reported + coverage.missing + coverage.invalid !==
      master.companies.length
    ) {
      fail("UPSTREAM_BAD_RESPONSE", "目前公司母體 profileCoverage 與 companies 數量不一致。", {
        reason: "CURRENT_MASTER_COUNTS_MISMATCH",
        category: "upstream",
        details: { companyCode, field, coverage },
      });
    }
  }
  const matches = master.companies.filter(
    (company) => company.code === companyCode,
  );
  if (matches.length === 0) {
    fail("NOT_FOUND", "目前公司母體找不到指定公司股票代號。", {
      reason: "COMPANY_NOT_IN_CURRENT_MASTER",
      category: "lookup",
      action: "change_query",
      details: { companyCode, snapshotId: master.snapshotId },
    });
  }
  if (matches.length !== 1) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體的公司 identity 不唯一。", {
      reason: "CURRENT_MASTER_IDENTITY_AMBIGUOUS",
      category: "upstream",
      details: {
        companyCode,
        matchCount: matches.length,
        snapshotId: master.snapshotId,
      },
    });
  }
  const company = matches[0];
  if (!company.name.trim() || !company.shortName.trim()) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體的公司名稱 identity 為空。", {
      reason: "CURRENT_MASTER_IDENTITY_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        name: company.name,
        shortName: company.shortName,
      },
    });
  }
  const expectedExchange = company.market === "listed" ? "TWSE" : "TPEx";
  if (company.exchange !== expectedExchange) {
    fail("UPSTREAM_BAD_RESPONSE", "目前公司母體的市場與交易所 identity 不一致。", {
      reason: "CURRENT_MASTER_IDENTITY_MISMATCH",
      category: "upstream",
      details: {
        companyCode,
        market: company.market,
        exchange: company.exchange,
        expectedExchange,
      },
    });
  }
  return {
    company,
    sources: validatedSources,
    generatedAtMs: masterGenerated.timestampMs,
  };
}

function assertCompletedCloseResult(
  result: AuthoritativeCompletedCloseResult,
  company: MasterCompany,
  evaluatedAt: string,
  generatedAtMs: number,
): {
  close: number;
  dataDate: string;
  source: ObservedPriceOfficialCloseSource;
  dataQualityComplete: boolean;
} {
  const expectedCompany = {
    code: company.code,
    shortName: company.shortName,
    market: company.market,
    exchange: company.exchange,
  };
  const evidence = result.resolverEvidence;
  const marketResolution = evidence.marketResolutions[0];
  const dataDate = result.expectedAsOf;
  if (
    result.query.companyCode !== company.code ||
    result.query.market !== company.market ||
    result.query.evaluatedAt !== evaluatedAt ||
    result.company.code !== expectedCompany.code ||
    result.company.market !== expectedCompany.market ||
    result.company.exchange !== expectedCompany.exchange ||
    normalizeName(result.company.shortName) !==
      normalizeName(expectedCompany.shortName)
  ) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative completed-close dependency 回傳的 query/company identity 不符。",
      {
        reason: "OFFICIAL_PRICE_QUERY_IDENTITY_MISMATCH",
        category: "upstream",
        details: {
          expectedCompany,
          evaluatedAt,
          actualQuery: result.query,
          actualCompany: result.company,
        },
      },
    );
  }
  if (
    evidence.status !== "resolved" ||
    evidence.evaluatedAt !== evaluatedAt ||
    evidence.markets.length !== 1 ||
    evidence.markets[0] !== company.market ||
    evidence.expectedAsOf !== dataDate ||
    evidence.marketResolutions.length !== 1 ||
    marketResolution?.market !== company.market ||
    marketResolution.status !== "resolved" ||
    marketResolution.expectedAsOf !== dataDate
  ) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative completed-session evidence 與 selected close 不一致。",
      {
        reason: "COMPLETED_SESSION_EVIDENCE_MISMATCH",
        category: "upstream",
        details: {
          companyCode: company.code,
          market: company.market,
          evaluatedAt,
          expectedAsOf: dataDate,
          resolverEvidence: evidence,
        },
      },
    );
  }
  if (
    !isValidIsoCalendarDate(dataDate) ||
    result.selectedBarDate !== dataDate ||
    result.bar.date !== dataDate ||
    result.source.selectedBarDate !== dataDate ||
    result.source.dataMonth !== dataDate.slice(0, 7)
  ) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative completed close 未精確綁定 resolver expectedAsOf。",
      {
        reason: "OFFICIAL_PRICE_DATE_MISMATCH",
        category: "upstream",
        details: {
          expectedAsOf: dataDate,
          selectedBarDate: result.selectedBarDate,
          barDate: result.bar.date,
          sourceSelectedBarDate: result.source.selectedBarDate,
          sourceDataMonth: result.source.dataMonth,
        },
      },
    );
  }
  if (
    result.currency !== "TWD" ||
    result.timezone !== "Asia/Taipei" ||
    result.interval !== "1d" ||
    result.priceBasis !== "raw_unadjusted" ||
    result.bar.market !== company.market ||
    result.source.companyCode !== company.code ||
    result.source.market !== company.market ||
    result.source.exchange !== company.exchange ||
    result.source.snapshotIdentity !== "verified" ||
    normalizeName(result.source.observedName) !== normalizeName(company.shortName)
  ) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative exact single-stock OHLC contract 或 identity 不符。",
      {
        reason: "OFFICIAL_PRICE_CONTRACT_MISMATCH",
        category: "upstream",
        details: {
          companyCode: company.code,
          market: company.market,
          currency: result.currency,
          timezone: result.timezone,
          interval: result.interval,
          priceBasis: result.priceBasis,
          barMarket: result.bar.market,
          sourceCompanyCode: result.source.companyCode,
          sourceMarket: result.source.market,
          sourceExchange: result.source.exchange,
          observedName: result.source.observedName,
          snapshotIdentity: result.source.snapshotIdentity,
        },
      },
    );
  }
  if (
    result.bar.status !== "traded" ||
    typeof result.bar.close !== "number" ||
    !Number.isFinite(result.bar.close) ||
    result.bar.close <= 0 ||
    result.close !== result.bar.close
  ) {
    fail("NO_DATA", "官方 authoritative completed session 沒有有效正數收盤價。", {
      reason: "OFFICIAL_COMPLETED_CLOSE_UNAVAILABLE",
      category: "no_data",
      details: {
        companyCode: company.code,
        date: dataDate,
        status: result.bar.status,
        close: result.bar.close,
        resultClose: result.close,
      },
    });
  }

  const expectedMissing = expectedMissingFields(result.bar);
  const priceValuesValid = [
    result.bar.open,
    result.bar.high,
    result.bar.low,
    result.bar.close,
  ].every((value) => value === null || (Number.isFinite(value) && value > 0));
  const countValuesValid = [
    result.bar.volumeShares,
    result.bar.turnoverTwd,
    result.bar.tradeCount,
  ].every(
    (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
  );
  const changeValueValid =
    result.bar.change === null || Number.isFinite(result.bar.change);
  const dataQualityComplete = result.bar.qualityStatus === "complete";
  const qualityIsConsistent =
    priceValuesValid &&
    countValuesValid &&
    changeValueValid &&
    new Set(result.bar.missingFields).size === result.bar.missingFields.length &&
    JSON.stringify(result.bar.missingFields) === JSON.stringify(expectedMissing) &&
    ((result.bar.qualityStatus === "complete" && expectedMissing.length === 0) ||
      (result.bar.qualityStatus === "partial" && expectedMissing.length > 0));
  if (!qualityIsConsistent) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative close bar 的 qualityStatus 與 missingFields 不一致。",
      {
        reason: "OFFICIAL_PRICE_QUALITY_MISMATCH",
        category: "upstream",
        details: {
          companyCode: company.code,
          qualityStatus: result.bar.qualityStatus,
          missingFields: result.bar.missingFields,
          expectedMissingFields: expectedMissing,
          priceValuesValid,
          countValuesValid,
          changeValueValid,
        },
      },
    );
  }

  const provenance = assertSourceTimeAndCache(
    result.source,
    generatedAtMs,
    { reasonPrefix: "OFFICIAL_PRICE" },
  );
  if (dataDate > provenance.retrieved.taipeiDate) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "官方單股 OHLC selected bar date 晚於來源 retrievedAt 的台北日期。",
      {
        reason: "OFFICIAL_PRICE_SOURCE_TIME_INCONSISTENT",
        category: "upstream",
        details: {
          companyCode: company.code,
          dataDate,
          retrievedAt: result.source.retrievedAt,
        },
      },
    );
  }
  if (
    dataDate === provenance.retrieved.taipeiDate &&
    provenance.retrieved.timestampMs < conservativeSessionCompletionMs(dataDate)
  ) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "同日 authoritative close source 在保守 session completion 時間之前取得。",
      {
        reason: "OFFICIAL_PRICE_SOURCE_PRECEDES_SESSION_COMPLETION",
        category: "upstream",
        details: {
          companyCode: company.code,
          dataDate,
          retrievedAt: result.source.retrievedAt,
          conservativeSessionCompletionTaipei:
            `${dataDate}T${CONSERVATIVE_REGULAR_SESSION_COMPLETION_TAIPEI}+08:00`,
        },
      },
    );
  }

  const exactBudget = result.workBudget.exactStockOhlcAttempts;
  const expectedExactAttempts = result.cacheRefresh.attempted ? 2 : 1;
  if (
    result.workBudget.scope !== "authoritative_completed_close_routing" ||
    evidence.workBudget.marketCount !== 1 ||
    evidence.workBudget.calendarLogicalLoads !== 1 ||
    evidence.workBudget.sessionMarkerLogicalLoads !== 1 ||
    evidence.workBudget.actualTotal !== 2 ||
    evidence.workBudget.maximumTotal !== 2 ||
    JSON.stringify(result.workBudget.completedSessionResolver) !==
      JSON.stringify(evidence.workBudget) ||
    exactBudget.actual !== expectedExactAttempts ||
    exactBudget.maximum !== 2 ||
    exactBudget.cacheRefreshPerformed !== result.cacheRefresh.attempted ||
    (result.cacheRefresh.attempted &&
      result.cacheRefresh.initialCacheStatus !== "hit")
  ) {
    fail(
      "UPSTREAM_BAD_RESPONSE",
      "authoritative completed-close work budget 與 cache refresh evidence 不一致。",
      {
        reason: "OFFICIAL_PRICE_WORK_BUDGET_MISMATCH",
        category: "upstream",
        details: {
          workBudget: result.workBudget,
          cacheRefresh: result.cacheRefresh,
        },
      },
    );
  }

  return {
    close: result.close,
    dataDate,
    source: {
      ...result.source,
      cache: provenance.cache,
      sourceId: `official_close:${company.market}:${dataDate}`,
      stage: "latest_official_completed_close",
    },
    dataQualityComplete,
  };
}
function normalizeQuery(
  query: ObservedPriceQuery,
  nowMs: number,
): { query: ObservedPriceQuery; observed: ParsedObservedAt } {
  if (typeof query.companyCode !== "string") {
    fail("INVALID_ARGUMENT", "company_code 必須是四碼公司股票代號。", {
      reason: "INVALID_COMPANY_CODE",
      category: "input",
      action: "fix_input",
      details: { companyCode: query.companyCode },
    });
  }
  const companyCode = query.companyCode.trim();
  if (!/^\d{4}$/.test(companyCode)) {
    fail("INVALID_ARGUMENT", "company_code 必須是四碼公司股票代號。", {
      reason: "INVALID_COMPANY_CODE",
      category: "input",
      action: "fix_input",
      details: { companyCode: query.companyCode },
    });
  }
  if (
    typeof query.observedPriceTwd !== "number" ||
    !Number.isFinite(query.observedPriceTwd) ||
    query.observedPriceTwd <= 0
  ) {
    fail("INVALID_ARGUMENT", "observed_price_twd 必須是大於 0 的有限數值。", {
      reason: "INVALID_OBSERVED_PRICE",
      category: "input",
      action: "fix_input",
      details: { observedPriceTwd: query.observedPriceTwd },
    });
  }
  if (typeof query.sourceLabel !== "string") {
    fail("INVALID_ARGUMENT", "source_label 不得為空。", {
      reason: "INVALID_SOURCE_LABEL",
      category: "input",
      action: "fix_input",
    });
  }
  const sourceLabel = query.sourceLabel.trim();
  if (!sourceLabel) {
    fail("INVALID_ARGUMENT", "source_label 不得為空。", {
      reason: "INVALID_SOURCE_LABEL",
      category: "input",
      action: "fix_input",
    });
  }
  if (sourceLabel.length > 200) {
    fail("INVALID_ARGUMENT", "source_label 最長 200 個字元。", {
      reason: "INVALID_SOURCE_LABEL",
      category: "input",
      action: "fix_input",
      details: { maximumLength: 200 },
    });
  }
  if (typeof query.observedAt !== "string") {
    fail("INVALID_ARGUMENT", "observed_at 必須是字串。", {
      reason: "OBSERVED_AT_INVALID",
      category: "input",
      action: "fix_input",
    });
  }
  const observed = parseObservedAt(query.observedAt);
  if (observed.timestampMs > nowMs) {
    fail("INVALID_ARGUMENT", "observed_at 不得晚於目前時間。", {
      reason: "OBSERVED_AT_IN_FUTURE",
      category: "input",
      action: "fix_input",
      details: {
        observedAt: query.observedAt,
        currentTime: new Date(nowMs).toISOString(),
      },
    });
  }
  return {
    query: {
      companyCode,
      observedPriceTwd: query.observedPriceTwd,
      observedAt: query.observedAt,
      sourceLabel,
    },
    observed,
  };
}

export class ObservedPriceClient {
  constructor(
    private readonly companyMaster: ObservedPriceCompanyMasterLike =
      companyMasterClient,
    private readonly completedClose: ObservedPriceCompletedCloseLike =
      authoritativeCompletedCloseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async analyzeObservedPrice(
    input: ObservedPriceQuery,
  ): Promise<ObservedPriceAnalysisResult> {
    return (await this.analyzeObservedPriceWithContext(input)).data;
  }

  async analyzeObservedPriceWithContext(
    input: ObservedPriceQuery,
  ): Promise<ObservedPriceAnalysisContext> {
    const requestNow = this.now();
    const requestNowMs = requestNow.getTime();
    if (!Number.isFinite(requestNowMs)) {
      fail("UPSTREAM_BAD_RESPONSE", "系統 request clock 無效。", {
        reason: "SYSTEM_CLOCK_INVALID",
        category: "upstream",
      });
    }
    const normalized = normalizeQuery(input, requestNowMs);
    const master = await this.companyMaster.listCompanies({
      market: "all",
      includeFinancial: true,
      includeKy: true,
    });
    const validatedMaster = assertMasterResult(
      master,
      normalized.query.companyCode,
    );
    const company = validatedMaster.company;
    const evaluatedAt = requestNow.toISOString();
    const completedClose = await this.completedClose.getLatestCompletedClose({
      company: {
        code: company.code,
        shortName: company.shortName,
        market: company.market,
        exchange: company.exchange,
      },
      evaluatedAt,
    });
    const generatedAt = this.now();
    const generatedAtMs = generatedAt.getTime();
    if (!Number.isFinite(generatedAtMs) || generatedAtMs < requestNowMs) {
      fail("UPSTREAM_BAD_RESPONSE", "系統 generatedAt clock 無效或發生倒退。", {
        reason: "SYSTEM_CLOCK_INVALID",
        category: "upstream",
        details: {
          requestNow: requestNow.toISOString(),
          generatedAt: Number.isFinite(generatedAtMs)
            ? generatedAt.toISOString()
            : null,
        },
      });
    }
    if (validatedMaster.generatedAtMs > generatedAtMs) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        "目前公司母體 generatedAt 晚於 observed-price orchestration generatedAt。",
        {
          reason: "CURRENT_MASTER_GENERATED_AT_IN_FUTURE",
          category: "upstream",
          details: {
            companyCode: company.code,
            masterGeneratedAt: master.generatedAt,
            generatedAt: generatedAt.toISOString(),
          },
        },
      );
    }
    const official = assertCompletedCloseResult(
      completedClose,
      company,
      evaluatedAt,
      generatedAtMs,
    );
    if (normalized.observed.taipeiDate < official.dataDate) {
      fail(
        "INVALID_ARGUMENT",
        "observed_at 的台北日期早於官方最近完成交易日，不能用較舊觀察值比較較新基準。",
        {
          reason: "OBSERVATION_PREDATES_OFFICIAL_CLOSE",
          category: "input",
          action: "fix_input",
          details: {
            observedAt: normalized.query.observedAt,
            observedTaipeiDate: normalized.observed.taipeiDate,
            latestOfficialCloseDate: official.dataDate,
          },
        },
      );
    }
    if (normalized.observed.taipeiDate === official.dataDate) {
      const conservativeCompletionMs = conservativeSessionCompletionMs(
        official.dataDate,
      );
      if (normalized.observed.timestampMs < conservativeCompletionMs) {
        fail(
          "INVALID_ARGUMENT",
          "同交易日 observed_at 必須在台北時間 13:33 之後，才可與該日官方 completed close 比較。",
          {
            reason: "OBSERVATION_PRECEDES_OFFICIAL_SESSION_COMPLETION",
            category: "input",
            action: "fix_input",
            details: {
              observedAt: normalized.query.observedAt,
              observedTaipeiDate: normalized.observed.taipeiDate,
              latestOfficialCloseDate: official.dataDate,
              conservativeSessionCompletionTaipei:
                `${official.dataDate}T${CONSERVATIVE_REGULAR_SESSION_COMPLETION_TAIPEI}+08:00`,
            },
          },
        );
      }
    }

    const rawAbsoluteDifference =
      normalized.query.observedPriceTwd - official.close;
    const rawPercentDifference =
      (normalized.query.observedPriceTwd / official.close - 1) * 100;
    if (
      !Number.isFinite(rawAbsoluteDifference) ||
      !Number.isFinite(rawPercentDifference)
    ) {
      fail("INVALID_ARGUMENT", "observed_price_twd 使價差計算超出有限數值範圍。", {
        reason: "OBSERVED_PRICE_COMPARISON_OVERFLOW",
        category: "input",
        action: "fix_input",
        details: {
          observedPriceTwd: normalized.query.observedPriceTwd,
          latestOfficialCompletedClose: official.close,
        },
      });
    }
    const absoluteDifference = round(rawAbsoluteDifference, 6);
    const percentDifference = round(rawPercentDifference, 6);
    if (
      !Number.isFinite(absoluteDifference) ||
      !Number.isFinite(percentDifference)
    ) {
      fail("INVALID_ARGUMENT", "observed_price_twd 的價差輸出無法表示為有限數值。", {
        reason: "OBSERVED_PRICE_COMPARISON_OVERFLOW",
        category: "input",
        action: "fix_input",
      });
    }
    const sources: ObservedPriceAnalysisResult["sources"] = [
      validatedMaster.sources[0],
      validatedMaster.sources[1],
      official.source,
    ];
    const masterSourceIds: [string, string] = [
      validatedMaster.sources[0].sourceId,
      validatedMaster.sources[1].sourceId,
    ];
    const resolverLoads =
      completedClose.workBudget.completedSessionResolver.actualTotal;
    const exactLoads = completedClose.workBudget.exactStockOhlcAttempts.actual;
    const data: ObservedPriceAnalysisResult = {
      query: normalized.query,
      generatedAt: generatedAt.toISOString(),
      priceOrigin: "caller_supplied",
      officialBaselineOrigin: "official_latest_completed_close",
      company: {
        code: company.code,
        name: company.name,
        shortName: company.shortName,
        market: company.market,
        exchange: company.exchange,
      },
      observedPriceTwd: normalized.query.observedPriceTwd,
      observedAt: normalized.query.observedAt,
      observedTaipeiDate: normalized.observed.taipeiDate,
      sourceLabel: normalized.query.sourceLabel,
      latestOfficialCompletedClose: official.close,
      latestOfficialCloseDate: official.dataDate,
      changeFromOfficialCloseTwd: absoluteDifference,
      changeFromOfficialClosePercent: percentDifference,
      officialHistoryCutoff: official.dataDate,
      market: company.market,
      exchange: company.exchange,
      currency: "TWD",
      timezone: "Asia/Taipei",
      officialPriceBasis: "raw_unadjusted",
      sources,
      provenance: {
        observedPrice: {
          evidenceClass: "CALLER_SUPPLIED",
          official: false,
          independentlyVerified: false,
          sourceLabel: normalized.query.sourceLabel,
          observedAt: normalized.query.observedAt,
        },
        currentMasterIdentity: {
          evidenceClass: "OFFICIAL_MASTER_RAW",
          queryMarket: "all",
          coverageMarkets: ["listed", "otc"],
          companyMarket: company.market,
          sourceIds: masterSourceIds,
        },
        officialBaseline: {
          evidenceClass: "OFFICIAL_MARKET_RAW",
          priceBasis: "raw_unadjusted",
          dataDate: official.dataDate,
          sourceIds: [official.source.sourceId],
        },
        comparison: {
          evidenceClass: "MOPSFIN_CALC",
          absoluteDifferenceFormula:
            "observed_price_twd - latest_official_completed_close_twd",
          percentDifferenceFormula:
            "(observed_price_twd / latest_official_completed_close_twd - 1) * 100",
          inputOrigins: ["CALLER_SUPPLIED", "OFFICIAL_MARKET_RAW"],
        },
      },
      dependencyLedger: [
        {
          dependency: "orchestration_company_master",
          logicalInvocations: 1,
          plannedOfficialSourceLoads: 2,
          sourceEvidence: "exposed",
          sourceIds: masterSourceIds,
        },
        {
          dependency: "authoritative_completed_session_resolver",
          logicalInvocations: 1,
          plannedOfficialSourceLoads: 2,
          sourceEvidence: "exposed_in_meta_resolver_evidence",
          sourceIds: [],
        },
        {
          dependency: "official_exact_single_stock_ohlc",
          logicalInvocations: 1,
          plannedOfficialSourceLoads: exactLoads,
          sourceEvidence: "exposed",
          sourceIds: [official.source.sourceId],
        },
      ],
      workBudget: {
        requestedCompanies: 1,
        dependencyInvocations: {
          orchestrationCompanyMaster: 1,
          authoritativeCompletedSessionResolver: 1,
          officialExactSingleStockOhlc: 1,
          maximumIncludingNestedDependencies: 3,
        },
        plannedOfficialSourceRequests: {
          orchestrationCompanyMasterMarkets: 2,
          completedSessionResolver: {
            actual: resolverLoads,
            maximum: 2,
          },
          exactSingleStockOhlc: {
            actual: exactLoads,
            maximum: 2,
            cacheRefreshPerformed: completedClose.cacheRefresh.attempted,
          },
          actualTotal: 2 + resolverLoads + exactLoads,
          maximumTotal: 6,
          unitDefinition:
            "one_logical_official_source_load_before_cache_and_bounded_retry",
        },
        priceRoutingPolicy:
          "authoritative_completed_session_expected_as_of_then_exact_single_stock_ohlc",
        selectedCompanyIdentityPolicy:
          "outer_market_all_master_plus_exact_single_stock_source",
      },
      warnings: [
        "observedPriceTwd 完全由 caller 提供，MopsFin 未獨立驗證；它不是官方報價，也不得稱為 real-time 行情。",
        "官方基準只代表最近完成交易日的原始未還原權值收盤價，不是盤中行情或 adjusted close。",
        "若 caller 觀察值與官方 completed close 同一台北日期，採 13:33 Asia/Taipei 作為包含暫緩收盤可能性的保守 regular-session completion guard。",
        "價差只是 caller-supplied 觀察值相對官方完成交易日收盤價的機械比較，不代表 fair value、買賣建議或投資評級。",
        "官方基準先由 authoritative completed-session resolver 固定 expectedAsOf，再查同日 exact single-stock OHLC；不使用可能落後的全市場 latest endpoint，也不退回前一日價格。",
        "指定公司由外層 market=all master 與單股官方來源的 code、name、market 精確核對；exact price dependency 不重複取得 current master。",
        "上市與上櫃 master 各自驗證 schema、coverage、reportDate 與 source provenance；兩市場 reportDate 可不同，不會阻斷跨來源唯一的指定公司 identity。",
        ...(completedClose.cacheRefresh.attempted
          ? [
              "current-month exact OHLC 初次命中缺少 expectedAsOf 的 cache；已做一次有界失效重取並以重取後來源作為證據。",
            ]
          : []),
        ...(official.dataQualityComplete
          ? []
          : [
              "官方行情列有非收盤價欄位缺失；本結果僅在已成交且收盤價有效時保留比較。",
            ]),
      ],
    };
    return { data, completedClose };
  }
}

export const observedPriceClient = new ObservedPriceClient();
