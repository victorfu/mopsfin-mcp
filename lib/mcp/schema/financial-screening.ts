import { z } from "zod";

import { FINANCIAL_SCREEN_METRIC_ROLES } from "@/lib/financial-screening/metric-roles";
import type {
  TaiwanFinancialScreenQuery,
  TaiwanFinancialScreenResult,
} from "@/lib/financial-screening/types";

import { successResultShape } from "./common";
import { screenPillarSchema } from "./screening";

const financialScreenMarketSchema = z
  .enum(["all", "listed", "otc"])
  .describe("金融股篩選的目前上市櫃市場範圍");

const companyMarketSchema = z
  .enum(["listed", "otc"])
  .describe("公司的目前上市或上櫃市場");

const supportedFinancialSectorSchema = z
  .enum(["holding", "bank", "bills"])
  .describe("金融模型目前支援的金控、銀行或票券子業別");

const financialMetricRoleSchema = z
  .enum(FINANCIAL_SCREEN_METRIC_ROLES)
  .describe("金融篩選器使用、與即時 catalog 裸代號解耦的穩定指標語意角色");

const financialMappingStatusSchema = z
  .enum([
    "mapped",
    "institution_not_found",
    "duplicate_institution_code",
    "unsupported_institution_sector",
    "identity_mismatch",
  ])
  .describe("股票公司與 Mopsfin 金融機構 exact-code mapping 的結果");

const candidateBucketSchema = z
  .enum([
    "research_candidate",
    "watchlist",
    "insufficient_data",
    "deprioritized",
  ])
  .describe("四柱 hard-gate 完成後的研究分流 bucket");

const normalizedFinancialScreenQuerySchema = z
  .object({
    market: financialScreenMarketSchema.describe("本次實際掃描的目前市場母體"),
    companyCodes: z
      .array(
        z
          .string()
          .regex(/^\d{4}$/)
          .describe("正規化後的單一四碼公司股票代號"),
      )
      .optional()
      .describe("排序後的自訂金融股母體；省略代表掃描所選市場"),
    includeKy: z.boolean().describe("本次是否保留 KY 金融公司"),
    candidateLimit: z
      .number()
      .int()
      .describe("最多進入 reaction 並回傳完整四柱結果的公司數"),
    preset: z
      .literal("balanced_financial_v1")
      .describe("本次使用的金融業固定透明規則版本"),
  })
  .strict()
  .describe("正規化後實際執行的 latest-only 金融股篩選條件") satisfies z.ZodType<TaiwanFinancialScreenQuery>;

export const screenTaiwanFinancialCandidatesInputSchema = z
  .object({
    market: financialScreenMarketSchema
      .default("all")
      .describe("all=上市與上櫃、listed=只取 TWSE、otc=只取 TPEx"),
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
        "可選且不得重複的 1 至 100 家自訂母體；非金融、無法安全 mapping 或不支援子業別仍會明示對帳",
      ),
    include_ky: z
      .boolean()
      .default(true)
      .describe("是否保留目前 company master 標示的 KY 金融公司"),
    candidate_limit: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(5)
      .describe(
        "最多進入 reaction 階段並回傳完整四柱結果的公司數，預設及上限 5；深篩仍固定最多 10 家",
      ),
    preset: z
      .literal("balanced_financial_v1")
      .default("balanced_financial_v1")
      .describe("固定的金融業透明規則版本；raw score 只允許金融模型內比較"),
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
  })
  .describe("screen_taiwan_financial_candidates 的 strict bounded 輸入");

