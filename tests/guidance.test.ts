import { describe, expect, it } from "vitest";

import {
  MOPSFIN_OFFICIAL_GUIDANCE,
  MOPSFIN_SERVER_INSTRUCTIONS,
  companyMetricWarnings,
  financialInstitutionWarnings,
  metricGuidance,
} from "@/lib/mopsfin/guidance";
import { TOOL_COUNT } from "@/lib/mcp/tool-manifest";
import type { MetricDefinition } from "@/lib/mopsfin/types";
import { SERVER_VERSION } from "@/lib/server/identity";

function metric(
  name: string,
  family: MetricDefinition["family"] = "data",
): MetricDefinition {
  return {
    code: name,
    name,
    unit: "%",
    category: "測試分類",
    family,
  };
}

describe("LLM-facing official guidance", () => {
  it("routes the new market tools and preserves completeness semantics", () => {
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(`v${SERVER_VERSION}`);
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      `共提供 ${TOOL_COUNT} 個工具`,
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("get_daily_market_valuation");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("get_monthly_revenue");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("run_reverse_dcf");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("analyze_observed_price");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "caller 值稱為官方或 real-time quote",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "同一台北日期必須到 13:33（含）後才比較",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "凍結同一 evaluatedAt",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不要求兩市場 reportDate 同日",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "兩份 master freshness 依各自 reportDate 揭露",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "authoritative completed-session resolver 解析 expectedAsOf",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "selectedBarDate、bar date 與 expectedAsOf 完全相等",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "全市場 latest OHLC 不參與這條 routing，也不 fallback 前一日",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "workBudget.authoritativeCompletedCloseCalls",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "日估值或全市場行情的 latest 日期不參與 completed-close routing",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "一次只反解 revenue_cagr、fcff_cagr 或 terminal_operating_margin",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不是 intrinsic value、分析師共識、目標價",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("成交量正規化為股");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("strict_current_master");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("valueStatus");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("filingCoverage");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("INCOMPLETE_COVERAGE");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("CATALOG_CONTRACT_MISMATCH");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "screen_taiwan_financial_candidates",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("balanced_financial_v1");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("唯一 exact-code 對應");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "cross-model 不得與 balanced_non_financial_v2 raw score 直接排序",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("net_profit");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("latest 只表示查詢意圖");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("freshnessDetails");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("FRESHNESS_UNVERIFIED");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("DATA_STALE");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("cache hit 不會改寫 retrievedAt");
    expect(MOPSFIN_OFFICIAL_GUIDANCE.valueBasis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataType: "市場隱含 Reverse DCF",
          basis: expect.stringContaining("caller 明示全部"),
        }),
        expect.objectContaining({
          dataType: "Caller 觀察價相對官方完成收盤",
          basis: expect.stringContaining("CALLER_SUPPLIED"),
        }),
      ]),
    );
  });

  it("distinguishes raw OHLC from fail-closed corporate-action-adjusted series", () => {
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("get_stock_price_series");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("最多 36 個日曆月份");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "raw_unadjusted 會在單次 orchestration 內收齊最多 3 個既有 get_stock_ohlc cursor pages，但完全不查公司行動",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "price_index_compatible_corporate_action_adjusted",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "anchorDate 固定為最後一根實際 raw bar",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("cash-only factor=1");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("成交量永遠維持 raw shares");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("不可回退 raw");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("freshness 為 not_applicable");
    expect(MOPSFIN_OFFICIAL_GUIDANCE.valueBasis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataType: "公司行動調整價格序列",
          basis: expect.stringContaining("非 adjusted close 或 total return"),
        }),
      ]),
    );
  });

  it("explains official catalyst scope without upgrading disclosures into signals", () => {
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("get_company_catalyst_events");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("material_information");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("investor_conference");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "per_company_event_type_calendar_month",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("計畫查詢工作單位上限為 40");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "歷史法說固定查上市／上櫃兩市場",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("coverage.currentSnapshots");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "publishedAt、factDate、scheduledAt、effectiveAt",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("isConsensus 固定 false");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不納入 screen_taiwan_stock_candidates 四柱分數",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不是 pinned point-in-time snapshot",
    );
    expect(MOPSFIN_OFFICIAL_GUIDANCE.valueBasis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataType: "官方重大訊息與法人說明會",
        }),
      ]),
    );
  });

  it("keeps current catalyst snapshots distinct from historical events and consensus", () => {
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "get_company_catalyst_snapshots",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("forecast_achievement");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "forecast_material_variance",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("sourceSnapshotDate");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "pointInTimeHistoryAvailable",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("firstKnownAt");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("upcomingEligible");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "stale、failed、unsupported 或 identity_unverified 不是 current no-data",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "任何 sourceSnapshotDate 晚於 Asia/Taipei as-of date",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).not.toContain("未來超過 1 日");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "公司自行揭露財測不是分析師 EPS／營收 consensus",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不請求或以 stale mopsfin_t187ap39_O 冒充當期資料",
    );
    expect(MOPSFIN_OFFICIAL_GUIDANCE.valueBasis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataType: "當期官方 catalyst snapshot evidence",
        }),
      ]),
    );
  });

  it("routes candidate-only snapshot enrichment without changing screen scoring", () => {
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "screen_taiwan_stock_candidates_with_catalyst_snapshots",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "對 screen.candidates 中所有實際 candidates 查 snapshot",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("最多 5 家");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不論 bucket 是 research_candidate、watchlist、insufficient_data 或 deprioritized 都會查",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "只有 notDeepScored、notReactionScored、excluded，以及進入 deepSelected 但未形成 candidate 的公司會排除",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不是歷史事件，也不是分析師 consensus／consensus revision",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("affectsScreenScore=false");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "不是第五柱、加分項、目標價或投資建議",
    );
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain(
      "standalone tools 全部保留",
    );
    expect(MOPSFIN_OFFICIAL_GUIDANCE.interpretationNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "screen_taiwan_stock_candidates_with_catalyst_snapshots 只對實際最多 5 名 candidates",
        ),
        expect.stringContaining("affectsScreenScore=false"),
      ]),
    );
  });

  it("provides formulas and applicability for company and financial metrics", () => {
    expect(metricGuidance(metric("權益報酬率"))).toMatchObject({
      calculation: "（稅後純益 ÷ 平均權益總額）× 100%",
      meaning: expect.stringContaining("平均權益"),
    });
    expect(metricGuidance(metric("毛利率"))).toMatchObject({
      calculation: "（營業毛利 ÷ 營業收入）× 100%",
      applicability: expect.stringContaining("金融業"),
    });
    expect(
      metricGuidance(metric("銀行業資本適足率", "adequacy")),
    ).toMatchObject({
      calculation: expect.stringContaining("加權風險性資產總額"),
      applicability: expect.stringContaining("Q2、Q4"),
    });
  });

  it("explains basis, averages, filing cadence and missing values", () => {
    const warnings = companyMetricWarnings(
      metric("權益報酬率"),
      "quarterly",
      true,
      true,
    );

    expect(warnings.join(" ")).toContain("Q4");
    expect(warnings.join(" ")).toContain("不是市值加權");
    expect(MOPSFIN_OFFICIAL_GUIDANCE.filingCadence).toHaveLength(3);
    expect(MOPSFIN_OFFICIAL_GUIDANCE.interpretationNotes.join(" ")).toContain(
      "不可當成 0",
    );
    const financialWarnings = financialInstitutionWarnings("fin", true, true);
    expect(financialWarnings.join(" ")).toContain("僅銀行業適用");
    expect(financialWarnings.join(" ")).toContain("不是市值加權");
    expect(financialWarnings.join(" ")).toContain("公司平均數");
    expect(MOPSFIN_OFFICIAL_GUIDANCE.averages).toHaveLength(4);
  });

  it("gives useful fallback guidance for report and note catalog entries", () => {
    expect(metricGuidance(metric("綜合損益表(累計)", "report"))).toMatchObject({
      valueBasis: expect.stringContaining("各季累計"),
      calculation: null,
    });
    expect(metricGuidance(metric("資金貸與他人", "xb"))).toMatchObject({
      applicability: expect.stringContaining("自願申報"),
      caveats: expect.arrayContaining([expect.stringContaining("NO_DATA")]),
    });
  });
});
