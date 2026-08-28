import { load } from "cheerio";

import type {
  CompanyMarket,
  CompanyMarketSelection,
} from "@/lib/company-master/types";
import {
  normalizeCompactDate,
  OfficialJsonLoader,
  type JsonSnapshot,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import type { OfficialMarketClientOptions } from "@/lib/market-data/types";
import { MopsfinError } from "@/lib/mopsfin/errors";
import { BenchmarkClient } from "@/lib/reaction/benchmark-client";
import type { BenchmarkHistory } from "@/lib/reaction/types";
import type { CacheProvenance } from "@/lib/upstream/cache-provenance";

import { OfficialJsonPostLoader } from "./official-json-post-loader";
import type {
  CompletedSessionMarketResolution,
  CompletedSessionResolverEvidence,
  CompletedSessionResolverReasonCode,
  CompletedSessionResolverSource,
  SourceCacheObservation,
} from "./types";

const TWSE_CALENDAR_URL =
  "https://www.twse.com.tw/holidaySchedule/holidaySchedule";
const TPEX_CALENDAR_URL =
  "https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate";
export const COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI = "13:33:00" as const;
export const COMPLETED_SESSION_RESOLVER_ID =
  "taiwan-equity.completed-session.v1" as const;

const OPEN_SEMANTICS =
  /(開始交易|最後交易|補行(?:開市)?交易)/;
const CLOSED_SEMANTICS = /(市場無交易|休市|放假|補假|停止交易)/;
const TPEX_BOND_ONLY = /債券/;
const MONTH_DAY = /(\d{1,2})月(\d{1,2})日/g;
const MONTH_DAY_RANGE =
  /(\d{1,2})月(\d{1,2})日\s*至\s*(?:(\d{1,2})月)?(\d{1,2})日/g;

type CalendarRule = "open" | "closed";

export interface OfficialTradingCalendarSource {
  market: CompanyMarket;
  exchange: "TWSE" | "TPEx";
  sourceName: string;
  sourceUrl: string;
  retrievedAt: string;
  cache?: CacheProvenance;
  calendarYear: number;
  rowCount: number;
}

export interface OfficialTradingCalendar {
  market: CompanyMarket;
  year: number;
  rules: ReadonlyMap<string, CalendarRule>;
  source: OfficialTradingCalendarSource;
}

interface TradingCalendarLike {
  getCalendar(
    market: CompanyMarket,
    year: number,
  ): Promise<OfficialTradingCalendar>;
}

interface BenchmarkLike {
  getHistory(
    market: CompanyMarket,
    months: string[],
  ): Promise<BenchmarkHistory>;
}

export interface CompletedSessionResolverOptions
  extends OfficialMarketClientOptions {
  deadlineMs?: number;
  maxResponseBytes?: number;
  maxJsonArrayLength?: number;
  maxJsonNodes?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
  calendarClient?: TradingCalendarLike;
  benchmarkClient?: BenchmarkLike;
}

export interface ResolveCompletedSessionInput {
  market: CompanyMarketSelection;
  evaluatedAt?: Date | string;
}

function calendarFailure(
  reason:
    | "CALENDAR_CONTRACT_MISMATCH"
    | "CALENDAR_YEAR_IDENTITY_MISMATCH",
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason,
    retryable: false,
    action: "none",
    details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoDate(year: number, month: number, day: number): string {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "官方交易日曆包含無效日期。", {
      year,
      month,
      day,
    });
  }
  return candidate.toISOString().slice(0, 10);
}

function markRule(
  rules: Map<string, CalendarRule>,
  date: string,
  rule: CalendarRule,
  market: CompanyMarket,
): void {
  const existing = rules.get(date);
  if (existing && existing !== rule) {
    calendarFailure(
      "CALENDAR_CONTRACT_MISMATCH",
      `${market} 官方交易日曆同日同時宣告開市與休市。`,
      { market, date, existing, incoming: rule },
    );
  }
  rules.set(date, rule);
}