const resolvedFinancialMetricSchema = z
  .object({
    role: financialMetricRoleSchema.describe("此 catalog metric 對應的穩定金融語意角色"),
    metricCode: z.string().describe("本次即時 catalog 的正式 metric code"),
    metricName: z.string().describe("用於 exact semantic resolution 的 catalog 正式名稱"),
    family: z
      .enum(["data", "fin", "adequacy"])
      .describe("此指標的 Mopsfin endpoint family"),
    unit: z.string().describe("catalog 宣告且通過語意驗證的來源單位"),
    category: z.string().describe("catalog 宣告的指標分類"),
    applicableSectors: z
      .array(
        supportedFinancialSectorSchema.describe("此 metric role 可合法套用的單一金融子業別"),
      )
      .describe("此 metric role 的金融子業別 applicability allowlist"),
    resolutionBasis: z
      .enum(["exact_name", "known_code_alias"])
      .describe("以正式名稱精確解析，或以已知代號 alias 作封閉 fallback"),
  })
  .strict()
  .describe("單一金融語意角色到即時 catalog metric 的解析證據");

const financialMetricResolutionSchema = z
  .object({
    requiredMetricRoles: z
      .array(
        financialMetricRoleSchema.describe("本次金融模型要求解析的單一語意角色"),
      )
      .describe("金融模型要求且必須 fail-closed 解析的全部語意角色"),
    resolvedMetrics: z
      .array(
        resolvedFinancialMetricSchema.describe("單一已成功解析的金融 metric role"),
      )
      .describe("本次 role 到正式 catalog metric 的逐項解析證據"),
    catalogDiscoveredAt: z
      .string()
      .datetime({ offset: true })
      .describe("本次使用的 Mopsfin catalog 解析完成時間"),
    catalogSnapshotId: z
      .string()
      .regex(/^mopsfin-financial-catalog-[a-f0-9]{64}$/)
      .describe("由金融 metric、institution 與期間 catalog 計算的 deterministic SHA-256 identity"),
  })
  .strict()
  .describe("balanced_financial_v1 對即時 Mopsfin catalog 的 fail-closed 語意解析結果");

const financialCompactCompanySchema = z
  .object({
    companyCode: z.string().describe("公司股票代號"),
    companyName: z.string().describe("公司名稱"),
    stage: z
      .enum([
        "universe_filter",
        "mapping",
        "coarse_filter",
        "deep_scoring",
        "reaction_selection",
      ])
      .describe("此公司被排除或未繼續處理的漏斗階段"),
    mappingStatus: financialMappingStatusSchema
      .nullable()
      .describe("金融機構 mapping 結果；尚未進入 mapping 時為 null"),
    financialSubtype: supportedFinancialSectorSchema
      .nullable()
      .describe("安全解析的金融子業別；未支援或無法安全 mapping 時為 null"),
    reasonCodes: z
      .array(z.string().describe("單一穩定排除、mapping 或 bounded-stage 原因代號"))
      .describe("此公司未繼續處理的完整穩定原因代號"),
  })
  .strict()
  .describe("bounded 摘要清單中的單一金融公司漏斗狀態");

