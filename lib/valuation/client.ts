import { companyMasterClient } from "@/lib/company-master/client";
import type { CompanyMarket, MasterCompany } from "@/lib/company-master/types";
import {
  assertUniqueCodes,
  fail,
  isEligibleCompanyIdentity,
  normalizeCompactDate,
  normalizeRequestedCodes,
  normalizeRequiredText,
  OfficialJsonLoader,
  parseOfficialNumber,
  reconcileMarket,
  selectedMarkets,
  type JsonSnapshot,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import type {
  CurrentCompanyMasterLike,
  OfficialMarketClientOptions,
} from "@/lib/market-data/types";

import type {
  DailyMarketValuationQuery,
  DailyMarketValuationResult,
  LegacyValuationValueStatus,
  ValuationRow,
  ValuationSource,
  ValuationValueStatus,
} from "./types";

interface ParsedValuationSource {
  market: CompanyMarket;
  dataDate: string;
  rows: ValuationRow[];
  source: ValuationSource;
}

interface LatestSourceResolution {
  result: ParsedValuationSource;
  fallbackReason?: string;
}

interface LatestFields {
  date: string;
  code: string;
  name: string;
  pe: string;
  pb: string;
  dividendYield: string;
  closePrice: string;
  dividendPerShare: string;
  dividendFiscalYear: string;
  referenceFiscalPeriod: string;
}

interface RawValuationFields {
  pe: unknown;
  pb: unknown;
  dividendYield: unknown;
  closePrice: unknown;
  dividendPerShare: unknown;
  dividendFiscalYear: unknown;
  referenceFiscalPeriod: unknown;
  provided: {
    closePrice: boolean;
    dividendPerShare: boolean;
    dividendFiscalYear: boolean;
    referenceFiscalPeriod: boolean;
  };
}

interface HistoricalTable {
  fields: unknown[];
  data: unknown[];
  declaredCount: unknown;
}

const SOURCE_CONFIGS: Record<CompanyMarket, OfficialSourceConfig> = {
  listed: {
    market: "listed",
    exchange: "TWSE",
    sourceName: "臺灣證券交易所－上市股票本益比、殖利率及股價淨值比",
    sourceUrl: "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
  },
  otc: {
    market: "otc",
    exchange: "TPEx",
    sourceName: "證券櫃檯買賣中心－上櫃股票本益比分析",
    sourceUrl:
      "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
  },
};

const SUPPORTED_FROM: Record<CompanyMarket, string> = {
  listed: "2005-09-02",
  otc: "2007-01-02",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MISSING_MARKER = /^(?:-|--|---|—|－|N\/?A|null)$/i;

function parseIsoDate(raw: string, field: string): Date {
  if (!ISO_DATE.test(raw)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 YYYY-MM-DD。`, {
      field,
      value: raw,
    });
  }
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${field} 不是有效日期。`, {
      field,
      value: raw,
    });
  }
  return parsed;
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

function validateQuery(query: DailyMarketValuationQuery, now: Date): void {
  if (
    query.universePolicy !== "compatible" &&
    query.universePolicy !== "strict_current_master"
  ) {
    fail(
      "INVALID_ARGUMENT",
      "universe_policy 必須是 compatible 或 strict_current_master。",
      { universePolicy: query.universePolicy },
    );
  }
  if (query.date === "latest") return;
  if (typeof query.date !== "string") {
    fail("INVALID_ARGUMENT", "date 必須是 latest 或 YYYY-MM-DD。", {
      date: query.date,
    });
  }
  parseIsoDate(query.date, "date");
  if (query.date > taipeiToday(now)) {
    fail("INVALID_ARGUMENT", "date 不得晚於台北今日日期。", {
      date: query.date,
    });
  }
  if (query.universePolicy === "strict_current_master") {
    fail(
      "INVALID_ARGUMENT",
      "strict_current_master 只支援 date=latest，不能用目前母體驗證歷史估值。",
    );
  }
  const supportedFrom =
    query.market === "listed" ? SUPPORTED_FROM.listed : SUPPORTED_FROM.otc;
  if (query.date < supportedFrom) {
    fail("INVALID_ARGUMENT", "date 早於指定市場的歷史估值支援範圍。", {
      market: query.market,
      supportedFrom,
    });
  }
}

function rawValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return String(raw).trim();
}

function valuationNumber(raw: unknown): {
  value: number | null;
  status: LegacyValuationValueStatus;
} {
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing) {
    return { value: null, status: "missing_or_not_meaningful" };
  }
  if (parsed.invalid || parsed.value === null || parsed.value < 0) {
    return { value: null, status: "invalid_upstream" };
  }
  return { value: parsed.value, status: "reported" };
}