function rowDateRule(name: string, description: string): CalendarRule | null {
  // The date column belongs to the row name. A description can mention a
  // different make-up session, so it must never turn the row date into open.
  const nameOpen = OPEN_SEMANTICS.test(name);
  const nameClosed = CLOSED_SEMANTICS.test(name);
  if (nameOpen && nameClosed) return null;
  if (nameOpen) return "open";
  if (nameClosed || CLOSED_SEMANTICS.test(description)) return "closed";
  return null;
}

function datedDescriptionRules(
  description: string,
  year: number,
): Array<{ date: string; rule: CalendarRule }> {
  const rules: Array<{ date: string; rule: CalendarRule }> = [];
  // Keep date lists joined by `、` / `及`, but split independent semantic
  // clauses such as "4月6日調整放假，4月14日補行開市交易".
  for (const clause of description.split(/[。；;，,+＋\n]/)) {
    const dates = monthDays(clause, year);
    if (dates.length === 0) continue;
    const open = OPEN_SEMANTICS.test(clause);
    const closed = CLOSED_SEMANTICS.test(clause);
    if (open && closed) {
      calendarFailure(
        "CALENDAR_CONTRACT_MISMATCH",
        "官方交易日曆同一日期說明同時包含開市與休市語意。",
        { year, clause },
      );
    }
    if (!open && !closed) continue;
    for (const date of dates) {
      rules.push({ date, rule: open ? "open" : "closed" });
    }
  }
  return rules;
}

function sourceCache(cache: CacheProvenance | undefined): SourceCacheObservation {
  return cache ?? {
    status: "unknown",
    observedAt: null,
    storedAt: null,
    ageMs: null,
    ttlMs: null,
  };
}

function assertCalendarYear(year: number): void {
  if (!Number.isSafeInteger(year) || year < 2006 || year > 9999) {
    throw new TypeError("calendar year 必須是 2006 之後的西元年。");
  }
}

