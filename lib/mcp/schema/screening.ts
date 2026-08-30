import { z } from "zod";

import {
  sourceCacheObservationSchema,
  successResultShape,
  warningShape,
} from "./common";

export const screenTaiwanStockCandidatesInputSchema = z
  .object({
    market: z
      .enum(["all", "listed", "otc"])
      .default("all")
      .describe(
        "目前公司母體與粗篩來源的市場：all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx",
      ),
    company_codes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("可選的四碼目前上市櫃公司股票代號"),
      )
      .min(1)
      .max(100)
      .optional()
      .describe(
        "可選且不得重複的 1 至 100 家自訂母體；省略時掃描所選市場目前 heuristic-gated 公司母體",
      ),
    include_ky: z
      .boolean()
      .default(true)
      .describe("是否保留 KY 公司；金融保險業不受此欄位影響，v2 固定排除"),
    candidate_limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(5)
      .describe(
        "最多進入 reaction 階段並回傳完整四柱結果的公司數，預設及上限 5；粗篩後深篩仍固定最多 10 家",
      ),
    preset: z
      .literal("balanced_non_financial_v2")
      .default("balanced_non_financial_v2")
      .describe(
        "固定透明規則版本；v2 第四柱只接受 official actual-result 證據完整的 price-index-compatible reaction，不能用總分抵銷任何四柱 hard gate",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.company_codes &&
      new Set(value.company_codes).size !== value.company_codes.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["company_codes"],
        message: "company_codes 不得包含重複代號",
      });
    }
  });

const screenCriterionStatusSchema = z.enum(["pass", "fail", "unknown"]);

const screenPillarKeySchema = z.enum([
  "company_quality",
  "fundamental_improvement",
  "reasonable_valuation",
  "market_underreaction_proxy",
]);

const screenCandidateBucketSchema = z.enum([
  "research_candidate",
  "watchlist",
  "insufficient_data",
  "deprioritized",
]);

const screenCriterionSchema = z
  .object({
    code: z.string().describe("穩定且可供程式判斷的 criterion code"),
    label: z.string().describe("criterion 的繁體中文名稱"),
    status: screenCriterionStatusSchema.describe(
      "pass=規則通過、fail=規則有反證、unknown=證據缺失或不可比；unknown 不得當成 0",
    ),
    value: z
      .number()
      .nullable()
      .describe("用於判定的正規化數值；無可比或有效證據時為 null"),
    unit: z.string().describe("value 的單位或 ratio／percentage-point 等口徑"),
    periods: z
      .array(z.string())
      .describe("此 criterion 實際使用的月份、季度或交易日範圍"),
    rule: z.string().describe("可重算的門檻或判定公式"),
    weight: z.number().describe("此 criterion 在所屬 pillar 內的權重"),
    mandatory: z.boolean().describe("缺少此 criterion 是否會使 pillar 變成 unknown"),
    context: z
      .record(
        z.string(),
        z.union([z.number(), z.string(), z.boolean(), z.null()]),
      )
      .describe("判定所需的 peer、前期值、樣本數或其他有限結構化上下文"),
    reasonCodes: z
      .array(z.string())
      .describe("fail、unknown 或其他限制的穩定原因代號"),
  })
  .strict()
  .describe("單一篩選 criterion 的透明規則、證據、權重與判定");

export const screenPillarSchema = z
  .object({
    key: screenPillarKeySchema.describe("四柱的穩定機器鍵"),
    label: z.string().describe("四柱的人類可讀名稱"),
    status: screenCriterionStatusSchema.describe(
      "此柱的 hard-gate 結論；unknown 與 fail 都不能由其他柱總分補償",
    ),
    score: z
      .number()
      .nullable()
      .describe("只依已知 criteria 計算的 0–100 輔助排序分數；無已知權重時為 null"),
    knownWeight: z.number().describe("本柱具有可判讀證據的 criterion 權重合計"),
    totalWeight: z.literal(100).describe("本柱規則的固定總權重"),
    criteria: z.array(screenCriterionSchema).describe("此柱的透明逐條判定與證據"),
    hardFailReasons: z
      .array(z.string())
      .describe("使本柱直接 fail 的硬性反證原因代號"),
    evidenceGaps: z
      .array(z.string())
      .describe("使本柱不完整或 unknown 的證據缺口"),
  })
  .strict()
  .describe("單一四柱的 hard-gate 狀態、輔助分數與逐條 criterion 證據");

