import type { MetricDefinition } from "./types";

export const MOPSFIN_SERVER_INSTRUCTIONS = `
這是 Mopsfin 台股 MCP v0.6.3，一個公開、唯讀、無資料庫的台灣公司財務與市場資料 Server，共提供 18 個工具。公司財務、報表、附註、產業與金融機構資料在查詢時直接取自「公開資訊觀測站－財務比較 E 點通（Mopsfin）」；上市櫃公司母體、OHLC 價量、歷史日估值、歷史月營收、市場價格指數、公司行動實際結果、重大訊息與法人說明會、current official catalyst snapshots 直接取自 MOPS、TWSE 與 TPEx 官方資料。

使用順序：需要「好公司＋基本面改善＋估值合理＋市場尚未充分反應」的初步研究名單時使用 screen_taiwan_stock_candidates；它只做 latest、非金融、營收改善導向的有界 research triage。對篩選後的少量公司查核指定日期範圍內的官方重大訊息與法人說明會時使用 get_company_catalyst_events；查核當期財測達成／重大差異、股東會與股利決議 snapshot 時使用 get_company_catalyst_snapshots；兩者都不會改變 screen 分數。需要目前上市櫃母體或自行掃描候選代號時先呼叫 list_companies；只知道特定公司名稱或代號時使用 find_companies，不要用 find_companies 枚舉全市場。list_companies 的 market=listed 只回上市（含創新板）、market=otc 只回上櫃、market=all 合併兩個當次官方來源；include_financial=false 或 include_ky=false 可排除金融保險業或 KY 公司。查單一股票跨期歷史價量使用 get_stock_ohlc；查同一交易日 accepted market snapshot 或一批代號使用 get_daily_market_ohlc，並依 universeCoverageVerified／reconciliation 判讀 rowset；比較個股與市場在 5／20／60／120 個交易日視窗的原始報酬、price-index-compatible 報酬、量能與價格路徑代理訊號使用 get_stock_reaction_signals。查 latest 或指定日估值使用 get_daily_market_valuation；查單月營收使用 get_monthly_revenue；查 3–24 個月營收序列與透明衍生值使用 get_monthly_revenue_trend。不知道 metric_code、industry_codes、institution_codes 或可用期別時先呼叫 list_catalog；單一指標使用 get_company_metric，多家公司 × 多指標使用 get_company_metrics_batch。回答前應讀取 list_catalog guidance 以及每次結果的 meta、coverage、status 與 warnings。

候選篩選：screen_taiwan_stock_candidates 固定 preset=balanced_non_financial_v2、screenDefinition.id=taiwan_stock_screen.v2，只接受目前上市櫃非金融公司，market 可選 all／listed／otc，company_codes 最多 100 家、candidate_limit 最多 5 家、include_ky 預設 true。省略 company_codes 時以目前 heuristic-gated master 為母體；先用 latest 月營收與 latest 估值做低成本粗篩，最多 10 家再查 6 個月營收趨勢及 roe、net_profit、operating_cashflow、debt_ratio、gross_margin、operating_margin、eps 七個 semantic roles，最後只對最多 5 家查 5／20／60 日 reaction signals。screen 每次先用即時 catalog 的 family=data 正式中文名稱解析 role；已知歷史代號只作 fallback，缺少、重複、名稱／代號衝突或 batch definition 漂移會以 CATALOG_CONTRACT_MISMATCH fail closed，不會猜測或默默降為 unknown。screenDefinition.evidencePolicies 揭露當次 resolved code/name/family、catalogDiscoveredAt 與 catalogSnapshotId；generic get_company_metric／get_company_metrics_batch 仍要求當次 catalog 的正式代號。deep batch 逐公司解析 identity，並在 24-unit 預算內嘗試隔離 metric 錯誤；受影響代號列在 dependencyStatus.affectedCompanyCodes，並以 notReactionScored.reasonCodes=company_metrics_unavailable 保留 unavailable／unknown 語意，不會當成 fail 或 0 分。無法精確隔離時保守標記共享 chunk；其餘 deepSelected 公司繼續，但不從 deepSelected 之外遞補。四柱 companyQuality、fundamentalImprovement、reasonableValuation、marketUnderreactionProxy 各自回 pass／fail／unknown；四柱都可判讀時才提供等權總分，四柱全 pass 才歸 research_candidate。只有完成 reaction 並形成 candidates 的公司才進 bucket；其中品質與改善通過但估值或市場柱未通過者為 watchlist，必要柱 unknown 為 insufficient_data，其餘為 deprioritized；deep evidence unavailable 者留在 notReactionScored。結果保留完整 coarseRanking、evidencePolicies、criteria／weights、funnel、workBudget、mixed asOf、dependencyStatus 與來源 lineage；不同來源的最新日期可能不一致。marketUnderreactionProxy 只接受公司行動 coverage、調整因子、前收盤核對與 marker reconciliation 足以形成 price_index_compatible 證據的 reaction；證據不足即為 unknown，不退回 raw score。目前沒有分析師預期修正、新聞、法人流向、持股或放空資料。這不是完整全市場深度覆蓋、point-in-time／無存活者偏誤回測、錯價證明或投資建議；應把候選視為下一輪查核清單。

官方事件：get_company_catalyst_events 查詢 1–20 家 selected companies 在明確 YYYY-MM-DD 起訖範圍內的官方重大訊息與法人說明會，含首尾最多 366 日。重大訊息使用 MOPS 歷史查詢並在近期範圍以 TWSE／TPEx current OpenAPI 補強，法說會使用 MOPS 歷史日曆；公開介面只支援 material_information 與 investor_conference。目前 master 只協助 current identity 與近期重大訊息市場路由；歷史法說固定查上市／上櫃兩市場，避免轉板漏件。catalyst 計畫查詢工作單位上限為 40：重大訊息每個 company×month 一單位、歷史法說每個 company×month×market 一單位，再加近期 market snapshot；這不包含 master hint、cache／single-flight 或 retry attempts，也不是實際 HTTP attempt 計數。失敗依 per_company_event_type_calendar_month 隔離；familyCoverage 只計歷史月份，近期補強另列 coverage.currentSnapshots。只有官方明確空回應可驗證、所有 requested families complete、companies[].eventCount=0、沒有 failures 且 meta.quality.selection=complete 已確認 identity 時，才可稱為該公司在 requested range 已驗證無事件；上游、security block 或 parser failure 不是空值。publishedAt、factDate、scheduledAt、effectiveAt 必須分開解讀；dateConfidence=confirmed 只表示官方時間證據，不表示正面、負面或市場尚未反應。本工具 isConsensus 固定 false，不提供公司財測、分析師 consensus／預估修正、情緒、impact score、目標價或投資建議，也不納入 screen_taiwan_stock_candidates 四柱分數。offset 續頁會重新查詢官方來源，不是 pinned point-in-time snapshot；必須沿用相同 query 並比對 fingerprint 與 meta.asOf.snapshotId，改變時從 offset=0 重查。

公司母體：list_companies 只列 TWSE／TPEx 公司普通股母體，不含 ETF、ETN、權證、特別股與 TDR。上市來源的 TDR 會固定排除，因為 Mopsfin 不涵蓋 TDR。market=all 只有在上市與上櫃兩個必要來源都成功，且各來源通過必要欄位、單一出表日期、唯一代號與最低筆數 heuristic gate 時才回傳 coverageComplete=true。官方來源沒有 declared row count，因此 coverageComplete 是向後相容成功旗標，不證明完整 rowset；必須保留 coverageVerification.status=heuristic、officialDeclaredRowCountAvailable=false、sources.minimumExpectedCount、meta.quality.universe=unverified、MASTER_ROWSET_HEURISTIC issue、各自 reportDate、snapshotId、counts 與 warnings。公司列在母體只表示目前屬上市櫃公司，不保證每個 Mopsfin 指標或期別都有資料。

價格資料：兩個 OHLC 工具回官方原始未還原權值日線，priceBasis=raw_unadjusted、幣別 TWD、時區 Asia/Taipei、interval=1d，並將成交量正規化為股、成交金額正規化為 TWD，同時保留成交筆數、漲跌價差、changeMarker、逐列 qualityStatus／missingFields 與來源 normalization；不提供盤中即時價或 adjusted close。get_stock_ohlc 每頁最多處理 12 個月份；coverageComplete=false 時必須用 nextCursor 續查，不能把局部頁面描述成完整 requested range。每個實際探測的市場月份都有獨立 source；只有回應本身可核對月份時才保留 dataMonth 並以 meta.asOf.sourceCutoffs 追溯。官方 no-data response 若缺 title/date，snapshotIdentity=unverified_empty、dataMonth 省略、cutoff 為 none，meta.quality.source=partial 並帶 SOURCE_SNAPSHOT_IDENTITY_UNVERIFIED。TWSE 個股月資料自 2010-01-04、TPEx 自 1994-01-01 起；可探測已下市櫃代號並合併上櫃轉上市月份。get_daily_market_ohlc 的 latest 是最近完成交易日；market=all 要求兩市場日期一致，指定假日或未來日不退回其他日期。latest 的 universe_policy=compatible 允許四碼公司代號 fallback，但各市場 matchRatio 低於 95% 仍拒絕疑似截斷資料；universeCoverageVerified 與 reconciliation.coverageComplete 只在集合與目前 heuristic-gated master 完全吻合時為 true，不能因此證明完整 rowset。strict_current_master 只支援 latest，無法精確核對時回 INCOMPLETE_COVERAGE；歷史日採 historical_code_rule，不套用今天 master。null、no_trade 或 partial 不可改寫為 0。

估值：get_daily_market_valuation 接受 latest 或 YYYY-MM-DD，指定日採 exact-date，假日不退回前一交易日；上市自 2005-09-02、上櫃與 market=all 自 2007-01-02。latest 先以官方 OpenAPI 決定最近估值日，再以同日官方端點補齊收盤價、每股股利、股利年度與估值參考財報期；成功時 sources 保留 discovery 與 exact-day lineage，補強失敗時保留單一 OpenAPI 基本估值並用 not_provided_by_source 說明。核心 PE／PB／殖利率 key 若從 eligible row 消失會視為上游 schema drift 並報錯；TWSE total 與 TPEx totalCount 也必須存在且等於實際列數，否則拒絕截斷回應。latest 預設 compatible 並以目前 master 揭露 reconciliation；strict_current_master 只支援 latest。歷史估值不使用目前 master，classificationPolicy=historical_code_rule、reconciliation 為空、universeCoverageVerified=false，以避免存活者偏誤。本益比、股價淨值比、殖利率與補強欄位皆須連同 valueStatus、rawValue 解讀，null 不可改寫成 0，也不可自行重算財報分母或股利。

月營收：get_monthly_revenue 接受 latest 或 2013-01 起的 YYYY-MM。latest 先以兩市場 OpenAPI 發現月份，再與同月或前一月 MOPS archive 核對共同有效月份；同月不同出表日的少量重疊列差異視為官方修訂，採較新 snapshot 並 warning，同出表日或大範圍數值衝突則報錯。指定歷史月直接讀 MOPS CSV archive。歷史 archive 是目前可取得的修訂後檔案，不是當時發布內容的 vintage snapshot，不適合宣稱無偏誤 point-in-time backtest。MOPS 檔沒有 declared row count、footer 或 checksum；sources.integrity 分開揭露已驗證的 RFC 4180／必要欄位／月份身分／唯一代號與仍無法證明的 rowset completeness。CSV parser 同時接受官方舊版短欄名與目前帶營業收入／累計營業收入前綴的 14 欄格式。latest 省略 universe_policy 時使用 strict_current_master；歷史月只能使用 compatible，歷史 sourceIndustryName 來自當月官方列，目前 master 的 industryCode 與 reconciliation 僅供輔助。金額從官方仟元乘以 1,000 正規化為 TWD；coverageComplete 是相容欄位，latest 成功完成必要來源、格式與 snapshot identity 核對時為 true，歷史 archive 因無 declared row count 固定為 false。sourceCoverage 表示 rowset 能否核對，filingCoverage 只讓 latest 判讀申報進度，歷史 status 固定為 historical_cross_timepoint_unverified。sourceReportDate 是資料集出表日期，不是個別公司 filedAt。

月營收趨勢：get_monthly_revenue_trend 必須指定 1–100 個四碼 company_codes、3–24 個 lookback_months，end_month 可為 latest 或 YYYY-MM，固定使用 compatible 並保留 caller 順序。每月缺列明確保留 missing，point 同時保留該月 name 與 market；相鄰有資料月份若名稱或市場改變，comparability=needs_review 且全部 derived 為 null，避免把改名、轉板或代號重用未經核對地串接。rolling 3／6 個月 YoY 以期間當月營收合計相對去年同月營收合計計算，所有必要值須 reported 且去年同期合計大於 0；YoY acceleration 是最新官方 YoY 減三個月前官方 YoY。archive rowset 無法證明完整，因此 coverageComplete=false、sourceCoverage=unverified。這些是可重算的透明衍生值，不是主觀的公司改善評分。

市場反應代理：get_stock_reaction_signals 接受 1–50 家目前上市櫃公司、as_of=latest 或 YYYY-MM-DD，以及不重複的 5／20／60／120 交易日 horizons；每頁 1–10 家且最多 48 個官方市場月份 work units。工具保留 raw_unadjusted 原始報酬，另用 TWSE／TPEx 除權息、減資與面額變更實際結果建立 price_index_compatible_corporate_action_adjusted 報酬，再與 TAIEX 或櫃買官方 price index 比較。現金股利價格效果會保留以匹配 price index；這不是 adjusted close、股息再投資或 total-return index。N-session 只採 benchmark 交易日曆的 exact 起訖日，個股缺錨點不以前一成交日代填。官方 coverage、調整因子、前收盤核對或 changeMarker reconciliation 不足時，相應 adjusted／excess return 與 screening market pillar 必須是 unknown，不能猜測或回退成 raw score；跨越股數變動公司行動的 volume signal 不可比，成交金額仍保留原始 TWD。公司行動各官方資料集可查起日不同，不得宣稱涵蓋來源支援日前的早期事件。訊號是市場尚未反應的研究代理，不是錯價證明或投資建議。必須沿 pagination.nextCursor 續頁並檢查各 signal status、comparability、dataQualityComplete 與 warnings。reaction cursor v2 的 pagination.snapshotId 綁 query／目前 master／benchmark、full-market 公司行動 range contracts/summaries 與整個 requested company scope 的 TWSE 權息 detail evidence，不包含尚未查詢公司的個股 OHLC。官方來源：TWSE TWT49U https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html、TWTAUU https://www.twse.com.tw/zh/announcement/reduction/twtauu.html、TWTB8U https://www.twse.com.tw/zh/announcement/change/twtb8u.html；TPEx 除權息 https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ、減資 https://www.tpex.org.tw/www/zh-tw/bulletin/revivt、面額變更 https://www.tpex.org.tw/www/zh-tw/bulletin/pvChgRslt。

批次基本面：get_company_metrics_batch 一次可接受 1–100 家公司與 1–8 個 list_catalog family=data 指標；按 caller 順序分頁，每頁最多 20 家，且每家公司保留全部 requested metrics。預設每家公司每項指標最多自己的最近 12 期，也可指定含首尾最多 12 季；basis 與 yoy_quarter 沿用 get_company_metric。本工具不提供產業平均或所選公司平均；每 10 家 × 每個指標是一個上游工作，comparison plan 與二分 isolation 合計每頁最多 24 units、併發最多 3。NO_DATA 不算 failure；單一 identity failure 與預算內可隔離的 company×metric error 會 partial success，其他公司與工作繼續，受影響項目以 coverage、availability 與 failure 明示，不把 unavailable 轉成 0 或 fail。無法精確定位時回 failureIsolationComplete=false 與 attribution=chunk；catalog、request／work-budget、ambient deadline、必要 invariant 或所有工作均失敗時仍整頁失敗。page snapshotId 包含完整 point、availability／failure 與 coverage；cursor 只綁 query／catalog，跨頁逐公司值不是 point-in-time 快照。

統一結果契約：成功 structuredContent 固定含 ok=true 與 meta.contractVersion=mopsfin.result.v1。meta.asOf 必須用來確認 requested selector、實際 resolved 範圍、Asia/Taipei、snapshotId 與各來源 cutoff；meta.quality 分別揭露 source、universe、selection、values、freshness 與 issues，universe=compatible/unverified 或 selection/value=unknown 時 overall status 為 partial；meta.page 統一表示 none、offset 或 cursor 分頁及 next。省略 page_size/cursor 的舊全市場工具維持回傳整個 accepted snapshot；提供 page_size 後必須沿 meta.page.next.cursor。HTML 表格沿 pagination.nextOffset，get_stock_ohlc 沿 coverage.nextCursor，reaction 沿 pagination.nextCursor。cursor 不在伺服器保存狀態；先取得整個 accepted rowset 再切頁的工具綁內容快照，但這不額外證明官方 rowset 完整；batch 綁 query／catalog，reaction cursor v2 綁 query／master／benchmark／公司行動 range contracts/summaries 與 requested-company detail fingerprint，後兩者用 STATELESS_PAGE_VALUES_NOT_PINNED 明示尚未讀取的逐公司值不在 snapshot scope。CURSOR_INVALID 或 SNAPSHOT_CHANGED 時必須從第一頁重新查詢。

當期快照證據：get_company_catalyst_snapshots 查詢 1–20 家 selected companies 的 as_of=latest current official snapshot evidence，不是歷史事件查詢。四 family 為 forecast_achievement、forecast_material_variance、shareholder_meeting、dividend_decision，最多檢查上市／上櫃×四 family 的 8 個 source routes。source status 是 nonempty／verified_empty／failed／unsupported，freshness 是 within_expected_window／stale／not_applicable；sourceSnapshotDate 只是當次官方快照日，不是公司財測事實日、首次公告日或歷史 event date。距 Asia/Taipei asOf 不超過 7 日才為 within_expected_window；任何 sourceSnapshotDate 晚於 Asia/Taipei as-of date，或日期格式不可驗證時都 fail closed。not_disclosed_in_snapshot 只能用於 fresh、schema-valid snapshot 中選定代號確實無列；stale、failed、unsupported 或 identity_unverified 不是 current no-data。pointInTimeHistoryAvailable 指出本來源不提供可回放歷史 vintage；firstKnownAt 不以 sourceSnapshotDate 代填。upcomingEligible 只能用於 fresh snapshot 中未過期的股東會，財測、股利決議與 stale evidence 均為 false。公司自行揭露財測不是分析師 EPS／營收 consensus 或 consensus revision。TPEx 沒有可用的 current dividend source；對應 route 為 unsupported，不請求或以 stale mopsfin_t187ap39_O 冒充當期資料。本工具與 get_company_catalyst_events 均不納入 screen_taiwan_stock_candidates 四柱分數。

資料範圍：涵蓋上市、上櫃、興櫃、公開發行公司，以及依法申報財報的未公開發行金融業；不含 TDR 發行公司。資料為採用 IFRSs 後的財務資訊，上市、上櫃、興櫃及金管會主管金融業通常自 2013 年起，公開發行公司通常自 2015 年起，特殊情況依實際採用 IFRSs 年度。

申報頻率：上市及上櫃公司通常有 Q1–Q4；興櫃及公開發行公司通常只有 Q2、Q4；部分公司只需申報年度。不同公司可用期別不同，NO_DATA 或 null 不代表公司不存在，也不可推論為 0。財報附註並非所有市場別都強制申報。

數值解讀：綜合損益表與現金流量表是各季累計；quarterly 是 Mopsfin 的單季口徑，上市櫃 Q4 通常由全年累計減 Q3 累計，興櫃／公開發行 Q2 通常是前兩季累計、Q4 通常由全年累計減 Q2 累計；cumulative_yoy 是指定季度的累計同比，必須提供 yoy_quarter。產業統計是各季累計，產業趨勢同時涉及單季與累計口徑。比較不同公司或期間前，務必確認 unit、periods、basis、warnings 與 metric guidance。

平均數與公司指標覆蓋：公司指標的所選公司平均數是所選公司的簡單平均，產業平均數是依產業分類計算的上市與上櫃公司指標平均。金融機構指標可另外要求相應金控／銀行／票券業的產業平均，以及本次所選機構的簡單平均。所有平均數都由 Mopsfin 計算，不是市值加權。get_company_metric 應依 seriesType 與 companyCode 分辨公司／平均 series，不可只解析 label；每點 valueStatus 與 coverage.selectionComplete、noValidDataCompanyCodes、missingPeriods、commonThroughPeriod 都是答案的一部分。多家公司與多指標的矩陣查詢優先使用 get_company_metrics_batch，不要自行發出大量單指標呼叫。

更新與責任：Mopsfin 每日更新一次，可能較公開資訊觀測站最新申報落後約一日；公司母體應以 list_companies 的各來源 reportDate、價格與估值應以 dataDate、月營收應以 dataMonth／sourceReportDate，並以 meta.asOf.sourceCutoffs、coverage、sources 與 warnings 為準。本服務不是臺灣證券交易所或證券櫃檯買賣中心的官方 MCP，也不構成投資建議；重要判斷應回查官方公司名錄、行情與公開資訊觀測站原始申報。

Freshness 與時間血緣：latest 只表示查詢意圖，不會直接宣稱資料在預期窗口內。meta.asOf 分開提供 data cutoff、真正 upstream retrievedAt、MCP servedAt 與 caller-specific cache provenance；cache hit 不會改寫 retrievedAt，官方未明示 publishedAt 時維持 null。meta.quality.freshnessDetails 以中央 source-specific policy 列出 observedAsOf、expectedAsOf、lag 與 reason；沒有可靠 expected as-of／交易日 resolver 時固定 unknown 並帶 FRESHNESS_UNVERIFIED，落後 policy 時為 stale 並帶 DATA_STALE。歷史 exact/range selector 的 latest freshness 為 not_applicable。

Stateless reliability：每個 MCP request 共用單一 absolute deadline；上游 attempt、等待有界併發 gate 與 retry delay 都不得超過剩餘時間。暫時性錯誤只做有限重試，優先尊重有安全上限的 Retry-After，否則採 exponential backoff 與 jitter。上游 response bytes、JSON／CSV rows、HTML table 展開、動態 TTL cache entries／weight、同時連線數與等待 queue 都有上限；超載或超限會回結構化錯誤。行程內 telemetry 只彙總 MCP method、tool name、延遲、狀態、錯誤碼與 reliability counters，不保留 tool arguments、request body、認證資料或使用者查詢值，也不持久化。shallow health 不呼叫官方來源；官方 schema 與 snapshot identity 另由每週一次的低頻 live contract 檢查。

錯誤語意：工具 handler 失敗時 structuredContent 固定含 ok=false、meta 空值與 error；error.code 保留 INVALID_ARGUMENT、NOT_FOUND、NO_DATA、INCOMPLETE_COVERAGE、UPSTREAM_TIMEOUT、UPSTREAM_RATE_LIMITED、UPSTREAM_BAD_RESPONSE，並另提供 reason、category、retryable、retryAfterMs、action 與已清理的 details。應依 action=fix_input、change_query、retry、restart_pagination 或 none 採取下一步，不要對所有錯誤盲目重試；Zod input 錯誤仍屬 MCP protocol InvalidParams。
`.trim();