const financialCandidateSchema = z
  .object({
    rank: z.number().int().describe("本次已完成四柱候選中的一日起算排序"),
    companyCode: z.string().describe("公司股票代號"),
    companyName: z.string().describe("公司正式名稱"),
    shortName: z.string().describe("公司簡稱"),
    market: companyMarketSchema.describe("目前上市或上櫃市場"),
    listingDate: z.string().describe("目前 company master 上市櫃日期"),
    isKy: z.boolean().describe("目前公司是否為 KY 公司"),
    financialSubtype: supportedFinancialSectorSchema.describe("此候選使用的金融子業別模型"),
    institutionCode: z.string().describe("exact-code mapping 後的 Mopsfin 金融機構代號"),
    institutionName: z.string().describe("通過 identity audit 的 Mopsfin 金融機構名稱"),
    modelId: z
      .literal("taiwan_financial_screen.v1")
      .describe("此候選的固定金融模型識別碼"),
    preset: z
      .literal("balanced_financial_v1")
      .describe("此候選使用的固定金融規則 preset"),
    scoreComparisonScope: z
      .literal("within_financial_model_only")
      .describe("raw overallScore 只允許在同一金融模型內比較"),
    bucket: candidateBucketSchema.describe("四柱 hard-gate 後的研究分流"),
    overallScore: z
      .number()
      .nullable()
      .describe("四柱皆有 score 時的等權重輔助排序分數；不能跨模型比較或抵銷 hard gate"),
    evidenceCompletenessPercent: z
      .number()
      .describe("四柱已知 criterion 權重占全部權重的百分比"),
    broadEvidence: z
      .object({
        revenueMonth: z.string().describe("粗篩月營收月份"),
        latestRevenueYoyPercent: z
          .number()
          .nullable()
          .describe("最新官方月營收 YoY 百分比"),
        cumulativeRevenueYoyPercent: z
          .number()
          .nullable()
          .describe("最新官方累計營收 YoY 百分比"),
        valuationDate: z.string().describe("粗篩估值資料日"),
        peRatio: z.number().nullable().describe("官方 trailing 本益比"),
        priceToBookRatio: z.number().nullable().describe("官方股價淨值比"),
        dividendYieldPercent: z.number().nullable().describe("官方殖利率百分比"),
        closePriceTwd: z
          .number()
          .nullable()
          .describe("估值來源可提供的收盤價 TWD"),
        coarseScore: z
          .number()
          .describe("最新營收成長與估值形成的 deterministic 粗篩分數"),
      })
      .strict()
      .describe("用於全金融母體低成本排序的最新營收與估值證據"),
    pillars: z
      .object({
        companyQuality: screenPillarSchema.describe("金融業經營品質與財務韌性柱"),
        fundamentalImprovement: screenPillarSchema.describe("金融業基本面改善柱"),
        reasonableValuation: screenPillarSchema.describe("同金融子業別估值合理柱"),
        marketUnderreactionProxy: screenPillarSchema.describe("市場尚未充分反應 proxy 柱"),
      })
      .strict()
      .describe("金融業專用前三柱與共用 reaction 第四柱"),
    firstRejectionReasons: z
      .array(z.string().describe("單一最早 hard-gate 或證據拒絕原因"))
      .describe("最先阻止 research_candidate 的 hard gate 或證據原因"),
    evidenceGaps: z
      .array(z.string().describe("單一需補齊的金融研究證據缺口"))
      .describe("需透過後續研究補齊的資料缺口"),
    nextDiligence: z
      .array(z.string().describe("單一建議人工研究步驟"))
      .describe("針對本公司的下一步人工研究，不是買賣行動"),
    asOf: z
      .object({
        masterReportDate: z.string().describe("此公司目前 master 的官方出表日期"),
        revenueThroughMonth: z.string().describe("此公司月營收證據終點月份"),
        valuationDate: z.string().describe("此公司估值證據日期"),
        profitabilityThroughPeriod: z
          .string()
          .nullable()
          .describe("ROE、稅後純益與 EPS 對齊的最近財報期；未完成時為 null"),
        capitalThroughPeriod: z
          .string()
          .nullable()
          .describe("子業別資本適足證據終點期；未完成或不適用時為 null"),
        assetQualityThroughPeriod: z
          .string()
          .nullable()
          .describe("銀行資產品質證據終點期；未完成或不適用時為 null"),
        reactionDate: z
          .string()
          .nullable()
          .describe("reaction exact-session 終點；未完成時為 null"),
      })
      .strict()
      .describe("此候選各證據角色彼此分離的 mixed as-of"),
  })
  .strict()
  .describe("一家具安全金融 mapping、子業別模型與完整四柱的候選公司");

const financialDependencyStatusSchema = z
  .object({
    stage: z.enum(["coarse", "deep", "reaction"]).describe("依賴所屬 pipeline 階段"),
    dependency: z
      .enum([
        "company_master",
        "catalog_mapping",
        "latest_monthly_revenue",
        "latest_valuation",
        "monthly_revenue_trend",
        "profitability_metrics_batch",
        "financial_institution_metrics_batch",
        "stock_reaction_signals",
      ])
      .describe("實際呼叫或規劃的底層即時資料依賴"),
    status: z
      .enum(["complete", "partial", "failed", "not_run"])
      .describe("本次依賴完成狀態；failed 或 not_run 不得補成 0 分"),
    affectedCompanyCodes: z
      .array(z.string().describe("受此依賴不完整或失敗影響的單一公司代號"))
      .describe("受此依賴不完整或失敗影響的公司代號"),
    message: z
      .string()
      .nullable()
      .describe("依賴完整時為 null，否則說明可重試、覆蓋或資料限制"),
  })
  .strict()
  .describe("單一金融篩選 pipeline dependency 的完成與影響範圍");

