import { createHash } from "node:crypto";

import type { CompanyMarket } from "@/lib/company-master/types";
import {
  normalizeCompactDate,
  normalizeOptionalText,
  normalizeRequiredText,
  OfficialJsonLoader,
  parseOfficialNumber,
  type JsonSnapshot,
  type OfficialJsonLoaderOptions,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import { MopsfinError } from "@/lib/mopsfin/errors";

import type {
  CompanyCatalystSnapshotsCompanyResult,
  CompanyCatalystSnapshotsCoverageItem,
  CompanyCatalystSnapshotsDetails,
  CompanyCatalystSnapshotsDisclosureStatus,
  CompanyCatalystSnapshotsFreshness,
  CompanyCatalystSnapshotsIdentityStatus,
  CompanyCatalystSnapshotsMarketHint,
  CompanyCatalystSnapshotsNumberRange,
  CompanyCatalystSnapshotsQuery,
  CompanyCatalystSnapshotsRecord,
  CompanyCatalystSnapshotsResult,
  CompanyCatalystSnapshotsSource,
  CompanyCatalystSnapshotsSourceFailure,
  CompanyCatalystSnapshotsSourceKey,
  CompanyCatalystSnapshotsType,
} from "./snapshot-types";

export interface CompanyCatalystSnapshotsJsonLoader {
  get(config: OfficialSourceConfig): Promise<JsonSnapshot>;
}

export interface CompanyCatalystSnapshotClientOptions
  extends OfficialJsonLoaderOptions {
  jsonLoader?: CompanyCatalystSnapshotsJsonLoader;
}

export type CompanyCatalystSnapshotsAllSourcesFailureMode =
  | "throw"
  | "return_partial";

export interface CompanyCatalystSnapshotsExecutionOptions {
  allSourcesFailureMode?: CompanyCatalystSnapshotsAllSourcesFailureMode;
}

interface SupportedSourceConfig extends OfficialSourceConfig {
  snapshotType: CompanyCatalystSnapshotsType;
  sourceKey: Exclude<
    CompanyCatalystSnapshotsSourceKey,
    "tpex_dividend_decision_current_unsupported"
  >;
  reportDateKey: "出表日期" | "Date";
  companyCodeKey: "公司代號" | "SecuritiesCompanyCode";
  companyNameKey: "公司名稱" | "CompanyName";
  expectedKeys: readonly string[];
}

interface PlannedRoute {
  snapshotType: CompanyCatalystSnapshotsType;
  market: CompanyMarket;
  companyCodes: string[];
  config: SupportedSourceConfig | null;
}

interface ParsedSource {
  records: CompanyCatalystSnapshotsRecord[];
  source: CompanyCatalystSnapshotsSource;
}

interface RouteExecution {
  route: PlannedRoute;
  records: CompanyCatalystSnapshotsRecord[];
  source: CompanyCatalystSnapshotsSource;
  failure: CompanyCatalystSnapshotsSourceFailure | null;
}

interface ValidatedQuery {
  companyCodes: string[];
  snapshotTypes: CompanyCatalystSnapshotsType[];
  companyMarkets: CompanyCatalystSnapshotsMarketHint[];
  marketHints: Map<string, CompanyMarket>;
  asOf: "latest";
  offset: number;
  limit: number;
}

const ALL_SNAPSHOT_TYPES: CompanyCatalystSnapshotsType[] = [
  "forecast_achievement",
  "forecast_material_variance",
  "shareholder_meeting",
  "dividend_decision",
];
const MARKETS: CompanyMarket[] = ["listed", "otc"];
const COMPANY_LIMIT = 20;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const SOURCE_QUERY_LIMIT = 8;
const EXPECTED_FRESHNESS_DAYS = 7;
const MAX_FUTURE_REPORT_DAYS = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

const FORECAST_ACHIEVEMENT_TWSE_KEYS = [
  "出表日期",
  "年度",
  "季別",
  "公司代號",
  "公司名稱",
  "財測序號",
  "涵蓋期間",
  "截至該季經會計師查核或核閱數",
  "截至該季綜合損益預測數",
] as const;
const FORECAST_ACHIEVEMENT_TPEX_KEYS = [
  "Date",
  "Year",
  "季別",
  "SecuritiesCompanyCode",
  "CompanyName",
  "財測序號",
  "涵蓋期間",
  "截至第1季經會計師查核或核閱數",
  "截至第1季稅前損益預測數",
] as const;
const FORECAST_VARIANCE_TWSE_KEYS = [
  "出表日期",
  "年度",
  "季別",
  "公司代號",
  "公司名稱",
  "財測序號",
  "涵蓋期間",
  "當季經會計師查核或核閱數",
  "截至當季經會計師查核或核閱數",
  "當季稅前(綜合)損益預測數",
  "截至當季稅前(綜合)損益預測數",
] as const;
const FORECAST_VARIANCE_TPEX_KEYS = [
  "Date",
  "Year",
  "季別",
  "SecuritiesCompanyCode",
  "CompanyName",
  "財測序號",
  "涵蓋期間",
  "經會計師查核或核閱數第4季",
  "經會計師查核或核閱數截至第4季",
  "稅前綜合損益預測數第4季",
  "稅前綜合損益預測數截至第4季",
] as const;
const SHAREHOLDER_MEETING_KEYS = [
  "出表日期",
  "公司代號",
  "公司名稱",
  "公司地址",
  "股東常(臨時)會",
  "開會日期",
  "開會地點",
  "是否改選董監",
  "聯絡電話",
  "股務單位",
  "股務單位電話",
  "是否採電子投票",
] as const;
const DIVIDEND_DECISION_KEYS = [
  "出表日期",
  "公司代號",
  "公司名稱",
  "決議（擬議）進度",
  "股利年度",
  "股利所屬年(季)度",
  "股利所屬期間",
  "期別",
  "董事會（擬議）股利分派日",
  "股東會日期",
  "期初未分配盈餘/待彌補虧損(元)",
  "本期淨利(淨損)(元)",
  "可分配盈餘(元)",
  "分配後期末未分配盈餘(元)",
  "股東配發-盈餘分配之現金股利(元/股)",
  "股東配發-法定盈餘公積發放之現金(元/股)",
  "股東配發-資本公積發放之現金(元/股)",
  "股東配發-股東配發之現金(股利)總金額(元)",
  "股東配發-盈餘轉增資配股(元/股)",
  "股東配發-法定盈餘公積轉增資配股(元/股)",
  "股東配發-資本公積轉增資配股(元/股)",
  "股東配發-股東配股總股數(股)",
  "摘錄公司章程-股利分派部分",
  "備註",
] as const;

const SOURCE_CONFIGS: Record<
  CompanyCatalystSnapshotsType,
  Partial<Record<CompanyMarket, SupportedSourceConfig>>
> = {
  forecast_achievement: {
    listed: {
      snapshotType: "forecast_achievement",
      market: "listed",
      exchange: "TWSE",
      sourceKey: "twse_forecast_achievement_current",
      sourceName: "臺灣證券交易所－上市公司財務預測達成情形",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap15_L",
      reportDateKey: "出表日期",
      companyCodeKey: "公司代號",
      companyNameKey: "公司名稱",
      expectedKeys: FORECAST_ACHIEVEMENT_TWSE_KEYS,
    },
    otc: {
      snapshotType: "forecast_achievement",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_forecast_achievement_current",
      sourceName: "證券櫃檯買賣中心－上櫃公司財務預測達成情形",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap15_O",
      reportDateKey: "Date",
      companyCodeKey: "SecuritiesCompanyCode",
      companyNameKey: "CompanyName",
      expectedKeys: FORECAST_ACHIEVEMENT_TPEX_KEYS,
    },
  },
  forecast_material_variance: {
    listed: {
      snapshotType: "forecast_material_variance",
      market: "listed",
      exchange: "TWSE",
      sourceKey: "twse_forecast_material_variance_current",
      sourceName: "臺灣證券交易所－上市公司財務預測重大差異名單",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap16_L",
      reportDateKey: "出表日期",
      companyCodeKey: "公司代號",
      companyNameKey: "公司名稱",
      expectedKeys: FORECAST_VARIANCE_TWSE_KEYS,
    },
    otc: {
      snapshotType: "forecast_material_variance",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_forecast_material_variance_current",
      sourceName: "證券櫃檯買賣中心－上櫃公司財務預測重大差異名單",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap16_O",
      reportDateKey: "Date",
      companyCodeKey: "SecuritiesCompanyCode",
      companyNameKey: "CompanyName",
      expectedKeys: FORECAST_VARIANCE_TPEX_KEYS,
    },
  },
  shareholder_meeting: {
    listed: {
      snapshotType: "shareholder_meeting",
      market: "listed",
      exchange: "TWSE",
      sourceKey: "twse_shareholder_meeting_current",
      sourceName: "臺灣證券交易所－上市公司股東會日期",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap41_L",
      reportDateKey: "出表日期",
      companyCodeKey: "公司代號",
      companyNameKey: "公司名稱",
      expectedKeys: SHAREHOLDER_MEETING_KEYS,
    },
    otc: {
      snapshotType: "shareholder_meeting",
      market: "otc",
      exchange: "TPEx",
      sourceKey: "tpex_shareholder_meeting_current",
      sourceName: "證券櫃檯買賣中心－上櫃公司股東會日期",
      sourceUrl: "https://www.tpex.org.tw/openapi/v1/t187ap41_O",
      reportDateKey: "出表日期",
      companyCodeKey: "公司代號",
      companyNameKey: "公司名稱",
      expectedKeys: SHAREHOLDER_MEETING_KEYS,
    },
  },
  dividend_decision: {
    listed: {
      snapshotType: "dividend_decision",
      market: "listed",
      exchange: "TWSE",
      sourceKey: "twse_dividend_decision_current",
      sourceName: "臺灣證券交易所－上市公司股利分派情形",
      sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap45_L",
      reportDateKey: "出表日期",
      companyCodeKey: "公司代號",
      companyNameKey: "公司名稱",
      expectedKeys: DIVIDEND_DECISION_KEYS,
    },
  },
};

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

function badResponse(
  message: string,
  reason: string,
  details: Record<string, unknown> = {},
  retryable = false,
): never {
  throw new MopsfinError("UPSTREAM_BAD_RESPONSE", message, {
    reason,
    retryable,
    action: retryable ? "retry" : "none",
    details,
  });
}

function invalidArgument(
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MopsfinError("INVALID_ARGUMENT", message, {
    reason: "INVALID_ARGUMENT",
    retryable: false,
    action: "fix_input",
    details,
  });
}

function taipeiToday(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function isoDayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function snapshotFreshness(
  reportDate: string,
  today: string,
  config: SupportedSourceConfig,
): {
  freshness: Exclude<CompanyCatalystSnapshotsFreshness, "not_applicable">;
  ageDays: number;
} {
  const ageDays = isoDayNumber(today) - isoDayNumber(reportDate);
  if (ageDays < -MAX_FUTURE_REPORT_DAYS) {
    badResponse(
      `${config.exchange} ${config.sourceName}出表日期晚於 Asia/Taipei 今日。`,
      "UPSTREAM_FUTURE_REPORT_DATE",
      { sourceKey: config.sourceKey, reportDate, today, ageDays },
    );
  }
  return {
    freshness:
      ageDays <= EXPECTED_FRESHNESS_DAYS
        ? "within_expected_window"
        : "stale",
    ageDays,
  };
}

function exactRecord(
  value: unknown,
  config: SupportedSourceConfig,
  rowIndex: number,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badResponse(
      `${config.exchange} ${config.sourceName}第 ${rowIndex + 1} 列不是物件。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, rowIndex },
    );
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  const expected = new Set(config.expectedKeys);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key)) ||
    config.expectedKeys.some((key) => !Object.hasOwn(row, key))
  ) {
    badResponse(
      `${config.exchange} ${config.sourceName}欄位與 exact schema 不符。`,
      "UPSTREAM_SCHEMA_DRIFT",
      {
        sourceKey: config.sourceKey,
        rowIndex,
        expectedKeys: [...config.expectedKeys],
        actualKeys: keys,
      },
    );
  }
  return row;
}

function isRawBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

function isOfficialBlankSentinel(
  row: Record<string, unknown>,
  config: SupportedSourceConfig,
): boolean {
  return config.expectedKeys.every((key) =>
    key === config.reportDateKey ? !isRawBlank(row[key]) : isRawBlank(row[key]),
  );
}

function validateQuery(query: CompanyCatalystSnapshotsQuery): ValidatedQuery {
  if (!query || typeof query !== "object") {
    invalidArgument("query 必須是物件。");
  }
  if (
    !Array.isArray(query.companyCodes) ||
    query.companyCodes.length < 1 ||
    query.companyCodes.length > COMPANY_LIMIT
  ) {
    invalidArgument("companyCodes 必須包含 1 至 20 個四碼公司代號。");
  }
  const companyCodes = query.companyCodes.map((code) => {
    if (typeof code !== "string" || !/^\d{4}$/.test(code.trim())) {
      invalidArgument("companyCodes 只能包含四碼公司代號。", { code });
    }
    return code.trim();
  });
  if (new Set(companyCodes).size !== companyCodes.length) {
    invalidArgument("companyCodes 不得包含重複代號。");
  }

  const requestedTypes = query.snapshotTypes ?? ALL_SNAPSHOT_TYPES;
  if (!Array.isArray(requestedTypes) || requestedTypes.length < 1) {
    invalidArgument("snapshotTypes 至少需要一種 snapshot type。");
  }
  if (
    requestedTypes.some(
      (snapshotType) => !ALL_SNAPSHOT_TYPES.includes(snapshotType),
    )
  ) {
    invalidArgument("snapshotTypes 含不支援的 snapshot type。", {
      snapshotTypes: requestedTypes,
    });
  }
  if (new Set(requestedTypes).size !== requestedTypes.length) {
    invalidArgument("snapshotTypes 不得重複。");
  }
  const requestedTypeSet = new Set(requestedTypes);
  const snapshotTypes = ALL_SNAPSHOT_TYPES.filter((snapshotType) =>
    requestedTypeSet.has(snapshotType),
  );

  if (query.asOf !== undefined && query.asOf !== "latest") {
    invalidArgument("asOf 目前只支援 latest。", { asOf: query.asOf });
  }
  const offset = query.offset ?? 0;
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(offset) || offset < 0) {
    invalidArgument("offset 必須是大於或等於 0 的整數。", { offset });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    invalidArgument("limit 必須是 1 至 100 的整數。", { limit });
  }

  const rawHints = query.companyMarkets ?? [];
  if (!Array.isArray(rawHints) || rawHints.length > companyCodes.length) {
    invalidArgument("companyMarkets 必須是 requested companyCodes 的唯一子集。");
  }
  const requestedCodeSet = new Set(companyCodes);
  const marketHints = new Map<string, CompanyMarket>();
  for (const hint of rawHints) {
    if (!hint || typeof hint !== "object") {
      invalidArgument("companyMarkets 每筆必須是物件。");
    }
    if (typeof hint.companyCode !== "string") {
      invalidArgument("companyMarkets.companyCode 必須是四碼字串。", {
        companyCode: hint.companyCode,
      });
    }
    const companyCode = hint.companyCode.trim();
    if (!companyCode || !requestedCodeSet.has(companyCode)) {
      invalidArgument("companyMarkets 只能包含 requested companyCodes。", {
        companyCode,
      });
    }
    if (hint.market !== "listed" && hint.market !== "otc") {
      invalidArgument("companyMarkets.market 必須是 listed 或 otc。", {
        companyCode,
        market: hint.market,
      });
    }
    if (marketHints.has(companyCode)) {
      invalidArgument("companyMarkets 不得重複公司代號。", { companyCode });
    }
    marketHints.set(companyCode, hint.market);
  }
  const companyMarkets = [...marketHints]
    .map(([companyCode, market]) => ({ companyCode, market }))
    .sort((left, right) => left.companyCode.localeCompare(right.companyCode));

  return {
    companyCodes,
    snapshotTypes,
    companyMarkets,
    marketHints,
    asOf: "latest",
    offset,
    limit,
  };
}

function planRoutes(query: ValidatedQuery): PlannedRoute[] {
  const routes: PlannedRoute[] = [];
  for (const snapshotType of query.snapshotTypes) {
    for (const market of MARKETS) {
      const companyCodes = query.companyCodes.filter((companyCode) => {
        const hint = query.marketHints.get(companyCode);
        return hint === undefined || hint === market;
      });
      if (companyCodes.length === 0) continue;
      routes.push({
        snapshotType,
        market,
        companyCodes,
        config: SOURCE_CONFIGS[snapshotType][market] ?? null,
      });
    }
  }
  if (routes.length > SOURCE_QUERY_LIMIT) {
    invalidArgument("snapshot source route 超過 8 個 logical routes。", {
      plannedSourceRoutes: routes.length,
      sourceQueryLimit: SOURCE_QUERY_LIMIT,
    });
  }
  return routes;
}

function preservedOptionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") {
    badResponse(
      "官方 snapshot 選填文字欄位不是字串。",
      "UPSTREAM_SCHEMA_DRIFT",
      { value },
    );
  }
  return normalizeOptionalText(value);
}

function rocCompactDate(
  raw: unknown,
  field: string,
  config: SupportedSourceConfig,
): string {
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    !/^\d{6,7}$/.test(String(raw).trim())
  ) {
    badResponse(
      `${config.exchange} ${config.sourceName}的 ${field} 不是 ROC compact date。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, field, value: raw },
    );
  }
  try {
    return normalizeCompactDate(raw, field);
  } catch (error) {
    if (error instanceof MopsfinError) {
      badResponse(
        `${config.exchange} ${config.sourceName}的 ${field} 不是有效日期。`,
        "UPSTREAM_SCHEMA_DRIFT",
        { sourceKey: config.sourceKey, field, value: raw },
      );
    }
    throw error;
  }
}

