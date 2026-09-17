import { z } from "zod";

const value = z.union([z.number(), z.string(), z.boolean(), z.null()]).describe("原始型別的欄位值；null 不代表零");
const stringItem = z.string().describe("識別字串");
const identityShape = {
  code: z.string().describe("公司代碼"),
  name: z.string().describe("公司名稱"),
  market: z.enum(["listed", "otc"]).describe("目前上市或上櫃市場"),
};
const cellMetaShape = {
  status: z.enum(["available", "missing", "not_applicable", "invalid_upstream", "source_unavailable", "period_unaligned", "freshness_unverified"]).describe("資料可用性；不適用與缺值分開"),
  unit: z.string().describe("標準化後單位"),
  period: z.string().nullable().describe("該欄位自己的日期、月份或季度"),
  basis: z.string().describe("原始、還原或財務計算口徑"),
  definitionId: z.string().describe("指標定義識別；相同名稱不表示同義"),
  sourceRefs: z.array(stringItem).describe("共用來源表的識別碼"),
  freshness: z.enum(["fresh", "stale", "unverified", "not_applicable"]).describe("時間新鮮度，獨立於數值是否存在"),
  reason: z.string().optional().describe("缺值、不適用或不可比較原因"),
};
const normalizationShape = {
  sourceUnit: z.string().describe("來源單位"),
  factor: z.number().describe("來源值乘此數得到標準化值"),
};
export const researchCellSchema = z.object({
  ...cellMetaShape, value,
  normalization: z.object({ ...normalizationShape, sourceValue: value }).optional().describe("可追溯的單位換算"),
}).describe("單一研究欄位，包含定義、期別、品質與来源");

const presentationShape = {
  scope: z.enum(["entire_selection", "current_page"]).describe("統計或資料涵蓋整個選取集合，或目前一頁"),
  rowCount: z.number().int().nonnegative().describe("此投影涵蓋的公司數"),
};
const full = z.object({
  ...presentationShape,
  outputMode: z.literal("full").describe("完整逐格 metadata 格式"),
  rowsOmitted: z.literal(false).describe("明細未省略"),
  rows: z.array(z.object({ ...identityShape, cells: z.record(z.string(), researchCellSchema).describe("欄位 ID 對應數值與 metadata") }).describe("一家公司完整欄位")).describe("公司資料列"),
});
const compact = z.object({
  ...presentationShape,
  outputMode: z.literal("compact").describe("共用 metadata 字典的無損壓縮格式"),
  rowsOmitted: z.literal(false).describe("明細未省略"),
  columns: z.array(stringItem).describe("values 陣列對應的欄位 ID 順序"),
  cellEncoding: z.literal("[value,metadataIndex,optionalSourceValue]").describe("tuple 的解碼規則；第三元素僅在有單位換算時存在"),
  cellMetadata: z.array(z.object({ ...cellMetaShape, normalization: z.object(normalizationShape).optional().describe("共用換算單位與因子；來源數值在 cell tuple") }).describe("一組共用 cell metadata")).describe("以零起算索引引用的 metadata 字典"),
  rows: z.array(z.object({
    ...identityShape,
    values: z.array(z.union([
      z.tuple([value, z.number().int().nonnegative().describe("metadata 索引")]),
      z.tuple([value, z.number().int().nonnegative().describe("metadata 索引"), value]),
      z.null(),
    ]).describe("數值與字典索引；整格 null 表示未取得此 cell，而非 cell.value=null")).describe("依 columns 順序排列的 cells"),
  }).describe("一家公司壓縮資料")).describe("公司資料列"),
});
const summary = z.object({
  ...presentationShape,
  outputMode: z.literal("summary").describe("統計摘要格式"),
  rowsOmitted: z.literal(true).describe("逐公司明細明確省略；不表示沒有資料"),
  statistics: z.array(z.object({
    field: z.string().describe("欄位 ID"),
    total: z.number().int().nonnegative().describe("納入檢查的公司數"),
    usableCount: z.number().int().nonnegative().describe("可用且符合 freshness 的 cell 數"),
    missingCount: z.number().int().nonnegative().describe("status=missing 或未取得 cell 的公司數；不把 not_applicable 或來源失敗當成 missing"),
    missingRate: z.number().min(0).max(1).nullable().describe("missingCount / total，0–1 比率；空集合為 null"),
    unusableCount: z.number().int().nonnegative().describe("total - usableCount，包含缺值、不適用、無效、來源失敗與 freshness 不可用"),
    unusableRate: z.number().min(0).max(1).nullable().describe("unusableCount / total，0–1 比率；空集合為 null"),
    statusCounts: z.record(z.string(), z.number().int().nonnegative().describe("該狀態的數量")).describe("所有 cell 的可用性或 freshness 狀態計數"),
    definitionMismatch: z.boolean().describe("同一欄位是否存在不同指標定義"),
    groups: z.array(z.object({
      definitionId: z.string().describe("群組指標定義"), unit: z.string().describe("群組單位"),
      basis: z.string().describe("群組計算口徑"), period: z.string().nullable().describe("群組期別"),
      count: z.number().int().positive().describe("群組有效數值個數"),
      min: z.number().describe("最小值"), max: z.number().describe("最大值"), median: z.number().nullable().describe("中位數"),
    }).describe("只合併相同定義、單位、口徑及期別的數值")).describe("分組數值統計；分類欄位沒有數值群組"),
  }).describe("單一欄位的品質計數與數值摘要")).describe("欄位統計；scope 明示所涵蓋資料集"),
});

/** SDK v2 preserves object root + anyOf, including each variant's required keys. */
export const researchPresentationSchema = z.union([full, compact, summary]).describe("可明確辨識的完整、壓縮或摘要投影");