const financialScreenSourceSchema = z
  .object({
    kind: z
      .enum([
        "company_master",
        "catalog",
        "monthly_revenue_latest",
        "monthly_revenue_history",
        "valuation_latest",
        "profitability_metrics",
        "financial_institution_metrics",
        "reaction_benchmark",
        "reaction_stock",
        "reaction_corporate_action",
      ])
      .describe("來源在金融篩選 pipeline 中提供的資料角色"),
    sourceName: z.string().describe("官方資料來源名稱"),
    sourceUrl: z.string().url().describe("實際官方來源 URL"),
    retrievedAt: z.string().describe("本服務取得或使用來源的 ISO 8601 時間"),
    cache: z
      .object({
        status: z
          .enum(["hit", "miss", "shared", "bypass", "not_applicable", "unknown"])
          .describe("此 caller 觀察到的 in-process cache 狀態"),
        observedAt: z
          .string()
          .describe("此 caller 觀察 cache 狀態的 ISO 8601 時間"),
        storedAt: z
          .string()
          .nullable()
          .describe("目前 cached upstream value 首次儲存時間；未儲存時為 null"),
        ageMs: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe("caller 觀察時的 cache age；不適用或未知時為 null"),
        ttlMs: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe("該來源 cache TTL；不適用或未知時為 null"),
      })
      .strict()
      .optional()
      .describe("screen 保留的 caller-specific source cache provenance"),
    market: companyMarketSchema
      .nullable()
      .describe("來源所屬市場；跨市場 catalog 或 Mopsfin 指標來源為 null"),
    asOf: z.string().describe("此來源實際使用的日期、月份、季度或 mixed 標記"),
    asOfGranularity: z
      .enum(["date", "month", "quarter", "mixed"])
      .describe("asOf 的時間粒度"),
  })
  .strict()
  .describe("本次金融篩選實際使用的一份官方來源及其 as-of");

const financialInstitutionMappingSchema = z
  .object({
    companyCode: z.string().describe("目前金融公司股票代號"),
    companyName: z.string().describe("目前 company master 公司正式名稱"),
    companyShortName: z.string().describe("目前 company master 公司簡稱"),
    market: companyMarketSchema.describe("目前公司上市或上櫃市場"),
    status: financialMappingStatusSchema.describe("此公司的 exact-code mapping 結果"),
    institutionCode: z
      .string()
      .nullable()
      .describe("唯一 exact-code 候選的 Mopsfin 金融機構代號；找不到時為 null"),
    institutionName: z
      .string()
      .nullable()
      .describe("唯一 exact-code 候選的 Mopsfin 金融機構名稱；不存在或不唯一時為 null"),
    sector: supportedFinancialSectorSchema
      .nullable()
      .describe("唯一候選的受支援子業別；未支援或無法解析時為 null"),
    matchBasis: z
      .literal("exact_company_code")
      .nullable()
      .describe("只允許 exact company code mapping；沒有候選時為 null"),
    identityMatch: z
      .enum(["company_name", "company_short_name", "mismatch"])
      .nullable()
      .describe("institution name 與 company master 正式名稱或簡稱的獨立 identity audit"),
    reasonCodes: z
      .array(z.string().describe("單一 mapping 結果或不安全原因的穩定代號"))
      .describe("此公司 mapping 結果的穩定原因代號"),
    catalogCandidates: z
      .array(
        z
          .object({
            code: z.string().describe("catalog 候選金融機構代號"),
            name: z.string().describe("catalog 候選金融機構名稱"),
            sector: z
              .enum(["holding", "bank", "bills", "unknown"])
              .describe("catalog 候選宣告的金融子業別"),
          })
          .strict()
          .describe("一個與股票代號完全相同的 catalog 候選"),
      )
      .describe("所有 exact-code catalog 候選；不得以名稱模糊補配"),
  })
  .strict()
  .describe("一家公司到 Mopsfin 金融機構 catalog 的可稽核 mapping 結果");

