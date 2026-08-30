import { z } from "zod";

import type {
  TaiwanMarketScreenQuery,
} from "@/lib/market-screening/types";

import { successResultShape } from "./common";
import { screenTaiwanFinancialCandidatesDataSchema } from "./financial-screening";
import { screenTaiwanStockCandidatesDataSchema } from "./screening";

const marketSelectionSchema = z
  .enum(["all", "listed", "otc"])
  .describe("全市場候選組合的目前上市櫃市場範圍");

const companyMarketSchema = z
  .enum(["listed", "otc"])
  .describe("候選公司的目前上市或上櫃市場");

const normalizedMarketScreenQuerySchema = z
  .object({
    market: marketSelectionSchema.describe("本次實際掃描的目前市場母體"),
    includeKy: z.boolean().describe("本次兩個 segment 是否都保留 KY 公司"),
    nonFinancialLimit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe("非金融 segment 合併前最多保留的候選數"),
    financialLimit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe("金融 segment 合併前最多保留的候選數"),
    preset: z
      .literal("balanced_market_v1")
      .describe("本次使用的固定跨模型組合規則版本"),
  })
  .strict()
  .describe("正規化後實際執行的 latest-only 全市場組合條件") satisfies z.ZodType<TaiwanMarketScreenQuery>;

export const screenTaiwanMarketCandidatesInputSchema = z
  .object({
    market: marketSelectionSchema
      .default("all")
      .describe("all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx"),
    include_ky: z
      .boolean()
      .default(true)
      .describe("是否在非金融與金融兩個 segment 都保留 KY 公司"),
    non_financial_limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(4)
      .describe("非金融模型合併前候選配額，必須是 1 至 5 的整數"),
    financial_limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(1)
      .describe("金融模型合併前候選配額，必須是 1 至 5 的整數"),
    preset: z
      .literal("balanced_market_v1")
      .default("balanced_market_v1")
      .describe("固定的全市場跨模型組合規則版本"),
  })
  .strict()
  .describe("screen_taiwan_market_candidates 的 strict bounded 輸入");

const marketScreenShortlistItemSchema = z
  .object({
    combinedRank: z
      .number()
      .int()
      .positive()
      .describe("依固定跨模型 merge policy 產生的一日起算最終排序"),
    segment: z
      .enum(["non_financial", "financial"])
      .describe("候選來源的非金融或金融模型 segment"),
    segmentPriority: z
      .union([z.literal(0), z.literal(1)])
      .describe("bucket 同級時使用的固定 segment 排序優先序"),
    segmentQuota: z
      .number()
      .int()
      .min(1)
      .max(5)
      .describe("此候選來源 segment 在合併前套用的固定配額"),
    companyCode: z.string().describe("候選公司的四碼股票代號"),
    companyName: z.string().describe("候選公司的簡稱"),
    market: companyMarketSchema.describe("候選公司目前上市或上櫃市場"),
    financialSubtype: z
      .enum(["holding", "bank", "bills"])
      .nullable()
      .describe("金融候選的支援子業別；非金融候選固定為 null"),
    modelId: z
      .enum(["taiwan_stock_screen.v2", "taiwan_financial_screen.v1"])
      .describe("產生此候選的 segment 模型識別碼"),
    modelPreset: z
      .enum(["balanced_non_financial_v2", "balanced_financial_v1"])
      .describe("產生此候選的 segment 固定規則版本"),
    withinModelRank: z
      .number()
      .int()
      .positive()
      .describe("候選在原始 segment 模型內的一日起算排名"),
    withinModelScore: z
      .number()
      .nullable()
      .describe("原始 segment 模型內的輔助分數；只保留展示且不得跨模型比較"),
    scoreComparisonScope: z
      .literal("within_model_only")
      .describe("明示 raw score 只允許在原始模型內比較"),
    bucket: z
      .enum([
        "research_candidate",
        "watchlist",
        "insufficient_data",
        "deprioritized",
      ])
      .describe("原始模型依四柱 hard gates 產生的研究分流 bucket"),
  })
  .strict()
  .describe("依 segment quota 選入並保留原始模型排名語意的單一合併候選");

const compositionCountsSchema = z
  .object({
    nonFinancial: z
      .number()
      .int()
      .nonnegative()
      .describe("非金融 segment 的候選數"),
    financial: z
      .number()
      .int()
      .nonnegative()
      .describe("金融 segment 的候選數"),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe("非金融與金融 segment 候選數合計"),
  })
  .strict()
  .describe("全市場組合中兩個 segments 的候選數量對帳");

