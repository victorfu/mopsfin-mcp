import { z } from "zod";
const text = (description: string) => z.string().describe(description);
const flag = (description: string) => z.boolean().describe(description);
const domain = z.enum(["company", "price", "valuation", "revenue", "financial"]).describe("資料來源領域");

export const researchFieldSchema = z.object({
  id: text("欄位 ID"), name: text("欄位名稱"), type: z.enum(["number", "string", "boolean"]).describe("值型別"),
  unit: text("輸出單位"), domain, frequency: z.enum(["snapshot", "daily", "monthly", "quarterly"]).describe("資料頻率"),
  basis: text("計算口徑"), definitionId: text("定義識別"), dependencies: z.array(domain).describe("實際來源依賴"),
  applicability: z.enum(["all", "non_financial", "industry_specific", "unknown"]).describe("業別適用性；unknown 不能自行猜測"),
  filterOperators: z.array(z.enum(["gt", "gte", "lt", "lte", "between", "eq", "in"]).describe("支援的運算子")).describe("允許的篩選運算子"),
  sortable: flag("是否可排序"), cost: z.enum(["master", "market_bulk", "company_metric_batch"]).describe("取得成本類別"),
  normalization: z.object({ sourceUnit: text("來源單位"), outputUnit: text("輸出單位"), factor: z.number().describe("來源乘數") }).nullable().describe("已確認的單位轉換；null 不猜測"),
  supportedTools: z.array(z.enum(["screen_companies", "compare_companies", "get_daily_market_ohlc", "get_daily_market_valuation", "get_monthly_revenue"]).describe("可用工具")).describe("支援此欄位的研究或市場投影工具；篩選／排序運算子只適用 screen_companies"),
}).strict().describe("研究欄位定義");
