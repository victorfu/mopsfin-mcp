import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PUBLIC_TOOL_NAMES, TOOL_COUNT } from "@/lib/mcp/tool-manifest";
import { SERVER_VERSION } from "@/lib/server/identity";

const readme = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

const verifiedExamplePrompts = [
  "查台積電最近 12 季營業收入，整理成表格並標示期別、單位與 warnings。",
  "用 get_valuation_model_inputs 整理台積電的 TTM、歷史 FCFF proxy、net debt、目前 issued shares、最近完成官方收盤與 enterprise value；逐欄列出 evidenceClass、formula、lineage、data_gap 與 freshness，不補 0、不當成 point-in-time vintage，也不要執行 DCF。",
  "用 run_reverse_dcf 反解台積電目前官方收盤價隱含的 5 年 revenue CAGR；明示 WACC、terminal growth、normalized margin、cash tax、sales-to-capital、solve range 與每一項 EV bridge assumption，列出 forecast、terminal value、PV tie-out、evidenceClass、source cutoffs 與 sensitivity cell failures，不要把結果稱為目標價、共識或投資建議。",
  "用 analyze_observed_price 比較我在 2026-08-28T14:00:00+08:00 看到的台積電 1,200 元，與官方最近完成交易日收盤價；把 caller-supplied 與 official evidence 分開，列出 cutoff、cache、價差與 warnings，不要稱為即時行情、合理價或投資建議。",
  "查台積電 2025-01-01 到 2026-08-24 的原始日線 OHLC，若尚未完整請沿 nextCursor 繼續。",
  "用 get_stock_price_series 查台積電 2025-01-01 到 2026-08-24 的 price-index-compatible 公司行動調整日線並附 event ledger；同時保留 raw OHLC、標示 backward anchor、現金股利 factor=1 與 raw shares，任何 adjustment 證據不足請回 null，不要回退 raw，也不要稱為 adjusted close 或 total return。",
  "列出 2026-08-24 全部上市與上櫃公司的原始日線 OHLC，標示實際資料日期與來源。",
  "查最新上市櫃公司估值，列出台積電與穩懋的本益比、股價淨值比、殖利率及 valueStatus。",
  "查 2025-01-02 上市櫃公司估值，列出台積電與穩懋的 PE、PB、股利年度、參考財報期與 rawValue。",
  "查最新上市櫃月營收，列出台積電與穩懋的 MoM、YoY、資料年月及 filingCoverage。",
  "查台積電 2025-01 月營收，標示目前修訂後 archive、來源產業名稱與資料出表日。",
  "查台積電截至 2026-07 的最近 12 個月營收趨勢，列出 3／6 月 YoY 與加速度。",
  "查台積電、聯發科與穩懋的 ROE、毛利率及營業利益率最近 8 季資料，按公司整理。",
  "比較台積電與 TAIEX 截至 2026-08-24 的 5、20、60、120 交易日原始與 price-index-compatible 報酬、公司行動證據及量能訊號。",
  "用 balanced_non_financial_v2 篩選最新上市櫃非金融研究候選，最多 5 家；逐家列出四柱 status、分數、as-of、缺值與下一步查核，不要當成投資建議。",
  "用 balanced_financial_v1 篩選 exact-mapped 金控、銀行與票券研究候選，最多 5 家；逐家列出 subtype、mapping、四柱、獲利／資本／資產品質 through period、同 subtype peer count 與 unknown，不要與非金融 raw score 比較或當成投資建議。",
  "用 balanced_non_financial_v2 篩選最新上市櫃非金融研究候選，並只替實際最多 5 名 candidates 附 current catalyst snapshots；保留 affectsScreenScore=false，不要當成第五柱、分析師 consensus 或投資建議。",
  "查台積電與聯發科 2026-07-01 至 2026-08-24 的官方重大訊息與法說會；分開 publishedAt、factDate、scheduledAt、effectiveAt，並標示 failures 與 verified empty，不要當成 consensus 或正負面分數。",
  "查台積電與穩懋的 current official catalyst snapshots，分開財測達成、財測重大差異、股東會與股利決議；標示 sourceSnapshotDate、freshness、firstKnownAt、upcomingEligible 與 unsupported，不要當成歷史事件或分析師 consensus。",
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

  it("documents the canonical server and tool contract with official sources", () => {
    expect(readme).toContain(`目前版本 \`${SERVER_VERSION}\``);
    expect(readme).toContain(`${TOOL_COUNT} 個工具`);
    expect(readme).toContain("browser-safe server identity");
    expect(readme).toContain("dependency-free tool manifest");
    expect(readme).toContain(
      "`screen_taiwan_stock_candidates_with_catalyst_snapshots`",
    );
    expect(readme).toContain("只取 screen 實際形成的 `candidates`");
    expect(readme).toContain(
      "不論其 bucket 是 `research_candidate`、`watchlist`、`insufficient_data` 或 `deprioritized`",
    );
    expect(readme).toContain("數量仍受 `candidate_limit` 限制且最多 5 家");
    expect(readme).toContain(
      "不因 bucket 排除其中的 `watchlist`、`insufficient_data` 或 `deprioritized`",
    );
    expect(readme).toContain(
      "只排除 `notDeepScored`、`notReactionScored`、`excluded`",
    );
    expect(readme).toContain("進入 `deepSelected` 但未形成 candidate 的公司");
    expect(readme).toContain("Current snapshots 不是歷史事件資料");
    expect(readme).toContain("不是分析師 consensus／consensus revision");
    expect(readme).toContain("`affectsScreenScore=false`");
    expect(readme).toContain("不是第五柱、不會成為加分項");
    expect(readme).toContain("standalone tools 全部保留");
    expect(readme).toContain("liveness=ok");
    expect(readme).toContain("applicationReadiness=ready");
    expect(readme).toContain("upstreamContracts.status=not_checked");
    expect(readme).toContain("只代表應用程式的 shallow readiness");
    expect(readme).toContain("只適用於 Mopsfin 財務資料");
    expect(readme).toContain("不代表所有 TWSE／TPEx 資料都固定落後一天");
    expect(readme).toContain("latest` 指最近可驗證的完成交易日");
    expect(readme).toContain("freshnessDetails");
    expect(readme).toContain("FRESHNESS_UNVERIFIED");
    expect(readme).toContain("DATA_STALE");
    expect(readme).toContain("cache.status/observedAt/storedAt/ageMs/ttlMs");
    expect(readme).toContain("cache hit 不會用 `servedAt` 覆寫原始 `retrievedAt`");
    for (const tool of PUBLIC_TOOL_NAMES) expect(readme).toContain(`\`${tool}\``);
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
    expect(readme).toContain("https://www.twse.com.tw/holidaySchedule/holidaySchedule");
    expect(readme).toContain("https://www.tpex.org.tw/www/zh-tw/bulletin/tradingDate");
    expect(readme).toContain("sourceCoverage");
    expect(readme).toContain("STATELESS_PAGE_VALUES_NOT_PINNED");
    expect(readme).toContain("comparability=needs_review");
    expect(readme).toContain("declared row count");
    expect(readme).toContain("coverageVerification.status");
    expect(readme).toContain("MASTER_ROWSET_HEURISTIC");
    expect(readme).toContain("CATALOG_CONTRACT_MISMATCH");
    expect(readme).toContain("evidencePolicies.requiredFinancialMetricRoles");
    expect(readme).toContain("absolute deadline");
    expect(readme).toContain("Retry-After");
    expect(readme).toContain("不記錄 tool arguments");
    expect(readme).toContain("每週一次");
    expect(readme).toContain("npm run test:live:corporate-actions");
    expect(readme).toContain("npm run test:live:catalog-screen");
    expect(readme).toContain("npm run test:live:completed-session");
    expect(readme).toContain("npm run test:live:observed-price");
    expect(readme).toContain("npm run test:live:valuation-model-inputs");
    expect(readme).toContain("完整 live suite");
    expect(readme).toContain(
      "`suite` 可選 `catalog-screen`、`completed-session`、`corporate-actions`、`catalysts`、`observed-price`、`valuation-model-inputs` 或 `all`",
    );
    expect(readme).toContain("### `get_valuation_model_inputs` 可追溯估值模型資料層");
    expect(readme).toContain("### `run_reverse_dcf` 市場隱含 Reverse DCF");
    expect(readme).toContain("### `analyze_observed_price` Caller 觀察價比較");
    expect(readme).toContain("`priceOrigin=caller_supplied`");
    expect(readme).toContain("authoritative completed-close routing");
    expect(readme).toContain("resolver `expectedAsOf`");
    expect(readme).toContain("exact single-stock monthly OHLC");
    expect(readme).toContain("`selectedBarDate=expectedAsOf`");
    expect(readme).toContain("`dataMonth` 是月資料文件身分");
    expect(readme).toContain("`workBudget.authoritativeCompletedCloseCalls`");
    expect(readme).toContain("不會在 exact bar 缺少時退回前一交易日");
    expect(readme).toContain("不要求 `reportDate` 同日");
    expect(readme).toContain("兩份 master freshness 依各自 `reportDate` 分開揭露");
    expect(readme).toContain(
      "外層 `market=all` current master 先唯一核對指定公司的 code、short name、market 與 exchange",
    );
    expect(readme).toContain("`13:33:00 Asia/Taipei`");
    expect(readme).toContain("`-00:00` 表示未知 local offset");
    expect(readme).toContain("NOT_APPLICABLE_FINANCIAL_COMPANY");
    expect(readme).toContain("每個 cell 會重新反解");
    expect(readme).toContain("最多 26");
    expect(readme).toContain("整體最多 8,398 次 model evaluations");
    expect(readme).toContain("不是 intrinsic value、目標價、分析師共識");
    expect(readme).toContain("source/sign-normalized historical FCFF proxy");
    expect(readme).toContain("不是 point-in-time filing vintage");
    expect(readme).toContain("不是歷史期末、加權平均或 fully diluted shares");
    expect(readme).toContain("MIXED_OFFICIAL_CALC");
    expect(readme).toContain("不執行 DCF");
    expect(readme).toContain("六組 range-family");
    expect(readme).toContain("TWSE `TWT49UDetail`");
    expect(readme).toContain("`verified_empty`");
    expect(readme).toContain("`unverified_empty`");
    expect(readme).toContain("schema drift");
    expect(readme).toContain("不使用資料庫、不寫入 persistence");
    expect(readme).toContain("這兩個 OHLC tools");
    expect(readme).toContain("不內嵌公司行動資料或公司行動調整價");
    expect(readme).toContain("### `get_stock_price_series` 公司行動調整價格序列");
    expect(readme).toContain("單次最多 36 個日曆月份");
    expect(readme).toContain("沒有 public cursor");
    expect(readme).toContain("最多 3 個既有 `get_stock_ohlc` cursor pages");
    expect(readme).toContain("完全不查公司行動");
    expect(readme).toContain("backward factor");
    expect(readme).toContain("cash-only 現金股利 factor 固定為 1");
    expect(readme).toContain("`volumeBasis=raw_shares`");
    expect(readme).toContain("絕不回退 raw");
    expect(readme).toContain("`meta.quality.freshness=not_applicable`");
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
    expect(readme).toContain("screen 本身目前沒有分析師預期修正、新聞、法人流向、持股或放空");
    expect(readme).toContain("material_information");
    expect(readme).toContain("investor_conference");
    expect(readme).toContain("per_company_event_type_calendar_month");
    expect(readme).toContain("計畫查詢工作單位上限為 40");
    expect(readme).toContain("歷史法說每個 company×month 會分上市與上櫃兩單位");
    expect(readme).toContain("coverage.currentSnapshots");
    expect(readme).toContain("publishedAt");
    expect(readme).toContain("factDate");
    expect(readme).toContain("scheduledAt");
    expect(readme).toContain("effectiveAt");
    expect(readme).toContain("isConsensus");
    expect(readme).toContain("CATALYST_OFFSET_PAGE_NOT_PINNED");
    expect(readme).toContain("npm run test:live:catalysts");
    expect(readme).toContain(
      "`corporate-actions`、`catalysts`、`observed-price`、`valuation-model-inputs` 或 `all`",
    );
    expect(readme).toContain("https://openapi.twse.com.tw/v1/opendata/t187ap04_L");
    expect(readme).toContain("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O");
    expect(readme).toContain("https://mopsov.twse.com.tw/mops/web/ajax_t05st01");
    expect(readme).toContain("https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1");
    expect(readme).toContain("forecast_achievement");
    expect(readme).toContain("forecast_material_variance");
    expect(readme).toContain("shareholder_meeting");
    expect(readme).toContain("dividend_decision");
    expect(readme).toContain("sourceSnapshotDate");
    expect(readme).toContain("pointInTimeHistoryAvailable");
    expect(readme).toContain("firstKnownAt");
    expect(readme).toContain("upcomingEligible");
    expect(readme).toContain("not_disclosed_in_snapshot");
    expect(readme).toContain("within_expected_window");
    expect(readme).toContain(
      "任何 `sourceSnapshotDate` 晚於 Asia/Taipei as-of date",
    );
    expect(readme).not.toContain("未來超過 1 日");
    expect(readme).toContain("stale `mopsfin_t187ap39_O`");
    expect(readme).toContain("TPEx current dividend route 是 `unsupported`");
    expect(readme).toContain("catalyst-snapshots.live.test.ts");
    expect(readme).toContain("https://openapi.twse.com.tw/v1/opendata/t187ap15_L");
    expect(readme).toContain("https://www.tpex.org.tw/openapi/v1/t187ap41_O");
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
