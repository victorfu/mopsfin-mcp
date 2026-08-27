import { createHash } from "node:crypto";

import type { CompanyMarket } from "@/lib/company-master/types";
import {
  fail,
  isEligibleCompanyIdentity,
  normalizeCompactDate,
  normalizeRequiredText,
  OfficialJsonLoader,
  parseOfficialNumber,
  type JsonSnapshot,
  type OfficialJsonLoaderOptions,
  type OfficialSourceConfig,
} from "@/lib/market-data/client-utils";
import { AbsoluteDeadline } from "@/lib/upstream/reliability";

import type {
  CorporateActionAdjustmentReason,
  CorporateActionCoverage,
  CorporateActionCoverageGap,
  CorporateActionEvent,
  CorporateActionFamily,
  CorporateActionHistory,
  CorporateActionHistoryOptions,
  CorporateActionKind,
  CorporateActionSource,
} from "./types";

interface RangeRequest {
  market: CompanyMarket;
  family: CorporateActionFamily;
  supportedFrom: string;
  queryStart: string;
  queryEnd: string;
  config: OfficialSourceConfig;
}

interface NormalizedRange {
  events: CorporateActionEvent[];
  source: CorporateActionSource;
}

interface ParsedTable {
  fields: unknown[];
  data: unknown[];
  declaredRowCount: number | null;
}

interface SelectedDetailFingerprintEvidence {
  companyCode: string;
  effectiveDate: string;
  status: "fulfilled" | "rejected";
  cashDividendPerShareTwd: number | null;
  priceIndexAdjustmentFactor: number | null;
  adjustmentStatus: CorporateActionEvent["adjustmentStatus"];
  adjustmentReason: CorporateActionEvent["adjustmentReason"];
}

interface AdjustmentInput {
  kind: CorporateActionKind;
  priorCloseTwd: number | null;
  referencePriceTwd: number | null;
  cashDividendPerShareTwd: number | null;
  combinedDetailRequested: boolean;
}

const FAMILY_ORDER: CorporateActionFamily[] = [
  "ex_right_dividend",
  "capital_reduction",
  "par_value_change",
];

const SUPPORTED_FROM: Record<
  CompanyMarket,
  Record<CorporateActionFamily, string>
> = {
  listed: {
    ex_right_dividend: "2003-05-05",
    capital_reduction: "2011-01-01",
    par_value_change: "2019-09-09",
  },
  otc: {
    ex_right_dividend: "2008-01-02",
    capital_reduction: "2013-01-01",
    par_value_change: "2019-09-09",
  },
};

const SOURCE_NAMES: Record<
  CompanyMarket,
  Record<CorporateActionFamily, string>
> = {
  listed: {
    ex_right_dividend: "臺灣證券交易所－除權除息計算結果表",
    capital_reduction: "臺灣證券交易所－股票減資恢復買賣參考價格",
    par_value_change: "臺灣證券交易所－變更股票面額恢復買賣參考價格",
  },
  otc: {
    ex_right_dividend: "證券櫃檯買賣中心－除權除息計算結果表",
    capital_reduction: "證券櫃檯買賣中心－減資恢復買賣參考價格",
    par_value_change: "證券櫃檯買賣中心－變更股票面額恢復買賣參考價格",
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_CODE = /^[1-9]\d{3}$/;
const OFFICIAL_SECURITY_CODE = /^[0-9A-Z]{4,10}$/i;

function parseIsoDate(value: string, field: string): Date {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    fail("INVALID_ARGUMENT", `${field} 必須是 YYYY-MM-DD。`, {
      field,
      value,
    });
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    fail("INVALID_ARGUMENT", `${field} 不是有效日期。`, { field, value });
  }
  return parsed;
}

function previousDate(value: string): string {
  const date = parseIsoDate(value, "supportedFrom");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function encodedSlashDate(value: string): string {
  return encodeURIComponent(value.replaceAll("-", "/"));
}

function normalizeActionDate(raw: unknown, field: string): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", `官方資料的 ${field} 不是日期字串。`, {
      field,
      value: raw,
    });
  }
  const compact = String(raw)
    .trim()
    .replace(/[年/月日.\-]/g, "");
  return normalizeCompactDate(compact, field);
}

function normalizeCompanyCodes(
  companyCodes: string[] | undefined,
): string[] | null {
  if (companyCodes === undefined) return null;
  if (
    !Array.isArray(companyCodes) ||
    companyCodes.length < 1 ||
    companyCodes.length > 500
  ) {
    fail("INVALID_ARGUMENT", "companyCodes 必須包含 1 至 500 個四碼公司代號。");
  }
  const normalized = companyCodes.map((value) =>
    typeof value === "string" ? value.trim() : String(value),
  );
  if (normalized.some((value) => !COMPANY_CODE.test(value))) {
    fail("INVALID_ARGUMENT", "companyCodes 只能包含四碼上市櫃公司代號。", {
      companyCodes,
    });
  }
  if (new Set(normalized).size !== normalized.length) {
    fail("INVALID_ARGUMENT", "companyCodes 不得包含重複代號。", {
      companyCodes,
    });
  }
  return normalized.sort();
}

function validateMarket(market: CompanyMarket): void {
  if (market !== "listed" && market !== "otc") {
    fail("INVALID_ARGUMENT", "market 必須是 listed 或 otc。", { market });
  }
}

function validateRange(startDate: string, endDate: string): void {
  parseIsoDate(startDate, "startDate");
  parseIsoDate(endDate, "endDate");
  if (startDate > endDate) {
    fail("INVALID_ARGUMENT", "startDate 不得晚於 endDate。", {
      startDate,
      endDate,
    });
  }
}