export function normalizeTwseTradingCalendar(
  snapshot: JsonSnapshot,
  requestedYear: number,
  sourceUrl: string,
): OfficialTradingCalendar {
  if (!isRecord(snapshot.payload)) {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TWSE 開休市回應不是物件。", {
      sourceUrl,
    });
  }
  const payload = snapshot.payload;
  const queryYear = Number(payload.queryYear);
  if (queryYear !== requestedYear) {
    calendarFailure(
      "CALENDAR_YEAR_IDENTITY_MISMATCH",
      "TWSE 開休市回應年度與 requested year 不符。",
      { requestedYear, queryYear, sourceUrl },
    );
  }
  if (String(payload.stat ?? "").toLowerCase() !== "ok") {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TWSE 開休市回應狀態錯誤。", {
      stat: payload.stat,
      requestedYear,
      sourceUrl,
    });
  }
  const identityDate = String(payload.date ?? "").trim();
  if (identityDate !== `${requestedYear}0101`) {
    calendarFailure(
      "CALENDAR_YEAR_IDENTITY_MISMATCH",
      "TWSE 開休市 snapshot identity 與 requested year 不符。",
      { requestedYear, identityDate, sourceUrl },
    );
  }
  const fields = Array.isArray(payload.fields) ? payload.fields.map(String) : [];
  if (!["日期", "名稱", "說明"].every((field) => fields.includes(field))) {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TWSE 開休市缺少必要欄位。", {
      fields,
      sourceUrl,
    });
  }
  const dateIndex = fields.indexOf("日期");
  const nameIndex = fields.indexOf("名稱");
  const descriptionIndex = fields.indexOf("說明");
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const declared = Number(payload.total);
  if (!Number.isSafeInteger(declared) || declared !== rows.length || rows.length === 0) {
    calendarFailure(
      "CALENDAR_CONTRACT_MISMATCH",
      "TWSE 開休市宣告筆數與資料列不符。",
      { declared: payload.total, actual: rows.length, sourceUrl },
    );
  }

  const rules = new Map<string, CalendarRule>();
  for (const raw of rows) {
    if (!Array.isArray(raw)) {
      calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TWSE 開休市資料列格式錯誤。", {
        sourceUrl,
      });
    }
    const date = String(raw[dateIndex] ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${requestedYear}-`)) {
      calendarFailure(
        "CALENDAR_YEAR_IDENTITY_MISMATCH",
        "TWSE 開休市資料列日期與 requested year 不符。",
        { requestedYear, date, sourceUrl },
      );
    }
    const normalized = normalizeCompactDate(date.replaceAll("-", ""), "calendar_date");
    const name = String(raw[nameIndex] ?? "").replace(/\s+/g, " ").trim();
    const description = String(raw[descriptionIndex] ?? "")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const rule = rowDateRule(name, description);
    if (!rule) {
      calendarFailure(
        "CALENDAR_CONTRACT_MISMATCH",
        "TWSE 開休市資料列缺少唯一可辨識的開市／休市語意。",
        { date, name, description, sourceUrl },
      );
    }
    markRule(rules, normalized, rule, "listed");
    for (const described of datedDescriptionRules(description, requestedYear)) {
      markRule(rules, described.date, described.rule, "listed");
    }
  }
  return {
    market: "listed",
    year: requestedYear,
    rules,
    source: {
      market: "listed",
      exchange: "TWSE",
      sourceName: "臺灣證券交易所－有價證券集中交易市場開休市日期",
      sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      calendarYear: requestedYear,
      rowCount: rows.length,
    },
  };
}

function monthDays(text: string, year: number): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(MONTH_DAY_RANGE)) {
    const start = isoDate(year, Number(match[1]), Number(match[2]));
    const end = isoDate(
      year,
      Number(match[3] ?? match[1]),
      Number(match[4]),
    );
    if (end < start) {
      calendarFailure(
        "CALENDAR_CONTRACT_MISMATCH",
        "官方交易日曆日期範圍終點早於起點。",
        { year, range: match[0] },
      );
    }
    let cursor = start;
    let count = 0;
    while (cursor <= end && count <= 366) {
      values.add(cursor);
      cursor = new Date(
        Date.parse(`${cursor}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
      )
        .toISOString()
        .slice(0, 10);
      count += 1;
    }
    if (count > 366) {
      calendarFailure(
        "CALENDAR_CONTRACT_MISMATCH",
        "官方交易日曆日期範圍超出單一年度安全上限。",
        { year, range: match[0] },
      );
    }
  }
  for (const match of text.matchAll(MONTH_DAY)) {
    values.add(isoDate(year, Number(match[1]), Number(match[2])));
  }
  return [...values];
}

interface ExpandedHtmlRow {
  values: string[];
  header: boolean;
}

function expandedRows(html: string): ExpandedHtmlRow[] {
  const $ = load(html);
  const table = $("table")
    .toArray()
    .find((candidate) => {
      const headers = $(candidate).find("th").text();
      return headers.includes("紀念節日名稱") && headers.includes("日期");
    });
  if (!table) {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TPEx 開休市 HTML 缺少目標表格。");
  }
  const spans = new Map<number, { value: string; remaining: number }>();
  const rows: ExpandedHtmlRow[] = [];
  for (const row of $(table).find("tr").toArray()) {
    const values: string[] = [];
    for (const [column, span] of [...spans.entries()]) {
      values[column] = span.value;
      span.remaining -= 1;
      if (span.remaining <= 0) spans.delete(column);
    }
    const cells = $(row).children("th,td").toArray();
    let column = 0;
    for (const cell of cells) {
      while (values[column] !== undefined) column += 1;
      const value = $(cell).text().replace(/\s+/g, " ").trim();
      const rowSpan = Number($(cell).attr("rowspan") ?? "1");
      const colSpan = Number($(cell).attr("colspan") ?? "1");
      if (
        !Number.isSafeInteger(rowSpan) ||
        rowSpan < 1 ||
        !Number.isSafeInteger(colSpan) ||
        colSpan < 1 ||
        rowSpan > 50 ||
        colSpan > 10
      ) {
        calendarFailure(
          "CALENDAR_CONTRACT_MISMATCH",
          "TPEx 開休市 HTML rowspan／colspan 超出安全契約。",
        );
      }
      for (let offset = 0; offset < colSpan; offset += 1) {
        values[column + offset] = value;
        if (rowSpan > 1) {
          spans.set(column + offset, { value, remaining: rowSpan - 1 });
        }
      }
      column += colSpan;
    }
    rows.push({
      values,
      header: $(row).children("th").length > 0,
    });
  }
  return rows;
}

