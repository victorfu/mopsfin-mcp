import { screenerClient } from "@/lib/screener/client";
import { comparisonClient } from "@/lib/comparison/client";
import { stockTechnicalsClient } from "@/lib/technicals/client";
import { evaluateFreshness } from "@/lib/freshness/evaluate";
import { FRESHNESS_POLICIES } from "@/lib/freshness/policies";
import type { FreshnessEvaluation } from "@/lib/freshness/types";
import type { ResearchSource } from "@/lib/research/market-data";
import { taipeiToday } from "@/lib/research/market-data";
import { screenCompaniesInputSchema, compareCompaniesInputSchema, stockTechnicalsInputSchema } from "../schema/research-inputs";
import { screenCompaniesOutputSchema, compareCompaniesOutputSchema, stockTechnicalsOutputSchema } from "../schema/research-outputs";
import { buildResultMeta, type QualityIssue, type ResultMetaHints } from "../result-contract";
import { defineTool } from "./definition";
import { annotations, success } from "./shared";

/** Preserve the public source tables while giving the common metadata builder
 * their actual dates and the technical tool's nested source arrays. */
function researchSuccess<T extends { sources: ResearchSource[] | { master: object[]; benchmark: object[]; prices: object[] } }>(text: string, data: T, hints: ResultMetaHints) {
  const sources = Array.isArray(data.sources)
    ? data.sources.map((source) => ({
        ...source.evidence, sourceUrl: source.sourceUrl, retrievedAt: source.retrievedAt,
        ...(source.cache ? { cache: source.cache } : {}), asOf: source.cutoff,
      }))
    : [...data.sources.master, ...data.sources.benchmark, ...data.sources.prices];
  const response = success(text, data, hints);
  response.structuredContent.meta = buildResultMeta({ ...data, sources }, hints);
  return response;
}

function presentationHasGaps(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(presentationHasGaps);
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (["missing", "invalid_upstream", "source_unavailable", "period_unaligned", "freshness_unverified"].includes(String(object.status))) return true;
  if (object.freshness === "stale" || object.freshness === "unverified") return true;
  if (typeof object.total === "number" && typeof object.usableCount === "number") {
    const statuses = object.statusCounts as Record<string, number> | undefined;
    if (object.total > object.usableCount + (statuses?.not_applicable ?? 0)) return true;
  }
  return Object.values(object).some(presentationHasGaps);
}

function freshnessForSources(options: {
  sources: ResearchSource[]; evaluatedAt: string; marketDate: string;
  expectedDate: string | null; revenueMonth: string; resolvedRevenueMonth: string | null;
}): FreshnessEvaluation[] {
  return options.sources.filter((source) => source.domain !== "financial").map((source) => {
    const company = source.domain === "company";
    const monthly = source.domain === "revenue";
    const latest = (monthly ? options.revenueMonth : options.marketDate) === "latest";
    return evaluateFreshness({
      policy: company ? FRESHNESS_POLICIES.currentSnapshotSevenDays : !latest ? FRESHNESS_POLICIES.historicalExact : monthly ? FRESHNESS_POLICIES.monthlyRevenueLatestCommon : FRESHNESS_POLICIES.completedOfficialSession,
      observedAsOf: source.cutoff,
      expectedAsOf: company ? taipeiToday(new Date(options.evaluatedAt)) : !latest ? null : monthly ? options.resolvedRevenueMonth : options.expectedDate,
      sourceUrls: [source.sourceUrl],
    });
  });
}
const emptyRefs = { companyCodes: [], fields: [], periods: [], sourceUrls: [] };
const universeIssue: QualityIssue = {
  refs: emptyRefs,
  code: "RESEARCH_UNIVERSE_HEURISTIC", severity: "info", scope: "universe",
  message: "current master 通過 heuristic 門檻；沒有官方 declared row count，不能宣稱 verified 全市場。",
};

