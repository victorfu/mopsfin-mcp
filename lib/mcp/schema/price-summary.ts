import { z } from "zod";
import { sourceCacheObservationSchema } from "./common";

const text = (description: string) => z.string().describe(description);
const count = (description: string) => z.number().int().nonnegative().describe(description);
const dates = (description: string) => z.array(text("日期或月份")).describe(description);
const stat = z.object({ value: z.number().nullable().describe("統計值；不可計算為 null"), status: z.enum(["available", "unavailable"]).describe("統計可用性"), reason: z.string().nullable().describe("不可計算的穩定原因"), unit: text("數值單位") }).strict().describe("透明公式統計值");
export const priceSummaryOutputShape = {
  outputMode: z.literal("summary").describe("完整 requested window 摘要模式"),
  barsOmitted: z.literal(true).describe("原始 bars 明確省略；不代表沒有行情"),
  summary: z.object({
    scope: z.literal("complete_collected_requested_window").describe("涵蓋完整收齊的 requested window，不是只取一頁"),
    priceBasis: z.enum(["raw_unadjusted", "price_index_compatible_corporate_action_adjusted"]).describe("計算所用價格口徑；adjusted 缺值不回退 raw"),
    firstDate: z.string().nullable().describe("第一根觀察 bar 日期"), lastDate: z.string().nullable().describe("最後觀察 bar 日期"),
    barCount: count("收集到的 bars 數"), validCloseCount: count("所選口徑中正數且有限的 traded close 數"),
    firstClose: z.number().nullable().describe("首根所選口徑 close"), lastClose: z.number().nullable().describe("末根所選口徑 close"), expectedSessions: z.number().int().nullable().describe("官方範圍交易日數；無法驗證為 null"),
    missingSessionDates: dates("官方交易日中缺少股票 bar 的日期"), unexpectedBarDates: dates("股票 bar 不在官方 session grid 中的日期"), calendarVerified: z.boolean().describe("完整 session grid 是否已驗證且與 bars 吻合"),
    endpointReturnPercent: stat, maxDrawdownPercent: stat, dailyLogReturnSampleStdDev: stat,
    calculation: z.object({ version: text("計算版本"), volatilityDdof: z.literal(1).describe("樣本標準差自由度"), volatilityAnnualized: z.literal(false).describe("日對數報酬標準差不年化"), drawdownBasis: z.literal("close").describe("以收盤價計算最大回撤"), endpointReturnBasis: z.literal("observed_first_to_last_close_only").describe("端點報酬只描述第一根至最後一根觀察 close；不要求中間逐日完整"), isTotalReturn: z.literal(false).describe("不是股息再投資／含息總報酬") }).strict().describe("完整公式及口徑"),
    complete: z.boolean().describe("三項價格統計是否都可計算"),
  }).strict().describe("價格序列與每日 session grid 的統計摘要"),
  summarySources: z.array(z.object({
    market: z.enum(["listed", "otc"]).describe("市場"), exchange: z.enum(["TWSE", "TPEx"]).describe("交易所"), benchmarkCode: z.enum(["TAIEX", "TPEX_PRICE_INDEX"]).describe("指數代碼"), benchmarkName: text("指數名稱"), sourceName: text("來源名稱"), sourceUrl: text("官方來源網址"), dataMonth: text("月份"), retrievedAt: text("來源取得時間"), rowCount: count("來源 row 數"), cache: sourceCacheObservationSchema.optional().describe("快取 provenance"),
  }).strict().describe("用來驗證逐日頻率的官方 benchmark 來源")).describe("摘要額外需要的官方日曆來源，與原價格來源分開"),
  summaryFailure: z.object({ code: text("錯誤碼"), message: text("來源失敗原因") }).nullable().describe("日曆失敗；不掩蓋為資料不足或正常無資料"),
  summaryWorkBudget: z.object({ benchmarkCalls: count("benchmark history 呼叫數"), requestedBenchmarkMonths: dates("要求的月份"), benchmarkMonthLogicalLoads: count("要求的月份來源工作數"), maximumBenchmarkMonths: z.literal(36).describe("有界月份數，與 price-series 相同範圍上限"), retries: text("重試／整體 deadline 政策") }).strict().describe("摘要額外來源成本；不宣稱只省 token 就同時節省 upstream"),
};