function canonicalHeader(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", "公司行動官方欄名不是字串。", {
      value: raw,
    });
  }
  return String(raw)
    .trim()
    .replace(/\s+/g, "")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replaceAll("／", "/");
}

function requiredField(
  headers: string[],
  aliases: string[],
  field: string,
  sourceName: string,
): number {
  const canonicalAliases = aliases.map(canonicalHeader);
  const index = headers.findIndex((header) => canonicalAliases.includes(header));
  if (index < 0) {
    fail("UPSTREAM_BAD_RESPONSE", `${sourceName}缺少必要欄位 ${field}。`, {
      field,
      headers,
    });
  }
  return index;
}

function payloadObject(snapshot: JsonSnapshot, sourceName: string): Record<string, unknown> {
  if (
    !snapshot.payload ||
    typeof snapshot.payload !== "object" ||
    Array.isArray(snapshot.payload)
  ) {
    fail("UPSTREAM_BAD_RESPONSE", `${sourceName}回應不是 JSON 物件。`);
  }
  return snapshot.payload as Record<string, unknown>;
}

function assertOk(payload: Record<string, unknown>, sourceName: string): void {
  const status = typeof payload.stat === "string" ? payload.stat.trim() : "";
  if (status.toLowerCase() !== "ok") {
    fail("UPSTREAM_BAD_RESPONSE", `${sourceName}回傳非成功狀態。`, {
      upstreamStatus: status || null,
    });
  }
}

function declaredRowCount(
  raw: unknown,
  actualCount: number,
  sourceName: string,
): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else if (typeof raw === "string") {
    const value = raw.trim();
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) {
      fail("UPSTREAM_BAD_RESPONSE", `${sourceName}官方宣告筆數格式錯誤。`, {
        declaredRowCount: raw,
      });
    }
    parsed = Number(value.replaceAll(",", ""));
  } else {
    fail("UPSTREAM_BAD_RESPONSE", `${sourceName}官方宣告筆數格式錯誤。`, {
      declaredRowCount: raw,
    });
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed !== actualCount) {
    fail("UPSTREAM_BAD_RESPONSE", `${sourceName}官方宣告筆數與實際資料列數不符。`, {
      declaredRowCount: raw,
      actualCount,
    });
  }
  return parsed;
}

function parsePositivePrice(raw: unknown, field: string): number | null {
  const parsed = parseOfficialNumber(raw);
  if (parsed.invalid) {
    fail("UPSTREAM_BAD_RESPONSE", `公司行動官方欄位 ${field} 不是有效數字。`, {
      field,
      value: raw,
    });
  }
  if (parsed.missing || parsed.value === null) return null;
  if (parsed.value <= 0) {
    fail("UPSTREAM_BAD_RESPONSE", `公司行動官方欄位 ${field} 必須大於零。`, {
      field,
      value: raw,
    });
  }
  return parsed.value;
}

function parseNonNegativeNumber(raw: unknown, field: string): number | null {
  const parsed = parseOfficialNumber(raw);
  if (parsed.invalid) {
    fail("UPSTREAM_BAD_RESPONSE", `公司行動官方欄位 ${field} 不是有效數字。`, {
      field,
      value: raw,
    });
  }
  if (parsed.missing || parsed.value === null) return null;
  if (parsed.value < 0) {
    fail("UPSTREAM_BAD_RESPONSE", `公司行動官方欄位 ${field} 不得小於零。`, {
      field,
      value: raw,
    });
  }
  return parsed.value;
}

function parseDetailCash(raw: unknown): number {
  if (typeof raw !== "string" && typeof raw !== "number") {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 權息詳細資料缺少每股現金股利。", {
      value: raw,
    });
  }
  const normalized = String(raw).replaceAll(",", "").trim();
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*元(?:[／/]股)?$/.exec(
    normalized,
  );
  if (!match) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 權息詳細資料的每股現金股利格式錯誤。", {
      value: raw,
    });
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 權息詳細資料的每股現金股利無效。", {
      value: raw,
    });
  }
  return value;
}

function normalizeIdentity(
  rawCode: unknown,
  rawName: unknown,
  market: CompanyMarket,
): { companyCode: string; name: string } | null {
  const companyCode = normalizeRequiredText(rawCode, "公司代號", market);
  const name = normalizeRequiredText(rawName, "公司名稱", market);
  if (!OFFICIAL_SECURITY_CODE.test(companyCode)) {
    fail("UPSTREAM_BAD_RESPONSE", "公司行動官方資料含無法辨識的證券代號。", {
      market,
      companyCode,
      name,
    });
  }
  if (!isEligibleCompanyIdentity(companyCode, name)) return null;
  return { companyCode, name };
}

function normalizeExRightKind(raw: unknown, market: CompanyMarket): {
  kind: CorporateActionKind;
  rawType: string;
} {
  const rawType = normalizeRequiredText(raw, "權/息", market);
  const canonical = rawType.replace(/\s+/g, "").replace(/^除/, "");
  if (canonical === "息") return { kind: "cash_dividend", rawType };
  if (canonical === "權") return { kind: "stock_rights", rawType };
  if (canonical === "權息") return { kind: "rights_and_dividend", rawType };
  fail("UPSTREAM_BAD_RESPONSE", "官方除權息資料含未知權/息分類。", {
    market,
    rawType,
  });
}

function checkedFactor(value: number, context: Record<string, unknown>): number {
  if (!Number.isFinite(value) || value <= 0) {
    fail("UPSTREAM_BAD_RESPONSE", "公司行動價格指數調整因子必須為正有限數。", {
      ...context,
      factor: value,
    });
  }
  return value;
}