function optionalNumber(
  raw: unknown,
  provided: boolean,
  positiveOnly = false,
): { value: number | null; status: ValuationValueStatus } {
  if (!provided) return { value: null, status: "not_provided_by_source" };
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing) {
    return { value: null, status: "missing_or_not_meaningful" };
  }
  if (
    parsed.invalid ||
    parsed.value === null ||
    parsed.value < 0 ||
    (positiveOnly && parsed.value === 0)
  ) {
    return { value: null, status: "invalid_upstream" };
  }
  return { value: parsed.value, status: "reported" };
}

function normalizeFiscalYear(rawYear: number): number | null {
  if (!Number.isInteger(rawYear) || rawYear <= 0) return null;
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  return year >= 1912 && year <= 9999 ? year : null;
}

function dividendFiscalYear(
  raw: unknown,
  provided: boolean,
): { value: number | null; status: ValuationValueStatus } {
  if (!provided) return { value: null, status: "not_provided_by_source" };
  const parsed = parseOfficialNumber(raw);
  if (parsed.missing) {
    return { value: null, status: "missing_or_not_meaningful" };
  }
  if (parsed.invalid || parsed.value === null) {
    return { value: null, status: "invalid_upstream" };
  }
  const value = normalizeFiscalYear(parsed.value);
  return value === null
    ? { value: null, status: "invalid_upstream" }
    : { value, status: "reported" };
}

function referenceFiscalPeriod(
  raw: unknown,
  provided: boolean,
): { value: string | null; status: ValuationValueStatus } {
  if (!provided) return { value: null, status: "not_provided_by_source" };
  if (raw === null || raw === undefined) {
    return { value: null, status: "missing_or_not_meaningful" };
  }
  const value = String(raw).trim();
  if (!value || MISSING_MARKER.test(value)) {
    return { value: null, status: "missing_or_not_meaningful" };
  }
  const compact = value.replace(/\s+/g, "");
  const match =
    /^(\d{2,4})(?:\/|Q)([1-4])$/i.exec(compact) ??
    /^(\d{2,4})年第?([1-4])季$/.exec(compact);
  if (!match) return { value: null, status: "invalid_upstream" };
  const year = normalizeFiscalYear(Number(match[1]));
  if (year === null) return { value: null, status: "invalid_upstream" };
  return { value: `${year}Q${match[2]}`, status: "reported" };
}

