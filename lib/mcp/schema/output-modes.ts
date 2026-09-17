import { z } from "zod";
import { researchPresentationSchema } from "./research";

export const outputModeInput = z.enum(["full", "compact", "summary"]).optional().describe("省略或 full 保留原完整回應；compact 回壓縮欄位表，summary 回統計摘要；不代表節省上游查詢");
export const marketOutputModeInputShape = {
  output_mode: outputModeInput,
  columns: z.array(z.string().min(1).max(100).describe("研究欄位 ID；限工具所屬 domain 與 company.code/name/market")).min(1).max(24).optional().describe("可選欄位投影；與 output_mode 組合會回明確 presentation 格式，省略維持原欄位"),
};
export const marketProjectionOutputShape = {
  outputMode: z.enum(["full", "compact", "summary"]).describe("此次欄位投影模式"),
  rawRowsOmitted: z.literal(true).describe("原始 rows/bars 被 presentation 取代，不是空資料集"),
  presentation: researchPresentationSchema.describe("選取欄位的數值、metadata 字典或分組統計；summary scope=entire_selection"),
  projection: z.object({
    columns: z.array(z.string().describe("欄位 ID")).describe("所選欄位順序"),
    sourceRefEncoding: z.literal("sources[index]").describe("sourceRefs 指向既有 sources 陣列的零起算索引"),
    upstreamSavingsClaimed: z.literal(false).describe("此投影只減少輸出資料量，不宣稱減少上游查詢"),
  }).strict().describe("欄位投影解碼與成本說明"),
};
