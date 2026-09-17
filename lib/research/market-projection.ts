import { MopsfinError } from "@/lib/mopsfin/errors";
import type { DailyMarketOhlcResult } from "@/lib/price/types";
import type { DailyMarketValuationResult } from "@/lib/valuation/types";
import type { MonthlyRevenueResult } from "@/lib/revenue/types";
import type { ResultMeta } from "@/lib/mcp/result-contract";
import { STATIC_RESEARCH_FIELDS } from "./fields";
import { projectResearchRows, type OutputMode } from "./projection";
import type { CellValue, ResearchCell, ResearchRow } from "./types";

export type MarketProjectionDomain = "price" | "valuation" | "revenue";
type MarketData = DailyMarketOhlcResult | DailyMarketValuationResult | MonthlyRevenueResult;
const upstreamKeys: Record<string, string> = {
  "company.code": "code", "company.name": "name", "company.market": "market",
  "price.open": "open", "price.high": "high", "price.low": "low", "price.close": "close", "price.volume_shares": "volumeShares", "price.turnover_twd": "turnoverTwd",
  "valuation.pe": "peRatio", "valuation.pb": "priceToBookRatio", "valuation.dividend_yield_pct": "dividendYieldPercent",
  "revenue.month_amount_twd": "currentMonthRevenueTwd", "revenue.mom_pct": "momPercent", "revenue.yoy_pct": "yoyPercent", "revenue.cumulative_amount_twd": "currentYearCumulativeRevenueTwd", "revenue.cumulative_yoy_pct": "cumulativeYoyPercent",
};

export function marketProjectionColumns(domain: MarketProjectionDomain, columns?: string[]): string[] {
  const selected = columns ?? STATIC_RESEARCH_FIELDS.filter((field) => field.domain === domain).map((field) => field.id);
  if (!selected.length || selected.length > 24 || new Set(selected).size !== selected.length || selected.some((id) => !upstreamKeys[id] || (!id.startsWith(`${domain}.`) && !["company.code", "company.name", "company.market"].includes(id)))) throw new MopsfinError("INVALID_ARGUMENT", `columns 只接受 ${domain} 欄位與 company.code/name/market，最多 24 欄且不可重複。`);
  return selected;
}

export function marketProjectionRows(data: MarketData, columns: string[], freshness: ResultMeta["quality"]["freshness"]): ResearchRow[] {
  const rows = "bars" in data ? data.bars : data.rows;
  return rows.map((row) => {
    const cells: Record<string, ResearchCell> = {};
    const sourceIndexes = data.sources.flatMap((source, index) => source.market === row.market ? [index] : []);
    const record = row as unknown as Record<string, unknown>;
    for (const id of columns) {
      const field = STATIC_RESEARCH_FIELDS.find((candidate) => candidate.id === id)!;
      const value = (record[upstreamKeys[id]] ?? null) as CellValue;
      const status = (record.valueStatus as Record<string, string> | undefined)?.[upstreamKeys[id]];
      const invalid = status === "invalid_upstream" || (typeof value === "number" && !Number.isFinite(value));
      const cell: ResearchCell = {
        value: invalid ? null : value, status: invalid ? "invalid_upstream" : value === null || (status && status !== "reported") ? "missing" : "available",
        unit: field.unit, period: "dataDate" in data ? data.dataDate : data.dataMonth, basis: field.basis, definitionId: field.definitionId,
        sourceRefs: sourceIndexes.map((index) => `sources[${index}]`),
        freshness: freshness === "within_expected_window" ? "fresh" : freshness === "not_applicable" ? "not_applicable" : freshness === "stale" ? "stale" : "unverified",
      };
      if ("amountUnit" in data && id.startsWith("revenue.")) {
        const industry = String(record.sourceIndustryName ?? "");
        if (record.industryCode === "17" || !record.industryCode || /金融|保險|證券|金控|異業/.test(industry)) {
          cell.definitionId += `.industry_mapping_unverified.${row.code}`;
          cell.reason = "未確認跨公司的月營收申報定義，按公司分組。";
        }
        if (id.endsWith("amount_twd")) {
          const source = data.sources[sourceIndexes[0]];
          if (source && typeof value === "number") cell.normalization = { sourceUnit: source.sourceAmountUnit, sourceValue: value / source.amountMultiplier, factor: source.amountMultiplier };
        }
      }
      if ("bars" in data && (id === "price.volume_shares" || id === "price.turnover_twd")) {
        const source = data.sources[sourceIndexes[0]];
        const normalization = source?.normalization[id === "price.volume_shares" ? "volumeShares" : "turnoverTwd"];
        if (normalization && typeof value === "number") cell.normalization = { sourceUnit: normalization.sourceUnit, sourceValue: value / normalization.multiplier, factor: normalization.multiplier };
      }
      cells[id] = cell;
    }
    return { code: row.code, name: row.name, market: row.market, cells };
  });
}

/** No acquisition: presentation reuses the already collected full rowset. */
export function projectMarketResponse<T extends MarketData & { ok: true; meta: ResultMeta }>(
  response: { content: Array<{ type: "text"; text: string }>; structuredContent: T },
  allData: MarketData, domain: MarketProjectionDomain, options: { columns?: string[]; outputMode?: OutputMode },
) {
  if ((!options.outputMode || options.outputMode === "full") && !options.columns) return response;
  const outputMode = options.outputMode ?? "full";
  const columns = marketProjectionColumns(domain, options.columns);
  const original = response.structuredContent;
  const { bars: _bars, rows: _rows, ...metadata } = original as T & { bars?: unknown; rows?: unknown };
  void _bars; void _rows;
  const selected = outputMode === "summary" ? allData : original;
  const rows = marketProjectionRows(selected, columns, original.meta.quality.freshness);
  const incomplete = rows.some((row) => Object.values(row.cells).some((cell) => cell.status !== "available" || cell.freshness === "stale" || cell.freshness === "unverified"));
  const meta: ResultMeta = incomplete ? {
    ...original.meta,
    quality: { ...original.meta.quality, status: "partial", values: "partial", issues: [...original.meta.quality.issues, {
      code: "PROJECTION_VALUES_PARTIAL", severity: "warning", scope: "value",
      message: "投影所涵蓋資料集有缺值、無效值或未確認的 freshness；summary 的範圍不只本頁。",
      refs: { companyCodes: [], fields: columns, periods: [], sourceUrls: [] },
    }] },
  } : original.meta;
  return {
    ...response,
    content: [{ type: "text" as const, text: `${domain} ${outputMode}：涵蓋 ${rows.length} 家公司；原始 rows/bars 已由明確標示的 presentation 取代。` }],
    structuredContent: {
      ...metadata, meta, outputMode, rawRowsOmitted: true as const,
      presentation: projectResearchRows(rows, columns, outputMode, outputMode === "summary" ? "entire_selection" : "current_page"),
      projection: { columns, sourceRefEncoding: "sources[index]" as const, upstreamSavingsClaimed: false as const },
    },
  };
}