const financialMappingCoverageSchema = z
  .object({
    scope: z
      .literal("current_listed_otc_financial_companies")
      .describe("coverage report 固定盤點目前上市櫃金融公司"),
    catalogDiscoveredAt: z
      .string()
      .describe("此 mapping report 使用的 Mopsfin catalog 解析時間"),
    coverageComplete: z
      .boolean()
      .describe("所有 scope 公司是否都安全 mapping 到受支援金融子業別"),
    counts: z
      .object({
        financialCompanies: z.number().int().describe("scope 內目前金融公司總數"),
        mapped: z.number().int().describe("安全 exact-code mapping 的公司數"),
        institutionNotFound: z.number().int().describe("catalog 找不到 exact-code 機構的公司數"),
        duplicateInstitutionCode: z.number().int().describe("catalog 同代號不唯一的公司數"),
        unsupportedInstitutionSector: z.number().int().describe("catalog 子業別不受模型支援的公司數"),
        identityMismatch: z.number().int().describe("機構名稱與公司 identity 不一致的公司數"),
        bySupportedSector: z
          .object({
            holding: z.number().int().describe("安全 mapping 的金控公司數"),
            bank: z.number().int().describe("安全 mapping 的銀行公司數"),
            bills: z.number().int().describe("安全 mapping 的票券公司數"),
          })
          .strict()
          .describe("安全 mapping 公司按受支援金融子業別的數量"),
      })
      .strict()
      .describe("mapping status 與受支援子業別的完整對帳數量"),
    mappings: z
      .array(
        financialInstitutionMappingSchema.describe("scope 內單一金融公司的 mapping audit"),
      )
      .describe("scope 內每家公司逐筆且不可消失的 mapping 結果"),
    warnings: z
      .array(z.string().describe("單一 mapping coverage 限制或不完整警示"))
      .describe("mapping coverage 不完整時不可忽略的警示"),
  })
  .strict()
  .describe("目前上市櫃金融公司與 Mopsfin institution catalog 的完整 coverage report");