function adjustment(input: AdjustmentInput): {
  priceIndexAdjustmentFactor: number | null;
  adjustmentStatus: "available" | "unavailable";
  adjustmentReason: CorporateActionAdjustmentReason;
} {
  if (input.kind === "cash_dividend") {
    if (input.cashDividendPerShareTwd === null) {
      return {
        priceIndexAdjustmentFactor: null,
        adjustmentStatus: "unavailable",
        adjustmentReason: "missing_required_official_value",
      };
    }
    return {
      priceIndexAdjustmentFactor: 1,
      adjustmentStatus: "available",
      adjustmentReason: "cash_only_price_index_factor_is_one",
    };
  }

  if (input.kind === "rights_and_dividend" && !input.combinedDetailRequested) {
    return {
      priceIndexAdjustmentFactor: null,
      adjustmentStatus: "unavailable",
      adjustmentReason: "twse_combined_event_detail_not_requested",
    };
  }

  if (
    input.priorCloseTwd === null ||
    input.referencePriceTwd === null ||
    (input.kind === "rights_and_dividend" &&
      input.cashDividendPerShareTwd === null)
  ) {
    return {
      priceIndexAdjustmentFactor: null,
      adjustmentStatus: "unavailable",
      adjustmentReason: "missing_required_official_value",
    };
  }

  if (
    input.kind === "stock_rights" ||
    input.kind === "rights_and_dividend"
  ) {
    const cashDividend = input.cashDividendPerShareTwd ?? 0;
    const denominator = input.priorCloseTwd - cashDividend;
    return {
      priceIndexAdjustmentFactor: checkedFactor(
        input.referencePriceTwd / denominator,
        { kind: input.kind, denominator },
      ),
      adjustmentStatus: "available",
      adjustmentReason:
        input.kind === "stock_rights"
          ? "official_reference_price_divided_by_prior_close"
          : "official_reference_price_divided_by_prior_close_less_cash_dividend",
    };
  }

  return {
    priceIndexAdjustmentFactor: checkedFactor(
      input.referencePriceTwd / input.priorCloseTwd,
      { kind: input.kind },
    ),
    adjustmentStatus: "available",
    adjustmentReason: "official_reference_price_divided_by_prior_close",
  };
}

function buildEvent(input: {
  companyCode: string;
  name: string;
  market: CompanyMarket;
  effectiveDate: string;
  kind: CorporateActionKind;
  priorCloseTwd: number | null;
  referencePriceTwd: number | null;
  cashDividendPerShareTwd: number | null;
  sourceFamily: CorporateActionFamily;
  sourceUrl: string;
  rawType: string;
  combinedDetailRequested?: boolean;
}): CorporateActionEvent {
  const calculated = adjustment({
    kind: input.kind,
    priorCloseTwd: input.priorCloseTwd,
    referencePriceTwd: input.referencePriceTwd,
    cashDividendPerShareTwd: input.cashDividendPerShareTwd,
    combinedDetailRequested:
      input.combinedDetailRequested ?? input.market === "otc",
  });
  return {
    companyCode: input.companyCode,
    name: input.name,
    market: input.market,
    effectiveDate: input.effectiveDate,
    kind: input.kind,
    priorCloseTwd: input.priorCloseTwd,
    referencePriceTwd: input.referencePriceTwd,
    cashDividendPerShareTwd: input.cashDividendPerShareTwd,
    ...calculated,
    shareCountChanged: input.kind !== "cash_dividend",
    sourceFamily: input.sourceFamily,
    sourceUrl: input.sourceUrl,
    rawType: input.rawType,
  };
}

function assertDateInRange(
  date: string,
  request: RangeRequest,
  rowIndex: number,
): void {
  if (date < request.queryStart || date > request.queryEnd) {
    fail("UPSTREAM_BAD_RESPONSE", "公司行動官方資料列日期超出查詢範圍。", {
      market: request.market,
      family: request.family,
      date,
      queryStart: request.queryStart,
      queryEnd: request.queryEnd,
      rowIndex,
    });
  }
}

function assertTwseResponseRange(
  payload: Record<string, unknown>,
  request: RangeRequest,
): { responseStart: string; responseEnd: string } {
  let rawStart: unknown;
  let rawEnd: unknown;
  if (request.family === "par_value_change") {
    const params = payload.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE 面額變更回應缺少查詢參數識別。", {
        sourceUrl: request.config.sourceUrl,
      });
    }
    rawStart = (params as Record<string, unknown>).startDate;
    rawEnd = (params as Record<string, unknown>).endDate;
  } else {
    rawStart = payload.strDate;
    rawEnd = payload.endDate;
  }
  const responseStart = normalizeActionDate(rawStart, "response.startDate");
  const responseEnd = normalizeActionDate(rawEnd, "response.endDate");
  if (
    responseStart !== request.queryStart ||
    responseEnd !== request.queryEnd
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 公司行動回傳了不同查詢日期範圍。", {
      family: request.family,
      queryStart: request.queryStart,
      queryEnd: request.queryEnd,
      responseStart,
      responseEnd,
    });
  }
  return { responseStart, responseEnd };
}

function twseTable(
  payload: Record<string, unknown>,
  request: RangeRequest,
): ParsedTable {
  if (!Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 公司行動回應缺少 fields/data。", {
      family: request.family,
      sourceUrl: request.config.sourceUrl,
    });
  }
  const count = declaredRowCount(
    payload.totalCount ?? payload.total,
    payload.data.length,
    request.config.sourceName,
  );
  return { fields: payload.fields, data: payload.data, declaredRowCount: count };
}

