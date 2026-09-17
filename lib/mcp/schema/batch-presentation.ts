import { z } from "zod";

const text = (description: string) => z.string().describe(description);
const count = (description: string) => z.number().int().nonnegative().describe(description);
const strings = (description: string) => z.array(text("識別值")).describe(description);
const coverageShape = {
  seriesReturned: z.boolean().describe("來源是否回傳序列"), nonNullPoints: count("有效點數"), missingPoints: count("缺值點數"), invalidPoints: count("無效點數"),
  firstReportedPeriod: text("最早 reported 期別").nullable().describe("最早 reported 期別"), latestReportedPeriod: text("最晚 reported 期別").nullable().describe("最晚 reported 期別"), missingPeriods: strings("缺值期別"),
};
const failure = z.object({ code: text("錯誤碼"), reason: text("原因碼").nullable().describe("原因碼"), message: text("錯誤訊息"), retryable: z.boolean().describe("是否可重試"), retryAfterMs: count("建議等待毫秒").nullable().describe("建議等待毫秒"), action: text("建議後續行動") }).strict();
const pointValue = z.number().nullable().describe("數值；null 不代表零");
const periodIndex = count("periods 字典索引");
const statusIndex = z.number().int().min(0).max(2).describe("pointStatusEncoding 索引");
export const batchPresentationSchema = z.union([
  z.object({
    scope: z.literal("current_page").describe("只涵蓋目前公司頁"), outputMode: z.literal("compact").describe("字典壓縮格式"), companiesOmitted: z.literal(false).describe("公司明細未省略"),
    periods: strings("共用期別字典"), pointStatusEncoding: z.array(z.enum(["reported", "missing", "invalid_upstream"]).describe("point 狀態")).describe("固定順序的狀態字典"),
    pointEncoding: z.literal("[periodIndex,value,valueStatusIndex,optionalStatus]").describe("每個 point 的 tuple 解碼規則"),
    metricMetadata: z.array(z.object({ metricCode: text("指標代號"), metricName: text("指標名称"), unit: text("原始官方單位，不猜測換算"), availability: z.enum(["available", "no_data", "unavailable"]).describe("來源可用性"), coverage: z.object(coverageShape).strict().describe("原始逐序列 coverage"), failure: failure.nullable().describe("逐序列失敗證據") }).strict().describe("共用 metric metadata")).describe("以零起算索引引用的 metric metadata 字典"),
    companies: z.array(z.object({ companyCode: text("公司代號"), companyName: text("公司名稱"), displayName: text("來源完整身份名稱"), evaluationStatus: z.enum(["complete", "partial", "unavailable"]).describe("公司評估狀態"), metrics: z.array(z.object({ metadataIndex: count("metricMetadata 索引"), periodIndexes: z.array(periodIndex).describe("原始 metric.periods 的字典索引，保留順序"), points: z.array(z.union([z.tuple([periodIndex, pointValue, statusIndex]), z.tuple([periodIndex, pointValue, statusIndex, text("來源附加 point.status")])]).describe("無損 point tuple")).describe("依原順序保留所有 points") }).strict().describe("一個公司的 metric 壓縮序列")).describe("所有要求的 metrics，保留原本 coverage 與 failure") }).strict().describe("本頁一家公司")).describe("本頁 identity 已取得的公司資料"),
  }).strict(),
  z.object({
    scope: z.literal("current_page").describe("只涵蓋目前公司頁；不代表所有 requested companies"), outputMode: z.literal("summary").describe("本頁統計摘要"), companiesOmitted: z.literal(true).describe("公司明細已省略，不代表沒有資料"),
    evaluatedCompanyCodes: strings("本頁實際評估的 requested companies，含失敗公司"), returnedCompanyCount: count("完成 identity 的公司數"),
    metricCoverage: z.array(z.object({ metricCode: text("指標代碼"), available: count("可用公司數"), noData: count("合法沒有數據的公司數"), unavailable: count("來源不可用的公司數"), pointStatuses: z.object({ reported: count("reported 點數"), missing: count("missing 點數"), invalid_upstream: count("invalid 點數") }).describe("全部 point 狀態計數") }).strict().describe("本頁逐指標覆蓋")).describe("品質計數，不以可用數據掩蓋失敗"),
    groups: z.array(z.object({ metricCode: text("指標代碼"), metricName: text("指標名稱"), unit: text("原始官方單位"), basis: text("單季或累計同比"), period: text("共同季度"), definitionId: text("可比較定義；未知業別映射按公司隔離"), companyCodes: strings("群組公司"), count: count("有效值個數"), min: z.number().describe("最小值"), max: z.number().describe("最大值"), median: z.number().nullable().describe("中位數") }).strict().describe("相同定義／期間／單位的數值群組")).describe("本頁可比較統計"),
    definitionPolicy: text("未驗證業別映射時不跨公司聚合的政策"),
  }).strict(),
]).describe("保留本頁 scope 的財務批次 compact 或 summary");