export const screenTaiwanMarketCandidatesDataSchema = z
  .object({
    query: normalizedMarketScreenQuerySchema.describe("正規化後實際執行的全市場組合 query"),
    generatedAt: z
      .string()
      .datetime({ offset: true })
      .describe("本服務完成全市場候選組合的 ISO 8601 時間"),
    timezone: z
      .literal("Asia/Taipei")
      .describe("latest 與市場日期解讀使用的時區"),
    screenDefinition: z
      .object({
        id: z
          .literal("taiwan_market_screen.v1")
          .describe("全市場跨模型組合器的穩定定義版本"),
        preset: z
          .literal("balanced_market_v1")
          .describe("全市場跨模型組合規則 preset"),
        posture: z
          .literal("research_triage_not_recommendation")
          .describe("結果只供研究候選分流，不是投資建議"),
        crossModelScoreComparable: z
          .literal(false)
          .describe("金融與非金融 raw score 不得直接比較"),
        segmentFailurePolicy: z
          .literal("fail_combined_request")
          .describe("任一 segment 拒絕時整個組合請求失敗，避免回傳不明示的半套市場結果"),
        mergePolicy: z
          .object({
            quotaAppliedBeforeMerge: z
              .literal(true)
              .describe("兩個 segment 都先套用各自配額，再進行合併排序"),
            bucketPriority: z
              .tuple([
                z
                  .literal("research_candidate")
                  .describe("第一優先的研究候選 bucket"),
                z.literal("watchlist").describe("第二優先的觀察 bucket"),
                z
                  .literal("insufficient_data")
                  .describe("第三優先的證據不足 bucket"),
                z
                  .literal("deprioritized")
                  .describe("第四優先的降低研究優先序 bucket"),
              ])
              .describe("合併時由高至低套用的固定 bucket 優先序"),
            segmentPriority: z
              .tuple([
                z
                  .literal("non_financial")
                  .describe("同 bucket 下第一優先的非金融 segment"),
                z
                  .literal("financial")
                  .describe("同 bucket 下第二優先的金融 segment"),
              ])
              .describe("同 bucket 候選的固定 segment 優先序"),
            finalTieBreak: z
              .literal("within_model_rank_then_company_code")
              .describe("同 bucket、segment 後依模型內排名與股票代號破同分"),
            compareRawOverallScoreAcrossModels: z
              .literal(false)
              .describe("合併排序不讀取或比較兩個模型的 raw overallScore"),
            refillUnusedQuotaAcrossSegments: z
              .literal(false)
              .describe("任一 segment 未填滿時不得由另一個模型跨段補額"),
          })
          .strict()
          .describe("不直接比較 raw score 的固定配額式跨模型合併政策"),
      })
      .strict()
      .describe("balanced_market_v1 的跨模型可比性、失敗與合併政策"),
    segments: z
      .object({
        nonFinancial: screenTaiwanStockCandidatesDataSchema.describe(
          "完整保留、不改寫排序與證據的非金融 screen domain result",
        ),
        financial: screenTaiwanFinancialCandidatesDataSchema.describe(
          "完整保留、不改寫排序與證據的金融 screen domain result",
        ),
      })
      .strict()
      .describe("兩個獨立模型的原始完整 bounded screen 結果"),
    shortlist: z
      .array(
        marketScreenShortlistItemSchema.describe("一筆配額內的合併研究候選"),
      )
      .describe("先套用 segment 配額，再依固定 bucket 與 segment priority 合併的短名單"),
    composition: z
      .object({
        requested: compositionCountsSchema.describe("caller 要求的兩個 segment 配額與總數"),
        returned: compositionCountsSchema.describe("實際選入短名單的兩個 segment 數量與總數"),
        unfilled: compositionCountsSchema.describe("因 segment 候選不足而未填滿的配額與總數"),
        nonFinancialResultPreserved: z
          .literal(true)
          .describe("非金融原始 domain result 是否完整保留"),
        financialResultPreserved: z
          .literal(true)
          .describe("金融原始 domain result 是否完整保留"),
      })
      .strict()
      .describe("各 segment 配額、回傳、缺額與原始結果保留狀態"),
    warnings: z
      .array(z.string().describe("單一跨模型可比性、配額、覆蓋或非投資建議警示"))
      .describe("回答時不可忽略的全市場組合限制"),
  })
  .strict()
  .describe("非金融與金融專用模型配額式合併的完整可稽核 domain result");

export const screenTaiwanMarketCandidatesOutputSchema = z
  .object({
    ...successResultShape,
    ...screenTaiwanMarketCandidatesDataSchema.shape,
  })
  .strict()
  .describe("screen_taiwan_market_candidates 的成功 envelope、共用 MCP metadata 與完整 domain result");
