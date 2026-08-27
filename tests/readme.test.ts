import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readme = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

const verifiedExamplePrompts = [
  "查台積電最近 12 季營業收入，整理成表格並標示期別、單位與 warnings。",
  "查台積電 2025-01-01 到 2026-08-24 的原始日線 OHLC，若尚未完整請沿 nextCursor 繼續。",
  "列出 2026-08-24 全部上市與上櫃公司的原始日線 OHLC，標示實際資料日期與來源。",
  "查最新上市櫃公司估值，列出台積電與穩懋的本益比、股價淨值比、殖利率及 valueStatus。",
  "查 2025-01-02 上市櫃公司估值，列出台積電與穩懋的 PE、PB、股利年度、參考財報期與 rawValue。",
  "查最新上市櫃月營收，列出台積電與穩懋的 MoM、YoY、資料年月及 filingCoverage。",
  "查台積電 2025-01 月營收，標示目前修訂後 archive、來源產業名稱與資料出表日。",
  "查台積電截至 2026-07 的最近 12 個月營收趨勢，列出 3／6 月 YoY 與加速度。",
  "查台積電、聯發科與穩懋的 ROE、毛利率及營業利益率最近 8 季資料，按公司整理。",
  "比較台積電與 TAIEX 截至 2026-08-24 的 5、20、60、120 交易日原始與 price-index-compatible 報酬、公司行動證據及量能訊號。",
  "用 balanced_non_financial_v2 篩選最新上市櫃非金融研究候選，最多 5 家；逐家列出四柱 status、分數、as-of、缺值與下一步查核，不要當成投資建議。",
  "列出全部上市公司代號，不要包含上櫃公司。",
  "列出全部上市與上櫃公司，排除金融業與 KY 公司。",
  "比較台積電和聯發科最近 8 季 ROE，標示期別、單位與 warnings。",
  "列出台積電 2025Q4 資產負債表的主要項目，標示單位與資料來源。",
  "比較半導體業最近 12 季營收趨勢，並說明單季／累計口徑與 warnings。",
  "查臺企銀最近可用的銀行業資本適足率；若最新期別為 null，往前找最近一個非 null，並標示期別、單位與 warnings。",
];

describe("README example prompts", () => {
  it("keeps every live-verified example prompt in the active README", () => {
    for (const prompt of verifiedExamplePrompts) {
      expect(readme).toContain(`「${prompt}」`);
    }
  });

  it("does not reintroduce examples with known upstream-data ambiguity", () => {
    expect(readme).not.toContain("查臺銀最近可用的銀行業資本適足率");
    expect(readme).not.toContain("列出最近完成交易日全部上市櫃公司的 OHLC");
  });

  it("documents the v0.5.1 sixteen-tool contract and official sources", () => {
    const tools = [
      "find_companies",
      "get_stock_ohlc",
      "get_daily_market_ohlc",
      "get_stock_reaction_signals",
      "get_daily_market_valuation",
      "get_monthly_revenue",
      "get_monthly_revenue_trend",
      "screen_taiwan_stock_candidates",
      "list_companies",
      "list_catalog",
      "get_company_metric",
      "get_company_metrics_batch",
      "get_financial_statement",
      "get_financial_note",
      "get_industry_data",
      "get_financial_institution_metric",
    ];
    expect(readme).toContain("目前版本 `0.5.1`");
    expect(readme).toContain("十六個工具");
    for (const tool of tools) expect(readme).toContain(`\`${tool}\``);
    expect(readme).toContain("meta.contractVersion=mopsfin.result.v1");
    expect(readme).toContain("meta.asOf");
    expect(readme).toContain("action=restart_pagination");
    expect(readme).toContain("成交股數、成交金額、成交筆數與漲跌");
    expect(readme).toContain("BWIBBU_d");
    expect(readme).toContain("peQryDate");
    expect(readme).toContain("t21sc03_{民國年}_{月}.csv");
    expect(readme).toContain("MI_5MINS_HIST");
    expect(readme).toContain("tradingIndex");
    expect(readme).toContain(
      "https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL",
    );
    expect(readme).toContain(
      "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis",
    );
    expect(readme).toContain(
      "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    );
    expect(readme).toContain(
      "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
    );
    expect(readme).toContain("不是當時發布內容的 vintage snapshot");
    expect(readme).toContain("不是 total-return index");
    expect(readme).toContain("price_index_compatible_corporate_action_adjusted");
    expect(readme).toContain("不是 adjusted close");
    expect(readme).toContain("現金股利造成的價格效果會保留");
    expect(readme).toContain("reaction cursor v2");
    expect(readme).toContain("整個 requested company scope 的 TWSE 權息 detail fingerprint");
    expect(readme).toContain("affected volume signal");
    expect(readme).toContain("https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html");
    expect(readme).toContain("https://www.twse.com.tw/zh/announcement/reduction/twtauu.html");
    expect(readme).toContain("https://www.twse.com.tw/zh/announcement/change/twtb8u.html");
    expect(readme).toContain("https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ");
    expect(readme).toContain("https://www.tpex.org.tw/www/zh-tw/bulletin/revivt");
    expect(readme).toContain("https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt");
    expect(readme).toContain("sourceCoverage");
    expect(readme).toContain("STATELESS_PAGE_VALUES_NOT_PINNED");
    expect(readme).toContain("comparability=needs_review");
    expect(readme).toContain("declared row count");
    expect(readme).toContain("coverageVerification.status");
    expect(readme).toContain("MASTER_ROWSET_HEURISTIC");
    expect(readme).toContain("absolute deadline");
    expect(readme).toContain("Retry-After");
    expect(readme).toContain("不記錄 tool arguments");
    expect(readme).toContain("每週一次");
    expect(readme).toContain("npm run test:live:corporate-actions");
    expect(readme).toContain("完整 live suite");
    expect(readme).toContain("`suite` 可選 `corporate-actions` 或 `all`");
    expect(readme).toContain("六組 range-family");
    expect(readme).toContain("TWSE `TWT49UDetail`");
    expect(readme).toContain("`verified_empty`");
    expect(readme).toContain("`unverified_empty`");
    expect(readme).toContain("schema drift");
    expect(readme).toContain("不使用資料庫、不寫入 persistence");
    expect(readme).toContain("這兩個 OHLC tools");
    expect(readme).toContain("不內嵌公司行動資料或公司行動調整價");
    expect(readme).toContain("balanced_non_financial_v2");
    expect(readme).toContain("taiwan_stock_screen.v2");
    expect(readme).toContain("coarseRanking");
    expect(readme).toContain("evidencePolicies");
    expect(readme).toContain("companyQuality");
    expect(readme).toContain("fundamentalImprovement");
    expect(readme).toContain("reasonableValuation");
    expect(readme).toContain("marketUnderreactionProxy");
    expect(readme).toContain("latest-only");
    expect(readme).toContain("最多 5 家");
    expect(readme).toContain("不是 point-in-time／無存活者偏誤回測");
    expect(readme).toContain("目前沒有分析師預期修正、新聞、法人流向、持股、放空");
    expect(readme).toContain("failureIsolationComplete=false");
    expect(readme).toContain("company×metric");
    expect(readme).toContain("company_metrics_unavailable");
    expect(readme).toContain("availability");
    expect(readme).toContain("notReactionScored");
    expect(readme).toContain("自動遞補");
    expect(readme).not.toContain("請勿把 live tests 設為定時 CI");
    expect(readme).not.toContain("v1 都只支援 latest");
    expect(readme).not.toContain("第一版只提供官方最新");
    expect(readme).not.toContain("不提供盤中即時報價、成交量、成交金額");
  });
});