function assertTpexResponseRange(
  payload: Record<string, unknown>,
  request: RangeRequest,
): { responseStart: string; responseEnd: string } {
  if (typeof payload.date !== "string") {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 公司行動回應缺少日期範圍識別。", {
      family: request.family,
    });
  }
  const pieces = payload.date.split("~");
  if (pieces.length !== 2) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 公司行動回應日期範圍格式錯誤。", {
      family: request.family,
      date: payload.date,
    });
  }
  const responseStart = normalizeActionDate(pieces[0], "response.startDate");
  const responseEnd = normalizeActionDate(pieces[1], "response.endDate");
  if (
    responseStart !== request.queryStart ||
    responseEnd !== request.queryEnd
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 公司行動回傳了不同查詢日期範圍。", {
      family: request.family,
      queryStart: request.queryStart,
      queryEnd: request.queryEnd,
      responseStart,
      responseEnd,
    });
  }
  return { responseStart, responseEnd };
}

function tpexTable(
  payload: Record<string, unknown>,
  request: RangeRequest,
): ParsedTable {
  if (!Array.isArray(payload.tables) || payload.tables.length === 0) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 公司行動回應缺少 tables。", {
      family: request.family,
      sourceUrl: request.config.sourceUrl,
    });
  }
  const candidates = payload.tables.filter(
    (table): table is Record<string, unknown> =>
      Boolean(table) && typeof table === "object" && !Array.isArray(table),
  );
  const table = candidates.find((candidate) => {
    if (!Array.isArray(candidate.fields) || !Array.isArray(candidate.data)) {
      return false;
    }
    const headers = candidate.fields.map(canonicalHeader);
    return (
      headers.some((header) =>
        ["除權息日期", "恢復買賣日期"].includes(header),
      ) &&
      headers.some((header) =>
        ["代號", "股票代號", "證券代號"].includes(header),
      )
    );
  });
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.data)) {
    fail("UPSTREAM_BAD_RESPONSE", "TPEx 公司行動找不到必要資料表。", {
      family: request.family,
    });
  }
  const count = declaredRowCount(
    table.totalCount,
    table.data.length,
    request.config.sourceName,
  );
  return { fields: table.fields, data: table.data, declaredRowCount: count };
}

function normalizeTwseRange(
  snapshot: JsonSnapshot,
  request: RangeRequest,
): NormalizedRange {
  const payload = payloadObject(snapshot, request.config.sourceName);
  assertOk(payload, request.config.sourceName);
  const range = assertTwseResponseRange(payload, request);
  const table = twseTable(payload, request);
  const headers = table.fields.map(canonicalHeader);
  const dateIndex = requiredField(
    headers,
    request.family === "ex_right_dividend"
      ? ["資料日期", "除權息日期"]
      : ["恢復買賣日期"],
    "生效日期",
    request.config.sourceName,
  );
  const codeIndex = requiredField(
    headers,
    ["股票代號", "證券代號", "代號"],
    "公司代號",
    request.config.sourceName,
  );
  const nameIndex = requiredField(
    headers,
    ["股票名稱", "證券名稱", "名稱"],
    "公司名稱",
    request.config.sourceName,
  );

  let priorIndex: number;
  let referenceIndex: number;
  let typeIndex: number | null = null;
  let cashIndex: number | null = null;
  if (request.family === "ex_right_dividend") {
    priorIndex = requiredField(
      headers,
      ["除權息前收盤價"],
      "除權息前收盤價",
      request.config.sourceName,
    );
    referenceIndex = requiredField(
      headers,
      ["除權息參考價"],
      "除權息參考價",
      request.config.sourceName,
    );
    typeIndex = requiredField(
      headers,
      ["權/息"],
      "權/息",
      request.config.sourceName,
    );
    cashIndex = requiredField(
      headers,
      ["權值+息值"],
      "權值+息值",
      request.config.sourceName,
    );
  } else {
    priorIndex = requiredField(
      headers,
      ["停止買賣前收盤價格", "最後交易日之收盤價格"],
      "停止買賣前收盤價格",
      request.config.sourceName,
    );
    referenceIndex = requiredField(
      headers,
      ["恢復買賣參考價", "減資恢復買賣開始日參考價格", "恢復買賣開始參考價"],
      "恢復買賣參考價",
      request.config.sourceName,
    );
    if (request.family === "capital_reduction") {
      typeIndex = requiredField(
        headers,
        ["減資原因"],
        "減資原因",
        request.config.sourceName,
      );
    }
  }

  const events: CorporateActionEvent[] = [];
  table.data.forEach((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow)) {
      fail("UPSTREAM_BAD_RESPONSE", "TWSE 公司行動包含非陣列資料列。", {
        family: request.family,
        rowIndex,
      });
    }
    const effectiveDate = normalizeActionDate(rawRow[dateIndex], "生效日期");
    assertDateInRange(effectiveDate, request, rowIndex);
    const identity = normalizeIdentity(
      rawRow[codeIndex],
      rawRow[nameIndex],
      request.market,
    );
    if (!identity) return;
    const priorCloseTwd = parsePositivePrice(
      rawRow[priorIndex],
      headers[priorIndex],
    );
    const referencePriceTwd = parsePositivePrice(
      rawRow[referenceIndex],
      headers[referenceIndex],
    );

    if (request.family === "ex_right_dividend") {
      const normalizedType = normalizeExRightKind(rawRow[typeIndex as number], request.market);
      const summaryValue = parseNonNegativeNumber(
        rawRow[cashIndex as number],
        headers[cashIndex as number],
      );
      events.push(
        buildEvent({
          ...identity,
          market: request.market,
          effectiveDate,
          kind: normalizedType.kind,
          priorCloseTwd,
          referencePriceTwd,
          cashDividendPerShareTwd:
            normalizedType.kind === "cash_dividend"
              ? summaryValue
              : normalizedType.kind === "stock_rights"
                ? 0
                : null,
          sourceFamily: request.family,
          sourceUrl: request.config.sourceUrl,
          rawType: normalizedType.rawType,
          combinedDetailRequested: false,
        }),
      );
      return;
    }

    const kind: CorporateActionKind =
      request.family === "capital_reduction"
        ? "capital_reduction"
        : "par_value_change";
    const rawType =
      typeIndex === null
        ? "變更股票面額"
        : normalizeRequiredText(rawRow[typeIndex], headers[typeIndex], request.market);
    events.push(
      buildEvent({
        ...identity,
        market: request.market,
        effectiveDate,
        kind,
        priorCloseTwd,
        referencePriceTwd,
        cashDividendPerShareTwd: null,
        sourceFamily: request.family,
        sourceUrl: request.config.sourceUrl,
        rawType,
      }),
    );
  });

  const collapsedEvents = collapseDuplicateEvents(events);
  return {
    events: collapsedEvents,
    source: {
      market: request.market,
      exchange: "TWSE",
      family: request.family,
      scope: "range_summary",
      sourceName: request.config.sourceName,
      sourceUrl: request.config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      supportedFrom: request.supportedFrom,
      queryStart: request.queryStart,
      queryEnd: request.queryEnd,
      responseStart: range.responseStart,
      responseEnd: range.responseEnd,
      rawRowCount: table.data.length,
      companyEventCount: collapsedEvents.length,
      officialDeclaredRowCount: table.declaredRowCount,
      officialDeclaredRowCountAvailable: table.declaredRowCount !== null,
    },
  };
}