export function normalizeTpexTradingCalendar(
  snapshot: { payload: unknown; retrievedAt: string; cache?: CacheProvenance },
  requestedYear: number,
  sourceUrl: string,
): OfficialTradingCalendar {
  if (!isRecord(snapshot.payload)) {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TPEx 開休市回應不是物件。", {
      sourceUrl,
    });
  }
  const payload = snapshot.payload;
  if (String(payload.stat ?? "").toLowerCase() !== "ok") {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TPEx 開休市回應狀態錯誤。", {
      stat: payload.stat,
      requestedYear,
      sourceUrl,
    });
  }
  if (String(payload.endDate ?? "").trim() !== `${requestedYear}0101`) {
    calendarFailure(
      "CALENDAR_YEAR_IDENTITY_MISMATCH",
      "TPEx 開休市 endDate 與 requested year 不符。",
      { requestedYear, endDate: payload.endDate, sourceUrl },
    );
  }
  const data = isRecord(payload.data) ? payload.data : null;
  const html = typeof data?.html === "string" ? data.html : "";
  const rocYear = requestedYear - 1911;
  if (!html || !html.includes(`中華民國${rocYear}年`) || !html.includes("開（休）市日期表")) {
    calendarFailure(
      "CALENDAR_YEAR_IDENTITY_MISMATCH",
      "TPEx 開休市 HTML title 無法核對 requested year。",
      { requestedYear, sourceUrl },
    );
  }

  const rules = new Map<string, CalendarRule>();
  let classifiedRows = 0;
  for (const row of expandedRows(html)) {
    if (row.header) continue;
    const [name = "", dateText = "", , description = ""] = row.values;
    if (!name && !dateText && !description) continue;
    if (TPEX_BOND_ONLY.test(name) && !name.includes("股票")) continue;
    const rowDates = monthDays(dateText, requestedYear);
    const rule = rowDateRule(name, description);
    if (rowDates.length > 0 && !rule) {
      calendarFailure(
        "CALENDAR_CONTRACT_MISMATCH",
        "TPEx 股票開休市資料列缺少可辨識語意。",
        { name, description, dateText, sourceUrl },
      );
    }
    if (rule && rowDates.length === 0) {
      calendarFailure(
        "CALENDAR_CONTRACT_MISMATCH",
        "TPEx 股票開休市資料列缺少日期。",
        { name, description, sourceUrl },
      );
    }
    if (rule) {
      for (const date of rowDates) markRule(rules, date, rule, "otc");
      classifiedRows += 1;
    }
    const describedRules = datedDescriptionRules(description, requestedYear);
    for (const described of describedRules) {
      markRule(rules, described.date, described.rule, "otc");
    }
    if (describedRules.length > 0) classifiedRows += 1;
  }
  if (rules.size === 0 || classifiedRows === 0) {
    calendarFailure("CALENDAR_CONTRACT_MISMATCH", "TPEx 開休市無法形成股票日曆規則。", {
      requestedYear,
      sourceUrl,
    });
  }
  return {
    market: "otc",
    year: requestedYear,
    rules,
    source: {
      market: "otc",
      exchange: "TPEx",
      sourceName: "證券櫃檯買賣中心－有價證券櫃檯買賣市場開休市日期",
      sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      calendarYear: requestedYear,
      rowCount: classifiedRows,
    },
  };
}

