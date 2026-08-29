import { createHash } from "node:crypto";

import { load } from "cheerio";

import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";
import {
  fail,
  isEligibleCompanyIdentity,
  normalizeCompactDate,
  normalizeOptionalText,
  normalizeRequestedCodes,
  normalizeRequiredText,
  OfficialJsonLoader,
  selectedMarkets,
  type JsonSnapshot,
  type OfficialJsonLoaderOptions,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import { MopsfinError } from "@/lib/mopsfin/errors";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

import {
  OfficialHtmlPostLoader,
  type CatalystHtmlPostLoader,
  type CatalystHtmlSnapshot,
  type OfficialHtmlPostLoaderOptions,
} from "./html-loader";
import type {
  CatalystAggregateFamilyCoverage,
  CatalystCompanyMarketHint,
  CatalystCompanyResult,
  CatalystCurrentSnapshotCoverage,
  CatalystCurrentSource,
  CatalystEvent,
  CatalystEventStatus,
  CatalystEventType,
  CatalystFamilyCoverage,
  CatalystResultSource,
  CatalystSourceFailure,
  CatalystSourceKey,
  CatalystWorkBudget,
  CompanyCatalystEventsQuery,
  CompanyCatalystEventsResult,
  CurrentMaterialInformationQuery,
  CurrentMaterialInformationResult,
} from "./types";

export interface CatalystJsonLoader {
  get(config: OfficialSourceConfig): Promise<JsonSnapshot>;
}

export interface CatalystClientOptions extends OfficialJsonLoaderOptions {
  jsonLoader?: CatalystJsonLoader;
  htmlLoader?: CatalystHtmlPostLoader;
  htmlLoaderOptions?: OfficialHtmlPostLoaderOptions;
}

interface CurrentSourceConfig extends OfficialSourceConfig {
  sourceKey:
    | "twse_material_information_current"
    | "tpex_material_information_current";
}

interface ParsedCurrentSource {
  events: CatalystEvent[];
  source: CatalystCurrentSource;
}

interface CalendarMonthRange {
  month: string;
  year: number;
  monthNumber: number;
  startDay: number;
  endDay: number;
}

interface HistoricalUnitResult {
  companyCode: string;
  eventType: CatalystEventType;
  market: CompanyMarket | null;
  queryMonth: string;
  events: CatalystEvent[];
  rawRowCount: number;
  duplicateRowCount: number;
  snapshotStatus: "nonempty" | "verified_empty";
  retrievedAt: string;
  cache?: CacheProvenance;
  snapshotIdentity: string;
}

interface FamilyExecution {
  coverage: CatalystFamilyCoverage;
  units: HistoricalUnitResult[];
  events: CatalystEvent[];
}

interface CurrentExecution {
  events: CatalystEvent[];
  sources: CatalystResultSource[];
  coverage: CatalystCurrentSnapshotCoverage[];
  failures: CatalystSourceFailure[];
}

interface HistoricalPlannedRequest {
  market: CompanyMarket | null;
  monthRange: CalendarMonthRange;
  run: () => Promise<HistoricalUnitResult>;
}

const CURRENT_SOURCE_CONFIGS: Record<CompanyMarket, CurrentSourceConfig> = {
  listed: {
    market: "listed",
    exchange: "TWSE",
    sourceKey: "twse_material_information_current",
    sourceName: "臺灣證券交易所－上市公司每日重大訊息",
    sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
  },
  otc: {
    market: "otc",
    exchange: "TPEx",
    sourceKey: "tpex_material_information_current",
    sourceName: "證券櫃檯買賣中心－上櫃公司每日重大訊息",
    sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
  },
};

const MATERIAL_HISTORY_URL =
  "https://mopsov.twse.com.tw/mops/web/ajax_t05st01";
const CONFERENCE_HISTORY_URL =
  "https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1";
const EVENT_TYPES: CatalystEventType[] = [
  "material_information",
  "investor_conference",
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_COMPANY_LIMIT = 20;
const HISTORY_RANGE_DAY_LIMIT = 366;
const HISTORY_UPSTREAM_REQUEST_LIMIT = 40;
const CATALYST_QUERY_CONCURRENCY = 4;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const CURRENT_LOOKBACK_DAYS = 7;
const SECURITY_BLOCK_PATTERN =
  /(?:access\s*denied|request\s*rejected|captcha|查詢過於頻繁|驗證碼|存取遭拒|禁止存取|系統忙碌|service\s*unavailable)/i;
const MATERIAL_EMPTY_PATTERN = /資料庫中查無需求資料/;
const CONFERENCE_EMPTY_PATTERN = /查無資料/;

class QueryTaskScheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active += 1;
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.drain();
          });
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      (this.queue.shift() as () => void)();
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalObject(nested)]),
  );
}

function stableDigest(value: unknown): string {
  return digest(canonicalObject(value));
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalFieldName(value: string): string {
  return cleanText(value)
    .replace(/\s+/g, "")
    .replaceAll("（", "(")
    .replaceAll("）", ")");
}

function canonicalRecord(
  row: Record<string, unknown>,
): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const [rawKey, value] of Object.entries(row)) {
    const key = canonicalFieldName(rawKey);
    if (fields.has(key)) {
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "重大訊息官方資料包含正規化後重複欄名。",
        {
          reason: "UPSTREAM_SCHEMA_DRIFT",
          retryable: false,
          action: "none",
          details: { key },
        },
      );
    }
    fields.set(key, value);
  }
  return fields;
}

function field(
  record: Map<string, unknown>,
  aliases: string[],
  label: string,
  market: CompanyMarket,
): unknown {
  for (const alias of aliases.map(canonicalFieldName)) {
    if (record.has(alias)) return record.get(alias);
  }
  fail("UPSTREAM_BAD_RESPONSE", `${market} 重大訊息缺少 ${label}。`, {
    label,
    fields: [...record.keys()],
  });
}

function normalizeOfficialDate(raw: unknown, label: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `${label} 不是官方日期字串。`, {
      label,
      value: raw,
    });
  }
  const compact = String(raw).trim().replace(/[年/月日.\-]/g, "");
  return normalizeCompactDate(compact, label);
}

function parseTime(raw: unknown, label: string): {
  time: string;
  precision: "minute" | "second";
} {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `${label} 不是官方時間字串。`, {
      label,
      value: raw,
    });
  }
  const text = String(raw).trim();
  let hour: number;
  let minute: number;
  let second: number;
  let precision: "minute" | "second";
  const separated = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (separated) {
    hour = Number(separated[1]);
    minute = Number(separated[2]);
    second = separated[3] === undefined ? 0 : Number(separated[3]);
    precision = separated[3] === undefined ? "minute" : "second";
  } else if (/^\d{1,6}$/.test(text)) {
    const padded = text.padStart(6, "0");
    hour = Number(padded.slice(0, 2));
    minute = Number(padded.slice(2, 4));
    second = Number(padded.slice(4, 6));
    precision = "second";
  } else {
    fail("UPSTREAM_BAD_RESPONSE", `${label} 格式錯誤。`, {
      label,
      value: raw,
    });
  }
  if (hour > 23 || minute > 59 || second > 59) {
    fail("UPSTREAM_BAD_RESPONSE", `${label} 超出有效時間範圍。`, {
      label,
      value: raw,
    });
  }
  return {
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
    precision,
  };
}

function taipeiTimestamp(date: string, time: string): string {
  return `${date}T${time}+08:00`;
}

function eventStatus(title: string): {
  status: CatalystEventStatus;
  basis: "announcement_publication" | "title_prefix";
} {
  if (/^(?:更正|修正|補充)/.test(title)) {
    return { status: "revised", basis: "title_prefix" };
  }
  if (/^(?:取消|撤回)/.test(title)) {
    return { status: "cancelled", basis: "title_prefix" };
  }
  return { status: "announced", basis: "announcement_publication" };
}