function buildValuationRow(
  market: CompanyMarket,
  code: string,
  name: string,
  raw: RawValuationFields,
): ValuationRow {
  const pe = valuationNumber(raw.pe);
  const pb = valuationNumber(raw.pb);
  const dividendYield = valuationNumber(raw.dividendYield);
  const closePrice = optionalNumber(raw.closePrice, raw.provided.closePrice, true);
  const dividendPerShare = optionalNumber(
    raw.dividendPerShare,
    raw.provided.dividendPerShare,
  );
  const dividendYear = dividendFiscalYear(
    raw.dividendFiscalYear,
    raw.provided.dividendFiscalYear,
  );
  const fiscalPeriod = referenceFiscalPeriod(
    raw.referenceFiscalPeriod,
    raw.provided.referenceFiscalPeriod,
  );
  return {
    code,
    name,
    market,
    peRatio: pe.value,
    priceToBookRatio: pb.value,
    dividendYieldPercent: dividendYield.value,
    closePriceTwd: closePrice.value,
    dividendPerShareTwd: dividendPerShare.value,
    dividendFiscalYear: dividendYear.value,
    referenceFiscalPeriod: fiscalPeriod.value,
    valueStatus: {
      peRatio: pe.status,
      priceToBookRatio: pb.status,
      dividendYieldPercent: dividendYield.status,
      closePriceTwd: closePrice.status,
      dividendPerShareTwd: dividendPerShare.status,
      dividendFiscalYear: dividendYear.status,
      referenceFiscalPeriod: fiscalPeriod.status,
    },
    rawValue: {
      peRatio: rawValue(raw.pe),
      priceToBookRatio: rawValue(raw.pb),
      dividendYieldPercent: rawValue(raw.dividendYield),
      closePriceTwd: rawValue(raw.closePrice),
      dividendPerShareTwd: rawValue(raw.dividendPerShare),
      dividendFiscalYear: rawValue(raw.dividendFiscalYear),
      referenceFiscalPeriod: rawValue(raw.referenceFiscalPeriod),
    },
  };
}

function fieldsFor(market: CompanyMarket): LatestFields {
  return market === "listed"
    ? {
        date: "Date",
        code: "Code",
        name: "Name",
        pe: "PEratio",
        pb: "PBratio",
        dividendYield: "DividendYield",
        closePrice: "ClosePrice",
        dividendPerShare: "DividendPerShare",
        dividendFiscalYear: "DividendYear",
        referenceFiscalPeriod: "FiscalYearQuarter",
      }
    : {
        date: "Date",
        code: "SecuritiesCompanyCode",
        name: "CompanyName",
        pe: "PriceEarningRatio",
        pb: "PriceBookRatio",
        dividendYield: "YieldRatio",
        closePrice: "ClosePrice",
        dividendPerShare: "DividendPerShare",
        dividendFiscalYear: "DividendYear",
        referenceFiscalPeriod: "FiscalYearQuarter",
      };
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

export function normalizeValuationPayload(
  snapshot: JsonSnapshot,
  config: OfficialSourceConfig,
): ParsedValuationSource {
  if (!Array.isArray(snapshot.payload) || snapshot.payload.length === 0) {
    fail("NO_DATA", `${config.exchange} 最新估值資料為空。`, {
      market: config.market,
      sourceUrl: config.sourceUrl,
    });
  }

  const fields = fieldsFor(config.market);
  const dataDates = new Set<string>();
  const rows: ValuationRow[] = [];
  for (const raw of snapshot.payload) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 估值資料包含非物件資料列。`, {
        market: config.market,
      });
    }
    const record = raw as Record<string, unknown>;
    const dataDate = normalizeCompactDate(record[fields.date], fields.date);
    const code = normalizeRequiredText(record[fields.code], fields.code, config.market);
    const name = normalizeRequiredText(record[fields.name], fields.name, config.market);
    dataDates.add(dataDate);
    if (!isEligibleCompanyIdentity(code, name)) continue;

    const missingCoreFields = [fields.pe, fields.pb, fields.dividendYield].filter(
      (field) => !hasOwn(record, field),
    );
    if (missingCoreFields.length > 0) {
      fail(
        "UPSTREAM_BAD_RESPONSE",
        `${config.exchange} 最新估值資料列缺少必要核心欄位。`,
        {
          market: config.market,
          sourceUrl: config.sourceUrl,
          companyCode: code,
          missingFields: missingCoreFields,
        },
      );
    }

    rows.push(
      buildValuationRow(config.market, code, name, {
        pe: record[fields.pe],
        pb: record[fields.pb],
        dividendYield: record[fields.dividendYield],
        closePrice: record[fields.closePrice],
        dividendPerShare: record[fields.dividendPerShare],
        dividendFiscalYear: record[fields.dividendFiscalYear],
        referenceFiscalPeriod: record[fields.referenceFiscalPeriod],
        provided: {
          closePrice: hasOwn(record, fields.closePrice),
          dividendPerShare: hasOwn(record, fields.dividendPerShare),
          dividendFiscalYear: hasOwn(record, fields.dividendFiscalYear),
          referenceFiscalPeriod: hasOwn(record, fields.referenceFiscalPeriod),
        },
      }),
    );
  }

  if (dataDates.size !== 1 || rows.length === 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 估值資料無法形成單一有效快照。`, {
      market: config.market,
      dataDates: [...dataDates],
      eligibleRowCount: rows.length,
    });
  }
  assertUniqueCodes(rows, `${config.exchange} 最新估值資料`);
  rows.sort((left, right) => left.code.localeCompare(right.code));
  const dataDate = [...dataDates][0];
  return {
    market: config.market,
    dataDate,
    rows,
    source: {
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      dataDate,
      rawCount: snapshot.payload.length,
      eligibleRowCount: rows.length,
    },
  };
}

