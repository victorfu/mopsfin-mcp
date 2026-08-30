import { z } from "zod";

import type {
  TaiwanMarketUniversePageQuery,
} from "@/lib/full-screening/types";

import { successResultShape } from "./common";
import { screenTaiwanFinancialCandidatesDataSchema } from "./financial-screening";
import { screenTaiwanStockCandidatesDataSchema } from "./screening";

const marketSchema = z
  .enum(["all", "listed", "otc"])
  .describe("full-universe manifest 的上市、上櫃或合併市場範圍");

const normalizedQuerySchema = z
  .object({
    market: marketSchema.describe("本次 manifest 的市場範圍"),
    includeKy: z.boolean().describe("本次是否讓 KY 公司進入其 segment screen"),
    pageSize: z.number().int().min(1).max(5).describe("每頁最多處理的 manifest 公司數"),
    cursorProvided: z.boolean().describe("本次是否使用上一頁 cursor 繼續"),
    preset: z
      .literal("full_universe_cursor_v1")
      .describe("本次使用的固定 stateless full-universe execution 版本"),
  })
  .strict()
  .describe("正規化後實際執行的 full-universe page query") satisfies z.ZodType<
    Omit<TaiwanMarketUniversePageQuery, "cursor"> & { cursorProvided: boolean }
  >;