function isBlankSentinel(
  row: unknown,
  config: CurrentSourceConfig,
): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const record = canonicalRecord(row as Record<string, unknown>);
  const expected = (
    config.market === "listed"
      ? [
          "出表日期",
          "發言日期",
          "發言時間",
          "公司代號",
          "公司名稱",
          "主旨",
          "符合條款",
          "事實發生日",
          "說明",
        ]
      : [
          "Date",
          "發言日期",
          "發言時間",
          "SecuritiesCompanyCode",
          "CompanyName",
          "主旨",
          "符合條款",
          "事實發生日",
          "說明",
        ]
  ).map(canonicalFieldName);
  return (
    record.size === expected.length &&
    expected.every(
      (key) => record.has(key) && normalizeOptionalText(record.get(key)) === null,
    )
  );
}

function sortEvents(events: CatalystEvent[]): CatalystEvent[] {
  return events.sort((left, right) => {
    const leftDate = left.scheduledAt ?? left.publishedAt ?? left.factDate ?? "";
    const rightDate =
      right.scheduledAt ?? right.publishedAt ?? right.factDate ?? "";
    return (
      leftDate.localeCompare(rightDate) ||
      left.companyCode.localeCompare(right.companyCode) ||
      left.eventType.localeCompare(right.eventType) ||
      left.eventId.localeCompare(right.eventId)
    );
  });
}

function uniqueEvents(events: CatalystEvent[]): {
  events: CatalystEvent[];
  duplicateCount: number;
} {
  const byId = new Map<string, CatalystEvent>();
  let duplicateCount = 0;
  for (const event of events) {
    if (byId.has(event.eventId)) duplicateCount += 1;
    else byId.set(event.eventId, event);
  }
  return { events: sortEvents([...byId.values()]), duplicateCount };
}

function semanticMaterialKey(event: CatalystEvent): string {
  return stableDigest([
    event.eventType,
    event.market,
    event.companyCode,
    event.publishedAt,
    cleanText(event.title),
  ]);
}

function parseIsoDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    fail("INVALID_ARGUMENT", `${label} 必須是 YYYY-MM-DD。`, {
      label,
      value,
    });
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${label} 不是有效日期。`, { label, value });
  }
  return date;
}

function calendarMonths(startDate: string, endDate: string): CalendarMonthRange[] {
  const start = parseIsoDate(startDate, "startDate");
  const end = parseIsoDate(endDate, "endDate");
  const months: CalendarMonthRange[] = [];
  for (
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    cursor <= end;
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    )
  ) {
    const year = cursor.getUTCFullYear();
    const monthNumber = cursor.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    months.push({
      month: `${String(year).padStart(4, "0")}-${String(monthNumber).padStart(2, "0")}`,
      year,
      monthNumber,
      startDay:
        year === start.getUTCFullYear() && monthNumber === start.getUTCMonth() + 1
          ? start.getUTCDate()
          : 1,
      endDay:
        year === end.getUTCFullYear() && monthNumber === end.getUTCMonth() + 1
          ? end.getUTCDate()
          : lastDay,
    });
  }
  return months;
}

function addDays(value: string, count: number): string {
  const date = parseIsoDate(value, "date");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function taipeiToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function overlapsCurrentWindow(
  startDate: string,
  endDate: string,
  now: Date,
): boolean {
  const today = taipeiToday(now);
  return endDate >= addDays(today, -(CURRENT_LOOKBACK_DAYS - 1)) && startDate <= today;
}

function currentEventId(
  sourceKey: CatalystSourceKey,
  event: Omit<CatalystEvent, "eventId">,
): string {
  return stableDigest([
    "catalyst_event_v1",
    sourceKey,
    event.market,
    event.companyCode,
    event.publishedAt,
    event.factDate,
    event.clause,
    event.title,
    event.description,
  ]);
}

function parseCurrentSource(
  snapshot: JsonSnapshot,
  config: CurrentSourceConfig,
  requestedCodes: Set<string> | null,
): ParsedCurrentSource {
  if (!Array.isArray(snapshot.payload)) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `${config.exchange} 每日重大訊息不是 JSON 陣列。`,
      {
        reason: "UPSTREAM_SCHEMA_DRIFT",
        retryable: false,
        action: "none",
        details: { sourceUrl: config.sourceUrl },
      },
    );
  }
  if (snapshot.payload.length === 0) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `${config.exchange} 每日重大訊息回傳無法驗證的空陣列。`,
      {
        reason: "UPSTREAM_UNVERIFIED_EMPTY",
        retryable: true,
        action: "retry",
        details: { sourceUrl: config.sourceUrl },
      },
    );
  }
  if (
    snapshot.payload.length === 1 &&
    isBlankSentinel(snapshot.payload[0], config)
  ) {
    const snapshotIdentity = stableDigest([
      config.sourceKey,
      "official_blank_sentinel",
    ]);
    return {
      events: [],
      source: {
        sourceKey: config.sourceKey,
        eventType: "material_information",
        market: config.market,
        exchange: config.exchange,
        sourceName: config.sourceName,
        sourceUrl: config.sourceUrl,
        scope: "current_official_snapshot",
        retrievedAt: snapshot.retrievedAt,
        ...(snapshot.cache ? { cache: snapshot.cache } : {}),
        reportDate: null,
        rawRowCount: 1,
        eligibleEventCount: 0,
        excludedRowCount: 0,
        duplicateRowCount: 0,
        returnedEventCount: 0,
        snapshotStatus: "verified_empty",
        emptyVerification: "official_blank_sentinel",
        officialDeclaredRowCount: null,
        rowsetCompleteness: "unverified_no_official_declared_count",
        snapshotIdentity,
      },
    };
  }
  if (snapshot.payload.some((row) => isBlankSentinel(row, config))) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `${config.exchange} 每日重大訊息混入空白 sentinel。`,
      {
        reason: "UPSTREAM_SCHEMA_DRIFT",
        retryable: false,
        action: "none",
      },
    );
  }

  const reportDates = new Set<string>();
  const events: CatalystEvent[] = [];
  let excludedRowCount = 0;
  for (const rawRow of snapshot.payload) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      fail("UPSTREAM_BAD_RESPONSE", `${config.market} 重大訊息包含非物件資料列。`);
    }
    const record = canonicalRecord(rawRow as Record<string, unknown>);
    const reportDate = normalizeOfficialDate(
      field(record, ["出表日期", "Date"], "出表日期", config.market),
      "出表日期",
    );
    const publicationDate = normalizeOfficialDate(
      field(record, ["發言日期"], "發言日期", config.market),
      "發言日期",
    );
    const publicationTime = parseTime(
      field(record, ["發言時間"], "發言時間", config.market),
      "發言時間",
    );
    const companyCode = normalizeRequiredText(
      field(
        record,
        ["公司代號", "SecuritiesCompanyCode"],
        "公司代號",
        config.market,
      ),
      "公司代號",
      config.market,
    );
    const companyName = normalizeRequiredText(
      field(record, ["公司名稱", "CompanyName"], "公司名稱", config.market),
      "公司名稱",
      config.market,
    );
    const title = normalizeRequiredText(
      field(record, ["主旨", "Subject"], "主旨", config.market),
      "主旨",
      config.market,
    );
    const clause = normalizeRequiredText(
      field(record, ["符合條款"], "符合條款", config.market),
      "符合條款",
      config.market,
    );
    const factDate = normalizeOfficialDate(
      field(record, ["事實發生日"], "事實發生日", config.market),
      "事實發生日",
    );
    const description = normalizeRequiredText(
      field(record, ["說明", "Description"], "說明", config.market),
      "說明",
      config.market,
    );
    reportDates.add(reportDate);
    if (!isEligibleCompanyIdentity(companyCode, companyName)) {
      excludedRowCount += 1;
      continue;
    }
    const publishedAt = taipeiTimestamp(
      publicationDate,
      publicationTime.time,
    );
    const normalizedStatus = eventStatus(title);
    const sourceRecordKey = stableDigest([
      config.sourceKey,
      companyCode,
      publishedAt,
      factDate,
      clause,
      title,
      description,
    ]);
    const eventWithoutId: Omit<CatalystEvent, "eventId"> = {
      eventType: "material_information",
      companyCode,
      companyName,
      market: config.market,
      title,
      description,
      clause,
      publishedAt,
      factDate,
      scheduledAt: null,
      effectiveAt: null,
      timezone: "Asia/Taipei",
      status: normalizedStatus.status,
      statusBasis: normalizedStatus.basis,
      dateConfidence: "confirmed",
      dateBasis: "publication",
      datePrecision: publicationTime.precision,
      isConsensus: false,
      sourceKey: config.sourceKey,
      sourceUrl: config.sourceUrl,
      sourceReportDate: reportDate,
      sourceRecordKey,
      eventDetails: null,
    };
    events.push({
      eventId: currentEventId(config.sourceKey, eventWithoutId),
      ...eventWithoutId,
    });
  }
  if (reportDates.size !== 1) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `${config.exchange} 每日重大訊息無法形成單一出表日快照。`,
      {
        reason: "UPSTREAM_SNAPSHOT_IDENTITY_MISMATCH",
        retryable: true,
        action: "retry",
        details: { reportDates: [...reportDates] },
      },
    );
  }
  const unique = uniqueEvents(events);
  const reportDate = [...reportDates][0];
  const filtered = requestedCodes
    ? unique.events.filter((event) => requestedCodes.has(event.companyCode))
    : unique.events;
  const snapshotIdentity = stableDigest({
    sourceKey: config.sourceKey,
    reportDate,
    rawRows: canonicalObject(snapshot.payload),
  });
  return {
    events: filtered,
    source: {
      sourceKey: config.sourceKey,
      eventType: "material_information",
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      scope: "current_official_snapshot",
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      reportDate,
      rawRowCount: snapshot.payload.length,
      eligibleEventCount: unique.events.length,
      excludedRowCount,
      duplicateRowCount: unique.duplicateCount,
      returnedEventCount: filtered.length,
      snapshotStatus: "nonempty",
      emptyVerification: "not_applicable",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "unverified_no_official_declared_count",
      snapshotIdentity,
    },
  };
}

function validateCurrentQuery(query: CurrentMaterialInformationQuery): string[] | null {
  selectedMarkets(query.market);
  return normalizeRequestedCodes(query.companyCodes)?.sort() ?? null;
}

function normalizeEventTypes(raw: CatalystEventType[] | undefined): CatalystEventType[] {
  if (raw === undefined) return [...EVENT_TYPES];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > EVENT_TYPES.length) {
    fail("INVALID_ARGUMENT", "eventTypes 必須包含 1 至 2 個支援的事件類型。");
  }
  if (raw.some((value) => !EVENT_TYPES.includes(value))) {
    fail(
      "INVALID_ARGUMENT",
      "eventTypes 只支援 material_information 與 investor_conference。",
      { eventTypes: raw },
    );
  }
  if (new Set(raw).size !== raw.length) {
    fail("INVALID_ARGUMENT", "eventTypes 不得重複。", { eventTypes: raw });
  }
  return [...raw].sort(
    (left, right) => EVENT_TYPES.indexOf(left) - EVENT_TYPES.indexOf(right),
  );
}

function normalizeMarketHints(
  hints: CatalystCompanyMarketHint[] | undefined,
  companyCodes: string[],
): Map<string, CompanyMarket> {
  const result = new Map<string, CompanyMarket>();
  if (hints === undefined) return result;
  const requested = new Set(companyCodes);
  for (const hint of hints) {
    if (
      !hint ||
      !requested.has(hint.companyCode) ||
      (hint.market !== "listed" && hint.market !== "otc") ||
      result.has(hint.companyCode)
    ) {
      fail("INVALID_ARGUMENT", "companyMarkets 必須是 requested company 的唯一市場提示。", {
        hint,
      });
    }
    result.set(hint.companyCode, hint.market);
  }
  return result;
}

function validateHistoricalQuery(
  query: CompanyCatalystEventsQuery,
  now: Date,
): {
  companyCodes: string[];
  eventTypes: CatalystEventType[];
  months: CalendarMonthRange[];
  marketHints: Map<string, CompanyMarket>;
  offset: number;
  limit: number;
  workBudget: CatalystWorkBudget;
} {
  const companyCodes = normalizeRequestedCodes(query.companyCodes)?.sort();
  if (!companyCodes || companyCodes.length > HISTORY_COMPANY_LIMIT) {
    fail(
      "INVALID_ARGUMENT",
      `companyCodes 必須包含 1 至 ${HISTORY_COMPANY_LIMIT} 個四碼公司代號。`,
    );
  }
  const start = parseIsoDate(query.startDate, "startDate");
  const end = parseIsoDate(query.endDate, "endDate");
  if (start > end) {
    fail("INVALID_ARGUMENT", "startDate 不得晚於 endDate。", {
      startDate: query.startDate,
      endDate: query.endDate,
    });
  }
  const inclusiveDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (inclusiveDays > HISTORY_RANGE_DAY_LIMIT) {
    fail(
      "INVALID_ARGUMENT",
      `查詢日期範圍不得超過 ${HISTORY_RANGE_DAY_LIMIT} 天。`,
      { inclusiveDays },
    );
  }
  const eventTypes = normalizeEventTypes(query.eventTypes);
  const months = calendarMonths(query.startDate, query.endDate);
  const marketHints = normalizeMarketHints(query.companyMarkets, companyCodes);
  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail("INVALID_ARGUMENT", "offset 必須是非負安全整數。", { offset });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    fail("INVALID_ARGUMENT", `limit 必須是 1 至 ${MAX_PAGE_LIMIT} 的安全整數。`, {
      limit,
    });
  }

  const materialRequests = eventTypes.includes("material_information")
    ? companyCodes.length * months.length
    : 0;
  const conferenceRequests = eventTypes.includes("investor_conference")
    ? companyCodes.length * months.length * 2
    : 0;
  const currentMarkets = new Set<CompanyMarket>();
  if (
    eventTypes.includes("material_information") &&
    overlapsCurrentWindow(query.startDate, query.endDate, now)
  ) {
    if (marketHints.size === companyCodes.length) {
      for (const market of marketHints.values()) currentMarkets.add(market);
    } else {
      currentMarkets.add("listed");
      currentMarkets.add("otc");
    }
  }
  const historicalUpstreamRequests = materialRequests + conferenceRequests;
  const plannedUpstreamRequests =
    historicalUpstreamRequests + currentMarkets.size;
  if (plannedUpstreamRequests > HISTORY_UPSTREAM_REQUEST_LIMIT) {
    fail(
      "INVALID_ARGUMENT",
      `查詢需要 ${plannedUpstreamRequests} 個 catalyst 查詢工作單位，超過 ${HISTORY_UPSTREAM_REQUEST_LIMIT} 單位上限；請縮短日期或減少公司／事件類型。歷史法說為避免轉板遺漏，固定查詢上市與上櫃兩市場。`,
      {
        companyCount: companyCodes.length,
        calendarMonthCount: months.length,
        eventTypeCount: eventTypes.length,
        historicalUpstreamRequests,
        currentSnapshotRequests: currentMarkets.size,
        upstreamRequestLimit: HISTORY_UPSTREAM_REQUEST_LIMIT,
      },
    );
  }
  return {
    companyCodes,
    eventTypes,
    months,
    marketHints,
    offset,
    limit,
    workBudget: {
      companyCount: companyCodes.length,
      distinctCalendarMonths: months.length,
      eventTypeCount: eventTypes.length,
      historicalLogicalUnits:
        companyCodes.length * months.length * eventTypes.length,
      historicalUpstreamRequests,
      currentSnapshotRequests: currentMarkets.size,
      plannedUpstreamRequests,
      upstreamRequestLimit: HISTORY_UPSTREAM_REQUEST_LIMIT,
    },
  };
}

function badHtml(
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason: "UPSTREAM_HTML_CONTRACT_MISMATCH",
    retryable: true,
    action: "retry",
    details,
  });
}

function htmlDocument(snapshot: CatalystHtmlSnapshot, sourceName: string) {
  if (!snapshot.body.trim()) {
    badHtml(`MOPS ${sourceName}回傳空白 HTML。`);
  }
  if (
    snapshot.contentType &&
    !/(?:text\/html|application\/xhtml\+xml)/i.test(snapshot.contentType)
  ) {
    badHtml(`MOPS ${sourceName}回傳非 HTML content-type。`, {
      contentType: snapshot.contentType,
    });
  }
  if (SECURITY_BLOCK_PATTERN.test(snapshot.body)) {
    throw new MopsfinError(
      "UPSTREAM_BAD_RESPONSE",
      `MOPS ${sourceName}回傳安全阻擋或服務異常頁。`,
      {
        reason: "UPSTREAM_SECURITY_BLOCK",
        retryable: true,
        action: "retry",
      },
    );
  }
  const $ = load(snapshot.body);
  if (cleanText($("title").first().text()) !== "公開資訊觀測站") {
    badHtml(`MOPS ${sourceName}缺少官方頁面識別。`);
  }
  if ($("#div01").length !== 1) {
    badHtml(`MOPS ${sourceName}缺少唯一結果容器。`);
  }
  if (!$("script[src*='mops2.js']").length) {
    badHtml(`MOPS ${sourceName}缺少官方回應 shell。`);
  }
  return $;
}

function tableIndexes(
  headers: string[],
  required: Record<string, string>,
  sourceName: string,
): Record<string, number> {
  const canonical = headers.map(canonicalFieldName);
  return Object.fromEntries(
    Object.entries(required).map(([key, label]) => {
      const index = canonical.indexOf(canonicalFieldName(label));
      if (index < 0) {
        badHtml(`MOPS ${sourceName}缺少必要欄位 ${label}。`, {
          headers: canonical,
        });
      }
      return [key, index];
    }),
  );
}

function onclickValue(onclick: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `${escaped}\\.value\\s*=\\s*["']([^"']*)["']`,
  ).exec(onclick);
  return match?.[1] ?? null;
}

function marketFromTypek(raw: string): CompanyMarket {
  if (raw === "sii") return "listed";
  if (raw === "otc") return "otc";
  badHtml("MOPS 歷史事件回傳非上市櫃市場識別。", { typek: raw });
}

function parseMaterialHistory(
  snapshot: CatalystHtmlSnapshot,
  companyCode: string,
  monthRange: CalendarMonthRange,
): HistoricalUnitResult {
  const sourceName = "歷史重大訊息";
  const $ = htmlDocument(snapshot, sourceName);
  const result = $("#div01");
  const resultText = cleanText(result.text());
  const tables = result.find("table.hasBorder");
  if (tables.length === 0 && MATERIAL_EMPTY_PATTERN.test(resultText)) {
    const snapshotIdentity = stableDigest([
      "mops_material_information_history",
      companyCode,
      monthRange.month,
      monthRange.startDay,
      monthRange.endDay,
      "official_no_data_marker_and_mops_response_shell",
    ]);
    return {
      companyCode,
      eventType: "material_information",
      market: null,
      queryMonth: monthRange.month,
      events: [],
      rawRowCount: 0,
      duplicateRowCount: 0,
      snapshotStatus: "verified_empty",
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      snapshotIdentity,
    };
  }
  if (tables.length !== 1) {
    badHtml("MOPS 歷史重大訊息未回傳唯一事件表格。", {
      companyCode,
      queryMonth: monthRange.month,
      tableCount: tables.length,
    });
  }
  const table = tables.first();
  const headerCells = table.find("tr").first().children("th");
  const headers = headerCells.map((_, cell) => cleanText($(cell).text())).get();
  const indexes = tableIndexes(
    headers,
    {
      code: "公司代號",
      name: "公司名稱",
      publicationDate: "發言日期",
      publicationTime: "發言時間",
      title: "主旨",
    },
    sourceName,
  );
  const parsed: CatalystEvent[] = [];
  const rows = table.find("tr").slice(1);
  rows.each((_, rowElement) => {
    const cells = $(rowElement).children("td");
    if (cells.length < headers.length) {
      badHtml("MOPS 歷史重大訊息資料列欄數不足。", {
        companyCode,
        queryMonth: monthRange.month,
        cells: cells.length,
        headers: headers.length,
      });
    }
    const textAt = (index: number) => cleanText(cells.eq(index).text());
    const rowCode = textAt(indexes.code);
    if (rowCode !== companyCode) {
      badHtml("MOPS 歷史重大訊息公司識別與查詢不符。", {
        requestedCompanyCode: companyCode,
        returnedCompanyCode: rowCode,
      });
    }
    const companyName = textAt(indexes.name);
    const title = textAt(indexes.title);
    if (!companyName || !title) {
      badHtml("MOPS 歷史重大訊息缺少公司名稱或主旨。", {
        companyCode,
      });
    }
    const publicationDate = normalizeOfficialDate(
      textAt(indexes.publicationDate),
      "發言日期",
    );
    const publicationTime = parseTime(
      textAt(indexes.publicationTime),
      "發言時間",
    );
    if (
      publicationDate.slice(0, 7) !== monthRange.month ||
      Number(publicationDate.slice(8, 10)) < monthRange.startDay ||
      Number(publicationDate.slice(8, 10)) > monthRange.endDay
    ) {
      badHtml("MOPS 歷史重大訊息日期超出查詢範圍。", {
        companyCode,
        publicationDate,
        queryMonth: monthRange.month,
      });
    }
    const detailCell = cells.last();
    const onclick = detailCell.find("input[onclick]").first().attr("onclick") ?? "";
    const detailCode = onclickValue(onclick, "co_id");
    const typek = onclickValue(onclick, "TYPEK");
    const spokeDate = onclickValue(onclick, "spoke_date");
    const spokeTime = onclickValue(onclick, "spoke_time");
    const sequence = onclickValue(onclick, "seq_no");
    if (!detailCode || !typek || !spokeDate || !spokeTime || !sequence) {
      badHtml("MOPS 歷史重大訊息缺少 stable detail key。", {
        companyCode,
        publicationDate,
      });
    }
    const market = marketFromTypek(typek);
    const normalizedSpokeDate = normalizeOfficialDate(spokeDate, "spoke_date");
    const normalizedSpokeTime = parseTime(spokeTime, "spoke_time");
    if (
      detailCode !== companyCode ||
      normalizedSpokeDate !== publicationDate ||
      normalizedSpokeTime.time !== publicationTime.time ||
      !/^\d+$/.test(sequence)
    ) {
      badHtml("MOPS 歷史重大訊息 stable detail key 與列資料不符。", {
        companyCode,
        publicationDate,
      });
    }
    const publishedAt = taipeiTimestamp(
      publicationDate,
      publicationTime.time,
    );
    const status = eventStatus(title);
    const sourceRecordKey = `t05st01:${typek}:${companyCode}:${spokeDate}:${spokeTime}:${sequence}`;
    parsed.push({
      eventId: stableDigest(["catalyst_event_v1", sourceRecordKey]),
      eventType: "material_information",
      companyCode,
      companyName,
      market,
      title,
      description: null,
      clause: null,
      publishedAt,
      factDate: null,
      scheduledAt: null,
      effectiveAt: null,
      timezone: "Asia/Taipei",
      status: status.status,
      statusBasis: status.basis,
      dateConfidence: "confirmed",
      dateBasis: "publication",
      datePrecision: publicationTime.precision,
      isConsensus: false,
      sourceKey: "mops_material_information_history",
      sourceUrl: MATERIAL_HISTORY_URL,
      sourceReportDate: null,
      sourceRecordKey,
      eventDetails: null,
    });
  });
  if (rows.length === 0) {
    badHtml("MOPS 歷史重大訊息回傳空表格，且沒有官方查無資料標記。", {
      companyCode,
      queryMonth: monthRange.month,
    });
  }
  const unique = uniqueEvents(parsed);
  const markets = new Set(unique.events.map((event) => event.market));
  if (markets.size > 1) {
    badHtml("MOPS 單一公司歷史重大訊息混入多個市場。", {
      companyCode,
      markets: [...markets],
    });
  }
  return {
    companyCode,
    eventType: "material_information",
    market: unique.events[0]?.market ?? null,
    queryMonth: monthRange.month,
    events: unique.events,
    rawRowCount: rows.length,
    duplicateRowCount: unique.duplicateCount,
    snapshotStatus: "nonempty",
    retrievedAt: snapshot.retrievedAt,
    ...(snapshot.cache ? { cache: snapshot.cache } : {}),
    snapshotIdentity: stableDigest({
      sourceKey: "mops_material_information_history",
      companyCode,
      queryMonth: monthRange.month,
      startDay: monthRange.startDay,
      endDay: monthRange.endDay,
      records: unique.events.map((event) => event.sourceRecordKey),
    }),
  };
}

function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function fileNameFromCell(onclick: string): string | null {
  const match = /fileName\.value\s*=\s*["']([^"']+)["']/.exec(onclick);
  return match?.[1] ?? null;
}

function parseConferenceHistory(
  snapshot: CatalystHtmlSnapshot,
  companyCode: string,
  market: CompanyMarket,
  monthRange: CalendarMonthRange,
  requestedStart: string,
  requestedEnd: string,
): HistoricalUnitResult {
  const sourceName = "歷史法人說明會";
  const $ = htmlDocument(snapshot, sourceName);
  if (!$("script[src*='t100sb02_1_j.js']").length) {
    badHtml("MOPS 歷史法人說明會缺少端點識別 script。", {
      companyCode,
      queryMonth: monthRange.month,
    });
  }
  const result = $("#div01");
  const table = result.find("table#myTable");
  const resultText = cleanText(result.text());
  if (table.length === 0 && CONFERENCE_EMPTY_PATTERN.test(resultText)) {
    return {
      companyCode,
      eventType: "investor_conference",
      market,
      queryMonth: monthRange.month,
      events: [],
      rawRowCount: 0,
      duplicateRowCount: 0,
      snapshotStatus: "verified_empty",
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      snapshotIdentity: stableDigest([
        "mops_investor_conference_history",
        companyCode,
        market,
        monthRange.month,
        "official_no_data_marker_and_endpoint_shell",
      ]),
    };
  }
  if (table.length !== 1) {
    badHtml("MOPS 歷史法人說明會未回傳唯一事件表格。", {
      companyCode,
      market,
      queryMonth: monthRange.month,
      tableCount: table.length,
    });
  }
  const firstHeaderText = canonicalFieldName(table.find("thead").text());
  for (const expected of [
    "公司代號",
    "公司名稱",
    "召開法人說明會日期",
    "召開法人說明會時間",
    "召開法人說明會地點",
    "法人說明會擇要訊息",
  ]) {
    if (!firstHeaderText.includes(canonicalFieldName(expected))) {
      badHtml(`MOPS 歷史法人說明會缺少必要欄位 ${expected}。`);
    }
  }
  const parsed: CatalystEvent[] = [];
  const rows = table.find("tr[data-type='body']");
  rows.each((_, rowElement) => {
    const cells = $(rowElement).children("td");
    if (cells.length < 11) {
      badHtml("MOPS 歷史法人說明會資料列欄數不足。", {
        companyCode,
        market,
        cells: cells.length,
      });
    }
    const textAt = (index: number) => cleanText(cells.eq(index).text());
    const rowCode = textAt(0);
    if (rowCode !== companyCode) {
      badHtml("MOPS 歷史法人說明會公司識別與查詢不符。", {
        requestedCompanyCode: companyCode,
        returnedCompanyCode: rowCode,
        market,
      });
    }
    const companyName = textAt(1);
    const scheduledDate = normalizeOfficialDate(textAt(2), "法說會日期");
    const scheduledTime = parseTime(textAt(3), "法說會時間");
    if (scheduledDate.slice(0, 7) !== monthRange.month) {
      badHtml("MOPS 歷史法人說明會日期與查詢月份不符。", {
        companyCode,
        scheduledDate,
        queryMonth: monthRange.month,
      });
    }
    if (scheduledDate < requestedStart || scheduledDate > requestedEnd) return;
    const description = textAt(5);
    if (!companyName || !description) {
      badHtml("MOPS 歷史法人說明會缺少公司名稱或擇要訊息。", {
        companyCode,
        scheduledDate,
      });
    }
    const scheduledAt = taipeiTimestamp(scheduledDate, scheduledTime.time);
    const presentationZhFileName = fileNameFromCell(
      cells.eq(6).find("[onclick]").first().attr("onclick") ?? "",
    );
    const presentationEnFileName = fileNameFromCell(
      cells.eq(7).find("[onclick]").first().attr("onclick") ?? "",
    );
    const companyIrUrl = safeHttpUrl(
      cells.eq(8).find("a[href]").first().attr("href"),
    );
    const videoUrl = safeHttpUrl(
      cells.eq(9).find("a[href]").first().attr("href"),
    );
    const location = normalizeOptionalText(textAt(4));
    const note = normalizeOptionalText(textAt(10));
    const sourceRecordKey = stableDigest([
      "t100sb02_1",
      market,
      companyCode,
      scheduledAt,
      description,
      presentationZhFileName,
      presentationEnFileName,
    ]);
    parsed.push({
      eventId: stableDigest(["catalyst_event_v1", sourceRecordKey]),
      eventType: "investor_conference",
      companyCode,
      companyName,
      market,
      title: "法人說明會",
      description,
      clause: null,
      publishedAt: null,
      factDate: null,
      scheduledAt,
      effectiveAt: null,
      timezone: "Asia/Taipei",
      status: "scheduled",
      statusBasis: "official_schedule",
      dateConfidence: "confirmed",
      dateBasis: "scheduled_event",
      datePrecision: scheduledTime.precision,
      isConsensus: false,
      sourceKey: "mops_investor_conference_history",
      sourceUrl: CONFERENCE_HISTORY_URL,
      sourceReportDate: null,
      sourceRecordKey,
      eventDetails: {
        location,
        presentationZhFileName,
        presentationEnFileName,
        companyIrUrl,
        videoUrl,
        note,
      },
    });
  });
  if (rows.length === 0) {
    badHtml("MOPS 歷史法人說明會回傳空表格，且沒有官方查無資料標記。", {
      companyCode,
      market,
      queryMonth: monthRange.month,
    });
  }
  const unique = uniqueEvents(parsed);
  return {
    companyCode,
    eventType: "investor_conference",
    market,
    queryMonth: monthRange.month,
    events: unique.events,
    rawRowCount: rows.length,
    duplicateRowCount: unique.duplicateCount,
    snapshotStatus: "nonempty",
    retrievedAt: snapshot.retrievedAt,
    ...(snapshot.cache ? { cache: snapshot.cache } : {}),
    snapshotIdentity: stableDigest({
      sourceKey: "mops_investor_conference_history",
      companyCode,
      market,
      queryMonth: monthRange.month,
      records: unique.events.map((event) => event.sourceRecordKey),
    }),
  };
}

function failureFrom(
  error: unknown,
  companyCode: string,
  eventType: CatalystEventType,
  queryMonth: string,
  market: CompanyMarket | null,
): CatalystSourceFailure {
  const upstream =
    error instanceof MopsfinError
      ? error
      : new MopsfinError(
          "UPSTREAM_BAD_RESPONSE",
          "Catalyst 官方資料查詢發生未預期錯誤。",
          {
            cause: error,
            reason: "UPSTREAM_UNEXPECTED_ERROR",
            retryable: true,
            action: "retry",
          },
        );
  const retryable = upstream.retryable ?? false;
  const action = upstream.action ?? (retryable ? "retry" : "none");
  return {
    failureId: stableDigest([
      "catalyst_failure_v1",
      companyCode,
      eventType,
      queryMonth,
      market,
      upstream.code,
      upstream.reason ?? null,
    ]),
    companyCode,
    eventType,
    market,
    queryMonth,
    code: upstream.code,
    message: upstream.message,
    reason: upstream.reason ?? null,
    retryable,
    retryAfterMs: upstream.retryAfterMs ?? null,
    action,
  };
}

function historySource(
  eventType: CatalystEventType,
  executions: FamilyExecution[],
  startDate: string,
  endDate: string,
): CatalystResultSource {
  const units = executions.flatMap((execution) => execution.units);
  const events = uniqueEvents(executions.flatMap((execution) => execution.events));
  const sourceKey: CatalystSourceKey =
    eventType === "material_information"
      ? "mops_material_information_history"
      : "mops_investor_conference_history";
  return {
    eventType,
    market: null,
    exchange: "MOPS",
    sourceKey,
    sourceName:
      eventType === "material_information"
        ? "公開資訊觀測站－歷史重大訊息"
        : "公開資訊觀測站－歷史法人說明會一覽表",
    sourceUrl:
      eventType === "material_information"
        ? MATERIAL_HISTORY_URL
        : CONFERENCE_HISTORY_URL,
    retrievedAt:
      units.map((unit) => unit.retrievedAt).sort().at(-1) ?? null,
    ...(units.length === 1 && units[0].cache
      ? { cache: units[0].cache }
      : {}),
    scope: "selected_company_historical_months",
    queryStart: startDate,
    queryEnd: endDate,
    sourceReportDate: null,
    rawRowCount: units.reduce((sum, unit) => sum + unit.rawRowCount, 0),
    acceptedEventCount: events.events.length,
    snapshotIdentity: stableDigest({
      sourceKey,
      contracts: executions.map((execution) => execution.coverage.snapshotIdentity),
    }),
  };
}

export class CatalystClient {
  private readonly jsonLoader: CatalystJsonLoader;
  private readonly htmlLoader: CatalystHtmlPostLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    options: CatalystClientOptions = {},
  ) {
    this.jsonLoader =
      options.jsonLoader ?? new OfficialJsonLoader(fetchImpl, now, options);
    this.htmlLoader =
      options.htmlLoader ??
      new OfficialHtmlPostLoader(
        fetchImpl,
        now,
        options.htmlLoaderOptions ?? options,
      );
  }

  async getCurrentMaterialInformation(
    query: CurrentMaterialInformationQuery,
  ): Promise<CurrentMaterialInformationResult> {
    const companyCodes = validateCurrentQuery(query);
    const requestedCodes = companyCodes ? new Set(companyCodes) : null;
    const markets = selectedMarkets(query.market);
    const parsed = await Promise.all(
      markets.map(async (market) => {
        const config = CURRENT_SOURCE_CONFIGS[market];
        const snapshot = await this.jsonLoader.get(config);
        return parseCurrentSource(snapshot, config, requestedCodes);
      }),
    );
    const unique = uniqueEvents(parsed.flatMap((source) => source.events));
    const events = unique.events;
    const withEventsCompanyCodes = [
      ...new Set(events.map((event) => event.companyCode)),
    ].sort();
    const withoutEventsCompanyCodes = companyCodes
      ? companyCodes.filter((code) => !withEventsCompanyCodes.includes(code))
      : [];
    const sources = parsed.map((source) => source.source);
    return {
      query: { market: query.market, companyCodes },
      generatedAt: this.now().toISOString(),
      timezone: "Asia/Taipei",
      scope: "current_official_snapshot",
      isConsensus: false,
      events,
      sources,
      selection: {
        requestedCompanyCodes: companyCodes,
        withEventsCompanyCodes,
        withoutEventsCompanyCodes,
      },
      counts: {
        listed: events.filter((event) => event.market === "listed").length,
        otc: events.filter((event) => event.market === "otc").length,
        returned: events.length,
      },
      fingerprint: stableDigest({
        query: { market: query.market, companyCodes },
        sourceSnapshots: sources.map((source) => source.snapshotIdentity),
        eventIds: events.map((event) => event.eventId),
      }),
      warnings: [
        "每日重大訊息 OpenAPI 沒有 official declared row count；source snapshot 通過欄位、單一出表日、唯一事件與空白 sentinel 檢查，但不能證明平台 rowset 絕對完整。",
      ],
    };
  }

  async getCompanyCatalystEvents(
    query: CompanyCatalystEventsQuery,
  ): Promise<CompanyCatalystEventsResult> {
    const validated = validateHistoricalQuery(query, this.now());
    const scheduler = new QueryTaskScheduler(CATALYST_QUERY_CONCURRENCY);
    const familyExecutions = await Promise.all(
      validated.companyCodes.flatMap((companyCode) =>
        validated.eventTypes.map((eventType) =>
          this.executeFamily(
            companyCode,
            eventType,
            validated.months,
            query.startDate,
            query.endDate,
            scheduler,
          ),
        ),
      ),
    );
    const current = await this.executeCurrent(
      validated,
      query.startDate,
      query.endDate,
    );

    const hasVerifiedHistoricalSource = familyExecutions.some(
      (execution) => execution.units.length > 0,
    );
    if (!hasVerifiedHistoricalSource && current.sources.length === 0) {
      const aggregateFailures = [
        ...familyExecutions.flatMap(
          (execution) => execution.coverage.failures,
        ),
        ...current.failures,
      ];
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "所有 catalyst 官方來源都失敗，無法形成可驗證結果。",
        {
          reason: "ALL_CATALYST_SOURCES_FAILED",
          retryable: aggregateFailures.some((failure) => failure.retryable),
          action: aggregateFailures.some((failure) => failure.retryable)
            ? "retry"
            : "none",
          details: {
            failures: aggregateFailures.map((failure) => ({
              failureId: failure.failureId,
              companyCode: failure.companyCode,
              eventType: failure.eventType,
              queryMonth: failure.queryMonth,
              code: failure.code,
              reason: failure.reason,
            })),
          },
        },
      );
    }

    const historicalEvents = familyExecutions.flatMap(
      (execution) => execution.events,
    );
    const currentMaterialEvents = uniqueEvents(current.events).events;
    const currentReplacementCounts = new Map<string, number>();
    for (const event of currentMaterialEvents) {
      const key = semanticMaterialKey(event);
      currentReplacementCounts.set(
        key,
        (currentReplacementCounts.get(key) ?? 0) + 1,
      );
    }
    const retainedHistoricalEvents: CatalystEvent[] = [];
    for (const event of historicalEvents) {
      if (event.eventType !== "material_information") {
        retainedHistoricalEvents.push(event);
        continue;
      }
      const key = semanticMaterialKey(event);
      const replacementCount = currentReplacementCounts.get(key) ?? 0;
      if (replacementCount > 0) {
        currentReplacementCounts.set(key, replacementCount - 1);
      } else {
        retainedHistoricalEvents.push(event);
      }
    }
    const allEvents = uniqueEvents([
      ...retainedHistoricalEvents,
      ...currentMaterialEvents,
    ]).events;
    const failures = [
      ...familyExecutions.flatMap((execution) => execution.coverage.failures),
      ...current.failures,
    ]
      .sort((left, right) => left.failureId.localeCompare(right.failureId));
    const familyCoverage = familyExecutions
      .map((execution) => execution.coverage)
      .sort(
        (left, right) =>
          left.companyCode.localeCompare(right.companyCode) ||
          left.eventType.localeCompare(right.eventType),
      );
    const companies = this.companyResults(
      validated.companyCodes,
      validated.eventTypes,
      familyCoverage,
      current.coverage,
      allEvents,
    );
    const aggregateCoverage = this.aggregateCoverage(
      validated.eventTypes,
      validated.companyCodes,
      familyCoverage,
      current.coverage,
      query.startDate,
      query.endDate,
    );
    const historySources = validated.eventTypes.flatMap((eventType) => {
      const executions = familyExecutions.filter(
        (execution) => execution.coverage.eventType === eventType,
      );
      return executions.some((execution) => execution.units.length > 0)
        ? [historySource(eventType, executions, query.startDate, query.endDate)]
        : [];
    });
    const sources = [...historySources, ...current.sources].sort((left, right) =>
      left.sourceKey.localeCompare(right.sourceKey),
    );
    const page = allEvents.slice(
      validated.offset,
      validated.offset + validated.limit,
    );
    const nextOffset =
      validated.offset + page.length < allEvents.length
        ? validated.offset + page.length
        : null;
    const fingerprint = stableDigest({
      query: {
        companyCodes: validated.companyCodes,
        startDate: query.startDate,
        endDate: query.endDate,
        eventTypes: validated.eventTypes,
      },
      events: allEvents.map((event) => event.eventId),
      sources: sources.map((source) => source.snapshotIdentity),
      currentCoverage: current.coverage.map((item) => item.snapshotIdentity),
      failures: failures.map((failure) => failure.failureId),
    });
    const completeCompanies = companies.filter(
      (company) => company.status === "complete",
    ).length;
    const partialCompanies = companies.filter(
      (company) => company.status === "partial",
    ).length;
    const failedCompanies = companies.filter(
      (company) => company.status === "failed",
    ).length;
    const warnings = [
      "資料只代表官方揭露事件，不是分析師共識、預估修正、情緒分數或投資建議。",
      "歷史重大訊息清單提供精確發言時間，但不提供事實發生日、條款與說明；這些欄位保持 null，沒有以發言日代填。",
      "歷史法人說明會固定查詢上市與上櫃兩市場以避免轉板遺漏；清單提供確認的召開時間，但不提供公告發布時間，publishedAt 保持 null，過去日期也不推論為 completed。",
      "familyCoverage 只計 selected-company 歷史月份；近期重大訊息補強另列於 coverage.currentSnapshots，避免把共享 current snapshot 與歷史月份計數混在一起。",
    ];
    if (current.coverage.length > 0) {
      warnings.push(
        "近期重大訊息 current OpenAPI 沒有 official declared row count；它只作 MOPS 歷史查詢的補強，來源成功不另外證明官方平台 rowset 絕對完整。",
      );
    }
    if (failures.length > 0) {
      warnings.push(
        "部分公司／事件類型／月份的官方請求失敗，已隔離並列於 failures；不得把該範圍解讀為沒有事件。",
      );
    }
    return {
      query: {
        companyCodes: validated.companyCodes,
        startDate: query.startDate,
        endDate: query.endDate,
        eventTypes: validated.eventTypes,
        offset: validated.offset,
        limit: validated.limit,
      },
      generatedAt: this.now().toISOString(),
      timezone: "Asia/Taipei",
      scope: "official_disclosure_events",
      isConsensus: false,
      events: page,
      sources,
      coverage: {
        sourceComplete: failures.length === 0,
        failureIsolation: "per_company_event_type_calendar_month",
        families: aggregateCoverage,
        currentSnapshots: current.coverage,
      },
      familyCoverage,
      companies,
      failures,
      counts: {
        requestedCompanies: validated.companyCodes.length,
        requestedEventTypes: validated.eventTypes.length,
        totalEvents: allEvents.length,
        returnedEvents: page.length,
        completeCompanies,
        partialCompanies,
        failedCompanies,
      },
      workBudget: validated.workBudget,
      pagination: {
        offset: validated.offset,
        limit: validated.limit,
        totalRows: allEvents.length,
        returnedRows: page.length,
        hasMore: nextOffset !== null,
        nextOffset,
      },
      fingerprint,
      warnings,
    };
  }

  private async executeFamily(
    companyCode: string,
    eventType: CatalystEventType,
    months: CalendarMonthRange[],
    startDate: string,
    endDate: string,
    scheduler: QueryTaskScheduler,
  ): Promise<FamilyExecution> {
    const requests: HistoricalPlannedRequest[] = [];
    for (const monthRange of months) {
      if (eventType === "material_information") {
        requests.push({
          market: null,
          monthRange,
          run: () => this.loadMaterialUnit(companyCode, monthRange),
        });
        continue;
      }
      const markets: CompanyMarket[] = ["listed", "otc"];
      for (const market of markets) {
        requests.push({
          market,
          monthRange,
          run: () =>
            this.loadConferenceUnit(
              companyCode,
              market,
              monthRange,
              startDate,
              endDate,
            ),
        });
      }
    }
    const settled = await Promise.all(
      requests.map(async (request) => {
        try {
          return { unit: await scheduler.run(request.run), failure: null };
        } catch (error) {
          return {
            unit: null,
            failure: failureFrom(
              error,
              companyCode,
              eventType,
              request.monthRange.month,
              request.market,
            ),
          };
        }
      }),
    );
    const units = settled
      .map((result) => result.unit)
      .filter((unit): unit is HistoricalUnitResult => unit !== null);
    const failures = settled
      .map((result) => result.failure)
      .filter((failure): failure is CatalystSourceFailure => failure !== null);
    const unique = uniqueEvents(units.flatMap((unit) => unit.events));
    const completedRequestCount = units.length;
    const status: CatalystFamilyCoverage["status"] =
      failures.length === 0
        ? "complete"
        : completedRequestCount === 0
          ? "failed"
          : "partial";
    const snapshotIdentity = stableDigest({
      companyCode,
      eventType,
      queryStart: startDate,
      queryEnd: endDate,
      units: units.map((unit) => ({
        market: unit.market,
        queryMonth: unit.queryMonth,
        status: unit.snapshotStatus,
        snapshotIdentity: unit.snapshotIdentity,
      })),
      failureIds: failures.map((failure) => failure.failureId),
    });
    return {
      units,
      events: unique.events,
      coverage: {
        companyCode,
        eventType,
        status,
        queryStart: startDate,
        queryEnd: endDate,
        requestCount: requests.length,
        completedRequestCount,
        verifiedEmptyRequestCount: units.filter(
          (unit) => unit.snapshotStatus === "verified_empty",
        ).length,
        nonemptyRequestCount: units.filter(
          (unit) => unit.snapshotStatus === "nonempty",
        ).length,
        eventCount: unique.events.length,
        snapshotIdentity,
        failures,
      },
    };
  }

  private async loadMaterialUnit(
    companyCode: string,
    monthRange: CalendarMonthRange,
  ): Promise<HistoricalUnitResult> {
    const snapshot = await this.htmlLoader.post(
      "歷史重大訊息",
      MATERIAL_HISTORY_URL,
      {
        step: "1",
        firstin: "1",
        off: "1",
        TYPEK: "all",
        co_id: companyCode,
        year: String(monthRange.year - 1911),
        month: String(monthRange.monthNumber),
        b_date: String(monthRange.startDay),
        e_date: String(monthRange.endDay),
      },
    );
    return parseMaterialHistory(snapshot, companyCode, monthRange);
  }

  private async loadConferenceUnit(
    companyCode: string,
    market: CompanyMarket,
    monthRange: CalendarMonthRange,
    startDate: string,
    endDate: string,
  ): Promise<HistoricalUnitResult> {
    const snapshot = await this.htmlLoader.post(
      "歷史法人說明會",
      CONFERENCE_HISTORY_URL,
      {
        step: "1",
        firstin: "ture",
        off: "1",
        TYPEK: market === "listed" ? "sii" : "otc",
        co_id: companyCode,
        year: String(monthRange.year - 1911),
        month: String(monthRange.monthNumber).padStart(2, "0"),
      },
    );
    return parseConferenceHistory(
      snapshot,
      companyCode,
      market,
      monthRange,
      startDate,
      endDate,
    );
  }

  private async executeCurrent(
    validated: ReturnType<typeof validateHistoricalQuery>,
    startDate: string,
    endDate: string,
  ): Promise<CurrentExecution> {
    if (
      !validated.eventTypes.includes("material_information") ||
      validated.workBudget.currentSnapshotRequests === 0
    ) {
      return {
        events: [],
        sources: [],
        coverage: [],
        failures: [],
      };
    }
    const markets = new Set<CompanyMarket>();
    if (validated.marketHints.size === validated.companyCodes.length) {
      for (const market of validated.marketHints.values()) markets.add(market);
    } else {
      markets.add("listed");
      markets.add("otc");
    }
    const currentQueryMonth = taipeiToday(this.now()).slice(0, 7);
    const results = await Promise.all(
      [...markets].map(async (market) => {
        const affectedCodes = validated.companyCodes.filter((code) => {
          const hint = validated.marketHints.get(code);
          return hint === undefined || hint === market;
        });
        try {
          const result = await this.getCurrentMaterialInformation({
            market,
            companyCodes: affectedCodes,
          });
          const events = result.events.filter((event) => {
            const date = event.publishedAt?.slice(0, 10);
            return date !== undefined && date >= startDate && date <= endDate;
          });
          const source = result.sources[0];
          if (!source || result.sources.length !== 1) {
            fail("UPSTREAM_BAD_RESPONSE", "current 重大訊息市場查詢未形成唯一來源。", {
              market,
              sourceCount: result.sources.length,
            });
          }
          const applicable =
            events.length > 0 ||
            (source.reportDate !== null &&
              source.reportDate >= startDate &&
              source.reportDate <= endDate);
          const sources: CatalystResultSource[] = applicable
            ? [{
              eventType: "material_information",
              market: source.market,
              exchange: source.exchange,
              sourceKey: source.sourceKey,
              sourceName: source.sourceName,
              sourceUrl: source.sourceUrl,
              retrievedAt: source.retrievedAt,
              ...(source.cache ? { cache: source.cache } : {}),
              scope: "current_official_snapshot",
              queryStart: startDate,
              queryEnd: endDate,
              sourceReportDate: source.reportDate,
              rawRowCount: source.rawRowCount,
              acceptedEventCount: events.length,
              snapshotIdentity: source.snapshotIdentity,
            }]
            : [];
          const coverage: CatalystCurrentSnapshotCoverage = {
            sourceKey: source.sourceKey,
            eventType: "material_information",
            market,
            status: applicable ? "complete" : "not_applicable",
            affectedCompanyCodes: affectedCodes,
            sourceReportDate: source.reportDate,
            eventCount: events.length,
            snapshotIdentity: stableDigest({
              sourceSnapshot: source.snapshotIdentity,
              affectedCompanyCodes: affectedCodes,
              applicable,
              eventIds: events.map((event) => event.eventId),
            }),
            failures: [],
          };
          return {
            events,
            sources,
            coverage: [coverage],
            failures: [] as CatalystSourceFailure[],
          };
        } catch (error) {
          const failures = affectedCodes.map((code) =>
            failureFrom(
              error,
              code,
              "material_information",
              currentQueryMonth,
              market,
            ),
          );
          const config = CURRENT_SOURCE_CONFIGS[market];
          return {
            events: [] as CatalystEvent[],
            sources: [] as CatalystResultSource[],
            coverage: [
              {
                sourceKey: config.sourceKey,
                eventType: "material_information" as const,
                market,
                status: "failed" as const,
                affectedCompanyCodes: affectedCodes,
                sourceReportDate: null,
                eventCount: 0,
                snapshotIdentity: stableDigest({
                  sourceKey: config.sourceKey,
                  affectedCompanyCodes: affectedCodes,
                  failureIds: failures.map((failure) => failure.failureId),
                }),
                failures,
              },
            ],
            failures,
          };
        }
      }),
    );
    const failures = results.flatMap((result) => result.failures);
    return {
      events: results.flatMap((result) => result.events),
      sources: results.flatMap((result) => result.sources),
      coverage: results.flatMap((result) => result.coverage),
      failures,
    };
  }

  private combinedFamilyStatus(
    companyCode: string,
    eventType: CatalystEventType,
    historicalCoverage: CatalystFamilyCoverage[],
    currentCoverage: CatalystCurrentSnapshotCoverage[],
  ): CatalystCompanyResult["status"] {
    const historical = historicalCoverage.find(
      (row) =>
        row.companyCode === companyCode && row.eventType === eventType,
    );
    if (!historical) {
      throw new Error(`Missing catalyst family coverage for ${companyCode}/${eventType}`);
    }
    const statuses: Array<"complete" | "failed" | "partial"> = [
      historical.status,
    ];
    if (eventType === "material_information") {
      statuses.push(
        ...currentCoverage
          .filter(
            (row) =>
              row.status !== "not_applicable" &&
              row.affectedCompanyCodes.includes(companyCode),
          )
          .map((row) => (row.status === "complete" ? "complete" : "failed")),
      );
    }
    return statuses.every((status) => status === "complete")
      ? "complete"
      : statuses.every((status) => status === "failed")
        ? "failed"
        : "partial";
  }

  private companyResults(
    companyCodes: string[],
    eventTypes: CatalystEventType[],
    historicalCoverage: CatalystFamilyCoverage[],
    currentCoverage: CatalystCurrentSnapshotCoverage[],
    events: CatalystEvent[],
  ): CatalystCompanyResult[] {
    return companyCodes.map((companyCode) => {
      const statuses = eventTypes.map((eventType) =>
        this.combinedFamilyStatus(
          companyCode,
          eventType,
          historicalCoverage,
          currentCoverage,
        ),
      );
      const failures = [
        ...historicalCoverage
          .filter(
            (row) =>
              row.companyCode === companyCode &&
              eventTypes.includes(row.eventType),
          )
          .flatMap((row) => row.failures),
        ...currentCoverage
          .filter((row) => row.affectedCompanyCodes.includes(companyCode))
          .flatMap((row) => row.failures),
      ].sort((left, right) => left.failureId.localeCompare(right.failureId));
      const status: CatalystCompanyResult["status"] = statuses.every(
        (value) => value === "complete",
      )
        ? "complete"
        : statuses.every((value) => value === "failed")
          ? "failed"
          : "partial";
      return {
        companyCode,
        status,
        eventCount: events.filter((event) => event.companyCode === companyCode)
          .length,
        failures,
      };
    });
  }

  private aggregateCoverage(
    eventTypes: CatalystEventType[],
    companyCodes: string[],
    historicalCoverage: CatalystFamilyCoverage[],
    currentCoverage: CatalystCurrentSnapshotCoverage[],
    startDate: string,
    endDate: string,
  ): CatalystAggregateFamilyCoverage[] {
    return eventTypes.map((eventType) => {
      const companyStatuses = companyCodes.map((companyCode) => ({
        companyCode,
        status: this.combinedFamilyStatus(
          companyCode,
          eventType,
          historicalCoverage,
          currentCoverage,
        ),
      }));
      const status: CatalystAggregateFamilyCoverage["status"] = companyStatuses.every(
        (row) => row.status === "complete",
      )
        ? "complete"
        : companyStatuses.every((row) => row.status === "failed")
          ? "failed"
          : "partial";
      return {
        eventType,
        scope:
          eventType === "material_information"
            ? "current_and_selected_company_history"
            : "selected_company_history",
        status,
        requestedStart: startDate,
        requestedEnd: endDate,
        failedCompanyCodes: [
          ...new Set(
            companyStatuses
              .filter((row) => row.status !== "complete")
              .map((row) => row.companyCode),
          ),
        ].sort(),
      };
    });
  }
}

export const catalystClient = new CatalystClient();
