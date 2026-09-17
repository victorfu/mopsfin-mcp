import { z } from "zod";
import { researchFieldSchema } from "./research-fields";
import { completedSessionResolverEvidenceSchema, resultMetaSchema, sourceCacheObservationSchema, successResultShape } from "./common";
import { listCompaniesOutputSchema } from "./company";
import { companyMetricsBatchFullOutputSchema } from "./financials";
import { stockPriceSeriesFullOutputSchema } from "./price-series";
import { researchCellSchema, researchPresentationSchema } from "./research";

const text = (description: string) => z.string().describe(description);
const count = (description: string) => z.number().int().nonnegative().describe(description);
const flag = (description: string) => z.boolean().describe(description);
const strings = (description: string) => z.array(text("識別值")).describe(description);
const record = (description: string) => z.record(z.string(), z.unknown()).describe(description);
const market = z.enum(["listed", "otc"]).describe("公司市場");
const domain = z.enum(["company", "price", "valuation", "revenue", "financial"]).describe("資料來源領域");
const mode = z.enum(["full", "compact", "summary"]).describe("輸出投影模式");
const financialPolicy = z.enum(["common_latest", "company_latest", "explicit"]).describe("財務季度選擇策略");
const freshness = z.enum(["fresh", "stale", "unverified", "not_applicable"]).describe("資料時間新鮮度");
const masterShape = listCompaniesOutputSchema.shape;
const seriesShape = stockPriceSeriesFullOutputSchema.shape;
const batchShape = companyMetricsBatchFullOutputSchema.shape;

const source = z.object({
  id: text("cell.sourceRefs 引用的穩定來源識別"), domain, sourceUrl: text("官方來源網址"),
  cutoff: text("來源觀測期別").nullable().describe("來源觀測期別"), retrievedAt: text("實際取得時間"),
  cache: sourceCacheObservationSchema.optional().describe("來源快取 provenance"),
  evidence: record("保留 domain client 的原始来源 metadata，包含正常化、完整性與官方來源欄位"),
}).strict().describe("去重來源及其原始證據");
const failure = z.object({ domain, code: text("錯誤碼"), reason: text("穩定原因碼").nullable().describe("穩定原因碼"), message: text("失敗原因") }).strict().describe("資料領域失敗");
const masterFreshness = z.array(z.object({ market, freshness }).describe("一個市場的公司母體 freshness")).describe("母體來源日期的七日 freshness 驗證");
const universeBase = {
  verification: masterShape.coverageVerification,
  freshness: masterFreshness,
  currentMasterOnly: z.literal(true).describe("只支援目前上市櫃公司母體"),
  historicalPointInTime: z.literal(false).describe("不是歷史當時已知的公司母體或資料 vintage"),
};
const resolvedDates = z.object({ marketDate: text("共同價格與估值完成日期").nullable().describe("共同價格與估值完成日期"), revenueMonth: text("共同月營收月份").nullable().describe("共同月營收月份") }).strict().describe("不同頻率各保留其觀測日期");
const coverage = z.object({
  price: record("價格原始 coverage、reconciliation 與 universe 限制").nullable().describe("價格原始 coverage、reconciliation 與 universe 限制"),
  valuation: record("估值原始 coverage、reconciliation 與 universe 限制").nullable().describe("估值原始 coverage、reconciliation 與 universe 限制"),
  revenue: record("營收 sourceCoverage、filingCoverage 與 reconciliation").nullable().describe("營收 sourceCoverage、filingCoverage 與 reconciliation"),
}).strict().describe("保留各領域的完整性證據；未查詢或失敗為 null，須同時檢查 failures");
const workBase = {
  orchestrationMasterCalls: z.literal(1).describe("外層公司母體呼叫一次；dependency 内部成本另列"),
  catalogCalls: count("外層 catalog 呼叫數"), resolverCalls: count("完成交易日 resolver 呼叫數"),
  resolver: completedSessionResolverEvidenceSchema.shape.workBudget.nullable().describe("resolver 官方來源工作量；未查詢為 null"),
  domainCalls: z.array(domain).describe("實际執行的批次 domain 呼叫，每個最多一次"),
  perCompanyMarketCalls: z.literal(0).describe("不執行逐公司市場行情查詢"),
  dependencyCosts: z.object({
    price: z.object({ sourceLoads: count("回傳來源數，不代表全部 HTTP 次數"), masterLookupPolicy: z.literal("dependency_managed").describe("來源 client 管理其母體查詢") }).nullable().describe("價格來源成本"),
    valuation: z.object({ sourceLoads: count("回傳來源數，不代表全部 HTTP 次數"), masterLookupPolicy: z.literal("dependency_managed").describe("來源 client 管理其母體查詢") }).nullable().describe("估值來源成本"),
    revenue: z.object({ sourceLoads: count("回傳來源數，不代表全部 HTTP 次數"), discoveryAndArchiveLoads: text("額外 discovery/archive 成本的可觀察限制"), masterLookupPolicy: z.literal("dependency_managed").describe("來源 client 管理其母體查詢") }).nullable().describe("營收來源成本"),
  }).describe("dependency 管理的來源與額外工作"),
  unitDefinition: text("工作量計數單位及 HTTP retries 的可觀察限制"),
};
const common = {
  ...successResultShape,
  evaluatedAt: text("固定本次請求的評估時間"), registryVersion: text("欄位定義版本"), snapshotId: text("綁定來源內容的快照指紋"),
  resolvedDates, sources: z.array(source).describe("去重來源表"), failures: z.array(failure).describe("來源失敗，不得解讀為零或無符合公司"),
  sourceCoverage: coverage, resolverEvidence: completedSessionResolverEvidenceSchema.nullable().describe("共用完成交易日的官方證據"),
  presentation: researchPresentationSchema.describe("明確辨識的 full/compact/summary 投影"), warnings: strings("來源、口徑與完整性警告"),
};
const scalar = z.union([z.number(), z.string(), z.boolean()]).describe("篩選值");
const filter = z.object({ field: text("欄位 ID"), op: z.enum(["gt", "gte", "lt", "lte", "between", "eq", "in"]).describe("運算子"), value: z.union([scalar, z.array(scalar)]).describe("單一值或界限／分類值陣列") }).describe("型別已驗證的篩選條件");
const evidence = z.array(z.object({ filter, outcome: z.enum(["true", "false", "unknown"]).describe("三態條件結果"), cell: researchCellSchema.nullable().describe("支持條件判定的值與 metadata；不存在 cell 為 null") }).describe("一個條件的判定證據")).describe("完整條件 evidence，含未選作輸出欄位的條件");
const companyEvidence = z.object({ code: text("公司代碼"), market, evidence }).describe("一家公司篩選證據");