const screenCompactCompanySchema = z
  .object({
    companyCode: z.string().describe("公司股票代號"),
    companyName: z.string().describe("公司簡稱"),
    stage: z
      .enum([
        "universe_filter",
        "coarse_filter",
        "deep_scoring",
        "reaction_selection",
      ])
      .describe("此公司被排除或未繼續處理的漏斗階段"),
    reasonCodes: z
      .array(z.string())
      .describe(
        "被排除、未深篩或未 reaction 評估的穩定原因代號；company_metrics_unavailable 表示 deep batch item failure，不能當成投資條件 fail",
      ),
  })
  .strict();

const screenSourceSchema = z
  .object({
    kind: z
      .enum([
        "company_master",
        "monthly_revenue_latest",
        "monthly_revenue_history",
        "valuation_latest",
        "company_metrics",
        "reaction_benchmark",
        "reaction_stock",
        "reaction_corporate_action",
      ])
      .describe("來源在篩選 pipeline 中提供的資料角色"),
    sourceName: z.string().describe("官方資料來源名稱"),
    sourceUrl: z.string().url().describe("實際官方來源 URL"),
    retrievedAt: z.string().describe("本服務取得或使用來源的 ISO 8601 時間"),
    cache: sourceCacheObservationSchema.optional().describe("screen 保留的 caller-specific source cache provenance"),
    market: z
      .enum(["listed", "otc"])
      .nullable()
      .describe("來源所屬市場；跨市場 Mopsfin 指標來源為 null"),
    asOf: z.string().describe("此來源實際使用的日期、月份、季度或 mixed 標記"),
    asOfGranularity: z
      .enum(["date", "month", "quarter", "mixed"])
      .describe("asOf 的時間粒度"),
  })
  .strict();

const screenDependencyStatusSchema = z
  .object({
    stage: z.enum(["coarse", "deep", "reaction"]).describe("依賴所屬 pipeline 階段"),
    dependency: z
      .enum([
        "company_master",
        "latest_monthly_revenue",
        "latest_valuation",
        "monthly_revenue_trend",
        "company_metrics_batch",
        "stock_reaction_signals",
      ])
      .describe("實際呼叫或規劃的底層即時資料依賴"),
    status: z
      .enum(["complete", "partial", "failed", "not_run"])
      .describe("本次依賴的完成狀態；failed／not_run 不會被補成 0 分"),
    affectedCompanyCodes: z
      .array(z.string())
      .describe("受此依賴不完整或失敗影響的公司代號"),
    message: z
      .string()
      .nullable()
      .describe("依賴完整時為 null，否則說明可重試、覆蓋或資料限制"),
  })
  .strict();