function normalizeTpexRange(
  snapshot: JsonSnapshot,
  request: RangeRequest,
): NormalizedRange {
  const payload = payloadObject(snapshot, request.config.sourceName);
  assertOk(payload, request.config.sourceName);
  const range = assertTpexResponseRange(payload, request);
  const table = tpexTable(payload, request);
  const headers = table.fields.map(canonicalHeader);
  const dateIndex = requiredField(
    headers,
    request.family === "ex_right_dividend"
      ? ["除權息日期"]
      : ["恢復買賣日期"],
    "生效日期",
    request.config.sourceName,
  );
  const codeIndex = requiredField(
    headers,
    ["代號", "股票代號", "證券代號"],
    "公司代號",
    request.config.sourceName,
  );
  const nameIndex = requiredField(
    headers,
    ["名稱", "股票名稱", "證券名稱"],
    "公司名稱",
    request.config.sourceName,
  );

  let priorIndex: number;
  let referenceIndex: number;
  let typeIndex: number | null = null;
  let cashIndex: number | null = null;
  if (request.family === "ex_right_dividend") {
    priorIndex = requiredField(
      headers,
      ["除權息前收盤價"],
      "除權息前收盤價",
      request.config.sourceName,
    );
    referenceIndex = requiredField(
      headers,
      ["除權息參考價"],
      "除權息參考價",
      request.config.sourceName,
    );
    typeIndex = requiredField(
      headers,
      ["權/息"],
      "權/息",
      request.config.sourceName,
    );
    cashIndex = requiredField(
      headers,
      ["現金股利"],
      "現金股利",
      request.config.sourceName,
    );
  } else {
    priorIndex = requiredField(
      headers,
      ["最後交易日之收盤價格", "停止買賣前收盤價格"],
      "最後交易日之收盤價格",
      request.config.sourceName,
    );
    referenceIndex = requiredField(
      headers,
      ["減資恢復買賣開始日參考價格", "恢復買賣開始參考價", "恢復買賣參考價"],
      "恢復買賣開始參考價",
      request.config.sourceName,
    );
    if (request.family === "capital_reduction") {
      typeIndex = requiredField(
        headers,
        ["減資原因"],
        "減資原因",
        request.config.sourceName,
      );
    }
  }

  const events: CorporateActionEvent[] = [];
  table.data.forEach((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow)) {
      fail("UPSTREAM_BAD_RESPONSE", "TPEx 公司行動包含非陣列資料列。", {
        family: request.family,
        rowIndex,
      });
    }
    const effectiveDate = normalizeActionDate(rawRow[dateIndex], "生效日期");
    assertDateInRange(effectiveDate, request, rowIndex);
    const identity = normalizeIdentity(
      rawRow[codeIndex],
      rawRow[nameIndex],
      request.market,
    );
    if (!identity) return;
    const priorCloseTwd = parsePositivePrice(
      rawRow[priorIndex],
      headers[priorIndex],
    );
    const referencePriceTwd = parsePositivePrice(
      rawRow[referenceIndex],
      headers[referenceIndex],
    );

    if (request.family === "ex_right_dividend") {
      const normalizedType = normalizeExRightKind(rawRow[typeIndex as number], request.market);
      const cashDividend = parseNonNegativeNumber(
        rawRow[cashIndex as number],
        headers[cashIndex as number],
      );
      events.push(
        buildEvent({
          ...identity,
          market: request.market,
          effectiveDate,
          kind: normalizedType.kind,
          priorCloseTwd,
          referencePriceTwd,
          cashDividendPerShareTwd: cashDividend,
          sourceFamily: request.family,
          sourceUrl: request.config.sourceUrl,
          rawType: normalizedType.rawType,
          combinedDetailRequested: true,
        }),
      );
      return;
    }

    const kind: CorporateActionKind =
      request.family === "capital_reduction"
        ? "capital_reduction"
        : "par_value_change";
    const rawType =
      typeIndex === null
        ? "變更股票面額"
        : normalizeRequiredText(rawRow[typeIndex], headers[typeIndex], request.market);
    events.push(
      buildEvent({
        ...identity,
        market: request.market,
        effectiveDate,
        kind,
        priorCloseTwd,
        referencePriceTwd,
        cashDividendPerShareTwd: null,
        sourceFamily: request.family,
        sourceUrl: request.config.sourceUrl,
        rawType,
      }),
    );
  });

  const collapsedEvents = collapseDuplicateEvents(events);
  return {
    events: collapsedEvents,
    source: {
      market: request.market,
      exchange: "TPEx",
      family: request.family,
      scope: "range_summary",
      sourceName: request.config.sourceName,
      sourceUrl: request.config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      supportedFrom: request.supportedFrom,
      queryStart: request.queryStart,
      queryEnd: request.queryEnd,
      responseStart: range.responseStart,
      responseEnd: range.responseEnd,
      rawRowCount: table.data.length,
      companyEventCount: collapsedEvents.length,
      officialDeclaredRowCount: table.declaredRowCount,
      officialDeclaredRowCountAvailable: table.declaredRowCount !== null,
    },
  };
}