function officialSecurityCode(
  raw: unknown,
  config: SupportedSourceConfig,
): string {
  const code = normalizeRequiredText(raw, config.companyCodeKey, config.market);
  if (!/^[A-Za-z0-9]{1,10}$/.test(code)) {
    badResponse(
      `${config.exchange} ${config.sourceName}證券代號格式錯誤。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, code },
    );
  }
  return code;
}

function fiscalYear(
  raw: unknown,
  config: SupportedSourceConfig,
): { raw: string; year: number } {
  const text = normalizeRequiredText(raw, "年度", config.market);
  if (!/^\d{2,4}$/.test(text)) {
    badResponse(
      `${config.exchange} ${config.sourceName}年度格式錯誤。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, value: raw },
    );
  }
  const numeric = Number(text);
  const year = text.length <= 3 ? numeric + 1911 : numeric;
  if (year < 1911 || year > 9999) {
    badResponse(
      `${config.exchange} ${config.sourceName}年度超出範圍。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, value: raw },
    );
  }
  return { raw: text, year };
}

function fiscalQuarter(
  raw: unknown,
  config: SupportedSourceConfig,
): 1 | 2 | 3 | 4 {
  const text = normalizeRequiredText(raw, "季別", config.market);
  if (!/^[1-4]$/.test(text)) {
    badResponse(
      `${config.exchange} ${config.sourceName}季別格式錯誤。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, value: raw },
    );
  }
  return Number(text) as 1 | 2 | 3 | 4;
}

