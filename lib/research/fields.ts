import { MopsfinError } from "@/lib/mopsfin/errors";
import type { MetricDefinition } from "@/lib/mopsfin/types";
import type { ResearchDomain, ResearchField, ResearchFilter, ResearchSort } from "./types";
import { financialFieldApplicability } from "./financials";

export const RESEARCH_FIELDS_VERSION = "mopsfin.research.fields.v1";

function field(
  id: string, name: string, type: ResearchField["type"], unit: string,
): ResearchField {
  const domain = id.split(".")[0] as ResearchDomain;
  const projectionTools: ResearchField["supportedTools"] =
    ["company.code", "company.name", "company.market"].includes(id)
      ? ["get_daily_market_ohlc", "get_daily_market_valuation", "get_monthly_revenue"]
      : domain === "price" ? ["get_daily_market_ohlc"]
      : domain === "valuation" ? ["get_daily_market_valuation"]
      : domain === "revenue" ? ["get_monthly_revenue"] : [];
  return {
    id, name, type, unit, domain,
    frequency: domain === "company" ? "snapshot" : domain === "revenue" ? "monthly" : "daily",
    basis: domain === "price" ? "raw_unadjusted" : domain === "revenue" ? "monthly_filing" : "official_snapshot",
    definitionId: `mopsfin.${id}.v1`, dependencies: [domain], applicability: "all",
    filterOperators: type === "number" ? ["gt", "gte", "lt", "lte", "between"] : ["eq", "in"],
    sortable: true, cost: domain === "company" ? "master" : "market_bulk",
    normalization: null, supportedTools: ["screen_companies", "compare_companies", ...projectionTools],
  };
}

export const STATIC_RESEARCH_FIELDS: readonly ResearchField[] = [
  field("company.code", "公司代碼", "string", "code"),
  field("company.name", "公司名稱", "string", "text"),
  field("company.market", "市場", "string", "category"),
  field("company.industry_code", "產業代碼", "string", "code"),
  field("company.is_financial", "金融業", "boolean", "boolean"),
  field("company.is_ky", "KY 公司", "boolean", "boolean"),
  ...(["open", "high", "low", "close"] as const).map((key) =>
    field(`price.${key}`, ({ open: "開盤價", high: "最高價", low: "最低價", close: "收盤價" })[key], "number", "TWD")),
  field("price.volume_shares", "成交股數", "number", "share"),
  field("price.turnover_twd", "成交金額", "number", "TWD"),
  field("valuation.pe", "本益比", "number", "ratio"),
  field("valuation.pb", "股價淨值比", "number", "ratio"),
  field("valuation.dividend_yield_pct", "殖利率", "number", "%"),
  field("revenue.month_amount_twd", "當月營收", "number", "TWD"),
  field("revenue.mom_pct", "月營收月增率", "number", "%"),
  field("revenue.yoy_pct", "月營收年增率", "number", "%"),
  field("revenue.cumulative_amount_twd", "累計營收", "number", "TWD"),
  field("revenue.cumulative_yoy_pct", "累計營收年增率", "number", "%"),
];

// Only verified unit spellings are normalized; unfamiliar units remain explicit.
export function financialNormalization(unit: string, metricName?: string): ResearchField["normalization"] {
  if (unit === "仟元" || unit === "新台幣仟元") return { sourceUnit: unit, outputUnit: "TWD", factor: 1000 };
  if (unit === "元" && (metricName === "每股盈餘" || metricName === "每股淨值")) return { sourceUnit: unit, outputUnit: "TWD/share", factor: 1 };
  if (unit === "%") return { sourceUnit: unit, outputUnit: "%", factor: 1 };
  if (unit === "倍") return { sourceUnit: unit, outputUnit: "ratio", factor: 1 };
  return null;
}

export function researchFields(metrics: MetricDefinition[] = []): ResearchField[] {
  return [...STATIC_RESEARCH_FIELDS, ...metrics.filter((metric) => metric.family === "data").map((metric): ResearchField => {
    const normalization = financialNormalization(metric.unit, metric.name);
    return {
      id: `financial.${metric.code}`, name: metric.name, type: "number",
      unit: normalization?.outputUnit ?? metric.unit, domain: "financial", frequency: "quarterly",
      basis: "quarterly", definitionId: `mopsfin.financial.${metric.code}.quarterly.v1`,
      dependencies: ["financial"], applicability: financialFieldApplicability(metric), filterOperators: [], sortable: false,
      cost: "company_metric_batch", normalization, supportedTools: ["compare_companies"],
    };
  })];
}

function invalid(message: string): never { throw new MopsfinError("INVALID_ARGUMENT", message); }

/** Validate and plan before any domain loads; no arbitrary upstream columns. */
export function planResearchFields(options: {
  registry: readonly ResearchField[];
  tool: "screen_companies" | "compare_companies";
  columns: string[];
  filters?: ResearchFilter[];
  sort?: ResearchSort[];
}): { fields: ResearchField[]; domains: ResearchDomain[] } {
  const { registry, tool, columns, filters = [], sort = [] } = options;
  if (columns.length > 24 || filters.length > 12 || sort.length > 3) invalid("研究欄位、篩選或排序數量超過限制。");
  const byId = new Map(registry.map((entry) => [entry.id, entry]));
  const ids = [...new Set([...columns, ...filters.map((f) => f.field), ...sort.map((s) => s.field)])];
  const fields = ids.map((id) => {
    const entry = byId.get(id);
    if (!entry || !entry.supportedTools.includes(tool)) invalid(`不支援的研究欄位：${id}`);
    return entry;
  });
  for (const filter of filters) {
    const entry = byId.get(filter.field)!;
    if (!entry.filterOperators.includes(filter.op)) invalid(`欄位 ${entry.id} 不支援 ${filter.op}。`);
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (!values.length || values.some((value) => typeof value !== entry.type || (typeof value === "number" && !Number.isFinite(value)))) invalid(`欄位 ${entry.id} 篩選值型別錯誤。`);
    if (filter.op === "between") {
      if (!Array.isArray(filter.value) || values.length !== 2 || values[0] > values[1]) invalid("between 需要遞增的兩個界限。");
    } else if (filter.op === "in") {
      if (!Array.isArray(filter.value)) invalid("in 需要非空陣列。");
    } else if (Array.isArray(filter.value)) invalid("此運算子需要單一值。");
  }
  for (const item of sort) {
    if (!byId.get(item.field)!.sortable || !["asc", "desc"].includes(item.direction)) invalid(`不支援排序：${item.field}`);
  }
  return { fields, domains: [...new Set(fields.flatMap((entry) => entry.dependencies))] };
}