function historicalSourceConfig(
  market: CompanyMarket,
  date: string,
): OfficialSourceConfig {
  const compact = date.replaceAll("-", "");
  if (market === "listed") {
    return {
      market,
      exchange: "TWSE",
      sourceName: "臺灣證券交易所－上市個股日本益比、殖利率及股價淨值比（依日期）",
      sourceUrl:
        `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_d?date=${compact}` +
        "&selectType=ALL&response=json",
    };
  }
  const slashDate = encodeURIComponent(date.replaceAll("-", "/"));
  return {
    market,
    exchange: "TPEx",
    sourceName: "證券櫃檯買賣中心－上櫃股票個股本益比、殖利率及股價淨值比（依日期）",
    sourceUrl:
      `https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=${slashDate}` +
      "&response=json",
  };
}

function canonicalHeader(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", "歷史估值欄名不是字串。", { value: raw });
  }
  return String(raw)
    .trim()
    .replace(/\s+/g, "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replaceAll("％", "%");
}

function fieldIndex(
  headers: string[],
  aliases: string[],
  required: boolean,
  field: string,
): number | undefined {
  const index = headers.findIndex((header) => aliases.includes(header));
  if (index >= 0) return index;
  if (required) {
    fail("UPSTREAM_BAD_RESPONSE", `歷史估值資料缺少 ${field} 欄位。`, {
      field,
      headers,
    });
  }
  return undefined;
}