export const screenCompaniesOutputSchema = z.object({
  ...common,
  query: z.object({
    market: z.enum(["all", "listed", "otc"]).describe("市場範圍"), includeFinancial: flag("保留金融公司"), includeKy: flag("保留 KY 公司"),
    industryCodes: strings("產業白名單").optional(), companyCodes: strings("公司白名單").optional(), asOf: z.literal("latest").describe("只查最新完成日"), revenueMonth: text("月營收月份 selector"),
    filters: z.array(filter).describe("AND 條件"), columns: strings("輸出欄位"), sort: z.array(z.object({ field: text("排序欄位"), direction: z.enum(["asc", "desc"]).describe("排序方向") }).describe("排序條件")).describe("整體排序鍵"), pageSize: count("頁大小").optional(), cursor: text("輸入 cursor").optional(), outputMode: mode,
  }).strict().describe("正規化後實際查詢"),
  universe: z.object({ ...universeBase, market: z.enum(["all", "listed", "otc"]).describe("市場範圍"), masterCount: count("accepted current master 公司數"), selectedCount: count("套用公司／產業條件後數量"), excludedCount: count("由母體條件排除的數量") }).strict().describe("母體選取與完整性限制"),
  counts: z.object({ selected: count("選取公司數"), matched: count("確定符合"), notMatched: count("確定不符合"), undetermined: count("資料不足無法判定"), unknownFilterCells: count("所有公司中 unknown 條件數，含確定不符合公司") }).strict().describe("三態總數，matched + notMatched + undetermined = selected"),
  resultComplete: flag("所有選取公司可判定、來源無失敗且母體 freshness 通過；不升級 heuristic universe"), rankIncomplete: flag("符合公司缺排序值；null 置後仍不能宣稱完整排名"),
  fieldCoverage: z.array(z.object({ field: text("欄位 ID"), usable: count("可用且 freshness 通過"), unavailable: count("不可用或 freshness 未通過"), statuses: z.record(z.string(), count("此狀態數量")).describe("cell 狀態分布") }).describe("單欄品質計數")).describe("所有所需欄位的品質覆蓋"),
  filterEvidence: z.array(companyEvidence).describe("本頁符合公司的完整條件證據"),
  unresolved: z.object({ total: count("無法判定公司總數"), returned: count("回傳證據數量"), omitted: count("省略證據數量"), companies: z.array(companyEvidence).describe("最多 100 家未定公司與原因") }).strict().describe("有界 unresolved evidence；省略不等於沒有未知公司"),
  page: resultMetaSchema.shape.page.describe("符合公司完成排序後的頁面；summary 本身仍涵蓋全體符合公司"),
  workBudget: z.object(workBase).strict().describe("實際邏輯查詢工作量與底層成本限制"),
}).strict().describe("台股三態篩選結果");