export const screenTaiwanFinancialCandidatesDataSchema = z
  .object({
    query: normalizedFinancialScreenQuerySchema.describe("正規化後實際執行的金融股 query"),
    generatedAt: z.string().describe("本服務完成組裝金融篩選結果的 ISO 8601 時間"),
    timezone: z.literal("Asia/Taipei").describe("latest 與交易日期使用的時區"),
    screenDefinition: z
      .object({
        id: z
          .literal("taiwan_financial_screen.v1")
          .describe("金融篩選模型的穩定定義版本"),
        preset: z
          .literal("balanced_financial_v1")
          .describe("金融四柱固定透明規則 preset"),
        posture: z
          .literal("research_triage_not_recommendation")
          .describe("結果只供研究候選分流，不是投資建議"),
        latestOnly: z.literal(true).describe("此版本只允許各來源 latest 資料"),
        supportedSectors: z
          .array(
            supportedFinancialSectorSchema.describe("模型明示支援的單一金融子業別"),
          )
          .describe("balanced_financial_v1 明示支援的金融子業別"),
        scoreCompensationAcrossPillars: z
          .literal(false)
          .describe("總分不得抵銷任何 pillar 的 fail 或 unknown"),
        crossModelScoreComparable: z
          .literal(false)
          .describe("金融 raw score 不得與非金融或其他模型 raw score 直接比較"),
        pillarWeights: z
          .object({
            company_quality: z.literal(25).describe("金融經營品質柱的總分權重"),
            fundamental_improvement: z.literal(25).describe("金融基本面改善柱的總分權重"),
            reasonable_valuation: z.literal(25).describe("同子業別估值合理柱的總分權重"),
            market_underreaction_proxy: z.literal(25).describe("市場尚未充分反應 proxy 柱的總分權重"),
          })
          .strict()
          .describe("金融四柱各 25% 的輔助排序權重；不改變 hard gates"),
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
                description: z.string().describe("此階段資料來源、範圍與限制"),
              })
              .strict()
              .describe("金融篩選 pipeline 的一個 bounded 階段"),
          )
          .describe("全母體粗篩、前 10 家深篩及最多 5 家 reaction 的固定流程"),
        coarseRanking: z
          .object({
            eligibilityRules: z
              .array(z.string().describe("單一粗篩 eligibility hard rule"))
              .describe("進入粗篩排序前必須具備的 latest 月營收與估值證據"),
            scoreComponents: z
              .array(
                z
                  .object({
                    code: z.string().describe("粗篩加分條件的穩定代號"),
                    points: z.number().describe("條件成立時加入 coarseScore 的固定分數"),
                    rule: z.string().describe("可重算的粗篩條件"),
                  })
                  .strict()
                  .describe("一項固定金融粗篩 score component"),
              )
              .describe("金融母體 deterministic 粗篩加分規則"),
            tieBreak: z
              .array(z.string().describe("一個依序套用的 deterministic 同分排序鍵"))
              .describe("粗篩同分時依序套用的 deterministic 排序鍵"),
          })
          .strict()
          .describe("決定哪些金融公司進入 top-10 深篩的透明粗篩規則"),
        evidencePolicies: z
          .object({
            profitabilityRoles: z
              .array(
                financialMetricRoleSchema.describe("一項金融獲利能力語意角色"),
              )
              .describe("所有受支援金融子業別共同使用的獲利能力 roles"),
            coreInstitutionMetricRoles: z
              .object({
                holding: z
                  .array(financialMetricRoleSchema.describe("金控核心 institution metric role"))
                  .describe("金控子業別必要的 institution metric roles"),
                bank: z
                  .array(financialMetricRoleSchema.describe("銀行核心 institution metric role"))
                  .describe("銀行子業別必要的 institution metric roles"),
                bills: z
                  .array(financialMetricRoleSchema.describe("票券核心 institution metric role"))
                  .describe("票券子業別必要的 institution metric roles"),
              })
              .strict()
              .describe("每個受支援金融子業別的核心資本或資產品質語意角色"),
            financialAlignment: z
              .string()
              .describe("獲利、資本與資產品質證據各自的期間對齊規則"),
            valuationPeerScope: z
              .literal("same_financial_subtype_no_fallback")
              .describe("估值 percentile 只允許同金融子業別 peer，樣本不足不得跨類 fallback"),
            valuationPeerMinimum: z
              .literal(3)
              .describe("形成同金融子業別估值 percentile 的最少有效 peer 數"),
            reactionPriceBasis: z
              .string()
              .describe("第四柱個股與指數報酬的 corporate-action 與 price-basis 規則"),
            metricResolution: financialMetricResolutionSchema.describe("本次即時 catalog 語意解析證據"),
          })
          .strict()
          .describe("金融指標 applicability、期間、peer 與 reaction price-basis 政策"),
        decisionPolicy: z
          .object({
            researchCandidate: z.string().describe("research_candidate bucket 的完整規則"),
            watchlist: z.string().describe("watchlist bucket 的完整規則"),
            insufficientData: z.string().describe("insufficient_data bucket 的完整規則"),
            deprioritized: z.string().describe("deprioritized bucket 的完整規則"),
          })
          .strict()
          .describe("四柱 hard-gate 到研究 bucket 的固定決策規則"),
        limitations: z
          .array(z.string().describe("單一模型覆蓋、可比性或資料限制"))
          .describe("回答與研究時不可忽略的 balanced_financial_v1 限制"),
      })
      .strict()
      .describe("balanced_financial_v1 的完整透明定義與證據政策"),
    asOf: z
      .object({
        selector: z.literal("latest").describe("此版本固定使用 latest selector"),
        granularity: z.literal("mixed").describe("多種來源日期與申報頻率形成 mixed as-of"),
        masterReportDates: z
          .array(z.string().describe("單一公司 master 官方出表日期"))
          .describe("本次使用的上市與上櫃 company master 出表日期"),
        revenueMonth: z.string().describe("本次 latest 月營收月份"),
        valuationDate: z.string().describe("本次 latest 官方估值資料日"),
        profitabilityThroughPeriods: z
          .array(z.string().describe("單一已使用的獲利能力證據終點期"))
          .describe("候選實際使用的獲利能力終點期集合"),
        capitalThroughPeriods: z
          .array(z.string().describe("單一已使用的資本適足證據終點期"))
          .describe("候選實際使用的資本適足終點期集合"),
        assetQualityThroughPeriods: z
          .array(z.string().describe("單一已使用的資產品質證據終點期"))
          .describe("銀行候選實際使用的資產品質終點期集合"),
        reactionDates: z
          .array(
            z
              .object({
                market: companyMarketSchema.describe("reaction exact-session 所屬市場"),
                date: z.string().describe("此市場的 reaction exact-session 日期"),
              })
              .strict()
              .describe("單一市場的 reaction exact-session 終點"),
          )
          .describe("已完成 reaction 的逐市場 exact-session 終點"),
      })
      .strict()
      .describe("不同官方資料角色彼此分離的 mixed as-of"),
    coverage: z
      .object({
        selectionComplete: z.boolean().describe("自訂公司選擇是否完整對帳"),
        sourceComplete: z.boolean().describe("本次已規劃來源是否都完成"),
        mappingComplete: z.boolean().describe("所選金融公司是否都安全 mapping"),
        deepEvidenceComplete: z.boolean().describe("deep-selected 公司是否都有完整金融深篩證據"),
        reactionEvidenceComplete: z.boolean().describe("reaction-selected 公司是否都有完整第四柱證據"),
        missingCompanyCodes: z
          .array(z.string().describe("一個不在目前所選 market master 的 requested company code"))
          .describe("自訂母體中無法在目前 company master 找到的公司代號"),
      })
      .strict()
      .describe("選擇、來源、mapping、深篩與 reaction 的分離完整性狀態"),
    funnel: z
      .object({
        currentMaster: z.number().int().describe("目前所選市場 company master 公司數"),
        explicitlyRequested: z.number().int().nullable().describe("caller 自訂母體數；未指定時為 null"),
        selectedFinancial: z.number().int().describe("market、requested 與 KY policy 後的金融公司數"),
        mappedSupported: z.number().int().describe("安全 mapping 至受支援子業別的金融公司數"),
        excludedNonFinancial: z.number().int().describe("自訂母體中明示排除的非金融公司數"),
        excludedKy: z.number().int().describe("依 includeKy policy 排除的金融 KY 公司數"),
        institutionNotFound: z.number().int().describe("catalog 無 exact-code institution 的公司數"),
        mappingUnsafe: z.number().int().describe("duplicate、unsupported 或 identity mismatch 的公司數"),
        coarseEligible: z.number().int().describe("具備粗篩必要 latest 證據的公司數"),
        deepSelected: z.number().int().describe("粗篩排序後進入 bounded deep stage 的公司數"),
        deepScored: z.number().int().describe("完成金融前三柱的公司數"),
        reactionSelected: z.number().int().describe("進入 bounded reaction stage 的公司數"),
        reactionScored: z.number().int().describe("完成 corporate-action-aware 第四柱的公司數"),
        returned: z.number().int().describe("本次回傳完整候選列數"),
        buckets: z
          .object({
            research_candidate: z.number().int().describe("research_candidate 候選數"),
            watchlist: z.number().int().describe("watchlist 候選數"),
            insufficient_data: z.number().int().describe("insufficient_data 候選數"),
            deprioritized: z.number().int().describe("deprioritized 候選數"),
          })
          .strict()
          .describe("returned 候選按四柱決策 bucket 的完整對帳"),
      })
      .strict()
      .describe("從目前 company master 到 returned candidates 的完整金融篩選漏斗"),
    workBudget: z
      .object({
        coarseCompanies: z.number().int().describe("實際進行低成本粗篩的金融公司數"),
        deepCompanyLimit: z.literal(10).describe("固定金融深篩公司數上限"),
        deepCompaniesRequested: z.number().int().describe("實際要求 deep dependencies 處理的公司數"),
        profitabilityMetricCount: z.literal(3).describe("每家固定要求的 ROE、稅後純益與 EPS role 數"),
        profitabilityComparisonUnits: z.number().int().describe("獲利能力 batch 的 company comparison units"),
        institutionComparisonUnits: z.number().int().describe("金融機構 batch 的 role × sector comparison units"),
        institutionIsolationUnits: z.number().int().describe("金融機構 batch item failure isolation units"),
        revenueTrendMonths: z.literal(6).describe("deep stage 固定要求的月營收趨勢月數"),
        reactionCompanyLimit: z.literal(5).describe("固定 reaction 公司數上限"),
        reactionCompaniesRequested: z.number().int().describe("實際要求 reaction dependency 處理的公司數"),
        reactionOfficialMonthUnits: z.number().int().describe("reaction 實際規劃的官方月資料 units"),
        reactionOfficialMonthUnitLimit: z.literal(48).describe("reaction 官方月資料 units 固定上限"),
        reactionCorporateActionRequests: z.number().int().describe("reaction 公司行動 logical requests"),
      })
      .strict()
      .describe("粗篩、金融 deep batches 與 reaction 的 bounded 工作量"),
    candidates: z
      .array(financialCandidateSchema.describe("一家具完整金融四柱的候選公司"))
      .describe("最多 candidateLimit 家已完成 reaction 並組成金融四柱的候選列"),
    summaryLimits: z
      .object({
        maximumPerList: z.literal(25).describe("三個摘要清單各自的固定回傳筆數上限"),
        notDeepScoredTotal: z.number().int().describe("粗篩合格但未深篩的完整數量"),
        notReactionScoredTotal: z.number().int().describe("已進 deep stage 但未形成 reaction 第四柱的完整數量"),
        excludedTotal: z.number().int().describe("母體、mapping 與粗篩排除公司的完整數量"),
      })
      .strict()
      .describe("bounded 摘要清單的上限與未截斷總數"),
    notDeepScored: z
      .array(financialCompactCompanySchema.describe("單一未進入 top-10 deep stage 的金融公司"))
      .describe("粗篩合格但未進入 top-10 深篩的公司摘要"),
    notReactionScored: z
      .array(financialCompactCompanySchema.describe("單一未形成 reaction 第四柱的 deep-stage 公司"))
      .describe("已進 deep stage 但未形成 reaction 第四柱的公司摘要"),
    excluded: z
      .array(financialCompactCompanySchema.describe("單一在 universe、mapping 或 coarse stage 排除的公司"))
      .describe("因非金融、KY、mapping 不安全或粗篩必要資料而排除的公司摘要"),
    dependencyStatus: z
      .array(financialDependencyStatusSchema.describe("單一 pipeline dependency 狀態"))
      .describe("各 pipeline 即時 dependency 的完成與影響範圍"),
    mappingCoverage: financialMappingCoverageSchema.describe("本次所用完整金融 institution mapping coverage"),
    sources: z
      .array(financialScreenSourceSchema.describe("一份實際使用且去重後的官方來源"))
      .describe("本次實際使用且去重後的官方來源與各自 as-of"),
    warnings: z
      .array(z.string().describe("單一金融口徑、適用性、覆蓋、缺值或非投資建議警示"))
      .describe("回答時不可忽略的金融模型、資料與投資建議限制"),
  })
  .strict()
  .describe("金融股 latest-only 研究候選分流的完整可稽核 domain result") satisfies z.ZodType<TaiwanFinancialScreenResult>;

export const screenTaiwanFinancialCandidatesOutputSchema = z
  .object({
    ...successResultShape,
    ...screenTaiwanFinancialCandidatesDataSchema.shape,
  })
  .strict()
  .describe("screen_taiwan_financial_candidates 的成功 envelope、共用 MCP metadata 與完整 domain result");