export const screenCompaniesTool = defineTool("screen_companies", {
  title: "篩選台股公司",
  description: "以目前上市／上櫃公司母體、官方整批日行情、估值與單月營收執行 1–12 個明確 AND 條件，支援公司／產業白名單、金融及 KY 選擇、欄位投影與排序。三態 matched/notMatched/undetermined 分開，null、stale 或來源失敗不当零，也不冒充確定不符合；每條條件附 evidence。行情與估值共用一次解析的完成交易日，不提供歷史 point-in-time 選股。全體符合公司先排序再分頁；cursor 綁定參數、欄位版本與來源內容，來源修訂需重新查詢。summary 涵蓋完整符合集合；compact 保留來源與逐欄 metadata。resultComplete 不代表官方已證明完整母體，rankIncomplete 另列排序缺值；請讀 universe、fieldCoverage、failures、sourceCoverage、workBudget 與 meta。",
  inputSchema: screenCompaniesInputSchema, outputSchema: screenCompaniesOutputSchema, annotations,
}, async (input) => {
  const data = await screenerClient.screenCompanies({ market: input.market, includeFinancial: input.include_financial, includeKy: input.include_ky, industryCodes: input.industry_codes, companyCodes: input.company_codes, asOf: input.as_of, revenueMonth: input.revenue_month, filters: input.filters, columns: input.columns, sort: input.sort, pageSize: input.page_size, cursor: input.cursor, outputMode: input.output_mode });
  return researchSuccess(`選取 ${data.counts.selected} 家，符合 ${data.counts.matched} 家、不符合 ${data.counts.notMatched} 家、無法判定 ${data.counts.undetermined} 家。`, data, {
    selector: "latest", snapshotId: data.snapshotId, page: data.page,
    resolved: { granularity: "mixed", from: null, through: null },
    universe: "unverified", source: data.failures.length ? "partial" : "complete",
    selection: data.resultComplete ? "complete" : "partial",
    values: data.fieldCoverage.some((field) => field.unavailable > 0) ? "partial" : "complete",
    freshnessDetails: freshnessForSources({ sources: data.sources, evaluatedAt: data.evaluatedAt, marketDate: "latest", expectedDate: data.resolverEvidence?.expectedAsOf ?? null, revenueMonth: input.revenue_month, resolvedRevenueMonth: data.resolvedDates.revenueMonth }),
    issues: [universeIssue, ...data.failures.map((failure): QualityIssue => ({ code: "RESEARCH_SOURCE_UNAVAILABLE", refs: emptyRefs, severity: "warning", scope: "source", message: `${failure.domain}: ${failure.message}` })), ...(data.counts.undetermined ? [{ code: "SCREEN_UNDETERMINED_COMPANIES", refs: emptyRefs, severity: "warning" as const, scope: "selection" as const, message: `${data.counts.undetermined} 家公司因資料不足或 freshness 未確認而無法判定。` }] : [])],
  });
});

export const compareCompaniesTool = defineTool("compare_companies", {
  title: "比較台股公司",
  description: "一次比較 1–20 家目前上市櫃公司與最多 24 個欄位，其中季度財務最多 8 項。維持公司輸入順序，不分公司頁；只取得所需 domain，不逐股查詢已存在的市場快照。common_latest 搜尋最近 12 個已完成曆季，對所有公司與 applicable 指標取 reported 期別交集；缺值、失敗公司不被移除，沒有交集回 no_common_period，不切換各自最新值。company_latest 在各公司內取共同季，explicit 使用指定季度且不 fallback。金融業不適用欄位維持 not_applicable，金融淨收益與一般營收使用不同 definitionId；無法確認定義不混合統計。每格保留單位、期別、來源與 status，summary 只合併相同定義／單位／口徑／期別。market_date 不是財務歷史 vintage；請檢查 alignment、financialDefinitions、failures、financialFailures、sourceCoverage 與 meta。",
  inputSchema: compareCompaniesInputSchema, outputSchema: compareCompaniesOutputSchema, annotations,
}, async (input) => {
  const data = await comparisonClient.compareCompanies({ companyCodes: input.company_codes, columns: input.columns, financialPeriodPolicy: input.financial_period_policy, fiscalPeriod: input.financial_period, financialBasis: input.financial_basis, marketDate: input.market_date, revenueMonth: input.revenue_month, outputMode: input.output_mode });
  const freshnessDetails = freshnessForSources({ sources: data.sources, evaluatedAt: data.evaluatedAt, marketDate: input.market_date, expectedDate: data.resolverEvidence?.expectedAsOf ?? null, revenueMonth: input.revenue_month, resolvedRevenueMonth: data.resolvedDates.revenueMonth });
  if (data.alignment) freshnessDetails.push(evaluateFreshness({ policy: input.financial_period_policy === "explicit" ? FRESHNESS_POLICIES.historicalExact : FRESHNESS_POLICIES.mopsfinLatestUnverified, observedAsOf: data.alignment.commonPeriod ?? null, expectedAsOf: null, sourceUrls: data.sources.filter((source) => source.domain === "financial").map((source) => source.sourceUrl) }));
  const failed = data.failures.length > 0 || data.financialFailures.length > 0;
  return researchSuccess(`比較 ${input.company_codes.length} 家公司；財務共同季 ${data.alignment?.commonPeriod ?? "未選取／依公司而異"}。`, data, {
    selector: "snapshot", resolved: { granularity: "mixed", from: null, through: null }, snapshotId: data.snapshotId,
    universe: "unverified", source: failed ? "partial" : "complete", selection: failed || data.alignment?.status === "no_common_period" ? "partial" : "complete",
    values: presentationHasGaps(data.presentation) ? "partial" : "complete", freshnessDetails,
    issues: [universeIssue, ...(data.alignment?.status === "no_common_period" ? [{ code: "NO_COMMON_FINANCIAL_PERIOD", refs: emptyRefs, severity: "warning" as const, scope: "period" as const, message: "所有要求公司與 applicable 指標在共同曆季窗内沒有交集；保留缺值，不回退。" }] : []), ...(data.columns.some((column) => column.definitionMismatch) ? [{ code: "RESEARCH_DEFINITION_MISMATCH", refs: emptyRefs, severity: "warning" as const, scope: "value" as const, message: "部分同名欄位定義不同；不得跨定義作共同排名或統計。" }] : [])],
  });
});

