import { describe, expect, it } from "vitest";

import {
  MOPSFIN_OFFICIAL_GUIDANCE,
  MOPSFIN_SERVER_INSTRUCTIONS,
  companyMetricWarnings,
  financialInstitutionWarnings,
  metricGuidance,
} from "@/lib/mopsfin/guidance";
import type { MetricDefinition } from "@/lib/mopsfin/types";

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
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("v0.6.0");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("共提供 17 個工具");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("get_daily_market_valuation");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("get_monthly_revenue");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("成交量正規化為股");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("strict_current_master");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("valueStatus");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("filingCoverage");
    expect(MOPSFIN_SERVER_INSTRUCTIONS).toContain("INCOMPLETE_COVERAGE");
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