export class OfficialTradingCalendarClient implements TradingCalendarLike {
  private readonly getLoader: OfficialJsonLoader;
  private readonly postLoader: OfficialJsonPostLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    now: () => Date = () => new Date(),
    options: CompletedSessionResolverOptions = {},
  ) {
    this.getLoader = new OfficialJsonLoader(fetchImpl, now, options);
    this.postLoader = new OfficialJsonPostLoader(fetchImpl, now, options);
  }

  async getCalendar(
    market: CompanyMarket,
    year: number,
  ): Promise<OfficialTradingCalendar> {
    assertCalendarYear(year);
    if (market === "listed") {
      const url = new URL(TWSE_CALENDAR_URL);
      url.search = new URLSearchParams({
        queryYear: String(year - 1911),
        response: "json",
      }).toString();
      const config: OfficialSourceConfig = {
        market,
        exchange: "TWSE",
        sourceName: "有價證券集中交易市場開休市日期",
        sourceUrl: url.toString(),
      };
      const snapshot = await this.getLoader.get(config);
      return normalizeTwseTradingCalendar(snapshot, year, url.toString());
    }
    const snapshot = await this.postLoader.post({
      sourceName: "TPEx 有價證券櫃檯買賣市場開休市日期",
      sourceUrl: TPEX_CALENDAR_URL,
      fields: { date: String(year), response: "json" },
      allowedOrigin: "https://www.tpex.org.tw",
      allowedPath: "/www/zh-tw/bulletin/tradingDate",
    });
    return normalizeTpexTradingCalendar(snapshot, year, TPEX_CALENDAR_URL);
  }
}

interface TaipeiParts {
  date: string;
  time: string;
  year: number;
}

function taipeiParts(value: Date): TaipeiParts {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("evaluatedAt 必須是有效時間。");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new TypeError("evaluatedAt 無法轉為 Asia/Taipei 時間。");
  }
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    year: Number(year),
  };
}

function subtractDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function isScheduledOpen(date: string, calendar: OfficialTradingCalendar): boolean {
  const explicit = calendar.rules.get(date);
  if (explicit) return explicit === "open";
  const day = weekday(date);
  return day >= 1 && day <= 5;
}

function candidateWithinYear(
  parts: TaipeiParts,
  calendar: OfficialTradingCalendar,
): { candidate: string | null; boundary: string } {
  const firstPossible =
    parts.time >= COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI
      ? parts.date
      : subtractDay(parts.date);
  const yearStart = `${parts.year}-01-01`;
  for (let date = firstPossible; date >= yearStart; date = subtractDay(date)) {
    if (isScheduledOpen(date, calendar)) {
      return { candidate: date, boundary: firstPossible };
    }
  }
  return { candidate: null, boundary: subtractDay(yearStart) };
}

function calendarSourceEvidence(
  calendar: OfficialTradingCalendar,
): CompletedSessionResolverSource {
  return {
    role: "calendar",
    market: calendar.market,
    exchange: calendar.source.exchange,
    sourceName: calendar.source.sourceName,
    sourceUrl: calendar.source.sourceUrl,
    retrievedAt: calendar.source.retrievedAt,
    cache: sourceCache(calendar.source.cache),
    asOf: String(calendar.year),
    asOfGranularity: "year",
  };
}

function benchmarkSourceEvidence(
  market: CompanyMarket,
  history: BenchmarkHistory,
): CompletedSessionResolverSource[] {
  return history.sources.map((source) => ({
    role: "session_marker" as const,
    market,
    exchange: source.exchange,
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    retrievedAt: source.retrievedAt,
    cache: sourceCache(source.cache),
    asOf: source.dataMonth,
    asOfGranularity: "month" as const,
  }));
}

function unavailableReason(error: unknown): {
  reasonCode: Exclude<
    CompletedSessionResolverReasonCode,
    "COMPLETED_SESSION_RESOLVED" | "CROSS_MARKET_EXPECTED_AS_OF_MISMATCH"
  >;
  reason: string;
} {
  if (error instanceof MopsfinError) {
    if (error.reason === "CALENDAR_YEAR_IDENTITY_MISMATCH") {
      return {
        reasonCode: "CALENDAR_YEAR_IDENTITY_MISMATCH",
        reason: "官方交易日曆回傳年度與 requested year 不符。",
      };
    }
    if (error.reason === "CALENDAR_CONTRACT_MISMATCH") {
      return {
        reasonCode: "CALENDAR_CONTRACT_MISMATCH",
        reason: "官方交易日曆 schema 或語意契約無法安全解析。",
      };
    }
  }
  return {
    reasonCode: "CALENDAR_SOURCE_UNAVAILABLE",
    reason: "官方交易日曆來源暫時無法取得。",
  };
}