export const getStockTechnicalsTool = defineTool("get_stock_technicals", {
  title: "查詢台股日線技術指標",
  description: "計算單一目前上市櫃公司在 latest 完成交易日或 exact 過去交易日的 SMA、Wilder RSI14、20／60 日歷史波動率、20／60 日突破與量比。以官方 benchmark sessions 驗證暖機與停牌缺日，不以最近有交易的 N 根跳過缺口。RSI 固定最後 251 closes、前 14 deltas 初始化 Wilder 平均，不承諾與第三方種子相同；波動率為 log return 樣本標準差乘 sqrt(252)。突破排除當日 high，量比使用當日 raw shares／前 20 日均量且排除當日分母。預設公司行動調整、保留現金股利效果；不是 total return，adjusted 缺值不回退 raw。各指標獨立揭露不可用原因、窗口與公式版本；股數變動使 raw 成交量不可直接比較。最多 18 個 benchmark 月份，沿用 request deadline，請檢查 coverage、identity、eventLedger、workBudget 與 meta。",
  inputSchema: stockTechnicalsInputSchema, outputSchema: stockTechnicalsOutputSchema, annotations,
}, async (input) => {
  const data = await stockTechnicalsClient.getStockTechnicals({ companyCode: input.company_code, asOf: input.as_of, priceBasis: input.price_basis, indicators: input.indicators, smaPeriods: input.sma_periods });
  return researchSuccess(`${input.company_code} ${data.asOf} 日線技術指標，完整性 ${data.coverage.indicatorsComplete ? "complete" : "partial"}。`, data, {
    selector: input.as_of === "latest" ? "latest" : "explicit",
    resolved: { granularity: "date", from: data.asOf, through: data.asOf },
    universe: "unverified", source: data.coverage.priceSeries.corporateActions.status === "unavailable" || data.coverage.priceSeries.corporateActions.status === "partial" ? "partial" : "complete",
    selection: data.identity.status === "verified_current_master" ? "complete" : "partial", values: data.coverage.indicatorsComplete ? "complete" : "partial",
    freshnessDetails: [evaluateFreshness({ policy: input.as_of === "latest" ? FRESHNESS_POLICIES.completedOfficialSession : FRESHNESS_POLICIES.historicalExact, observedAsOf: data.asOf, expectedAsOf: input.as_of === "latest" ? data.asOfEvidence.expectedAsOf : null, resolverEvidence: data.asOfEvidence, sourceUrls: data.sources.benchmark.map((source) => source.sourceUrl) })],
    issues: [universeIssue, ...Object.entries(data.indicators).filter(([, value]) => value.status !== "available").map(([name, value]): QualityIssue => ({ code: "TECHNICAL_INDICATOR_UNAVAILABLE", severity: "warning", scope: "value", message: `${name}: ${value.reason}`, refs: { sourceUrls: data.sources.prices.map((source) => source.sourceUrl), fields: [name], companyCodes: [input.company_code], periods: [data.asOf] } }))],
  });
});

export const researchTools = [screenCompaniesTool, compareCompaniesTool, getStockTechnicalsTool] as const;