function requiredOfficialNumber(
  raw: unknown,
  field: string,
  config: SupportedSourceConfig,
): { raw: string; value: number } {
  const text = normalizeRequiredText(raw, field, config.market);
  const parsed = parseOfficialNumber(text);
  if (parsed.invalid || parsed.missing || parsed.value === null) {
    badResponse(
      `${config.exchange} ${config.sourceName}的 ${field} 不是有效數值。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, field, value: raw },
    );
  }
  return { raw: text, value: parsed.value };
}

function optionalOfficialNumber(
  raw: unknown,
  field: string,
  config: SupportedSourceConfig,
): number | null {
  const parsed = parseOfficialNumber(raw);
  if (parsed.invalid) {
    badResponse(
      `${config.exchange} ${config.sourceName}的 ${field} 不是有效數值。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, field, value: raw },
    );
  }
  return parsed.value;
}

function officialNumberRange(
  raw: unknown,
  field: string,
  config: SupportedSourceConfig,
): CompanyCatalystSnapshotsNumberRange {
  const text = normalizeRequiredText(raw, field, config.market);
  const numeric = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const match = new RegExp(`^(${numeric})(?:\\s*[~～]\\s*(${numeric}))?$`).exec(
    text.replace(/,/g, ""),
  );
  if (!match) {
    badResponse(
      `${config.exchange} ${config.sourceName}的 ${field} 不是單值或數值區間。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, field, value: raw },
    );
  }
  const lower = Number(match[1]);
  const upper = Number(match[2] ?? match[1]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
    badResponse(
      `${config.exchange} ${config.sourceName}的 ${field} 數值區間錯誤。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, field, value: raw },
    );
  }
  return { raw: text, lower, upper, unit: "source_not_declared" };
}

function optionalOfficialDate(
  raw: unknown,
  field: string,
  config: SupportedSourceConfig,
): string | null {
  const text = preservedOptionalText(raw);
  if (text === null || /^(?:0+|-+|—|－)$/.test(text)) return null;
  return rocCompactDate(text, field, config);
}

function dividendPeriod(
  raw: unknown,
  config: SupportedSourceConfig,
): { raw: string; start: string | null; end: string | null } {
  const text = normalizeRequiredText(raw, "股利所屬期間", config.market);
  const match = /^(\d{6,7})\s*[~～]\s*(\d{6,7})$/.exec(text);
  if (!match) return { raw: text, start: null, end: null };
  const start = rocCompactDate(match[1], "股利所屬期間起日", config);
  const end = rocCompactDate(match[2], "股利所屬期間迄日", config);
  if (start > end) {
    badResponse(
      `${config.exchange} ${config.sourceName}的股利所屬期間起日晚於迄日。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, field: "股利所屬期間", value: raw },
    );
  }
  return { raw: text, start, end };
}

function plainDecisionStage(
  raw: unknown,
  config: SupportedSourceConfig,
): string {
  const source = normalizeRequiredText(raw, "決議（擬議）進度", config.market);
  const plain = source
    .replace(/<br\s*\/?\s*>/gi, " / ")
    .replace(/\s+/g, " ")
    .trim();
  if (/<[^>]+>/.test(plain)) {
    badResponse(
      `${config.exchange} ${config.sourceName}的決議進度包含未支援 HTML。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey, value: raw },
    );
  }
  return plain;
}