export const screenTaiwanMarketUniversePageInputSchema = z
  .object({
    market: marketSchema
      .default("all")
      .describe("all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx"),
    include_ky: z
      .boolean()
      .default(true)
      .describe("是否在逐頁 segment evaluation 保留 KY 公司"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(5)
      .describe("每頁公司數，預設與上限均為 5；這是頁面上限而非總量上限"),
    cursor: z
      .string()
      .max(1000)
      .optional()
      .describe("上一頁 meta.page.next.cursor；必須與 query、page_size 及 manifest snapshot 相同"),
    preset: z
      .literal("full_universe_cursor_v1")
      .default("full_universe_cursor_v1")
      .describe("固定的 manifest-bound stateless cursor execution 版本"),
  })
  .strict()
  .describe("screen_taiwan_market_universe_page 的 strict cursor input");

const resultPageMetaSchema = z
  .object({
    mode: z.literal("cursor").describe("本工具固定使用 cursor 分頁"),
    unit: z.literal("company").describe("limit、returned 與 total 均以公司計"),
    limit: z.number().int().describe("第一頁綁定並沿 cursor 保持的 page_size"),
    returned: z.number().int().describe("本頁 manifest 公司數"),
    total: z.number().int().describe("current manifest 的公司總數"),
    next: z
      .object({
        kind: z.literal("cursor").describe("下一頁使用不透明 cursor"),
        cursor: z.string().describe("query/snapshot/page-size-bound 下一頁 cursor"),
      })
      .strict()
      .nullable()
      .describe("下一頁 cursor；null 表示已到 manifest 結尾"),
  })
  .strict()
  .describe("與共用 meta.page 相同語意的 domain page 狀態");

const terminalResultSchema = z
  .object({
    manifestIndex: z.number().int().nonnegative().describe("公司在完整 ordered manifest 的零起算位置"),
    companyCode: z.string().regex(/^\d{4}$/).describe("本頁公司四碼股票代號"),
    companyName: z.string().describe("本頁 segment result 的公司名稱"),
    market: z.enum(["listed", "otc"]).describe("公司目前上市或上櫃市場"),
    segment: z.enum(["non_financial", "financial"]).describe("實際評估公司的模型 segment"),
    route: z
      .enum(["candidate", "not_reaction_scored", "excluded"])
      .describe("本頁完成後恰好一個 terminal route"),
    bucket: z
      .enum(["research_candidate", "watchlist", "insufficient_data", "deprioritized"])
      .nullable()
      .describe("candidate route 的四柱 bucket；其他 terminal route 為 null"),
    reasonCodes: z
      .array(z.string().describe("單一 terminal route 原因代號"))
      .describe("not-reaction/excluded 的原因；candidate 通常為空"),
    detailCollection: z
      .enum(["candidates", "notReactionScored", "excluded"])
      .describe("可在本頁 segment result 中找到完整 evidence 的 collection"),
    detailIndex: z.number().int().nonnegative().describe("完整 evidence 在 detailCollection 的零起算位置"),
    rankScope: z
      .literal("page_segment_only")
      .describe("任何 candidate rank 只屬本頁該模型，不能宣稱全市場 rank"),
  })
  .strict()
  .describe("一家公司在本頁完成且可回查完整 evidence 的 terminal ledger row");

export const screenTaiwanMarketUniversePageDataSchema = z
  .object({
    query: normalizedQuerySchema.describe("正規化後的 full-universe page query"),
    generatedAt: z.string().datetime({ offset: true }).describe("本服務完成本頁的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("日期與 latest selectors 使用的時區"),
    executionDefinition: z
      .object({
        id: z.literal("taiwan_market_full_universe.v1").describe("full-universe execution 穩定識別碼"),
        preset: z.literal("full_universe_cursor_v1").describe("stateless cursor preset"),
        posture: z.literal("research_triage_not_recommendation").describe("只供研究分流，不是投資建議"),
        mode: z.literal("full_universe_cursor").describe("逐頁完整路由 current manifest 的 execution mode"),
        pageCompanyLimit: z.literal(5).describe("每頁固定最大公司數"),
        underlyingModels: z
          .tuple([
            z.literal("taiwan_stock_screen.v2").describe("非金融 underlying model"),
            z.literal("taiwan_financial_screen.v1").describe("金融 underlying model"),
          ])
          .describe("逐公司依金融分類路由的兩個既有模型"),
        snapshotScope: z
          .literal("manifest_company_identity_only")
          .describe("cursor 只 pin current master identity manifest，不 pin 未讀頁逐公司值"),
        pageValuesPinned: z.literal(false).describe("逐頁財務、營收、估值與行情不跨頁 materialize"),
        pointInTime: z.literal(false).describe("此 stateless execution 不是 point-in-time vintage"),
        globalRankAvailable: z.literal(false).describe("收齊所有頁前不提供全市場 rank"),
        sharedDependencyFailurePolicy: z
          .literal("fail_page_without_advancing_cursor")
          .describe("shared/dependency failure 使整頁失敗，caller 重試相同 cursor"),
      })
      .strict()
      .describe("full-universe cursor 的 snapshot、失敗與誠實輸出政策"),
    manifest: z
      .object({
        snapshotId: z.string().regex(/^market-universe-[A-Za-z0-9_-]{32}$/).describe("query 與完整 current company identity manifest 的 content fingerprint"),
        companyCount: z.number().int().nonnegative().describe("完整 manifest 公司數"),
        listedCount: z.number().int().nonnegative().describe("manifest 上市公司數"),
        otcCount: z.number().int().nonnegative().describe("manifest 上櫃公司數"),
        financialCount: z.number().int().nonnegative().describe("manifest 金融公司數"),
        nonFinancialCount: z.number().int().nonnegative().describe("manifest 非金融公司數"),
        excludedKyCount: z.number().int().nonnegative().describe("include_ky=false 時 manifest 內將 policy-exclude 的 KY 數"),
        masterReportDates: z.array(z.string().describe("公司 master 官方出表日期")).describe("manifest 使用的各市場 master report dates"),
        coverageVerification: z
          .object({
            status: z.literal("heuristic").describe("公司 master 只能做 heuristic coverage gate"),
            officialDeclaredRowCountAvailable: z.literal(false).describe("官方沒有 declared row count"),
          })
          .strict()
          .describe("current company manifest 的官方完整性驗證界線"),
      })
      .strict()
      .describe("跨頁固定核對的 current company identity manifest"),
    page: z
      .object({
        startIndex: z.number().int().nonnegative().describe("本頁在 manifest 的零起算起點"),
        endIndexExclusive: z.number().int().nonnegative().describe("本頁在 manifest 的不含尾端位置"),
        companyCodes: z.array(z.string().regex(/^\d{4}$/).describe("本頁公司代號")).describe("本頁依 manifest order 的公司代號"),
        hasMore: z.boolean().describe("manifest 是否仍有下一頁"),
        nextCursor: z.string().nullable().describe("下一頁 cursor；結尾為 null"),
        meta: resultPageMetaSchema.describe("domain 內對應共用 meta.page 的分頁狀態"),
      })
      .strict()
      .describe("本頁 manifest 範圍與下一頁位置"),
    coverage: z
      .object({
        pageSelectionComplete: z.literal(true).describe("本頁每個 manifest code 都送入正確 segment"),
        pageTerminalReconciliationComplete: z.literal(true).describe("本頁每家公司恰好有一個 terminal route"),
        pageSourceComplete: z.boolean().describe("本頁已執行 segments 的必要來源是否完整"),
        manifestIdentityPinned: z.literal(true).describe("cursor 會拒絕 changed current-master manifest"),
        pageValuesPinned: z.literal(false).describe("逐公司 evidence 不跨頁 pin"),
        pointInTime: z.literal(false).describe("不是歷史 point-in-time snapshot"),
        globalRankAvailable: z.literal(false).describe("沒有全市場 rank"),
        pageEndReached: z.boolean().describe("本頁是否已到 manifest 結尾"),
      })
      .strict()
      .describe("本頁完整路由與 stateless snapshot scope"),
    segments: z
      .object({
        nonFinancial: screenTaiwanStockCandidatesDataSchema
          .nullable()
          .describe("本頁有非金融公司時的完整 segment evidence；否則 null"),
        financial: screenTaiwanFinancialCandidatesDataSchema
          .nullable()
          .describe("本頁有金融公司時的完整 segment evidence；否則 null"),
      })
      .strict()
      .describe("本頁兩個 underlying models 的完整 evidence"),
    terminalResults: z
      .array(terminalResultSchema.describe("一筆本頁 terminal ledger row"))
      .describe("與 page.companyCodes 一對一且同 manifest order 的 terminal results"),
    warnings: z
      .array(z.string().describe("單一 snapshot、rank、coverage 或非投資建議警示"))
      .describe("回答時不可忽略的 stateless full-universe 限制"),
  })
  .strict()
  .describe("current manifest 中一頁公司的完整雙模型路由與 evidence");

export const screenTaiwanMarketUniversePageOutputSchema = z
  .object({
    ...successResultShape,
    ...screenTaiwanMarketUniversePageDataSchema.shape,
  })
  .strict()
  .describe("screen_taiwan_market_universe_page 的 success envelope 與完整 page result");