const WORK_UNIT =
  "one logical load of one official market source; transport retries do not add units" as const;

function marketWorkBudget(sessionMarkerLogicalLoads: 0 | 1) {
  return {
    unitDefinition: WORK_UNIT,
    calendarLogicalLoads: 1,
    sessionMarkerLogicalLoads,
    actualTotal: 1 + sessionMarkerLogicalLoads,
    maximumTotal: 2 as const,
  };
}

function resolverWorkBudget(
  marketResolutions: readonly CompletedSessionMarketResolution[],
) {
  const calendarLogicalLoads = marketResolutions.reduce(
    (total, resolution) => total + resolution.workBudget.calendarLogicalLoads,
    0,
  );
  const sessionMarkerLogicalLoads = marketResolutions.reduce(
    (total, resolution) =>
      total + resolution.workBudget.sessionMarkerLogicalLoads,
    0,
  );
  return {
    scope: "freshness_meta_layer" as const,
    unitDefinition: WORK_UNIT,
    marketCount: marketResolutions.length,
    calendarLogicalLoads,
    sessionMarkerLogicalLoads,
    actualTotal: calendarLogicalLoads + sessionMarkerLogicalLoads,
    maximumTotal: marketResolutions.length * 2,
  };
}

export class CompletedSessionResolver {
  private readonly calendarClient: TradingCalendarLike;
  private readonly benchmarkClient: BenchmarkLike;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    options: CompletedSessionResolverOptions = {},
  ) {
    this.calendarClient =
      options.calendarClient ??
      new OfficialTradingCalendarClient(fetchImpl, now, options);
    this.benchmarkClient =
      options.benchmarkClient ?? new BenchmarkClient(fetchImpl, now, options);
  }

  async resolve(
    input: ResolveCompletedSessionInput,
  ): Promise<CompletedSessionResolverEvidence> {
    const evaluated =
      input.evaluatedAt instanceof Date
        ? input.evaluatedAt
        : typeof input.evaluatedAt === "string"
          ? new Date(input.evaluatedAt)
          : this.now();
    const evaluatedAt = evaluated.toISOString();
    const markets: CompanyMarket[] =
      input.market === "all" ? ["listed", "otc"] : [input.market];
    const marketResolutions = await Promise.all(
      markets.map((market) => this.resolveMarket(market, evaluated)),
    );
    const workBudget = resolverWorkBudget(marketResolutions);
    const resolved = marketResolutions.every(
      (resolution) => resolution.status === "resolved",
    );
    const expectedDates = [
      ...new Set(
        marketResolutions.flatMap((resolution) =>
          resolution.expectedAsOf ? [resolution.expectedAsOf] : [],
        ),
      ),
    ];
    if (resolved && expectedDates.length === 1) {
      return {
        resolverId: COMPLETED_SESSION_RESOLVER_ID,
        status: "resolved",
        evaluatedAt,
        timezone: "Asia/Taipei",
        completionGuardTaipei: COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
        markets,
        expectedAsOf: expectedDates[0],
        reasonCode: "COMPLETED_SESSION_RESOLVED",
        reason:
          "各市場 scheduled calendar candidate 已由該市場官方 exact benchmark session 確認。",
        marketResolutions,
        workBudget,
      };
    }
    if (resolved && expectedDates.length !== 1) {
      return {
        resolverId: COMPLETED_SESSION_RESOLVER_ID,
        status: "unresolved",
        evaluatedAt,
        timezone: "Asia/Taipei",
        completionGuardTaipei: COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
        markets,
        expectedAsOf: null,
        reasonCode: "CROSS_MARKET_EXPECTED_AS_OF_MISMATCH",
        reason: "TWSE 與 TPEx 的 authoritative completed-session 日期不一致。",
        marketResolutions,
        workBudget,
      };
    }
    const firstFailure = marketResolutions.find(
      (resolution) => resolution.status === "unresolved",
    );
    return {
      resolverId: COMPLETED_SESSION_RESOLVER_ID,
      status: "unresolved",
      evaluatedAt,
      timezone: "Asia/Taipei",
      completionGuardTaipei: COMPLETED_SESSION_COMPLETION_GUARD_TAIPEI,
      markets,
      expectedAsOf: null,
      reasonCode: firstFailure?.reasonCode ?? "SCHEDULED_SESSION_UNRESOLVED",
      reason:
        firstFailure?.reason ?? "至少一個市場無法安全解析 authoritative completed session。",
      marketResolutions,
      workBudget,
    };
  }

  private async resolveMarket(
    market: CompanyMarket,
    evaluatedAt: Date,
  ): Promise<CompletedSessionMarketResolution> {
    const parts = taipeiParts(evaluatedAt);
    let calendar: OfficialTradingCalendar;
    try {
      calendar = await this.calendarClient.getCalendar(market, parts.year);
    } catch (error) {
      const unavailable = unavailableReason(error);
      return {
        market,
        status: "unresolved",
        scheduledCandidate: null,
        expectedAsOf: null,
        ...unavailable,
        sources: [],
        workBudget: marketWorkBudget(0),
      };
    }
    const sources: CompletedSessionResolverSource[] = [
      calendarSourceEvidence(calendar),
    ];
    const scheduled = candidateWithinYear(parts, calendar);
    const markerMonth = (scheduled.candidate ?? scheduled.boundary).slice(0, 7);
    let history: BenchmarkHistory;
    try {
      history = await this.benchmarkClient.getHistory(market, [markerMonth]);
    } catch {
      return {
        market,
        status: "unresolved",
        scheduledCandidate: scheduled.candidate,
        expectedAsOf: null,
        reasonCode: "SESSION_MARKER_UNAVAILABLE",
        reason: "市場官方 exact benchmark session marker 暫時無法取得。",
        sources,
        workBudget: marketWorkBudget(1),
      };
    }
    sources.push(...benchmarkSourceEvidence(market, history));
    const latestMarkerThroughBoundary =
      history.bars
        .filter((bar) => bar.date <= scheduled.boundary)
        .map((bar) => bar.date)
        .sort()
        .at(-1) ?? null;
    const expected = scheduled.candidate
      ? latestMarkerThroughBoundary === scheduled.candidate
        ? scheduled.candidate
        : null
      : latestMarkerThroughBoundary;
    if (!expected) {
      return {
        market,
        status: "unresolved",
        scheduledCandidate: scheduled.candidate,
        expectedAsOf: null,
        reasonCode: "SESSION_MARKER_NOT_CONFIRMED",
        reason:
          "scheduled candidate 未等於 boundary 前最新官方 exact benchmark session；可能是發布尚未完成、日曆漏列臨時／補行 session，或來源漂移。",
        sources,
        workBudget: marketWorkBudget(1),
      };
    }
    return {
      market,
      status: "resolved",
      scheduledCandidate: scheduled.candidate,
      expectedAsOf: expected,
      reasonCode: "COMPLETED_SESSION_RESOLVED",
      reason: scheduled.candidate
        ? "scheduled candidate 已由該市場官方 exact benchmark session 確認。"
        : "跨年度邊界由上一個月份的官方 exact benchmark 解析最近完成 session；scheduled candidate 不跨年度猜測。",
      sources,
      workBudget: marketWorkBudget(1),
    };
  }
}

export const completedSessionResolver = new CompletedSessionResolver();

export function completedSessionResolverSourceUrls(
  evidence: CompletedSessionResolverEvidence,
): string[] {
  return [
    ...new Set(
      evidence.marketResolutions.flatMap((resolution) =>
        resolution.sources.map((source) => source.sourceUrl),
      ),
    ),
  ].sort();
}

export function completedSessionExpectedAsOfForMarket(
  evidence: CompletedSessionResolverEvidence,
  market: CompanyMarket,
): string | null {
  return (
    evidence.marketResolutions.find((resolution) => resolution.market === market)
      ?.expectedAsOf ?? null
  );
}