export const MOPSFIN_OFFICIAL_GUIDANCE = {
  sourceScope: [
    "公司範圍包含上市、上櫃、興櫃、公開發行公司，以及依法需在公開資訊觀測站申報財報的未公開發行金融業。",
    "不包含發行 TDR（臺灣存託憑證）的公司。",
    "提供各公司採用 IFRSs 後的財務資訊；上市、上櫃、興櫃及金管會主管金融業通常自 2013 年起，公開發行公司通常自 2015 年起，特殊情況依實際採用 IFRSs 年度。",
  ],
  filingCadence: [
    {
      companyType: "上市及上櫃公司",
      availableQuarters: ["Q1", "Q2", "Q3", "Q4"],
      note: "通常一年申報四次。",
    },
    {
      companyType: "興櫃及公開發行公司",
      availableQuarters: ["Q2", "Q4"],
      note: "通常一年申報兩次，因此 Q1、Q3 查無資料可能是正常情況。",
    },
    {
      companyType: "其他依法僅需申報年度財報的公司",
      availableQuarters: ["Q4"],
      note: "可能只有年度資料。",
    },
  ],
  reportAvailability: [
    "上市、上櫃、興櫃公司，以及部分金融機構通常申報四大報表與財報附註。",
    "公開發行公司及其他未公開發行金融業通常只強制申報四大報表，附註屬自願申報，因此查無附註不代表公司不存在。",
  ],
  updateCadence:
    "Mopsfin 資料庫每日更新一次，與公開資訊觀測站公司最新申報可能有約一日時間差。",
  valueBasis: [
    {
      dataType: "綜合損益表與現金流量表",
      basis: "報表為各季累計金額。",
    },
    {
      dataType: "公司趨勢 quarterly",
      basis:
        "代表 Mopsfin 的單季口徑。上市櫃 Q1–Q3 為公司申報單季值，Q4 通常以全年累計減 Q3 累計；興櫃／公開發行 Q2 通常為前兩季累計，Q4 通常以全年累計減 Q2 累計。",
    },
    {
      dataType: "公司趨勢 cumulative_yoy",
      basis: "代表指定 yoy_quarter 的累計金額或比率之年增比較，不是任意滾動 12 個月。",
    },
    {
      dataType: "產業統計",
      basis: "營業收入與稅後純益皆為各季累計金額。",
    },
    {
      dataType: "產業趨勢",
      basis: "營業收入與稅後純益提供單季及累計口徑；回覆時應依 periods、series 與上游標示說明。",
    },
    {
      dataType: "金融業資產品質與資本適足性",
      basis: "為累計／期末申報口徑；資本適足性通常只有 Q2、Q4 需要申報。",
    },
    {
      dataType: "歷史日估值",
      basis:
        "指定日採 exact-date 官方快照，不退回前一交易日；歷史公司列採當日四碼代號規則，不使用目前 master 冒充歷史母體。",
    },
    {
      dataType: "歷史月營收與趨勢",
      basis:
        "MOPS archive 是目前可取得的修訂後月份檔案，不是當時發布內容的 vintage snapshot；來源無 declared row count，格式可驗證但完整 rowset 不可證明；金額由仟元統一換算為 TWD。",
    },
    {
      dataType: "市場反應代理",
      basis:
        "保留 raw_unadjusted 個股報酬，另依 TWSE／TPEx 公司行動實際結果建立 price_index_compatible_corporate_action_adjusted 報酬與官方 price index 比較；現金股利價格效果保留。這不是 adjusted close、股息再投資或 total-return index；必要 coverage／因子／前收盤／marker 證據不足時為 unknown，跨股數變動的 volume 不可比。",
    },
    {
      dataType: "官方重大訊息與法人說明會",
      basis:
        "依 selected company×event family×calendar month 即時查詢 MOPS／TWSE／TPEx；publishedAt、factDate、scheduledAt 與 effectiveAt 不互相代填。只有官方明確空回應才是 verified empty，failure 不是無事件；這不是分析師 consensus、情緒或投資建議。",
    },
    {
      dataType: "當期官方 catalyst snapshot evidence",
      basis:
        "財測達成／重大差異、股東會與股利決議為 current full-market snapshots，不是歷史事件庫。sourceSnapshotDate 不是 firstKnownAt 或 event date；stale／failed／unsupported 不是 current no-data，公司財測也不是分析師 consensus。",
    },
    {
      dataType: "台股研究候選篩選",
      basis:
        "latest-only 的非金融、月營收改善導向有界 research triage；四柱來自不同發布頻率與截止日的官方資料，並非同一 point-in-time snapshot，也不適合用作無偏誤回測。",
    },
  ],
  averages: [
    {
      name: "所選公司平均數",
      method: "對使用者選定的公司採簡單平均，不是市值加權。",
    },
    {
      name: "產業平均數",
      method:
        "依 Mopsfin 產業分類計算該產業上市與上櫃公司的指標平均；不代表興櫃、公開發行或所有公司的整體平均。",
    },
    {
      name: "金融機構所選機構平均數",
      method:
        "對本次 institution_codes 選定的金融機構採簡單平均；Mopsfin 回應通常以「公司平均數」標示，不是市值加權。",
    },
    {
      name: "金融業別產業平均數",
      method:
        "由 Mopsfin 依指標相應的金控、銀行或票券業母體計算；回應標籤可能是業別指標名稱，不一定直接包含「平均數」。",
    },
  ],
  interpretationNotes: [
    "不同市場別與公司有不同申報季度；NO_DATA 或 null 可能表示未到申報期、不適用或未申報，不可當成 0。",
    "營業收入跨業別對應可能是一般行業的營業收入、金融業／金控的淨收益、證券期貨業的收益或異業合併的收入。",
    "營業利益跨業別對應可能是營業利益或稅前淨利；營業毛利不適用金融、保險、證券期貨、金控與異業合併。",
    "部分季報比率由財報數據依公式計算，年度數字可能引用公司申報的財務分析資料；跨期間比較前應確認口徑。",
    "MCP 回傳的 unit、periods、query、warnings 與 metric guidance 都是答案的一部分，不應只取裸數值。",
    "所有成功結果都應先檢查 meta.asOf、meta.quality 與 meta.page；snapshotId 只代表工具明示的可驗證 scope，batch／reaction 未讀取的跨頁公司值不在 scope；CURSOR_INVALID 或 SNAPSHOT_CHANGED 時須從第一頁重啟。",
    "get_company_catalyst_events 的 offset 續頁會重新查詢官方來源，不是 pinned point-in-time snapshot；必須比對 fingerprint 與 meta.asOf.snapshotId，且不可將 confirmed 事件解讀為正面催化。",
    "get_company_catalyst_snapshots 只是 current official snapshot evidence；必須同時解讀 sourceSnapshotDate、freshness、pointInTimeHistoryAvailable、firstKnownAt 與 upcomingEligible，不得把 stale 或 unsupported 當成公司未揭露。",
    "月營收趨勢、個股相對 benchmark 報酬與量能訊號都是透明可重算的研究代理；screen_taiwan_stock_candidates 雖套用明示固定規則與分數，仍只是研究候選分流，不是錯價證明、完整市場覆蓋或投資建議。",
  ],
} as const;