export const screenTaiwanStockCandidatesOutputSchema = z
  .object({
    ...successResultShape,
    query: z
      .object({
        market: z.enum(["all", "listed", "otc"]).describe("實際掃描的目前市場母體"),
        companyCodes: z
          .array(z.string())
          .optional()
          .describe("正規化並排序後的自訂公司代號母體；省略代表掃描所選市場"),
        includeKy: z.boolean().describe("本次是否保留 KY 公司"),
        candidateLimit: z.number().int().describe("最多進入 reaction 並回傳的公司數"),
        preset: z
          .literal("balanced_non_financial_v2")
          .describe("本次使用的固定透明規則版本"),
      })
      .strict()
      .describe("正規化後實際執行的 latest-only 篩選條件"),
    generatedAt: z.string().describe("本服務完成組裝篩選結果的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("latest 與交易日期使用的時區"),
    screenDefinition: z
      .object({
        id: z.literal("taiwan_stock_screen.v2").describe("使用 corporate-action-aware reaction 的穩定篩選定義版本"),
        preset: z
          .literal("balanced_non_financial_v2")
          .describe("四柱規則 preset"),
        posture: z
          .literal("research_triage_not_recommendation")
          .describe("結果只供研究候選分流，不是投資建議"),
        latestOnly: z.literal(true).describe("此版本只允許各來源 latest 資料"),
        financialCompanies: z.literal("excluded").describe("金融保險業固定排除"),
        scoreCompensationAcrossPillars: z
          .literal(false)
          .describe("總分不得抵銷任何 pillar 的 fail 或 unknown"),
        pillarWeights: z
          .object({
            company_quality: z.literal(25).describe("好公司柱的總分權重"),
            fundamental_improvement: z.literal(25).describe("基本面改善柱的總分權重"),
            reasonable_valuation: z.literal(25).describe("估值合理柱的總分權重"),
            market_underreaction_proxy: z
              .literal(25)
              .describe("市場尚未充分反應 proxy 柱的總分權重"),
          })
          .strict()
          .describe("四柱各 25% 的排序權重；不改變 hard gates"),
        stages: z
          .array(
            z
              .object({
                stage: z.enum(["coarse", "deep", "reaction"]).describe("pipeline 階段"),
                maximumCompanies: z
                  .number()
                  .int()
                  .nullable()
                  .describe("該階段最多公司數；全母體 coarse 為 null"),
                description: z.string().describe("階段資料來源、範圍與限制"),
              })
              .strict(),
          )
          .describe("全母體粗篩、前 10 家深篩及最多 5 家 reaction 的固定流程"),
        coarseRanking: z
          .object({
            eligibilityRules: z
              .array(z.string())
              .describe("進入粗篩排序前必須具備的 latest 月營收與估值證據"),
            scoreComponents: z
              .array(
                z
                  .object({
                    code: z.string().describe("粗篩加分條件的穩定代號"),
                    points: z.number().describe("條件成立時加入 coarseScore 的固定分數"),
                    rule: z.string().describe("可重算的粗篩條件"),
                  })
                  .strict(),
              )
              .describe("合計最高 100 分的固定粗篩加分規則"),
            tieBreak: z
              .array(z.string())
              .describe("粗篩同分時依序套用的 deterministic 排序鍵"),
          })
          .strict()
          .describe("決定哪些公司進入 top-10 深篩的完整透明粗篩規則"),
        evidencePolicies: z
          .object({
            requiredFinancialMetricRoles: z
              .tuple([
                z.literal("roe"),
                z.literal("net_profit"),
                z.literal("operating_cashflow"),
                z.literal("debt_ratio"),
                z.literal("gross_margin"),
                z.literal("operating_margin"),
                z.literal("eps"),
              ])
              .describe("screening 內部固定依賴、與上游裸代號解耦的七項財務語意角色"),
            financialMetricCodes: z
              .array(z.string())
              .length(7)
              .describe("本次由即時 catalog semantic resolver 解析出的七項正式 Mopsfin metric codes；保留此欄位供相容讀取"),
            resolvedFinancialMetrics: z
              .array(
                z
                  .object({
                    role: z.enum([
                      "roe",
                      "net_profit",
                      "operating_cashflow",
                      "debt_ratio",
                      "gross_margin",
                      "operating_margin",
                      "eps",
                    ]).describe("screening 內部穩定財務語意角色"),
                    metricCode: z.string().describe("本次即時 catalog 的正式 metric code"),
                    metricName: z.string().describe("用於語意核對的 catalog 正式名稱"),
                    family: z.literal("data").describe("screening 財務指標只允許 family=data"),
                    unit: z.string().describe("catalog 宣告的來源單位"),
                    category: z.string().describe("catalog 宣告的指標分類"),
                    resolutionBasis: z
                      .enum(["exact_name", "known_code_alias"])
                      .describe("優先以正式名稱精確解析；已知代號 alias 只作 fallback"),
                  })
                  .strict(),
              )
              .length(7)
              .describe("本次七項 role 到正式 catalog metric 的逐項解析證據"),
            catalogDiscoveredAt: z
              .string()
              .datetime({ offset: true })
              .describe("本次使用的 Mopsfin catalog 在來源端解析完成時間"),
            catalogSnapshotId: z
              .string()
              .regex(/^mopsfin-catalog-[a-f0-9]{64}$/)
              .describe("由 catalog metric definitions 與期間內容計算的 deterministic SHA-256 identity"),
            financialAlignment: z
              .literal("exact_common_quarter_no_substitution")
              .describe("七項財務指標必須對齊同一季度，缺值不以鄰季代填"),
            valuationPeerMinimum: z
              .literal(20)
              .describe("每一估值欄位形成 percentile 所需的最少有效 peer 數"),
            valuationPeerFallback: z
              .literal("same_industry_then_same_market")
              .describe("同產業有效樣本不足 20 時退回同市場非金融母體"),
            reactionHorizons: z
              .array(z.union([z.literal(5), z.literal(20), z.literal(60)]))
              .describe("第四柱固定使用的 benchmark session horizons"),
            reactionPriceBasis: z
              .literal("price_index_compatible_corporate_action_adjusted_vs_price_index")
              .describe("第四柱只使用 official actual-result factor 移除股數變動機械斷點後的個股報酬與 price index；現金股利效果保留，非 total return"),
          })
          .strict()
          .superRefine((value, context) => {
            const roles = value.resolvedFinancialMetrics.map((item) => item.role);
            const codes = value.resolvedFinancialMetrics.map(
              (item) => item.metricCode,
            );
            if (
              roles.some(
                (role, index) =>
                  role !== value.requiredFinancialMetricRoles[index],
              )
            ) {
              context.addIssue({
                code: "custom",
                path: ["resolvedFinancialMetrics"],
                message: "resolvedFinancialMetrics 必須依 requiredFinancialMetricRoles 唯一且同序排列",
              });
            }
            if (
              new Set(codes).size !== codes.length ||
              codes.some(
                (code, index) => code !== value.financialMetricCodes[index],
              )
            ) {
              context.addIssue({
                code: "custom",
                path: ["financialMetricCodes"],
                message: "financialMetricCodes 必須與 resolvedFinancialMetrics 唯一且同序一致",
              });
            }
          })
          .describe("深度財務、估值同業與 reaction 的固定證據政策"),
        decisionPolicy: z
          .object({
            researchCandidate: z.string().describe("research_candidate 的四柱通過政策"),
            watchlist: z.string().describe("watchlist 的 gate 與反證政策"),
            insufficientData: z.string().describe("insufficient_data 的缺證政策"),
            deprioritized: z.string().describe("deprioritized 的硬性反證政策"),
          })
          .strict()
          .describe("四個研究分流 bucket 的 precedence 與 hard-gate 語意"),
        limitations: z
          .array(z.string())
          .describe("來源、時間點、金融業、raw price 與缺少市場預期資料等限制"),
      })
      .strict()
      .describe("可供重算與解釋的固定篩選方法"),
    asOf: z
      .object({
        selector: z.literal("latest").describe("所有 dependency 均要求 latest"),
        granularity: z.literal("mixed").describe("來源同時包含日期、月份與季度"),
        masterReportDates: z.array(z.string()).describe("目前公司母體各市場官方出表日期"),
        revenueMonth: z.string().describe("粗篩最新月營收資料年月"),
        valuationDate: z.string().describe("粗篩與估值柱使用的官方估值日"),
        financialThroughPeriods: z
          .array(z.string())
          .describe("深篩公司七項財務指標可共同對齊的最新季度集合"),
        reactionDates: z
          .array(
            z
              .object({
                market: z.enum(["listed", "otc"]).describe("reaction benchmark 市場"),
                date: z.string().describe("該市場 reaction exact-session 終點日期"),
              })
              .strict(),
          )
          .describe("各市場實際解析的 reaction 日期"),
      })
      .strict()
      .describe("不同來源的 mixed as-of，不代表單一 point-in-time snapshot"),
    coverage: z
      .object({
        selectionComplete: z.boolean().describe("requested 公司母體是否全部完成 identity 選取"),
        sourceComplete: z.boolean().describe("所有實際執行 dependency 是否均為 complete"),
        deepEvidenceComplete: z.boolean().describe("全部深篩公司前三柱是否都可判讀"),
        reactionEvidenceComplete: z.boolean().describe("reaction 入選公司是否全部形成可判讀第四柱"),
        missingCompanyCodes: z.array(z.string()).describe("requested 但未取得的公司代號"),
      })
      .strict()
      .describe("selection、來源、深篩與 reaction 證據完整性"),
    funnel: z
      .object({
        currentMaster: z.number().int().describe("所選市場目前公司母體公司數"),
        explicitlyRequested: z
          .number()
          .int()
          .nullable()
          .describe("自訂 company_codes 數量；全市場掃描為 null"),
        eligibleNonFinancial: z.number().int().describe("排除金融與查詢指定 KY 政策後的公司數"),
        excludedFinancial: z.number().int().describe("固定排除的金融保險業公司數"),
        excludedKy: z.number().int().describe("依 include_ky=false 排除的 KY 公司數"),
        missingRequestedCodes: z.array(z.string()).describe("requested 但不在目前母體的公司代號"),
        withLatestRevenue: z.number().int().describe("有 latest 月營收列的 eligible 公司數"),
        withLatestValuation: z.number().int().describe("有 latest 估值列的 eligible 公司數"),
        coarseEligible: z.number().int().describe("通過粗篩必要資料 gate 的公司數"),
        deepSelected: z.number().int().describe("依粗篩排序進入深篩的公司數，上限 10"),
        deepScored: z.number().int().describe("已取得營收趨勢且七項財務可對齊共同季度的公司數"),
        reactionSelected: z.number().int().describe("依前三柱與 candidate_limit 進入 reaction 的公司數"),
        reactionScored: z.number().int().describe("實際形成完整四柱 candidate 列的公司數"),
        returned: z.number().int().describe("本次 candidates 回傳公司數"),
        buckets: z
          .object({
            research_candidate: z.number().int().describe("四柱全部 pass 的研究候選數"),
            watchlist: z.number().int().describe("品質與改善通過但估值或反應尚待 trigger 的數量"),
            insufficient_data: z.number().int().describe("至少一柱證據不足的數量"),
            deprioritized: z.number().int().describe("存在硬性反證或完整證據不符規則的數量"),
          })
          .strict()
          .describe("實際回傳 candidates 的研究分流數量"),
      })
      .strict()
      .describe("從目前母體到粗篩、深篩、reaction 與結果 bucket 的完整漏斗計數"),
    workBudget: z
      .object({
        coarseCompanies: z.number().int().describe("本次粗篩處理的 eligible 公司數"),
        deepCompanyLimit: z.literal(10).describe("固定深篩公司數上限"),
        deepCompaniesRequested: z.number().int().describe("本次要求深篩的公司數"),
        financialMetricCount: z.literal(7).describe("每家深篩要求的固定季度財務指標數"),
        financialMetricComparisonUnits: z.number().int().describe("每十家公司乘每個指標計算的 Mopsfin comparison units"),
        revenueTrendMonths: z.literal(6).describe("深篩月營收趨勢固定月份數"),
        reactionCompanyLimit: z.literal(5).describe("固定 reaction 公司數上限"),
        reactionCompaniesRequested: z.number().int().describe("本次要求 reaction 的公司數"),
        reactionOfficialMonthUnits: z.number().int().describe("本次 reaction 實際消耗的官方市場月份 units"),
        reactionOfficialMonthUnitLimit: z.literal(48).describe("reaction dependency 的官方月份 unit 上限"),
        reactionCorporateActionRequests: z.number().int().nonnegative().describe("本次 reaction 另行載入的 official actual-result 公司行動區間／詳情 requests"),
      })
      .strict()
      .describe("52 秒 request deadline 下的 bounded coarse／deep／reaction 工作量"),
    candidates: z
      .array(
        z
          .object({
            rank: z.number().int().describe("本次已完成四柱候選中的一日起算排序"),
            companyCode: z.string().describe("公司股票代號"),
            companyName: z.string().describe("公司正式名稱"),
            shortName: z.string().describe("公司簡稱"),
            market: z.enum(["listed", "otc"]).describe("目前上市或上櫃市場"),
            industryCode: z.string().describe("目前 company master 產業代號"),
            listingDate: z.string().describe("目前 company master 上市櫃日期"),
            isKy: z.boolean().describe("目前公司是否為 KY 公司"),
            bucket: screenCandidateBucketSchema.describe("四柱 hard-gate 後的研究分流"),
            overallScore: z
              .number()
              .nullable()
              .describe("四柱皆有 score 時的等權重排序分數；不能抵銷 fail／unknown"),
            evidenceCompletenessPercent: z.number().describe("四柱已知 criterion 權重占全部權重的百分比"),
            broadEvidence: z
              .object({
                revenueMonth: z.string().describe("粗篩月營收月份"),
                latestRevenueYoyPercent: z.number().nullable().describe("最新官方月營收 YoY 百分比"),
                cumulativeRevenueYoyPercent: z.number().nullable().describe("最新官方累計營收 YoY 百分比"),
                valuationDate: z.string().describe("粗篩估值資料日"),
                peRatio: z.number().nullable().describe("官方 trailing 本益比"),
                priceToBookRatio: z.number().nullable().describe("官方股價淨值比"),
                dividendYieldPercent: z.number().nullable().describe("官方殖利率百分比"),
                closePriceTwd: z.number().nullable().describe("估值來源可提供的收盤價 TWD"),
                coarseScore: z.number().describe("最新營收成長與估值形成的 deterministic 粗篩分數"),
              })
              .strict()
              .describe("用於全母體低成本排序的最新營收與估值證據"),
            pillars: z
              .object({
                companyQuality: screenPillarSchema.describe("好公司柱"),
                fundamentalImprovement: screenPillarSchema.describe("基本面改善柱"),
                reasonableValuation: screenPillarSchema.describe("估值合理柱"),
                marketUnderreactionProxy: screenPillarSchema.describe("市場尚未充分反應的 corporate-action-aware、price-index-compatible proxy 柱；actual-result 證據不足時為 unknown"),
              })
              .strict()
              .describe("好公司、基本面改善、估值合理與市場反應 proxy 四柱"),
            firstRejectionReasons: z.array(z.string()).describe("最先阻止 research_candidate 的 hard gate 或證據原因"),
            evidenceGaps: z.array(z.string()).describe("需透過後續研究補齊的資料缺口"),
            nextDiligence: z.array(z.string()).describe("針對本公司建議的下一步人工研究，不是買賣行動"),
            asOf: z
              .object({
                masterReportDate: z.string().describe("此公司目前 master 的官方出表日期"),
                revenueThroughMonth: z.string().describe("此公司月營收證據終點月份"),
                valuationDate: z.string().describe("此公司估值證據日期"),
                financialThroughPeriod: z.string().nullable().describe("七項財務指標共同對齊季度"),
                reactionDate: z.string().nullable().describe("reaction exact-session 終點；未完成時為 null"),
              })
              .strict()
              .describe("此候選各類證據的 mixed as-of"),
          })
          .strict(),
      )
      .describe("最多 candidate_limit 家已完成 reaction 並組成四柱的研究候選列"),
    summaryLimits: z
      .object({
        maximumPerList: z.literal(25).describe("三個摘要清單各自的固定回傳筆數上限"),
        notDeepScoredTotal: z.number().int().describe("粗篩合格但受 top-10 限制未深篩的完整數量"),
        notReactionScoredTotal: z.number().int().describe("已深篩但未形成 reaction 第四柱的完整數量"),
        excludedTotal: z.number().int().describe("母體與粗篩排除公司的完整數量"),
      })
      .strict()
      .describe("bounded 摘要清單的上限與未截斷總數"),
    notDeepScored: z.array(screenCompactCompanySchema).describe("粗篩合格但未進入 top-10 深篩的公司摘要"),
    notReactionScored: z
      .array(screenCompactCompanySchema)
      .describe("已進 deepSelected 但因 evidence unavailable、前三柱 unknown、reaction dependency 或 bounded limit 而未形成第四柱的公司摘要"),
    excluded: z.array(screenCompactCompanySchema).describe("因金融、KY policy 或粗篩必要資料而排除的公司摘要"),
    dependencyStatus: z.array(screenDependencyStatusSchema).describe("各 pipeline 即時 dependency 的完成與影響範圍"),
    sources: z.array(screenSourceSchema).describe("本次實際使用且去重後的官方來源與各自 as-of"),
    ...warningShape,
  })
  .strict();

export const screenTaiwanStockCandidatesDataSchema =
  screenTaiwanStockCandidatesOutputSchema.omit({ ok: true, meta: true });