const applicability = z.enum(["applicable", "not_applicable", "unknown"]).describe("已確認適用、不適用或未知");
const alignment = z.object({
  policy: financialPolicy, searchWindow: strings("實際搜尋的共同曆季窗"), status: z.enum(["selected", "no_common_period", "not_applicable"]).describe("期別選取結果"), commonPeriod: text("共同季度").nullable().describe("共同季度"),
  companies: z.array(z.object({ companyCode: text("公司代碼"), constraints: z.array(z.object({ metricCode: text("指標代碼"), applicability, availablePeriods: strings("已 reported 且有限數值的可用季度") }).describe("一項財務期別約束")).describe("全部 requested metrics 的約束，不移除 missing 公司"), availablePeriods: strings("該公司全部 applicable metrics 的季度交集"), applicableMetricCount: count("約束數量，unknown 仍形成約束"), selectedPeriod: text("此公司選定季度；無交集為 null").nullable().describe("此公司選定季度；無交集為 null") }).describe("公司期別對齊證據")).describe("維持 caller 順序的期別證據"),
}).strict().describe("共同或各公司期別策略的精確結果");

export const compareCompaniesOutputSchema = z.object({
  ...common,
  query: z.object({ companyCodes: strings("caller 公司順序"), columns: strings("選取欄位"), financialPeriodPolicy: financialPolicy.optional(), fiscalPeriod: text("explicit 季度").optional(), financialBasis: z.literal("quarterly").optional().describe("財務單季口徑"), marketDate: text("價格／估值日期 selector"), revenueMonth: text("月營收 selector"), outputMode: mode }).strict().describe("實際比較查詢"),
  columns: z.array(researchFieldSchema.extend({ definitions: strings("本次實際 cell 定義"), periods: z.array(text("期別").nullable().describe("期別")).describe("本次實際 cell 期別"), definitionMismatch: flag("同欄位是否存在不同定義"), periodMismatch: flag("同欄位是否存在不同期別") }).describe("欄位定義及本次可比性")).describe("比較欄位與可比性"),
  alignment: alignment.nullable().describe("沒有財務欄位時為 null"),
  financialDefinitions: z.array(z.object({ companyCode: text("公司代碼"), metricCode: text("指標代碼"), field: text("欄位 ID"), applicability, definitionId: text("公司業別對應後定義"), meaning: text("定義及跨業別映射說明"), definitionVerified: flag("是否已確認此公司的指標定義") }).describe("公司×財務欄位定義")).describe("金融／非金融適用性與定義證據"),
  financialFreshness: z.object({ latestFilingVerified: z.literal(false).describe("未證明最新財報申報"), periodSelection: text("目前可觀察期間與歷史 vintage 限制") }).describe("財務 freshness 的能力邊界"),
  universe: z.object(universeBase).strict().describe("當前母體來源及限制"),
  financialFailures: batchShape.failures, financialCoverage: batchShape.coverage.nullable().describe("財務批次來源完整性；未查詢或整批失敗為 null"),
  workBudget: z.object({ ...workBase, financialBatchCalls: count("財務批次呼叫數"), financialBatch: batchShape.workBudget.nullable().describe("comparison 與 isolation 的實際工作量"), financialBatchDependencyCatalogLookup: text("財務 dependency catalog 查詢成本歸屬") }).strict().describe("所有來源工作量"),
}).strict().describe("跨公司與跨領域比較結果");