function forecastAchievementDetails(
  row: Record<string, unknown>,
  config: SupportedSourceConfig,
): CompanyCatalystSnapshotsDetails {
  const yearKey = config.market === "listed" ? "年度" : "Year";
  const actualKey =
    config.market === "listed"
      ? "截至該季經會計師查核或核閱數"
      : "截至第1季經會計師查核或核閱數";
  const forecastKey =
    config.market === "listed"
      ? "截至該季綜合損益預測數"
      : "截至第1季稅前損益預測數";
  const year = fiscalYear(row[yearKey], config);
  const actual = requiredOfficialNumber(row[actualKey], actualKey, config);
  return {
    kind: "forecast_achievement",
    fiscalYear: year.year,
    fiscalYearRaw: year.raw,
    quarter: fiscalQuarter(row["季別"], config),
    forecastSequence: normalizeRequiredText(
      row["財測序號"],
      "財測序號",
      config.market,
    ),
    coveragePeriod: normalizeRequiredText(
      row["涵蓋期間"],
      "涵蓋期間",
      config.market,
    ),
    actualCumulative: actual.value,
    actualCumulativeRaw: actual.raw,
    valueUnit: "source_not_declared",
    forecastCumulative: officialNumberRange(
      row[forecastKey],
      forecastKey,
      config,
    ),
  };
}

function forecastVarianceDetails(
  row: Record<string, unknown>,
  config: SupportedSourceConfig,
): CompanyCatalystSnapshotsDetails {
  const yearKey = config.market === "listed" ? "年度" : "Year";
  const actualQuarterKey =
    config.market === "listed"
      ? "當季經會計師查核或核閱數"
      : "經會計師查核或核閱數第4季";
  const actualCumulativeKey =
    config.market === "listed"
      ? "截至當季經會計師查核或核閱數"
      : "經會計師查核或核閱數截至第4季";
  const forecastQuarterKey =
    config.market === "listed"
      ? "當季稅前(綜合)損益預測數"
      : "稅前綜合損益預測數第4季";
  const forecastCumulativeKey =
    config.market === "listed"
      ? "截至當季稅前(綜合)損益預測數"
      : "稅前綜合損益預測數截至第4季";
  const year = fiscalYear(row[yearKey], config);
  const actualQuarter = requiredOfficialNumber(
    row[actualQuarterKey],
    actualQuarterKey,
    config,
  );
  const actualCumulative = requiredOfficialNumber(
    row[actualCumulativeKey],
    actualCumulativeKey,
    config,
  );
  return {
    kind: "forecast_material_variance",
    fiscalYear: year.year,
    fiscalYearRaw: year.raw,
    quarter: fiscalQuarter(row["季別"], config),
    forecastSequence: normalizeRequiredText(
      row["財測序號"],
      "財測序號",
      config.market,
    ),
    coveragePeriod: normalizeRequiredText(
      row["涵蓋期間"],
      "涵蓋期間",
      config.market,
    ),
    actualQuarter: actualQuarter.value,
    actualQuarterRaw: actualQuarter.raw,
    actualCumulative: actualCumulative.value,
    actualCumulativeRaw: actualCumulative.raw,
    valueUnit: "source_not_declared",
    forecastQuarter: officialNumberRange(
      row[forecastQuarterKey],
      forecastQuarterKey,
      config,
    ),
    forecastCumulative: officialNumberRange(
      row[forecastCumulativeKey],
      forecastCumulativeKey,
      config,
    ),
    selectionBasis: "official_dataset_membership",
    officialSelectionRule:
      "quarter_difference_at_least_10_percent_or_cumulative_difference_at_least_20_percent",
    thresholdDetail: null,
  };
}

function shareholderMeetingDetails(
  row: Record<string, unknown>,
  config: SupportedSourceConfig,
): CompanyCatalystSnapshotsDetails {
  return {
    kind: "shareholder_meeting",
    companyAddress: preservedOptionalText(row["公司地址"]),
    meetingType: normalizeRequiredText(
      row["股東常(臨時)會"],
      "股東常(臨時)會",
      config.market,
    ),
    meetingDate: rocCompactDate(row["開會日期"], "開會日期", config),
    meetingLocation: normalizeRequiredText(
      row["開會地點"],
      "開會地點",
      config.market,
    ),
    directorSupervisorElection: normalizeRequiredText(
      row["是否改選董監"],
      "是否改選董監",
      config.market,
    ),
    electronicVoting: normalizeRequiredText(
      row["是否採電子投票"],
      "是否採電子投票",
      config.market,
    ),
    contactPhone: preservedOptionalText(row["聯絡電話"]),
    stockTransferAgent: preservedOptionalText(row["股務單位"]),
    stockTransferAgentPhone: preservedOptionalText(row["股務單位電話"]),
  };
}

function dividendDecisionDetails(
  row: Record<string, unknown>,
  config: SupportedSourceConfig,
): CompanyCatalystSnapshotsDetails {
  const year = fiscalYear(row["股利年度"], config);
  const period = dividendPeriod(row["股利所屬期間"], config);
  return {
    kind: "dividend_decision",
    decisionStage: plainDecisionStage(row["決議（擬議）進度"], config),
    dividendYear: year.year,
    dividendYearRaw: year.raw,
    periodType: normalizeRequiredText(
      row["股利所屬年(季)度"],
      "股利所屬年(季)度",
      config.market,
    ),
    periodRaw: period.raw,
    periodStart: period.start,
    periodEnd: period.end,
    sequence: normalizeRequiredText(row["期別"], "期別", config.market),
    boardDecisionDate: optionalOfficialDate(
      row["董事會（擬議）股利分派日"],
      "董事會（擬議）股利分派日",
      config,
    ),
    shareholderMeetingDate: optionalOfficialDate(
      row["股東會日期"],
      "股東會日期",
      config,
    ),
    cashDividend: {
      earningsPerShare: optionalOfficialNumber(
        row["股東配發-盈餘分配之現金股利(元/股)"],
        "股東配發-盈餘分配之現金股利(元/股)",
        config,
      ),
      legalReservePerShare: optionalOfficialNumber(
        row["股東配發-法定盈餘公積發放之現金(元/股)"],
        "股東配發-法定盈餘公積發放之現金(元/股)",
        config,
      ),
      capitalReservePerShare: optionalOfficialNumber(
        row["股東配發-資本公積發放之現金(元/股)"],
        "股東配發-資本公積發放之現金(元/股)",
        config,
      ),
      totalAmount: optionalOfficialNumber(
        row["股東配發-股東配發之現金(股利)總金額(元)"],
        "股東配發-股東配發之現金(股利)總金額(元)",
        config,
      ),
    },
    stockDividend: {
      earningsPerShare: optionalOfficialNumber(
        row["股東配發-盈餘轉增資配股(元/股)"],
        "股東配發-盈餘轉增資配股(元/股)",
        config,
      ),
      legalReservePerShare: optionalOfficialNumber(
        row["股東配發-法定盈餘公積轉增資配股(元/股)"],
        "股東配發-法定盈餘公積轉增資配股(元/股)",
        config,
      ),
      capitalReservePerShare: optionalOfficialNumber(
        row["股東配發-資本公積轉增資配股(元/股)"],
        "股東配發-資本公積轉增資配股(元/股)",
        config,
      ),
      totalShares: optionalOfficialNumber(
        row["股東配發-股東配股總股數(股)"],
        "股東配發-股東配股總股數(股)",
        config,
      ),
    },
    charterExcerpt: preservedOptionalText(
      row["摘錄公司章程-股利分派部分"],
    ),
    note: preservedOptionalText(row["備註"]),
  };
}