function sourceConfig(
  market: CompanyMarket,
  family: CorporateActionFamily,
  startDate: string,
  endDate: string,
): OfficialSourceConfig {
  let sourceUrl: string;
  if (market === "listed") {
    const path =
      family === "ex_right_dividend"
        ? "/rwd/zh/exRight/TWT49U"
        : family === "capital_reduction"
          ? "/rwd/zh/reducation/TWTAUU"
          : "/rwd/zh/change/TWTB8U";
    sourceUrl =
      `https://www.twse.com.tw${path}?startDate=${compactDate(startDate)}` +
      `&endDate=${compactDate(endDate)}&response=json`;
  } else {
    const path =
      family === "ex_right_dividend"
        ? "/www/zh-tw/bulletin/exDailyQ"
        : family === "capital_reduction"
          ? "/www/zh-tw/bulletin/revivt"
          : "/www/zh-tw/bulletin/pvChgRslt";
    sourceUrl =
      `https://www.tpex.org.tw${path}?startDate=${encodedSlashDate(startDate)}` +
      `&endDate=${encodedSlashDate(endDate)}&response=json`;
  }
  return {
    market,
    exchange: market === "listed" ? "TWSE" : "TPEx",
    sourceName: SOURCE_NAMES[market][family],
    sourceUrl,
  };
}

function requestsAndCoverage(
  market: CompanyMarket,
  startDate: string,
  endDate: string,
): { requests: RangeRequest[]; coverage: CorporateActionCoverage } {
  const requests: RangeRequest[] = [];
  const gaps: CorporateActionCoverageGap[] = [];
  for (const family of FAMILY_ORDER) {
    const supportedFrom = SUPPORTED_FROM[market][family];
    if (startDate < supportedFrom) {
      gaps.push({
        market,
        family,
        requestedStart: startDate,
        uncoveredThrough:
          endDate < supportedFrom ? endDate : previousDate(supportedFrom),
        supportedFrom,
        reason: "before_official_history_start",
      });
    }
    if (endDate < supportedFrom) continue;
    const queryStart = startDate < supportedFrom ? supportedFrom : startDate;
    requests.push({
      market,
      family,
      supportedFrom,
      queryStart,
      queryEnd: endDate,
      config: sourceConfig(market, family, queryStart, endDate),
    });
  }
  return {
    requests,
    coverage: {
      status: gaps.length === 0 ? "complete" : "partial",
      coverageComplete: gaps.length === 0,
      requestedStart: startDate,
      requestedEnd: endDate,
      gaps,
    },
  };
}

function compareEvents(left: CorporateActionEvent, right: CorporateActionEvent): number {
  return (
    left.effectiveDate.localeCompare(right.effectiveDate) ||
    left.companyCode.localeCompare(right.companyCode) ||
    left.kind.localeCompare(right.kind)
  );
}

function eventCore(event: CorporateActionEvent) {
  return {
    companyCode: event.companyCode,
    name: event.name,
    market: event.market,
    effectiveDate: event.effectiveDate,
    kind: event.kind,
    priorCloseTwd: event.priorCloseTwd,
    referencePriceTwd: event.referencePriceTwd,
    cashDividendPerShareTwd: event.cashDividendPerShareTwd,
    priceIndexAdjustmentFactor: event.priceIndexAdjustmentFactor,
    shareCountChanged: event.shareCountChanged,
    adjustmentStatus: event.adjustmentStatus,
    adjustmentReason: event.adjustmentReason,
    sourceFamily: event.sourceFamily,
    rawType: event.rawType,
  };
}

function collapseDuplicateEvents(
  events: CorporateActionEvent[],
): CorporateActionEvent[] {
  const seen = new Map<string, CorporateActionEvent>();
  for (const event of events) {
    const key = [
      event.market,
      event.effectiveDate,
      event.companyCode,
      event.kind,
    ].join("\u0000");
    const previous = seen.get(key);
    if (previous) {
      if (JSON.stringify(eventCore(previous)) !== JSON.stringify(eventCore(event))) {
        fail("UPSTREAM_BAD_RESPONSE", "官方公司行動資料含重複事件衝突。", {
          key,
          previous: eventCore(previous),
          duplicate: eventCore(event),
        });
      }
      continue;
    }
    seen.set(key, event);
  }
  return [...seen.values()];
}