function assertDeclaredRowCount(
  raw: unknown,
  actualCount: number,
  source: string,
): void {
  let declaredCount: number;
  if (typeof raw === "number") {
    declaredCount = raw;
  } else if (typeof raw === "string") {
    const normalized = raw.trim();
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(normalized)) {
      fail("UPSTREAM_BAD_RESPONSE", `${source}官方宣告筆數格式錯誤。`, {
        declaredCount: raw,
        actualCount,
      });
    }
    declaredCount = Number(normalized.replaceAll(",", ""));
  } else {
    fail("UPSTREAM_BAD_RESPONSE", `${source}缺少官方宣告筆數。`, {
      declaredCount: raw ?? null,
      actualCount,
    });
  }

  if (!Number.isSafeInteger(declaredCount) || declaredCount < 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${source}官方宣告筆數格式錯誤。`, {
      declaredCount: raw,
      actualCount,
    });
  }
  if (declaredCount !== actualCount) {
    fail("UPSTREAM_BAD_RESPONSE", `${source}官方宣告筆數與實際資料列數不符。`, {
      declaredCount,
      actualCount,
    });
  }
}

function extractHistoricalTable(
  payload: Record<string, unknown>,
  market: CompanyMarket,
): HistoricalTable {
  if (market === "listed") {
    if (!Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE 歷史估值 table 格式錯誤。");
    }
    return {
      fields: payload.fields,
      data: payload.data,
      declaredCount: payload.total,
    };
  }
  if (!Array.isArray(payload.tables)) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 歷史估值缺少 tables。");
  }
  if (payload.tables.length === 0) {
    fail("NO_DATA", "TPEx 指定日期沒有官方估值資料。");
  }
  const table = payload.tables.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const fields = (candidate as Record<string, unknown>).fields;
    return (
      Array.isArray(fields) &&
      fields.map(canonicalHeader).some((field) => field === "股票代號")
    );
  });
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    const allTablesEmpty = payload.tables.every((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return false;
      }
      const data = (candidate as Record<string, unknown>).data;
      return Array.isArray(data) && data.length === 0;
    });
    if (allTablesEmpty) {
      fail("NO_DATA", "TPEx 指定日期沒有官方估值資料。");
    }
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 歷史估值找不到個股估值 table。");
  }
  const record = table as Record<string, unknown>;
  if (!Array.isArray(record.fields) || !Array.isArray(record.data)) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 歷史估值 table 格式錯誤。");
  }
  return {
    fields: record.fields,
    data: record.data,
    declaredCount: record.totalCount,
  };
}

export function normalizeHistoricalValuationPayload(
  snapshot: JsonSnapshot,
  config: OfficialSourceConfig,
  requestedDate: string,
): ParsedValuationSource {
  if (
    !snapshot.payload ||
    typeof snapshot.payload !== "object" ||
    Array.isArray(snapshot.payload)
  ) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 歷史估值資料不是物件。`, {
      sourceUrl: config.sourceUrl,
    });
  }
  const payload = snapshot.payload as Record<string, unknown>;
  const stat = typeof payload.stat === "string" ? payload.stat.trim() : "";
  if (stat.toLowerCase() !== "ok") {
    fail("NO_DATA", `${config.exchange} 指定日期沒有官方估值資料。`, {
      market: config.market,
      requestedDate,
      upstreamStatus: stat || null,
    });
  }
  const responseDate = normalizeCompactDate(payload.date, "response.date");
  if (responseDate !== requestedDate) {
    fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 歷史估值回傳了不同日期。`, {
      market: config.market,
      requestedDate,
      responseDate,
      sourceUrl: config.sourceUrl,
    });
  }

  const table = extractHistoricalTable(payload, config.market);
  assertDeclaredRowCount(
    table.declaredCount,
    table.data.length,
    `${config.exchange} 歷史估值 table `,
  );
  if (table.data.length === 0) {
    fail("NO_DATA", `${config.exchange} 指定日期沒有官方估值資料。`, {
      market: config.market,
      requestedDate,
    });
  }
  const headers = table.fields.map(canonicalHeader);
  const codeIndex = fieldIndex(
    headers,
    ["證券代號", "股票代號"],
    true,
    "公司代號",
  ) as number;
  const nameIndex = fieldIndex(
    headers,
    ["證券名稱", "公司名稱"],
    true,
    "公司名稱",
  ) as number;
  const peIndex = fieldIndex(headers, ["本益比"], true, "本益比") as number;
  const pbIndex = fieldIndex(
    headers,
    ["股價淨值比"],
    true,
    "股價淨值比",
  ) as number;
  const yieldIndex = fieldIndex(
    headers,
    ["殖利率(%)"],
    true,
    "殖利率(%)",
  ) as number;
  const closeIndex = fieldIndex(headers, ["收盤價"], false, "收盤價");
  const dividendPerShareIndex = fieldIndex(
    headers,
    ["每股股利"],
    false,
    "每股股利",
  );
  const dividendYearIndex = fieldIndex(
    headers,
    ["股利年度"],
    false,
    "股利年度",
  );
  const fiscalPeriodIndex = fieldIndex(
    headers,
    ["財報年/季", "財報年季"],
    false,
    "財報年/季",
  );

  const rows: ValuationRow[] = [];
  for (const rawRow of table.data) {
    if (!Array.isArray(rawRow)) {
      fail("UPSTREAM_BAD_RESPONSE", `${config.exchange} 歷史估值包含非陣列資料列。`, {
        market: config.market,
      });
    }
    const code = normalizeRequiredText(
      rawRow[codeIndex],
      headers[codeIndex],
      config.market,
    );
    const name = normalizeRequiredText(
      rawRow[nameIndex],
      headers[nameIndex],
      config.market,
    );
    if (!isEligibleCompanyIdentity(code, name)) continue;
    rows.push(
      buildValuationRow(config.market, code, name, {
        pe: rawRow[peIndex],
        pb: rawRow[pbIndex],
        dividendYield: rawRow[yieldIndex],
        closePrice: closeIndex === undefined ? undefined : rawRow[closeIndex],
        dividendPerShare:
          dividendPerShareIndex === undefined
            ? undefined
            : rawRow[dividendPerShareIndex],
        dividendFiscalYear:
          dividendYearIndex === undefined ? undefined : rawRow[dividendYearIndex],
        referenceFiscalPeriod:
          fiscalPeriodIndex === undefined ? undefined : rawRow[fiscalPeriodIndex],
        provided: {
          closePrice: closeIndex !== undefined,
          dividendPerShare: dividendPerShareIndex !== undefined,
          dividendFiscalYear: dividendYearIndex !== undefined,
          referenceFiscalPeriod: fiscalPeriodIndex !== undefined,
        },
      }),
    );
  }
  if (rows.length === 0) {
    fail("NO_DATA", `${config.exchange} 指定日期沒有合格公司估值資料。`, {
      market: config.market,
      requestedDate,
    });
  }
  assertUniqueCodes(rows, `${config.exchange} ${requestedDate} 歷史估值資料`);
  rows.sort((left, right) => left.code.localeCompare(right.code));
  return {
    market: config.market,
    dataDate: responseDate,
    rows,
    source: {
      market: config.market,
      exchange: config.exchange,
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      dataDate: responseDate,
      rawCount: table.data.length,
      eligibleRowCount: rows.length,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知補強錯誤";
}

function uniqueValuationSources(sources: ValuationSource[]): ValuationSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.market}\u0000${source.dataDate}\u0000${source.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function discoveryCoverage(
  discovery: ParsedValuationSource,
  candidate: ParsedValuationSource,
): number {
  const discoveryCodes = new Set(discovery.rows.map((row) => row.code));
  const candidateCodes = new Set(candidate.rows.map((row) => row.code));
  if (discoveryCodes.size === 0) return 0;
  const matched = [...discoveryCodes].filter((code) => candidateCodes.has(code)).length;
  return matched / discoveryCodes.size;
}

export class ValuationClient {
  private readonly loader: OfficialJsonLoader;

  constructor(
    fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly companyMaster: CurrentCompanyMasterLike = companyMasterClient,
    options: OfficialMarketClientOptions = {},
  ) {
    this.loader = new OfficialJsonLoader(fetchImpl, now, options);
  }

  private async getHistoricalMarket(
    market: CompanyMarket,
    date: string,
  ): Promise<ParsedValuationSource> {
    const config = historicalSourceConfig(market, date);
    return normalizeHistoricalValuationPayload(
      await this.loader.get(config),
      config,
      date,
    );
  }

  private async enrichLatestSource(
    discovery: ParsedValuationSource,
  ): Promise<LatestSourceResolution> {
    try {
      const result = await this.getHistoricalMarket(
        discovery.market,
        discovery.dataDate,
      );
      const coverage = discoveryCoverage(discovery, result);
      if (coverage < 0.95) {
        fail(
          "UPSTREAM_BAD_RESPONSE",
          `${result.source.exchange} 依日期估值補強資料相對 latest OpenAPI 覆蓋不足。`,
          { market: discovery.market, coverage },
        );
      }
      return { result };
    } catch (error) {
      return { result: discovery, fallbackReason: errorMessage(error) };
    }
  }

  async getDailyMarketValuation(
    query: DailyMarketValuationQuery,
  ): Promise<DailyMarketValuationResult> {
    const markets = selectedMarkets(query.market);
    validateQuery(query, this.now());
    const companyCodes = normalizeRequestedCodes(query.companyCodes);

    let sourceResults: ParsedValuationSource[];
    let lineageSources: ValuationSource[];
    let currentMasterCompanies: MasterCompany[] = [];
    const fallbackReasons: Array<{ market: CompanyMarket; reason: string }> = [];
    if (query.date === "latest") {
      const [discoveries, master] = await Promise.all([
        Promise.all(
          markets.map(async (market) => {
            const config = SOURCE_CONFIGS[market];
            return normalizeValuationPayload(await this.loader.get(config), config);
          }),
        ),
        this.companyMaster.listCompanies({
          market: query.market,
          includeFinancial: true,
          includeKy: true,
        }),
      ]);
      const discoveryDates = [...new Set(discoveries.map((result) => result.dataDate))];
      if (discoveryDates.length !== 1) {
        fail(
          "NO_DATA",
          "上市與上櫃最新估值資料日期不一致，請稍後重試或分市場查詢。",
          {
            sourceDates: discoveries.map((result) => ({
              market: result.market,
              dataDate: result.dataDate,
            })),
          },
        );
      }
      const resolutions = await Promise.all(
        discoveries.map((discovery) => this.enrichLatestSource(discovery)),
      );
      sourceResults = resolutions.map((resolution) => resolution.result);
      lineageSources = uniqueValuationSources(
        discoveries.flatMap((discovery, index) => [
          discovery.source,
          resolutions[index].result.source,
        ]),
      );
      resolutions.forEach((resolution, index) => {
        if (resolution.fallbackReason) {
          fallbackReasons.push({
            market: discoveries[index].market,
            reason: resolution.fallbackReason,
          });
        }
      });
      currentMasterCompanies = master.companies;
    } else {
      sourceResults = await Promise.all(
        markets.map((market) => this.getHistoricalMarket(market, query.date)),
      );
      lineageSources = sourceResults.map((result) => result.source);
    }

    const dates = [...new Set(sourceResults.map((result) => result.dataDate))];
    if (dates.length !== 1) {
      fail(
        "NO_DATA",
        query.date === "latest"
          ? "上市與上櫃最新估值資料日期不一致，請稍後重試或分市場查詢。"
          : "上市與上櫃指定日期的估值資料日期不一致。",
        {
          sourceDates: sourceResults.map((result) => ({
            market: result.market,
            dataDate: result.dataDate,
          })),
        },
      );
    }

    const sourceRows = sourceResults.flatMap((result) => result.rows);
    assertUniqueCodes(
      sourceRows,
      query.date === "latest" ? "上市與上櫃最新估值資料" : "上市與上櫃歷史估值資料",
    );
    let reconciliation: DailyMarketValuationResult["reconciliation"] = [];
    let universeCoverageVerified = false;
    let rows: ValuationRow[];
    if (query.date === "latest") {
      const reconciled = sourceResults.map((source) =>
        reconcileMarket(
          source.market,
          source.rows,
          currentMasterCompanies,
          query.universePolicy,
        ),
      );
      reconciliation = reconciled.map((value) => value.reconciliation);
      universeCoverageVerified = reconciliation.every(
        (value) => value.coverageComplete,
      );
      const coverageSufficient = reconciliation.every(
        (value) => value.matchRatio >= 0.95,
      );
      if (
        (query.universePolicy === "strict_current_master" &&
          !universeCoverageVerified) ||
        (query.universePolicy === "compatible" && !coverageSufficient)
      ) {
        fail(
          "INCOMPLETE_COVERAGE",
          query.universePolicy === "strict_current_master"
            ? "最新估值資料未與目前 heuristic-gated 公司母體完全吻合。"
            : "最新估值資料與目前公司母體吻合率低於 95%，疑似來源截斷。",
          { universePolicy: query.universePolicy, reconciliation },
        );
      }
      rows = reconciled.flatMap((value) => value.acceptedRows);
    } else {
      rows = sourceRows;
    }

    if (companyCodes) {
      const selected = new Set(companyCodes);
      rows = rows.filter((row) => selected.has(row.code));
    }
    rows.sort((left, right) => left.code.localeCompare(right.code));
    const returnedCodes = new Set(rows.map((row) => row.code));
    const missingCompanyCodes = companyCodes
      ? companyCodes.filter((code) => !returnedCodes.has(code))
      : [];
    if (rows.length === 0) {
      fail("NO_DATA", "指定市場、日期與公司條件查無官方估值資料。", {
        market: query.market,
        date: query.date,
        missingCompanyCodes,
      });
    }

    const warnings = [
      query.date === "latest"
        ? "latest 先由官方 OpenAPI 決定最近估值日，再以同日官方依日期端點補齊欄位；不是盤中即時估值。"
        : "歷史估值採 exact-date 語意；假日不會退回前一交易日，並以官方四碼公司列辨識歷史母體。",
      "本益比或股價淨值比在不具計算意義時可能為空白或 N/A；此類值回傳 null，不轉成 0。",
      "殖利率沿用官方百分比口徑；本工具不自行重算財報分母或股利。",
      "請依 valueStatus 與 rawValue 區分官方未提供欄位、無計算意義 marker 與無法解析值。",
    ];
    if (fallbackReasons.length > 0) {
      warnings.push(
        `以下 latest 日端點補強失敗，已保留 OpenAPI 基本估值並將未提供的新欄位標示為 not_provided_by_source：${fallbackReasons
          .map((item) => `${item.market}（${item.reason}）`)
          .join("；")}。`,
      );
    }
    if (query.date === "latest" && !universeCoverageVerified) {
      warnings.push(
        "官方估值列與目前公司母體未完全吻合；請檢查 reconciliation，不得將 compatible 結果宣稱為完整母體。",
      );
    }
    if (query.date !== "latest") {
      warnings.push(
        "歷史結果不以目前公司 master 驗證或過濾；reconciliation 為空且 universeCoverageVerified=false，避免存活者偏誤。",
      );
    }
    if (missingCompanyCodes.length > 0) {
      warnings.push(
        `以下指定代號未出現在本次結果：${missingCompanyCodes.join("、")}。`,
      );
    }
    const invalidFieldCount = rows.reduce(
      (sum, row) =>
        sum +
        Object.values(row.valueStatus).filter((status) => status === "invalid_upstream")
          .length,
      0,
    );
    if (invalidFieldCount > 0) {
      warnings.push(
        `本次有 ${invalidFieldCount} 個估值欄位為無法解析的官方值，已回傳 null 與 invalid_upstream。`,
      );
    }

    return {
      query: {
        ...query,
        ...(companyCodes ? { companyCodes } : {}),
      },
      dataDate: dates[0],
      currency: "TWD",
      classificationPolicy:
        query.date === "latest"
          ? query.universePolicy === "strict_current_master"
            ? "current_master_strict"
            : "current_master_with_code_fallback"
          : "historical_code_rule",
      coverageComplete: true,
      universeCoverageVerified,
      selectionComplete: missingCompanyCodes.length === 0,
      missingCompanyCodes,
      reconciliation,
      counts: {
        raw: sourceResults.reduce((sum, result) => sum + result.source.rawCount, 0),
        returned: rows.length,
        withPe: rows.filter((row) => row.peRatio !== null).length,
        withPb: rows.filter((row) => row.priceToBookRatio !== null).length,
        withDividendYield: rows.filter((row) => row.dividendYieldPercent !== null)
          .length,
        withClosePrice: rows.filter((row) => row.closePriceTwd !== null).length,
        withDividendPerShare: rows.filter(
          (row) => row.dividendPerShareTwd !== null,
        ).length,
        withDividendFiscalYear: rows.filter(
          (row) => row.dividendFiscalYear !== null,
        ).length,
        withReferenceFiscalPeriod: rows.filter(
          (row) => row.referenceFiscalPeriod !== null,
        ).length,
      },
      rows,
      sources: lineageSources,
      warnings,
    };
  }
}

export const valuationClient = new ValuationClient();