function parseDetails(
  row: Record<string, unknown>,
  config: SupportedSourceConfig,
): CompanyCatalystSnapshotsDetails {
  switch (config.snapshotType) {
    case "forecast_achievement":
      return forecastAchievementDetails(row, config);
    case "forecast_material_variance":
      return forecastVarianceDetails(row, config);
    case "shareholder_meeting":
      return shareholderMeetingDetails(row, config);
    case "dividend_decision":
      return dividendDecisionDetails(row, config);
  }
}

function stableRawIdentity(
  config: SupportedSourceConfig,
  companyCode: string,
  details: CompanyCatalystSnapshotsDetails,
): string {
  switch (details.kind) {
    case "forecast_achievement":
    case "forecast_material_variance":
      return stableDigest([
        config.sourceKey,
        companyCode,
        details.fiscalYearRaw,
        details.quarter,
        details.forecastSequence,
      ]);
    case "shareholder_meeting":
      return stableDigest([
        config.sourceKey,
        companyCode,
        details.meetingType,
        details.meetingDate,
      ]);
    case "dividend_decision":
      return stableDigest([
        config.sourceKey,
        companyCode,
        details.dividendYearRaw,
        details.periodRaw,
        details.sequence,
      ]);
  }
}

function parseSourceSnapshot(
  snapshot: JsonSnapshot,
  config: SupportedSourceConfig,
  requestedCompanyCodes: string[],
  today: string,
): ParsedSource {
  if (!Array.isArray(snapshot.payload)) {
    badResponse(
      `${config.exchange} ${config.sourceName}不是 JSON array。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey },
    );
  }
  if (snapshot.payload.length === 0) {
    badResponse(
      `${config.exchange} ${config.sourceName}回傳空 array，無法驗證是官方空資料。`,
      "UPSTREAM_UNVERIFIED_EMPTY",
      { sourceKey: config.sourceKey },
      true,
    );
  }
  const rows = snapshot.payload.map((value, rowIndex) =>
    exactRecord(value, config, rowIndex),
  );
  const reportDates = rows.map((row) =>
    rocCompactDate(row[config.reportDateKey], config.reportDateKey, config),
  );
  const uniqueReportDates = [...new Set(reportDates)];
  if (uniqueReportDates.length !== 1) {
    badResponse(
      `${config.exchange} ${config.sourceName}含多個出表日期。`,
      "UPSTREAM_MIXED_REPORT_DATES",
      { sourceKey: config.sourceKey, reportDates: uniqueReportDates },
    );
  }
  const sourceSnapshotDate = uniqueReportDates[0];
  const { freshness, ageDays } = snapshotFreshness(
    sourceSnapshotDate,
    today,
    config,
  );

  if (rows.length === 1 && isOfficialBlankSentinel(rows[0], config)) {
    const snapshotIdentity = stableDigest({
      sourceKey: config.sourceKey,
      sourceSnapshotDate,
      status: "official_blank_sentinel",
      expectedKeys: [...config.expectedKeys],
    });
    return {
      records: [],
      source: {
        snapshotType: config.snapshotType,
        market: config.market,
        exchange: config.exchange,
        sourceKey: config.sourceKey,
        sourceName: config.sourceName,
        sourceUrl: config.sourceUrl,
        sourceMode: "current_official_snapshot",
        pointInTimeHistoryAvailable: false,
        isConsensus: false,
        requestedCompanyCodes,
        status: "verified_empty",
        freshness,
        retrievedAt: snapshot.retrievedAt,
        ...(snapshot.cache ? { cache: snapshot.cache } : {}),
        sourceSnapshotDate,
        sourceSnapshotAgeDays: ageDays,
        rawRowCount: 1,
        eligibleRecordCount: 0,
        duplicateRecordCount: 0,
        selectedRecordCount: 0,
        emptyVerification: "official_blank_sentinel",
        officialDeclaredRowCount: null,
        rowsetCompleteness: "unverified_no_official_declared_count",
        snapshotIdentity,
        failureId: null,
      },
    };
  }
  if (rows.some((row) => isOfficialBlankSentinel(row, config))) {
    badResponse(
      `${config.exchange} ${config.sourceName}把空白 sentinel 與資料列混合回傳。`,
      "UPSTREAM_SCHEMA_DRIFT",
      { sourceKey: config.sourceKey },
    );
  }

  const parsedRecords = rows.map((row) => {
    const companyCode = officialSecurityCode(
      row[config.companyCodeKey],
      config,
    );
    const companyName = normalizeRequiredText(
      row[config.companyNameKey],
      config.companyNameKey,
      config.market,
    );
    const details = parseDetails(row, config);
    const sourceRecordKey = stableRawIdentity(config, companyCode, details);
    const upcomingEligible =
      freshness === "within_expected_window" &&
      details.kind === "shareholder_meeting" &&
      details.meetingDate >= today;
    return {
      record: {
        recordId: stableDigest([
          "company_catalyst_snapshot_v1",
          sourceRecordKey,
        ]),
        snapshotType: config.snapshotType,
        companyCode,
        companyName,
        market: config.market,
        sourceMode: "current_official_snapshot" as const,
        sourceSnapshotDate,
        freshness,
        sourceSnapshotAgeDays: ageDays,
        pointInTimeHistoryAvailable: false as const,
        firstKnownAt: null,
        isConsensus: false as const,
        upcomingEligible,
        sourceKey: config.sourceKey,
        sourceUrl: config.sourceUrl,
        sourceRecordKey,
        details,
      } satisfies CompanyCatalystSnapshotsRecord,
      contentDigest: stableDigest(row),
    };
  });
  const uniqueByKey = new Map<
    string,
    { record: CompanyCatalystSnapshotsRecord; contentDigest: string }
  >();
  let duplicateRecordCount = 0;
  for (const parsed of parsedRecords) {
    const existing = uniqueByKey.get(parsed.record.sourceRecordKey);
    if (!existing) {
      uniqueByKey.set(parsed.record.sourceRecordKey, parsed);
      continue;
    }
    if (existing.contentDigest !== parsed.contentDigest) {
      badResponse(
        `${config.exchange} ${config.sourceName}同一 stable identity 含衝突內容。`,
        "UPSTREAM_CONFLICTING_DUPLICATE",
        {
          sourceKey: config.sourceKey,
          sourceRecordKey: parsed.record.sourceRecordKey,
          firstContentDigest: existing.contentDigest,
          secondContentDigest: parsed.contentDigest,
        },
      );
    }
    duplicateRecordCount += 1;
  }
  const uniqueRecords = [...uniqueByKey.values()]
    .map((parsed) => parsed.record)
    .sort(compareRecords);
  const requested = new Set(requestedCompanyCodes);
  const selectedRecords = uniqueRecords.filter((record) =>
    requested.has(record.companyCode),
  );
  const snapshotIdentity = stableDigest({
    sourceKey: config.sourceKey,
    sourceSnapshotDate,
    sourceRecords: [...uniqueByKey.values()]
      .map((parsed) => ({
        sourceRecordKey: parsed.record.sourceRecordKey,
        contentDigest: parsed.contentDigest,
      }))
      .sort((left, right) =>
        left.sourceRecordKey.localeCompare(right.sourceRecordKey),
      ),
  });
  return {
    records: selectedRecords,
    source: {
      snapshotType: config.snapshotType,
      market: config.market,
      exchange: config.exchange,
      sourceKey: config.sourceKey,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      sourceMode: "current_official_snapshot",
      pointInTimeHistoryAvailable: false,
      isConsensus: false,
      requestedCompanyCodes,
      status: "nonempty",
      freshness,
      retrievedAt: snapshot.retrievedAt,
      ...(snapshot.cache ? { cache: snapshot.cache } : {}),
      sourceSnapshotDate,
      sourceSnapshotAgeDays: ageDays,
      rawRowCount: rows.length,
      eligibleRecordCount: uniqueRecords.length,
      duplicateRecordCount,
      selectedRecordCount: selectedRecords.length,
      emptyVerification: "not_applicable",
      officialDeclaredRowCount: null,
      rowsetCompleteness: "unverified_no_official_declared_count",
      snapshotIdentity,
      failureId: null,
    },
  };
}

function compareRecords(
  left: CompanyCatalystSnapshotsRecord,
  right: CompanyCatalystSnapshotsRecord,
): number {
  return (
    left.companyCode.localeCompare(right.companyCode) ||
    ALL_SNAPSHOT_TYPES.indexOf(left.snapshotType) -
      ALL_SNAPSHOT_TYPES.indexOf(right.snapshotType) ||
    left.market.localeCompare(right.market) ||
    left.sourceRecordKey.localeCompare(right.sourceRecordKey)
  );
}

function unsupportedSourceKey(
  route: PlannedRoute,
): "tpex_dividend_decision_current_unsupported" {
  if (route.snapshotType !== "dividend_decision" || route.market !== "otc") {
    throw new Error("Unsupported source route is not declared.");
  }
  return "tpex_dividend_decision_current_unsupported";
}

function unsupportedSource(route: PlannedRoute): CompanyCatalystSnapshotsSource {
  const sourceKey = unsupportedSourceKey(route);
  return {
    snapshotType: route.snapshotType,
    market: route.market,
    exchange: "TPEx",
    sourceKey,
    sourceName:
      "證券櫃檯買賣中心－上櫃公司股利決議 current snapshot（官方端點未提供）",
    sourceUrl: null,
    sourceMode: "current_official_snapshot",
    pointInTimeHistoryAvailable: false,
    isConsensus: false,
    requestedCompanyCodes: route.companyCodes,
    status: "unsupported",
    freshness: "not_applicable",
    retrievedAt: null,
    sourceSnapshotDate: null,
    sourceSnapshotAgeDays: null,
    rawRowCount: 0,
    eligibleRecordCount: 0,
    duplicateRecordCount: 0,
    selectedRecordCount: 0,
    emptyVerification: "not_applicable",
    officialDeclaredRowCount: null,
    rowsetCompleteness: "not_applicable",
    snapshotIdentity: null,
    failureId: null,
  };
}

function sourceFailureFrom(
  error: unknown,
  route: PlannedRoute,
): CompanyCatalystSnapshotsSourceFailure {
  if (!route.config) throw new Error("Supported source config is required.");
  const upstream =
    error instanceof MopsfinError
      ? error
      : new MopsfinError(
          "UPSTREAM_BAD_RESPONSE",
          "Catalyst snapshot 官方來源發生未預期錯誤。",
          {
            cause: error,
            reason: "UPSTREAM_UNEXPECTED_ERROR",
            retryable: true,
            action: "retry",
          },
        );
  const failureId = stableDigest([
    "company_catalyst_snapshot_failure_v1",
    route.config.sourceKey,
    route.companyCodes,
    upstream.code,
    upstream.reason ?? null,
  ]);
  const retryable = upstream.retryable ?? false;
  return {
    failureId,
    snapshotType: route.snapshotType,
    market: route.market,
    sourceKey: route.config.sourceKey,
    affectedCompanyCodes: route.companyCodes,
    code: upstream.code,
    message: upstream.message,
    reason: upstream.reason ?? null,
    retryable,
    retryAfterMs: upstream.retryAfterMs ?? null,
    action: upstream.action ?? (retryable ? "retry" : "none"),
  };
}

function failedSource(
  route: PlannedRoute,
  failure: CompanyCatalystSnapshotsSourceFailure,
): CompanyCatalystSnapshotsSource {
  if (!route.config) throw new Error("Supported source config is required.");
  return {
    snapshotType: route.snapshotType,
    market: route.market,
    exchange: route.config.exchange,
    sourceKey: route.config.sourceKey,
    sourceName: route.config.sourceName,
    sourceUrl: route.config.sourceUrl,
    sourceMode: "current_official_snapshot",
    pointInTimeHistoryAvailable: false,
    isConsensus: false,
    requestedCompanyCodes: route.companyCodes,
    status: "failed",
    freshness: "not_applicable",
    retrievedAt: null,
    sourceSnapshotDate: null,
    sourceSnapshotAgeDays: null,
    rawRowCount: 0,
    eligibleRecordCount: 0,
    duplicateRecordCount: 0,
    selectedRecordCount: 0,
    emptyVerification: "not_applicable",
    officialDeclaredRowCount: null,
    rowsetCompleteness: "not_applicable",
    snapshotIdentity: null,
    failureId: failure.failureId,
  };
}

function resolveIdentity(
  companyCode: string,
  query: ValidatedQuery,
  records: CompanyCatalystSnapshotsRecord[],
): {
  identityStatus: CompanyCatalystSnapshotsIdentityStatus;
  resolvedMarket: CompanyMarket | null;
} {
  const hintedMarket = query.marketHints.get(companyCode);
  if (hintedMarket) {
    return {
      identityStatus: "verified_current_master_hint",
      resolvedMarket: hintedMarket,
    };
  }
  const currentRecordMarkets = new Set(
    records
      .filter(
        (record) =>
          record.companyCode === companyCode &&
          record.freshness === "within_expected_window",
      )
      .map((record) => record.market),
  );
  if (currentRecordMarkets.size === 1) {
    return {
      identityStatus: "verified_official_record",
      resolvedMarket: [...currentRecordMarkets][0],
    };
  }
  return { identityStatus: "unverified", resolvedMarket: null };
}

function aggregateSourceFreshness(
  sources: CompanyCatalystSnapshotsSource[],
): CompanyCatalystSnapshotsFreshness {
  const successful = sources.filter(
    (source) =>
      source.status === "nonempty" || source.status === "verified_empty",
  );
  if (successful.some((source) => source.freshness === "stale")) return "stale";
  if (
    successful.some(
      (source) => source.freshness === "within_expected_window",
    )
  ) {
    return "within_expected_window";
  }
  return "not_applicable";
}

function buildCoverage(
  query: ValidatedQuery,
  executions: RouteExecution[],
  records: CompanyCatalystSnapshotsRecord[],
): CompanyCatalystSnapshotsCoverageItem[] {
  return query.companyCodes.flatMap((companyCode) => {
    const identity = resolveIdentity(companyCode, query, records);
    return query.snapshotTypes.map((snapshotType) => {
      const routed = executions.filter(
        (execution) =>
          execution.route.snapshotType === snapshotType &&
          execution.route.companyCodes.includes(companyCode),
      );
      const allSources = routed.map((execution) => execution.source);
      const relevantSources = identity.resolvedMarket
        ? allSources.filter(
            (source) => source.market === identity.resolvedMarket,
          )
        : allSources;
      const typeRecords = records.filter(
        (record) =>
          record.companyCode === companyCode &&
          record.snapshotType === snapshotType,
      );
      const relevantRecords = identity.resolvedMarket
        ? typeRecords.filter(
            (record) => record.market === identity.resolvedMarket,
          )
        : typeRecords;
      const freshness = aggregateSourceFreshness(relevantSources);
      const allFailed =
        relevantSources.length > 0 &&
        relevantSources.every((source) => source.status === "failed");
      const allUnsupported =
        relevantSources.length > 0 &&
        relevantSources.every((source) => source.status === "unsupported");
      const hasFailure = relevantSources.some(
        (source) => source.status === "failed",
      );
      const hasUnsupported = relevantSources.some(
        (source) => source.status === "unsupported",
      );
      let status: CompanyCatalystSnapshotsCoverageItem["status"];
      let disclosureStatus: CompanyCatalystSnapshotsDisclosureStatus;

      if (relevantRecords.length > 0) {
        disclosureStatus = "disclosed";
        status =
          freshness === "within_expected_window" &&
          identity.identityStatus !== "unverified" &&
          !hasFailure &&
          !hasUnsupported
            ? "complete"
            : "partial";
      } else if (allUnsupported) {
        status = "unsupported";
        disclosureStatus = "unsupported";
      } else if (allFailed) {
        status = "failed";
        disclosureStatus = "unknown_source_failure";
      } else if (hasFailure) {
        status = "partial";
        disclosureStatus = "unknown_source_failure";
      } else if (freshness === "stale") {
        status = "partial";
        disclosureStatus = "unknown_stale_snapshot";
      } else if (identity.identityStatus === "unverified") {
        status = "partial";
        disclosureStatus = "identity_unverified";
      } else if (hasUnsupported) {
        status = "partial";
        disclosureStatus = "unsupported";
      } else {
        status = "complete";
        disclosureStatus = "not_disclosed_in_snapshot";
      }

      return {
        companyCode,
        snapshotType,
        routedMarkets: routed.map((execution) => execution.route.market),
        status,
        disclosureStatus,
        identityStatus: identity.identityStatus,
        resolvedMarket: identity.resolvedMarket,
        freshness,
        recordCount: relevantRecords.length,
        sourceKeys: relevantSources.map((source) => source.sourceKey),
        failureIds: relevantSources.flatMap((source) =>
          source.failureId ? [source.failureId] : [],
        ),
      };
    });
  });
}

function orderedSnapshotTypes(
  values: CompanyCatalystSnapshotsType[],
): CompanyCatalystSnapshotsType[] {
  const selected = new Set(values);
  return ALL_SNAPSHOT_TYPES.filter((value) => selected.has(value));
}

function buildCompanies(
  query: ValidatedQuery,
  coverage: CompanyCatalystSnapshotsCoverageItem[],
  records: CompanyCatalystSnapshotsRecord[],
): CompanyCatalystSnapshotsCompanyResult[] {
  return query.companyCodes.map((companyCode) => {
    const companyCoverage = coverage.filter(
      (item) => item.companyCode === companyCode,
    );
    const identity = resolveIdentity(companyCode, query, records);
    const status = companyCoverage.every((item) => item.status === "complete")
      ? "complete"
      : companyCoverage.every((item) => item.status === "failed")
        ? "failed"
        : "partial";
    const forStatus = (
      predicate: (item: CompanyCatalystSnapshotsCoverageItem) => boolean,
    ) =>
      orderedSnapshotTypes(
        companyCoverage
          .filter(predicate)
          .map((item) => item.snapshotType),
      );
    return {
      companyCode,
      status,
      identityStatus: identity.identityStatus,
      resolvedMarket: identity.resolvedMarket,
      recordCount: records.filter((record) => record.companyCode === companyCode)
        .length,
      disclosedSnapshotTypes: forStatus(
        (item) => item.disclosureStatus === "disclosed",
      ),
      notDisclosedSnapshotTypes: forStatus(
        (item) => item.disclosureStatus === "not_disclosed_in_snapshot",
      ),
      staleSnapshotTypes: forStatus((item) => item.freshness === "stale"),
      unsupportedSnapshotTypes: forStatus(
        (item) =>
          item.status === "unsupported" ||
          item.sourceKeys.includes(
            "tpex_dividend_decision_current_unsupported",
          ),
      ),
      failedSnapshotTypes: forStatus(
        (item) => item.status === "failed" || item.failureIds.length > 0,
      ),
    };
  });
}

export class CompanyCatalystSnapshotClient {
  private readonly jsonLoader: CompanyCatalystSnapshotsJsonLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    options: CompanyCatalystSnapshotClientOptions = {},
  ) {
    this.jsonLoader =
      options.jsonLoader ?? new OfficialJsonLoader(fetchImpl, now, options);
  }

  async getCompanyCatalystSnapshots(
    query: CompanyCatalystSnapshotsQuery,
    executionOptions: CompanyCatalystSnapshotsExecutionOptions = {},
  ): Promise<CompanyCatalystSnapshotsResult> {
    const validated = validateQuery(query);
    const routes = planRoutes(validated);
    const evaluationTime = this.now();
    const today = taipeiToday(evaluationTime);
    const executions = await Promise.all(
      routes.map((route) => this.executeRoute(route, today)),
    );
    const supportedExecutions = executions.filter(
      (execution) => execution.route.config !== null,
    );
    if (
      (executionOptions.allSourcesFailureMode ?? "throw") === "throw" &&
      supportedExecutions.length > 0 &&
      supportedExecutions.every(
        (execution) => execution.source.status === "failed",
      )
    ) {
      const aggregateFailures = supportedExecutions.flatMap((execution) =>
        execution.failure ? [execution.failure] : [],
      );
      throw new MopsfinError(
        "UPSTREAM_BAD_RESPONSE",
        "所有已查詢的 catalyst snapshot 官方來源都失敗，無法形成可驗證結果。",
        {
          reason: "ALL_CATALYST_SNAPSHOT_SOURCES_FAILED",
          retryable: aggregateFailures.some((failure) => failure.retryable),
          action: aggregateFailures.some((failure) => failure.retryable)
            ? "retry"
            : "none",
          details: {
            failures: aggregateFailures.map((failure) => ({
              failureId: failure.failureId,
              sourceKey: failure.sourceKey,
              code: failure.code,
              reason: failure.reason,
              affectedCompanyCodes: failure.affectedCompanyCodes,
            })),
          },
        },
      );
    }

    const routedRecords = executions
      .flatMap((execution) => execution.records)
      .sort(compareRecords);
    const resolvedMarkets = new Map(
      validated.companyCodes.flatMap((companyCode) => {
        const identity = resolveIdentity(
          companyCode,
          validated,
          routedRecords,
        );
        return identity.resolvedMarket === null
          ? []
          : [[companyCode, identity.resolvedMarket] as const];
      }),
    );
    let identityExcludedRecordCount = 0;
    const effectiveExecutions = executions.map((execution) => {
      const records = execution.records.filter((record) => {
        const resolvedMarket = resolvedMarkets.get(record.companyCode);
        const retained =
          resolvedMarket === undefined || resolvedMarket === record.market;
        if (!retained) identityExcludedRecordCount += 1;
        return retained;
      });
      return {
        ...execution,
        records,
        source:
          records.length === execution.source.selectedRecordCount
            ? execution.source
            : {
                ...execution.source,
                selectedRecordCount: records.length,
              },
      };
    });
    const allRecords = effectiveExecutions
      .flatMap((execution) => execution.records)
      .sort(compareRecords);
    const sources = effectiveExecutions
      .map((execution) => execution.source)
      .sort(
        (left, right) =>
          ALL_SNAPSHOT_TYPES.indexOf(left.snapshotType) -
            ALL_SNAPSHOT_TYPES.indexOf(right.snapshotType) ||
          MARKETS.indexOf(left.market) - MARKETS.indexOf(right.market),
      );
    const failures = effectiveExecutions
      .flatMap((execution) => (execution.failure ? [execution.failure] : []))
      .sort((left, right) => left.failureId.localeCompare(right.failureId));
    const snapshots = buildCoverage(
      validated,
      effectiveExecutions,
      allRecords,
    );
    const companies = buildCompanies(validated, snapshots, allRecords);
    const page = allRecords.slice(
      validated.offset,
      validated.offset + validated.limit,
    );
    const nextOffset =
      validated.offset + page.length < allRecords.length
        ? validated.offset + page.length
        : null;
    const fingerprint = stableDigest({
      query: {
        companyCodes: validated.companyCodes,
        snapshotTypes: validated.snapshotTypes,
        companyMarkets: validated.companyMarkets,
        asOf: validated.asOf,
      },
      recordIds: allRecords.map((record) => record.recordId),
      sourceSnapshots: sources.map((source) => ({
        sourceKey: source.sourceKey,
        status: source.status,
        freshness: source.freshness,
        snapshotIdentity: source.snapshotIdentity,
        failureId: source.failureId,
      })),
      coverage: snapshots.map((item) => ({
        companyCode: item.companyCode,
        snapshotType: item.snapshotType,
        status: item.status,
        disclosureStatus: item.disclosureStatus,
        identityStatus: item.identityStatus,
      })),
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
      "資料是官方 current snapshot，不是 point-in-time 歷史；firstKnownAt 固定為 null，出表日只表示 source snapshot date，不是公告日、事實發生日或首次得知日。",
      "公司財測欄位是發行人揭露，不是分析師共識；官方來源未宣告金額單位，因此保留 raw 並以 source_not_declared 標示 parsed values。",
      "forecast_material_variance 只表示公司列於官方資料集；不得由 membership 推定實際命中 10% 或 20% 的哪一門檻，也沒有自行重算差異幅度。",
      "只有 freshness=within_expected_window、日期不早於 Asia/Taipei 今日的股東會 record 才可能 upcomingEligible=true；其他 record 固定 false。",
      "董事會（擬議）股利分派日保留為 boardDecisionDate，不是 publication、firstKnown 或股利付款日。",
      "TPEx 沒有可用的 current dividend-decision OpenAPI；此 route 明列 unsupported，且不使用 stale mopsfin_t187ap39_O。",
      "這些 OpenAPI 沒有 official declared row count；即使通過 exact schema、單一出表日與 sentinel 檢查，fresh snapshot 中未找到公司也只代表 not_disclosed_in_snapshot，不證明平台 rowset 絕對完整。",
      "offset pagination 是無伺服器狀態的 current snapshot 切頁；若 fingerprint 改變，應從 offset=0 重新開始。",
    ];
    if (sources.some((source) => source.freshness === "stale")) {
      warnings.push(
        "至少一個官方 source snapshot 已 stale；空白 sentinel 或 selected code absence 不得解讀成目前沒有揭露。",
      );
    }
    if (identityExcludedRecordCount > 0) {
      warnings.push(
        `current identity 已由 current-master hint 或 fresh 官方 record 確認；已排除 ${identityExcludedRecordCount} 筆另一市場的 stale／不相符代號 records，避免把跨市場同碼證據錯接至 requested 公司。`,
      );
    }
    if (failures.length > 0) {
      warnings.push(
        "部分 snapshot type／market 官方來源失敗，已隔離於 failures；受影響範圍不得解讀成沒有揭露。",
      );
    }
    if (
      companies.some((company) => company.identityStatus === "unverified")
    ) {
      warnings.push(
        "至少一個未提供 current-master market hint 的公司，沒有 fresh 官方 record 可確認目前市場；其 absence 標示 identity_unverified，不得解讀為 not_disclosed。",
      );
    }

    return {
      query: {
        companyCodes: validated.companyCodes,
        snapshotTypes: validated.snapshotTypes,
        companyMarkets: validated.companyMarkets,
        asOf: validated.asOf,
        offset: validated.offset,
        limit: validated.limit,
      },
      generatedAt: evaluationTime.toISOString(),
      timezone: "Asia/Taipei",
      scope: "current_official_company_snapshots",
      isConsensus: false,
      records: page,
      sources,
      coverage: {
        sourceComplete: sources.every(
          (source) =>
            (source.status === "nonempty" ||
              source.status === "verified_empty") &&
            source.freshness === "within_expected_window",
        ),
        selection: snapshots.every((item) => item.status === "complete")
          ? "complete"
          : "partial",
        failureIsolation: "per_snapshot_type_market",
        snapshots,
      },
      companies,
      failures,
      counts: {
        requestedCompanies: validated.companyCodes.length,
        requestedSnapshotTypes: validated.snapshotTypes.length,
        totalRecords: allRecords.length,
        returnedRecords: page.length,
        completeCompanies,
        partialCompanies,
        failedCompanies,
        nonemptySources: sources.filter((source) => source.status === "nonempty")
          .length,
        verifiedEmptySources: sources.filter(
          (source) => source.status === "verified_empty",
        ).length,
        staleSources: sources.filter((source) => source.freshness === "stale")
          .length,
        failedSources: sources.filter((source) => source.status === "failed")
          .length,
        unsupportedSources: sources.filter(
          (source) => source.status === "unsupported",
        ).length,
      },
      workBudget: {
        companyCount: validated.companyCodes.length,
        snapshotTypeCount: validated.snapshotTypes.length,
        plannedSourceRoutes: routes.length,
        supportedSourceQueries: routes.filter((route) => route.config !== null)
          .length,
        unsupportedSourceRoutes: routes.filter((route) => route.config === null)
          .length,
        sourceQueryLimit: SOURCE_QUERY_LIMIT,
      },
      pagination: {
        offset: validated.offset,
        limit: validated.limit,
        totalRows: allRecords.length,
        returnedRows: page.length,
        hasMore: nextOffset !== null,
        nextOffset,
      },
      fingerprint,
      warnings,
    };
  }

  private async executeRoute(
    route: PlannedRoute,
    today: string,
  ): Promise<RouteExecution> {
    if (!route.config) {
      return {
        route,
        records: [],
        source: unsupportedSource(route),
        failure: null,
      };
    }
    try {
      const snapshot = await this.jsonLoader.get(route.config);
      const parsed = parseSourceSnapshot(
        snapshot,
        route.config,
        route.companyCodes,
        today,
      );
      return { route, ...parsed, failure: null };
    } catch (error) {
      const failure = sourceFailureFrom(error, route);
      return {
        route,
        records: [],
        source: failedSource(route, failure),
        failure,
      };
    }
  }
}

export const companyCatalystSnapshotClient =
  new CompanyCatalystSnapshotClient();