function historyFingerprint(
  market: CompanyMarket,
  startDate: string,
  endDate: string,
  coverage: CorporateActionCoverage,
  ranges: NormalizedRange[],
  fullMarketEvents: CorporateActionEvent[],
  filteredCompanyCodes: string[] | null,
  selectedDetailEvidence: SelectedDetailFingerprintEvidence[],
): string {
  const content = {
    version: 2,
    market,
    startDate,
    endDate,
    filteredCompanyCodes,
    gaps: coverage.gaps,
    sources: ranges.map(({ source }) => ({
      family: source.family,
      sourceUrl: source.sourceUrl,
      responseStart: source.responseStart,
      responseEnd: source.responseEnd,
      rawRowCount: source.rawRowCount,
      companyEventCount: source.companyEventCount,
      officialDeclaredRowCount: source.officialDeclaredRowCount,
    })),
    fullMarketEvents: fullMarketEvents.map((event) => ({
      companyCode: event.companyCode,
      name: event.name,
      effectiveDate: event.effectiveDate,
      kind: event.kind,
      priorCloseTwd: event.priorCloseTwd,
      referencePriceTwd: event.referencePriceTwd,
      cashDividendPerShareTwd: event.cashDividendPerShareTwd,
      rawType: event.rawType,
    })),
    selectedTwseCombinedDetailEvidence: selectedDetailEvidence,
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function detailConfig(event: CorporateActionEvent): OfficialSourceConfig {
  const sourceUrl =
    "https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail" +
    `?STK_NO=${encodeURIComponent(event.companyCode)}` +
    `&T1=${compactDate(event.effectiveDate)}&response=json`;
  return {
    market: "listed",
    exchange: "TWSE",
    sourceName: "臺灣證券交易所－除權除息計算結果詳細資料",
    sourceUrl,
  };
}

function normalizeTwseCombinedDetail(
  snapshot: JsonSnapshot,
  config: OfficialSourceConfig,
  event: CorporateActionEvent,
): { event: CorporateActionEvent; source: CorporateActionSource } {
  const payload = payloadObject(snapshot, config.sourceName);
  assertOk(payload, config.sourceName);
  if (!Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 權息詳細資料缺少 fields/data。", {
      sourceUrl: config.sourceUrl,
    });
  }
  const count = declaredRowCount(
    payload.totalCount ?? payload.total,
    payload.data.length,
    config.sourceName,
  );
  if (payload.data.length !== 1 || !Array.isArray(payload.data[0])) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 權息詳細資料必須只有一筆事件。", {
      companyCode: event.companyCode,
      effectiveDate: event.effectiveDate,
      actualCount: payload.data.length,
    });
  }
  const headers = payload.fields.map(canonicalHeader);
  const codeIndex = requiredField(
    headers,
    ["股票代號", "證券代號"],
    "公司代號",
    config.sourceName,
  );
  const nameIndex = requiredField(
    headers,
    ["股票名稱", "證券名稱"],
    "公司名稱",
    config.sourceName,
  );
  const cashIndex = requiredField(
    headers,
    ["(每股配發現金股利)除息"],
    "每股配發現金股利",
    config.sourceName,
  );
  const row = payload.data[0] as unknown[];
  const identity = normalizeIdentity(row[codeIndex], row[nameIndex], "listed");
  if (
    !identity ||
    identity.companyCode !== event.companyCode ||
    identity.name !== event.name
  ) {
    fail("UPSTREAM_BAD_RESPONSE", "TWSE 權息詳細資料公司 identity 不符。", {
      expectedCode: event.companyCode,
      expectedName: event.name,
      actual: identity,
    });
  }
  const cashDividendPerShareTwd = parseDetailCash(row[cashIndex]);
  const enriched = buildEvent({
    companyCode: event.companyCode,
    name: event.name,
    market: event.market,
    effectiveDate: event.effectiveDate,
    kind: event.kind,
    priorCloseTwd: event.priorCloseTwd,
    referencePriceTwd: event.referencePriceTwd,
    cashDividendPerShareTwd,
    sourceFamily: event.sourceFamily,
    sourceUrl: event.sourceUrl,
    rawType: event.rawType,
    combinedDetailRequested: true,
  });
  return {
    event: enriched,
    source: {
      market: "listed",
      exchange: "TWSE",
      family: "ex_right_dividend",
      scope: "event_detail",
      sourceName: config.sourceName,
      sourceUrl: config.sourceUrl,
      retrievedAt: snapshot.retrievedAt,
      supportedFrom: SUPPORTED_FROM.listed.ex_right_dividend,
      queryStart: event.effectiveDate,
      queryEnd: event.effectiveDate,
      responseStart: null,
      responseEnd: null,
      rawRowCount: payload.data.length,
      companyEventCount: 1,
      officialDeclaredRowCount: count,
      officialDeclaredRowCountAvailable: count !== null,
    },
  };
}

function gapWarning(gap: CorporateActionCoverageGap): string {
  const family =
    gap.family === "ex_right_dividend"
      ? "除權除息"
      : gap.family === "capital_reduction"
        ? "減資"
        : "面額變更";
  return `${gap.market} ${family}官方歷史自 ${gap.supportedFrom} 起提供；${gap.requestedStart} 至 ${gap.uncoveredThrough} 無法覆蓋。`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知上游錯誤";
}

export class CorporateActionClient {
  private readonly loader: OfficialJsonLoader;
  private readonly deadlineMs: number;

