import { z } from "zod";

const companyCode = z.string().regex(/^\d{4}$/).describe("目前上市櫃四位公司代碼");
const fieldId = z.string().min(1).max(100).describe("list_catalog research_fields 中的欄位 ID");
const outputMode = z.enum(["full", "compact", "summary"]).default("compact").describe("full 保留逐格 metadata；compact 使用 metadata 字典；summary 僅回傳分組統計，仍保留來源與品質");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "必須是有效日曆日期").describe("YYYY-MM-DD，必須是已完成的官方交易日");
const month = z.union([z.literal("latest"), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)]).default("latest").describe("latest 共同官方月營收月份，或明確 YYYY-MM；不是資料首次公開日期");
const scalar = z.union([z.number().finite(), z.string().max(100), z.boolean()]).describe("有限數字、字串或布林值，型別須與欄位一致");
const filter = z.object({
  field: fieldId,
  op: z.enum(["gt", "gte", "lt", "lte", "between", "eq", "in"]).describe("數值使用 gt/gte/lt/lte/between，分類使用 eq/in；between 含兩端"),
  value: z.union([scalar, z.array(scalar).min(1).max(500)]).describe("單一值，between 的 [下界,上界] 或 in 的非空值陣列"),
}).strict().describe("一個有型別的篩選條件；所有條件以 AND 組合，缺值為 unknown");
const unique = (items: readonly unknown[]) => new Set(items).size === items.length;

export const screenCompaniesInputSchema = z.object({
  market: z.enum(["all", "listed", "otc"]).default("all").describe("目前上市／上櫃或兩市公司母體"),
  include_financial: z.boolean().default(true).describe("是否保留金融業公司"),
  include_ky: z.boolean().default(true).describe("是否保留 KY 公司"),
  industry_codes: z.array(z.string().max(20).describe("官方 catalog 產業代碼")).min(1).max(100).optional().describe("可選產業白名單，查詢前由 catalog 驗證"),
  company_codes: z.array(companyCode).min(1).max(500).optional().describe("可選公司白名單；省略表示整個所選市場母體"),
  as_of: z.literal("latest").default("latest").describe("第一版限最新共同完成交易日；不提供歷史 point-in-time 選股"),
  revenue_month: month,
  filters: z.array(filter).min(1).max(12).describe("必填 1–12 個 AND 條件；不接受任意公式或來源網址，單純列公司請使用 list_companies"),
  columns: z.array(fieldId).min(1).max(24).default(["price.close", "valuation.pe", "revenue.yoy_pct"]).describe("回傳欄位；公司 identity 固定保留；隱藏的篩選欄位仍回 evidence"),
  sort: z.array(z.object({ field: fieldId, direction: z.enum(["asc", "desc"]).describe("升冪或降冪；null 永遠置後") }).strict().describe("一個排序鍵")).max(3).default([]).describe("最多三個排序键；全體符合公司排序後才分頁，最後以市場與代碼定序"),
  page_size: z.number().int().min(1).max(100).optional().describe("首頁預設 50、上限 100；後頁省略時沿用 cursor 的大小"),
  cursor: z.string().max(1000).optional().describe("與參數、欄位版本及來源內容綁定的無狀態 cursor；來源修訂需重啟分頁"),
  output_mode: outputMode,
}).strict();

export const compareCompaniesInputSchema = z.object({
  company_codes: z.array(companyCode).min(1).max(20).refine(unique, "公司代碼不可重複").describe("1–20 家公司，維持 caller 順序且不分公司頁"),
  columns: z.array(fieldId).min(1).max(24).refine(unique, "欄位不可重複").describe("最多 24 欄，其中 financial.<catalog code> 最多 8 個季度指標"),
  financial_period_policy: z.enum(["common_latest", "company_latest", "explicit"]).optional().describe("有 financial 欄位時預設 common_latest；latest 策略只搜尋最近 12 個已完成曆季，無交集不回退"),
  financial_period: z.string().regex(/^\d{4}Q[1-4]$/).optional().describe("explicit 策略必填的 YYYYQn；其他策略不得提供"),
  financial_basis: z.literal("quarterly").optional().describe("第一版只支援單季；未指定視為 quarterly，不自動合成 TTM"),
  market_date: z.union([z.literal("latest"), date]).default("latest").describe("價格／估值的 latest 完成日或 exact 歷史交易日；不是整份比較的歷史 as-of"),
  revenue_month: month,
  output_mode: outputMode,
}).strict().superRefine((query, context) => {
  const count = query.columns.filter((field) => field.startsWith("financial.")).length;
  if (count > 8) context.addIssue({ code: "custom", path: ["columns"], message: "financial 欄位最多 8 個" });
  if (!count && (query.financial_period_policy !== undefined || query.financial_period !== undefined || query.financial_basis !== undefined)) context.addIssue({ code: "custom", path: ["financial_period_policy"], message: "未要求 financial 欄位時不得提供財務期間參數" });
  if (query.financial_period_policy === "explicit" ? !query.financial_period : query.financial_period !== undefined) context.addIssue({ code: "custom", path: ["financial_period"], message: "只有 explicit 可以且必須指定 financial_period" });
});

export const stockTechnicalsInputSchema = z.object({
  company_code: companyCode,
  as_of: z.union([z.literal("latest"), date]).default("latest").describe("latest 完成交易日或 exact 過去交易日；非交易日不改取前一日"),
  price_basis: z.enum(["raw_unadjusted", "price_index_compatible_corporate_action_adjusted"]).default("price_index_compatible_corporate_action_adjusted").describe("預設公司行動調整、保留現金除息效果；不是含息報酬，調整失敗不得回退 raw"),
  indicators: z.array(z.enum(["sma", "rsi", "historical_volatility", "breakout", "volume_ratio"]).describe("指標類別")).min(1).max(5).refine(unique, "指標不可重複").default(["sma", "rsi", "historical_volatility", "breakout", "volume_ratio"]).describe("只取得所選指標必要歷史；RSI14 固定需要 251 closes，其餘不強制此暖機長度"),
  sma_periods: z.array(z.union([z.literal(5), z.literal(10), z.literal(20), z.literal(60), z.literal(120), z.literal(200)]).describe("均線市場交易日長度")).min(1).max(6).refine(unique, "均線長度不可重複").default([20, 60, 200]).describe("SMA 子集；包含 as_of 收盤，缺交易日不補值"),
}).strict();