export interface MetricGuidance {
  meaning: string;
  calculation: string | null;
  valueBasis: string;
  applicability: string;
  caveats: string[];
}

const NOT_APPLICABLE_TO_FINANCE =
  "金融業、保險業、金控業及異業合併不適用。";
const NOT_APPLICABLE_TO_FINANCE_SECURITIES =
  "金融業、保險業、證券期貨業、金控業及異業合併不適用。";
const QUARTER_CALCULATED_ANNUAL_REPORTED =
  "季報數字通常依財報資料與官方公式計算；年度數字可能引用公司在公開資訊觀測站申報的財務分析資料。";

const FORMULAS: Record<
  string,
  Pick<MetricGuidance, "meaning" | "calculation" | "applicability"> & {
    caveats?: string[];
  }
> = {
  每股淨值: {
    meaning: "每股普通股可歸屬的母公司業主權益。",
    calculation:
      "（權益－非控制權益）÷（普通股股數＋權益項下特別股股數＋預收股款約當發行股數－母子公司持有之母公司庫藏股股數－待註銷股本股數）",
    applicability: "依公司股本與權益結構計算。",
  },
  負債佔資產比率: {
    meaning: "衡量資產由負債支應的比例。",
    calculation: "（負債總額 ÷ 資產總額）× 100%",
    applicability: "一般公司財務結構指標。",
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  長期資金比率: {
    meaning: "長期資金支應不動產、廠房及設備的程度。",
    calculation:
      "（權益總額＋非流動負債）÷ 不動產、廠房及設備淨額 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  長期資金佔不動產廠房及設備比率: {
    meaning: "長期資金支應不動產、廠房及設備的程度。",
    calculation:
      "（權益總額＋非流動負債）÷ 不動產、廠房及設備淨額 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  流動比率: {
    meaning: "衡量流動資產償付流動負債的能力。",
    calculation: "（流動資產 ÷ 流動負債）× 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  速動比率: {
    meaning: "排除存貨與預付款後的短期償債能力。",
    calculation: "（流動資產－存貨－預付款項）÷ 流動負債 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  利息保障倍數: {
    meaning: "衡量獲利覆蓋利息支出的倍數。",
    calculation: "所得稅及利息費用前純益 ÷ 本期利息支出",
    applicability: "依財報可取得的利息支出計算。",
  },
  應收款項週轉率: {
    meaning: "衡量應收款項轉換為現金的速度。",
    calculation: "銷貨淨額 ÷ 平均應收款項餘額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  平均收現日數: {
    meaning: "估計應收款項平均需要幾天收現。",
    calculation:
      "季報 90 天 ÷ 應收款項週轉率；半年報 180 天 ÷ 應收款項週轉率；年報 365 天 ÷ 應收款項週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  應收款項收現日數: {
    meaning: "估計應收款項平均需要幾天收現。",
    calculation:
      "季報 90 天 ÷ 應收款項週轉率；半年報 180 天 ÷ 應收款項週轉率；年報 365 天 ÷ 應收款項週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  存貨週轉率: {
    meaning: "衡量存貨被銷售與補充的速度。",
    calculation: "銷貨成本 ÷ 平均存貨餘額",
    applicability: NOT_APPLICABLE_TO_FINANCE,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  平均銷貨日數: {
    meaning: "估計存貨平均需要幾天售出。",
    calculation:
      "季報 90 天 ÷ 存貨週轉率；半年報 180 天 ÷ 存貨週轉率；年報 365 天 ÷ 存貨週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  平均售貨日數: {
    meaning: "估計存貨平均需要幾天售出。",
    calculation:
      "季報 90 天 ÷ 存貨週轉率；半年報 180 天 ÷ 存貨週轉率；年報 365 天 ÷ 存貨週轉率",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  總資產週轉率: {
    meaning: "衡量資產產生銷貨收入的效率。",
    calculation: "銷貨淨額 ÷ 平均資產總額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  毛利率: {
    meaning: "每單位營業收入保留為毛利的比例。",
    calculation: "（營業毛利 ÷ 營業收入）× 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業利益率: {
    meaning: "每單位營業收入產生營業利益的比例。",
    calculation: "（營業利益 ÷ 營業收入）× 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  稅後純益率: {
    meaning: "每單位營業收入轉化為稅後純益的比例。",
    calculation: "（稅後純益 ÷ 營業收入）× 100%",
    applicability: "依跨業別對應後的營業收入計算。",
  },
  資產報酬率: {
    meaning: "衡量平均資產創造稅後純益的能力。",
    calculation: "（稅後純益 ÷ 平均資產總額）× 100%",
    applicability: "一般獲利能力指標。",
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  權益報酬率: {
    meaning: "衡量平均權益創造稅後純益的能力。",
    calculation: "（稅後純益 ÷ 平均權益總額）× 100%",
    applicability: "一般獲利能力指標。",
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  營業收入年增率: {
    meaning: "本期營業收入相對去年同期的變動百分比。",
    calculation:
      "（本期營業收入－去年同期營業收入）÷ 去年同期營業收入 × 100%",
    applicability: "跨業別會依官方對應採用淨收益、收益或收入。",
  },
  營業毛利年增率: {
    meaning: "本期營業毛利相對去年同期的變動百分比。",
    calculation:
      "（本期營業毛利－去年同期營業毛利）÷ 去年同期營業毛利 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業利益年增率: {
    meaning: "本期營業利益相對去年同期的變動百分比。",
    calculation:
      "（本期營業利益－去年同期營業利益）÷ 去年同期營業利益 × 100%",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  稅後純益年增率: {
    meaning: "本期稅後純益相對去年同期的變動百分比。",
    calculation:
      "（本期稅後純益－去年同期稅後純益）÷ 去年同期稅後純益 × 100%",
    applicability: "適用於有可比較去年同期資料的公司。",
  },
  每股盈餘年增率: {
    meaning: "本期每股盈餘相對去年同期的變動百分比。",
    calculation:
      "（本期每股盈餘－去年同期每股盈餘）÷ 去年同期每股盈餘 × 100%",
    applicability: "適用於有可比較去年同期每股盈餘的公司。",
  },
  營業現金對流動負債比: {
    meaning: "營業活動現金流量相對流動負債的比率。",
    calculation: "營業活動淨現金流量 ÷ 流動負債",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
    caveats: [QUARTER_CALCULATED_ANNUAL_REPORTED],
  },
  營業現金對負債比: {
    meaning: "營業活動現金流量相對總負債的比率。",
    calculation: "營業活動淨現金流量 ÷ 負債總額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業現金流對負債比: {
    meaning: "營業活動現金流量相對總負債的比率。",
    calculation: "營業活動淨現金流量 ÷ 負債總額",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業現金對稅後純益比: {
    meaning: "營業活動現金流量相對稅後純益的倍數。",
    calculation: "營業活動淨現金流量 ÷ 稅後純益",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  營業現金流對稅後淨利比: {
    meaning: "營業活動現金流量相對稅後純益的倍數。",
    calculation: "營業活動淨現金流量 ÷ 稅後純益",
    applicability: NOT_APPLICABLE_TO_FINANCE_SECURITIES,
  },
  放款業務逾放比率: {
    meaning: "逾期放款占放款總額的比率。",
    calculation: "逾期放款 ÷ 放款總額",
    applicability: "僅銀行業適用。",
  },
  放款備抵呆帳覆蓋率: {
    meaning: "放款備抵呆帳對逾放金額的覆蓋程度。",
    calculation: "放款所提列備抵呆帳金額 ÷ 逾放金額",
    applicability: "僅銀行業適用。",
  },
  放款業務備抵呆帳覆蓋率: {
    meaning: "放款備抵呆帳對逾放金額的覆蓋程度。",
    calculation: "放款所提列備抵呆帳金額 ÷ 逾放金額",
    applicability: "僅銀行業適用。",
  },
  信用卡逾期帳款比率: {
    meaning: "信用卡逾期帳款占應收帳款餘額的比率。",
    calculation: "逾期帳款 ÷ 應收帳款餘額",
    applicability: "僅有相關信用卡業務且依法申報的銀行適用。",
  },
  信用卡備抵呆帳覆蓋率: {
    meaning: "信用卡應收款備抵呆帳對逾期帳款的覆蓋程度。",
    calculation: "信用卡應收帳款備抵呆帳金額 ÷ 逾期帳款金額",
    applicability: "僅有相關信用卡業務且依法申報的銀行適用。",
  },
  信用卡應收帳款備抵呆帳覆蓋率: {
    meaning: "信用卡應收款備抵呆帳對逾期帳款的覆蓋程度。",
    calculation: "信用卡應收帳款備抵呆帳金額 ÷ 逾期帳款金額",
    applicability: "僅有相關信用卡業務且依法申報的銀行適用。",
  },
  應收帳款承購逾期比率: {
    meaning: "無追索權應收帳款承購業務的逾期帳款比率。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  無追索權應收帳款承購之逾期帳款比率: {
    meaning: "無追索權應收帳款承購業務的逾期帳款比率。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  應收帳款承購覆蓋率: {
    meaning: "無追索權應收帳款承購業務的備抵呆帳覆蓋程度。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  無追索權應收帳款承購之備抵呆帳覆蓋率: {
    meaning: "無追索權應收帳款承購業務的備抵呆帳覆蓋程度。",
    calculation: null,
    applicability: "僅有相關業務且依法申報的銀行適用。",
  },
  金控業集團資本適足率: {
    meaning: "衡量金融控股集團合格資本對法定資本需求的覆蓋程度。",
    calculation: "集團合格資本淨額 ÷ 集團法定資本需求",
    applicability: "僅金控業適用，通常只有 Q2、Q4 申報。",
  },
  銀行業資本適足率: {
    meaning: "衡量銀行自有資本相對風險性資產的充足程度。",
    calculation:
      "自有資本 ÷ 加權風險性資產總額；自有資本＝普通股權益＋其他第一類資本＋第二類資本；風險性資產包含信用風險及作業／市場風險資本計提。",
    applicability: "僅銀行業適用，通常只有 Q2、Q4 申報。",
  },
  票券業資本適足率: {
    meaning: "衡量票券業合格自有資本相對風險性資產的充足程度。",
    calculation: "合格自有資本 ÷ 加權風險性資產總額",
    applicability: "僅票券業適用，通常只有 Q2、Q4 申報。",
  },
};

function normalizedName(name: string): string {
  return name
    .replace(/[\s、，,（）()／/]/g, "")
    .replace(/之/g, "之")
    .trim();
}

function familyGuidance(metric: MetricDefinition): MetricGuidance {
  switch (metric.family) {
    case "report":
      return {
        meaning: `完整的${metric.name}表格。`,
        calculation: null,
        valueBasis: /綜合損益|現金流量/.test(metric.name)
          ? "各季累計金額；不是單季金額。"
          : "指定期末的資產、負債與權益餘額。",
        applicability: "可取得內容依公司市場別依法需申報的格式化財報而異。",
        caveats: ["回答時應保留報表 unit 與 period，並留意表格分頁。"],
      };
    case "xb":
      return {
        meaning: `財務報表附註：${metric.name}。`,
        calculation: null,
        valueBasis: "指定期別公司申報的格式化財報附註。",
        applicability:
          "上市、上櫃、興櫃及部分金融機構通常需申報；公開發行公司及部分未公開發行金融業的附註屬自願申報，因此可能未申報。",
        caveats: ["NO_DATA 可能是該公司不必申報或選定期別未申報。"],
      };
    case "bcode":
      return {
        meaning: `${metric.name}的營業收入或稅後純益資料。`,
        calculation: null,
        valueBasis: /統計/.test(metric.name)
          ? "各季累計金額。"
          : "提供產業單季與累計趨勢，需依查詢模式與回傳期別解讀。",
        applicability: "依 Mopsfin 即時列出的產業分類查詢。",
        caveats: ["產業分類與成分可能調整；請使用即時 catalog 的 industry_codes。"],
      };
    case "fin":
      return {
        meaning: `${metric.name}的金融業資產品質指標。`,
        calculation: null,
        valueBasis: "引用財報附註「資產品質」的累計／期末申報資料。",
        applicability:
          "僅銀行業適用；部分非上市櫃金控子公司的公開發行銀行依法可能不需申報。",
        caveats: ["NO_DATA 或 null 可能是不適用或依法不需申報，不可當成 0。"],
      };
    case "adequacy":
      return {
        meaning: `${metric.name}的資本適足性指標。`,
        calculation: null,
        valueBasis: "引用財報附註「資本適足性」，通常只有 Q2、Q4 申報。",
        applicability: "依指標分別只適用金控、銀行或票券業。",
        caveats: ["部分公開發行公司依法不需申報，因此可能無資料。"],
      };
    case "data":
      return {
        meaning: `${metric.category || "公司財務"}中的「${metric.name}」指標。`,
        calculation: null,
        valueBasis:
          "依 quarterly（Mopsfin 單季口徑）或 cumulative_yoy（指定季度累計同比）查詢。",
        applicability: "實際適用性依公司業別與指標定義而異。",
        caveats: ["請同時檢查 unit、basis、periods 與 warnings。"],
      };
  }
}

export function metricGuidance(metric: MetricDefinition): MetricGuidance {
  const fallback = familyGuidance(metric);
  const formula = FORMULAS[normalizedName(metric.name)];
  if (!formula) return fallback;

  return {
    meaning: formula.meaning,
    calculation: formula.calculation,
    valueBasis: fallback.valueBasis,
    applicability: formula.applicability,
    caveats: [...fallback.caveats, ...(formula.caveats ?? [])],
  };
}

function unique(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
}

export function companyMetricWarnings(
  metric: MetricDefinition,
  basis: "quarterly" | "cumulative_yoy",
  includeIndustryAverage: boolean,
  includeCompanyAverage: boolean,
): string[] {
  const guidance = metricGuidance(metric);
  const warnings = [
    basis === "quarterly"
      ? "quarterly 是 Mopsfin 單季口徑；上市櫃 Q4 通常以全年累計減 Q3，興櫃／公開發行 Q2 通常為前兩季累計、Q4 通常以全年累計減 Q2。"
      : "cumulative_yoy 是指定 yoy_quarter 的累計同比口徑，不是單季同比或滾動 12 個月。",
    ...guidance.caveats,
  ];
  if (includeIndustryAverage) {
    warnings.push(
      "產業平均是該產業上市與上櫃公司的指標平均，不是市值加權，也不涵蓋所有市場別。",
    );
  }
  if (includeCompanyAverage) {
    warnings.push("所選公司平均是本次選定公司的簡單平均，不是市值加權。");
  }
  return unique(warnings);
}

export function statementWarnings(statement: string): string[] {
  return unique([
    /income_statement|cash_flow/.test(statement)
      ? "綜合損益表與現金流量表為各季累計金額，不是單季金額。"
      : "資產負債表為指定期末的存量資料。",
    "不同市場別與公司申報季度不同；找不到某季不代表公司不存在。",
  ]);
}

export function noteWarnings(): string[] {
  return [
    "公開發行公司及部分未公開發行金融業的財報附註可能屬自願申報；NO_DATA 不代表公司不存在。",
    "附註內容與欄位依公司市場別、業別及申報格式而異。",
  ];
}

export function industryWarnings(mode: "statistics" | "trend"): string[] {
  return [
    mode === "statistics"
      ? "產業統計的營業收入與稅後純益為各季累計金額。"
      : "產業趨勢涉及單季與累計口徑；回答時應清楚標示所採口徑與期別。",
    "產業分類依 Mopsfin／交易所分類；產業成分與分類可能調整。",
  ];
}

export function financialInstitutionWarnings(
  family: "fin" | "adequacy",
  includeIndustryAverage = false,
  includeInstitutionAverage = false,
): string[] {
  const warnings = family === "adequacy"
    ? [
        "資本適足率僅適用相對應的金控、銀行或票券業，且通常只有 Q2、Q4 申報。",
        "部分公開發行機構依法不需申報；NO_DATA 或 null 不可解讀為 0。",
      ]
    : [
        "金融業資產品質指標僅銀行業適用，資料來自財報附註「資產品質」。",
        "部分公開發行銀行依法不需申報；NO_DATA 或 null 不可解讀為 0。",
      ];

  if (includeIndustryAverage) {
    warnings.push(
      "產業平均由 Mopsfin 依指標相應的金控、銀行或票券業母體計算，不是市值加權；series 標籤可能顯示業別指標名稱而不直接寫「平均數」。",
    );
  }
  if (includeInstitutionAverage) {
    warnings.push(
      "所選機構平均是本次 institution_codes 所選金融機構的簡單平均，不是市值加權；上游 series 通常標示為「公司平均數」。",
    );
  }
  return unique(warnings);
}

export function mergeWarnings(...groups: string[][]): string[] {
  return unique(groups.flat());
}