  constructor(
    fetchImpl: typeof fetch = fetch,
    now: () => Date = () => new Date(),
    options: OfficialJsonLoaderOptions = {},
  ) {
    this.loader = new OfficialJsonLoader(fetchImpl, now, options);
    this.deadlineMs = options.deadlineMs ?? 50_000;
  }

  async getHistory(
    market: CompanyMarket,
    startDate: string,
    endDate: string,
    options: CorporateActionHistoryOptions = {},
  ): Promise<CorporateActionHistory> {
    validateMarket(market);
    validateRange(startDate, endDate);
    const filteredCompanyCodes = normalizeCompanyCodes(options.companyCodes);
    const { requests, coverage } = requestsAndCoverage(
      market,
      startDate,
      endDate,
    );
    const deadline = new AbsoluteDeadline(this.deadlineMs);
    try {
      const ranges = await Promise.all(
        requests.map(async (request) => {
          const snapshot = await this.loader.get(request.config, deadline);
          return request.market === "listed"
            ? normalizeTwseRange(snapshot, request)
            : normalizeTpexRange(snapshot, request);
        }),
      );
      const fullMarketEvents = collapseDuplicateEvents(
        ranges.flatMap((range) => range.events),
      ).sort(compareEvents);
      const selectedCodes =
        filteredCompanyCodes === null
          ? null
          : new Set(filteredCompanyCodes);
      let events = fullMarketEvents.filter(
        (event) => selectedCodes === null || selectedCodes.has(event.companyCode),
      );
      const detailSources: CorporateActionSource[] = [];
      const detailWarnings: string[] = [];
      let detailRequestCount = 0;
      if (market === "listed" && selectedCodes !== null) {
        const combinedEvents = events.filter(
          (event) => event.kind === "rights_and_dividend",
        );
        detailRequestCount = combinedEvents.length;
        const details = await Promise.all(
          combinedEvents.map(async (event) => {
            const config = detailConfig(event);
            try {
              return {
                status: "fulfilled" as const,
                result: normalizeTwseCombinedDetail(
                  await this.loader.get(config, deadline),
                  config,
                  event,
                ),
              };
            } catch (error) {
              return {
                status: "rejected" as const,
                event,
                reason: errorMessage(error),
              };
            }
          }),
        );
        const enrichedByKey = new Map(
          details
            .filter((detail) => detail.status === "fulfilled")
            .map(({ result }) => [
              `${result.event.companyCode}\u0000${result.event.effectiveDate}`,
              result.event,
            ]),
        );
        const failedByKey = new Set(
          details
            .filter((detail) => detail.status === "rejected")
            .map(({ event }) => `${event.companyCode}\u0000${event.effectiveDate}`),
        );
        events = events.map(
          (event) => {
            const key = `${event.companyCode}\u0000${event.effectiveDate}`;
            const enriched = enrichedByKey.get(key);
            if (enriched) return enriched;
            if (!failedByKey.has(key)) return event;
            return {
              ...event,
              priceIndexAdjustmentFactor: null,
              adjustmentStatus: "unavailable" as const,
              adjustmentReason: "twse_combined_event_detail_failed" as const,
            };
          },
        );
        detailSources.push(
          ...details
            .filter((detail) => detail.status === "fulfilled")
            .map(({ result }) => result.source),
        );
        detailWarnings.push(
          ...details
            .filter((detail) => detail.status === "rejected")
            .map(
              ({ event, reason }) =>
                `TWSE ${event.companyCode} ${event.effectiveDate} 權息 detail 查詢失敗；該事件調整因子保留 unavailable：${reason}`,
            ),
        );
      }
      events.sort(compareEvents);
      const selectedDetailEvidence: SelectedDetailFingerprintEvidence[] =
        market === "listed" && filteredCompanyCodes !== null
          ? events
              .filter((event) => event.kind === "rights_and_dividend")
              .map((event) => ({
                companyCode: event.companyCode,
                effectiveDate: event.effectiveDate,
                status:
                  event.adjustmentReason === "twse_combined_event_detail_failed"
                    ? "rejected" as const
                    : "fulfilled" as const,
                cashDividendPerShareTwd: event.cashDividendPerShareTwd,
                priceIndexAdjustmentFactor: event.priceIndexAdjustmentFactor,
                adjustmentStatus: event.adjustmentStatus,
                adjustmentReason: event.adjustmentReason,
              }))
          : [];
      const fingerprint = historyFingerprint(
        market,
        startDate,
        endDate,
        coverage,
        ranges,
        fullMarketEvents,
        filteredCompanyCodes,
        selectedDetailEvidence,
      );
      const warnings = [...coverage.gaps.map(gapWarning), ...detailWarnings];
      if (
        market === "listed" &&
        filteredCompanyCodes === null &&
        events.some((event) => event.kind === "rights_and_dividend")
      ) {
        warnings.push(
          "未提供 companyCodes；為避免對全市場逐筆呼叫 detail，TWSE 權息事件不補抓現金股利，priceIndexAdjustmentFactor 保留 unavailable。",
        );
      }
      return {
        market,
        requestedStart: startDate,
        requestedEnd: endDate,
        filteredCompanyCodes,
        events,
        sources: [
          ...ranges.map((range) => range.source),
          ...detailSources,
        ],
        requestCount: requests.length + detailRequestCount,
        coverage,
        fingerprint,
        fingerprintBasis:
          "full_market_range_summary_plus_selected_scope_and_twse_combined_detail_without_retrieved_at",
        warnings,
      };
    } finally {
      deadline.dispose();
    }
  }
}

export const corporateActionClient = new CorporateActionClient();