const indicator = z.object({
  value: z.union([z.number(), z.boolean(), z.null()]).describe("指標值；不可計算為 null"), status: z.enum(["available", "unavailable"]).describe("指標可用性"), reason: text("不可用穩定原因").nullable().describe("不可用穩定原因"), unit: text("指標單位"),
  priceBasis: z.enum(["raw_unadjusted", "price_index_compatible_corporate_action_adjusted", "raw_shares"]).describe("公式使用的價格或成交量基礎"), calculationVersion: text("計算公式版本"),
  window: z.object({ from: text("暖機／計算視窗起日").nullable().describe("暖機／計算視窗起日"), through: text("精確 as-of 日"), expectedSessions: count("所需市場 sessions"), observedSessions: count("實際取得股票 bars 的 sessions") }).strict().describe("依官方市場日曆驗證的計算視窗"),
  details: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()]).describe("公式參數或計算中間值")).describe("period、seed、referenceHigh、denominator、comparability 等可重現公式證據"),
}).strict().describe("單一可重現技術指標");
const benchmarkSource = z.object({ market, exchange: z.enum(["TWSE", "TPEx"]).describe("交易所"), benchmarkCode: z.enum(["TAIEX", "TPEX_PRICE_INDEX"]).describe("價格指數代碼"), benchmarkName: text("指數名稱"), sourceName: text("來源名稱"), sourceUrl: text("官方來源網址"), dataMonth: text("月份"), retrievedAt: text("實際取得時間"), rowCount: count("來源日資料數"), cache: sourceCacheObservationSchema.optional().describe("快取 provenance") }).strict().describe("官方市場交易日曆使用的 benchmark 來源");

export const stockTechnicalsOutputSchema = z.object({
  ...successResultShape,
  query: z.object({ companyCode: text("公司代碼"), asOf: text("最新或 exact 日期 selector"), priceBasis: seriesShape.requestedPriceBasis, indicators: strings("指標子集"), smaPeriods: z.array(count("均線長度")).describe("SMA 子集") }).strict().describe("實際指標查詢"),
  evaluatedAt: text("固定請求評估時間"), asOf: text("官方已完成交易日"), timezone: z.literal("Asia/Taipei").describe("市場時區"), interval: z.literal("1d").describe("日線"),
  company: masterShape.companies.element.describe("目前公司 identity 與原始 profile metadata"), priceBasis: seriesShape.requestedPriceBasis, isTotalReturn: z.literal(false).describe("不是含息報酬"),
  asOfEvidence: completedSessionResolverEvidenceSchema.describe("最新完成交易日的官方來源證據"), identity: seriesShape.identity,
  indicators: z.record(z.string(), indicator).describe("依指標名稱對應結果"),
  coverage: z.object({ requiredSessions: count("最大所需暖機 sessions"), observedMarketSessions: count("實際取得官方市場 sessions"), marketWindowComplete: flag("市场暖機視窗是否足夠"), priceSeries: seriesShape.coverage, indicatorsComplete: flag("全部所選指標可用") }).strict().describe("官方日曆、股價與指標完整性"),
  adjustment: seriesShape.adjustment, eventLedger: seriesShape.eventLedger,
  sources: z.object({ master: masterShape.sources, benchmark: z.array(benchmarkSource).describe("官方市場日曆來源"), prices: seriesShape.sources }).strict().describe("母體、日曆、價格與公司行動來源"),
  workBudget: z.object({ orchestrationMasterCalls: z.literal(1).describe("外層 master 呼叫數"), resolver: completedSessionResolverEvidenceSchema.shape.workBudget, benchmarkMonths: strings("已查詢 benchmark 月份"), benchmarkLogicalLoads: count("benchmark 邏輯來源次數"), maximumBenchmarkLogicalLoads: z.literal(18).describe("最多 18 個月份"), stockCalendarMonths: count("股票資料所需日曆月份"), priceSeriesCalls: z.literal(1).describe("price-series 呼叫次數"), priceSeries: seriesShape.workBudget, note: text("工作量與 HTTP retries 的計數限制") }).strict().describe("包含暖機與底層來源的有界工作量"),
  warnings: strings("來源、價格基礎與可比性警告"),
}).strict().describe("日線技術指標與來源證據");
